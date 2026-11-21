import { estimatePmOutputTokens, readSettings, resolveRuntimeStatusRegistry, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import type { GetResult } from '@unbrained/pm-cli/sdk';
import { encodeToon } from '@unbrained/pm-cli/sdk/testing';
import { assertCloseIntentSettled } from './close.ts';
import { CLOSE_INTENT } from './close-journal.ts';
import { inspectItem, readItem } from './inspection.ts';
import { StaleFenceError } from './lease.ts';
import { itemFootprint } from './planner.ts';
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

/** Exact counts for the populated work fields or collection rows the budget omitted. */
type BriefOmissions = Partial<Record<keyof BriefContext, number>>;

/** Portable assignment scoped to one current ownership generation. */
export interface AssignmentBrief {
  id: string;
  agent: string;
  token: string;
  status: string;
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
    files: itemFootprint(item),
    docs: item.docs?.map(doc => doc.path),
    tests: item.tests?.map(({ command, path }) => ({ command, path })),
    body: item.body,
    comments: item.comments?.map(comment => comment.text).reverse(),
  };
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
    if (count > 0) brief.omission_receipt[field] = count;
  }

  for (const field of fields) {
    const value = work[field];
    const count = brief.omission_receipt[field] ?? 0;
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
  assertPrivatePathSafe({ id, token, author: engine.author });
  if (typeof token !== 'string' || !/^\d+$/.test(token)) throw new SettingsRefusal('swarm_input_invalid', 'Supply the decimal --token returned by the current swarm claim.');
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 8192) throw new SettingsRefusal('swarm_input_invalid', 'Set --token-budget to an integer from 1 through 8192.');

  const local = await inspectItem(engine.pmRoot, engine.repo, id);
  const fields = `status,assignee,tags,swarm_token,${CLOSE_INTENT},title,acceptance_criteria,description,blocked_by,blocked_reason,dependencies,files,docs,tests,body,comments`;
  const item = local === null ? (await readItem(engine.client, id, fields)).item : { ...local.item, body: local.body };
  if (item.assignee !== engine.author || item.swarm_token !== token) throw new StaleFenceError(item.id);
  const statuses = resolveRuntimeStatusRegistry((await readSettings(engine.pmRoot)).schema);
  const status = String(item.status);
  if (statusIsTerminal(status, statuses) || item.tags!.includes(RESOURCE_TAG)) throw new SettingsRefusal('swarm_input_invalid', 'Use an active work item with an ordinary swarm claim.');
  assertCloseIntentSettled(engine, item);

  const brief = { id: item.id, agent: engine.author, token, status, token_budget: tokenBudget, context: {}, omission_receipt: {} };
  return admitReceipt(pack(brief, briefContext(item)));
}
