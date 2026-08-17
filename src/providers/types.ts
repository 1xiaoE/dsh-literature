/**
 * PdfProvider layer: institutional / licensed full-text access providers
 * that are NOT open-access sources. The generic fetch pipeline (fetch/pdf.ts)
 * knows only this interface — provider-specific logic (browser driving,
 * session management, login-wall detection) lives inside the provider, never
 * scattered in the pipeline.
 *
 * Provenance contract (per provider):
 * - name:         stable source id, e.g. 'carsi'
 * - accessType:   'institutional' for licensed access (never 'oa')
 * - isOpenAccess: must be false for institutional providers
 */
import type { PaperRef } from '../sources/types.js'

/** Terminal outcomes of one provider attempt (per requirement 6). */
export type ProviderOutcome = 'PDF_OK' | 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'ACCESS_DENIED' | 'PDF_NOT_FOUND'

export interface ProviderFetchOptions {
  /** directory to store downloaded PDFs as pdfs/<sha256>.pdf */
  pdfsDir: string
  /** per-attempt timeout (ms) */
  timeoutMs: number
  /** minimum bytes for a plausible PDF */
  minPdfBytes: number
}

export interface ProviderResult {
  outcome: ProviderOutcome
  /** absolute path of the stored PDF (PDF_OK only) */
  pdfPath?: string
  sha256?: string
  /** winning URL (publisher/portal landing or PDF URL) */
  url?: string
  /** HTTP status of the successful/failed document response, when known */
  http?: number
  /** response Content-Type of the successful download, when known */
  contentType?: string
  /** size of the downloaded document in bytes */
  bytes?: number
  /** human-readable reason (for attempt trails / user prompts) */
  reason?: string
}

export interface PdfProvider {
  readonly name: string
  readonly accessType: 'oa' | 'institutional'
  readonly isOpenAccess: boolean

  /**
   * Attempt to obtain a legal PDF for the paper. Providers are invoked ONLY
   * after every public/open-access candidate has failed, and only for papers
   * that already passed the ranking quality gates (enforced by the tools).
   */
  fetch(paper: PaperRef, opts: ProviderFetchOptions): Promise<ProviderResult>

  /**
   * Frequency gate (requirement 7: strict low frequency, no batch scraping).
   * The pipeline consults this before every invocation; when it returns false
   * the attempt is skipped and the reason is recorded.
   */
  shouldAttempt(now?: Date): { ok: boolean; reason?: string }

  /** Record that an attempt happened (updates the frequency ledger). */
  markAttempt(now?: Date): void

  /** Clear the auth-required state after a successful manual re-login. */
  markAuthenticated(now?: Date): void
}
