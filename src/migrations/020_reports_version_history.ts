import type { Db } from '../db.js'

/**
 * v20: reports become a version history. Previously `reports` had
 * paper_id PRIMARY KEY — one current report per paper, overwritten on
 * re-read. Re-reading the same paper (deep-read, workflow re-run, model /
 * prompt comparisons) should keep every report version, so the table gains
 * an auto-increment id and (paper_id, created_at) history semantics.
 *
 * Existing rows are preserved; a paper may now carry multiple report
 * versions ordered by id (newest last). All readers use "newest report"
 * semantics already (ORDER BY id/created_at DESC), so this is additive.
 */
export default function up(db: Db): void {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec(`
CREATE TABLE reports_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  report_path TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('workflow','deep_read')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO reports_new (paper_id, report_path, source, created_at, updated_at)
  SELECT paper_id, report_path, source, created_at, updated_at FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX IF NOT EXISTS idx_reports_paper ON reports(paper_id);
CREATE INDEX IF NOT EXISTS idx_reports_paper_created ON reports(paper_id, created_at);
`)
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
