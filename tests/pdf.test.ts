import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, upsertPaper, type Db } from '../src/db.js'
import { fetchPdf, inRetryCooldown } from '../src/fetch/pdf.js'
import type { PdfCandidate } from '../src/sources/types.js'

function fakeFetch(routes: Array<{ status: number; body: Buffer | string }>) {
  let i = 0
  return async (): Promise<Response> => {
    const r = routes[Math.min(i, routes.length - 1)]!
    i += 1
    if (r.status !== 200) {
      return new Response('nope', { status: r.status })
    }
    const body = typeof r.body === 'string' ? r.body : r.body
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })
  }
}

function pdfBytes(n: number): Buffer {
  // %PDF magic + filler
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, n - 8), 0x61)])
}

function tempDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-pdf-'))
  return { db: openDb(dir), dir }
}

const CANDS = (urls: Array<[string, string]>): PdfCandidate[] =>
  urls.map(([url, source]) => ({ url, license: 'oa' as const, source }))


function seedPaper(db: Db, id: string): void {
  upsertPaper(db, {
    id,
    title: 'Test Paper',
    authors: '["T"]',
    venue: null,
    year: 2024,
    doi: null,
    arxiv_id: id.replace('arxiv:', ''),
    openalex_id: null,
    url: null,
    oa_pdf_url: null,
    abstract: null,
    citations: 1,
    bibtex: null,
    metadata_source: 'arxiv',
  })
}


describe('fetchPdf multi-source fallback', () => {
  it('falls back through 404 and empty responses to a valid PDF', async () => {
    const { db, dir } = tempDb()
    seedPaper(db, 'arxiv:2401.001')
    const good = pdfBytes(20000)
    const result = await fetchPdf(
      db,
      'arxiv:2401.001',
      CANDS([
        ['https://bad.example/1.pdf', 'arxiv'],
        ['https://empty.example/2.pdf', 'openalex'],
        ['https://good.example/3.pdf', 'arxiv'],
      ]),
      join(dir, 'pdfs'),
      { fetchImpl: fakeFetch([{ status: 404, body: 'nf' }, { status: 200, body: '' }, { status: 200, body: good }]) },
    )
    expect(result.outcome).toBe('ok')
    expect(result.pdfPath).toBeTruthy()
    expect(result.sha256).toHaveLength(64)
    expect(result.attempts.map((a) => a.status)).toEqual(['http_error', 'not_pdf', 'ok'])
    const log = db.prepare('SELECT * FROM fetch_log WHERE paper_id = ?').all('arxiv:2401.001') as Array<{
      outcome: string
      attempts: string
    }>
    expect(log.length).toBe(1)
    expect(log[0]!.outcome).toBe('ok')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records FULLTEXT_UNAVAILABLE when every source fails', async () => {
    const { db, dir } = tempDb()
    seedPaper(db, 'arxiv:2401.002')
    const result = await fetchPdf(
      db,
      'arxiv:2401.002',
      CANDS([
        ['https://a.example/1.pdf', 'arxiv'],
        ['https://b.example/2.pdf', 'crossref'],
      ]),
      join(dir, 'pdfs'),
      { fetchImpl: fakeFetch([{ status: 403, body: 'denied' }, { status: 200, body: 'not a pdf at all' }]) },
    )
    expect(result.outcome).toBe('FULLTEXT_UNAVAILABLE')
    expect(result.pdfPath).toBeUndefined()
    const log = db.prepare('SELECT * FROM fetch_log WHERE paper_id = ?').all('arxiv:2401.002') as Array<{
      outcome: string
      attempts: string
    }>
    expect(log[0]!.outcome).toBe('FULLTEXT_UNAVAILABLE')
    expect(JSON.parse(log[0]!.attempts)).toHaveLength(2)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects too-small PDFs', async () => {
    const { db, dir } = tempDb()
    seedPaper(db, 'arxiv:2401.003')
    const tiny = pdfBytes(100) // below minPdfBytes
    const result = await fetchPdf(
      db,
      'arxiv:2401.003',
      CANDS([['https://tiny.example/1.pdf', 'arxiv']]),
      join(dir, 'pdfs'),
      { fetchImpl: fakeFetch([{ status: 200, body: tiny }]), minPdfBytes: 10240 },
    )
    expect(result.outcome).toBe('FULLTEXT_UNAVAILABLE')
    expect(result.attempts[0]!.status).toBe('too_small')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('retry cooldown (audit fix)', () => {
  it('suppresses re-attempts within the TTL and expires after it', () => {
    const { db, dir } = tempDb()
    seedPaper(db, 'arxiv:2401.099')
    db.prepare(
      "INSERT INTO fetch_log (paper_id, attempts, outcome, created_at) VALUES (?, '[]', 'FULLTEXT_UNAVAILABLE', datetime('now'))",
    ).run('arxiv:2401.099')
    expect(inRetryCooldown(db, 'arxiv:2401.099', 72)).not.toBeNull()
    expect(inRetryCooldown(db, 'arxiv:2401.099', 0)).toBeNull()
    // a stale (old) unavailable record is outside the TTL
    db.prepare(
      "INSERT INTO fetch_log (paper_id, attempts, outcome, created_at) VALUES (?, '[]', 'FULLTEXT_UNAVAILABLE', datetime('now', '-100 hours'))",
    ).run('arxiv:2401.099')
    expect(inRetryCooldown(db, 'arxiv:2401.099', 72)).toBeNull()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
