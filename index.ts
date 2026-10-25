/** Expose opt-in fair assignment options, compact decisions and actionable refusals. */
export { SchedulingRefusal } from './src/fair-scheduling.ts';
/** Typed policy inputs and bounded scheduling receipts. */
export type { ScheduleOptions, ScheduleReceipt, SchedulingDecision, SchedulingRefusalCode } from './src/fair-scheduling.ts';
/** Expose revision-bound parallel Plan progress and typed recovery instructions. */
export { PlanProgress, ProgressRefusal, PROGRESS_PREFIX } from './src/progress.ts';
/** Expose portable witness, declaration and compact progress contracts. */
export type { ProgressWitness, ProgressStage, ProgressView, ProgressStep, ProgressOptions, ProgressDeclaration, ProgressRefusalCode } from './src/progress.ts';
import { defineExtension } from '@unbrained/pm-cli/sdk/authoring';
import { register } from './src/commands.ts';
/** Expose the same tracker-bound engine used by host commands. */
export { Swarm } from './src/swarm.ts';
/** Expose claim coordination for trackers without Git worktree lanes. */
export { SharedTracker } from './src/shared-tracker.ts';
/** Expose backend-neutral exclusive resource coordination and typed remedies. */
export { ResourceReservations, ResourceRefusal, RESOURCE_TAG } from './src/resources.ts';
/** Expose the adapter reusing the existing shared-tracker operation lease. */
export { trackerResourceBackend } from './src/resource-tracker.ts';
/** Expose portable backend and compact resource receipt contracts. */
export type { ResourceBackend, ResourceRecord, ResourceChange, ResourceReceipt, ResourceRefusalCode } from './src/resources.ts';
/** Expose typed stale-token refusals for embedded workers. */
export { StaleFenceError } from './src/lease.ts';
/** Expose conservative footprint and wave planning primitives. */
export { partition, separation, overlaps, footprintPath } from './src/planner.ts';
/** Expose the real Git merge predictor for embedded tools. */
export { predict } from './src/git.ts';
/** Expose exhaustive sequential merge ordering and minimal conflict analysis. */
export { cleanOrder, minimalConflict } from './src/order.ts';
/** Expose SDK-backed package settings resolution. */
export { settings, updateSettings, resolveSwarmSettings, swarmSettingsSection, SettingsRefusal, assertPrivatePathSafe } from './src/settings.ts';
/** Expose portable lane contracts. */
export type { Candidate, Lane, Prediction, Separation, SwarmSettings } from './src/types.ts';
/** Activate the swarm command family and its extension fields. */
export default defineExtension({ name: 'pm-swarm', version: '2026.10.15', description: 'Many agents on one tracker with fenced claims and context handoff; Git lanes optional', activate: register });

/** Typed settings mutation, refusal and verification contracts. */
export type { SettingsReceipt, SettingsMutationOptions, SettingsBoundary, SettingsRefusalCode } from './src/settings.ts';
