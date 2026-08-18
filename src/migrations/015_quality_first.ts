import type { Db } from '../db.js'

/** v15: Quality-First acquisition state machine + non-terminal provider rate-limit (fetch_log RATE_LIMITED). */
export default function up(db: Db): void {
  // Quality-First acquisition state machine + non-terminal provider rate-limit.
  const candCols = db.prepare('PRAGMA table_info(candidates)').all() as Array<{ name: string }>
  const addCand = (name: string, ddl: string): void => {
    if (!candCols.some((c) => c.name === name)) db.exec(`ALTER TABLE candidates ADD COLUMN ${ddl};`)
  }
  addCand('public_preflight_status', "public_preflight_status TEXT CHECK (public_preflight_status IS NULL OR public_preflight_status IN ('AVAILABLE','UNAVAILABLE'))")
  addCand('acquisition_outcome', "acquisition_outcome TEXT CHECK (acquisition_outcome IS NULL OR acquisition_outcome IN ('SELECTED','AUTH_REQUIRED','RATE_LIMITED','ACCESS_DENIED','PDF_NOT_FOUND','FULLTEXT_UNAVAILABLE','PDF_FAILED'))")
  addCand('acquisition_reason', 'acquisition_reason TEXT')

  // Snapshot the normalized runtime policy that governs this push. New pushes
  // can then use the exact same thresholds/stage rules on a 0-LLM --resume,
  // while old pushes without a snapshot safely fall back to the agent path.
  const pushCols = db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>
  if (!pushCols.some((c) => c.name === 'policy_json')) db.exec('ALTER TABLE pushes ADD COLUMN policy_json TEXT;')

  // fetch_log outcome CHECK must admit RATE_LIMITED. A rate-limit is not a
  // paper-level failure and never arms FULLTEXT_UNAVAILABLE cooldown.
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec(`
CREATE TABLE fetch_log_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id       TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  attempts       TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','PDF_OK','AUTH_REQUIRED','RATE_LIMITED','ACCESS_DENIED','PDF_NOT_FOUND','FULLTEXT_UNAVAILABLE','failed')),
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
