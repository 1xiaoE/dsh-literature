import type { Db } from '../db.js'

/** v8: Human-in-the-loop — pushes 'user_action_required' + user_actions table. */
export default function up(db: Db): void {
  // Human-in-the-loop (NEED_USER_ACTION):
  // - pushes gain the generic 'user_action_required' terminal (a resource /
  //   auth / permission / download-channel / research-choice problem that
  //   the USER can solve more easily than the automation — never blind
  //   retries, never misreported as FULLTEXT_UNAVAILABLE);
  // - user_actions stores the five-part issue record (where stuck / what's
  //   missing / what was tried / what the user should do / how to continue)
  //   so a resumed workflow can continue from the original step without
  //   re-running retrieval and scoring.
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec(`
CREATE TABLE pushes_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic          TEXT NOT NULL,
  stage          INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','no_candidate','fulltext_unavailable','auth_required','user_action_required')),
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

CREATE TABLE IF NOT EXISTS user_actions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  push_id            INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  paper_id           TEXT REFERENCES papers(id) ON DELETE CASCADE,
  step               TEXT NOT NULL,   -- where the workflow is stuck (sources/selection/preflight/fetch_pdf/fulltext_index/report/record)
  kind               TEXT NOT NULL,   -- carsi_relogin | manual_pdf | version_choice | topic_decision | user_resource_needed | ...
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  issue              TEXT NOT NULL,   -- what resource/permission/info is missing
  attempts           TEXT,            -- JSON array: what has already been tried
  what_user_should_do TEXT NOT NULL,
  how_to_continue    TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_actions_push ON user_actions(push_id);
CREATE INDEX IF NOT EXISTS idx_user_actions_state ON user_actions(state);
`)
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
