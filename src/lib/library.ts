/**
 * Library / Retrieved-Pool separation.
 *
 * The core invariant of the whole UI:
 *
 *   "retrieved" (检索到过) !== "in the library" (进入知识库).
 *
 * - RETRIEVED POOL: every paper ever surfaced by a retrieval / candidate
 *   generation step (papers row + retrievals/candidates history). This is a
 *   transient candidate / search-history pool and is deletable.
 * - LIBRARY: papers the user actually owns — Selected by the workflow,
 *   manually imported PDFs, or any paper with real content attached
 *   (PDF / read / report / favorite / manual category). Library papers are
 *   protected: removing their retrieval history must NEVER delete the paper
 *   entity, its PDF, reads, report, categories, or favorite state.
 *
 * `isLibraryPaper` is the single source of truth consumed by the adapter
 * (Research Fields / Topics counts), by the category resolver trigger, and
 * by the safe-retrieved-removal state machine.
 */
import { existsSync, unlinkSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Db } from '../db.js'
import { expandHome } from './paths.js'

export interface RemoveRetrievedResult {
  paperId: string
  /** true when at least one retrieval/candidate relation was removed */
  removedRetrieved: boolean
  /** true when the paper is part of the library → only history was removed */
  protectedLibrary: boolean
  /** true when the paper was a pure retrieved-only orphan and its row was cleaned up */
  orphanDeleted: boolean
  /** true when the paper had no retrieval/candidate history to remove */
  alreadyClean: boolean
}

export interface RemoveRetrievedBatchResult {
  /** papers whose retrieval/candidate history was removed (any reason) */
  removedRetrievedCount: number
  /** library papers that were protected — only retrieval history removed */
  protectedLibraryCount: number
  /** pure retrieved-only orphan papers whose metadata row was deleted */
  orphanPaperDeletedCount: number
  /** papers that could not be processed (db error etc.) */
  failedCount: number
}

const PDF_OK = "f.outcome IN ('ok','PDF_OK')"

/**
 * Reusable EXISTS sub-query fragment that matches papers belonging to the
 * library. `alias` is the papers-table alias used in the outer query (e.g.
 * 'p'). Keep in sync with isLibraryPaper().
 */
export function libraryPaperExistsSql(alias: string): string {
  return `(
    EXISTS (SELECT 1 FROM candidates c WHERE c.paper_id = ${alias}.id AND c.selection_outcome = 'SELECTED')
    OR EXISTS (SELECT 1 FROM fetch_log f WHERE f.paper_id = ${alias}.id AND ${PDF_OK} AND f.access_type IN ('manual','manual_upload'))
    OR EXISTS (SELECT 1 FROM fetch_log f WHERE f.paper_id = ${alias}.id AND ${PDF_OK} AND f.pdf_path IS NOT NULL AND f.pdf_path <> '')
    OR EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id = ${alias}.id AND ft.status = 'ok')
    OR EXISTS (SELECT 1 FROM fulltext_reads r WHERE r.paper_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM reports rp WHERE rp.paper_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM pushes pu WHERE pu.paper_id = ${alias}.id AND pu.report_path IS NOT NULL AND pu.report_path <> '')
    OR EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = ${alias}.id AND pc.source = 'manual')
    OR ${alias}.is_favorite = 1
  )`
}

/**
 * True when the paper belongs to the formal library:
 * Selected by the workflow, manually imported / registered PDF, has a
 * usable PDF / fulltext, has read records, has a report, is a favorite, or
 * carries a manual category assignment. Read/report/favorite/category rows
 * can only exist because the paper was already library-backed, so they act
 * as compatibility protection for legacy data.
 */
export function isLibraryPaper(db: Db, paperId: string): boolean {
  const row = db.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM candidates c WHERE c.paper_id = ? AND c.selection_outcome = 'SELECTED') AS selected,
       EXISTS (SELECT 1 FROM fetch_log f WHERE f.paper_id = ? AND ${PDF_OK} AND f.access_type IN ('manual','manual_upload')) AS manual_import,
       EXISTS (SELECT 1 FROM fetch_log f WHERE f.paper_id = ? AND ${PDF_OK} AND f.pdf_path IS NOT NULL AND f.pdf_path <> '') AS has_pdf,
       EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id = ? AND ft.status = 'ok') AS has_fulltext,
       EXISTS (SELECT 1 FROM fulltext_reads r WHERE r.paper_id = ?) AS has_reads,
       EXISTS (SELECT 1 FROM reports rp WHERE rp.paper_id = ?) AS has_report,
       EXISTS (SELECT 1 FROM pushes pu WHERE pu.paper_id = ? AND pu.report_path IS NOT NULL AND pu.report_path <> '') AS push_report,
       EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = ? AND pc.source = 'manual') AS manual_category,
       (SELECT is_favorite FROM papers WHERE id = ?) AS favorite`,
  ).get(
    paperId, paperId, paperId, paperId, paperId, paperId, paperId, paperId, paperId,
  ) as {
    selected: number; manual_import: number; has_pdf: number; has_fulltext: number
    has_reads: number; has_report: number; push_report: number; manual_category: number
    favorite: number | null
  }
  return (
    row.selected === 1 ||
    row.manual_import === 1 ||
    row.has_pdf === 1 ||
    row.has_fulltext === 1 ||
    row.has_reads === 1 ||
    row.has_report === 1 ||
    row.push_report === 1 ||
    row.manual_category === 1 ||
    row.favorite === 1
  )
}

/**
 * True when the paper has NO remaining retrieval/candidate history, no open
 * user action, and is not part of the library — i.e. it is safe to delete the
 * paper metadata row entirely (its rows all cascade from papers).
 */
export function isPaperOrphaned(db: Db, paperId: string): boolean {
  if (isLibraryPaper(db, paperId)) return false
  const row = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM retrievals r WHERE r.paper_id = ?) AS retrievals,
       (SELECT COUNT(*) FROM candidates c WHERE c.paper_id = ?) AS candidates,
       (SELECT COUNT(*) FROM user_actions ua WHERE ua.paper_id = ? AND ua.state = 'open') AS open_actions`,
  ).get(paperId, paperId, paperId) as { retrievals: number; candidates: number; open_actions: number }
  return row.retrievals === 0 && row.candidates === 0 && row.open_actions === 0
}

/**
 * Remove the retrieval/candidate history of one paper from the visible
 * Retrieved pool. Library papers are never deleted — only their history.
 * A pure retrieved-only orphan may have its papers row cleaned up.
 *
 * Always safe to call for any paper id; never throws for missing rows.
 */
export function removeRetrievedRecordSafely(db: Db, paperId: string): RemoveRetrievedResult {
  const exists = db.prepare('SELECT 1 FROM papers WHERE id = ?').get(paperId)
  if (exists === undefined) {
    return { paperId, removedRetrieved: false, protectedLibrary: false, orphanDeleted: false, alreadyClean: true }
  }
  const removedRetrieved = removeRetrievalHistory(db, paperId)
  const protectedLibrary = isLibraryPaper(db, paperId)
  let orphanDeleted = false
  if (!protectedLibrary && isPaperOrphaned(db, paperId)) {
    // Pure retrieved-only orphan with no library content and no remaining
    // references: cascade removes retrievals/candidates/fetch_log/categories.
    db.prepare('DELETE FROM papers WHERE id = ?').run(paperId)
    orphanDeleted = true
  }
  return {
    paperId,
    removedRetrieved,
    protectedLibrary,
    orphanDeleted,
    alreadyClean: !removedRetrieved && !orphanDeleted,
  }
}

/**
 * Batch variant: per-paper protection checks (never a blanket
 * `DELETE FROM papers WHERE id IN (...)`). Returns aggregate counters for
 * the UI confirmation copy.
 */
export function removeRetrievedBatch(db: Db, paperIds: string[]): RemoveRetrievedBatchResult {
  const result: RemoveRetrievedBatchResult = {
    removedRetrievedCount: 0,
    protectedLibraryCount: 0,
    orphanPaperDeletedCount: 0,
    failedCount: 0,
  }
  for (const paperId of paperIds) {
    try {
      const one = removeRetrievedRecordSafely(db, paperId)
      if (one.removedRetrieved) result.removedRetrievedCount += 1
      if (one.protectedLibrary) result.protectedLibraryCount += 1
      if (one.orphanDeleted) result.orphanPaperDeletedCount += 1
    } catch {
      result.failedCount += 1
    }
  }
  return result
}

export interface DeleteLibraryResult {
  deletedCount: number
  notFoundCount: number
  failedCount: number
}

/** Delete explicitly selected library papers and their managed local assets. */
export function deleteLibraryPapers(db: Db, paperIds: string[], dataDir: string): DeleteLibraryResult {
  const result: DeleteLibraryResult = { deletedCount: 0, notFoundCount: 0, failedCount: 0 }
  const root = resolve(dataDir)
  for (const paperId of paperIds) {
    const exists = db.prepare('SELECT 1 FROM papers WHERE id = ?').get(paperId)
    if (exists === undefined) { result.notFoundCount += 1; continue }
    const assets = [
      ...(db.prepare("SELECT pdf_path AS path FROM fetch_log WHERE paper_id = ? AND pdf_path IS NOT NULL AND pdf_path <> ''").all(paperId) as unknown as Array<{ path: string }>),
      ...(db.prepare("SELECT report_path AS path FROM reports WHERE paper_id = ? AND report_path IS NOT NULL AND report_path <> ''").all(paperId) as unknown as Array<{ path: string }>),
      ...(db.prepare("SELECT report_path AS path FROM pushes WHERE paper_id = ? AND report_path IS NOT NULL AND report_path <> ''").all(paperId) as unknown as Array<{ path: string }>),
    ].map((asset) => expandHome(asset.path)).filter((path) => {
      const rel = relative(root, resolve(path))
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
    try {
      db.prepare('DELETE FROM papers WHERE id = ?').run(paperId)
      result.deletedCount += 1
      for (const path of assets) if (existsSync(path)) { try { unlinkSync(path) } catch { /* best effort */ } }
    } catch {
      result.failedCount += 1
    }
  }
  return result
}

/**
 * Drop every retrievals row pointing at this paper and every non-library
 * candidates row. The SELECTED candidate row is the paper's library
 * membership credential (Selected state lives on candidates), so it is
 * preserved: removing a retrieved history must never un-select a paper.
 */
function removeRetrievalHistory(db: Db, paperId: string): boolean {
  const delRetrievals = db.prepare('DELETE FROM retrievals WHERE paper_id = ?').run(paperId).changes
  const delCandidates = db.prepare(
    `DELETE FROM candidates WHERE paper_id = ? AND (selection_outcome IS NULL OR selection_outcome NOT IN ('SELECTED'))`,
  ).run(paperId).changes
  return delRetrievals > 0 || delCandidates > 0
}

/**
 * Toggle the favorite flag. A favorite is part of the library definition
 * (isLibraryPaper), so favoriting a paper protects it from orphan cleanup.
 */
export function togglePaperFavorite(db: Db, paperId: string): { paperId: string; favorite: boolean } {
  const row = db.prepare('SELECT is_favorite FROM papers WHERE id = ?').get(paperId) as { is_favorite: number } | undefined
  if (row === undefined) throw new Error('PAPER_NOT_FOUND')
  const favorite = row.is_favorite !== 1
  db.prepare('UPDATE papers SET is_favorite = ? WHERE id = ?').run(favorite ? 1 : 0, paperId)
  return { paperId, favorite }
}

export function isPaperFavorite(db: Db, paperId: string): boolean {
  const row = db.prepare('SELECT is_favorite FROM papers WHERE id = ?').get(paperId) as { is_favorite: number } | undefined
  return row?.is_favorite === 1
}
