/**
 * /api/dsh-literature route family — the browser UI's only data path.
 *
 * The node half of the SAME dsh-literature plugin serves these routes through
 * the harness webServer (registered only when a web profile is running; the
 * headless profile never mounts a webserver and is unaffected). Handlers are
 * thin: they read the existing SQLite through src/ui/adapter.ts and, for
 * Run/Resume, spawn the EXISTING CLI workflow (bin/dsh-literature-push.mjs)
 * — no new retrieval/ranking/acquisition/database anywhere.
 *
 * Every route carries a loopback-only trust fence (mirrors dsh-ssh): these
 * endpoints can launch agent runs, so LAN-exposed deployments must not serve
 * them.
 */
import { once } from 'node:events'
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LiteratureRuntime } from '../lib/runtime.js'
import {
  bulkRemoveRetrieved,
  getDashboard,
  getPaperDetail,
  getPushStatus,
  latestRunnerLog,
  listPapers,
  removeRetrieved,
  setPaperFavorite,
  canResumePush,
  startResume,
  startPush,
  workflowAlreadyRunning,
  type PapersFilter,
} from './adapter.js'
import type { UiRunResult } from './types.js'
import {
  assignPaperField,
  createResearchField,
  deleteResearchField,
  listResearchFields,
  mergeResearchFields,
  removePaperField,
  renameResearchField,
} from '../lib/research_fields.js'
import { enrichPaperMetadata, importLocalPdfFromFile } from '../lib/library_import.js'
import { startDeepRead } from '../lib/deep_read.js'

/** Minimal structural WebRoute (matches @deepseek-ai/dsh-host-webserver). */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Route dependencies: the same lazy runtime the tools use. */
export interface UiRouteDeps {
  getRt: () => LiteratureRuntime
  startPush?: (keyword: string, rt?: LiteratureRuntime) => UiRunResult | Promise<UiRunResult>
  startResume?: (pushId: number, rt?: LiteratureRuntime) => UiRunResult | Promise<UiRunResult>
}

/** Cap on JSON request bodies (Run/Resume payloads are tiny). */
const MAX_JSON_BODY_BYTES = 16 * 1024

function maxPdfUploadBytes(): number {
  const mb = Number(process.env.MAX_PDF_UPLOAD_MB ?? 50)
  return Math.max(1, Number.isFinite(mb) ? mb : 50) * 1024 * 1024
}

/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

async function readBinaryBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

const PDF_MAGIC = Buffer.from('%PDF-')

interface StagedUpload {
  dir: string
  path: string
  sha256: string
  reason: 'ok' | 'too_large' | 'not_pdf'
}

/**
 * Stream an upload body to a temp file while hashing it and enforcing the
 * size cap and %PDF- magic. Never buffers the whole file in memory. The
 * caller owns cleanup of the returned temp dir.
 */
async function streamUploadToTemp(req: IncomingMessage, limit: number): Promise<StagedUpload> {
  const { createHash } = await import('node:crypto')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-upload-'))
  const path = join(dir, 'upload.bin')
  const hash = createHash('sha256')
  let size = 0
  let magicBytes = 0
  const stream = createWriteStream(path, { flags: 'wx' })
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > limit) return { dir, path, sha256: hash.digest('hex'), reason: 'too_large' }
      // Validate the %PDF- magic incrementally over the first bytes.
      if (magicBytes < PDF_MAGIC.length) {
        const need = PDF_MAGIC.length - magicBytes
        const take = Math.min(need, buffer.length)
        if (!buffer.subarray(0, take).equals(PDF_MAGIC.subarray(magicBytes, magicBytes + take))) {
          return { dir, path, sha256: hash.digest('hex'), reason: 'not_pdf' }
        }
        magicBytes += take
      }
      hash.update(buffer)
      if (!stream.write(buffer)) await once(stream, 'drain')
    }
    if (magicBytes < PDF_MAGIC.length) return { dir, path, sha256: hash.digest('hex'), reason: 'not_pdf' }
    await new Promise<void>((resolve2, reject) => {
      stream.end(() => resolve2())
      stream.on('error', reject)
    })
    return { dir, path, sha256: hash.digest('hex'), reason: 'ok' }
  } finally {
    if (!stream.closed) stream.destroy()
  }
}

function guard(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { error: 'forbidden: loopback-only' })
    return false
  }
  if (req.method !== method) {
    writeJson(res, 405, { error: `method not allowed (expected ${method})` })
    return false
  }
  return true
}

function err(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: message })
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

function integerField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Decode a single captured path segment (percent-encoded paper id). The raw
 * pathname is deliberately NOT decoded globally (see handler), so ids like
 * `doi:10.1109/TRO.xxx` arrive as `doi%3A10.1109%2FTRO.xxx` and must be
 * unescaped exactly once here. Malformed escapes fall back to the raw text.
 */
function decodeId(raw: string): string {
  try { return decodeURIComponent(raw) } catch { return raw }
}

function categoryError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  err(res, message === 'FIELD_NOT_FOUND' || message === 'PAPER_NOT_FOUND' ? 404 : 400, message)
}

function streamFile(res: ServerResponse, path: string, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-disposition': 'inline',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  const stream = createReadStream(path)
  stream.on('error', () => { res.destroy() })
  stream.pipe(res)
}

/**
 * Build the single /api/dsh-literature prefix route. Returns one registration
 * so src/index.ts can pass it straight to ctx.webServer.register.
 */
export function makeUiRoutes(deps: UiRouteDeps): WebRouteLike {
  return {
    kind: 'prefix',
    path: '/api/dsh-literature',
    handler: async (req, res) => {
      // Keep the RAW (undecoded) pathname for route matching: paper ids such
      // as `doi:10.1109/TRO.xxx` contain '/' and are sent percent-encoded
      // (%2F). Decoding the whole pathname early would turn those into real
      // slashes and break every single-segment `^/papers/([^/]+)/...` regex.
      // Captured id segments are decoded individually via decodeId() below.
      const url = new URL(req.url ?? '/', 'http://x')
      const pathname = url.pathname
      const rest = pathname.startsWith('/api/dsh-literature')
        ? pathname.slice('/api/dsh-literature'.length)
        : pathname

      try {
        if (rest === '/dashboard' && guard(req, res, 'GET')) {
          const rt = deps.getRt()
          writeJson(res, 200, getDashboard(rt.db))
          return
        }
        if (rest === '/push-status' && guard(req, res, 'GET')) {
          const rt = deps.getRt()
          writeJson(res, 200, getPushStatus(rt.db, rt.cfg))
          return
        }
        if (rest === '/papers' && guard(req, res, 'GET')) {
          const rt = deps.getRt()
          const category = url.searchParams.get('category') ?? undefined
          const filter: PapersFilter = category !== undefined && category.length > 0 ? { category } : {}
          writeJson(res, 200, listPapers(rt.db, filter))
          return
        }
        if (rest === '/import-pdf' && guard(req, res, 'POST')) {
          const filename = url.searchParams.get('filename') ?? ''
          const mimeType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].split(';')[0] : undefined
          if (!filename) { err(res, 400, 'PDF_FILENAME_REQUIRED'); return }
          const staged = await streamUploadToTemp(req, maxPdfUploadBytes())
          if (staged.reason !== 'ok') {
            rmSync(staged.dir, { recursive: true, force: true })
            err(res, staged.reason === 'too_large' ? 413 : 400, staged.reason === 'too_large' ? 'PDF_TOO_LARGE' : 'INVALID_PDF')
            return
          }
          try {
            writeJson(res, 201, await importLocalPdfFromFile(deps.getRt(), {
              filename,
              mimeType,
              tempPath: staged.path,
              sha256: staged.sha256,
              move: true,
            }))
          } catch (error) {
            categoryError(res, error)
          } finally {
            rmSync(staged.dir, { recursive: true, force: true })
          }
          return
        }
        if (rest === '/categories') {
          if (req.method === 'GET') {
            if (!guard(req, res, 'GET')) return
            writeJson(res, 200, listResearchFields(deps.getRt().db))
            return
          }
          if (!guard(req, res, 'POST')) return
          const body = await readJsonBody(req)
          const nameEn = body === undefined ? undefined : stringField(body, 'nameEn')
          const nameZh = body === undefined ? undefined : stringField(body, 'nameZh')
          if (nameEn === undefined || nameZh === undefined) {
            err(res, 400, 'FIELD_NAMES_REQUIRED')
            return
          }
          try {
            writeJson(res, 201, createResearchField(deps.getRt().db, { nameEn, nameZh }))
          } catch (error) { categoryError(res, error) }
          return
        }
        const categoryMatch = /^\/categories\/(\d+)(?:\/(merge))?$/.exec(rest)
        if (categoryMatch !== null && categoryMatch[2] === 'merge') {
          if (!guard(req, res, 'POST')) return
          const body = await readJsonBody(req)
          const targetId = body === undefined ? undefined : integerField(body, 'targetId')
          if (targetId === undefined) {
            err(res, 400, 'FIELD_MOVE_TARGET_REQUIRED')
            return
          }
          try {
            mergeResearchFields(deps.getRt().db, Number(categoryMatch[1]), targetId)
            writeJson(res, 200, { ok: true })
          } catch (error) { categoryError(res, error) }
          return
        }
        if (categoryMatch !== null && req.method === 'PATCH') {
          if (!guard(req, res, 'PATCH')) return
          const body = await readJsonBody(req)
          const nameEn = body === undefined ? undefined : stringField(body, 'nameEn')
          const nameZh = body === undefined ? undefined : stringField(body, 'nameZh')
          if (nameEn === undefined || nameZh === undefined) {
            err(res, 400, 'FIELD_NAMES_REQUIRED')
            return
          }
          try {
            writeJson(res, 200, renameResearchField(deps.getRt().db, Number(categoryMatch[1]), { nameEn, nameZh }))
          } catch (error) { categoryError(res, error) }
          return
        }
        if (categoryMatch !== null && req.method === 'DELETE') {
          if (!guard(req, res, 'DELETE')) return
          const body = await readJsonBody(req)
          const mode = body?.mode === 'move' ? 'move' : body?.mode === 'detach' ? 'detach' : undefined
          const targetId = body === undefined ? undefined : integerField(body, 'targetId')
          if (mode === undefined) {
            err(res, 400, 'FIELD_DELETE_MODE_REQUIRED')
            return
          }
          try {
            deleteResearchField(deps.getRt().db, Number(categoryMatch[1]), mode, targetId)
            writeJson(res, 200, { ok: true })
          } catch (error) { categoryError(res, error) }
          return
        }
        if (categoryMatch !== null) {
          if (!guard(req, res, 'PATCH')) return
        }
        const paperCategoryMatch = /^\/papers\/([^/]+)\/categories(?:\/(\d+))?$/.exec(rest)
        if (paperCategoryMatch !== null && paperCategoryMatch[2] === undefined) {
          if (!guard(req, res, 'POST')) return
          const body = await readJsonBody(req)
          const categoryId = body === undefined ? undefined : integerField(body, 'categoryId')
          if (categoryId === undefined) {
            err(res, 400, 'CATEGORY_ID_REQUIRED')
            return
          }
          try {
            assignPaperField(deps.getRt().db, decodeId(paperCategoryMatch[1]!), categoryId)
            writeJson(res, 200, { ok: true })
          } catch (error) { categoryError(res, error) }
          return
        }
        if (paperCategoryMatch !== null && paperCategoryMatch[2] !== undefined) {
          if (!guard(req, res, 'DELETE')) return
          try {
            removePaperField(deps.getRt().db, decodeId(paperCategoryMatch[1]!), Number(paperCategoryMatch[2]))
            writeJson(res, 200, { ok: true })
          } catch (error) { categoryError(res, error) }
          return
        }
        if (rest.startsWith('/assets/pdf/') && guard(req, res, 'GET')) {
          const id = decodeId(rest.slice('/assets/pdf/'.length))
          const detail = id.length > 0 ? getPaperDetail(deps.getRt().db, id) : null
          if (detail?.pdfPath === null || detail === null) {
            err(res, 404, 'PDF_NOT_AVAILABLE')
            return
          }
          streamFile(res, detail.pdfPath, 'application/pdf')
          return
        }
        if (rest.startsWith('/assets/report/') && guard(req, res, 'GET')) {
          const id = decodeId(rest.slice('/assets/report/'.length))
          const detail = id.length > 0 ? getPaperDetail(deps.getRt().db, id) : null
          if (detail?.reportPath === null || detail === null) {
            err(res, 404, 'REPORT_NOT_AVAILABLE')
            return
          }
          streamFile(res, detail.reportPath, 'text/markdown; charset=utf-8')
          return
        }
        const enrichMatch = /^\/papers\/([^/]+)\/enrich-metadata$/.exec(rest)
        if (enrichMatch !== null) {
          if (!guard(req, res, 'POST')) return
          try { writeJson(res, 200, await enrichPaperMetadata(deps.getRt(), decodeId(enrichMatch[1]!))) } catch (error) { categoryError(res, error) }
          return
        }
        const deepReadMatch = /^\/papers\/([^/]+)\/deep-read$/.exec(rest)
        if (deepReadMatch !== null) {
          if (!guard(req, res, 'POST')) return
          const paperId = decodeId(deepReadMatch[1]!)
          const result = startDeepRead(deps.getRt(), paperId)
          if (!result.started) { err(res, result.errorCode === 'ALREADY_RUNNING' || result.errorCode === 'ALREADY_COMPLETE' ? 409 : 404, result.errorCode ?? 'DEEP_READ_NOT_AVAILABLE'); return }
          writeJson(res, 202, { ok: true, paperId, status: 'running' })
          return
        }
        const favoriteMatch = /^\/papers\/([^/]+)\/favorite$/.exec(rest)
        if (favoriteMatch !== null) {
          if (!guard(req, res, 'POST')) return
          try {
            const result = setPaperFavorite(deps.getRt().db, decodeId(favoriteMatch[1]!))
            writeJson(res, 200, result)
          } catch (error) { categoryError(res, error) }
          return
        }
        const retrievedMatch = /^\/retrieved\/([^/]+)$/.exec(rest)
        if (retrievedMatch !== null) {
          if (!guard(req, res, 'DELETE')) return
          try {
            writeJson(res, 200, removeRetrieved(deps.getRt().db, decodeId(retrievedMatch[1]!)))
          } catch (error) { categoryError(res, error) }
          return
        }
        if (rest === '/retrieved/bulk-remove' && guard(req, res, 'POST')) {
          const body = await readJsonBody(req)
          const paperIds = Array.isArray(body?.paperIds) ? body.paperIds.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
          if (paperIds.length === 0) {
            err(res, 400, 'missing paperIds array')
            return
          }
          try {
            writeJson(res, 200, bulkRemoveRetrieved(deps.getRt().db, paperIds))
          } catch (error) { categoryError(res, error) }
          return
        }
        if (rest.startsWith('/papers/') && guard(req, res, 'GET')) {
          const rt = deps.getRt()
          const id = decodeId(rest.slice('/papers/'.length))
          if (id.length === 0) {
            err(res, 400, 'missing paper id')
            return
          }
          const detail = getPaperDetail(rt.db, id)
          if (detail === null) {
            err(res, 404, `paper not found: ${id}`)
            return
          }
          writeJson(res, 200, detail)
          return
        }
        if (rest === '/run' && guard(req, res, 'POST')) {
          const rt = deps.getRt()
          if (workflowAlreadyRunning(rt.db)) {
            err(res, 409, 'WORKFLOW_ALREADY_RUNNING')
            return
          }
          const body = await readJsonBody(req)
          if (body === undefined) {
            err(res, 400, 'invalid JSON body')
            return
          }
          const keyword = typeof body?.keyword === 'string' ? body.keyword.trim() : ''
          const result = await (deps.startPush ?? startPush)(keyword, rt)
          writeJson(res, result.ok ? 200 : result.errorCode === 'WORKFLOW_ALREADY_RUNNING' ? 409 : 500, result)
          return
        }
        if (rest === '/resume' && guard(req, res, 'POST')) {
          const body = await readJsonBody(req)
          const pushId = typeof body?.pushId === 'number' && Number.isInteger(body.pushId) ? body.pushId : undefined
          if (pushId === undefined) {
            err(res, 400, 'missing integer pushId')
            return
          }
          if (!canResumePush(deps.getRt().db, pushId)) {
            err(res, 409, 'RESUME_NOT_AVAILABLE')
            return
          }
          const result = await (deps.startResume ?? startResume)(pushId, deps.getRt())
          writeJson(res, result.ok ? 200 : result.errorCode === 'WORKFLOW_ALREADY_RUNNING' ? 409 : 500, result)
          return
        }
        if (rest === '/runner-log' && guard(req, res, 'GET')) {
          const log = latestRunnerLog(deps.getRt())
          if (log === null) {
            err(res, 404, 'NO_RUNNER_LOG')
            return
          }
          writeJson(res, 200, log)
          return
        }
        if (rest === '/health' && guard(req, res, 'GET')) {
          writeJson(res, 200, { ok: true })
          return
        }
        if (res.writableEnded) return
        err(res, 404, `unknown dsh-literature route: ${rest}`)
      } catch (error) {
        console.error('[dsh-literature] ui route error:', error)
        err(res, 500, error instanceof Error ? error.message : String(error))
      }
    },
  }
}
