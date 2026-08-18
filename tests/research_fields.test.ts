import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, upsertPaper, type Db } from '../src/db.js'
import {
  assignPaperField,
  backfillResearchFields,
  createResearchField,
  deleteResearchField,
  listPaperFields,
  listResearchFields,
  mergeResearchFields,
  removePaperField,
  renameResearchField,
  resolvePaperFields,
} from '../src/lib/research_fields.js'

function tempDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-fields-'))
  return { db: openDb(dir), dir }
}

function close(t: { db: Db; dir: string }): void {
  t.db.close()
  rmSync(t.dir, { recursive: true, force: true })
}

/** Seed a library paper: upsert + manual PDF record, so it is classified. */
function paper(db: Db, id: string, title: string, abstract = ''): void {
  upsertPaper(db, {
    id, title, abstract, authors: '[]', venue: null, year: 2026, doi: null,
    arxiv_id: null, openalex_id: null, url: null, oa_pdf_url: null,
    citations: null, bibtex: null, metadata_source: 'test',
  })
  db.prepare(
    `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, access_type, is_open_access)
     VALUES (?, '[]', 'PDF_OK', '/tmp/unused.pdf', 'manual', 0)`,
  ).run(id)
}

describe('research fields', () => {
  it('creates bilingual fields once and supports multiple manual paper assignments', () => {
    const t = tempDb()
    try {
      paper(t.db, 'paper:one', 'A paper')
      const robotics = createResearchField(t.db, { nameEn: 'Robotics', nameZh: '机器人学' })
      const control = createResearchField(t.db, { nameEn: 'Control', nameZh: '控制' })
      expect(createResearchField(t.db, { nameEn: ' Robotics ', nameZh: '机器人学' }).id).toBe(robotics.id)
      assignPaperField(t.db, 'paper:one', robotics.id)
      assignPaperField(t.db, 'paper:one', control.id)
      assignPaperField(t.db, 'paper:one', control.id)
      expect(listPaperFields(t.db, 'paper:one').map((field) => field.nameEn)).toEqual(['Control', 'Robotics'])
      expect(t.db.prepare('SELECT COUNT(*) AS n FROM paper_categories WHERE paper_id = ? AND category_id = ?').get('paper:one', control.id)).toMatchObject({ n: 1 })
      expect(listResearchFields(t.db).find((field) => field.id === robotics.id)?.nameZh).toBe('机器人学')
    } finally { close(t) }
  })

  it('renames in place, merges relations without loss, and deletes only the category relation', () => {
    const t = tempDb()
    try {
      paper(t.db, 'paper:one', 'One')
      paper(t.db, 'paper:two', 'Two')
      const source = createResearchField(t.db, { nameEn: 'Legged Robotics', nameZh: '足式机器人' })
      const target = createResearchField(t.db, { nameEn: 'Robotics', nameZh: '机器人学' })
      assignPaperField(t.db, 'paper:one', source.id)
      assignPaperField(t.db, 'paper:two', target.id)
      expect(renameResearchField(t.db, source.id, { nameEn: 'Legged Systems', nameZh: '足式系统' }).id).toBe(source.id)
      mergeResearchFields(t.db, source.id, target.id)
      expect(listPaperFields(t.db, 'paper:one').map((field) => field.id)).toEqual([target.id])
      expect(listResearchFields(t.db).some((field) => field.id === source.id)).toBe(false)
      deleteResearchField(t.db, target.id, 'detach')
      expect(t.db.prepare('SELECT id FROM papers WHERE id = ?').get('paper:one')).toBeTruthy()
      expect(listPaperFields(t.db, 'paper:one')).toEqual([])
    } finally { close(t) }
  })

  it('preserves manual exclusions and assignments when automatic classification runs again', () => {
    const t = tempDb()
    try {
      paper(t.db, 'paper:robot', 'Robust quadruped locomotion control with reinforcement learning')
      // The paper is now a library paper (manual PDF attached); classification
      // is triggered by the library entry point (SELECTED / manual import).
      resolvePaperFields(t.db, 'paper:robot')
      const initial = listPaperFields(t.db, 'paper:robot')
      expect(initial.map((field) => field.slug)).toEqual(expect.arrayContaining(['robotics', 'control', 'reinforcement-learning']))
      resolvePaperFields(t.db, 'paper:robot')
      const control = initial.find((field) => field.slug === 'control')!
      removePaperField(t.db, 'paper:robot', control.id)
      const manual = createResearchField(t.db, { nameEn: 'Custom Field', nameZh: '自定义领域' })
      assignPaperField(t.db, 'paper:robot', manual.id)
      resolvePaperFields(t.db, 'paper:robot')
      const after = listPaperFields(t.db, 'paper:robot')
      expect(after.some((field) => field.id === control.id)).toBe(false)
      expect(after.find((field) => field.id === manual.id)?.source).toBe('manual')
    } finally { close(t) }
  })

  it('preserves manual exclusions when a field is merged or moved', () => {
    const t = tempDb()
    try {
      paper(t.db, 'paper:excluded', 'Excluded')
      paper(t.db, 'paper:active', 'Active')
      const source = createResearchField(t.db, { nameEn: 'Source Field', nameZh: '源领域' })
      const target = createResearchField(t.db, { nameEn: 'Target Field', nameZh: '目标领域' })
      removePaperField(t.db, 'paper:excluded', source.id)
      assignPaperField(t.db, 'paper:active', source.id)
      removePaperField(t.db, 'paper:active', target.id)
      mergeResearchFields(t.db, source.id, target.id)
      expect(t.db.prepare('SELECT source, state FROM paper_categories WHERE paper_id = ? AND category_id = ?').get('paper:excluded', target.id)).toMatchObject({ source: 'manual', state: 'excluded' })
      expect(t.db.prepare('SELECT source, state FROM paper_categories WHERE paper_id = ? AND category_id = ?').get('paper:active', target.id)).toMatchObject({ source: 'manual', state: 'excluded' })

      paper(t.db, 'paper:moved', 'Moved')
      const moveSource = createResearchField(t.db, { nameEn: 'Move Source', nameZh: '移动源' })
      const moveTarget = createResearchField(t.db, { nameEn: 'Move Target', nameZh: '移动目标' })
      removePaperField(t.db, 'paper:moved', moveSource.id)
      deleteResearchField(t.db, moveSource.id, 'move', moveTarget.id)
      expect(t.db.prepare('SELECT source, state FROM paper_categories WHERE paper_id = ? AND category_id = ?').get('paper:moved', moveTarget.id)).toMatchObject({ source: 'manual', state: 'excluded' })
    } finally { close(t) }
  })

  it('auto-creates one normalized state-estimation field and backfills idempotently', () => {
    const t = tempDb()
    try {
      paper(t.db, 'paper:estimation', 'Visual-inertial state estimation for quadruped robots')
      resolvePaperFields(t.db, 'paper:estimation')
      backfillResearchFields(t.db)
      backfillResearchFields(t.db)
      const state = listResearchFields(t.db).filter((field) => field.slug === 'state-estimation')
      expect(state).toHaveLength(1)
      expect(listPaperFields(t.db, 'paper:estimation').map((field) => field.slug)).toContain('state-estimation')
      expect(t.db.prepare("SELECT COUNT(*) AS n FROM paper_categories WHERE paper_id = 'paper:estimation'").get()).toMatchObject({ n: expect.any(Number) })
    } finally { close(t) }
  })
})
