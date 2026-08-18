import type { Db } from '../db.js'

/** v7: CARSI institutional-access fallback — fetch_log outcomes/provenance + pushes 'auth_required'. */
export default function up(db: Db): void {
  // CARSI institutional-access fallback:
  // - fetch_log: new terminal outcomes (PDF_OK / AUTH_REQUIRED / ACCESS_DENIED /
  //   PDF_NOT_FOUND) + provenance columns (access_type / is_open_access);
  // - pushes: new terminal status 'auth_required' (distinct from
  //   fulltext_unavailable — a broken institutional session needs a re-login
  //   prompt, NOT a permanent paper-level cooldown).
  // SQLite cannot alter CHECK constraints, so both tables are rebuilt.
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
  access_type    TEXT CHECK (access_type IS NULL OR access_type IN ('oa','institutional')),
  is_open_access INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO fetch_log_new (id, paper_id, attempts, outcome, pdf_path, pdf_source, sha256, created_at)
  SELECT id, paper_id, attempts, outcome, pdf_path, pdf_source, sha256, created_at FROM fetch_log;
DROP TABLE fetch_log;
ALTER TABLE fetch_log_new RENAME TO fetch_log;

CREATE TABLE pushes_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic          TEXT NOT NULL,
  stage          INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','no_candidate','fulltext_unavailable','auth_required')),
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  error_code     TEXT,
  error_detail   TEXT,
  paper_id       TEXT,
  report_path    TEXT,
  model_route    TEXT,
  notes          TEXT
);
INSERT INTO pushes_new (id, topic, stage, status, started_at, finished_at, error_code, error_detail, paper_id, report_path, model_route, notes)
  SELECT id, topic, stage, status, started_at, finished_at, error_code, error_detail, paper_id, report_path, model_route, notes FROM pushes;
DROP TABLE pushes;
ALTER TABLE pushes_new RENAME TO pushes;
`)
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
