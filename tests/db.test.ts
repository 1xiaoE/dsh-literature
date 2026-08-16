import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate, openDb, upsertPaper, type Db } from '../src/db.js'

interface TempDb {
  db: Db
  dir: string
}

function tempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-'))
  const db = openDb(dir)
  return { db, dir }
}

describe('sqlite migration', () => {
  it('is idempotent and sets user_version', () => {
    const { db, dir } = tempDb()
    migrate(db)
    migrate(db)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(2)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    for (const t of ['papers', 'pushes', 'candidates', 'fetch_log', 'fulltexts', 'fulltext_chunks', 'stages']) {
      expect(names).toContain(t)
    }
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upserts papers idempotently', () => {
    const { db, dir } = tempDb()
    const row = {
      id: 'arxiv:2401.001',
      title: 'A Paper',
      authors: '["A"]',
      venue: null,
      year: 2024,
      doi: '10.1/abc',
      arxiv_id: '2401.001',
      openalex_id: null,
      url: null,
      abstract: null,
      citations: 10,
      bibtex: null,
      metadata_source: 'arxiv',
    }
    upsertPaper(db, row)
    upsertPaper(db, { ...row, citations: 11, authors: '["A","B"]' })
    const got = db.prepare('SELECT * FROM papers WHERE id = ?').get('arxiv:2401.001') as {
      citations: number
      authors: string
    }
    expect(got.citations).toBe(11)
    expect(got.authors).toBe('["A","B"]')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
