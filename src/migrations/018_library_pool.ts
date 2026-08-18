import type { Db } from '../db.js'
import { cleanRetrievedOnlyAutoCategories } from '../lib/research_fields.js'

/** v18: Library / Retrieved-pool separation — papers.is_favorite + cleanup of retrieved-only auto categories. */
export default function up(db: Db): void {
  // Library / Retrieved-pool separation. `is_favorite` is a first-class
  // library membership signal (favorites are linked to paper categories).
  // Retrieved-only candidates auto-classified by pre-separation versions
  // have their auto categories removed — the candidate pool must never
  // pollute Research Fields. Manual categories and all library papers are
  // preserved.
  const paperCols = db.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>
  if (!paperCols.some((c) => c.name === 'is_favorite')) {
    db.exec('ALTER TABLE papers ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;')
  }
  cleanRetrievedOnlyAutoCategories(db)
}
