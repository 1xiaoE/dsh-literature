import type { Db } from '../db.js'

/** v12: arXiv request-scheduling provenance (scheduler gaps / dedup / 429 / breaker). */
export default function up(db: Db): void {
  // arXiv request-scheduling provenance (scheduler gaps / dedup / 429 / breaker).
  const cols = db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>
  const add = (name: string, ddl: string): void => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE pushes ADD COLUMN ${ddl};`)
  }
  add('arxiv_requests', 'arxiv_requests INTEGER')
  add('arxiv_dedup_hits', 'arxiv_dedup_hits INTEGER')
  add('arxiv_429_count', 'arxiv_429_count INTEGER')
  add('arxiv_retry_count', 'arxiv_retry_count INTEGER')
  add('arxiv_rate_limited', 'arxiv_rate_limited INTEGER')
  add('arxiv_wait_ms', 'arxiv_wait_ms INTEGER')
}
