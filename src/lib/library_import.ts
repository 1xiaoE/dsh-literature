/**
 * Local PDF library ingestion.  This deliberately stops after a PDF is
 * registered: indexing, chunk reading and reporting are separate explicit
 * operations.  It writes the same papers/fetch_log/categories rows as the
 * workflow and never creates a push, candidate, or retrieval record.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PaperRow } from '../db.js'
import { getPaper, getPaperByDoi, upsertPaper } from '../db.js'
import { extractPdfText } from '../fetch/fulltext.js'
import type { LiteratureRuntime } from './runtime.js'
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
  readStatus: 'unread'
  reportStatus: 'none'
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

function parseAuthors(line: string): string[] {
  if (/^(abstract|keywords?|introduction|doi\b)/iu.test(line)) return []
  return line.split(/(?:,|\band\b|;)/iu).map(clean).filter((part) => part.length >= 2 && part.length < 100).slice(0, 12)
}

/** Extract conservative front-matter metadata from the already validated PDF. */
export async function extractLocalMetadata(pdfPath: string, filename: string): Promise<LocalMetadata> {
  let text = ''
  try { text = (await extractPdfText(pdfPath)).text } catch { /* valid image PDFs can still be imported */ }
  // Many PDFs expose document identifiers in an uncompressed metadata stream
  // even when text extraction is unavailable; this remains local extraction.
  const raw = readFileSync(pdfPath).toString('latin1')
  const searchable = `${text}\n${raw}`
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean)
  const abstractIndex = lines.findIndex((line) => /^abstract\b/iu.test(line))
  const titleCandidate = lines.slice(0, Math.max(0, abstractIndex === -1 ? 8 : abstractIndex))
    .find((line) => line.length >= 6 && line.length <= 300 && !/^(doi|keywords?|copyright|page\s+\d+)/iu.test(line))
  const title = titleCandidate ?? titleFromFilename(filename)
  const titleIndex = lines.indexOf(titleCandidate ?? '')
  const authorLine = titleIndex >= 0 ? lines.slice(titleIndex + 1, titleIndex + 4).find((line) => parseAuthors(line).length > 0) : undefined
  const doi = searchable.match(DOI_RE)?.[0]?.replace(/[).,;]+$/u, '').toLowerCase() ?? null
  const keywordLine = lines.find((line) => /^keywords?\s*[:—-]/iu.test(line))
  const keywords = keywordLine ? keywordLine.replace(/^keywords?\s*[:—-]\s*/iu, '').split(/[,;·]/).map(clean).filter(Boolean).slice(0, 20) : []
  const abstractLine = abstractIndex >= 0 ? lines.slice(abstractIndex, abstractIndex + 12).join(' ') : null
  const year = Number(searchable.match(/\b(19|20)\d{2}\b/u)?.[0] ?? '') || null
  const affiliation = lines.find((line) => /\b(university|institute|laboratory|department|college)\b/iu.test(line)) ?? null
  return { title, authors: authorLine ? parseAuthors(authorLine) : [], affiliation, abstract: abstractLine, keywords, doi, venue: null, year, source: 'pdf' }
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

function metadataComplete(row: PaperRow): boolean {
  return Boolean(row.title && row.authors && row.year && row.venue)
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
    merged.metadata_enriched_at = new Date().toISOString()
    upsertPaper(rt.db, merged)
  } catch {
    // Provider failure is a normal offline-degraded outcome.  The valid PDF
    // and reliably extracted metadata remain in the library.
  }
  const row = getPaper(rt.db, paperId)!
  return { paperId, status: { complete: metadataComplete(row), enriched: row.metadata_enriched_at !== null, sources: row.metadata_source.split('+'), confidence } }
}

export async function importLocalPdf(rt: LiteratureRuntime, input: LocalPdfInput): Promise<LocalPdfImportResult> {
  const filename = safeFilename(input.filename)
  if (!/\.pdf$/iu.test(filename) || (input.mimeType !== undefined && input.mimeType !== 'application/pdf')) throw new Error('INVALID_PDF_TYPE')
  const maxMb = Number(process.env.MAX_PDF_UPLOAD_MB ?? 50)
  if (input.bytes.length < rt.cfg.http.minPdfBytes || input.bytes.length > Math.max(1, maxMb) * 1024 * 1024) throw new Error('INVALID_PDF_SIZE')
  if (input.bytes.length < PDF_MAGIC.length || !input.bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) throw new Error('INVALID_PDF')
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const previous = rt.db.prepare(
    "SELECT paper_id FROM fetch_log WHERE sha256 = ? AND outcome IN ('ok','PDF_OK') ORDER BY id DESC LIMIT 1",
  ).get(sha256) as { paper_id: string } | undefined
  if (previous) {
    const row = getPaper(rt.db, previous.paper_id)!
    return { paperId: row.id, isNewPaper: false, duplicateDetected: true, pdfAttached: false, sha256,
      metadata: { title: row.title, authors: authorsOf(row), venue: row.venue, year: row.year, doi: row.doi },
      metadataStatus: { complete: metadataComplete(row), enriched: row.metadata_enriched_at !== null, sources: row.metadata_source.split('+'), confidence: 1 }, readStatus: 'unread', reportStatus: 'none' }
  }
  mkdirSync(rt.pdfsDir, { recursive: true })
  const managedPath = join(rt.pdfsDir, `${sha256}.pdf`)
  if (!existsSync(managedPath)) writeFileSync(managedPath, input.bytes, { flag: 'wx' })
  let metadata: LocalMetadata
  try { metadata = await extractLocalMetadata(managedPath, filename) } catch (error) { throw error }
  if (!metadata.title) throw new Error('METADATA_TITLE_REQUIRED')
  let paper = asPaper(metadata, sha256)
  if (input.enrich !== false) {
    try { paper = await rt.registry.lookupMetadata(paper) } catch { /* partial import stays valid */ }
  }
  const match = identityMatch(rt.db, paper)
  const existing = match.confidence >= 0.9 ? match.paper : null
  const paperId = existing?.id ?? paper.id
  const row = toRow(paperId, paper, metadata, existing ?? undefined)
  row.metadata_enriched_at = input.enrich === false ? null : new Date().toISOString()
  upsertPaper(rt.db, row)
  rt.db.prepare(
    `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access)
     VALUES (?, ?, 'PDF_OK', ?, 'Manual Upload', ?, 'manual', 0)`,
  ).run(paperId, JSON.stringify([{ source: 'manual_upload', filename, status: 'ok' }]), managedPath, sha256)
  const saved = getPaper(rt.db, paperId)!
  return { paperId, isNewPaper: existing === null, duplicateDetected: false, pdfAttached: true, sha256,
    metadata: { title: saved.title, authors: authorsOf(saved), venue: saved.venue, year: saved.year, doi: saved.doi },
    metadataStatus: { complete: metadataComplete(saved), enriched: saved.metadata_enriched_at !== null, sources: saved.metadata_source.split('+'), confidence: existing ? match.confidence : null }, readStatus: 'unread', reportStatus: 'none' }
}

/** Confirm a managed PDF path is still a real non-empty file. */
export function hasManagedPdf(path: string | null): boolean {
  try { return path !== null && statSync(path).isFile() && statSync(path).size > 0 } catch { return false }
}
