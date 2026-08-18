/**
 * Browser API client for the /api/dsh-literature route family (served by this
 * plugin's own node half through the harness webserver). Plain same-origin
 * fetch. Every call falls back to demo payloads when the route family is
 * unreachable. Development builds may return an explicit Demo payload;
 * production returns `mode: unavailable` and never substitutes mock data.
 */
import type {
  ApiResult,
  UiDashboard,
  UiPaperDetail,
  UiPaperSummary,
  UiPaperTranslation,
  UiPushStatus,
  UiRunResult,
} from './wire.ts'
import {
  MOCK_AUTH_STATUS,
  MOCK_DASHBOARD,
  MOCK_PAPERS,
  MOCK_PUSH_STATUS,
  mockDetail,
} from './mock.ts'

const BASE = '/api/dsh-literature'
declare const process: { env: { NODE_ENV?: string } }

class LiteratureApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiteratureApiError'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new LiteratureApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new LiteratureApiError(message)
  }
  return body as T
}

/** Wrap a live fetch with a demo fallback; reports whether the data is live. */
export function fallbackMode(mode: string): 'demo' | 'unavailable' {
  return mode === 'development' ? 'demo' : 'unavailable'
}

const buildMode = process.env.NODE_ENV ?? 'production'

async function withFallback<T>(live: () => Promise<T>, demo: () => T): Promise<ApiResult<T>> {
  try {
    const data = await live()
    return { data, live: true, mode: 'live' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const mode = fallbackMode(buildMode)
    if (mode === 'demo') {
      console.warn('[dsh-literature] live API unavailable, using explicit demo data:', error)
      return { data: demo(), live: false, mode }
    }
    console.warn('[dsh-literature] live API unavailable:', error)
    return { data: null, live: false, mode, error: message }
  }
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value)
  }
  const text = search.toString()
  return text === '' ? '' : '?' + text
}

export class LiteratureApi {
  dashboard(): Promise<ApiResult<UiDashboard>> {
    return withFallback(
      () => fetch(`${BASE}/dashboard`).then((r) => readJson<UiDashboard>(r)),
      () => MOCK_DASHBOARD,
    )
  }

  papers(category?: string): Promise<ApiResult<UiPaperSummary[]>> {
    return withFallback(
      () => fetch(`${BASE}/papers${query({ category })}`).then((r) => readJson<UiPaperSummary[]>(r)),
      () => {
        if (category === undefined || category === 'all') return MOCK_PAPERS
        if (category === 'selected') return MOCK_PAPERS.filter((p) => p.selected)
        if (category === 'read') return MOCK_PAPERS.filter((p) => p.readCount > 0)
        if (category === 'reports') return MOCK_PAPERS.filter((p) => p.reportCount > 0)
        if (category === 'favorites') return []
        return MOCK_PAPERS
      },
    )
  }

  paperDetail(id: string): Promise<ApiResult<UiPaperDetail>> {
    return withFallback(
      () => fetch(`${BASE}/papers/${encodeURIComponent(id)}`).then((r) => readJson<UiPaperDetail>(r)),
      () => mockDetail(id),
    )
  }

  pushStatus(): Promise<ApiResult<UiPushStatus>> {
    return withFallback(
      () => fetch(`${BASE}/push-status`).then((r) => readJson<UiPushStatus>(r)),
      // Demo: alternate the acquiring / auth-required scenarios per poll so
      // both states are visible in the demo mode.
      () => (Date.now() % 2 === 0 ? MOCK_PUSH_STATUS : MOCK_AUTH_STATUS),
    )
  }

  run(keyword: string): Promise<UiRunResult> {
    return fetch(`${BASE}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyword }),
    }).then((r) => readJson<UiRunResult>(r)).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))
  }

  resume(pushId: number): Promise<UiRunResult> {
    return fetch(`${BASE}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushId }),
    }).then((r) => readJson<UiRunResult>(r)).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))
  }

  /** Tail of the latest runner log (stderr/stdout capture), or null. */
  async runnerLog(): Promise<{ path: string; content: string } | null> {
    try {
      const response = await fetch(`${BASE}/runner-log`)
      if (!response.ok) return null
      return await readJson<{ path: string; content: string }>(response)
    } catch {
      return null
    }
  }

  importPdf(file: File): Promise<{ paperId: string }> {
    return fetch(`${BASE}/import-pdf${query({ filename: file.name })}`, {
      method: 'POST', headers: { 'content-type': file.type || 'application/pdf' }, body: file,
    }).then((response) => readJson<{ paperId: string }>(response))
  }

  enrichMetadata(paperId: string): Promise<void> {
    return fetch(`${BASE}/papers/${encodeURIComponent(paperId)}/enrich-metadata`, { method: 'POST' })
      .then((response) => readJson<unknown>(response)).then(() => undefined)
  }

  deepRead(paperId: string): Promise<void> {
    return fetch(`${BASE}/papers/${encodeURIComponent(paperId)}/deep-read`, { method: 'POST' })
      .then((response) => readJson<unknown>(response)).then(() => undefined)
  }

  createField(input: { nameEn: string; nameZh: string }): Promise<void> {
    return fetch(`${BASE}/categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
      .then((response) => readJson<unknown>(response)).then(() => undefined)
  }

  renameField(id: number, input: { nameEn: string; nameZh: string }): Promise<void> {
    return fetch(`${BASE}/categories/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
      .then((response) => readJson<unknown>(response)).then(() => undefined)
  }

  mergeField(id: number, targetId: number): Promise<void> {
    return fetch(`${BASE}/categories/${id}/merge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId }) })
      .then((response) => readJson<{ ok: true }>(response)).then(() => undefined)
  }

  deleteField(id: number, mode: 'detach' | 'move', targetId?: number): Promise<void> {
    return fetch(`${BASE}/categories/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, targetId }) })
      .then((response) => readJson<{ ok: true }>(response)).then(() => undefined)
  }

  addPaperField(paperId: string, categoryId: number): Promise<void> {
    return fetch(`${BASE}/papers/${encodeURIComponent(paperId)}/categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ categoryId }) })
      .then((response) => readJson<{ ok: true }>(response)).then(() => undefined)
  }

  removePaperField(paperId: string, categoryId: number): Promise<void> {
    return fetch(`${BASE}/papers/${encodeURIComponent(paperId)}/categories/${categoryId}`, { method: 'DELETE' })
      .then((response) => readJson<{ ok: true }>(response)).then(() => undefined)
  }

  /** Reserved for a future persistent translation cache; never calls an LLM today. */
  getPaperTranslation(_paperId: string, _language: 'zh-CN'): Promise<UiPaperTranslation | null> {
    return Promise.resolve(null)
  }
}
