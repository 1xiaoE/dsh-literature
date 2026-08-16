/**
 * arXiv adapter: preprint metadata + open PDF (https://arxiv.org/pdf/<id>).
 * Uses the public arXiv API (Atom XML) and its export mirror.
 */
import type { PaperRef, PdfCandidate, SearchParams, SourceAdapter } from './types.js'
import { normalizeTitle } from './types.js'

const API = 'https://export.arxiv.org/api/query'

interface RawEntry {
  id: string
  title: string
  summary: string
  published: string
  authors: string[]
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

export class ArxivAdapter implements SourceAdapter {
  readonly name = 'arxiv'

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30000,
  ) {}

  private async getJson(url: string): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/atom+xml' } })
      if (!res.ok) throw new Error(`arXiv API HTTP ${res.status}`)
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  async search(params: SearchParams): Promise<PaperRef[]> {
    const query = `all:"${params.topic.replace(/["\\]/g, ' ')}" AND submittedDate:[${Math.min(...params.years)}0101 TO ${Math.max(...params.years)}1231]`
    const url = `${API}?search_query=${encodeURIComponent(query)}&start=0&max_results=${params.limit}&sortBy=submittedDate&sortOrder=descending`
    const res = await this.getJson(url)
    const xml = await res.text()
    return parseAtom(xml).map((e) => {
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
      } satisfies PaperRef
    })
  }

  async expand(paper: PaperRef): Promise<Partial<PaperRef> | null> {
    // arXiv metadata is complete at search time; nothing to expand.
    return null
  }

  async pdfCandidates(paper: PaperRef): Promise<PdfCandidate[]> {
    if (!paper.arxivId) return []
    return [{ url: `https://arxiv.org/pdf/${paper.arxivId}`, license: 'oa', source: this.name }]
  }
}

/** Keep the dedup helper exported for registry reuse. */
export { normalizeTitle }
