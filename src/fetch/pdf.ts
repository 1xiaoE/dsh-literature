/**
 * PDF acquisition with multi-source fallback. Tries every candidate from
 * every adapter in order; records the attempt trail. When no candidate
 * yields a valid PDF the outcome is FULLTEXT_UNAVAILABLE — never a fake
 * success.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../db.js'
import type { PdfCandidate } from '../sources/types.js'

export interface FetchAttempt {
  source: string
  url: string
  status: 'ok' | 'http_error' | 'not_pdf' | 'too_small' | 'network_error' | 'skipped'
  http?: number
}

export interface FetchResult {
  outcome: 'ok' | 'FULLTEXT_UNAVAILABLE' | 'failed'
  pdfPath?: string
  sha256?: string
  pdfSource?: string
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

/**
 * Download the first valid PDF from the candidate list, record the attempt
 * trail in fetch_log, and store the file as pdfs/<sha256>.pdf.
 */
export async function fetchPdf(
  db: Db,
  paperId: string,
  candidates: PdfCandidate[],
  pdfsDir: string,
  opts: { timeoutMs?: number; minPdfBytes?: number; fetchImpl?: typeof fetch } = {},
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
      const result: FetchResult = {
        outcome: 'ok',
        pdfPath,
        sha256,
        pdfSource: `${c.url} (license: ${c.license})`,
        attempts,
      }
      db.prepare(
        'INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source, sha256) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(paperId, JSON.stringify(attempts), 'ok', pdfPath, result.pdfSource ?? null, sha256)
      return result
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
      })
    }
  }

  const result: FetchResult = { outcome: 'FULLTEXT_UNAVAILABLE', attempts }
  db.prepare('INSERT INTO fetch_log (paper_id, attempts, outcome) VALUES (?, ?, ?)').run(
    paperId,
    JSON.stringify(attempts),
    'FULLTEXT_UNAVAILABLE',
  )
  return result
}
