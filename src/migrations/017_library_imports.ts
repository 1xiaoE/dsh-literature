import type { Db } from '../db.js'

/** v17: Library imports — papers enrichment columns + reports / paper_reading_jobs + workflow report backfill. */
export default function up(db: Db): void {
  // Library imports are papers first, never a parallel manual library.  The
  // supplemental columns retain extracted metadata without changing the
  // retrieval/ranking model, while reports/read jobs normalize assets that
  // do not belong to a workflow push.
  const paperCols = db.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>
  if (!paperCols.some((c) => c.name === 'affiliation')) db.exec('ALTER TABLE papers ADD COLUMN affiliation TEXT;')
  if (!paperCols.some((c) => c.name === 'keywords')) db.exec('ALTER TABLE papers ADD COLUMN keywords TEXT;')
  if (!paperCols.some((c) => c.name === 'metadata_enriched_at')) db.exec('ALTER TABLE papers ADD COLUMN metadata_enriched_at TEXT;')
  db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  paper_id    TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  report_path TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('workflow','deep_read')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS paper_reading_jobs (
  paper_id    TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  read_chunks INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_reading_jobs_status ON paper_reading_jobs(status);
INSERT INTO reports (paper_id, report_path, source, created_at, updated_at)
  SELECT paper_id, report_path, 'workflow', COALESCE(finished_at, started_at, datetime('now')), datetime('now')
  FROM pushes
  WHERE paper_id IS NOT NULL AND report_path IS NOT NULL AND report_path <> ''
  ON CONFLICT(paper_id) DO UPDATE SET report_path=excluded.report_path, source='workflow', updated_at=excluded.updated_at;
`)
}
