/** Settings stored in the SDK-owned settings document; roots must be relative. */
export interface SwarmSettings {
  base: string;
  root: string;
  branch_prefix: string;
  lane_limit: number;
  progress_orchestrator?: string;
}
/** A ready item projected from the certified SDK corpus. */
export interface Candidate {
  id: string;
  files: string[];
  dependencies: string[];
}
/** One pair that cannot start together and its complete separation reasons. */
export interface Separation {
  left: string;
  right: string;
  reasons: string[];
}
/** A real merge-tree result, including unresolved tracker paths. */
export interface Prediction {
  left: string;
  right: string;
  tree: string;
  clean: boolean;
  conflicts: string[];
  messages: string[];
  tracker_conflicts: string[];
}
/** Active branch identity, with no machine-specific worktree location. */
export interface Lane {
  id: string;
  branch: string;
  sha: string;
  base: string;
  target: string;
  agent: string | null;
  files: string[];
  terminal: boolean;
}
