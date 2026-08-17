/**
 * CARSI (China Academic Research System Infrastructure, 中国教育和科研计算机网
 * 联邦认证与资源共享基础设施) institutional-access provider.
 *
 * LEGACY / EXPERIMENTAL — DISABLED BY DEFAULT. The CARSI portal
 * auto-navigation workflow is no longer part of the normal acquisition chain;
 * the generic publisher-browser provider (providers/publisher_browser.ts) is
 * the non-OA acquisition path. This file is kept for history and tests only;
 * normal pushes never invoke CARSI unless explicitly re-enabled via
 * config.carsi.enabled.
 *
 * Responsibilities (all CARSI specifics live HERE, never in fetch/pdf.ts):
 * - independent persistent browser profile (REQUIRED by spec: never touches
 *   the user's daily browser profile / cookie DB);
 * - manual first-time login + re-login via a headed browser (login CLI);
 * - session probing: a login wall after the profile exists is reported as
 *   AUTH_REQUIRED (never misreported as FULLTEXT_UNAVAILABLE);
 * - strict low-frequency gating (interval + per-call ledgers);
 * - download validation: HTTP status, Content-Type, %PDF- magic, non-HTML,
 *   minimum size, sha256 (requirement 5).
 *
 * Shared browser-driving infrastructure (PageLike/BrowserLike/launcher,
 * validatePdfBuffer, classifyLoginWall, resolveCandidateUrls, ledger) is
 * re-exported from providers/browser_lib.ts — see that module.
 *
 * The provider is optional by construction: playwright is loaded lazily and
 * missing chromium/playwright degrades to PDF_NOT_FOUND with a clear reason.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PaperRef } from '../sources/types.js'
import type { PdfProvider, ProviderFetchOptions, ProviderResult } from './types.js'
import {
  classifyLoginWall,
  launchPersistentBrowser,
  resolveCandidateUrls,
  validatePdfBuffer,
  type BrowserLauncher,
  type BrowserLike,
  type PageLike,
  type PageResponseLike,
} from './browser_lib.js'

export const CARSI_PORTAL_URL = 'https://ds.carsi.edu.cn/resource/resource.php'
export const DEFAULT_PROFILE_DIR_NAME = 'browser-profile'

/* ------------------------------------------------------------------ */
/* Shared browser-driving infrastructure (see browser_lib.ts)          */
/* ------------------------------------------------------------------ */

export {
  BrowserLauncher,
  BrowserLike,
  PageDownloadLike,
  PageLike,
  PageResponseLike,
  classifyLoginWall,
  launchPersistentBrowser,
  resolveCandidateUrls,
  validatePdfBuffer,
} from './browser_lib.js'

/* ------------------------------------------------------------------ */
/* CARSI session ledger (CARSI-specific path under the data dir)       */
/* ------------------------------------------------------------------ */

export interface CarsiLedger {
  /** last CARSI browser attempt (ISO) */
  lastAttemptAt?: string
  /** last provider outcome (ProviderOutcome or 'skipped') */
  lastOutcome?: string
  /** last successful manual authentication (ISO) */
  lastAuthAt?: string
  attemptsCount: number
}

export function ledgerPath(dataDir: string): string {
  return join(dataDir, 'carsi', 'session.json')
}

export function readLedger(dataDir: string): CarsiLedger {
  try {
    const raw = readFileSync(ledgerPath(dataDir), 'utf8')
    const v = JSON.parse(raw) as Partial<CarsiLedger>
    return { attemptsCount: v.attemptsCount ?? 0, ...v }
  } catch {
    return { attemptsCount: 0 }
  }
}

export function writeLedger(dataDir: string, ledger: CarsiLedger): void {
  const dir = join(dataDir, 'carsi')
  mkdirSync(dir, { recursive: true })
  const tmp = `${ledgerPath(dataDir)}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger, null, 2))
  renameSync(tmp, ledgerPath(dataDir))
}

/* ------------------------------------------------------------------ */
/* CarsiPdfProvider                                                    */
/* ------------------------------------------------------------------ */

export interface CarsiProviderOptions {
  dataDir: string
  enabled: boolean
  /** minutes between CARSI browser attempts (strict low frequency) */
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

export class CarsiPdfProvider implements PdfProvider {
  readonly name = 'carsi'
  readonly accessType = 'institutional' as const
  readonly isOpenAccess = false

  private readonly profileDir: string
  private readonly launcher: BrowserLauncher | null

  constructor(private readonly opts: CarsiProviderOptions) {
    this.profileDir = opts.profileDir ?? join(opts.dataDir, DEFAULT_PROFILE_DIR_NAME)
    this.launcher = opts.launcher ?? null
  }

  /** Persistent browser profile directory — never a user's daily profile. */
  getProfileDir(): string {
    return this.profileDir
  }

  /** Whether the browser runtime is usable (lazy playwright dynamic import). */
  async probeAvailable(): Promise<boolean> {
    if (this.launcher) return true
    try {
      const pw = await import('playwright')
      return existsSync(pw.chromium.executablePath())
    } catch {
      return false
    }
  }

  shouldAttempt(now: Date = new Date()): { ok: boolean; reason?: string } {
    if (!this.opts.enabled) return { ok: false, reason: 'CARSI 未启用（carsi.enabled=false）' }
    const ledger = readLedger(this.opts.dataDir)
    if (!ledger.lastAttemptAt) return { ok: true }
    const last = new Date(ledger.lastAttemptAt).getTime()
    if (Number.isNaN(last)) return { ok: true }
    const intervalMs = this.opts.minIntervalMinutes * 60 * 1000
    if (now.getTime() - last < intervalMs) {
      const until = new Date(last + intervalMs).toISOString()
      return {
        ok: false,
        reason: `CARSI 低频门：距上次尝试不足 ${this.opts.minIntervalMinutes} 分钟（最早可试 ${until}）`,
      }
    }
    return { ok: true }
  }

  markAttempt(now: Date = new Date(), outcome?: string): void {
    const ledger = readLedger(this.opts.dataDir)
    ledger.lastAttemptAt = now.toISOString()
    ledger.attemptsCount = (ledger.attemptsCount ?? 0) + 1
    if (outcome) ledger.lastOutcome = outcome
    writeLedger(this.opts.dataDir, ledger)
  }

  markAuthenticated(now: Date = new Date()): void {
    const ledger = readLedger(this.opts.dataDir)
    ledger.lastAuthAt = now.toISOString()
    ledger.lastOutcome = 'authenticated'
    // a manual re-login is a human action: reset the interval gate so the
    // user can immediately retry (frequency protection remains for automated
    // attempts — AUTH_REQUIRED never causes a permanent block)
    delete ledger.lastAttemptAt
    writeLedger(this.opts.dataDir, ledger)
  }

  /** Current session/auth status for the login CLI and tool prompts. */
  async sessionStatus(): Promise<CarsiLedger & { profileDir: string; available: boolean }> {
    return { ...readLedger(this.opts.dataDir), profileDir: this.profileDir, available: await this.probeAvailable() }
  }

  /**
   * Fetch a paper's PDF through the institutional session.
   * Order: DOI-resolved publisher URL → publisher landing URL → title-based
   * CARSI portal search (best effort). Never invoked before the public
   * open-access chain has failed (enforced by the pipeline).
   */
  async fetch(paper: PaperRef, opts: ProviderFetchOptions): Promise<ProviderResult> {
    const started = new Date()
    if (!(await this.probeAvailable())) {
      const reason = 'playwright/chromium 不可用（CARSI provider 未安装或已降级）'
      this.markAttempt(started, 'PDF_NOT_FOUND')
      return { outcome: 'PDF_NOT_FOUND', reason }
    }
    const urls = resolveCandidateUrls(paper)
    if (urls.length === 0 && !paper.title) {
      this.markAttempt(started, 'PDF_NOT_FOUND')
      return { outcome: 'PDF_NOT_FOUND', reason: '无 DOI / publisher URL / title 可解析' }
    }

    let browser: BrowserLike | null = null
    try {
      browser = await this.launchBrowser()
      const failures: ProviderResult[] = []

      for (const url of urls) {
        const res = await this.tryUrl(browser, url, opts)
        if (res.outcome === 'PDF_OK') {
          this.markAttempt(started, 'PDF_OK')
          return res
        }
        failures.push(res)
        if (res.outcome === 'AUTH_REQUIRED') {
          // session broken: further candidates would hit the same wall —
          // stop immediately, do not burn more attempts (req 3/7)
          this.markAttempt(started, 'AUTH_REQUIRED')
          return res
        }
      }

      // title-only: best-effort CARSI portal search
      if (urls.length === 0 && paper.title) {
        const res = await this.portalSearch(paper.title, opts)
        if (res.outcome === 'PDF_OK' || res.outcome === 'AUTH_REQUIRED') {
          this.markAttempt(started, res.outcome)
          return res
        }
        failures.push(res)
      }

      const winner = strongestFailure(failures)
      this.markAttempt(started, winner.outcome)
      return winner
    } finally {
      if (browser) await browser.close().catch(() => undefined)
    }
  }

  /**
   * Manual (re-)authentication: opens the CARSI portal in a browser using the
   * SAME persistent profile, then waits for `waitFor` (e.g. Enter on stdin or
   * a timeout) before closing. Only after the human finishes does the session
   * ledger get marked authenticated.
   */
  async authenticate(opts: {
    headless?: boolean
    openUrl?: string
    waitFor?: Promise<unknown>
    timeoutMs?: number
  } = {}): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.probeAvailable())) return { ok: false, reason: 'playwright/chromium 不可用' }
    const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000
    let browser: BrowserLike | null = null
    try {
      browser = await this.launchBrowser(opts.headless ?? false)
      const page = await browser.newPage()
      await page.goto(opts.openUrl ?? CARSI_PORTAL_URL, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeoutMs, 60000),
      })
      const done = opts.waitFor ?? new Promise((r) => setTimeout(r, timeoutMs))
      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('登录等待超时')), timeoutMs)),
      ])
      this.markAuthenticated()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: String(err) }
    } finally {
      if (browser) await browser.close().catch(() => undefined)
    }
  }

  /* ---------------- internals ---------------- */

  private async launchBrowser(headless = this.opts.headless): Promise<BrowserLike> {
    if (this.launcher) return this.launcher(this.profileDir, { headless, userAgent: this.opts.userAgent })
    return launchPersistentBrowser(this.profileDir, { headless, userAgent: this.opts.userAgent })
  }

  private async tryUrl(
    browser: BrowserLike,
    url: string,
    opts: ProviderFetchOptions,
  ): Promise<ProviderResult> {
    const page = await browser.newPage()
    const captured: Array<{ res: PageResponseLike }> = []
    const downloads: Array<{ path: string; name: string }> = []
    page.on('response', (res) => {
      const ct = res.headers()['content-type'] ?? ''
      if (/application\/pdf|octet-stream/i.test(ct) || /\.pdf($|\?)/i.test(res.url())) {
        captured.push({ res })
      }
    })
    page.on('download', (d) => {
      void d
        .path()
        .then((p) => downloads.push({ path: p, name: d.suggestedFilename() }))
        .catch(() => undefined)
    })
    try {
      let mainStatus = 0
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs })
        mainStatus = resp?.status() ?? 0
      } catch {
        mainStatus = 0
      }
      // allow JS redirects / SP session flows to settle (bounded)
      await page.waitForTimeout(2500)

      // direct PDF response (main doc or sub-resource)
      if (captured.length > 0) {
        const c = captured[0]!
        const buf = await c.res.body().catch(() => Buffer.alloc(0))
        const ok = validatePdfBuffer(buf, opts.minPdfBytes, c.res.headers()['content-type'])
        if (ok.ok) {
          const stored = await storePdf(buf, opts.pdfsDir)
          if (stored) {
            return {
              outcome: 'PDF_OK',
              pdfPath: stored.path,
              sha256: stored.sha256,
              url: c.res.url(),
              http: c.res.status(),
              contentType: c.res.headers()['content-type'],
              bytes: buf.length,
            }
          }
          return { outcome: 'PDF_NOT_FOUND', url, reason: `存储失败: ${ok.reason}` }
        }
        // else: fall through to page-level classification
      }

      // explicit download event
      if (downloads.length > 0) {
        const d = downloads[0]!
        try {
          const buf = readFileSync(d.path)
          const ok = validatePdfBuffer(buf, opts.minPdfBytes)
          if (ok.ok) {
            const stored = await storePdf(buf, opts.pdfsDir)
            if (stored) {
              return {
                outcome: 'PDF_OK',
                pdfPath: stored.path,
                sha256: stored.sha256,
                url,
                contentType: 'application/pdf (download)',
                bytes: buf.length,
              }
            }
          }
        } catch {
          // temp file gone → treat as not found
        }
      }

      // scan page for a PDF link and follow it (bounded)
      const hrefs = await page.linkHrefs('a[href]').catch(() => [] as string[])
      const pdfHrefs = hrefs.filter((h) => /\.pdf($|\?)/i.test(h) || /(?:download|stamp|retrieve|fulltext)/i.test(h))
      for (const href of pdfHrefs.slice(0, 3)) {
        const abs = new URL(href, page.url()).toString()
        try {
          await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: Math.min(opts.timeoutMs, 30000) })
          await page.waitForTimeout(1500)
        } catch {
          continue
        }
        const hit = captured.find((x) => x.res.url() === abs) ?? captured[captured.length - 1]
        if (hit) {
          const buf = await hit.res.body().catch(() => Buffer.alloc(0))
          const ok = validatePdfBuffer(buf, opts.minPdfBytes, hit.res.headers()['content-type'])
          if (ok.ok) {
            const stored = await storePdf(buf, opts.pdfsDir)
            if (stored) {
              return {
                outcome: 'PDF_OK',
                pdfPath: stored.path,
                sha256: stored.sha256,
                url: abs,
                http: hit.res.status(),
                contentType: hit.res.headers()['content-type'],
                bytes: buf.length,
              }
            }
          }
        }
      }

      // classify the failure — using the CURRENT page state (the click-through
      // may have landed on a login/SSO interstitial, which is a wall even
      // though the article page earlier exposed a download link)
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
        return {
          outcome: 'AUTH_REQUIRED',
          url: page.url(),
          http: mainStatus || undefined,
          reason:
            '机构会话缺失或已失效：页面进入登录/身份认证流程。请运行 dsh-literature-carsi-login 重新登录 CARSI 后再试。',
        }
      }
      if (wall === 'denied') {
        return {
          outcome: 'ACCESS_DENIED',
          url: page.url(),
          http: mainStatus || undefined,
          reason: `出版社拒绝访问（HTTP ${mainStatus || '未知'}；可能为反爬拦截或机构未授权该资源）`,
        }
      }
      // empty/tiny page with no links: anti-bot challenge or JS never loaded
      const emptyish = html.length > 0 && html.length < 8000 && currentHrefs.length === 0
      return {
        outcome: 'PDF_NOT_FOUND',
        url: page.url(),
        http: mainStatus || undefined,
        reason: emptyish
          ? '页面为空/疑似反爬挑战或 JS 未加载（非会话问题）。可在登录 CLI 的 headed 浏览器中手动完成该出版社访问'
          : '页面未提供可验证的 PDF（无 PDF 响应/下载/链接）',
      }
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  /** Best-effort title search on the CARSI portal (last-resort input). */
  private async portalSearch(title: string, opts: ProviderFetchOptions): Promise<ProviderResult> {
    const browser = await this.launchBrowser()
    try {
      const page = await browser.newPage()
      try {
        await page.goto(CARSI_PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs })
        await page.waitForTimeout(2000)
        const filled = await page.fillAndSubmit(
          'input[type="text"], input[name*="q" i], input[placeholder*="搜索" i], input[placeholder*="search" i]',
          title.slice(0, 120),
        )
        if (!filled) {
          return {
            outcome: 'PDF_NOT_FOUND',
            url: CARSI_PORTAL_URL,
            reason: 'CARSI 门户未找到搜索框（页面结构变化或需登录），请改用 DOI/出版社链接',
          }
        }
        await page.waitForTimeout(4000)
        const links = await page.linkHrefs('a[href]').catch(() => [] as string[])
        const candidates = links.filter((h) => !/javascript:|#|logout|login/i.test(h)).slice(0, 5)
        for (const href of candidates) {
          const abs = new URL(href, page.url()).toString()
          const res = await this.tryUrl(browser, abs, opts)
          if (res.outcome === 'PDF_OK' || res.outcome === 'AUTH_REQUIRED') return res
        }
        return {
          outcome: 'PDF_NOT_FOUND',
          url: CARSI_PORTAL_URL,
          reason: 'CARSI 门户检索未定位到该论文的机构全文',
        }
      } finally {
        await page.close().catch(() => undefined)
      }
    } finally {
      await browser.close().catch(() => undefined)
    }
  }
}

/** Pick the most informative failure across candidates. */
export function strongestFailure(results: ProviderResult[]): ProviderResult {
  if (results.length === 0) {
    return { outcome: 'PDF_NOT_FOUND', reason: '无可用候选' }
  }
  const rank: Record<string, number> = { AUTH_REQUIRED: 3, ACCESS_DENIED: 2, PDF_NOT_FOUND: 1 }
  return [...results].sort((a, b) => (rank[b.outcome] ?? 0) - (rank[a.outcome] ?? 0))[0]!
}

async function storePdf(buf: Buffer, pdfsDir: string): Promise<{ path: string; sha256: string } | null> {
  try {
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const path = join(pdfsDir, `${sha256}.pdf`)
    mkdirSync(pdfsDir, { recursive: true })
    writeFileSync(path, buf)
    return { path, sha256 }
  } catch {
    return null
  }
}

/** Remove a stale ledger (used by tests / cleanup). */
export function clearLedger(dataDir: string): void {
  rmSync(join(dataDir, 'carsi'), { recursive: true, force: true })
}
