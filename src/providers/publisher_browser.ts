/**
 * Generic Publisher Browser Provider — Direct Publisher Access.
 *
 * Replaces CARSI portal navigation as the non-OA acquisition path
 * (Quality First, Access Second):
 *
 *   1. resolve candidate URLs from the paper: DOI direct resolution first
 *      (https://doi.org/<doi> → publisher landing page), then the paper's own
 *      publisher URL;
 *   2. drive the dedicated persistent browser to the article page;
 *   3. capture PDF responses / downloads / explicit PDF links;
 *   4. on a login wall (login / sign in / institutional sign in / subscription
 *      required / authentication required) → AUTH_REQUIRED, NEVER blind
 *      auto-navigation; the user completes a legal login in a headed browser
 *      via bin/dsh-literature-browser-login and the push resumes;
 *   5. on explicit denial (403 / not entitled) → ACCESS_DENIED;
 *   6. otherwise PDF_NOT_FOUND.
 *
 * Responsibilities explicitly OUT of scope (by design):
 *   - paper retrieval / ranking / quality judgement
 *   - CARSI portal navigation / school selection / database resource browsing
 *   - auto-filling accounts, passwords, CAPTCHAs, or institutional credentials
 *
 * The provider uses the SAME independent persistent profile as the legacy
 * CARSI provider (~/dsh-literature/Data/browser-profile) and never
 * reads the user's daily browser cookies. Sessions are reused across pushes
 * until they expire (then AUTH_REQUIRED → HITL re-login).
 */
import { join } from 'node:path'
import type { PaperRef } from '../sources/types.js'
import type { PdfProvider, ProviderFetchOptions, ProviderResult } from './types.js'
import {
  BrowserLauncher,
  classifyLoginWall,
  launchPersistentBrowser,
  PageLike,
  PageResponseLike,
  probeBrowserAvailable,
  readLedger,
  resolveCandidateUrls,
  storePdf,
  validatePdfBuffer,
  writeLedger,
  type BrowserLike,
} from './browser_lib.js'

export const PUBLISHER_LEDGER_FILE = 'publisher_browser/session.json'

/**
 * Extract the publisher rate-limit domain for a paper. Prefers the paper's
 * own URL host when it points at a real publisher (not doi.org), else falls
 * back to the DOI prefix registry (10.1109 → ieeexplore.ieee.org etc.).
 * Returns null when no domain can be determined (no per-domain gate).
 */
const DOI_PREFIX_DOMAINS: Record<string, string> = {
  '10.1109': 'ieeexplore.ieee.org',
  '10.1080': 'tandfonline.com',
  '10.1007': 'springer.com',
  '10.1016': 'sciencedirect.com',
  '10.1038': 'nature.com',
  '10.1126': 'science.org',
  '10.1145': 'dl.acm.org',
  '10.1146': 'annualreviews.org',
  '10.2514': 'arc.aiaa.org',
  '10.1177': 'journals.sagepub.com',
  '10.1201': 'taylorfrancis.com',
}

export function publisherDomainOf(paper: PaperRef): string | null {
  if (paper.url) {
    try {
      const u = new URL(paper.url)
      if (u.hostname && u.hostname !== 'doi.org' && u.hostname !== 'dx.doi.org') {
        return u.hostname.replace(/^www\./, '')
      }
    } catch {
      /* fall through to DOI prefix */
    }
  }
  if (paper.doi) {
    const prefix = paper.doi.split('/')[0]?.toLowerCase()
    if (prefix && DOI_PREFIX_DOMAINS[prefix]) return DOI_PREFIX_DOMAINS[prefix]!
  }
  return null
}

export interface PublisherBrowserOptions {
  dataDir: string
  enabled: boolean
  /** minutes between publisher-browser attempts (strict low frequency) */
  minIntervalMinutes: number
  /** headless for cron pushes; the login CLI forces headed */
  headless: boolean
  /** per-attempt timeout (ms) */
  timeoutMs: number
  /** override for the persistent profile dir (default <dataDir>/browser-profile) */
  profileDir?: string
  userAgent?: string
  /** injectable launcher (defaults to playwright chromium; tests stub this) */
  launcher?: BrowserLauncher
}

/**
 * Setup response/download capture on a page BEFORE navigation so that
 * synchronous stub pages and real browsers alike record every PDF response.
 */
function attachPdfCapture(
  page: PageLike,
  captured: Array<{ res: PageResponseLike; url: string; status: number; ct: string }>,
  downloads: Array<{ path: string; name: string }>,
): void {
  page.on('response', (res) => {
    const ct = res.headers()['content-type'] ?? ''
    if (/application\/pdf|octet-stream/i.test(ct) || /\.pdf($|\?)/i.test(res.url())) {
      captured.push({ res, url: res.url(), status: res.status(), ct })
    }
  })
  page.on('download', (d) => {
    void d
      .path()
      .then((p) => downloads.push({ path: p, name: d.suggestedFilename() }))
      .catch(() => undefined)
  })
}

/**
 * Extract a PDF from the captured responses/downloads/links. Returns
 * ProviderResult on success; null when nothing usable (caller classifies).
 */
async function tryPagePdf(
  page: PageLike,
  captured: Array<{ res: PageResponseLike; url: string; status: number; ct: string }>,
  downloads: Array<{ path: string; name: string }>,
  opts: ProviderFetchOptions,
): Promise<ProviderResult | null> {
  // direct PDF response
  if (captured.length > 0) {
    const c = captured[0]!
    try {
      const buf = await c.res.body().catch(() => Buffer.alloc(0))
      const ok = validatePdfBuffer(buf, opts.minPdfBytes, c.ct)
      if (ok.ok) {
        const stored = storePdf(buf, opts.pdfsDir)
        if (stored) {
          return {
            outcome: 'PDF_OK',
            pdfPath: stored.path,
            sha256: stored.sha256,
            url: c.url,
            http: c.status,
            contentType: c.ct,
            bytes: buf.length,
          }
        }
        return { outcome: 'PDF_NOT_FOUND', url: c.url, reason: `存储失败: ${ok.reason}` }
      }
    } catch {
      /* fall through to page-level classification */
    }
  }

  // explicit download event
  if (downloads.length > 0) {
    try {
      const { readFileSync } = await import('node:fs')
      const buf = readFileSync(downloads[0]!.path)
      const ok = validatePdfBuffer(buf, opts.minPdfBytes)
      if (ok.ok) {
        const stored = storePdf(buf, opts.pdfsDir)
        if (stored) {
          return {
            outcome: 'PDF_OK',
            pdfPath: stored.path,
            sha256: stored.sha256,
            url: page.url(),
            contentType: 'application/pdf (download)',
            bytes: buf.length,
          }
        }
      }
    } catch {
      /* temp file gone → not found */
    }
  }

  // scan for a PDF link and follow it (bounded)
  const hrefs = await page.linkHrefs('a[href]').catch(() => [] as string[])
  const pdfHrefs = hrefs.filter(
    (h) => /\.pdf($|\?)/i.test(h) || /(?:download|stamp|retrieve|fulltext)/i.test(h),
  )
  for (const href of pdfHrefs.slice(0, 3)) {
    const abs = new URL(href, page.url()).toString()
    try {
      await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: Math.min(opts.timeoutMs, 30000) })
      await page.waitForTimeout(1500)
    } catch {
      continue
    }
    const hit = captured.find((x) => x.url === abs) ?? captured[captured.length - 1]
    if (hit) {
      try {
        const buf = await hit.res.body().catch(() => Buffer.alloc(0))
        const ok = validatePdfBuffer(buf, opts.minPdfBytes, hit.ct)
        if (ok.ok) {
          const stored = storePdf(buf, opts.pdfsDir)
          if (stored) {
            return {
              outcome: 'PDF_OK',
              pdfPath: stored.path,
              sha256: stored.sha256,
              url: abs,
              http: hit.status,
              contentType: hit.ct,
              bytes: buf.length,
            }
          }
        }
      } catch {
        continue
      }
    }
  }
  return null
}

export class PublisherBrowserProvider implements PdfProvider {
  readonly name = 'publisher_browser'
  readonly accessType = 'institutional' as const
  readonly isOpenAccess = false

  private readonly launcher?: BrowserLauncher

  constructor(private readonly opts: PublisherBrowserOptions) {
    this.launcher = opts.launcher
  }

  getProfileDir(): string {
    return this.opts.profileDir || join(this.opts.dataDir, 'browser-profile')
  }

  private ledgerFile(): string {
    return join(this.opts.dataDir, PUBLISHER_LEDGER_FILE)
  }

  /**
   * PdfProvider-interface compatible: the pipeline pre-check only verifies
   * the provider is enabled. The real rate limit is per-publisher-domain and
   * is enforced inside fetch() via shouldAttemptFor — so a previous IEEE
   * attempt never blocks a Springer paper, and a post-login --resume (which
   * clears the ledger) retries immediately.
   */
  shouldAttempt(_now: Date = new Date()): { ok: boolean; reason?: string } {
    if (!this.opts.enabled) return { ok: false, reason: 'publisher_browser 未启用' }
    return { ok: true }
  }

  /** Per-domain rate limit check (publisher host → last attempt timestamp). */
  shouldAttemptFor(domain: string, now: Date = new Date()): { ok: boolean; reason?: string } {
    if (!this.opts.enabled) return { ok: false, reason: 'publisher_browser 未启用' }
    const ledger = readLedger(this.ledgerFile())
    const intervalMs = this.opts.minIntervalMinutes * 60 * 1000
    const iso = (ledger.lastAttemptByDomain ?? {})[domain]
    if (!iso) return { ok: true }
    const last = new Date(iso).getTime()
    if (Number.isNaN(last)) return { ok: true }
    if (now.getTime() - last < intervalMs) {
      const until = new Date(last + intervalMs).toISOString()
      return {
        ok: false,
        reason: `publisher_browser 低频门（${domain}）：距上次尝试不足 ${this.opts.minIntervalMinutes} 分钟（最早可试 ${until}）`,
      }
    }
    return { ok: true }
  }

  /** PdfProvider-interface compatible: records a global attempt (no domain). */
  markAttempt(now: Date = new Date(), outcome?: string): void {
    this.markAttemptFor(undefined, now, outcome)
  }

  /** Record an attempt against a publisher domain (per-domain rate limit). */
  markAttemptFor(domain: string | undefined, now: Date = new Date(), outcome?: string): void {
    const ledger = readLedger(this.ledgerFile())
    const iso = now.toISOString()
    if (domain) {
      ledger.lastAttemptByDomain = { ...(ledger.lastAttemptByDomain ?? {}), [domain]: iso }
    }
    ledger.lastAttemptAt = iso
    ledger.attemptsCount = (ledger.attemptsCount ?? 0) + 1
    if (outcome) ledger.lastOutcome = outcome
    writeLedger(this.ledgerFile(), ledger)
  }

  markAuthenticated(now: Date = new Date()): void {
    const ledger = readLedger(this.ledgerFile())
    ledger.lastAuthAt = now.toISOString()
    ledger.lastOutcome = 'authenticated'
    // A manual re-login is a human action: clear EVERY rate-limit timestamp
    // (global + per-domain) so the user can immediately retry the same paper
    // via --resume without waiting out the automatic rate limit.
    delete ledger.lastAttemptAt
    delete ledger.lastAttemptByDomain
    writeLedger(this.ledgerFile(), ledger)
  }

  async sessionStatus(): Promise<{ available: boolean; profileDir: string } & Record<string, unknown>> {
    return {
      ...readLedger(this.ledgerFile()),
      profileDir: this.getProfileDir(),
      available: await probeBrowserAvailable(this.launcher),
    }
  }

  /** Resolve DOI / publisher URL → article page → PDF (or a terminal reason). */
  async fetch(paper: PaperRef, opts: ProviderFetchOptions): Promise<ProviderResult> {
    const started = new Date()
    const domain = publisherDomainOf(paper) ?? undefined
    // Environment faults (missing runtime / unresolvable identity) are NOT real
    // publisher attempts: never move the per-domain timestamp, otherwise a
    // broken playwright would make the domain wait out minIntervalMinutes.
    if (!(await probeBrowserAvailable(this.launcher))) {
      const reason = 'playwright/chromium 不可用（publisher_browser 未安装或已降级）'
      return { outcome: 'PDF_NOT_FOUND', reason }
    }
    const urls = resolveCandidateUrls(paper)
    if (urls.length === 0) {
      return { outcome: 'PDF_NOT_FOUND', reason: '无 DOI / publisher URL 可解析' }
    }
    // Per-domain rate limit: a recent attempt on the SAME publisher blocks,
    // but different publishers never block each other (IEEE ≠ Springer).
    // The user-facing login CLI calls markAuthenticated() which clears ALL
    // timestamps, so a post-login --resume retries immediately.
    if (domain) {
      const gate = this.shouldAttemptFor(domain, started)
      if (!gate.ok) {
        // A blocked retry is NOT an attempt: do not move the timestamp
        // forward, otherwise repeated retries create a sliding lockout.
        return {
          outcome: 'RATE_LIMITED',
          reason: `${gate.reason}（domain=${domain}）`,
        }
      }
    }

    let browser: BrowserLike | null = null
    try {
      browser = await this.launch()
      const failures: ProviderResult[] = []
      for (const url of urls) {
        const page = await browser.newPage()
        try {
          // attach capture BEFORE navigation so synchronous stub pages and
          // real browsers alike record every PDF response/download
          const captured: Array<{ res: PageResponseLike; url: string; status: number; ct: string }> = []
          const downloads: Array<{ path: string; name: string }> = []
          attachPdfCapture(page, captured, downloads)

          let mainStatus = 0
          try {
            const resp = await page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: opts.timeoutMs,
            })
            mainStatus = resp?.status() ?? 0
          } catch {
            mainStatus = 0
          }
          // allow JS redirects / SP session flows to settle (bounded)
          await page.waitForTimeout(2500)

          const got = await tryPagePdf(page, captured, downloads, opts)
          if (got) {
            this.markAttemptFor(domain, started, got.outcome)
            return got
          }

          // classify the failure from the CURRENT page state
          const html = await page.content().catch(() => '')
          const title = await page.title().catch(() => '')
          const currentHrefs = await page.linkHrefs('a[href]').catch(() => [] as string[])
          const hasPdfNow = currentHrefs.some(
            (h) => /\.pdf($|\?)/i.test(h) || /(?:download|stamp|retrieve|fulltext)/i.test(h),
          )
          const wall = classifyLoginWall({
            url: page.url(),
            http: mainStatus || undefined,
            title,
            html,
            hasPdfLink: hasPdfNow,
          })
          if (wall === 'auth') {
            const r: ProviderResult = {
              outcome: 'AUTH_REQUIRED',
              url: page.url(),
              http: mainStatus || undefined,
              reason:
                '出版社登录墙：需要合法登录/机构订阅。请运行 bin/dsh-literature-browser-login（headed 浏览器完成登录）后 --resume 继续；不得自动填写账号/密码/验证码。',
            }
            failures.push(r)
            this.markAttemptFor(domain, started, 'AUTH_REQUIRED')
            return r
          }
          if (wall === 'denied') {
            const r: ProviderResult = {
              outcome: 'ACCESS_DENIED',
              url: page.url(),
              http: mainStatus || undefined,
              reason: `出版社拒绝访问（HTTP ${mainStatus || '未知'}；可能为机构未订阅该资源）`,
            }
            failures.push(r)
            continue
          }
          const emptyish = html.length > 0 && html.length < 8000 && currentHrefs.length === 0
          failures.push({
            outcome: 'PDF_NOT_FOUND',
            url: page.url(),
            http: mainStatus || undefined,
            reason: emptyish
              ? '页面为空/疑似反爬挑战或 JS 未加载（非会话问题）。可在登录 CLI 的 headed 浏览器中手动完成该出版社访问'
              : '页面未提供可验证的 PDF（无 PDF 响应/下载/链接）',
          })
        } finally {
          await page.close().catch(() => undefined)
        }
      }

      const winner = strongestFailure(failures)
      this.markAttemptFor(domain, started, winner.outcome)
      return winner
    } finally {
      if (browser) await browser.close().catch(() => undefined)
    }
  }

  private async launch(): Promise<BrowserLike> {
    if (this.launcher) return this.launcher(this.getProfileDir(), {
      headless: this.opts.headless,
      userAgent: this.opts.userAgent,
    })
    return launchPersistentBrowser(this.getProfileDir(), {
      headless: this.opts.headless,
      userAgent: this.opts.userAgent,
    })
  }
}

/** Pick the most informative failure across candidates. */
function strongestFailure(results: ProviderResult[]): ProviderResult {
  if (results.length === 0) return { outcome: 'PDF_NOT_FOUND', reason: '无可用候选' }
  const rank: Record<string, number> = { AUTH_REQUIRED: 4, RATE_LIMITED: 3, ACCESS_DENIED: 2, PDF_NOT_FOUND: 1 }
  return [...results].sort((a, b) => (rank[b.outcome] ?? 0) - (rank[a.outcome] ?? 0))[0]!
}
