import { getSettingsPath, readFileIfExists } from '@unbrained/pm-cli/sdk';
import type { SwarmSettings } from './types.ts';

/** Read package settings through SDK path and file APIs, preserving the private section. */
export async function settings(pmRoot: string, overrides: Partial<SwarmSettings> = {}): Promise<SwarmSettings> {
  const raw = await readFileIfExists(getSettingsPath(pmRoot));
  const document = JSON.parse(raw ?? '{}') as { swarm?: Partial<SwarmSettings> };
  const config = { base: 'main', root: '../.pm-swarm', branch_prefix: 'swarm/', lane_limit: 4, ...document.swarm, ...overrides };
  for (const value of [config.base, config.root, config.branch_prefix, ...(config.progress_orchestrator === undefined ? [] : [config.progress_orchestrator])]) if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || value.includes('\n')) throw new Error('Invalid swarm string setting');
  if (!Number.isInteger(config.lane_limit) || config.lane_limit < 1 || config.lane_limit > 8) throw new Error('swarm lane_limit must be an integer from 1 to 8');
  return config;
}
