/**
 * PDF acquisition with multi-source fallback. Tries every public/open-access
 * candidate from every adapter in order, then — only when all of them failed —
 * the registered PdfProviders (e.g. the CARSI institutional-access provider)
 * in registration order. Records the attempt trail in fetch_log with
 * provenance (source / access_type / is_open_access). When nothing yields a
 * valid PDF the outcome is FULLTEXT_UNAVAILABLE or a provider terminal
 * (AUTH_REQUIRED / ACCESS_DENIED / PDF_NOT_FOUND) — never a fake success.
 *
 * Provider specifics (browser driving, session state, login-wall detection)
 * live in src/providers/*; this module only knows the PdfProvider interface.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../db.js'
import type { PaperRef, PdfCandidate } from '../sources/types.js'
import type { PdfProvider, ProviderResult } from '../providers/types.js'

export type FetchOutcome =
  | 'ok' // public/open-access candidate
  | 'PDF_OK' // institutional provider success
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'ACCESS_DENIED'
  | 'PDF_NOT_FOUND'
  | 'FULLTEXT_UNAVAILABLE'
  | 'failed'

export type FetchAttemptStatus =
  | 'ok'
  | 'http_error'
  | 'not_pdf'
  | 'too_small'
  | 'network_error'
  | 'skipped'
  | 'auth_required'
  | 'rate_limited'
  | 'access_denied'
  | 'not_found'

export interface FetchAttempt {
  source: string
  url: string
  status: FetchAttemptStatus
  http?: number
  /** provider reason (e.g. login-wall message) when applicable */
  detail?: string
}

export interface FetchResult {
  outcome: FetchOutcome
  pdfPath?: string
  sha256?: string
  pdfSource?: string
  /** provenance: 'oa' | 'institutional' | 'manual' (requirement 1) */
  accessType?: 'oa' | 'institutional' | 'manual'
  isOpenAccess?: boolean
  attempts: FetchAttempt[]
}

const PDF_MAGIC = Buffer.from('%PDF')

/** Thrown when a response body is not a PDF (magic mismatch). */
class NotPdfError extends Error {
  constructor() {
    super('not a PDF (magic mismatch)')
  }
}

function looksLikePdf(buf: Buffer): boolean {
  return buf.length >= PDF_MAGIC.length && buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
}

async function download(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<Buffer> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!looksLikePdf(buf)) throw new NotPdfError()
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/** Map a provider result to an attempt-trail entry. */
function attemptOfProvider(name: string, r: ProviderResult): FetchAttempt {
  const status: FetchAttemptStatus =
    r.outcome === 'PDF_OK'
      ? 'ok'
      : r.outcome === 'AUTH_REQUIRED'
        ? 'auth_required'
        : r.outcome === 'RATE_LIMITED'
          ? 'rate_limited'
          : r.outcome === 'ACCESS_DENIED'
          ? 'access_denied'
          : 'not_found'
  return { source: name, url: r.url ?? '-', status, http: r.http, detail: r.reason }
}

/**
 * Download the first valid PDF from the public candidate list; when every
 * candidate fails, fall back to the registered providers (CARSI etc.) in
 * order. Records the attempt trail + provenance in fetch_log and stores the
 * file as pdfs/<sha256>.pdf.
 */
export async function fetchPdf(
  db: Db,
  paperId: string,
  candidates: PdfCandidate[],
  pdfsDir: string,
  opts: {
    timeoutMs?: number
    minPdfBytes?: number
    fetchImpl?: typeof fetch
    providers?: PdfProvider[]
    /** paper record; required when providers are used (they resolve URLs from it) */
    paper?: PaperRef
  } = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 30000
  const minBytes = opts.minPdfBytes ?? 10240
  const fetchImpl = opts.fetchImpl ?? fetch
  const attempts: FetchAttempt[] = []

  for (const c of candidates) {
    if (attempts.length >= 8) break
    try {
      const buf = await download(c.url, timeoutMs, fetchImpl)
      if (buf.length < minBytes) {
        attempts.push({ source: c.source, url: c.url, status: 'too_small' })
        continue
      }
      const sha256 = createHash('sha256').update(buf).digest('hex')
      const pdfPath = join(pdfsDir, `${sha256}.pdf`)
      mkdirSync(pdfsDir, { recursive: true })
      await writeFile(pdfPath, buf)
      attempts.push({ source: c.source, url: c.url, status: 'ok' })
      const pdfSource = `${c.url} (license: ${c.license})`
      db.prepare(
        `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access)
         VALUES (?, ?, 'ok', ?, ?, ?, 'oa', 1)`,
      ).run(paperId, JSON.stringify(attempts), pdfPath, pdfSource, sha256)
      return { outcome: 'ok', pdfPath, sha256, pdfSource, accessType: 'oa', isOpenAccess: true, attempts }
    } catch (err) {
      const e = err as { message?: string; name?: string }
      attempts.push({
        source: c.source,
        url: c.url,
        status:
          err instanceof NotPdfError
            ? 'not_pdf'
            : e?.name === 'AbortError'
              ? 'network_error'
              : 'http_error',
        http: /HTTP (\d+)/.exec(e?.message ?? '')?.[1] ? Number(/HTTP (\d+)/.exec(e?.message ?? '')![1]) : undefined,
      })
    }
  }

  // ---- all public candidates failed: provider chain (e.g. CARSI) ----
  for (const provider of opts.providers ?? []) {
    const gate = provider.shouldAttempt()
    if (!gate.ok) {
      attempts.push({ source: provider.name, url: '-', status: 'skipped', detail: gate.reason })
      continue
    }
    const result: ProviderResult = await provider.fetch(
      opts.paper ?? ({ id: paperId } as PaperRef),
      { pdfsDir, timeoutMs, minPdfBytes: minBytes },
    )
    attempts.push(attemptOfProvider(provider.name, result))

    if (result.outcome === 'PDF_OK' && result.pdfPath && result.sha256) {
      // defense-in-depth: the provider claims success — verify the file exists
      try {
        await access(result.pdfPath)
      } catch {
        attempts.push({
          source: provider.name,
          url: result.url ?? '-',
          status: 'not_found',
          detail: 'provider 报告 PDF_OK 但文件不存在',
        })
        continue
      }
      const pdfSource = `${provider.name}: ${result.url ?? result.pdfPath} (license: ${provider.accessType})`
      db.prepare(
        `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access)
         VALUES (?, ?, 'PDF_OK', ?, ?, ?, ?, ?)`,
      ).run(
        paperId,
        JSON.stringify(attempts),
        result.pdfPath,
        pdfSource,
        result.sha256,
        provider.accessType,
        provider.isOpenAccess ? 1 : 0,
      )
      return {
        outcome: 'PDF_OK',
        pdfPath: result.pdfPath,
        sha256: result.sha256,
        pdfSource,
        accessType: provider.accessType,
        isOpenAccess: provider.isOpenAccess,
        attempts,
      }
    }
  }

  // ---- terminal outcome ----
  const providerTerminal = (opts.providers ?? []).length > 0
    ? strongestProviderFailure(attempts)
    : undefined
  const outcome: FetchOutcome = providerTerminal ?? 'FULLTEXT_UNAVAILABLE'
  db.prepare('INSERT INTO fetch_log (paper_id, attempts, outcome) VALUES (?, ?, ?)').run(
    paperId,
    JSON.stringify(attempts),
    outcome,
  )
  return { outcome, attempts }
}

/** Strongest provider failure among the attempt trail (AUTH > RATE_LIMITED > DENIED > NOT_FOUND). */
function strongestProviderFailure(attempts: FetchAttempt[]): FetchOutcome | undefined {
  if (attempts.some((a) => a.status === 'auth_required')) return 'AUTH_REQUIRED'
  if (attempts.some((a) => a.status === 'rate_limited')) return 'RATE_LIMITED'
  if (attempts.some((a) => a.status === 'access_denied')) return 'ACCESS_DENIED'
  if (attempts.some((a) => a.status === 'not_found')) return 'PDF_NOT_FOUND'
  // Disabled providers may still appear as skipped; they do not turn the
  // paper into FULLTEXT_UNAVAILABLE. A real low-frequency gate is represented
  // explicitly as RATE_LIMITED by the provider.
  if (attempts.some((a) => a.status === 'skipped')) return 'PDF_NOT_FOUND'
  return undefined
}

export interface PreflightProbe {
  source: string
  url: string
  status: 'ok' | 'http_error' | 'not_pdf' | 'network_error'
  http?: number
}

export interface PreflightResult {
  available: boolean
  probes: PreflightProbe[]
}

/**
 * Cheap full-text availability preflight: probes each PUBLIC candidate with a
 * bounded fetch (up to probeBytes, then abort) and checks the PDF magic.
 * No file is written — the real download happens only for the selected paper.
 * Providers (CARSI) are deliberately NOT probed here: institutional access is
 * decided at fetch time only (strict low frequency, no browser sessions in
 * the selection loop).
 */
export async function preflightPdf(
  candidates: PdfCandidate[],
  opts: { timeoutMs?: number; probeBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<PreflightResult> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const probeBytes = opts.probeBytes ?? 16384
  const fetchImpl = opts.fetchImpl ?? fetch
  const probes: PreflightProbe[] = []

  for (const c of candidates) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(c.url, { signal: ctrl.signal, redirect: 'follow' })
      if (!res.ok) {
        probes.push({ source: c.source, url: c.url, status: 'http_error', http: res.status })
        continue
      }
      const reader = res.body?.getReader()
      let head = Buffer.alloc(0)
      if (reader) {
        let got = 0
        while (got < probeBytes) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            head = Buffer.concat([head, Buffer.from(value)])
            got += value.byteLength
          }
        }
        await reader.cancel().catch(() => undefined)
      } else {
        head = Buffer.from(await res.arrayBuffer())
      }
      if (!looksLikePdf(head)) {
        probes.push({ source: c.source, url: c.url, status: 'not_pdf' })
        continue
      }
      probes.push({ source: c.source, url: c.url, status: 'ok' })
      return { available: true, probes }
    } catch (err) {
      const e = err as { name?: string }
      probes.push({
        source: c.source,
        url: c.url,
        status: e?.name === 'AbortError' ? 'network_error' : 'http_error',
      })
    } finally {
      clearTimeout(timer)
    }
  }
  return { available: false, probes }
}

/**
 * Retry cooldown: latest FULLTEXT_UNAVAILABLE outcome for a paper, if it is
 * within the TTL window, returns the ISO timestamp until which retries are
 * suppressed; otherwise null.
 *
 * AUTH_REQUIRED is deliberately NOT a cooldown source (requirement 6): a
 * broken/expired institutional session must surface as a re-login prompt, not
 * as a paper-level permanent block.
 */
export function inRetryCooldown(db: Db, paperId: string, cooldownHours: number): string | null {
  if (!cooldownHours || cooldownHours <= 0) return null
  const row = db
    .prepare(
      `SELECT created_at FROM fetch_log
       WHERE paper_id = ? AND outcome = 'FULLTEXT_UNAVAILABLE'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(paperId) as { created_at: string } | undefined
  if (!row) return null
  const last = new Date(`${row.created_at.replace(' ', 'T')}Z`).getTime()
  if (Number.isNaN(last)) return null
  const until = last + cooldownHours * 3600 * 1000
  if (Date.now() < until) return new Date(until).toISOString()
  return null
}
