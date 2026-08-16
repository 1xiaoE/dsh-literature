/**
 * Unpaywall OA locator — NOT a search adapter. Only supplies legal OA PDF
 * candidates for papers with a DOI, using the Unpaywall API (which indexes
 * legal OA copies: repositories, author manuscripts, publisher OA).
 * API: https://api.unpaywall.org/v2/<doi>?email=<email>
 */
import type { PaperRef, PdfCandidate, SearchHit, SearchParams, SourceAdapter } from './types.js'

interface UnpaywallResponse {
  best_oa_location?: { url_for_pdf?: string | null; url?: string | null } | null
  oa_locations?: Array<{ url_for_pdf?: string | null; url?: string | null }> | null
}

export class UnpaywallAdapter implements SourceAdapter {
  readonly name = 'unpaywall'

  constructor(
    private readonly email: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30000,
  ) {}

  async search(_params: SearchParams): Promise<SearchHit[]> {
    // OA location only — never a candidate source
    return []
  }

  async expand(_paper: PaperRef): Promise<Partial<PaperRef> | null> {
    return null
  }

  async pdfCandidates(paper: PaperRef): Promise<PdfCandidate[]> {
    if (!paper.doi) return []
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(paper.doi)}?email=${encodeURIComponent(this.email)}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
      if (!res.ok) return []
      const data = (await res.json()) as UnpaywallResponse
      const out: PdfCandidate[] = []
      const seen = new Set<string>()
      const push = (u: string | null | undefined): void => {
        if (u && !seen.has(u)) {
          seen.add(u)
          out.push({ url: u, license: 'oa', source: this.name })
        }
      }
      push(data.best_oa_location?.url_for_pdf)
      push(data.best_oa_location?.url)
      for (const loc of data.oa_locations ?? []) {
        push(loc.url_for_pdf)
      }
      return out
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}
