/**
 * arXiv adapter: preprint metadata + open PDF.
 * Query style: field-combined `ti:"q" OR abs:"q"` plus robotics-related
 * categories as an auxiliary constraint (cs.RO / cs.LG / cs.AI / eess.SY /
 * math.OC); broad `all:` queries are NOT used. Recent pool constrains
 * submittedDate; landmark pool is year-unconstrained.
 *
 * Request scheduling (arXiv official guidance: ≥ ~3s between API calls):
 * - a single adapter-level SERIAL scheduler gates every HTTP request: the
 *   start times of any two arXiv API requests are at least 3.1s apart, and
 *   queries are never sent concurrently;
 * - request-level dedup: identical normalized search queries (query text +
 *   pool filters) are fetched at most once per adapter instance and reused
 *   (RecentPool/LandmarkPool often produce identical HTTP queries);
 * - HTTP 429: honor Retry-After when present, otherwise wait ≥6s; retry at
 *   most ONCE; a second 429 trips a run-level breaker (RATE_LIMITED) that
 *   stops all remaining arXiv requests — OpenAlex/Crossref etc. are
 *   unaffected (the breaker lives inside this adapter);
 * - timings are injectable (now/sleep) so tests never wait in real time.
 */
import type { PaperRef, PdfCandidate, SearchHit, SearchParams, SourceAdapter } from './types.js'

const API = 'https://export.arxiv.org/api/query'
const CATS = 'cat:cs.RO OR cat:cs.LG OR cat:cs.AI OR cat:eess.SY OR cat:math.OC'
/** arXiv guidance: ≥ ~3s between consecutive API calls (we use 3.1s). */
export const ARXIV_MIN_INTERVAL_MS = 3100
/** fallback 429 retry delay when no Retry-After header is present */
export const ARXIV_429_RETRY_MS = 6000

interface RawEntry {
  id: string
  title: string
  summary: string
  published: string
  authors: string[]
}

export interface ArxivStats {
  /** actual HTTP requests sent */
  requests: number
  /** identical-query cache hits (no HTTP request issued) */
  dedupHits: number
  /** HTTP 429 responses seen */
  '429Count': number
  /** retries performed after 429 */
  retryCount: number
  /** breaker tripped (1) or not (0) */
  rateLimited: 0 | 1
  /** total ms slept by the scheduler + 429 backoff */
  waitMs: number
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
  return m ? decodeXmlEntities(m[1] ?? '').trim() : ''
}

function extractAll(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g')
  for (const m of xml.matchAll(re)) out.push(decodeXmlEntities(m[1] ?? '').trim())
  return out
}

function parseAtom(xml: string): RawEntry[] {
  const entries: RawEntry[] = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  for (const m of xml.matchAll(entryRe)) {
    const body = m[1] ?? ''
    const idUrl = extractTag(body, 'id')
    entries.push({
      id: idUrl,
      title: extractTag(body, 'title'),
      summary: extractTag(body, 'summary'),
      published: extractTag(body, 'published'),
      authors: extractAll(body, 'name'),
    })
  }
  return entries
}

function arxivIdFromUrl(url: string): string | undefined {
  // https://arxiv.org/abs/2312.12345v1 -> 2312.12345
  const m = url.match(/arxiv\.org\/(?:abs|pdf)\/([^v/]+)(?:v\d+)?/)
  return m?.[1]
}

/** Read a Retry-After header: integer seconds, or null when absent/invalid. */
function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('retry-after')
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export interface ArxivAdapterOptions {
  /** injectable clock (defaults to Date.now) */
  now?: () => number
  /** injectable sleep (defaults to setTimeout) — tests use fake timers */
  sleep?: (ms: number) => Promise<void>
}

export class ArxivAdapter implements SourceAdapter {
  readonly name = 'arxiv'

  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** serial scheduler: every HTTP request waits for the previous slot */
  private chain: Promise<void> = Promise.resolve()
  private lastRequestStart = 0
  /** request-level dedup: normalized search_query → result */
  private readonly cache = new Map<string, Promise<string | null>>()
  private rateLimited = false
  private readonly counters: ArxivStats = { requests: 0, dedupHits: 0, '429Count': 0, retryCount: 0, rateLimited: 0, waitMs: 0 }
  private warned429 = false

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30000,
    opts: ArxivAdapterOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** Snapshot of the scheduling/429 counters (provenance, never a key). */
  stats(): Record<string, number> {
    return { ...this.counters } as unknown as Record<string, number>
  }

  /**
   * Serial slot: guarantees real HTTP request start times are ≥ 3.1s apart,
   * even for concurrent search() calls (promise chain = true serialization).
   */
  private schedule(): Promise<void> {
    const run = this.chain.then(async () => {
      const nowMs = this.now()
      const wait = this.lastRequestStart + ARXIV_MIN_INTERVAL_MS - nowMs
      if (wait > 0) {
        this.counters.waitMs += wait
        await this.sleep(wait)
      }
      this.lastRequestStart = this.now()
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  private async doRequest(url: string): Promise<string | null> {
    await this.schedule()
    this.counters.requests += 1
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/atom+xml' },
      })
      if (res.status === 429) {
        this.counters['429Count'] += 1
        const retryAfter = retryAfterSeconds(res.headers)
        const delay = retryAfter !== null ? retryAfter * 1000 : ARXIV_429_RETRY_MS
        this.counters.retryCount += 1
        this.counters.waitMs += delay
        if (!this.warned429) {
          console.warn(`[dsh-literature] arXiv HTTP 429: retrying once after ${delay}ms`)
          this.warned429 = true
        }
        await this.sleep(delay)
        // second attempt — scheduler keeps the 3.1s gap automatically
        this.counters.requests += 1
        const res2 = await this.fetchImpl(url, {
          signal: ctrl.signal,
          headers: { accept: 'application/atom+xml' },
        })
        if (res2.status === 429) {
          // breaker: stop hammering arXiv for the rest of this run
          this.rateLimited = true
          this.counters.rateLimited = 1
          console.warn('[dsh-literature] arXiv RATE_LIMITED: stopping remaining arXiv requests for this run')
          return null
        }
        if (!res2.ok) throw new Error(`arXiv API HTTP ${res2.status}`)
        return await res2.text()
      }
      if (!res.ok) throw new Error(`arXiv API HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      // network/timeout errors: no retry (finite by construction); the query
      // fails and the caller moves on — never an infinite loop
      console.warn(`[dsh-literature] arxiv request failed: ${String(err)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** Request with dedup: identical normalized queries are fetched once. */
  private async getText(url: string, dedupKey: string): Promise<string | null> {
    if (this.rateLimited) return null
    const cached = this.cache.get(dedupKey)
    if (cached) {
      this.counters.dedupHits += 1
      return cached
    }
    const p = this.doRequest(url)
    this.cache.set(dedupKey, p)
    try {
      return await p
    } catch (err) {
      this.cache.delete(dedupKey) // failed responses may be retried later
      throw err
    }
  }

  private toRef(e: RawEntry): PaperRef {
    const arxivId = arxivIdFromUrl(e.id)
    const year = Number.parseInt(e.published.slice(0, 4), 10)
    return {
      id: `arxiv:${arxivId ?? ''}`,
      title: e.title.replace(/\s+/g, ' ').trim(),
      authors: e.authors,
      year: Number.isFinite(year) ? year : undefined,
      arxivId,
      url: `https://arxiv.org/abs/${arxivId}`,
      abstract: e.summary.replace(/\s+/g, ' ').trim(),
      metadataSource: this.name,
    }
  }

  /** Build one arXiv search_query for a planned query (title/abstract + cats). */
  private buildQuery(query: string, pool: 'recent' | 'landmark', recentYears: number): string {
    const terms = query
      .split(/\s+/)
      .map((t) => `"${t.replace(/"/g, '')}"`)
      .join(' AND ')
    const fieldQuery = `(ti:${terms} OR abs:${terms})`
    let dateClause = ''
    if (pool === 'recent') {
      const start = `${new Date().getUTCFullYear() - recentYears + 1}0101`
      const end = `${new Date().getUTCFullYear()}1231`
      dateClause = ` AND submittedDate:[${start} TO ${end}]`
    }
    return `${fieldQuery} AND (${CATS})${dateClause}`
  }

  async search(params: SearchParams): Promise<SearchHit[]> {
    if (this.rateLimited) return [] // breaker: skip quietly
    const hits: SearchHit[] = []
    for (const q of params.queries) {
      if (this.rateLimited) break
      const searchQuery = this.buildQuery(q.text, params.pool, params.recentYears)
      const url = `${API}?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=${params.limitPerQuery}&sortBy=submittedDate&sortOrder=descending`
      const xml = await this.getText(url, searchQuery)
      if (xml === null) continue
      for (const e of parseAtom(xml)) {
        hits.push({ paper: this.toRef(e), query: q.text })
      }
    }
    return hits
  }

  async expand(paper: PaperRef): Promise<Partial<PaperRef> | null> {
    return null
  }

  async pdfCandidates(paper: PaperRef): Promise<PdfCandidate[]> {
    if (!paper.arxivId) return []
    return [{ url: `https://arxiv.org/pdf/${paper.arxivId}`, license: 'oa', source: this.name }]
  }
}
