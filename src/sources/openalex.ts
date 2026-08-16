/**
 * OpenAlex adapter: metadata, citation counts, venue, OA locations.
 * Query style: semantic `search=` (official capability) with
 * `filter=title_and_abstract.search:"q"` style constraints where useful;
 * multiple query results are merged by the registry. Captures the
 * source-provided `relevance_score` for retrieval provenance.
 * API: https://api.openalex.org/works
 */
import type { PaperRef, PdfCandidate, SearchHit, SearchParams, SourceAdapter } from './types.js'

const API = 'https://api.openalex.org/works'

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
  }
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null
  abstract_inverted_index?: Record<string, number[]> | null
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

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30000,
    private readonly mailto?: string,
  ) {}

  private async getJson(url: string, retries = 2): Promise<unknown> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      try {
        const headers: Record<string, string> = { accept: 'application/json' }
        if (this.mailto) headers['User-Agent'] = this.mailto
        const res = await this.fetchImpl(url, { signal: ctrl.signal, headers })
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`OpenAlex API HTTP ${res.status}`)
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
          continue
        }
        if (!res.ok) throw new Error(`OpenAlex API HTTP ${res.status}`)
        return await res.json()
      } catch (err) {
        lastErr = err
        if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
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
    const pdf = w.best_oa_location?.pdf_url ?? w.primary_location?.pdf_url ?? undefined
    return {
      id: `openalex:${id}`,
      title: title.trim(),
      authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
      venue: w.primary_location?.source?.display_name ?? undefined,
      year: w.publication_year,
      doi,
      openalexId: id,
      url: pdf ?? w.primary_location?.landing_page_url ?? undefined,
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
      const url = this.buildUrl(q.text, params.pool, params.recentYears, params.limitPerQuery)
      let data: { results?: OpenAlexWork[] } | undefined
      try {
        data = (await this.getJson(url)) as { results?: OpenAlexWork[] }
      } catch (err) {
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
    if (!paper.url) {
      const ext = await this.expand(paper)
      if (ext?.url) {
        out.push({ url: ext.url, license: 'oa', source: this.name })
      }
      return out
    }
    out.push({ url: paper.url, license: 'oa', source: this.name })
    return out
  }
}
