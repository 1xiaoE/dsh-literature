import type { Db } from '../db.js'

/** v4: curriculum coverage — hint/value scores, selection trace, knowledge_coverage. */
export default function up(db: Db): void {
  db.exec('ALTER TABLE candidates ADD COLUMN curriculum_hint REAL;')
  db.exec('ALTER TABLE candidates ADD COLUMN curriculum_value REAL;')
  db.exec('ALTER TABLE candidates ADD COLUMN selection_rank INTEGER;')
  db.exec(
    "ALTER TABLE candidates ADD COLUMN selection_outcome TEXT "
    + "CHECK (selection_outcome IS NULL OR selection_outcome IN ('SELECTED','FULLTEXT_UNAVAILABLE','BELOW_QUALITY_GATE','PDF_FAILED'));",
  )
  db.exec('ALTER TABLE candidates ADD COLUMN selection_rejection_reason TEXT;')
  db.exec('ALTER TABLE candidates ADD COLUMN landmark_confidence REAL;')
  db.exec('ALTER TABLE candidates ADD COLUMN methodological_centrality REAL;')
  const stageCols = db.prepare('PRAGMA table_info(stages)').all() as Array<{ name: string }>
  if (!stageCols.some((c) => c.name === 'covered_goals')) {
    db.exec("ALTER TABLE stages ADD COLUMN covered_goals TEXT NOT NULL DEFAULT '[]';")
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS knowledge_coverage (
      push_id  INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      goal     TEXT NOT NULL,
      PRIMARY KEY (push_id, paper_id, goal)
    );`,
  )
}
