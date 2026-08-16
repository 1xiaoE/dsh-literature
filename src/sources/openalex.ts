/**
 * OpenAlex adapter: metadata, citation counts, venue, OA locations.
 * Query style: semantic `search=` (official capability) with
 * `filter=title_and_abstract.search:"q"` style constraints where useful;
 * multiple query results are merged by the registry. Captures the
 * source-provided `relevance_score` for retrieval provenance.
 * API: https://api.openalex.org/works
 *
 * Auth (security rules):
 * - OPENALEX_API_KEY is read from the environment (or injected for tests);
 * - when present, EVERY OpenAlex request gets `api_key=<key>` appended;
 * - the key is NEVER logged / persisted / committed: the only log lines are
 *   "OpenAlex API key configured" (key present) or
 *   "openalex_auth_mode=anonymous" (key absent);
 * - anonymous mode stays the default when no key exists.
 *
 * Robustness:
 * - request-level dedup: the same URL is fetched at most once per adapter
 *   instance (recent+landmark pools often repeat the same query text);
 * - a clear quota/rate-limit HTTP 429 trips a run-level circuit breaker:
 *   the remaining OpenAlex requests of this run stop immediately (arXiv /
 *   Crossref / Unpaywall are unaffected — the breaker lives inside this
 *   adapter only);
 * - finite retries only for transient 5xx (max 2 retries, bounded backoff) —
 *   never infinite retries.
 */
import type { PaperRef, PdfCandidate, SearchHit, SearchParams, SourceAdapter } from './types.js'

const API = 'https://api.openalex.org/works'
const RATE_LIMIT_API = 'https://api.openalex.org/rate_limit'

interface OpenAlexWork {
  id: string
  doi?: string
  title?: string
  display_name?: string
  publication_year?: number
  cited_by_count?: number
  relevance_score?: number
  authorships?: Array<{ author?: { display_name?: string } }>
  primary_location?: {
    source?: { display_name?: string }
    pdf_url?: string | null
    landing_page_url?: string | null
    url_for_pdf?: string | null
  }
  best_oa_location?: {
    pdf_url?: string | null
    landing_page_url?: string | null
    url_for_pdf?: string | null
  } | null
  abstract_inverted_index?: Record<string, number[]> | null
}

/** Thrown when the run-level rate-limit breaker is open. */
class RateLimitedError extends Error {
  constructor() {
    super('OpenAlex rate-limited (circuit breaker open)')
  }
}

function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string | undefined {
  if (!inv) return undefined
  const pos: Array<{ w: string; i: number }> = []
  for (const [w, idxs] of Object.entries(inv)) {
    for (const i of idxs) pos.push({ w, i })
  }
  pos.sort((a, b) => a.i - b.i)
  return pos.map((p) => p.w).join(' ')
}

export class OpenAlexAdapter implements SourceAdapter {
  readonly name = 'openalex'
  readonly authMode: 'anonymous' | 'api_key'
  /** request-level dedup: url → in-flight/resolved promise */
  private readonly cache = new Map<string, Promise<unknown>>()
  /** run-level circuit breaker: a clear 429 stops all remaining OpenAlex calls */
  private rateLimited = false
  /** ES private field: never enumerable / serializable / loggable */
  readonly #apiKey?: string

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30000,
    private readonly mailto?: string,
    apiKey?: string,
  ) {
    this.#apiKey = apiKey ?? process.env.OPENALEX_API_KEY
    this.authMode = this.#apiKey ? 'api_key' : 'anonymous'
    // The ONLY key-related log lines. Never log the key itself.
    if (this.#apiKey) console.log('OpenAlex API key configured')
    else console.log('openalex_auth_mode=anonymous')
  }

  /** Append the api_key query parameter when configured (never logged). */
  private withKey(url: string): string {
    if (!this.#apiKey) return url
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}api_key=${encodeURIComponent(this.#apiKey)}`
  }

  private async getJson(url: string, retries = 2): Promise<unknown> {
    if (this.rateLimited) throw new RateLimitedError()
    const keyed = this.withKey(url)
    const cached = this.cache.get(keyed)
    if (cached) return cached
    const p = this.doGetJson(keyed, retries)
    this.cache.set(keyed, p)
    try {
      return await p
    } catch (err) {
      // failed responses are NOT cached: a later identical call may retry
      this.cache.delete(keyed)
      throw err
    }
  }

  private async doGetJson(url: string, retries: number): Promise<unknown> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      try {
        const headers: Record<string, string> = { accept: 'application/json' }
        if (this.mailto) headers['User-Agent'] = this.mailto
        const res = await this.fetchImpl(url, { signal: ctrl.signal, headers })
        if (res.status === 429) {
          // clear quota/rate-limit: trip the breaker, do NOT retry
          this.rateLimited = true
          console.warn('[dsh-literature] OpenAlex HTTP 429: stopping remaining OpenAlex requests for this run')
          throw new RateLimitedError()
        }
        if (res.status >= 500) {
          // transient server errors: finite bounded retries only
          lastErr = new Error(`OpenAlex API HTTP ${res.status}`)
          if (attempt < retries) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
          continue
        }
        if (!res.ok) throw new Error(`OpenAlex API HTTP ${res.status}`)
        return await res.json()
      } catch (err) {
        // a tripped breaker must abort the loop immediately (no further calls)
        if (err instanceof RateLimitedError) throw err
        lastErr = err
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
        }
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastErr ?? new Error('OpenAlex API failed')
  }

  private toRef(w: OpenAlexWork): PaperRef | null {
    const title = w.title ?? w.display_name
    if (!title) return null
    const id = w.id.split('/').pop() ?? ''
    const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, '') : undefined
    // landing page ≠ OA PDF: only url_for_pdf/pdf_url counts as a fulltext signal
    const oaPdf = w.best_oa_location?.url_for_pdf ?? w.primary_location?.pdf_url ?? undefined
    const landing = w.primary_location?.landing_page_url ?? w.best_oa_location?.landing_page_url ?? undefined
    return {
      id: `openalex:${id}`,
      title: title.trim(),
      authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
      venue: w.primary_location?.source?.display_name ?? undefined,
      year: w.publication_year,
      doi,
      openalexId: id,
      url: landing ?? undefined,
      oaPdfUrl: oaPdf ?? undefined,
      abstract: reconstructAbstract(w.abstract_inverted_index),
      citations: w.cited_by_count,
      metadataSource: this.name,
    }
  }

  /** Build one OpenAlex URL for a planned query. */
  private buildUrl(query: string, pool: 'recent' | 'landmark', recentYears: number, limit: number): string {
    const q = encodeURIComponent(`"${query}"`)
    let filter = ''
    if (pool === 'recent') {
      const start = new Date().getUTCFullYear() - recentYears + 1
      const end = new Date().getUTCFullYear()
      filter = `&filter=publication_year:${start}-${end}`
    }
    // semantic search (official); landmark sorts by citation impact
    const sort = pool === 'landmark' ? '&sort=cited_by_count:desc' : ''
    return `${API}?search=${q}${filter}${sort}&per-page=${limit}`
  }

  async search(params: SearchParams): Promise<SearchHit[]> {
    const hits: SearchHit[] = []
    for (const q of params.queries) {
      if (this.rateLimited) break // circuit breaker: skip remaining queries quietly
      const url = this.buildUrl(q.text, params.pool, params.recentYears, params.limitPerQuery)
      let data: { results?: OpenAlexWork[] } | undefined
      try {
        data = (await this.getJson(url)) as { results?: OpenAlexWork[] }
      } catch (err) {
        if (this.rateLimited) break // already announced once; stay quiet
        console.warn(`[dsh-literature] openalex query "${q.text}" failed: ${String(err)}`)
        continue
      } finally {
        // polite pool: small gap between queries
        await new Promise((r) => setTimeout(r, 120))
      }
      for (const w of data?.results ?? []) {
        const paper = this.toRef(w)
        if (!paper) continue
        hits.push({ paper, query: q.text, retrievalScore: w.relevance_score })
      }
    }
    return hits
  }

  async expand(paper: PaperRef): Promise<Partial<PaperRef> | null> {
    if (this.rateLimited) return null
    if (!paper.doi && !paper.openalexId) return null
    const id = paper.openalexId ? `openalex:${paper.openalexId}` : `doi:${paper.doi}`
    const url = `${API}/${encodeURIComponent(id)}`
    const w = (await this.getJson(url)) as OpenAlexWork | undefined
    if (!w) return null
    const ref = this.toRef(w)
    return ref
      ? {
          venue: ref.venue,
          citations: ref.citations,
          abstract: ref.abstract,
          url: ref.url,
          year: ref.year,
          doi: ref.doi,
        }
      : null
  }

  async pdfCandidates(paper: PaperRef): Promise<PdfCandidate[]> {
    const out: PdfCandidate[] = []
    const push = (u: string | undefined): void => {
      if (u) out.push({ url: u, license: 'oa', source: this.name })
    }
    push(paper.oaPdfUrl)
    if (out.length === 0) {
      const ext = await this.expand(paper)
      push(ext?.oaPdfUrl)
    }
    return out
  }
}

/* ------------------------------------------------------------------ */
/* Lightweight rate-limit status check (official /rate-limit endpoint) */
/* ------------------------------------------------------------------ */

export interface OpenAlexRateLimitInfo {
  /** daily quota (requests) */
  dailyBudget: number | null
  /** requests used today */
  used: number | null
  /** requests remaining today */
  remaining: number | null
  /** ISO timestamp of the daily reset (when known) */
  resetTime: string | null
}

/**
 * Call the official rate-limit endpoint with the CURRENT key (or anonymous).
 * Only the quota numbers are returned — the API key never leaves the caller.
 * Field names vary across API versions; both `daily_*` and bare forms are
 * accepted.
 */
export async function fetchOpenAlexRateLimit(opts: {
  apiKey?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
} = {}): Promise<OpenAlexRateLimitInfo> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 15000
  const apiKey = opts.apiKey ?? process.env.OPENALEX_API_KEY
  let url = RATE_LIMIT_API
  if (apiKey) url += `?api_key=${encodeURIComponent(apiKey)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`OpenAlex /rate_limit HTTP ${res.status}`)
    const raw = (await res.json()) as Record<string, unknown>
    const num = (k: string): number | null => {
      const v = raw[k]
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    const str = (k: string): string | null => {
      const v = raw[k]
      return typeof v === 'string' && v.length > 0 ? v : null
    }
    return {
      dailyBudget: num('daily_budget') ?? num('budget'),
      used: num('daily_used') ?? num('used'),
      remaining: num('daily_remaining') ?? num('remaining'),
      resetTime: str('daily_reset_time') ?? str('reset_time'),
    }
  } finally {
    clearTimeout(timer)
  }
}
