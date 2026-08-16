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
 * Cheap full-text availability preflight: probes each candidate with a
 * bounded fetch (up to probeBytes, then abort) and checks the PDF magic.
 * No file is written — the real download happens only for the selected paper.
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
