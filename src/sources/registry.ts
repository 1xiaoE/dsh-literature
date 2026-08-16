/**
 * Adapter registry: registers adapters, fans out searches in parallel,
 * merges and de-duplicates results, and exposes per-paper PDF candidates.
 * Business logic never touches concrete APIs directly.
 */
import type { PaperRef, PdfCandidate, SearchParams, SourceAdapter } from './types.js'
import { canonicalId, normalizeTitle } from './types.js'
import { ArxivAdapter } from './arxiv.js'
import { OpenAlexAdapter } from './openalex.js'
import { CrossrefAdapter } from './crossref.js'

export interface RegistryOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  mailto?: string
}

export class SourceRegistry {
  private readonly adapters: SourceAdapter[] = []

  constructor(private readonly opts: RegistryOptions = {}) {}

  register(adapter: SourceAdapter): void {
    this.adapters.push(adapter)
  }

  get names(): string[] {
    return this.adapters.map((a) => a.name)
  }

  /**
   * Search all adapters in parallel, merge by canonical id and normalized
   * title. Richer records (with doi/citations/oa) win over thinner ones.
   */
  async search(params: SearchParams): Promise<PaperRef[]> {
    const results = await Promise.all(
      this.adapters.map((a) =>
        a.search(params).catch((err: unknown) => {
          // one adapter failing must not kill the whole search
          console.warn(`[dsh-literature] adapter ${a.name} search failed: ${String(err)}`)
          return [] as PaperRef[]
        }),
      ),
    )
    const byId = new Map<string, PaperRef>()
    const rank = (p: PaperRef): number =>
      (p.doi ? 3 : 0) + (p.citations !== undefined ? 2 : 0) + (p.abstract ? 1 : 0)

    for (const list of results) {
      for (const paper of list) {
        const id = canonicalId(paper)
        const existing = byId.get(id)
        if (!existing || rank(paper) > rank(existing)) {
          byId.set(id, paper)
        }
      }
    }
    return [...byId.values()]
  }

  /** Enrich a paper with any adapter that can (citations/venue/OA location). */
  async expand(paper: PaperRef): Promise<PaperRef> {
    let merged: PaperRef = paper
    for (const a of this.adapters) {
      const ext = await a.expand(merged).catch(() => null)
      if (ext) merged = { ...merged, ...ext }
    }
    return merged
  }

  /** All legal PDF candidates across adapters, deduplicated by URL. */
  async pdfCandidates(paper: PaperRef): Promise<PdfCandidate[]> {
    const lists = await Promise.all(
      this.adapters.map((a) => a.pdfCandidates(paper).catch(() => [] as PdfCandidate[])),
    )
    const seen = new Set<string>()
    const out: PdfCandidate[] = []
    for (const list of lists) {
      for (const c of list) {
        if (!seen.has(c.url)) {
          seen.add(c.url)
          out.push(c)
        }
      }
    }
    return out
  }
}

/** Build the V0.1 registry with the three shipped adapters. */
export function createRegistry(opts: RegistryOptions = {}): SourceRegistry {
  const registry = new SourceRegistry(opts)
  registry.register(new ArxivAdapter(opts.fetchImpl, opts.timeoutMs))
  registry.register(new OpenAlexAdapter(opts.fetchImpl, opts.timeoutMs, opts.mailto))
  registry.register(new CrossrefAdapter(opts.fetchImpl, opts.timeoutMs))
  return registry
}
