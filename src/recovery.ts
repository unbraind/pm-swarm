/** Preserve recovery decisions only while ownership, lifecycle and item revision match. */
export function recoverySnapshotMatches(snapshot: Record<string, unknown>, current: Record<string, unknown>): boolean {
  return ['parent', 'assignee', 'status', 'updated_at', 'swarm_token', 'swarm_claimed_at', 'swarm_branch', 'swarm_base', 'swarm_base_ref'].every(field => snapshot[field] === current[field]);
}
