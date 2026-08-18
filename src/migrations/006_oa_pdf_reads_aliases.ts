import type { Db } from '../db.js'

/** v6: oa pdf url split (landing page is NOT a fulltext signal), fulltext_reads, legacy topic aliases. */
export default function up(db: Db): void {
  // oa pdf url split (landing page is NOT a fulltext signal)
  const paperCols = db.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>
  if (!paperCols.some((c) => c.name === 'oa_pdf_url')) {
    db.exec('ALTER TABLE papers ADD COLUMN oa_pdf_url TEXT;')
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS fulltext_reads (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      push_id  INTEGER REFERENCES pushes(id) ON DELETE CASCADE,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      seq      INTEGER NOT NULL,
      read_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );`,
  )
  // legacy topic aliases → canonical id (keeps historical dedup working)
  db.exec(
    "UPDATE pushes SET topic = 'legged_robot_control' WHERE topic IN ('足式机器人控制', 'legged robot control', 'legged robot')",
  )
  db.exec(
    "DELETE FROM stages WHERE topic IN ('足式机器人控制', 'legged robot control', 'legged robot') AND topic != 'legged_robot_control'",
  )
}
