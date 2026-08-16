/**
 * Adapter registry: fans out planned queries to retrieval adapters
 * (arxiv + openalex; crossref is metadata-completion only), merges and
 * de-duplicates hits (DOI → arXiv id → OpenAlex id → normalized title,
 * with title-level cross-identifier merging), and collects per-hit
 * retrieval provenance. Business logic never touches concrete APIs.
 */
import type {
  PaperRef,
  PdfCandidate,
  PlannedQuery,
  SearchHit,
  SourceAdapter,
} from './types.js'
import { canonicalId, normalizeTitle } from './types.js'
import { ArxivAdapter } from './arxiv.js'
import { OpenAlexAdapter } from './openalex.js'
import { CrossrefAdapter } from './crossref.js'
import { UnpaywallAdapter } from './unpaywall.js'
import { landmarkEligibility, matchSeed } from '../lib/planner.js'
import { stageRelevanceHint } from '../lib/ranking.js'
import type { LiteratureConfig, StageDef } from '../config.js'

export interface RegistryOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  mailto?: string
  /** email required by the Unpaywall API (legal-OA locator) */
  unpaywallEmail?: string
  /** OpenAlex API key (from OPENALEX_API_KEY env by default); never logged */
  openalexApiKey?: string
}

export interface RetrievalProvenance {
  paperId: string
  query: string
  language: 'en'
  source: string
  retrievalScore: number | null
  pool: 'recent' | 'landmark'
  retrievedAt: string
  /** auth mode of the producing adapter ('anonymous' | 'api_key') */
  authMode?: 'anonymous' | 'api_key'
}

export interface PoolSearchResult {
  papers: PaperRef[]
  provenance: RetrievalProvenance[]
  /** how many raw hits (before dedup) each source produced */
  rawCount: number
}

function rankPaper(p: PaperRef): number {
  return (p.doi ? 3 : 0) + (p.citations !== undefined ? 2 : 0) + (p.abstract ? 1 : 0)
}

/** Strong dedup key: DOI → arXiv id → OpenAlex id. */
export function dedupKeyOf(p: PaperRef): string | undefined {
  if (p.doi) return `doi:${p.doi.toLowerCase()}`
  if (p.arxivId) return `arxiv:${p.arxivId.toLowerCase()}`
  if (p.openalexId) return `openalex:${p.openalexId.toLowerCase()}`
  return undefined
}

/** Fill missing fields from another record (identifier/venue/year/citations…). */
function combine(a: PaperRef, b: PaperRef): PaperRef {
  const out: PaperRef = { ...a }
  if (!out.doi && b.doi) out.doi = b.doi
  if (!out.arxivId && b.arxivId) out.arxivId = b.arxivId
  if (!out.openalexId && b.openalexId) out.openalexId = b.openalexId
  if (!out.venue && b.venue) out.venue = b.venue
  if (out.year === undefined && b.year !== undefined) out.year = b.year
  if (out.citations === undefined && b.citations !== undefined) out.citations = b.citations
  if (!out.abstract && b.abstract) out.abstract = b.abstract
  if (!out.url && b.url) out.url = b.url
  if (out.authors.length === 0 && b.authors.length > 0) out.authors = b.authors
  return out
}

/**
 * Two-pass dedup:
 * 1. strong identifiers (doi/arxiv/openalex);
 * 2. normalized title — records with the same title but different strong
 *    identifiers are merged (identifiers combined, richer metadata wins).
 */
export function mergePapers(papers: PaperRef[]): PaperRef[] {
  const byId = new Map<string, PaperRef>()
  for (const p of papers) {
    const k = dedupKeyOf(p)
    if (!k) continue
    const ex = byId.get(k)
    if (!ex || rankPaper(p) > rankPaper(ex)) byId.set(k, p)
  }
  const survivors = [...byId.values(), ...papers.filter((p) => !dedupKeyOf(p))]
  const byTitle = new Map<string, PaperRef[]>()
  for (const p of survivors) {
    const t = normalizeTitle(p.title)
    const list = byTitle.get(t) ?? []
    list.push(p)
    byTitle.set(t, list)
  }
  const out: PaperRef[] = []
  for (const list of byTitle.values()) {
    let rep = list[0]!
    for (const other of list.slice(1)) {
      rep = rankPaper(other) > rankPaper(rep) ? other : rep
      rep = combine(rep, other)
    }
    if (rep.id !== canonicalId(rep)) rep = { ...rep, id: canonicalId(rep) }
    out.push(rep)
  }
  return out
}

/** Whether two records refer to the same paper (identifier or title match). */
export function samePaper(a: PaperRef, b: PaperRef): boolean {
  const ka = dedupKeyOf(a)
  const kb = dedupKeyOf(b)
  if (ka && kb && ka === kb) return true
  return normalizeTitle(a.title) === normalizeTitle(b.title)
}

/**
 * Merge entries carrying pool labels; the 'recent' label wins when a paper
 * appears in both pools.
 */
export function mergeWithLabels(
  entries: Array<{ paper: PaperRef; pool: 'recent' | 'landmark' }>,
): Array<{ paper: PaperRef; pool: 'recent' | 'landmark' }> {
  const merged = mergePapers(entries.map((e) => e.paper))
  const out: Array<{ paper: PaperRef; pool: 'recent' | 'landmark' }> = []
  for (const m of merged) {
    let pool: 'recent' | 'landmark' = 'landmark'
    for (const e of entries) {
      if (samePaper(m, e.paper)) {
        if (e.pool === 'recent') pool = 'recent'
      }
    }
    out.push({ paper: m, pool })
  }
  return out
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

  /** Operational counters of one adapter (requests/dedup/429/…), for provenance. */
  adapterStats(name: string): Record<string, number> {
    const a = this.adapters.find((x) => x.name === name)
    return a?.stats ? (Object.fromEntries(Object.entries(a.stats())) as Record<string, number>) : {}
  }

  private retrievalAdapters(): SourceAdapter[] {
    // crossref search is not a relevance signal — exclude from candidate retrieval
    return this.adapters.filter((a) => a.name !== 'crossref')
  }

  /**
   * Search one pool (recent | landmark) with the planned queries across all
   * retrieval adapters; returns deduped papers + full provenance.
   */
  async searchPool(
    cfg: LiteratureConfig,
    queries: PlannedQuery[],
    stage: StageDef | undefined,
    pool: 'recent' | 'landmark',
  ): Promise<PoolSearchResult> {
    const params = {
      queries,
      pool,
      recentYears: cfg.retrieval.recentYears,
      limitPerQuery: cfg.retrieval.perQueryLimit,
    }
    const allHits: SearchHit[] = []
    let raw = 0

    for (const adapter of this.retrievalAdapters()) {
      for (const q of queries) {
        let hits: SearchHit[] = []
        try {
          hits = await adapter.search({ ...params, queries: [q] })
        } catch (err) {
          console.warn(`[dsh-literature] ${adapter.name} search failed: ${String(err)}`)
          continue
        }
        allHits.push(...hits.map((h) => ({ ...h, source: adapter.name, authMode: adapter.authMode })))
        raw += hits.length
      }
    }

    const papers = mergePapers(allHits.map((h) => h.paper))
    const provenance: RetrievalProvenance[] = []
    for (const hit of allHits) {
      const merged = papers.find((p) => samePaper(p, hit.paper))
      if (!merged) continue
      provenance.push({
        paperId: canonicalId(merged),
        query: hit.query,
        language: 'en',
        source: hit.source ?? 'unknown',
        retrievalScore: hit.retrievalScore ?? null,
        pool,
        retrievedAt: new Date().toISOString(),
        authMode: (hit as SearchHit & { authMode?: 'anonymous' | 'api_key' }).authMode,
      })
    }

    let result = papers
    if (pool === 'landmark' && stage) {
      // curated seeds are admitted unconditionally as anchors; others must
      // pass landmark eligibility; the pool stays capped
      const seeds: PaperRef[] = []
      const candidates: PaperRef[] = []
      for (const p of papers) {
        if (matchSeed(p, stage.landmarkSeeds)) seeds.push(p)
        else candidates.push(p)
      }
      const eligible = candidates
        .map((p) => {
          const sr = stageRelevanceHint(`${p.title} ${p.abstract ?? ''}`, stage)
          return {
            p,
            el: landmarkEligibility(
              {
                year: p.year,
                citations: p.citations,
                venue: p.venue,
                stageHint: sr.score,
                stageMatched: sr.matchedPreferred.length,
              },
              cfg,
            ),
          }
        })
        .filter((x) => x.el.eligible)
        .sort((a, b) => b.el.score - a.el.score)
        .map((x) => x.p)
      result = [...seeds, ...eligible].slice(0, cfg.retrieval.landmarkMaxCandidates)
      const allowed = new Set(result.map((p) => canonicalId(p)))
      // keep provenance only for admitted landmark papers
      for (let i = provenance.length - 1; i >= 0; i -= 1) {
        if (!allowed.has(provenance[i]!.paperId)) provenance.splice(i, 1)
      }
    }

    return { papers: result, provenance, rawCount: raw }
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

/** Build the registry with the shipped adapters, in fetch-chain order:
 * arxiv → openalex (OA location) → unpaywall → crossref (publisher links),
 * i.e. public/OA sources strictly before publisher links; institutional
 * providers (CARSI) are appended by the fetch pipeline only after ALL of
 * these have failed. */
export function createRegistry(opts: RegistryOptions = {}): SourceRegistry {
  const registry = new SourceRegistry(opts)
  registry.register(new ArxivAdapter(opts.fetchImpl, opts.timeoutMs))
  registry.register(new OpenAlexAdapter(opts.fetchImpl, opts.timeoutMs, opts.mailto, opts.openalexApiKey))
  registry.register(
    new UnpaywallAdapter(opts.unpaywallEmail ?? 'dsh-literature@example.org', opts.fetchImpl, opts.timeoutMs),
  )
  registry.register(new CrossrefAdapter(opts.fetchImpl, opts.timeoutMs))
  return registry
}
