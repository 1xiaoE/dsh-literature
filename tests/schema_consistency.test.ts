import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate, type Db } from '../src/db.js'

/**
 * Guards the migrate()/schema.sql sync contract: a database migrated from
 * empty must end up with exactly the schema declared in schema.sql.
 */
interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

type ColumnRow = [table: string, name: string, type: string, notnull: number, dflt_value: string | null, pk: number]

function snapshot(db: Db): { columns: ColumnRow[]; indexes: Array<[string, string]> } {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>
  const columns: ColumnRow[] = []
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as ColumnInfo[]
    for (const c of cols) {
      columns.push([t.name, c.name, c.type, c.notnull, c.dflt_value, c.pk])
    }
  }
  columns.sort((a, b) => `${a[0]}\u0000${a[1]}`.localeCompare(`${b[0]}\u0000${b[1]}`))
  // Index SQL may differ only in cosmetic whitespace (e.g. multiline DDL in
  // schema.sql vs single-line in the migration); normalize before comparing.
  const indexes = (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
      .all() as Array<{ name: string; sql: string }>
  ).map((i) => [i.name, i.sql.replace(/\s+/g, ' ').trim()] as [string, string])
  return { columns, indexes }
}

describe('schema consistency', () => {
  it('migrate() from an empty DB produces exactly the schema.sql schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-schema-'))
    try {
      const dbMigrated = new DatabaseSync(join(dir, 'migrated.db'))
      const dbSql = new DatabaseSync(join(dir, 'schema.db'))
      try {
        migrate(dbMigrated)
        const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
        dbSql.exec(schemaSql)

        expect((dbSql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(22)

        const migrated = snapshot(dbMigrated)
        const fromSql = snapshot(dbSql)

        expect(migrated.columns).toEqual(fromSql.columns)
        expect(migrated.indexes).toEqual(fromSql.indexes)
      } finally {
        dbMigrated.close()
        dbSql.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
