/**
 * Unified Source Adapter interface. Business logic never calls a specific
 * API directly — it goes through SourceAdapter + registry. V0.1 ships
 * arxiv, openalex, crossref; semantic-scholar and others can implement the
 * same interface later.
 */

export interface SearchParams {
  topic: string
  /** preferred publication years */
  years: number[]
  limit: number
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
  search(params: SearchParams): Promise<PaperRef[]>
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
