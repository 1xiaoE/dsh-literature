import type { Db } from '../db.js'

/** v3: retrievals — candidate pool marker on candidates + retrievals table. */
export default function up(db: Db): void {
  db.exec("ALTER TABLE candidates ADD COLUMN candidate_pool TEXT NOT NULL DEFAULT 'recent';")
  db.exec(
    `CREATE TABLE IF NOT EXISTS retrievals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      push_id         INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
      paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      generated_query TEXT NOT NULL,
      query_language  TEXT NOT NULL DEFAULT 'en',
      source_adapter  TEXT NOT NULL,
      retrieval_score REAL,
      candidate_pool  TEXT NOT NULL CHECK (candidate_pool IN ('recent','landmark')),
      retrieved_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );`,
  )
}
