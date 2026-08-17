/**
 * CARSI institutional-access fallback tests:
 * - pure helpers (validation, login-wall classification, URL resolution);
 * - fetchPdf provider-chain outcome mapping + provenance columns;
 * - AUTH_REQUIRED never enters retry cooldown (requirement 6);
 * - strict low-frequency gating (requirement 7);
 * - persistent profile dir isolation (requirement 3: never a daily browser
 *   profile);
 * - end-to-end provider fetch with a stubbed browser launcher.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, upsertPaper, type Db } from '../src/db.js'
import { fetchPdf, inRetryCooldown } from '../src/fetch/pdf.js'
import type { PaperRef } from '../src/sources/types.js'
import type { PdfProvider, ProviderResult } from '../src/providers/types.js'
import {
  CarsiPdfProvider,
  classifyLoginWall,
  clearLedger,
  resolveCandidateUrls,
  validatePdfBuffer,
  type BrowserLike,
  type PageLike,
  type PageResponseLike,
} from '../src/providers/carsi.js'

/* ---------------- helpers ---------------- */

function pdfBytes(n: number): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, n - 8), 0x61)])
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-lit-${prefix}-`))
}

function seedPaper(db: Db, id: string, extra: Partial<PaperRef> = {}): void {
  upsertPaper(db, {
    id,
    title: 'Test Paper',
    authors: '["T"]',
    venue: null,
    year: 2024,
    doi: extra.doi ?? '10.1000/xyz',
    arxiv_id: null,
    openalex_id: null,
    url: extra.url ?? 'https://publisher.example/article/1',
    oa_pdf_url: null,
    abstract: null,
    citations: 1,
    bibtex: null,
    metadata_source: 'crossref',
  })
}

const PAPER: PaperRef = {
  id: 'doi:10.1000/xyz',
  title: 'Test Paper',
  authors: ['T'],
  doi: '10.1000/xyz',
  url: 'https://publisher.example/article/1',
  metadataSource: 'crossref',
}

class StubProvider implements PdfProvider {
  readonly name = 'carsi'
  readonly accessType = 'institutional' as const
  readonly isOpenAccess = false
  constructor(
    private readonly result: ProviderResult | (() => ProviderResult),
    private readonly gate: { ok: boolean; reason?: string } = { ok: true },
  ) {}
  shouldAttempt(): { ok: boolean; reason?: string } {
    return this.gate
  }
  markAttempt(): void {}
  markAuthenticated(): void {}
  async fetch(): Promise<ProviderResult> {
    return typeof this.result === 'function' ? this.result() : this.result
  }
}

/** Scripted stub page: emits a pdf response on goto, or a login wall. */
function stubPage(opts: {
  pdf?: { url: string; body: Buffer; contentType?: string }
  wall?: { url: string; title?: string; html?: string; http?: number }
}): PageLike {
  const listeners: { response?: (r: PageResponseLike) => void } = {}
  let currentUrl = ''
  return {
    goto: async (url) => {
      currentUrl = url
      if (opts.pdf) {
        const res: PageResponseLike = {
          url: () => opts.pdf!.url,
          status: () => 200,
          headers: () => ({ 'content-type': opts.pdf!.contentType ?? 'application/pdf' }),
          body: async () => opts.pdf!.body,
        }
        listeners.response?.(res)
        return { status: () => 200 }
      }
      return { status: () => opts.wall?.http ?? 200 }
    },
    url: () => currentUrl,
    title: async () => opts.wall?.title ?? '',
    content: async () => opts.wall?.html ?? '',
    on: (ev, cb) => {
      if (ev === 'response') listeners.response = cb as (r: PageResponseLike) => void
    },
    linkHrefs: async () => [],
    fillAndSubmit: async () => false,
    waitForTimeout: async () => {},
    close: async () => {},
  }
}

function stubBrowser(page: PageLike): BrowserLike {
  return { newPage: async () => page, close: async () => {} }
}

/* ---------------- pure helpers ---------------- */

describe('validatePdfBuffer (requirement 5)', () => {
  it('accepts a plausible PDF', () => {
    expect(validatePdfBuffer(pdfBytes(20000), 10240, 'application/pdf').ok).toBe(true)
  })
  it('rejects HTML login pages by content-type even with pdf-ish bytes', () => {
    const r = validatePdfBuffer(pdfBytes(20000), 10240, 'text/html')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/HTML/)
  })
  it('rejects non-PDF magic (HTML body)', () => {
    const r = validatePdfBuffer(Buffer.from('<html><body>sign in</body></html>'), 10240)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/%PDF/)
  })
  it('rejects too-small documents', () => {
    const r = validatePdfBuffer(pdfBytes(100), 10240)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/过小/)
  })
})

describe('classifyLoginWall', () => {
  it('login-wall URL → auth (session expired)', () => {
    expect(
      classifyLoginWall({ url: 'https://sso.example/wayf/Shibboleth.sso/Login?target=x', hasPdfLink: false }),
    ).toBe('auth')
  })
  it('HTTP 403 with session → denied', () => {
    expect(classifyLoginWall({ url: 'https://pub.example/a', http: 403, hasPdfLink: false })).toBe('denied')
  })
  it('article page with sign-in header links and a PDF link is NOT a wall', () => {
    expect(
      classifyLoginWall({
        url: 'https://pub.example/article/1',
        html: '<a>Sign In</a><a href="x.pdf">PDF</a>',
        hasPdfLink: true,
      }),
    ).toBeNull()
  })
  it('login markers without any pdf link → auth', () => {
    expect(
      classifyLoginWall({
        url: 'https://pub.example/article/1',
        title: 'Access through your institution',
        html: 'Institutional login required',
        hasPdfLink: false,
      }),
    ).toBe('auth')
  })
})

describe('resolveCandidateUrls (requirement 4)', () => {
  it('DOI first, then publisher URL; skips direct PDF URLs', () => {
    expect(resolveCandidateUrls(PAPER)).toEqual([
      'https://doi.org/10.1000%2Fxyz',
      'https://publisher.example/article/1',
    ])
  })
  it('returns [] without doi/url', () => {
    expect(resolveCandidateUrls({ id: 'x', title: 'T', authors: [], metadataSource: 'x' })).toEqual([])
  })
})

/* ---------------- fetchPdf provider chain ---------------- */

describe('fetchPdf provider chain (order: public → CARSI → terminal)', () => {
  it('public chain ok keeps outcome ok + oa provenance', async () => {
    const dir = tempDir('pub')
    const db = openDb(dir)
    seedPaper(db, 'arxiv:2401.010')
    const good = pdfBytes(20000)
    const res = await fetchPdf(
      db,
      'arxiv:2401.010',
      [{ url: 'https://a.example/1.pdf', license: 'oa', source: 'arxiv' }],
      join(dir, 'pdfs'),
      { fetchImpl: (async () => new Response(good, { status: 200 })) as typeof fetch },
    )
    expect(res.outcome).toBe('ok')
    expect(res.accessType).toBe('oa')
    expect(res.isOpenAccess).toBe(true)
    const log = db.prepare('SELECT * FROM fetch_log').get() as { outcome: string; access_type: string | null; is_open_access: number | null }
    expect(log.outcome).toBe('ok')
    expect(log.access_type).toBe('oa')
    expect(log.is_open_access).toBe(1)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('public all fail → CARSI PDF_OK → outcome PDF_OK + institutional provenance', async () => {
    const dir = tempDir('carsi-ok')
    const db = openDb(dir)
    seedPaper(db, 'doi:10.1000/xyz')
    const pdfPath = join(dir, 'pdfs', `${'a'.repeat(64)}.pdf`)
    mkdirSync(join(dir, 'pdfs'), { recursive: true })
    writeFileSync(pdfPath, pdfBytes(20000))
    const provider = new StubProvider({
      outcome: 'PDF_OK',
      pdfPath,
      sha256: 'a'.repeat(64),
      url: 'https://publisher.example/pdf/1',
      contentType: 'application/pdf',
    })
    const res = await fetchPdf(
      db,
      'doi:10.1000/xyz',
      [{ url: 'https://paywall.example/1.pdf', license: 'publisher', source: 'crossref' }],
      join(dir, 'pdfs'),
      {
        fetchImpl: (async () => new Response('denied', { status: 403 })) as typeof fetch,
        providers: [provider],
        paper: PAPER,
      },
    )
    expect(res.outcome).toBe('PDF_OK')
    expect(res.pdfPath).toBe(pdfPath)
    expect(res.accessType).toBe('institutional')
    expect(res.isOpenAccess).toBe(false)
    expect(res.pdfSource).toMatch(/^carsi:/)
    const log = db.prepare('SELECT * FROM fetch_log').get() as {
      outcome: string
      access_type: string | null
      is_open_access: number | null
      pdf_source: string | null
    }
    expect(log.outcome).toBe('PDF_OK')
    expect(log.access_type).toBe('institutional')
    expect(log.is_open_access).toBe(0)
    expect(log.pdf_source).toMatch(/^carsi:/)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('AUTH_REQUIRED → outcome AUTH_REQUIRED, NOT FULLTEXT_UNAVAILABLE, and NO cooldown', async () => {
    const dir = tempDir('auth')
    const db = openDb(dir)
    seedPaper(db, 'doi:10.1000/xyz')
    const provider = new StubProvider({
      outcome: 'AUTH_REQUIRED',
      url: 'https://sso.example/login',
      reason: '机构会话失效',
    })
    const res = await fetchPdf(
      db,
      'doi:10.1000/xyz',
      [{ url: 'https://paywall.example/1.pdf', license: 'publisher', source: 'crossref' }],
      join(dir, 'pdfs'),
      {
        fetchImpl: (async () => new Response('denied', { status: 403 })) as typeof fetch,
        providers: [provider],
        paper: PAPER,
      },
    )
    expect(res.outcome).toBe('AUTH_REQUIRED')
    expect(res.attempts.some((a) => a.status === 'auth_required')).toBe(true)
    const log = db.prepare('SELECT outcome FROM fetch_log').get() as { outcome: string }
    expect(log.outcome).toBe('AUTH_REQUIRED')
    // requirement 6: AUTH_REQUIRED must not cause permanent cooldown
    expect(inRetryCooldown(db, 'doi:10.1000/xyz', 72)).toBeNull()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ACCESS_DENIED and PDF_NOT_FOUND terminals', async () => {
    const dir = tempDir('denied')
    const db = openDb(dir)
    seedPaper(db, 'doi:10.1000/xyz')
    const denied = await fetchPdf(
      db,
      'doi:10.1000/xyz',
      [{ url: 'https://paywall.example/1.pdf', license: 'publisher', source: 'crossref' }],
      join(dir, 'pdfs'),
      {
        fetchImpl: (async () => new Response('denied', { status: 403 })) as typeof fetch,
        providers: [new StubProvider({ outcome: 'ACCESS_DENIED', url: 'https://pub.example/1', http: 403 })],
        paper: PAPER,
      },
    )
    expect(denied.outcome).toBe('ACCESS_DENIED')

    const dir2 = tempDir('nf')
    const db2 = openDb(dir2)
    seedPaper(db2, 'doi:10.1000/xyz')
    const nf = await fetchPdf(
      db2,
      'doi:10.1000/xyz',
      [{ url: 'https://paywall.example/1.pdf', license: 'publisher', source: 'crossref' }],
      join(dir2, 'pdfs'),
      {
        fetchImpl: (async () => new Response('denied', { status: 403 })) as typeof fetch,
        providers: [new StubProvider({ outcome: 'PDF_NOT_FOUND', url: 'https://pub.example/1', reason: 'no pdf' })],
        paper: PAPER,
      },
    )
    expect(nf.outcome).toBe('PDF_NOT_FOUND')
    db.close()
    db2.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
  })

  it('provider blocked by frequency gate → skipped attempt, PDF_NOT_FOUND (no FULLTEXT_UNAVAILABLE cooldown)', async () => {
    const dir = tempDir('gate')
    const db = openDb(dir)
    seedPaper(db, 'doi:10.1000/xyz')
    const provider = new StubProvider(
      { outcome: 'PDF_OK', pdfPath: '/nonexistent', sha256: 'b'.repeat(64) },
      { ok: false, reason: 'CARSI 低频门：距上次尝试不足 120 分钟' },
    )
    const res = await fetchPdf(
      db,
      'doi:10.1000/xyz',
      [{ url: 'https://paywall.example/1.pdf', license: 'publisher', source: 'crossref' }],
      join(dir, 'pdfs'),
      {
        fetchImpl: (async () => new Response('denied', { status: 403 })) as typeof fetch,
        providers: [provider],
        paper: PAPER,
      },
    )
    // A gate-skipped provider means no provider actually attempted the paper:
    // benign PDF_NOT_FOUND, never FULLTEXT_UNAVAILABLE (which arms the 72h cooldown).
    expect(res.outcome).toBe('PDF_NOT_FOUND')
    expect(res.attempts.some((a) => a.status === 'skipped' && a.source === 'carsi')).toBe(true)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('provider claims PDF_OK but file missing → treated as failure', async () => {
    const dir = tempDir('missing')
    const db = openDb(dir)
    seedPaper(db, 'doi:10.1000/xyz')
    const res = await fetchPdf(
      db,
      'doi:10.1000/xyz',
      [{ url: 'https://paywall.example/1.pdf', license: 'publisher', source: 'crossref' }],
      join(dir, 'pdfs'),
      {
        fetchImpl: (async () => new Response('denied', { status: 403 })) as typeof fetch,
        providers: [new StubProvider({ outcome: 'PDF_OK', pdfPath: join(dir, 'missing.pdf'), sha256: 'c'.repeat(64) })],
        paper: PAPER,
      },
    )
    expect(res.outcome).toBe('PDF_NOT_FOUND')
    expect(res.attempts.some((a) => a.status === 'not_found' && a.detail?.includes('PDF_OK'))).toBe(true)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- CarsiPdfProvider with stub browser ---------------- */

describe('CarsiPdfProvider browser flow (stubbed launcher)', () => {
  it('downloads + validates + stores a PDF (PDF_OK with sha256)', async () => {
    const dataDir = tempDir('prov')
    const pdfsDir = join(dataDir, 'pdfs')
    const provider = new CarsiPdfProvider({
      dataDir,
      enabled: true,
      minIntervalMinutes: 120,
      headless: true,
      timeoutMs: 90000,
      launcher: async () =>
        stubBrowser(
          stubPage({ pdf: { url: 'https://pub.example/a.pdf', body: pdfBytes(30000) } }),
        ),
    })
    const res = await provider.fetch(PAPER, { pdfsDir, timeoutMs: 90000, minPdfBytes: 10240 })
    expect(res.outcome).toBe('PDF_OK')
    expect(res.sha256).toHaveLength(64)
    expect(existsSync(res.pdfPath!)).toBe(true)
    expect(readFileSync(res.pdfPath!).subarray(0, 5).toString()).toBe('%PDF-')
    expect(res.url).toBe('https://pub.example/a.pdf')
    const ledger = JSON.parse(readFileSync(join(dataDir, 'carsi', 'session.json'), 'utf8'))
    expect(ledger.lastOutcome).toBe('PDF_OK')
    expect(ledger.attemptsCount).toBe(1)
    clearLedger(dataDir)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('login wall → AUTH_REQUIRED (never FULLTEXT_UNAVAILABLE)', async () => {
    const dataDir = tempDir('prov-wall')
    const provider = new CarsiPdfProvider({
      dataDir,
      enabled: true,
      minIntervalMinutes: 120,
      headless: true,
      timeoutMs: 90000,
      launcher: async () =>
        stubBrowser(
          stubPage({
            wall: {
              url: 'https://sso.example/Shibboleth.sso/Login',
              title: 'Sign in',
              html: 'Please sign in with your institution',
            },
          }),
        ),
    })
    const res = await provider.fetch(PAPER, { pdfsDir: join(dataDir, 'pdfs'), timeoutMs: 90000, minPdfBytes: 10240 })
    expect(res.outcome).toBe('AUTH_REQUIRED')
    expect(res.reason).toMatch(/重新登录 CARSI/)
    clearLedger(dataDir)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('low-frequency gate: blocks within the interval, allows after it', async () => {
    const dataDir = tempDir('prov-gate')
    const provider = new CarsiPdfProvider({
      dataDir,
      enabled: true,
      minIntervalMinutes: 120,
      headless: true,
      timeoutMs: 90000,
      launcher: async () => stubBrowser(stubPage({ pdf: { url: 'https://pub.example/a.pdf', body: pdfBytes(30000) } })),
    })
    const t0 = new Date('2025-01-01T00:00:00Z')
    expect(provider.shouldAttempt(t0).ok).toBe(true)
    provider.markAttempt(t0, 'PDF_NOT_FOUND')
    const blocked = provider.shouldAttempt(new Date('2025-01-01T01:00:00Z'))
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toMatch(/低频门/)
    expect(provider.shouldAttempt(new Date('2025-01-01T02:00:01Z')).ok).toBe(true)
    provider.markAuthenticated(new Date('2025-01-01T02:30:00Z'))
    const ledger = JSON.parse(readFileSync(join(dataDir, 'carsi', 'session.json'), 'utf8'))
    expect(ledger.lastAuthAt).toBe('2025-01-01T02:30:00.000Z')
    // a fresh manual re-login resets the interval gate (retry immediately)
    expect(provider.shouldAttempt(new Date('2025-01-01T02:31:00Z')).ok).toBe(true)
    clearLedger(dataDir)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('profile dir is the dedicated data-dir profile, never a daily browser profile', async () => {
    const dataDir = tempDir('prov-profile')
    const provider = new CarsiPdfProvider({
      dataDir,
      enabled: true,
      minIntervalMinutes: 120,
      headless: true,
      timeoutMs: 90000,
    })
    const profile = provider.getProfileDir()
    expect(profile).toBe(join(dataDir, 'browser-profile'))
    expect(profile).not.toMatch(/\.mozilla|\.config\/google-chrome|\.config\/chromium/)
    rmSync(dataDir, { recursive: true, force: true })
  })
})
