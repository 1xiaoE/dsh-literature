import type { Db } from '../db.js'

/** v2: stage relevance — deterministic hint (program) + agent-assigned score. */
export default function up(db: Db): void {
  // stage relevance: deterministic hint (program) + agent-assigned score
  db.exec('ALTER TABLE candidates ADD COLUMN stage_relevance_hint REAL;')
  db.exec('ALTER TABLE candidates ADD COLUMN stage_relevance_score REAL;')
}
