/**
 * Shared browser-driving infrastructure for institutional-access providers
 * (the legacy CARSI provider and the generic publisher-browser provider).
 *
 * What lives here:
 * - the narrow browser surface (PageLike / BrowserLike) plus a real
 *   playwright launcher bound to an INDEPENDENT persistent profile (never the
 *   user's daily browser profile / cookie DB);
 * - pure validation helpers (PDF magic, size, non-HTML, login-wall
 *   classification, DOI → publisher URL resolution);
 * - PDF storage (pdfs/<sha256>.pdf) and a tiny JSON session ledger.
 *
 * Providers keep their own business logic (URL planning, candidate order,
 * frequency gates) on top of this shared layer.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Download, Page, Response } from 'playwright'
import type { PaperRef } from '../sources/types.js'

export const PDF_MAGIC = Buffer.from('%PDF-')

/* ------------------------------------------------------------------ */
/* Pure validation helpers (unit-testable without a browser)           */
/* ------------------------------------------------------------------ */

/** Validate a downloaded document (magic, non-HTML, minimum size). */
export function validatePdfBuffer(
  buf: Buffer,
  minBytes: number,
  contentType?: string | null,
): { ok: boolean; reason: string } {
  if (contentType && /^text\/html/i.test(contentType)) {
    return { ok: false, reason: `Content-Type ${contentType} 为 HTML（登录页/页面），拒绝` }
  }
  if (buf.length < PDF_MAGIC.length || !buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return { ok: false, reason: '文件头不是 %PDF-（可能为 HTML 登录页或错误页）' }
  }
  if (buf.length < minBytes) {
    return { ok: false, reason: `文件过小：${buf.length}B < ${minBytes}B` }
  }
  return { ok: true, reason: 'ok' }
}

const LOGIN_URL_RE =
  /(?:login|signin|sign-in|sso|wayf|shibboleth|openauth|authn|auth\/|idp|cas|fed|saml|identity)/i

const LOGIN_MARKERS = [
  'sign in', 'sign-in', 'log in', 'please sign in', 'institutional login',
  'access through your institution', 'institutional sign in', 'sso login',
  'subscription required', 'authentication required', 'purchase this article',
  '登录', '请登录', '机构登录', '统一身份认证', '登录以访问', '订阅',
]

/**
 * Classify a page as a login wall. `auth` = the session is missing/expired
 * (AUTH_REQUIRED); `denied` = session present but rejected (HTTP 403/401,
 * ACCESS_DENIED). A page that still exposes a PDF link is NOT a wall even
 * when it carries header "Sign In" links.
 */
export function classifyLoginWall(opts: {
  url: string
  http?: number
  title?: string
  html?: string
  hasPdfLink: boolean
}): 'auth' | 'denied' | null {
  if (opts.http === 403) return 'denied'
  if (opts.http === 401) return 'auth'
  if (LOGIN_URL_RE.test(opts.url)) return 'auth'
  if (opts.hasPdfLink) return null
  const hay = `${opts.title ?? ''} ${opts.html ?? ''}`.toLowerCase()
  if (LOGIN_MARKERS.some((m) => hay.includes(m.toLowerCase()))) return 'auth'
  return null
}

/** DOI-first publisher URL candidates from paper identity. */
export function resolveCandidateUrls(paper: PaperRef): string[] {
  const out: string[] = []
  if (paper.doi) out.push(`https://doi.org/${encodeURIComponent(paper.doi)}`)
  if (paper.url && /^https?:\/\//i.test(paper.url) && !/\.pdf($|\?)/i.test(paper.url)) {
    out.push(paper.url)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Minimal browser surface (real launcher = playwright; tests stub it) */
/* ------------------------------------------------------------------ */

export interface PageResponseLike {
  url(): string
  status(): number
  headers(): Record<string, string>
  body(): Promise<Buffer>
}

export interface PageDownloadLike {
  path(): Promise<string>
  suggestedFilename(): string
}

export interface PageLike {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number } | null>
  url(): string
  title(): Promise<string>
  content(): Promise<string>
  on(event: 'response', cb: (res: PageResponseLike) => void): void
  on(event: 'download', cb: (d: PageDownloadLike) => void): void
  /** hrefs of all links matching the selector */
  linkHrefs(sel: string): Promise<string[]>
  /** fill an input and press Enter (portal search); false when not found */
  fillAndSubmit(sel: string, value: string): Promise<boolean>
  waitForTimeout(ms: number): Promise<void>
  close(): Promise<void>
}

export interface BrowserLike {
  newPage(): Promise<PageLike>
  close(): Promise<void>
}

export type BrowserLauncher = (
  profileDir: string,
  opts: { headless: boolean; userAgent?: string },
) => Promise<BrowserLike>

/** Adapter from a real playwright page to the narrow PageLike surface. */
function pageAdapter(page: Page): PageLike {
  return {
    goto: (url, o) =>
      page
        .goto(url, { waitUntil: (o?.waitUntil ?? 'load') as 'load', timeout: o?.timeout })
        .then((r) => (r ? { status: () => r.status() } : null)),
    url: () => page.url(),
    title: () => page.title(),
    content: () => page.content(),
    on: (event, cb) => {
      if (event === 'response') {
        page.on('response', (r: Response) =>
          (cb as (res: PageResponseLike) => void)({
            url: () => r.url(),
            status: () => r.status(),
            headers: () => r.headers(),
            body: () => r.body(),
          }),
        )
      } else {
        page.on('download', (d: Download) =>
          (cb as (d: PageDownloadLike) => void)({
            path: () => d.path(),
            suggestedFilename: () => d.suggestedFilename(),
          }),
        )
      }
    },
    linkHrefs: (sel) =>
      page
        .locator(sel)
        .evaluateAll((els) => els.map((e) => String((e as { href?: string }).href ?? '')))
        .catch(() => [] as string[]),
    fillAndSubmit: async (sel, value) => {
      const loc = page.locator(sel).first()
      if ((await loc.count()) === 0) return false
      await loc.fill(value)
      await page.keyboard.press('Enter')
      return true
    },
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    close: () => page.close(),
  }
}

/**
 * Launch (or reuse) the persistent browser context bound to `profileDir`.
 * Falls back to PDF_NOT_FOUND-grade availability checks by the caller.
 */
export async function launchPersistentBrowser(
  profileDir: string,
  opts: { headless: boolean; userAgent?: string },
): Promise<BrowserLike> {
  const pw = await import('playwright')
  const context = await pw.chromium.launchPersistentContext(profileDir, {
    headless: opts.headless,
    userAgent: opts.userAgent,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  })
  return {
    newPage: async () => pageAdapter(await context.newPage()),
    close: async () => context.close(),
  }
}

/** Whether the playwright browser runtime is usable. */
export async function probeBrowserAvailable(launcher?: BrowserLauncher): Promise<boolean> {
  if (launcher) return true
  try {
    const pw = await import('playwright')
    return existsSync(pw.chromium.executablePath())
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* PDF storage + session ledger                                        */
/* ------------------------------------------------------------------ */

/** Store a validated PDF buffer as pdfs/<sha256>.pdf; returns path+sha256. */
export function storePdf(buf: Buffer, pdfsDir: string): { path: string; sha256: string } | null {
  try {
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const dir = join(pdfsDir, `${sha256}.pdf`)
    mkdirSync(pdfsDir, { recursive: true })
    writeFileSync(dir, buf)
    return { path: dir, sha256 }
  } catch {
    return null
  }
}

export interface SessionLedger {
  lastAttemptAt?: string
  lastOutcome?: string
  lastAuthAt?: string
  attemptsCount: number
}

export function readLedger(ledgerFile: string): SessionLedger {
  try {
    const raw = readFileSync(ledgerFile, 'utf8')
    const v = JSON.parse(raw) as Partial<SessionLedger>
    return { attemptsCount: v.attemptsCount ?? 0, ...v }
  } catch {
    return { attemptsCount: 0 }
  }
}

export function writeLedger(ledgerFile: string, ledger: SessionLedger): void {
  const dir = join(ledgerFile, '..')
  mkdirSync(dir, { recursive: true })
  const tmp = `${ledgerFile}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger, null, 2))
  renameSync(tmp, ledgerFile)
}
