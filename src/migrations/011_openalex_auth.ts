import type { Db } from '../db.js'

/** v11: OpenAlex auth provenance — how the retrieval adapter authenticated (mode only, never the key). */
export default function up(db: Db): void {
  // OpenAlex auth provenance: how the retrieval adapter authenticated.
  // Only the MODE is stored ('anonymous' | 'api_key') — never the key.
  const cols = db.prepare('PRAGMA table_info(retrievals)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'auth_mode')) {
    db.exec("ALTER TABLE retrievals ADD COLUMN auth_mode TEXT;")
  }
}
