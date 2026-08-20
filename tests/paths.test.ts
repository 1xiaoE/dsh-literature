import { homedir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { DEFAULT_DATA_DIR, dataDirs, repairPdfPaths, resolveDataDir, resolveLibraryRoot } from '../src/lib/paths.js'

describe('runtime data paths', () => {
  it('keeps default runtime data isolated under ~/dsh-literature/Data', () => {
    const expected = join(homedir(), 'dsh-literature', 'Data')
    const config = normalizeConfig(undefined)

    expect(DEFAULT_DATA_DIR).toBe(expected)
    expect(resolveDataDir(config)).toBe(expected)
    expect(resolveLibraryRoot(config)).toBe(join(expected, 'reports'))
  })

  it('preserves explicit dataDir and libraryRoot overrides', () => {
    const config = normalizeConfig({
      dataDir: '~/custom-literature-data',
      libraryRoot: '~/custom-literature-reports',
    })

    expect(resolveDataDir(config)).toBe(join(homedir(), 'custom-literature-data'))
    expect(resolveLibraryRoot(config)).toBe(join(homedir(), 'custom-literature-reports'))
  })

  it('repairs stored PDF paths when files moved into the current data directory', () => {
    const root = mkdtempSync(join('/tmp', 'dsh-lit-paths-'))
    let db: Db | undefined
    try {
      mkdirSync(dataDirs(root).pdfs, { recursive: true })
      const pdf = join(dataDirs(root).pdfs, 'sha256.pdf')
      writeFileSync(pdf, '%PDF-1.4 test')
      db = openDb(root)
      db.prepare('INSERT INTO papers (id, title, metadata_source) VALUES (?, ?, ?)').run('paper:path', 'Moved PDF', 'test')
      db.prepare("INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path) VALUES (?, '[]', 'ok', ?)").run('paper:path', '/old/runtime/pdfs/sha256.pdf')

      expect(repairPdfPaths(db, root)).toBe(1)
      expect((db.prepare('SELECT pdf_path FROM fetch_log WHERE paper_id = ?').get('paper:path') as { pdf_path: string }).pdf_path).toBe(pdf)
    } finally {
      db?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
