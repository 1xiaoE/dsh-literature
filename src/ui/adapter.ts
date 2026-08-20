/**
 * UI adapter — the presentation layer over the EXISTING dsh-literature
 * SQLite database and workflow state. This is the only place the browser UI
 * reads data from; it never re-implements retrieval/ranking/acquisition and
 * never writes to the core paper model.
 *
 * All reads go through the same schema.sql tables the tools/CLI use
 * (papers, pushes, candidates, fetch_log, fulltexts, fulltext_reads,
 * retrievals, user_actions, stages). Phase derivation for the Execution
 * panel is a pure VIEW over persisted push columns (performance audit +
 * progress counters) — the workflow itself is untouched.
 */
import { spawn, type StdioOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from '../db.js'
import type { LiteratureConfig } from '../config.js'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { expandHome } from '../lib/paths.js'
import { listPaperFields, listResearchFields } from '../lib/research_fields.js'
import { libraryPaperExistsSql } from '../lib/library.js'
import { RunnerService } from '../lib/runner_service.js'
import { buildResumePrompt, buildTaskPrompt } from '../lib/workflow_prompt.js'
import { classifyWorkflowError, failureFor, redactSensitiveText } from '../lib/workflow_errors.js'
import {
  isPaperFavorite,
  removeRetrievedBatch,
  removeRetrievedRecordSafely,
  togglePaperFavorite,
  type RemoveRetrievedBatchResult,
} from '../lib/library.js'
import type {
  UiAcquisitionLine,
  UiCategory,
  UiDashboard,
  UiPaperDetail,
  UiPaperSummary,
  UiPushPhase,
  UiPushStatus,
  UiRetrievalLine,
  UiRunResult,
  UiStageSummary,
  UiUserAction,
} from './types.js'

/**
 * Workflow categories backed by real data. `all` is the Retrieved pool:
 * every paper ever surfaced by retrieval/candidate generation — a transient
 * candidate/search-history pool, NOT the formal library. Favorites are a
 * real first-class library signal backed by papers.is_favorite.
 */
const WORKFLOW_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'Retrieved' },
  { id: 'library', label: 'Library' },
  { id: 'selected', label: 'Selected' },
  { id: 'to-read', label: 'To Read' },
  { id: 'read', label: 'Read' },
  { id: 'reports', label: 'Reports' },
  { id: 'favorites', label: 'Favorites' },
]

/** Parse the papers.authors JSON array (tolerant of legacy plain text). */
function parseAuthors(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[]
  } catch {
    // fall through to plain-text split
  }
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Shared paper-summary projection used by every listing query. */
const PAPER_SUMMARY_COLUMNS = `
  p.id,
  p.title,
  p.authors,
  p.venue,
  p.year,
  p.doi,
  p.citations,
  p.created_at,
  (SELECT MIN(c.agent_rank) FROM candidates c WHERE c.paper_id = p.id AND c.agent_rank IS NOT NULL) AS agent_rank,
  (SELECT MAX(c.final_score) FROM candidates c WHERE c.paper_id = p.id AND c.final_score IS NOT NULL) AS final_score,
  (SELECT COUNT(*) FROM candidates c WHERE c.paper_id = p.id AND c.selection_outcome = 'SELECTED') AS selected_count,
  (SELECT MAX(c.push_id) FROM candidates c WHERE c.paper_id = p.id AND c.selection_outcome = 'SELECTED') AS selected_push_id,
  (SELECT f.pdf_path FROM fetch_log f WHERE f.paper_id = p.id AND f.outcome IN ('ok','PDF_OK') AND f.pdf_path IS NOT NULL ORDER BY f.id DESC LIMIT 1) AS pdf_path,
  (SELECT COUNT(DISTINCT r.seq) FROM fulltext_reads r WHERE r.paper_id = p.id) AS read_count,
  (SELECT MAX(r.id) FROM fulltext_reads r WHERE r.paper_id = p.id) AS read_id,
  (SELECT f.chunk_count FROM fulltexts f WHERE f.paper_id = p.id AND f.status = 'ok') AS fulltext_chunks,
  (SELECT j.status FROM paper_reading_jobs j WHERE j.paper_id = p.id) AS reading_status,
  (SELECT pu.report_path FROM pushes pu WHERE pu.paper_id = p.id AND pu.report_path IS NOT NULL AND pu.report_path <> '' ORDER BY pu.id DESC LIMIT 1) AS report_path,
  (SELECT MAX(pu.id) FROM pushes pu WHERE pu.paper_id = p.id AND pu.report_path IS NOT NULL AND pu.report_path <> '') AS report_push_id,
  (SELECT topic FROM candidates c JOIN pushes pu ON pu.id = c.push_id WHERE c.paper_id = p.id ORDER BY pu.id DESC LIMIT 1) AS topic,
  p.is_favorite,
  ${libraryPaperExistsSql('p')} AS is_library
`

interface PaperRow extends Record<string, unknown> {
  id: string
  title: string
  authors: string | null
  venue: string | null
  year: number | null
  doi: string | null
  citations: number | null
  created_at: string | null
  agent_rank: number | null
  final_score: number | null
  selected_count: number | null
  selected_push_id: number | null
  pdf_path: string | null
  read_count: number | null
  read_id: number | null
  report_path: string | null
  report_push_id: number | null
  topic: string | null
  fulltext_chunks: number | null
  reading_status: 'running' | 'completed' | 'failed' | null
  is_favorite: number | null
  is_library: number | null
}

function usableFile(path: string | null): string | null {
  if (path === null || path.trim() === '') return null
  const resolved = expandHome(path)
  try {
    const stat = statSync(resolved)
    return stat.isFile() && stat.size > 0 ? resolved : null
  } catch {
    return null
  }
}

interface FetchAssetRow {
  paper_id?: string
  pdf_path: string | null
  pdf_source: string | null
  access_type: string | null
  is_open_access: number | null
  outcome: string
}

interface ReportAssetRow { id: number; paper_id?: string; report_path: string }

interface UsableAssetMaps {
  pdf: Map<string, FetchAssetRow & { path: string }>
  report: Map<string, ReportAssetRow & { path: string }>
}

/** Load asset histories once for a paper set, choosing the newest real file. */
function usableAssetsForPapers(db: Db, paperIds?: string[]): UsableAssetMaps {
  const pdf = new Map<string, FetchAssetRow & { path: string }>()
  const report = new Map<string, ReportAssetRow & { path: string }>()
  if (paperIds?.length === 0) return { pdf, report }
  const where = paperIds === undefined ? '' : ` AND paper_id IN (${paperIds.map(() => '?').join(',')})`
  const params = paperIds ?? []
  const fetchRows = db.prepare(
    `SELECT paper_id, pdf_path, pdf_source, access_type, is_open_access, outcome
     FROM fetch_log
     WHERE outcome IN ('ok','PDF_OK') AND pdf_path IS NOT NULL${where}
     ORDER BY id DESC`,
  ).all(...params) as unknown as Array<FetchAssetRow & { paper_id: string }>
  for (const row of fetchRows) {
    if (pdf.has(row.paper_id)) continue
    const path = usableFile(row.pdf_path)
    if (path !== null) pdf.set(row.paper_id, { ...row, path })
  }
  const reportRows = db.prepare(
    `SELECT id, paper_id, report_path FROM (
       SELECT rowid AS id, paper_id, report_path, updated_at AS event_at FROM reports${paperIds === undefined ? '' : ` WHERE paper_id IN (${paperIds.map(() => '?').join(',')})`}
       UNION ALL
       SELECT id, paper_id, report_path, COALESCE(finished_at, started_at) AS event_at FROM pushes
       WHERE paper_id IS NOT NULL AND report_path IS NOT NULL AND report_path <> ''${where}
     ) ORDER BY event_at DESC, id DESC`,
  ).all(...params, ...params) as unknown as Array<ReportAssetRow & { paper_id: string }>
  for (const row of reportRows) {
    if (report.has(row.paper_id)) continue
    const path = usableFile(row.report_path)
    if (path !== null) report.set(row.paper_id, { ...row, path })
  }
  return { pdf, report }
}

/** Count distinct papers with a real report without hydrating paper rows. */
function countUsableReports(db: Db): number {
  const rows = db.prepare(
    `SELECT paper_id, report_path FROM reports
     UNION ALL SELECT paper_id, report_path FROM pushes WHERE paper_id IS NOT NULL AND report_path IS NOT NULL AND report_path <> ''`,
  ).all() as unknown as Array<{ paper_id: string; report_path: string }>
  const found = new Set<string>()
  for (const row of rows) {
    if (!found.has(row.paper_id) && usableFile(row.report_path) !== null) found.add(row.paper_id)
  }
  return found.size
}

function paperFetchAssets(db: Db, paperId: string): { latest?: FetchAssetRow; usable?: FetchAssetRow & { path: string } } {
  const rows = db.prepare(
    `SELECT pdf_path, pdf_source, access_type, is_open_access, outcome
     FROM fetch_log WHERE paper_id = ? ORDER BY id DESC`,
  ).all(paperId) as unknown as FetchAssetRow[]
  const usable = rows
    .filter((row) => row.outcome === 'ok' || row.outcome === 'PDF_OK')
    .map((row) => ({ ...row, path: usableFile(row.pdf_path) }))
    .find((row): row is FetchAssetRow & { path: string } => row.path !== null)
  return { latest: rows[0], usable }
}

function paperReportAsset(db: Db, paperId: string): (ReportAssetRow & { path: string }) | undefined {
  const rows = db.prepare(
    `SELECT id, report_path FROM (
       SELECT rowid AS id, report_path, updated_at AS event_at FROM reports WHERE paper_id = ?
       UNION ALL SELECT id, report_path, COALESCE(finished_at, started_at) AS event_at FROM pushes WHERE paper_id = ? AND report_path IS NOT NULL AND report_path <> ''
     ) ORDER BY event_at DESC, id DESC`,
  ).all(paperId, paperId) as unknown as ReportAssetRow[]
  return rows
    .map((row) => ({ ...row, path: usableFile(row.report_path) }))
    .find((row): row is ReportAssetRow & { path: string } => row.path !== null)
}

function toSummary(db: Db, row: PaperRow, pdfPath: string | null = usableFile(row.pdf_path), reportPath: string | null = usableFile(row.report_path), isOpenAccess: boolean | null = null): UiPaperSummary {
  return {
    id: row.id,
    title: row.title,
    authors: parseAuthors(row.authors),
    year: row.year,
    venue: row.venue,
    doi: row.doi,
    citations: row.citations,
    agentRank: row.agent_rank,
    finalScore: row.final_score,
    selected: (row.selected_count ?? 0) > 0,
    hasPdf: pdfPath !== null,
    isOpenAccess,
    readCount: row.read_count ?? 0,
    fulltextChunks: row.fulltext_chunks ?? null,
    readCoverage: row.fulltext_chunks && row.fulltext_chunks > 0 ? Math.min(1, (row.read_count ?? 0) / row.fulltext_chunks) : null,
    readingStatus: row.reading_status ?? null,
    reportCount: reportPath === null ? 0 : 1,
    topic: row.topic,
    createdAt: row.created_at,
    favorite: row.is_favorite === 1,
    // Precomputed in the shared projection (one correlated EXISTS, no N+1
    // per-paper isLibraryPaper() calls in the hot list path).
    isLibrary: row.is_library === 1,
  }
}

export interface PapersFilter {
  /** category id from listCategories(): workflow id | 'field:<id>' | 'topic:<name>' */
  category?: string
  /** Server-side pagination: max rows returned (default 500). */
  limit?: number
  /** Server-side pagination: row offset (default 0). */
  offset?: number
}

/** Resolve the category branch into a reusable WHERE clause for p/count. */
function papersWhere(db: Db, filter: PapersFilter): { where: string[]; params: string[] } {
  const where: string[] = []
  const params: string[] = []
  const category = filter.category ?? 'all'

  if (category === 'all' || category === '') {
    // no filter
  } else if (category === 'library') {
    where.push(libraryPaperExistsSql('p'))
  } else if (category === 'selected') {
    where.push("EXISTS (SELECT 1 FROM candidates c WHERE c.paper_id = p.id AND c.selection_outcome = 'SELECTED')")
  } else if (category === 'to-read') {
    where.push(`EXISTS (SELECT 1 FROM fetch_log f WHERE f.paper_id = p.id AND f.outcome IN ('ok','PDF_OK') AND f.pdf_path IS NOT NULL)
      AND NOT (
        EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id = p.id AND ft.status = 'ok' AND (SELECT COUNT(DISTINCT r.seq) FROM fulltext_reads r WHERE r.paper_id = p.id) >= ft.chunk_count)
        OR (NOT EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id = p.id) AND EXISTS (SELECT 1 FROM fulltext_reads r WHERE r.paper_id = p.id))
      )`)
  } else if (category === 'read') {
    where.push("(EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id=p.id AND ft.status='ok' AND (SELECT COUNT(DISTINCT r.seq) FROM fulltext_reads r WHERE r.paper_id=p.id) >= ft.chunk_count) OR (NOT EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id=p.id) AND EXISTS (SELECT 1 FROM fulltext_reads r WHERE r.paper_id=p.id)))")
  } else if (category === 'reports') {
    where.push("EXISTS (SELECT 1 FROM reports r WHERE r.paper_id=p.id) OR EXISTS (SELECT 1 FROM pushes pu WHERE pu.paper_id = p.id AND pu.report_path IS NOT NULL AND pu.report_path <> '')")
  } else if (category === 'favorites') {
    where.push('p.is_favorite = 1')
  } else if (category.startsWith('topic:')) {
    const topic = category.slice('topic:'.length)
    where.push(`EXISTS (
      SELECT 1 FROM candidates c JOIN pushes pu ON pu.id = c.push_id
      WHERE c.paper_id = p.id AND pu.topic = ?
    )`)
    params.push(topic)
  } else if (category.startsWith('field:')) {
    const categoryId = Number(category.slice('field:'.length))
    if (Number.isInteger(categoryId) && categoryId > 0) {
      where.push(`EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = p.id AND pc.category_id = ? AND pc.state = 'active')
        AND ${libraryPaperExistsSql('p')}`)
      params.push(String(categoryId))
    } else {
      where.push('1 = 0')
    }
  }
  return { where, params }
}

/** Exact count of papers matching the filter (used by category badges). */
export function countPapers(db: Db, filter: PapersFilter = {}): number {
  const { where, params } = papersWhere(db, filter)
  const sql = `SELECT COUNT(*) AS n FROM papers p
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`
  const row = db.prepare(sql).get(...params) as { n: number }
  return row.n
}

/** List paper summaries with an optional category filter. */
export function listPapers(db: Db, filter: PapersFilter = {}): UiPaperSummary[] {
  const { where, params } = papersWhere(db, filter)
  const category = filter.category ?? 'all'
  const limit = filter.limit ?? 500
  const offset = filter.offset ?? 0

  const orderBy = category === 'selected'
    ? 'selected_push_id DESC, p.created_at DESC'
    : category === 'reports'
      ? 'report_push_id DESC, p.created_at DESC'
      : category === 'read'
        ? 'read_id DESC, p.created_at DESC'
        : 'COALESCE(p.year, 0) DESC, p.created_at DESC'
  const sql = `SELECT ${PAPER_SUMMARY_COLUMNS} FROM papers p
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...params, limit, offset) as unknown as PaperRow[]
  const assets = usableAssetsForPapers(db, rows.map((row) => row.id))
  const papers = rows.map((row) => {
    const fetch = assets.pdf.get(row.id)
    const report = assets.report.get(row.id)
    return { paper: toSummary(db, row, fetch?.path ?? null, report?.path ?? null, fetch?.is_open_access === null || fetch?.is_open_access === undefined ? null : fetch.is_open_access === 1), reportPushId: report?.id ?? 0 }
  })
  if (category === 'reports') {
    return papers
      .filter(({ paper }) => paper.reportCount > 0)
      .sort((a, b) => b.reportPushId - a.reportPushId)
      .map(({ paper }) => paper)
  }
  return papers.map(({ paper }) => paper)
}

/** Full detail for the right-hand panel (fields exist → mapped; missing → null). */
export function getPaperDetail(db: Db, id: string): UiPaperDetail | null {
  const row = db.prepare(
    `SELECT ${PAPER_SUMMARY_COLUMNS}, p.abstract, p.arxiv_id, p.openalex_id, p.url, p.oa_pdf_url,
       p.bibtex, p.metadata_source, p.affiliation, p.keywords
     FROM papers p WHERE p.id = ?`,
  ).get(id) as unknown as PaperRow & {
    abstract: string | null
    arxiv_id: string | null
    openalex_id: string | null
    url: string | null
    oa_pdf_url: string | null
    bibtex: string | null
    metadata_source: string | null
    affiliation: string | null
    keywords: string | null
  }
  if (row === undefined) return null

  const cand = db.prepare(
    `SELECT c.agent_rank, c.final_score, c.rationale, c.selection_outcome, c.acquisition_outcome,
            c.acquisition_reason, pu.stage
     FROM candidates c JOIN pushes pu ON pu.id = c.push_id WHERE c.paper_id = ?
     ORDER BY (c.agent_rank IS NULL), c.agent_rank ASC, c.rowid DESC LIMIT 1`,
  ).get(id) as
    | { agent_rank: number | null; final_score: number | null; rationale: string | null; selection_outcome: string | null; acquisition_outcome: string | null; acquisition_reason: string | null; stage: number | null }
    | undefined

  const fetchAssets = paperFetchAssets(db, id)
  const fetch = fetchAssets.usable ?? fetchAssets.latest

  const ft = db.prepare(
    `SELECT status, chunk_count FROM fulltexts WHERE paper_id = ?`,
  ).get(id) as { status: string | null; chunk_count: number | null } | undefined

  const report = paperReportAsset(db, id)
  const base = toSummary(db, row, fetchAssets.usable?.path ?? null, report?.path ?? null, fetchAssets.usable?.is_open_access === null || fetchAssets.usable?.is_open_access === undefined ? null : fetchAssets.usable.is_open_access === 1)

  return {
    ...base,
    researchFields: listPaperFields(db, id).map((field) => ({
      id: field.id, slug: field.slug, nameEn: field.nameEn, nameZh: field.nameZh, source: field.source,
    })),
    abstract: row.abstract,
    arxivId: row.arxiv_id,
    openalexId: row.openalex_id,
    url: row.url,
    oaPdfUrl: row.oa_pdf_url,
    bibtex: row.bibtex,
    metadataSource: row.metadata_source,
    affiliation: row.affiliation,
    keywords: (() => { try { const parsed: unknown = JSON.parse(row.keywords ?? '[]'); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [] } catch { return [] } })(),
    metadataStatus: row.title && parseAuthors(row.authors).length > 0 && row.year && row.venue ? 'complete' : 'partial',
    selectionReason: cand?.rationale ?? null,
    stage: cand?.stage ?? null,
    selectionOutcome: cand?.selection_outcome ?? null,
    acquisitionOutcome: cand?.acquisition_outcome ?? null,
    acquisitionReason: cand?.acquisition_reason ?? null,
    fulltextStatus: ft?.status ?? null,
    fulltextChunks: ft?.chunk_count ?? base.fulltextChunks,
    readCoverage: ft?.chunk_count && ft.chunk_count > 0 ? Math.min(1, base.readCount / ft.chunk_count) : base.readCoverage,
    pdfPath: fetchAssets.usable?.path ?? null,
    pdfSource: fetch?.pdf_source ?? null,
    accessType: fetch?.access_type ?? null,
    isOpenAccess: fetch === undefined ? null : fetch.is_open_access === 1,
    reportPath: report?.path ?? null,
  }
}

interface CategoryRow extends Record<string, unknown> {
  topic: string | null
  n: number
}

/** Category list: workflow, persisted research fields, and workflow topics. */
export function listCategories(db: Db): UiCategory[] {
  const categories: UiCategory[] = []
  const scalarCount = (sql: string, params: string[] = []): number =>
    (db.prepare(sql).get(...params) as { n: number }).n
  const reportCount = countUsableReports(db)
  for (const w of WORKFLOW_CATEGORIES) {
    const n = w.id === 'all'
      ? scalarCount('SELECT COUNT(*) AS n FROM papers')
      : w.id === 'library'
        ? countPapers(db, { category: 'library' })
      : w.id === 'selected'
        ? scalarCount("SELECT COUNT(DISTINCT paper_id) AS n FROM candidates WHERE selection_outcome = 'SELECTED'")
        : w.id === 'to-read'
          // SQL aggregate over the whole table — never the 500-row list cap.
          ? countPapers(db, { category: 'to-read' })
        : w.id === 'read'
          ? scalarCount("SELECT COUNT(DISTINCT r.paper_id) AS n FROM fulltext_reads r WHERE NOT EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id=r.paper_id) OR EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id=r.paper_id AND ft.status='ok' AND (SELECT COUNT(DISTINCT r2.seq) FROM fulltext_reads r2 WHERE r2.paper_id=ft.paper_id) >= ft.chunk_count)")
        : w.id === 'reports'
          ? reportCount
          : w.id === 'favorites'
            ? scalarCount('SELECT COUNT(*) AS n FROM papers WHERE is_favorite = 1')
            : 0
    categories.push({ id: w.id, label: w.label, kind: 'workflow', count: n })
  }
  for (const field of listResearchFields(db)) {
    categories.push({
      id: `field:${field.id}`, label: field.nameEn, labelEn: field.nameEn, labelZh: field.nameZh,
      categoryId: field.id, createdBy: field.createdBy, kind: 'field', count: field.count,
    })
  }
  // Real topics present in the pushes table — restricted to library papers:
  // the candidate pool must never inflate Research Topics.
  const rows = db.prepare(
    `SELECT pu.topic, COUNT(DISTINCT c.paper_id) AS n
     FROM pushes pu JOIN candidates c ON c.push_id = pu.id
     JOIN papers p ON p.id = c.paper_id
     WHERE ${libraryPaperExistsSql('p')}
     GROUP BY pu.topic ORDER BY n DESC`,
  ).all() as unknown as CategoryRow[]
  for (const r of rows) {
    if (r.topic === null || r.topic === '') continue
    categories.push({ id: `topic:${r.topic}`, label: r.topic, kind: 'topic', count: r.n })
  }
  return categories
}

/** Stage rows from the stages table (no cfg needed). */
function listStages(db: Db): UiStageSummary[] {
  const rows = db.prepare(
    `SELECT topic, current, papers_in_stage, target_papers FROM stages ORDER BY topic`,
  ).all() as unknown as Array<{ topic: string; current: number; papers_in_stage: number; target_papers: number }>
  return rows.map((r) => ({
    topic: r.topic,
    current: r.current,
    label: null,
    papersInStage: r.papers_in_stage,
    targetPapers: r.target_papers,
  }))
}

/** Top-level dashboard aggregate. */
export function getDashboard(db: Db): UiDashboard {
  const papers = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number }
  const library = db.prepare(
    `SELECT COUNT(*) AS n FROM papers p WHERE ${libraryPaperExistsSql('p')}`,
  ).get() as { n: number }
  const pushes = db.prepare('SELECT COUNT(*) AS n FROM pushes').get() as { n: number }
  const latest = db.prepare(
    `SELECT id, status, topic FROM pushes ORDER BY id DESC LIMIT 1`,
  ).get() as { id: number; status: string; topic: string } | undefined
  return {
    paperCount: papers.n,
    libraryCount: library.n,
    pushCount: pushes.n,
    reportCount: countUsableReports(db),
    categories: listCategories(db),
    latestPush: latest ?? null,
    stages: listStages(db),
  }
}

/** Remove one paper's retrieval/candidate history (safe, library-protected). */
export function removeRetrieved(db: Db, paperId: string) {
  return removeRetrievedRecordSafely(db, paperId)
}

/** Remove many papers' retrieval histories, per-paper protection checks. */
export function bulkRemoveRetrieved(db: Db, paperIds: string[]): RemoveRetrievedBatchResult {
  return removeRetrievedBatch(db, paperIds)
}

/** Toggle favorite membership (favorites are part of the library). */
export function setPaperFavorite(db: Db, paperId: string) {
  return togglePaperFavorite(db, paperId)
}

export { isPaperFavorite }

interface PushRow extends Record<string, unknown> {
  id: number
  topic: string
  stage: number
  status: string
  started_at: string
  finished_at: string | null
  error_code: string | null
  error_detail: string | null
  paper_id: string | null
  report_path: string | null
  notes: string | null
  total_chunks: number | null
  read_chunks: number | null
  read_coverage: number | null
  retrieval_ms: number | null
  agent_ranking_ms: number | null
  fulltext_read_ms: number | null
  report_generation_ms: number | null
  total_ms: number | null
  raw_candidates: number | null
  deterministic_candidates: number | null
  agent_scored_candidates: number | null
  llm_call_count: number | null
}

interface LiveProgress {
  retrievalCount: number
  candidateCount: number
  rankedCount: number
  selectedPaperId: string | null
  totalChunks: number | null
  readChunks: number
}

/** Derive the live phase from workflow tables written at each existing tool boundary. */
function derivePhase(push: PushRow, progress: LiveProgress): UiPushPhase {
  switch (push.status) {
    case 'completed':
    case 'no_candidate':
    case 'fulltext_unavailable':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'auth_required':
    case 'user_action_required':
      return 'auth_required'
    default:
      break
  }
  if (progress.retrievalCount === 0 && progress.candidateCount === 0) return 'retrieving'
  if (progress.rankedCount === 0) return 'ranking'
  if (progress.selectedPaperId === null) return 'acquiring'
  if (push.report_path !== null && push.report_path !== '') return 'reporting'
  return 'reading'
}

/**
 * Project the latest child-process lifecycle into the execution payload.
 * A runner can fail before literature_push_now creates a pushes row, so this
 * is deliberately separate from the persisted push phase. Older runner jobs
 * are hidden once a newer push has started.
 */
function runnerStatus(db: Db, pushStartedAt?: string): UiPushStatus['runner'] {
  const job = new RunnerService(db).latestJob()
  if (job === null || (pushStartedAt !== undefined && job.startedAt < pushStartedAt)) return null
  return {
    status: job.status,
    kind: job.kind,
    message: job.message,
    errorCode: job.errorCode,
    retryable: job.retryable,
    provider: job.provider,
    model: job.model,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    logPath: job.logPath,
  }
}

/** Execution panel payload for the latest push (real persisted state). */
export function getPushStatus(db: Db, cfg?: LiteratureConfig): UiPushStatus {
  const push = db.prepare('SELECT * FROM pushes ORDER BY id DESC LIMIT 1').get() as PushRow | undefined
  if (push === undefined) {
    return {
      present: false,
      pushId: null,
      phase: 'idle',
      label: 'IDLE',
      rawStatus: null,
      topic: null,
      stage: null,
      stageLabel: null,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorDetail: null,
      running: false,
      staleRunning: false,
      lastActivityAt: null,
      retrieving: [],
      retrievedPapers: null,
      candidatesRanked: null,
      acquisition: [],
      reading: { totalChunks: null, readChunks: null, coverage: null },
      reporting: { reportGenerationMs: null, reportPath: null },
      authRequired: null,
      notes: null,
      perf: { retrievalMs: null, rankingMs: null, totalMs: null, llmCallCount: null },
      runner: runnerStatus(db),
    }
  }

  // Retrieval per-source lines for this push (retrievals table).
  const retrievals = db.prepare(
    `SELECT source_adapter, MIN(retrieved_at) AS retrieved_at
     FROM retrievals WHERE push_id = ? GROUP BY source_adapter ORDER BY retrieved_at ASC`,
  ).all(push.id) as unknown as Array<{ source_adapter: string; retrieved_at: string }>
  const retrieving: UiRetrievalLine[] = retrievals.map((r) => ({
    source: r.source_adapter,
    retrievedAt: r.retrieved_at,
  }))

  // Stale-running detection: a 'running' push whose newest persisted activity
  // (retrieval row, or the push start when nothing was written yet) is older
  // than the window usually means the headless runner died without finalizing
  // — surface it so the Execution panel warns instead of looking frozen.
  const lastActivityAt = retrievals.map((r) => r.retrieved_at).sort().at(-1) ?? push.started_at
  let staleRunning = false
  if (push.status === 'running' && lastActivityAt !== null) {
    const parsed = Date.parse(`${lastActivityAt.replace(' ', 'T')}Z`)
    if (!Number.isNaN(parsed)) staleRunning = Date.now() - parsed > STALE_RUNNING_MS
  }

  const retrievalCount = (db.prepare(
    'SELECT COUNT(DISTINCT paper_id) AS n FROM retrievals WHERE push_id = ?',
  ).get(push.id) as { n: number }).n
  const candidateStats = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN agent_rank IS NOT NULL THEN 1 ELSE 0 END) AS ranked
     FROM candidates WHERE push_id = ?`,
  ).get(push.id) as { total: number; ranked: number | null }
  const selected = db.prepare(
    `SELECT paper_id FROM candidates
     WHERE push_id = ? AND acquisition_outcome = 'SELECTED'
     ORDER BY agent_rank ASC LIMIT 1`,
  ).get(push.id) as { paper_id: string } | undefined
  const selectedPaperId = selected?.paper_id ?? push.paper_id
  const liveReading = selectedPaperId === null ? undefined : db.prepare(
    `SELECT ft.chunk_count AS total_chunks,
            (SELECT COUNT(DISTINCT r.seq) FROM fulltext_reads r WHERE r.push_id = ? AND r.paper_id = ?) AS read_chunks
     FROM fulltexts ft WHERE ft.paper_id = ? AND ft.status = 'ok'`,
  ).get(push.id, selectedPaperId, selectedPaperId) as { total_chunks: number | null; read_chunks: number } | undefined
  const liveProgress: LiveProgress = {
    retrievalCount,
    candidateCount: candidateStats.total,
    rankedCount: candidateStats.ranked ?? 0,
    selectedPaperId,
    totalChunks: liveReading?.total_chunks ?? push.total_chunks,
    readChunks: liveReading?.read_chunks ?? push.read_chunks ?? 0,
  }

  // Acquisition trace per candidate (Quality First rank-by-rank attempts).
  const cands = db.prepare(
    `SELECT c.agent_rank, c.paper_id, p.title, c.public_preflight_status, c.acquisition_outcome, c.acquisition_reason
     FROM candidates c JOIN papers p ON p.id = c.paper_id
     WHERE c.push_id = ?
       AND (c.agent_rank IS NOT NULL OR c.selection_outcome IS NOT NULL OR c.acquisition_outcome IS NOT NULL)
     ORDER BY COALESCE(c.agent_rank, 999) ASC`,
  ).all(push.id) as unknown as Array<{
    agent_rank: number | null
    paper_id: string
    title: string
    public_preflight_status: string | null
    acquisition_outcome: string | null
    acquisition_reason: string | null
  }>
  const acquisition: UiAcquisitionLine[] = cands.map((c) => ({
    agentRank: c.agent_rank ?? 0,
    paperId: c.paper_id,
    title: c.title,
    publicPreflight: c.public_preflight_status,
    outcome: c.acquisition_outcome,
    reason: c.acquisition_reason,
  }))

  // Open user actions (AUTH_REQUIRED / NEED_USER_ACTION HITL).
  const actions: UiUserAction[] = []
  const openActions = db.prepare(
    `SELECT ua.*, p.title AS paper_title
     FROM user_actions ua LEFT JOIN papers p ON p.id = ua.paper_id
     WHERE ua.push_id = ? AND ua.state = 'open' ORDER BY ua.id ASC`,
  ).all(push.id) as unknown as Array<{
    id: number
    paper_id: string | null
    paper_title: string | null
    step: string
    kind: string
    issue: string
    attempts: string | null
    what_user_should_do: string
    how_to_continue: string
  }>
  for (const a of openActions) {
    let attempts: string[] = []
    try {
      const parsed: unknown = a.attempts ? JSON.parse(a.attempts) : []
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) attempts = parsed as string[]
    } catch {
      attempts = []
    }
    actions.push({
      id: a.id,
      paperId: a.paper_id,
      paperTitle: a.paper_title,
      step: a.step,
      kind: a.kind,
      issue: a.issue,
      attempts,
      whatUserShouldDo: a.what_user_should_do,
      howToContinue: a.how_to_continue,
    })
  }

  const phase = derivePhase(push, liveProgress)

  // Publisher host for the auth card: from the latest fetch_log pdf_source of
  // the stuck paper (real provenance, not a guess).
  const stuckPaperId = actions[0]?.paperId ?? push.paper_id
  let publisher: string | null = null
  if (phase === 'auth_required' && stuckPaperId !== null) {
    const src = db.prepare(
      `SELECT pdf_source FROM fetch_log WHERE paper_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(stuckPaperId) as { pdf_source: string | null } | undefined
    const sourceUrl = src?.pdf_source ?? null
    if (sourceUrl !== null) {
      try {
        const host = new URL(sourceUrl).hostname
        if (host !== '' && host !== 'localhost') publisher = host
      } catch {
        publisher = sourceUrl
      }
    }
  }

  const authRequired = phase === 'auth_required'
    ? {
        paperTitle: actions[0]?.paperTitle ?? (push.paper_id !== null ? push.paper_id : null),
        publisher,
        rank: acquisition.find((a) => a.paperId === stuckPaperId && a.agentRank > 0)?.agentRank ?? null,
        reason: actions[0]?.issue ?? push.error_detail,
        nextStep: actions[0]?.whatUserShouldDo ?? null,
        actions,
      }
    : null

  const stageLabel = cfg !== undefined && push.stage !== null
    ? cfg.stageOrder[push.stage - 1]?.label ?? null
    : null

  return {
    present: true,
    pushId: push.id,
    phase,
    label: phase.toUpperCase(),
    rawStatus: push.status,
    topic: push.topic,
    stage: push.stage,
    stageLabel,
    startedAt: push.started_at,
    finishedAt: push.finished_at,
    errorCode: push.error_code,
    errorDetail: push.error_detail,
    running: push.status === 'running',
    staleRunning,
    lastActivityAt,
    retrieving,
    retrievedPapers: retrievalCount > 0 ? retrievalCount : null,
    candidatesRanked: liveProgress.rankedCount > 0
      ? liveProgress.rankedCount
      : push.agent_scored_candidates ?? push.deterministic_candidates,
    acquisition,
    reading: {
      totalChunks: liveProgress.totalChunks,
      readChunks: liveProgress.totalChunks === null ? push.read_chunks : liveProgress.readChunks,
      coverage: liveProgress.totalChunks !== null && liveProgress.totalChunks > 0
        ? liveProgress.readChunks / liveProgress.totalChunks
        : push.read_coverage,
    },
    reporting: {
      reportGenerationMs: push.report_generation_ms,
      reportPath: push.report_path,
    },
    authRequired,
    notes: push.notes,
    perf: {
      retrievalMs: push.retrieval_ms,
      rankingMs: push.agent_ranking_ms,
      totalMs: push.total_ms,
      llmCallCount: push.llm_call_count,
    },
    runner: runnerStatus(db, push.started_at),
  }
}

// ---------------------------------------------------------------------------
// Workflow launchers — Run / Resume reuse the EXISTING CLI workflow runner
// (bin/dsh-literature-push.mjs → headless dsh profile → literature_* tools).
// The HTTP layer starts the process and watches its early startup: runner
// stderr/stdout is captured to <dataDir>/runs/runner-*.log, and an immediate
// non-zero exit (e.g. ENOSPC on boot) is reported back instead of the UI
// seeing only "started". No workflow is re-implemented.
// ---------------------------------------------------------------------------

/** Absolute path of the shipped CLI workflow runner. */
function pushCliPath(): string {
  return fileURLToPath(new URL('../../bin/dsh-literature-push.mjs', import.meta.url))
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Resolve the profile to use for the one-shot workflow runner.
 *
 * The Web host's `web` profile is not itself a task runner: passing it to the
 * one-shot CLI makes the CLI reject the workflow prompt/arguments. An
 * explicitly configured DSH_LITERATURE_PROFILE remains available for users
 * who installed a dedicated workflow profile; otherwise the runner's own
 * compatibility fallback selects headless.
 */
export function currentHarnessProfile(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const args = argv.slice(2)
  const envProfile = env.DSH_LITERATURE_PROFILE?.trim()
  const configuredProfile = envProfile !== undefined && envProfile !== 'web' && PROFILE_NAME.test(envProfile) ? envProfile : undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    const value = arg === '--profile'
      ? args[i + 1]
      : arg.startsWith('--profile=')
        ? arg.slice('--profile='.length)
        : undefined
    if (value !== undefined && PROFILE_NAME.test(value.trim())) {
      return value.trim() === 'web' ? configuredProfile : value.trim()
    }
  }
  return configuredProfile
}

/** CLI argv for a fresh push (custom keyword enters as --topic). Pure — testable. */
export function pushCliArgs(keyword: string): string[] {
  const trimmed = keyword.trim()
  return trimmed.length > 0 ? ['--topic', trimmed] : []
}

/** CLI argv for resuming a parked push. Pure — testable. */
export function resumeCliArgs(pushId: number): string[] {
  return ['--resume', String(pushId)]
}

/** True when SQLite already has a workflow that must finish or be resumed. */
export function workflowAlreadyRunning(db: Db): boolean {
  const latest = db.prepare('SELECT status FROM pushes ORDER BY id DESC LIMIT 1').get() as { status: string } | undefined
  if (latest !== undefined && ['running', 'auth_required', 'user_action_required'].includes(latest.status)) return true
  // A live runner job (fresh heartbeat) also counts as running, even before
  // the CLI has persisted any push row.
  const job = db.prepare(
    `SELECT status, heartbeat_at FROM runner_jobs ORDER BY run_id DESC LIMIT 1`,
  ).get() as { status: string; heartbeat_at: string } | undefined
  if (job !== undefined && job.status === 'running') {
    const last = Date.parse(`${job.heartbeat_at.replace(' ', 'T')}Z`)
    if (!Number.isNaN(last) && Date.now() - last < STALE_RUNNING_MS) return true
  }
  return false
}

/** Resume only the parked push that still has persisted user work to resolve. */
export function canResumePush(db: Db, pushId: number): boolean {
  const row = db.prepare(
    `SELECT p.status,
            EXISTS(SELECT 1 FROM user_actions ua WHERE ua.push_id = p.id AND ua.state = 'open') AS has_open_action,
            p.id = (SELECT MAX(id) FROM pushes) AS is_latest
     FROM pushes p WHERE p.id = ?`,
  ).get(pushId) as { status: string; has_open_action: number; is_latest: number } | undefined
  return row !== undefined
    && ['auth_required', 'user_action_required'].includes(row.status)
    && row.has_open_action === 1
    && row.is_latest === 1
}

/** How long /run waits for an immediate runner crash before declaring it started. */
export const RUNNER_GRACE_MS = 5000

/** A 'running' push older than this with no persisted activity is stale. */
export const STALE_RUNNING_MS = 10 * 60 * 1000

/** Max chars of the runner log tail embedded in the failure message. */
const FAILURE_TAIL_CHARS = 800

/** Max chars served by the /runner-log endpoint. */
const LOG_SERVE_CHARS = 8000

/** Human-readable runner failure line (pure — testable). */
export function formatRunnerFailure(code: number | null, signal: string | null, tail: string): string {
  const where = code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`
  const detail = redactSensitiveText(tail).trim().split('\n').slice(-8).join(' | ').trim().slice(0, FAILURE_TAIL_CHARS)
  return `runner exited early (${where})${detail !== '' ? `: ${detail}` : ''}`
}

/** Env keys the harness treats as internal/sensitive and scrubs from children. */
const SENSITIVE_ENV_PATTERN = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i

/** Explicit allowlist: legitimate runner config that may look "sensitive". */
const RUNNER_ENV_ALLOWLIST = new Set(['OPENALEX_API_KEY', 'DSH_LITERATURE_PROFILE'])

/**
 * Child env for the workflow runner: the parent env minus harness-internal
 * DSH_* entries and credential-shaped keys (mirrors the harness subprocess
 * scrub — raw process.env can carry runtime-injected state that makes
 * execve fail), plus an explicit allowlist for documented runner config.
 * Pure — testable.
 */
export function runnerChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (RUNNER_ENV_ALLOWLIST.has(key)) { env[key] = value; continue }
    if (upper.startsWith('DSH_')) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    env[key] = value
  }
  return env
}

/** Runner argv → <dataDir>/runs log path (null when logging disabled). */
function runnerLogPath(logDir: string | null | undefined): string | null {
  if (logDir === undefined || logDir === null || logDir === '') return null
  mkdirSync(logDir, { recursive: true })
  return join(logDir, `runner-${Date.now()}.log`)
}

/** Mutable double-launch guard (kept inside runCli via opts.flag). */
export interface RunnerActiveFlag {
  active: boolean
}

export interface RunCliOptions {
  /** directory for runner-*.log capture; null/undefined disables logging */
  logDir?: string | null
  /** early-exit detection window (default RUNNER_GRACE_MS) */
  graceMs?: number
  /** double-launch guard shared by the workflow launchers */
  flag?: RunnerActiveFlag
  /** explicit working directory for the child (default: process.cwd()) */
  cwd?: string
}

/**
 * Spawn a CLI runner, capture stdout/stderr to a log file, and detect an
 * immediate crash (non-zero exit within the grace window) so the caller can
 * surface the real error instead of a silent "started".
 *
 * The child env is scrubbed like the harness subprocess layer does (DSH_* /
 * credential-shaped keys dropped, OPENALEX_API_KEY allowlisted) and an
 * explicit cwd is set: raw process.env in the web host can carry
 * runtime-injected state that makes execve fail. Spawn failures now carry the
 * actual error (code / syscall / path) instead of a bare "-1".
 * @param bin - executable to run.
 * @param args - CLI arguments.
 * @param opts - logging, grace window, double-launch guard, cwd.
 * @returns the run result (ok=false carries the failure detail in message).
 */
export async function runCli(bin: string, args: string[], opts: RunCliOptions = {}): Promise<UiRunResult> {
  if (opts.flag !== undefined && opts.flag.active) {
    return { ...failureFor('WORKFLOW_ALREADY_RUNNING') }
  }
  const graceMs = opts.graceMs ?? RUNNER_GRACE_MS
  const logPath = runnerLogPath(opts.logDir)
  const stdio: StdioOptions = logPath !== null ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore']

  const child = spawn(bin, args, {
    detached: true,
    stdio,
    env: runnerChildEnv(),
    cwd: opts.cwd ?? process.cwd(),
  })

  if (opts.flag !== undefined) opts.flag.active = true
  const pid = child.pid ?? null

  let log: WriteStream | undefined
  if (logPath !== null) {
    log = createWriteStream(logPath)
    child.stdout?.pipe(log)
    child.stderr?.pipe(log)
  }
  const closeLog = (): void => {
    if (log === undefined) return
    try { log.end() } catch { /* already closed */ }
  }
  const release = (): void => { if (opts.flag !== undefined) opts.flag.active = false }
  child.once('exit', () => { closeLog(); release() })
  child.once('error', () => { closeLog(); release() })
  child.unref()

  // Bounded early-exit detection: resolves with the exit code when the runner
  // dies inside the grace window, null when it is still alive after it.
  const earlyExit = await new Promise<{ code: number | null; signal: string | null; spawnError?: string } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), graceMs)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    child.once('error', (error) => {
      clearTimeout(timer)
      const detail = error instanceof Error
        ? `${error.message}${'code' in error ? ` (${String((error as NodeJS.ErrnoException).code)})` : ''}`
        : String(error)
      resolve({ code: -1, signal: null, spawnError: detail })
    })
  })
  if (earlyExit === null) {
    return { ok: true, pid, logPath, message: `started ${bin} ${args.join(' ')}` }
  }
  closeLog()
  if (earlyExit.code !== 0) {
    if (earlyExit.spawnError !== undefined) {
      const detail = redactSensitiveText(`runner spawn failed: ${earlyExit.spawnError}`)
      const failure = classifyWorkflowError(detail)
      return { ...failure, pid, logPath, message: `${failure.message} ${detail}` }
    }
    const tail = logPath !== null && existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const failure = classifyWorkflowError(tail)
    return {
      ...failure,
      pid,
      logPath,
      message: `${failure.message} ${formatRunnerFailure(earlyExit.code, earlyExit.signal, tail)}`,
    }
  }
  return { ok: true, pid, logPath, message: `finished ${bin} ${args.join(' ')} (exit 0)` }
}

/** Module-level double-launch guard for the workflow CLI launchers. */
const workflowFlag: RunnerActiveFlag = { active: false }

/** <dataDir>/runs for the workflow runner (fallback: no logging). */
function workflowLogDir(rt: LiteratureRuntime | undefined): string | null {
  return rt !== undefined ? join(rt.dataDir, 'runs') : null
}

/**
 * Spawn the existing workflow CLI through the RunnerService: it persists a
 * runner_jobs row (runId/kind/pushId/pid/status/heartbeat/logPath) so the
 * Execution panel reads the live job instead of inferring the phase from
 * retrieval rows, and it keeps the double-launch guard.
 */
async function spawnCli(args: string[], rt?: LiteratureRuntime, kind: 'push' | 'resume' = 'push', pushId?: number | null): Promise<UiRunResult> {
  const service = runnerServiceFor(rt)
  // Launch through node explicitly: the .mjs ships without the execute bit
  // (mode 600), so exec'ing it directly fails with EACCES.
  // Node must receive the shipped runner script before its CLI flags; passing
  // --topic/--resume directly to `node` makes Node reject them as bad options.
  const profile = currentHarnessProfile()
  const profileArgs = profile === undefined ? [] : ['--profile', profile]
  const out = await service.start(kind, [pushCliPath(), ...profileArgs, ...args], { bin: process.execPath, pushId: pushId ?? null })
  // Keep the legacy guard in sync for any caller that still reads it.
  if (out.ok) workflowFlag.active = true
  return {
    ok: out.ok,
    errorCode: out.errorCode,
    retryable: out.retryable,
    provider: out.provider,
    model: out.model,
    pid: out.pid,
    logPath: out.logPath,
    message: out.message,
  }
}

/** One RunnerService per runtime (cheap; rows are the durable source). */
function runnerServiceFor(rt: LiteratureRuntime | undefined): RunnerService {
  return new RunnerService(rt?.db as unknown as Db, { dataDir: rt?.dataDir ?? null })
}

/** Run the existing workflow with an optional keyword (enters as --topic). */
export function startPush(keyword: string, rt?: LiteratureRuntime): Promise<UiRunResult> {
  if (rt !== undefined && keyword.trim() === '' && rt.db.prepare('SELECT 1 FROM pushes LIMIT 1').get() === undefined) {
    return Promise.resolve({ ...failureFor('INVALID_ARGUMENT') })
  }
  return spawnCli(pushCliArgs(keyword), rt, 'push', null)
}

/** Resume a parked push (AUTH_REQUIRED / NEED_USER_ACTION / interrupted). */
export function startResume(pushId: number, rt?: LiteratureRuntime): Promise<UiRunResult> {
  return spawnCli(resumeCliArgs(pushId), rt, 'resume', pushId)
}

interface CurrentProfileSelection {
  provider: string
  model: string
}

interface CurrentProfileAgent {
  followup(message: {
    id: string
    role: 'user'
    content: Array<{ type: 'text'; text: string }>
    source: { kind: 'user' }
  }): void
  whenIdle(): Promise<void>
  session: { events: readonly unknown[] }
}

interface CurrentProfileWorkflowDeps {
  agentDefaultModel?: { currentSelection?: () => CurrentProfileSelection }
  agents?: {
    create: (options: {
      sessionId: string
      meta: { cwd: string }
      agentOptions: CurrentProfileSelection
    }) => Promise<{ agent: CurrentProfileAgent; dispose: () => Promise<void> }>
  }
}

function agentFailure(events: readonly unknown[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== 'turn/end') continue
    const reason = (event as { data?: { reason?: unknown } }).data?.reason
    if (typeof reason !== 'object' || reason === null || (reason as { kind?: unknown }).kind !== 'error') return null
    const error = (reason as { error?: { code?: unknown; message?: unknown } }).error
    const code = typeof error?.code === 'string' ? error.code : 'NETWORK'
    const message = typeof error?.message === 'string' ? error.message : 'Harness Agent execution failed'
    return `${code}: ${message}`
  }
  return null
}

/**
 * Web-only workflow launcher. It creates a temporary Agent in the live
 * Harness profile, so its selected provider/model and credentials are exactly
 * the ones visible in the Harness model dialog.
 */
export function createCurrentProfileWorkflowRunner(deps: CurrentProfileWorkflowDeps): {
  startPush: (keyword: string, rt?: LiteratureRuntime) => Promise<UiRunResult>
  startResume: (pushId: number, rt?: LiteratureRuntime) => Promise<UiRunResult>
} {
  const start = async (kind: 'push' | 'resume', prompt: string, rt?: LiteratureRuntime): Promise<UiRunResult> => {
    const selection = deps.agentDefaultModel?.currentSelection?.()
    const agents = deps.agents
    if (selection === undefined || selection.provider.trim() === '' || selection.model.trim() === '' || agents === undefined) {
      return { ...failureFor('NO_ADAPTER') }
    }
    const service = runnerServiceFor(rt)
    return service.startInProcess(kind, selection, async () => {
      const handle = await agents.create({
        sessionId: `literature-${randomUUID()}`,
        meta: { cwd: process.cwd() },
        agentOptions: selection,
      })
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
      return {
        done: (async () => {
          try {
            await handle.agent.whenIdle()
            const failure = agentFailure(handle.agent.session.events)
            if (failure !== null) throw new Error(failure)
          } finally {
            await handle.dispose()
          }
        })(),
      }
    })
  }

  return {
    startPush: (keyword, rt) => {
      if (rt !== undefined && keyword.trim() === '' && rt.db.prepare('SELECT 1 FROM pushes LIMIT 1').get() === undefined) {
        return Promise.resolve({ ...failureFor('INVALID_ARGUMENT') })
      }
      return start('push', buildTaskPrompt(keyword), rt)
    },
    startResume: (pushId, rt) => start('resume', buildResumePrompt(pushId), rt),
  }
}

/**
 * Tail of the newest runner log (for the UI's log viewer), or null when no
 * run has been captured yet.
 */
export function latestRunnerLog(rt: LiteratureRuntime | undefined): { path: string; content: string } | null {
  return runnerServiceFor(rt).latestLog(LOG_SERVE_CHARS)
}
