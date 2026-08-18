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
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Db } from '../db.js'
import type { LiteratureConfig } from '../config.js'
import { expandHome } from '../lib/paths.js'
import { listPaperFields, listResearchFields } from '../lib/research_fields.js'
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

/** Workflow categories backed by real data (favorites has no column yet). */
const WORKFLOW_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All Papers' },
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
  (SELECT topic FROM candidates c JOIN pushes pu ON pu.id = c.push_id WHERE c.paper_id = p.id ORDER BY pu.id DESC LIMIT 1) AS topic
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

function toSummary(row: PaperRow, pdfPath: string | null = usableFile(row.pdf_path), reportPath: string | null = usableFile(row.report_path)): UiPaperSummary {
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
    readCount: row.read_count ?? 0,
    fulltextChunks: row.fulltext_chunks ?? null,
    readCoverage: row.fulltext_chunks && row.fulltext_chunks > 0 ? Math.min(1, (row.read_count ?? 0) / row.fulltext_chunks) : null,
    readingStatus: row.reading_status ?? null,
    reportCount: reportPath === null ? 0 : 1,
    topic: row.topic,
    createdAt: row.created_at,
  }
}

export interface PapersFilter {
  /** category id from listCategories(): workflow id | 'field:<id>' | 'topic:<name>' */
  category?: string
}

/** List paper summaries with an optional category filter. */
export function listPapers(db: Db, filter: PapersFilter = {}): UiPaperSummary[] {
  const where: string[] = []
  const params: string[] = []
  const category = filter.category ?? 'all'

  if (category === 'all' || category === '') {
    // no filter
  } else if (category === 'selected') {
    where.push("EXISTS (SELECT 1 FROM candidates c WHERE c.paper_id = p.id AND c.selection_outcome = 'SELECTED')")
  } else if (category === 'to-read') {
    where.push("EXISTS (SELECT 1 FROM fetch_log f WHERE f.paper_id = p.id AND f.outcome IN ('ok','PDF_OK') AND f.pdf_path IS NOT NULL)")
  } else if (category === 'read') {
    where.push("(EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id=p.id AND ft.status='ok' AND (SELECT COUNT(DISTINCT r.seq) FROM fulltext_reads r WHERE r.paper_id=p.id) >= ft.chunk_count) OR (NOT EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id=p.id) AND EXISTS (SELECT 1 FROM fulltext_reads r WHERE r.paper_id=p.id)))")
  } else if (category === 'reports') {
    where.push("EXISTS (SELECT 1 FROM reports r WHERE r.paper_id=p.id) OR EXISTS (SELECT 1 FROM pushes pu WHERE pu.paper_id = p.id AND pu.report_path IS NOT NULL AND pu.report_path <> '')")
  } else if (category === 'favorites') {
    // No favorites column in the schema yet (Phase 4); the UI shows an empty
    // list instead of fabricating data.
    where.push('1 = 0')
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
      where.push("EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = p.id AND pc.category_id = ? AND pc.state = 'active')")
      params.push(String(categoryId))
    } else {
      where.push('1 = 0')
    }
  }

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
    LIMIT 500`
  const rows = db.prepare(sql).all(...params) as unknown as PaperRow[]
  const assets = usableAssetsForPapers(db, rows.map((row) => row.id))
  const papers = rows.map((row) => {
    const fetch = assets.pdf.get(row.id)
    const report = assets.report.get(row.id)
    return { paper: toSummary(row, fetch?.path ?? null, report?.path ?? null), reportPushId: report?.id ?? 0 }
  })
  if (category === 'reports') {
    return papers
      .filter(({ paper }) => paper.reportCount > 0)
      .sort((a, b) => b.reportPushId - a.reportPushId)
      .map(({ paper }) => paper)
  }
  return (category === 'to-read'
    ? papers.filter(({ paper }) => paper.hasPdf && (paper.readCoverage === null || paper.readCoverage === undefined || paper.readCoverage < 1))
    : papers).map(({ paper }) => paper)
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
  const base = toSummary(row, fetchAssets.usable?.path ?? null, report?.path ?? null)

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
    metadataStatus: row.title && row.authors && row.year && row.venue ? 'complete' : 'partial',
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
      : w.id === 'selected'
        ? scalarCount("SELECT COUNT(DISTINCT paper_id) AS n FROM candidates WHERE selection_outcome = 'SELECTED'")
        : w.id === 'to-read'
          ? listPapers(db).filter((paper) => paper.hasPdf && (paper.readCoverage === null || paper.readCoverage === undefined || paper.readCoverage < 1)).length
        : w.id === 'read'
          ? scalarCount("SELECT COUNT(DISTINCT r.paper_id) AS n FROM fulltext_reads r WHERE NOT EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id=r.paper_id) OR EXISTS (SELECT 1 FROM fulltexts ft WHERE ft.paper_id=r.paper_id AND ft.status='ok' AND (SELECT COUNT(DISTINCT r2.seq) FROM fulltext_reads r2 WHERE r2.paper_id=ft.paper_id) >= ft.chunk_count)")
          : w.id === 'reports'
            ? reportCount
            : 0
    categories.push({ id: w.id, label: w.label, kind: 'workflow', count: n })
  }
  for (const field of listResearchFields(db)) {
    categories.push({
      id: `field:${field.id}`, label: field.nameEn, labelEn: field.nameEn, labelZh: field.nameZh,
      categoryId: field.id, createdBy: field.createdBy, kind: 'field', count: field.count,
    })
  }
  // Real topics present in the pushes table.
  const rows = db.prepare(
    `SELECT pu.topic, COUNT(DISTINCT c.paper_id) AS n
     FROM pushes pu JOIN candidates c ON c.push_id = pu.id
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
  const pushes = db.prepare('SELECT COUNT(*) AS n FROM pushes').get() as { n: number }
  const latest = db.prepare(
    `SELECT id, status, topic FROM pushes ORDER BY id DESC LIMIT 1`,
  ).get() as { id: number; status: string; topic: string } | undefined
  return {
    paperCount: papers.n,
    pushCount: pushes.n,
    reportCount: countUsableReports(db),
    categories: listCategories(db),
    latestPush: latest ?? null,
    stages: listStages(db),
  }
}

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
      retrieving: [],
      retrievedPapers: null,
      candidatesRanked: null,
      acquisition: [],
      reading: { totalChunks: null, readChunks: null, coverage: null },
      reporting: { reportGenerationMs: null, reportPath: null },
      authRequired: null,
      notes: null,
      perf: { retrievalMs: null, rankingMs: null, totalMs: null, llmCallCount: null },
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
  }
}

// ---------------------------------------------------------------------------
// Workflow launchers — Run / Resume reuse the EXISTING CLI workflow runner
// (bin/dsh-literature-push.mjs → headless dsh profile → literature_* tools).
// The HTTP layer just starts the process; the Execution panel follows the
// same SQLite state the running workflow writes. No workflow is re-implemented.
// ---------------------------------------------------------------------------

/** Absolute path of the shipped CLI workflow runner. */
function pushCliPath(): string {
  return fileURLToPath(new URL('../../bin/dsh-literature-push.mjs', import.meta.url))
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
  return latest !== undefined && ['running', 'auth_required', 'user_action_required'].includes(latest.status)
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

let workflowProcessActive = false

function spawnCli(args: string[]): UiRunResult {
  if (workflowProcessActive) {
    return { ok: false, errorCode: 'WORKFLOW_ALREADY_RUNNING', message: 'WORKFLOW_ALREADY_RUNNING' }
  }
  try {
    workflowProcessActive = true
    const child = spawn(process.execPath, [pushCliPath(), ...args], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    const release = (): void => { workflowProcessActive = false }
    child.once('error', release)
    child.once('exit', release)
    child.unref()
    return { ok: true, pid: child.pid ?? null, message: `started dsh-literature-push ${args.join(' ')}` }
  } catch (error) {
    workflowProcessActive = false
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Run the existing workflow with an optional keyword (enters as --topic). */
export function startPush(keyword: string): UiRunResult {
  return spawnCli(pushCliArgs(keyword))
}

/** Resume a parked push (AUTH_REQUIRED / NEED_USER_ACTION / interrupted). */
export function startResume(pushId: number): UiRunResult {
  return spawnCli(resumeCliArgs(pushId))
}
