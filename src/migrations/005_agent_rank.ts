import type { Db } from '../db.js'

/** v5: agent rank — agent_rank / preflight order / priority-goal match; drop conflated selection_rank. */
export default function up(db: Db): void {
  db.exec('ALTER TABLE candidates ADD COLUMN agent_rank INTEGER;')
  db.exec('ALTER TABLE candidates ADD COLUMN preflight_attempt_order INTEGER;')
  db.exec('ALTER TABLE candidates ADD COLUMN priority_goal_match INTEGER NOT NULL DEFAULT 0;')
  // split the conflated selection_rank column (agent rank ≠ preflight order)
  const cols = db.prepare('PRAGMA table_info(candidates)').all() as Array<{ name: string }>
  if (cols.some((c) => c.name === 'selection_rank')) {
    db.exec('ALTER TABLE candidates DROP COLUMN selection_rank;')
  }
}
