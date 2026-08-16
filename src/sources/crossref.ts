/**
 * Crossref adapter: DOI metadata fallback (bibliographic + citation signal).
 * API: https://api.crossref.org/works
 */
import type { PaperRef, PdfCandidate, SearchParams, SourceAdapter } from './types.js'

const API = 'https://api.crossref.org/works'

interface CrossrefWork {
  DOI?: string
  title?: string[]
  author?: Array<{ family?: string; given?: string }>
  'container-title'?: string[]
  issued?: { 'date-parts'?: number[][] }
  'is-referenced-by-count'?: number
  abstract?: string
  URL?: string
  link?: Array<{ URL?: string; 'content-type'?: string }>
}

export class CrossrefAdapter implements SourceAdapter {
  readonly name = 'crossref'

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30000,
  ) {}

  private async getJson(url: string): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/json', 'User-Agent': 'dsh-literature/0.1 (mailto:literature@example.org)' },
      })
      if (!res.ok) throw new Error(`Crossref API HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async search(params: SearchParams): Promise<PaperRef[]> {
    const minYear = Math.min(...params.years)
    const maxYear = Math.max(...params.years)
    const filter = `from-pub-date:${minYear}-01-01,until-pub-date:${maxYear}-12-31`
    const url = `${API}?query.bibliographic=${encodeURIComponent(params.topic)}&filter=${filter}&rows=${params.limit}&select=DOI,title,author,container-title,issued,is-referenced-by-count,abstract,URL,link`
    const data = (await this.getJson(url)) as { message?: { items?: CrossrefWork[] } }
    return (data.message?.items ?? []).map((w) => this.toRef(w)).filter((p): p is PaperRef => p !== null)
  }

  private toRef(w: CrossrefWork): PaperRef | null {
    const title = w.title?.[0]
    const doi = w.DOI
    if (!title || !doi) return null
    const year = w.issued?.['date-parts']?.[0]?.[0]
    return {
      id: `doi:${doi}`,
      title: title.trim(),
      authors: (w.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')),
      venue: w['container-title']?.[0],
      year,
      doi,
      url: w.URL ?? `https://doi.org/${doi}`,
      abstract: w.abstract?.replace(/<[^>]+>/g, ' ').trim(),
      citations: w['is-referenced-by-count'],
      metadataSource: this.name,
    }
  }

  async expand(paper: PaperRef): Promise<Partial<PaperRef> | null> {
    if (!paper.doi) return null
    const w = (await this.getJson(`${API}/${encodeURIComponent(paper.doi)}`)) as
      | { message?: CrossrefWork }
      | undefined
    if (!w?.message) return null
    const ref = this.toRef(w.message)
    return ref
      ? {
          venue: ref.venue,
          citations: ref.citations,
          abstract: ref.abstract,
          url: ref.url,
          year: ref.year,
        }
      : null
  }

  async pdfCandidates(paper: PaperRef): Promise<PdfCandidate[]> {
    if (!paper.doi) return []
    const w = (await this.getJson(`${API}/${encodeURIComponent(paper.doi)}`)) as
      | { message?: CrossrefWork }
      | undefined
    const links = w?.message?.link ?? []
    return links
      .filter((l) => l.URL && (l['content-type'] === 'application/pdf' || l['content-type'] === 'unspecified'))
      .map((l) => ({ url: l.URL as string, license: 'publisher' as const, source: this.name }))
  }
}
