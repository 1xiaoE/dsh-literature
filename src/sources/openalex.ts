/**
 * OpenAlex adapter: metadata, citation counts, venue and OA locations.
 * API: https://api.openalex.org/works
 */
import type { PaperRef, PdfCandidate, SearchParams, SourceAdapter } from './types.js'

const API = 'https://api.openalex.org/works'

interface OpenAlexWork {
  id: string
  doi?: string
  title?: string
  display_name?: string
  publication_year?: number
  cited_by_count?: number
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

  private async getJson(url: string): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (this.mailto) headers['User-Agent'] = this.mailto
      const res = await this.fetchImpl(url, { signal: ctrl.signal, headers })
      if (!res.ok) throw new Error(`OpenAlex API HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async search(params: SearchParams): Promise<PaperRef[]> {
    const years = params.years.join('|')
    const url = `${API}?search=${encodeURIComponent(params.topic)}&filter=publication_year:${years}&per-page=${params.limit}&sort=cited_by_count:desc`
    const data = (await this.getJson(url)) as { results?: OpenAlexWork[] }
    return (data.results ?? []).map((w) => this.toRef(w)).filter((p): p is PaperRef => p !== null)
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
      // try expand for OA location
      const ext = await this.expand(paper)
      if (ext?.url) {
        out.push({ url: ext.url, license: 'oa', source: this.name })
      }
      return out
    }
    // heuristic: openalex urls that are pdfs or landing pages are OA
    out.push({ url: paper.url, license: 'oa', source: this.name })
    return out
  }
}
