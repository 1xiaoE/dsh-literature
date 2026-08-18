import type { Db } from '../db.js'

/** v14: HITL manual PDF provenance — fetch_log.access_type admits 'manual' (user-downloaded PDFs). */
export default function up(db: Db): void {
  // HITL manual PDF provenance: fetch_log.access_type now also admits
  // 'manual' (user-downloaded via a publisher's human flow / Edge etc.).
  // SQLite cannot alter CHECK constraints, so the table is rebuilt
  // preserving all rows (source=manual is NOT open access).
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec(`
CREATE TABLE fetch_log_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id       TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  attempts       TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','PDF_OK','AUTH_REQUIRED','ACCESS_DENIED','PDF_NOT_FOUND','FULLTEXT_UNAVAILABLE','failed')),
  pdf_path       TEXT,
  pdf_source     TEXT,
  sha256         TEXT,
  access_type    TEXT CHECK (access_type IS NULL OR access_type IN ('oa','institutional','manual')),
  is_open_access INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO fetch_log_new (id, paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access, created_at)
  SELECT id, paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access, created_at FROM fetch_log;
DROP TABLE fetch_log;
ALTER TABLE fetch_log_new RENAME TO fetch_log;
`)
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
