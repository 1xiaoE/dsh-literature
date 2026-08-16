/**
 * Unified Source Adapter interface. Business logic never calls a specific
 * API directly — it goes through SourceAdapter + registry. V0.2 ships
 * arxiv + openalex as retrieval sources; crossref is metadata-completion
 * only (its search results are NOT a domain-relevance signal).
 */

export interface PlannedQuery {
  text: string
  language: 'en'
  kind: 'canonical' | 'secondary' | 'stage'
  pool: 'recent' | 'landmark'
}

export interface SearchParams {
  /** all planned queries for this (topic, stage, pool) */
  queries: PlannedQuery[]
  /** which pool this search serves */
  pool: 'recent' | 'landmark'
  /** recent pool window in years (landmark ignores years) */
  recentYears: number
  /** per (source, query) result limit */
  limitPerQuery: number
}

/** One retrieval hit: the paper plus provenance of how it was found. */
export interface SearchHit {
  paper: PaperRef
  /** the generated query that produced this hit */
  query: string
  /** source-provided relevance signal when available (e.g. OpenAlex relevance_score) */
  retrievalScore?: number
  /** adapter that produced this hit (filled by the registry) */
  source?: string
}

/** A paper record as returned by an adapter (pre-persistence). */
export interface PaperRef {
  /** canonical id: 'arxiv:XXXX' | 'doi:10.xxx' | 'openalex:W...' */
  id: string
  title: string
  authors: string[]
  venue?: string
  year?: number
  doi?: string
  arxivId?: string
  openalexId?: string
  url?: string
  abstract?: string
  citations?: number
  /** provenance: adapter name that produced this record */
  metadataSource: string
}

export type PdfLicense = 'oa' | 'author' | 'publisher'

export interface PdfCandidate {
  url: string
  license: PdfLicense
  /** adapter name (provenance) */
  source: string
}

export interface SourceAdapter {
  readonly name: string
  /** retrieve candidates for the planned queries (source-specific query style) */
  search(params: SearchParams): Promise<SearchHit[]>
  /** enrich a paper with metadata this adapter can supply (doi, citations, OA location) */
  expand(paper: PaperRef): Promise<Partial<PaperRef> | null>
  /** legal PDF candidates for a paper */
  pdfCandidates(paper: PaperRef): Promise<PdfCandidate[]>
}

/** Normalize a title for dedup comparison. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Build a canonical paper id preferring DOI, then arXiv, then OpenAlex. */
export function canonicalId(paper: Pick<PaperRef, 'doi' | 'arxivId' | 'openalexId' | 'url'>): string {
  if (paper.doi) return `doi:${paper.doi}`
  if (paper.arxivId) return `arxiv:${paper.arxivId}`
  if (paper.openalexId) return `openalex:${paper.openalexId}`
  if (paper.url) return `url:${paper.url}`
  return `unknown:${Math.random().toString(36).slice(2)}`
}
