import { CAPACITY_TAG } from './capacity.ts';
import { estimatePmOutputTokens, readSettings, resolveRuntimeStatusRegistry, scanMutationSecrets, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import type { GetResult } from '@unbrained/pm-cli/sdk';
import { encodeToon } from '@unbrained/pm-cli/sdk/testing';
import { assertCloseIntentSettled } from './close.ts';
import { CLOSE_INTENT } from './close-journal.ts';
import { inspectItem, readItem } from './inspection.ts';
import { StaleFenceError } from './lease.ts';
import { footprintPath } from './planner.ts';
import { admitReceipt } from './receipts.ts';
import { RESOURCE_TAG } from './resources.ts';
import { assertPrivatePathSafe, SettingsRefusal } from './settings.ts';
import type { Swarm } from './swarm.ts';

/** Single-item work fields in budget priority order. */
type BriefContext = Pick<GetResult['item'], 'title' | 'acceptance_criteria' | 'description' | 'blocked_by' | 'blocked_reason' | 'body'> & {
  dependencies?: Pick<NonNullable<GetResult['item']['dependencies']>[number], 'id' | 'kind'>[];
  files?: string[];
  docs?: string[];
  tests?: Pick<NonNullable<GetResult['item']['tests']>[number], 'command' | 'path'>[];
  comments?: string[];
};

/** The only disclosure about a field withheld by a privacy scan. */
const WITHHELD = 'withheld: privacy';

/** Privacy markers and exact counts of otherwise safe work omitted for budget. */
type BriefOmissions = Partial<Record<keyof BriefContext, number | typeof WITHHELD>> & { status?: typeof WITHHELD };

/** Portable assignment scoped to one current ownership generation. */
export interface AssignmentBrief {
  id: string;
  agent: string;
  token: string;
  status?: string;
  token_budget: number;
  context: BriefContext;
  omission_receipt: BriefOmissions;
}

/** Materialize only item-local work fields and prefer the latest comments. */
function briefContext(item: GetResult['item']): BriefContext {
  return {
    title: item.title,
    acceptance_criteria: item.acceptance_criteria,
    description: item.description,
    blocked_by: item.blocked_by,
    blocked_reason: item.blocked_reason,
    dependencies: item.dependencies?.map(({ id, kind }) => ({ id, kind })),
    files: item.files?.map(file => file.path),
    docs: item.docs?.map(doc => doc.path),
    tests: item.tests?.map(({ command, path }) => ({ command, path })),
    body: item.body,
    comments: item.comments?.map(comment => comment.text).reverse(),
  };
}

/** Preserve the identity refusal and add the SDK's credential checks. */
function assertBriefIdentitySafe(value: unknown): void {
  assertPrivatePathSafe(value);
  if (scanMutationSecrets(value).length > 0) throw new SettingsRefusal('swarm_input_invalid', 'Remove credential-shaped text from the assignment identity.');
}

/** Withhold a field if either scan detects private content or cannot finish. */
function hasPrivacyFinding(value: unknown): boolean {
  try {
    assertPrivatePathSafe(value);
    return scanMutationSecrets(value).length > 0;
  } catch {
    return true;
  }
}

/** Count the whole receipt, including the renderer's trailing newline, in both formats. */
function fits(brief: AssignmentBrief): boolean {
  const bytes = Math.max(Buffer.byteLength(JSON.stringify(brief)), Buffer.byteLength(encodeToon(brief)));
  return estimatePmOutputTokens(bytes + 1) <= brief.token_budget;
}

/** Add whole fields or collection prefixes while preserving exact omission counts. */
function pack(brief: AssignmentBrief, work: BriefContext): AssignmentBrief {
  const fields = Object.keys(work) as (keyof BriefContext)[];
  for (const field of fields) {
    const value = work[field];
    const count = Array.isArray(value) ? value.length : Number(Boolean(value));
    if (count > 0) brief.omission_receipt[field] = hasPrivacyFinding(value) ? WITHHELD : count;
  }
  // Inspect stored paths before normalization can reject or remove private text.
  if (typeof brief.omission_receipt.files === 'number') {
    work.files = work.files!.map(footprintPath);
    if (hasPrivacyFinding(work.files)) brief.omission_receipt.files = WITHHELD;
  }

  for (const field of fields) {
    const value = work[field];
    const count = brief.omission_receipt[field];
    if (typeof count !== 'number') continue;
    for (let length = 1; length <= count; length++) {
      const omissions = { ...brief.omission_receipt };
      if (length === count) delete omissions[field];
      else omissions[field] = count - length;
      const context = { ...brief.context, [field]: Array.isArray(value) ? value.slice(0, length) : value };
      const candidate = { ...brief, context, omission_receipt: omissions };
      if (!fits(candidate)) break;
      brief = candidate;
    }
  }
  if (!fits(brief)) throw new SettingsRefusal('swarm_input_invalid', 'Increase --token-budget to fit the assignment identity and omission receipt.');
  return brief;
}

/** Read one authoritative item snapshot and disclose work only to the matching swarm fence. */
export async function readAssignmentBrief(engine: Swarm, id: string, token: string | undefined, tokenBudget = 512): Promise<AssignmentBrief> {
  assertBriefIdentitySafe({ id, token, author: engine.author });
  if (typeof token !== 'string' || !/^\d+$/.test(token)) throw new SettingsRefusal('swarm_input_invalid', 'Supply the decimal --token returned by the current swarm claim.');
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 8192) throw new SettingsRefusal('swarm_input_invalid', 'Set --token-budget to an integer from 1 through 8192.');

  const local = await inspectItem(engine.pmRoot, engine.repo, id);
  const fields = `status,assignee,tags,swarm_token,${CLOSE_INTENT},title,acceptance_criteria,description,blocked_by,blocked_reason,dependencies,files,docs,tests,body,comments`;
  const item = local === null ? (await readItem(engine.client, id, fields)).item : { ...local.item, body: local.body };
  assertBriefIdentitySafe(item.id);
  if (item.assignee !== engine.author || item.swarm_token !== token) throw new StaleFenceError(item.id);
  const statuses = resolveRuntimeStatusRegistry((await readSettings(engine.pmRoot)).schema);
  const status = String(item.status);
  if (statusIsTerminal(status, statuses) || (item.tags!.includes(RESOURCE_TAG) || item.tags!.includes(CAPACITY_TAG))) throw new SettingsRefusal('swarm_input_invalid', 'Use an active work item with an ordinary swarm claim.');
  assertCloseIntentSettled(engine, item);

  const brief: AssignmentBrief = { id: item.id, agent: engine.author, token, token_budget: tokenBudget, context: {}, omission_receipt: {} };
  if (hasPrivacyFinding(status)) brief.omission_receipt.status = WITHHELD;
  else brief.status = status;
  return admitReceipt(pack(brief, briefContext(item)));
}
