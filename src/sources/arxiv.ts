/**
 * arXiv adapter: preprint metadata + open PDF.
 * Query style: field-combined `ti:"q" OR abs:"q"` plus robotics-related
 * categories as an auxiliary constraint (cs.RO / cs.LG / cs.AI / eess.SY /
 * math.OC); broad `all:` queries are NOT used. Recent pool constrains
 * submittedDate; landmark pool is year-unconstrained.
 */
import type { PaperRef, PdfCandidate, SearchHit, SearchParams, SourceAdapter } from './types.js'

const API = 'https://export.arxiv.org/api/query'
const CATS = 'cat:cs.RO OR cat:cs.LG OR cat:cs.AI OR cat:eess.SY OR cat:math.OC'

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

  private async getText(url: string): Promise<string> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/atom+xml' },
      })
      if (!res.ok) throw new Error(`arXiv API HTTP ${res.status}`)
      return await res.text()
    } finally {
      clearTimeout(timer)
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
    const hits: SearchHit[] = []
    for (const q of params.queries) {
      const searchQuery = this.buildQuery(q.text, params.pool, params.recentYears)
      const url = `${API}?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=${params.limitPerQuery}&sortBy=submittedDate&sortOrder=descending`
      let xml = ''
      try {
        xml = await this.getText(url)
      } catch (err) {
        console.warn(`[dsh-literature] arxiv query "${q.text}" failed: ${String(err)}`)
        continue
      }
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
