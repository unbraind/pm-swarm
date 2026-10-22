import { defineExtension } from '@unbrained/pm-cli/sdk/authoring';
import { register } from './src/commands.ts';
/** Expose the same tracker-bound engine used by host commands. */
export { Swarm } from './src/swarm.ts';
/** Expose claim coordination for trackers without Git worktree lanes. */
export { SharedTracker } from './src/shared-tracker.ts';
/** Expose typed stale-token refusals for embedded workers. */
export { StaleFenceError } from './src/lease.ts';
/** Expose conservative footprint and wave planning primitives. */
export { partition, separation, overlaps, footprintPath } from './src/planner.ts';
/** Expose the real Git merge predictor for embedded tools. */
export { predict } from './src/git.ts';
/** Expose exhaustive sequential merge ordering and minimal conflict analysis. */
export { cleanOrder, minimalConflict } from './src/order.ts';
/** Expose SDK-backed package settings resolution. */
export { settings } from './src/settings.ts';
/** Expose portable lane contracts. */
export type { Candidate, Lane, Prediction, Separation, SwarmSettings } from './src/types.ts';
/** Activate the swarm command family and its extension fields. */
export default defineExtension({ name: 'pm-swarm', version: '2026.10.15', description: 'Many agents on one tracker with fenced claims and context handoff; Git lanes optional', activate: register });
