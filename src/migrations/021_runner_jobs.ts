import type { Db } from '../db.js'

/**
 * v21: runner_jobs — the Web UI's child-process lifecycle ledger. Every Run /
 * Resume spawns a row here (runId / kind / pushId / pid / status / started /
 * heartbeat / exitCode / logPath), so the Execution panel reads the live job
 * instead of inferring the workflow phase from retrieval rows.
 */
export default function up(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS runner_jobs (
  run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('push','resume')),
  push_id     INTEGER,
  pid         INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('running','exited','failed')),
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  exit_code   INTEGER,
  log_path    TEXT,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_status ON runner_jobs(status);
`)
}
