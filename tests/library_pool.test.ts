/**
 * Library / Retrieved-pool separation tests.
 *
 * Core invariant: "retrieved" !== "library". Retrieved-only candidates never
 * appear in Research Fields/Topics, are never auto-classified, and can be
 * cleaned up; library papers (Selected / manual import / PDF / read / report /
 * favorite / manual category) are protected from retrieval-history removal.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, upsertPaper, type Db } from '../src/db.js'
import { isLibraryPaper, isPaperFavorite, isPaperOrphaned, removeRetrievedBatch, removeRetrievedRecordSafely, togglePaperFavorite } from '../src/lib/library.js'
import { listPaperFields, listResearchFields, resolvePaperFields } from '../src/lib/research_fields.js'
import { listCategories, listPapers, getDashboard } from '../src/ui/adapter.js'

function tempDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-pool-'))
  return { db: openDb(dir), dir }
}

function close(t: { db: Db; dir: string }): void {
  t.db.close()
  rmSync(t.dir, { recursive: true, force: true })
}

function paper(db: Db, id: string, title: string, abstract = ''): void {
  upsertPaper(db, {
    id, title, abstract, authors: '[]', venue: null, year: 2026, doi: null,
    arxiv_id: null, openalex_id: null, url: null, oa_pdf_url: null,
    citations: null, bibtex: null, metadata_source: 'test',
  })
}

function push(db: Db, id: number, topic: string): void {
  db.prepare(
    `INSERT INTO pushes (id, topic, stage, status, started_at)
     VALUES (?, ?, 1, 'completed', datetime('now'))`,
  ).run(id, topic)
}

/** Retrieved-only candidate: paper + retrieval + candidate rows, no library content. */
function retrievedOnly(db: Db, paperId: string, title: string, pushId = 1, topic = 'control'): void {
  paper(db, paperId, title)
  push(db, pushId, topic)
  db.prepare(
    `INSERT INTO retrievals (push_id, paper_id, generated_query, query_language, source_adapter, candidate_pool)
     VALUES (?, ?, ?, 'en', 'test', 'recent')`,
  ).run(pushId, paperId, title)
  db.prepare(
    `INSERT INTO candidates (push_id, paper_id, agent_rank, final_score, candidate_pool)
     VALUES (?, ?, 1, 0.8, 'recent')`,
  ).run(pushId, paperId)
}

function makeSelected(db: Db, paperId: string, pushId = 1): void {
  db.prepare(
    `UPDATE candidates SET selection_outcome = 'SELECTED' WHERE push_id = ? AND paper_id = ?`,
  ).run(pushId, paperId)
}

function attachPdf(db: Db, paperId: string, source = 'manual', path = '/tmp/unused.pdf'): void {
  db.prepare(
    `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, access_type, is_open_access)
     VALUES (?, '[]', 'PDF_OK', ?, ?, 0)`,
  ).run(paperId, path, source)
}

function addRead(db: Db, paperId: string): void {
  db.prepare(`INSERT INTO fulltext_reads (paper_id, seq) VALUES (?, 0)`).run(paperId)
}

function addReport(db: Db, paperId: string, path = '/tmp/unused.md'): void {
  db.prepare(
    `INSERT INTO reports (paper_id, report_path, source) VALUES (?, ?, 'workflow')`,
  ).run(paperId, path)
}

function autoCategoryCount(db: Db, paperId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM paper_categories WHERE paper_id = ? AND source = 'auto' AND state = 'active'").get(paperId) as { n: number }
  return row.n
}

describe('library pool — isLibraryPaper', () => {
  it('retrieved-only paper is NOT a library paper', () => {
    const t = tempDb()
    try {
      retrievedOnly(t.db, 'p:retrieved', 'Retrieved Only Paper')
      expect(isLibraryPaper(t.db, 'p:retrieved')).toBe(false)
      expect(isPaperOrphaned(t.db, 'p:retrieved')).toBe(false) // still referenced
    } finally { close(t) }
  })

  it('selected paper IS a library paper', () => {
    const t = tempDb()
    try {
      retrievedOnly(t.db, 'p:sel', 'Selected Paper')
      makeSelected(t.db, 'p:sel')
      expect(isLibraryPaper(t.db, 'p:sel')).toBe(true)
    } finally { close(t) }
  })

  it('manual import (manual PDF) IS a library paper', () => {
    const t = tempDb()
    try {
      paper(t.db, 'p:manual', 'Manual Paper')
      attachPdf(t.db, 'p:manual', 'manual')
      expect(isLibraryPaper(t.db, 'p:manual')).toBe(true)
    } finally { close(t) }
  })

  it('pdf / read / report / favorite / manual category each make it a library paper', () => {
    const t = tempDb()
    try {
      paper(t.db, 'p:pdf', 'Pdf Only')
      attachPdf(t.db, 'p:pdf', 'oa')
      expect(isLibraryPaper(t.db, 'p:pdf')).toBe(true)
      paper(t.db, 'p:read', 'Read Only')
      addRead(t.db, 'p:read')
      expect(isLibraryPaper(t.db, 'p:read')).toBe(true)
      paper(t.db, 'p:report', 'Report Only')
      addReport(t.db, 'p:report')
      expect(isLibraryPaper(t.db, 'p:report')).toBe(true)
      paper(t.db, 'p:fav', 'Favorite Only')
      togglePaperFavorite(t.db, 'p:fav')
      expect(isLibraryPaper(t.db, 'p:fav')).toBe(true)
      expect(isPaperFavorite(t.db, 'p:fav')).toBe(true)
      paper(t.db, 'p:cat', 'Manual Category')
      resolvePaperFields(t.db, 'p:cat')
      // manual category assignment directly
      const field = listResearchFields(t.db).find((f) => f.slug === 'robotics') ?? listResearchFields(t.db)[0]!
      db: {
        const catId = field.id
        t.db.prepare(
          `INSERT INTO paper_categories (paper_id, category_id, source, state, confidence)
           VALUES (?, ?, 'manual', 'active', 1)`,
        ).run('p:cat', catId)
      }
      expect(isLibraryPaper(t.db, 'p:cat')).toBe(true)
    } finally { close(t) }
  })
})

describe('library pool — Research Fields / Topics only count library papers', () => {
  it('retrieved-only paper never appears in Research Fields', () => {
    const t = tempDb()
    try {
      retrievedOnly(t.db, 'p:retrieved', 'Robust quadruped locomotion control with reinforcement learning')
      resolvePaperFields(t.db, 'p:retrieved')
      expect(autoCategoryCount(t.db, 'p:retrieved')).toBe(0)
      expect(listPaperFields(t.db, 'p:retrieved')).toEqual([])
      const fields = listResearchFields(t.db)
      const total = fields.reduce((sum, f) => sum + f.count, 0)
      expect(total).toBe(0)
      expect(listCategories(t.db).find((c) => c.kind === 'topic')?.count ?? 0).toBe(0)
    } finally { close(t) }
  })

  it('selected paper appears in Research Fields and topic counts', () => {
    const t = tempDb()
    try {
      retrievedOnly(t.db, 'p:sel', 'Robust quadruped locomotion control with reinforcement learning')
      makeSelected(t.db, 'p:sel')
      resolvePaperFields(t.db, 'p:sel')
      expect(autoCategoryCount(t.db, 'p:sel')).toBeGreaterThan(0)
      const slugs = listPaperFields(t.db, 'p:sel').map((f) => f.slug)
      expect(slugs).toContain('robotics')
      const fields = listResearchFields(t.db)
      expect(fields.find((f) => f.slug === 'robotics')?.count ?? 0).toBe(1)
      const categories = listCategories(t.db)
      expect(categories.find((c) => c.kind === 'topic' && c.id === 'topic:control')?.count).toBe(1)
    } finally { close(t) }
  })

  it('manual import paper appears in Research Fields', () => {
    const t = tempDb()
    try {
      paper(t.db, 'p:manual', 'Quadruped locomotion model predictive control')
      attachPdf(t.db, 'p:manual', 'manual')
      resolvePaperFields(t.db, 'p:manual')
      expect(autoCategoryCount(t.db, 'p:manual')).toBeGreaterThan(0)
      expect(listResearchFields(t.db).find((f) => f.slug === 'robotics')?.count ?? 0).toBe(1)
    } finally { close(t) }
  })

  it('dashboard libraryCount counts only library papers', () => {
    const t = tempDb()
    try {
      retrievedOnly(t.db, 'p:retrieved', 'Retrieved Only')
      paper(t.db, 'p:manual', 'Manual Paper')
      attachPdf(t.db, 'p:manual', 'manual')
      const dash = getDashboard(t.db)
      expect(dash.paperCount).toBe(2)
      expect(dash.libraryCount).toBe(1)
    } finally { close(t) }
  })
})

describe('library pool — safe retrieved removal', () => {
  it('single removal of a retrieved-only orphan deletes the paper row', () => {
    const t = tempDb()
    try {
      retrievedOnly(t.db, 'p:orphan', 'Orphan Retrieved Paper')
      const result = removeRetrievedRecordSafely(t.db, 'p:orphan')
      expect(result.removedRetrieved).toBe(true)
      expect(result.protectedLibrary).toBe(false)
      expect(result.orphanDeleted).toBe(true)
      expect(t.db.prepare('SELECT 1 FROM papers WHERE id = ?').get('p:orphan')).toBeUndefined()
      expect(t.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE paper_id = ?').get('p:orphan')).toMatchObject({ n: 0 })
      expect(t.db.prepare('SELECT COUNT(*) AS n FROM retrievals WHERE paper_id = ?').get('p:orphan')).toMatchObject({ n: 0 })
    } finally { close(t) }
  })

  it('removal of a selected paper keeps the paper and its data, only history is dropped', () => {
    const t = tempDb()
    try {
      retrievedOnly(t.db, 'p:sel', 'Selected Paper')
      makeSelected(t.db, 'p:sel')
      attachPdf(t.db, 'p:sel', 'oa')
      addRead(t.db, 'p:sel')
      const reportFile = join(t.dir, 'report.md')
      writeFileSync(reportFile, '# report')
      addReport(t.db, 'p:sel', reportFile)
      resolvePaperFields(t.db, 'p:sel')
      const categoryCount = autoCategoryCount(t.db, 'p:sel')
      expect(categoryCount).toBeGreaterThan(0)
      const result = removeRetrievedRecordSafely(t.db, 'p:sel')
      expect(result.removedRetrieved).toBe(true)
      expect(result.protectedLibrary).toBe(true)
      expect(result.orphanDeleted).toBe(false)
      expect(t.db.prepare('SELECT 1 FROM papers WHERE id = ?').get('p:sel')).toBeTruthy()
      expect(t.db.prepare('SELECT 1 FROM fetch_log WHERE paper_id = ?').get('p:sel')).toBeTruthy()
      expect(t.db.prepare('SELECT 1 FROM fulltext_reads WHERE paper_id = ?').get('p:sel')).toBeTruthy()
      expect(t.db.prepare('SELECT 1 FROM reports WHERE paper_id = ?').get('p:sel')).toBeTruthy()
      expect(autoCategoryCount(t.db, 'p:sel')).toBe(categoryCount)
      expect(listPaperFields(t.db, 'p:sel').length).toBeGreaterThan(0)
      // Still visible under library-backed categories.
      expect(listPapers(t.db, { category: 'selected' }).map((p) => p.id)).toContain('p:sel')
      expect(listPapers(t.db, { category: 'read' }).map((p) => p.id)).toContain('p:sel')
      expect(listPapers(t.db, { category: 'reports' }).map((p) => p.id)).toContain('p:sel')
    } finally { close(t) }
  })

  it('removal keeps manual category, favorite, and deep-read availability intact', () => {
    const t = tempDb()
    try {
      const pdfFile = join(t.dir, 'real.pdf')
      writeFileSync(pdfFile, '%PDF-1.4 real')
      paper(t.db, 'p:manual', 'Manual Import Paper')
      attachPdf(t.db, 'p:manual', 'manual', pdfFile)
      togglePaperFavorite(t.db, 'p:manual')
      const field = listResearchFields(t.db)[0]!
      t.db.prepare(
        `INSERT INTO paper_categories (paper_id, category_id, source, state, confidence)
         VALUES (?, ?, 'manual', 'active', 1)`,
      ).run('p:manual', field.id)
      const result = removeRetrievedRecordSafely(t.db, 'p:manual')
      expect(result.alreadyClean).toBe(true) // no retrieval history at all
      expect(result.protectedLibrary).toBe(true)
      expect(isPaperFavorite(t.db, 'p:manual')).toBe(true)
      expect(listPaperFields(t.db, 'p:manual').map((f) => f.id)).toContain(field.id)
      expect(listPapers(t.db, { category: 'favorites' }).map((p) => p.id)).toContain('p:manual')
      expect(listPapers(t.db, { category: 'to-read' }).map((p) => p.id)).toContain('p:manual')
    } finally { close(t) }
  })

  it('same paper retrieved by multiple pushes: removal clears all history but keeps paper', () => {
    const t = tempDb()
    try {
      paper(t.db, 'p:multi', 'Multi Push Paper')
      for (let i = 1; i <= 3; i += 1) {
        push(t.db, i, 'control')
        db: {
          const pushId = i
          t.db.prepare(
            `INSERT INTO retrievals (push_id, paper_id, generated_query, query_language, source_adapter, candidate_pool)
             VALUES (?, ?, 'q', 'en', 'test', 'recent')`,
          ).run(pushId, 'p:multi')
          t.db.prepare(
            `INSERT INTO candidates (push_id, paper_id, agent_rank, candidate_pool) VALUES (?, ?, 1, 'recent')`,
          ).run(pushId, 'p:multi')
        }
      }
      // Paper B is a library paper in the same pool.
      paper(t.db, 'p:lib', 'Library Neighbor')
      attachPdf(t.db, 'p:lib', 'manual')
      const result = removeRetrievedRecordSafely(t.db, 'p:multi')
      expect(result.removedRetrieved).toBe(true)
      expect(result.protectedLibrary).toBe(false)
      expect(result.orphanDeleted).toBe(true) // no remaining refs after history removal
      expect(t.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE paper_id = ?').get('p:multi')).toMatchObject({ n: 0 })
      expect(t.db.prepare('SELECT 1 FROM papers WHERE id = ?').get('p:lib')).toBeTruthy()
      expect(isLibraryPaper(t.db, 'p:lib')).toBe(true)
    } finally { close(t) }
  })

  it('batch removal: per-paper protection, aggregate counters, never blanket DELETE', () => {
    const t = tempDb()
    try {
      retrievedOnly(t.db, 'p:orphan1', 'Orphan One')
      retrievedOnly(t.db, 'p:orphan2', 'Orphan Two', 2, 'control')
      retrievedOnly(t.db, 'p:sel', 'Selected Paper', 3, 'control')
      makeSelected(t.db, 'p:sel', 3)
      attachPdf(t.db, 'p:sel', 'oa')
      const result = removeRetrievedBatch(t.db, ['p:orphan1', 'p:orphan2', 'p:sel'])
      expect(result.removedRetrievedCount).toBe(3)
      expect(result.protectedLibraryCount).toBe(1)
      expect(result.orphanPaperDeletedCount).toBe(2)
      expect(result.failedCount).toBe(0)
      expect(t.db.prepare('SELECT 1 FROM papers WHERE id = ?').get('p:orphan1')).toBeUndefined()
      expect(t.db.prepare('SELECT 1 FROM papers WHERE id = ?').get('p:sel')).toBeTruthy()
      expect(isLibraryPaper(t.db, 'p:sel')).toBe(true)
    } finally { close(t) }
  })

  it('removal of a non-existent paper is a clean no-op', () => {
    const t = tempDb()
    try {
      const result = removeRetrievedRecordSafely(t.db, 'p:missing')
      expect(result.alreadyClean).toBe(true)
      expect(result.orphanDeleted).toBe(false)
      const batch = removeRetrievedBatch(t.db, ['p:missing'])
      expect(batch.removedRetrievedCount).toBe(0)
      expect(batch.failedCount).toBe(0)
    } finally { close(t) }
  })
})
