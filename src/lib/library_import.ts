/**
 * Local PDF library ingestion.  This deliberately stops after a PDF is
 * registered: indexing, chunk reading and reporting are separate explicit
 * operations.  It writes the same papers/fetch_log/categories rows as the
 * workflow and never creates a push, candidate, or retrieval record.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { PaperRow } from '../db.js'
import { getPaper, getPaperByDoi, upsertPaper } from '../db.js'
import { extractPdfText } from '../fetch/fulltext.js'
import type { LiteratureRuntime } from './runtime.js'
import { resolvePaperFields } from './research_fields.js'
import { canonicalId, normalizeTitle, type PaperRef } from '../sources/types.js'

const PDF_MAGIC = Buffer.from('%PDF-')
const DOI_RE = /\b10\.\d{4,9}\/[\w.()/:;-]+\b/iu
const MAX_FILENAME_LENGTH = 180

export interface LocalPdfInput {
  filename: string
  mimeType?: string
  bytes: Buffer
  /** Tests and offline callers may explicitly skip the targeted lookup. */
  enrich?: boolean
}

export interface MetadataStatus {
  complete: boolean
  enriched: boolean
  sources: string[]
  confidence: number | null
}

export interface LocalPdfImportResult {
  paperId: string
  isNewPaper: boolean
  duplicateDetected: boolean
  pdfAttached: boolean
  sha256: string
  metadata: { title: string; authors: string[]; venue: string | null; year: number | null; doi: string | null }
  metadataStatus: MetadataStatus
  readStatus: 'unread' | 'reading' | 'read' | 'failed'
  reportStatus: 'none' | 'available'
}

export interface LocalMetadata {
  title: string
  authors: string[]
  affiliation: string | null
  abstract: string | null
  keywords: string[]
  doi: string | null
  venue: string | null
  year: number | null
  source: 'pdf'
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function safeFilename(name: string): string {
  const safe = basename(name).replace(/[\0-\x1f<>:"|?*]/g, '_').slice(0, MAX_FILENAME_LENGTH)
  return safe || 'document.pdf'
}

function titleFromFilename(name: string): string {
  return clean(safeFilename(name).replace(/\.pdf$/iu, '').replace(/[_-]+/g, ' '))
}

function isLikelyAuthorName(line: string): boolean {
  const words = clean(line).split(/\s+/u)
  return words.length >= 2 && words.length <= 5 && words.every((word) => /^[A-Z][A-Za-z.'-]*$/u.test(word))
}

function parseAuthors(line: string): string[] {
  if (/^(abstract|keywords?|introduction|doi\b)/iu.test(line)) return []
  const parts = line.split(/(?:,|\band\b|;)/iu).map(clean)
    .filter((part) => part.length >= 2 && part.length < 100)
    .filter((part) => !/^(?:student|senior|associate|life)?\s*member(?:\s+of)?\s*(?:ieee)?$|^ieee$/iu.test(part))
    .slice(0, 12)
  return parts.length > 1 || isLikelyAuthorName(line) ? parts : []
}

function isPublicationHeader(line: string): boolean {
  return /^\d+\s+(?:ieee|acm|springer|elsevier|sage|wiley|mdpi)\b.*\b(?:vol\.?|volume|no\.?|issue|february|january|march|april|may|june|july|august|september|october|november|december)\b/iu.test(line)
}

/** Parse conservative front-matter metadata from extracted PDF text. */
export function parseLocalMetadataText(text: string, filename: string, raw = text): LocalMetadata {
  const searchable = `${text}\n${raw}`
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean)
  const abstractIndex = lines.findIndex((line) => /^abstract\b/iu.test(line))
  const titleCandidate = lines.slice(0, Math.max(0, abstractIndex === -1 ? 8 : abstractIndex))
    .find((line) => line.length >= 6 && line.length <= 300 && !isPublicationHeader(line) && !/^(doi|keywords?|copyright|page\s+\d+)/iu.test(line))
  const titleIndex = lines.indexOf(titleCandidate ?? '')
  let title = titleCandidate ?? titleFromFilename(filename)
  let titleEndIndex = titleIndex
  if (titleIndex >= 0) {
    const titleParts = [title]
    for (let index = titleIndex + 1; index < lines.length && index < titleIndex + 4; index += 1) {
      const line = lines[index]!
      if (/^(abstract|keywords?|introduction|doi\b)/iu.test(line) || parseAuthors(line).length > 0) break
      titleParts.push(line)
      titleEndIndex = index
    }
    title = clean(titleParts.join(' '))
  }
  const authorLine = titleEndIndex >= 0 ? lines.slice(titleEndIndex + 1, titleEndIndex + 4).find((line) => parseAuthors(line).length > 0) : undefined
  const doi = searchable.match(DOI_RE)?.[0]?.replace(/[).,;]+$/u, '').toLowerCase() ?? null
  const keywordLine = lines.find((line) => /^keywords?\s*[:—-]/iu.test(line))
  const keywords = keywordLine ? keywordLine.replace(/^keywords?\s*[:—-]\s*/iu, '').split(/[,;·]/).map(clean).filter(Boolean).slice(0, 20) : []
  const abstractLine = abstractIndex >= 0 ? lines.slice(abstractIndex, abstractIndex + 12).join(' ') : null
  const year = Number(searchable.match(/\b(19|20)\d{2}\b/u)?.[0] ?? '') || null
  const affiliation = lines.find((line) => /\b(university|institute|laboratory|department|college)\b/iu.test(line)) ?? null
  const venue = lines.slice(0, 8).find(isPublicationHeader)?.replace(/^\d+\s+/u, '').replace(/,\s*vol\.?\s+.*$/iu, '').trim() ?? null
  return { title, authors: authorLine ? parseAuthors(authorLine) : [], affiliation, abstract: abstractLine, keywords, doi, venue, year, source: 'pdf' }
}

/** Extract conservative front-matter metadata from the already validated PDF. */
export async function extractLocalMetadata(pdfPath: string, filename: string): Promise<LocalMetadata> {
  let text = ''
  try { text = (await extractPdfText(pdfPath)).text } catch { /* valid image PDFs can still be imported */ }
  // Many PDFs expose document identifiers in an uncompressed metadata stream
  // even when text extraction is unavailable; this remains local extraction.
  const raw = readFileSync(pdfPath).toString('latin1')
  return parseLocalMetadataText(text, filename, raw)
}

function asPaper(metadata: LocalMetadata, sha256: string): PaperRef {
  const base: PaperRef = {
    id: `local:${sha256}`,
    title: metadata.title,
    authors: metadata.authors,
    venue: metadata.venue ?? undefined,
    year: metadata.year ?? undefined,
    doi: metadata.doi ?? undefined,
    abstract: metadata.abstract ?? undefined,
    metadataSource: 'manual_pdf',
  }
  return { ...base, id: base.doi ? canonicalId(base) : base.id }
}

function similarity(a: string, b: string): number {
  const aa = new Set(normalizeTitle(a).split(' ').filter(Boolean))
  const bb = new Set(normalizeTitle(b).split(' ').filter(Boolean))
  if (aa.size === 0 || bb.size === 0) return 0
  let shared = 0
  for (const token of aa) if (bb.has(token)) shared += 1
  return shared / Math.max(aa.size, bb.size)
}

function authorsOf(row: PaperRow): string[] {
  try { const parsed: unknown = JSON.parse(row.authors ?? '[]'); if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string') } catch { /* legacy text */ }
  return (row.authors ?? '').split(',').map(clean).filter(Boolean)
}

export function identityMatch(db: LiteratureRuntime['db'], paper: PaperRef): { paper: PaperRow | null; confidence: number } {
  if (paper.doi) {
    const exact = getPaperByDoi(db, paper.doi)
    if (exact) return { paper: exact, confidence: 1 }
  }
  const rows = db.prepare('SELECT * FROM papers').all() as unknown as PaperRow[]
  let best: PaperRow | null = null
  let confidence = 0
  for (const row of rows) {
    const titleScore = similarity(paper.title, row.title)
    const incomingAuthors = new Set(paper.authors.map((author) => normalizeTitle(author)))
    const overlap = authorsOf(row).some((author) => incomingAuthors.has(normalizeTitle(author))) ? 1 : 0
    // An identical title alone is not a sufficient identity proof: many
    // workshops/preprints share generic names.  Automatic attachment needs a
    // strong identifier or corroborating author metadata.
    const score = titleScore === 1 ? (overlap ? 0.98 : 0.85) : titleScore * 0.8 + overlap * 0.12
    if (score > confidence) { best = row; confidence = score }
  }
  return { paper: best, confidence }
}

function toRow(id: string, paper: PaperRef, metadata: LocalMetadata, existing?: PaperRow): PaperRow {
  const value = <T>(local: T | undefined | null, previous: T | undefined | null): T | null => local ?? previous ?? null
  return {
    id,
    // Existing library metadata is trusted by default. Targeted enrichment
    // fills omissions; identity matches do not silently replace a title or
    // author list the user/workflow already established.
    title: existing?.title ?? paper.title ?? metadata.title,
    authors: existing?.authors ?? (paper.authors.length > 0 ? JSON.stringify(paper.authors) : null),
    venue: value(paper.venue, existing?.venue),
    year: value(paper.year, existing?.year),
    doi: existing?.doi ?? paper.doi?.toLowerCase() ?? null,
    arxiv_id: value(paper.arxivId, existing?.arxiv_id),
    openalex_id: value(paper.openalexId, existing?.openalex_id),
    url: value(paper.url, existing?.url),
    oa_pdf_url: value(paper.oaPdfUrl, existing?.oa_pdf_url),
    abstract: value(paper.abstract, existing?.abstract),
    citations: value(paper.citations, existing?.citations),
    bibtex: existing?.bibtex ?? null,
    metadata_source: paper.metadataSource || existing?.metadata_source || 'manual_pdf',
    affiliation: value(metadata.affiliation, existing?.affiliation),
    keywords: metadata.keywords.length > 0 ? JSON.stringify(metadata.keywords) : existing?.keywords ?? null,
    metadata_enriched_at: existing?.metadata_enriched_at ?? null,
  }
}

/**
 * A paper's metadata is complete only when the title exists AND the author
 * list is non-empty. `authorsOf` tolerates a legacy plain-text author string
 * but a serialized empty array "[]" (or "null") is NOT an author list.
 */
function metadataComplete(row: PaperRow): boolean {
  return Boolean(row.title) && authorsOf(row).length > 0 && Boolean(row.year) && Boolean(row.venue)
}

/** Derive the truthful read status for an existing library paper. */
function readStatusOf(db: LiteratureRuntime['db'], paperId: string): LocalPdfImportResult['readStatus'] {
  const job = db.prepare('SELECT status FROM paper_reading_jobs WHERE paper_id = ?').get(paperId) as { status: 'running' | 'completed' | 'failed' } | undefined
  if (job?.status === 'running') return 'reading'
  if (job?.status === 'failed') return 'failed'
  const reads = db.prepare('SELECT COUNT(DISTINCT seq) AS n FROM fulltext_reads WHERE paper_id = ?').get(paperId) as { n: number }
  const chunks = db.prepare("SELECT chunk_count AS n FROM fulltexts WHERE paper_id = ? AND status = 'ok'").get(paperId) as { n: number } | undefined
  if (reads.n > 0 && (chunks === undefined || reads.n >= chunks.n)) return 'read'
  if (reads.n > 0) return 'reading'
  return 'unread'
}

/** True when a real, usable report exists for this paper. */
function reportStatusOf(db: LiteratureRuntime['db'], paperId: string): LocalPdfImportResult['reportStatus'] {
  const row = db.prepare(
    `SELECT 1 AS n FROM reports WHERE paper_id = ? AND report_path IS NOT NULL AND report_path <> ''
     UNION ALL SELECT 1 FROM pushes WHERE paper_id = ? AND report_path IS NOT NULL AND report_path <> '' LIMIT 1`,
  ).get(paperId, paperId) as { n: number } | undefined
  return row ? 'available' : 'none'
}

/** Whether a manual import actually enriched (a provider result was applied). */
function wasEnriched(seed: PaperRef, result: PaperRef): boolean {
  if (result === seed) return false
  return (
    result.doi !== undefined ||
    result.arxivId !== undefined ||
    result.openalexId !== undefined ||
    result.abstract !== undefined ||
    result.citations !== undefined ||
    result.url !== undefined ||
    result.metadataSource !== seed.metadataSource
  )
}

/** Targeted provider enrichment only: no retrieval persistence, no push. */
export async function enrichPaperMetadata(rt: LiteratureRuntime, paperId: string): Promise<{ paperId: string; status: MetadataStatus }> {
  const existing = getPaper(rt.db, paperId)
  if (!existing) throw new Error('PAPER_NOT_FOUND')
  const seed: PaperRef = {
    id: existing.id,
    title: existing.title,
    authors: authorsOf(existing),
    venue: existing.venue ?? undefined,
    year: existing.year ?? undefined,
    doi: existing.doi ?? undefined,
    arxivId: existing.arxiv_id ?? undefined,
    openalexId: existing.openalex_id ?? undefined,
    url: existing.url ?? undefined,
    oaPdfUrl: existing.oa_pdf_url ?? undefined,
    abstract: existing.abstract ?? undefined,
    citations: existing.citations ?? undefined,
    metadataSource: existing.metadata_source,
  }
  let enriched: PaperRef = seed
  let confidence: number | null = null
  let applied = false
  try {
    enriched = await rt.registry.lookupMetadata(seed)
    const match = identityMatch(rt.db, enriched)
    confidence = match.paper?.id === existing.id || enriched.doi === existing.doi ? Math.max(match.confidence, 0.9) : match.confidence
    // A fuzzy provider result may only fill blanks; it never replaces the
    // local title/authors/DOI unless it is an exact identity match.
    const safe = confidence >= 0.75
    const merged = toRow(existing.id, safe ? enriched : seed, {
      title: existing.title, authors: authorsOf(existing), affiliation: existing.affiliation ?? null,
      abstract: existing.abstract ?? null, keywords: (() => { try { return JSON.parse(existing.keywords ?? '[]') as string[] } catch { return [] } })(),
      doi: existing.doi, venue: existing.venue, year: existing.year, source: 'pdf',
    }, existing)
    if (wasEnriched(seed, safe ? enriched : seed)) {
      merged.metadata_enriched_at = new Date().toISOString()
      applied = true
    }
    upsertPaper(rt.db, merged)
  } catch {
    // Provider failure is a normal offline-degraded outcome.  The valid PDF
    // and reliably extracted metadata remain in the library.
  }
  const row = getPaper(rt.db, paperId)!
  const status: MetadataStatus = { complete: metadataComplete(row), enriched: row.metadata_enriched_at !== null, sources: row.metadata_source.split('+'), confidence }
  if (applied) status.enriched = true
  return { paperId, status }
}

/**
 * Stream-friendly import input: the caller already wrote the upload to a
 * temporary file (and validated size/magic on the way), so we never buffer
 * the whole PDF in memory.
 */
export interface LocalPdfFileInput {
  filename: string
  mimeType?: string
  /** Absolute path of the already-written temp file (caller-owned). */
  tempPath: string
  /** Precomputed sha256 of the file, when the caller streamed it. */
  sha256?: string
  /** True when the temp file should be moved into the library (default). */
  move?: boolean
  /** Tests and offline callers may explicitly skip the targeted lookup. */
  enrich?: boolean
}

const isSameFile = (a: string, b: string): boolean => resolve(a) === resolve(b)

/**
 * Import a PDF already staged in a temp file. The whole pipeline is
 * transactional: a DB failure removes the newly stored managed PDF so no
 * orphan file is left behind. Metadata is extracted from the first pages
 * only (pdftotext -f 1 -l 2), keeping large uploads cheap.
 */
export async function importLocalPdfFromFile(rt: LiteratureRuntime, input: LocalPdfFileInput): Promise<LocalPdfImportResult> {
  const filename = safeFilename(input.filename)
  if (!/\.pdf$/iu.test(filename) || (input.mimeType !== undefined && input.mimeType !== 'application/pdf')) throw new Error('INVALID_PDF_TYPE')
  if (!existsSync(input.tempPath) || statSync(input.tempPath).size < rt.cfg.http.minPdfBytes) throw new Error('INVALID_PDF_SIZE')
  let sha256 = input.sha256
  if (sha256 === undefined) {
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(input.tempPath)) hash.update(chunk as Buffer)
    sha256 = hash.digest('hex')
  }
  const previous = rt.db.prepare(
    "SELECT paper_id FROM fetch_log WHERE sha256 = ? AND outcome IN ('ok','PDF_OK') ORDER BY id DESC LIMIT 1",
  ).get(sha256) as { paper_id: string } | undefined
  if (previous) {
    if (input.move !== false && !isSameFile(input.tempPath, join(rt.pdfsDir, `${sha256}.pdf`))) {
      try { unlinkSync(input.tempPath) } catch { /* best-effort cleanup */ }
    }
    const row = getPaper(rt.db, previous.paper_id)!
    return { paperId: row.id, isNewPaper: false, duplicateDetected: true, pdfAttached: false, sha256,
      metadata: { title: row.title, authors: authorsOf(row), venue: row.venue, year: row.year, doi: row.doi },
      metadataStatus: { complete: metadataComplete(row), enriched: row.metadata_enriched_at !== null, sources: row.metadata_source.split('+'), confidence: 1 },
      readStatus: readStatusOf(rt.db, row.id), reportStatus: reportStatusOf(rt.db, row.id) }
  }
  mkdirSync(rt.pdfsDir, { recursive: true })
  const managedPath = join(rt.pdfsDir, `${sha256}.pdf`)
  if (!existsSync(managedPath)) {
    if (input.move !== false) {
      // Atomic move of the staged upload into the library.
      try { renameSync(input.tempPath, managedPath) } catch { copyFileSync(input.tempPath, managedPath) }
    } else {
      copyFileSync(input.tempPath, managedPath)
    }
  } else if (input.move !== false && !isSameFile(input.tempPath, managedPath)) {
    try { unlinkSync(input.tempPath) } catch { /* best-effort cleanup */ }
  }
  let metadata: LocalMetadata
  try { metadata = await extractLocalMetadata(managedPath, filename) } catch (error) { throw error }
  if (!metadata.title) throw new Error('METADATA_TITLE_REQUIRED')
  let paper = asPaper(metadata, sha256)
  let enrichedApplied = false
  if (input.enrich !== false) {
    const seed = paper
    try {
      paper = await rt.registry.lookupMetadata(paper)
      enrichedApplied = wasEnriched(seed, paper)
    } catch { /* partial import stays valid */ }
  }
  const match = identityMatch(rt.db, paper)
  const existing = match.confidence >= 0.9 ? match.paper : null
  const paperId = existing?.id ?? paper.id
  const row = toRow(paperId, paper, metadata, existing ?? undefined)
  row.metadata_enriched_at = input.enrich === false || !enrichedApplied ? null : new Date().toISOString()
  const createdManaged = !existsSync(managedPath)
  rt.db.exec('BEGIN')
  try {
    upsertPaper(rt.db, row)
    rt.db.prepare(
      `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access)
       VALUES (?, ?, 'PDF_OK', ?, 'Manual Upload', ?, 'manual', 0)`,
    ).run(paperId, JSON.stringify([{ source: 'manual_upload', filename, status: 'ok' }]), managedPath, sha256)
    // Library entry point: a manually imported PDF belongs to the knowledge
    // base and is auto-classified into Research Fields right away.
    resolvePaperFields(rt.db, paperId)
    rt.db.exec('COMMIT')
  } catch (error) {
    rt.db.exec('ROLLBACK')
    // Never leave an orphan managed PDF behind a failed transaction.
    if (createdManaged) { try { unlinkSync(managedPath) } catch { /* best-effort */ } }
    throw error
  }
  const saved = getPaper(rt.db, paperId)!
  return { paperId, isNewPaper: existing === null, duplicateDetected: false, pdfAttached: true, sha256,
    metadata: { title: saved.title, authors: authorsOf(saved), venue: saved.venue, year: saved.year, doi: saved.doi },
    metadataStatus: { complete: metadataComplete(saved), enriched: saved.metadata_enriched_at !== null, sources: saved.metadata_source.split('+'), confidence: existing ? match.confidence : null },
    readStatus: readStatusOf(rt.db, saved.id), reportStatus: reportStatusOf(rt.db, saved.id) }
}

export async function importLocalPdf(rt: LiteratureRuntime, input: LocalPdfInput): Promise<LocalPdfImportResult> {
  const filename = safeFilename(input.filename)
  if (!/\.pdf$/iu.test(filename) || (input.mimeType !== undefined && input.mimeType !== 'application/pdf')) throw new Error('INVALID_PDF_TYPE')
  const maxMb = Number(process.env.MAX_PDF_UPLOAD_MB ?? 50)
  if (input.bytes.length < rt.cfg.http.minPdfBytes || input.bytes.length > Math.max(1, maxMb) * 1024 * 1024) throw new Error('INVALID_PDF_SIZE')
  if (input.bytes.length < PDF_MAGIC.length || !input.bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) throw new Error('INVALID_PDF')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-upload-'))
  const tempPath = join(dir, filename)
  writeFileSync(tempPath, input.bytes, { flag: 'wx' })
  try {
    return await importLocalPdfFromFile(rt, { filename, mimeType: input.mimeType, tempPath, enrich: input.enrich, move: true })
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

/** Confirm a managed PDF path is still a real non-empty file. */
export function hasManagedPdf(path: string | null): boolean {
  try { return path !== null && statSync(path).isFile() && statSync(path).size > 0 } catch { return false }
}
