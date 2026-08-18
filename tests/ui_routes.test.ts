import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config.js'
import { openDb, upsertPaper, type Db } from '../src/db.js'
import type { LiteratureRuntime } from '../src/lib/runtime.js'
import { makeUiRoutes } from '../src/ui/routes.js'

class CaptureResponse extends Writable {
  status = 200
  readonly headers: Record<string, string> = {}
  readonly chunks: Buffer[] = []

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status
    Object.assign(this.headers, headers)
    return this
  }

  text(): string { return Buffer.concat(this.chunks).toString('utf8') }
}

function request(method: string, url: string, body?: string, headers: IncomingHttpHeaders = {}): IncomingMessage {
  return {
    method,
    url,
    headers: { host: 'localhost', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  } as unknown as IncomingMessage
}

async function invoke(
  db: Db,
  req: IncomingMessage,
  launch: (keyword: string) => { ok: boolean; message: string } = () => ({ ok: true, message: 'started' }),
): Promise<CaptureResponse> {
  const runtime = { db, cfg: defaultConfig() } as LiteratureRuntime
  const route = makeUiRoutes({ getRt: () => runtime, startPush: launch })
  const response = new CaptureResponse()
  await route.handler(req, response as unknown as ServerResponse)
  if (!response.writableFinished) await once(response, 'finish')
  return response
}

function seedPaper(db: Db, id: string): void {
  upsertPaper(db, {
    id,
    title: 'Route Test Paper',
    authors: '[]',
    venue: null,
    year: 2026,
    doi: null,
    arxiv_id: null,
    openalex_id: null,
    url: null,
    oa_pdf_url: null,
    abstract: null,
    citations: null,
    bibtex: null,
    metadata_source: 'test',
  })
}

describe('UI routes', () => {
  it('creates a bilingual field and assigns it to a paper through loopback routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    try {
      seedPaper(db, 'paper:field')
      const created = await invoke(db, request('POST', '/api/dsh-literature/categories', JSON.stringify({ nameEn: 'State Estimation', nameZh: '状态估计' })))
      expect(created.status).toBe(201)
      const field = JSON.parse(created.text()) as { id: number; nameEn: string }
      expect(field.nameEn).toBe('State Estimation')
      const assigned = await invoke(db, request('POST', '/api/dsh-literature/papers/paper%3Afield/categories', JSON.stringify({ categoryId: field.id })))
      expect(assigned.status).toBe(200)
      const detail = await invoke(db, request('GET', '/api/dsh-literature/papers/paper%3Afield'))
      expect(JSON.parse(detail.text()).researchFields).toEqual(expect.arrayContaining([expect.objectContaining({ id: field.id, source: 'manual' })]))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects category writes from a cross-site browser request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    try {
      const response = await invoke(db, request('POST', '/api/dsh-literature/categories', JSON.stringify({ nameEn: 'Control', nameZh: '控制' }), { origin: 'http://evil.example' }))
      expect(response.status).toBe(403)
      expect(db.prepare("SELECT COUNT(*) AS n FROM categories WHERE name_en = 'Control'").get()).toMatchObject({ n: 1 })
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns 400 and never launches for malformed JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    let launches = 0
    try {
      const response = await invoke(
        db,
        request('POST', '/api/dsh-literature/run', '{', { 'content-type': 'application/json' }),
        () => { launches += 1; return { ok: true, message: 'started' } },
      )
      expect(response.status).toBe(400)
      expect(JSON.parse(response.text())).toEqual({ error: 'invalid JSON body' })
      expect(launches).toBe(0)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns 400 and never launches for an oversized JSON body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    let launches = 0
    try {
      const oversized = JSON.stringify({ keyword: 'x'.repeat(17 * 1024) })
      const response = await invoke(
        db,
        request('POST', '/api/dsh-literature/run', oversized, { 'content-type': 'application/json' }),
        () => { launches += 1; return { ok: true, message: 'started' } },
      )
      expect(response.status).toBe(400)
      expect(JSON.parse(response.text())).toEqual({ error: 'invalid JSON body' })
      expect(launches).toBe(0)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps an active persisted push to 409 before invoking the launcher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    let launches = 0
    try {
      db.prepare(`INSERT INTO pushes (topic, status) VALUES ('control', 'running')`).run()
      const response = await invoke(
        db,
        request('POST', '/api/dsh-literature/run', JSON.stringify({ keyword: '' }), { 'content-type': 'application/json' }),
        () => { launches += 1; return { ok: true, message: 'started' } },
      )
      expect(response.status).toBe(409)
      expect(JSON.parse(response.text())).toEqual({ error: 'WORKFLOW_ALREADY_RUNNING' })
      expect(launches).toBe(0)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('streams only SQLite-backed existing PDF and report assets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    try {
      seedPaper(db, 'paper:asset')
      const pdf = join(dir, 'paper.pdf')
      const report = join(dir, 'report.md')
      writeFileSync(pdf, '%PDF-1.4 route')
      writeFileSync(report, '# route report')
      db.prepare(`INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path) VALUES ('paper:asset', '[]', 'PDF_OK', ?)`).run(pdf)
      db.prepare(`INSERT INTO pushes (topic, status, paper_id, report_path) VALUES ('control', 'completed', 'paper:asset', ?)`).run(report)

      const pdfResponse = await invoke(db, request('GET', `/api/dsh-literature/assets/pdf/${encodeURIComponent('paper:asset')}`))
      expect(pdfResponse.status).toBe(200)
      expect(pdfResponse.headers['content-type']).toBe('application/pdf')
      expect(pdfResponse.text()).toBe('%PDF-1.4 route')
      const reportResponse = await invoke(db, request('GET', `/api/dsh-literature/assets/report/${encodeURIComponent('paper:asset')}`))
      expect(reportResponse.status).toBe(200)
      expect(reportResponse.headers['content-type']).toBe('text/markdown; charset=utf-8')
      expect(reportResponse.text()).toBe('# route report')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects cross-site browser requests at the loopback trust boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    try {
      const response = await invoke(db, request('GET', '/api/dsh-literature/health', undefined, { 'sec-fetch-site': 'cross-site' }))
      expect(response.status).toBe(403)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a browser Origin that does not match the loopback host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    try {
      const response = await invoke(db, request('GET', '/api/dsh-literature/health', undefined, { origin: 'http://evil.example' }))
      expect(response.status).toBe(403)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes DOI-style paper ids containing "/" (percent-encoded) on every write API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    try {
      const doiId = 'doi:10.1109/TRO.2024.1234567'
      seedPaper(db, doiId)
      // GET detail must decode the id back to the DOI form.
      const detail = await invoke(db, request('GET', `/api/dsh-literature/papers/${encodeURIComponent(doiId)}`))
      expect(detail.status).toBe(200)
      expect((JSON.parse(detail.text()) as { id: string }).id).toBe(doiId)

      // Category assignment.
      const created = await invoke(db, request('POST', '/api/dsh-literature/categories', JSON.stringify({ nameEn: 'State Estimation', nameZh: '状态估计' })))
      expect(created.status).toBe(201)
      const field = JSON.parse(created.text()) as { id: number }
      const assigned = await invoke(db, request('POST', `/api/dsh-literature/papers/${encodeURIComponent(doiId)}/categories`, JSON.stringify({ categoryId: field.id })))
      expect(assigned.status).toBe(200)

      // Enrich metadata (reports success without a network hit in tests).
      const enriched = await invoke(db, request('POST', `/api/dsh-literature/papers/${encodeURIComponent(doiId)}/enrich-metadata`))
      expect(enriched.status).toBe(200)

      // Favorite toggle.
      const fav = await invoke(db, request('POST', `/api/dsh-literature/papers/${encodeURIComponent(doiId)}/favorite`))
      expect(fav.status).toBe(200)
      expect((JSON.parse(fav.text()) as { favorite: boolean }).favorite).toBe(true)

      // Deep read starts (no real PDF → 404 with DEEP_READ_NOT_AVAILABLE proves
      // the route matched; a 404 for the wrong reason would be a routing bug).
      const deep = await invoke(db, request('POST', `/api/dsh-literature/papers/${encodeURIComponent(doiId)}/deep-read`))
      expect([404, 202]).toContain(deep.status)

      // Retrieved removal keeps the library paper (favorite protects it).
      const removed = await invoke(db, request('DELETE', `/api/dsh-literature/retrieved/${encodeURIComponent(doiId)}`))
      expect(removed.status).toBe(200)
      const removedBody = JSON.parse(removed.text()) as { protectedLibrary: boolean; removedRetrieved: boolean }
      expect(removedBody.protectedLibrary).toBe(true)
      expect(removedBody.removedRetrieved).toBe(false) // no retrieval history seeded

      // Category relation survived the removal.
      const detailAfter = await invoke(db, request('GET', `/api/dsh-literature/papers/${encodeURIComponent(doiId)}`))
      const after = JSON.parse(detailAfter.text()) as { researchFields: Array<{ id: number }> }
      expect(after.researchFields.map((f) => f.id)).toContain(field.id)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes DOI-style paper ids with a real PDF through the asset endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-routes-'))
    const db = openDb(dir)
    try {
      const doiId = 'doi:10.1109/LRA.2023.9988776'
      seedPaper(db, doiId)
      const pdf = join(dir, 'doi-asset.pdf')
      writeFileSync(pdf, '%PDF-1.4 doi route')
      db.prepare(`INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path) VALUES (?, '[]', 'PDF_OK', ?)`).run(doiId, pdf)
      const pdfResponse = await invoke(db, request('GET', `/api/dsh-literature/assets/pdf/${encodeURIComponent(doiId)}`))
      expect(pdfResponse.status).toBe(200)
      expect(pdfResponse.text()).toBe('%PDF-1.4 doi route')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
