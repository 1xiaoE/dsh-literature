/**
 * Tool: literature_fetch_pdf — download a paper's PDF with multi-source
 * fallback: public/OA chain (arxiv → openalex OA → unpaywall → crossref
 * publisher links) first; when all public sources failed for a quality-gated
 * paper, the institutional providers are consulted rank-by-rank:
 *   - publisher_browser (generic Direct Publisher Access, the default);
 *   - carsi (LEGACY / EXPERIMENTAL — only when explicitly enabled).
 *
 * Terminals: ok (public) / PDF_OK (institutional) / AUTH_REQUIRED (session
 * broken — NEVER a paper-level cooldown; user must re-login via
 * bin/dsh-literature-browser-login) / ACCESS_DENIED / PDF_NOT_FOUND /
 * FULLTEXT_UNAVAILABLE. The full attempt trail is persisted.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { jsonSafe } from '../lib/json_safe.js'
import { getPaper } from '../db.js'
import { fetchPdf, inRetryCooldown, type FetchAttempt } from '../fetch/pdf.js'
import { rowToRef } from './literature_sources.js'
import { allocateAttemptOrder, ensureAcquisitionTurn, markAcquisitionOutcome } from '../lib/selection.js'

export interface FetchPdfInput {
  paperId: string
  pushId?: number
  /**
   * Opt into the institutional-access fallback (publisher_browser and, if
   * enabled, CARSI) for this paper. MUST only be set after (a) the paper
   * passed the ranking quality gates and (b) every public/open-access
   * fulltext source failed. Institutional access is never a batch/bulk
   * source — strict low-frequency gates apply.
   */
  allowInstitutional?: boolean
  /**
   * Backward-compatible alias of allowInstitutional (kept so old prompts and
   * scripts that said allowCarsi still work; CARSI itself is legacy/disabled
   * by default, the generic publisher_browser provider handles the request).
   */
  allowCarsi?: boolean
  /**
   * Human-in-the-loop: the user manually downloaded the PDF (e.g. via the
   * publisher's human flow or a headed login browser). The file is validated
   * (%PDF- magic, size), hashed and registered as pdfs/<sha256>.pdf with
   * provenance source=manual (NOT open access).
   */
  manualPdfPath?: string
}

export interface FetchPdfOutput {
  paperId: string
  outcome: 'ok' | 'PDF_OK' | 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'ACCESS_DENIED' | 'PDF_NOT_FOUND' | 'FULLTEXT_UNAVAILABLE' | 'failed'
  pdfPath?: string
  sha256?: string
  pdfSource?: string
  accessType?: 'oa' | 'institutional' | 'manual'
  isOpenAccess?: boolean
  attempts: FetchAttempt[]
  reason?: string
  /** set when the user must act (e.g. re-run the browser login CLI) */
  userAction?: 'publisher_login' | 'carsi_relogin'
}

/** How many institutional PDF_OK successes this push already has (maxPerPush cap).
 *  Only counts rows whose candidate is acquisition-SELECTED: legacy rows from
 *  pre-状态机 pushes or pushless fetches never count, so maxPerPush=1 cannot
 *  dead-lock a fresh push on an old institutional row. */
function institutionalSuccessCount(rt: LiteratureRuntime, pushId: number): number {
  const row = rt.db
    .prepare(
      `SELECT COUNT(*) AS n FROM fetch_log f
       JOIN candidates c ON c.paper_id = f.paper_id
       WHERE c.push_id = ? AND f.outcome = 'PDF_OK' AND f.access_type = 'institutional'
         AND c.acquisition_outcome = 'SELECTED'`,
    )
    .get(pushId) as { n: number }
  return row?.n ?? 0
}

export function defineLiteratureFetchPdf(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_fetch_pdf',
    description:
      '多源回退下载论文 PDF。提供 pushId 时执行 Quality First 硬约束：必须先 literature_rank_candidates，再对当前最高排名达标候选完成 public/OA→publisher 的完整 acquisition chain；Rank1 未得到 ACCESS_DENIED/PDF_NOT_FOUND 等明确终态前禁止跳 Rank。终态：ok / PDF_OK / AUTH_REQUIRED / RATE_LIMITED / ACCESS_DENIED / PDF_NOT_FOUND / FULLTEXT_UNAVAILABLE。',
    parameters: {
      paperId: { type: 'string', required: true, description: '候选论文 id（来自 literature_sources）' },
      pushId: { type: 'integer', description: '推送号；提供时执行 SELECTED 不变式检查' },
      allowInstitutional: {
        type: 'boolean',
        description:
          '公开/OA 全失败后是否允许机构访问兜底（publisher_browser + 启用时的 CARSI；仅限质量门达标论文；严格低频，默认不传）',
      },
      allowCarsi: {
        type: 'boolean',
        description:
          '兼容别名（等价 allowInstitutional）。旧提示/脚本语义保持：公开/OA 全失败后允许机构访问兜底。CARSI 本身已标记 legacy 且默认禁用，实际由 publisher_browser 承担机构访问。',
      },
      manualPdfPath: {
        type: 'string',
        description:
          '用户已手动下载的 PDF 路径（Human-in-the-loop 手动登记）：校验 %PDF- + 大小 → sha256 → 入库 pdfs/<sha256>.pdf，provenance source=manual（非 OA）。提供时跳过自动下载链。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paperId: { type: 'string', required: true },
          outcome: {
            type: 'string',
            required: true,
            enum: ['ok', 'PDF_OK', 'AUTH_REQUIRED', 'RATE_LIMITED', 'ACCESS_DENIED', 'PDF_NOT_FOUND', 'FULLTEXT_UNAVAILABLE', 'failed'],
          },
          pdfPath: { type: 'string' },
          sha256: { type: 'string' },
          pdfSource: { type: 'string' },
          accessType: { type: 'string', enum: ['oa', 'institutional', 'manual'] },
          isOpenAccess: { type: 'boolean' },
          reason: { type: 'string' },
          userAction: { type: 'string', enum: ['publisher_login', 'carsi_relogin'] },
          attempts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                url: { type: 'string', required: true },
                status: {
                  type: 'string',
                  required: true,
                  enum: ['ok', 'http_error', 'not_pdf', 'too_small', 'network_error', 'skipped', 'auth_required', 'rate_limited', 'access_denied', 'not_found'],
                },
                http: { type: 'integer' },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: FetchPdfOutput) => [
        {
          type: 'text',
          text:
            value.outcome === 'ok'
              ? `PDF 下载成功（公开/OA）：${value.pdfSource} (sha256=${value.sha256?.slice(0, 12)}…)`
              : value.outcome === 'PDF_OK'
                ? `PDF 下载成功（机构访问，非 OA，仅私人文献库）：${value.pdfSource} (sha256=${value.sha256?.slice(0, 12)}…)`
                : value.outcome === 'AUTH_REQUIRED'
                  ? `AUTH_REQUIRED：出版社登录墙/机构会话缺失或已失效（${value.attempts.filter((a) => a.status === 'auth_required').map((a) => a.detail).join('; ') || '详见 attempts'}）。请运行 bin/dsh-literature-browser-login 完成合法登录后 --resume 继续；本次不进入 cooldown。`
                  : value.outcome === 'RATE_LIMITED'
                  ? `RATE_LIMITED：${value.reason ?? value.attempts.filter((a) => a.status === 'rate_limited').map((a) => a.detail).join('; ')}。保持当前 Rank，不得跳到下一候选；到最早重试时间后 --resume。`
                  : value.outcome === 'FULLTEXT_UNAVAILABLE'
                    ? `FULLTEXT_UNAVAILABLE：${value.attempts.length} 个源均失败。${value.attempts.map((a) => `${a.source}:${a.status}${a.detail ? `(${a.detail})` : ''}`).join(', ')}`
                    : `失败（${value.outcome}）：${value.reason ?? '未知原因'}。${value.attempts.map((a) => `${a.source}:${a.status}`).join(', ')}`,
        },
      ],
    },
    async execute(args: FetchPdfInput): Promise<FetchPdfOutput> {
      const rt = getRt()
      const wantInstitutional = args.allowInstitutional || args.allowCarsi === true
      if (args.pushId !== undefined) {
        try {
          const turn = ensureAcquisitionTurn(rt.db, args.pushId, args.paperId, rt.cfg)
          if (!args.manualPdfPath && !turn.publicPreflightStatus) {
            return jsonSafe({
              paperId: args.paperId,
              outcome: 'failed',
              attempts: [],
              reason: `Quality First invariant: agentRank #${turn.agentRank} 尚未 public preflight；先调用 literature_pdf_preflight(pushId=${args.pushId}, paperId=${args.paperId})`,
            })
          }
          // Quality First: when the public/OA chain is UNAVAILABLE on the
          // current rank, the full public→institutional fallback must run
          // (allowInstitutional=true) instead of jumping to a lower rank.
          // When public IS available, opt-in stays opt-in (backward compatible).
          if (
            !args.manualPdfPath &&
            turn.publicPreflightStatus === 'UNAVAILABLE' &&
            rt.providers.length > 0 &&
            !wantInstitutional
          ) {
            return jsonSafe({
              paperId: args.paperId,
              outcome: 'failed',
              attempts: [],
              reason: 'Quality First invariant: 当前 Rank public/OA 不可得，必须一次完成 public→institutional 回退链；请传 allowInstitutional=true，不能直接跳下一 Rank',
            })
          }
        } catch (err) {
          return jsonSafe({
            paperId: args.paperId,
            outcome: 'failed',
            attempts: [],
            reason: String(err instanceof Error ? err.message : err),
          })
        }
      }
      const cooldown = inRetryCooldown(rt.db, args.paperId, rt.cfg.fulltext.retryCooldownHours)
      if (cooldown) {
        return jsonSafe({
          paperId: args.paperId,
          outcome: 'failed',
          attempts: [],
          reason: `FULLTEXT_UNAVAILABLE retry cooldown (until ${cooldown})`,
        })
      }
      const row = getPaper(rt.db, args.paperId)
      if (!row) {
        return jsonSafe({
          paperId: args.paperId,
          outcome: 'failed',
          attempts: [],
          reason: 'paper not found — 先运行 literature_sources 生成候选',
        })
      }

      // Human-in-the-loop: user manually downloaded the PDF — validate,
      // hash and register it directly (skips the automatic chain).
      if (args.manualPdfPath) {
        const manual = registerManualPdf(rt, args.paperId, args.manualPdfPath)
        if (args.pushId !== undefined && manual.outcome === 'PDF_OK') {
          markAcquisitionOutcome(rt.db, args.pushId, args.paperId, 'SELECTED', manual.reason)
        }
        return manual
      }

      const paper = rowToRef(row)
      const candidates = await rt.registry.pdfCandidates(paper)
      if (candidates.length === 0 && !(wantInstitutional && rt.providers.length > 0)) {
        const out = {
          paperId: args.paperId,
          outcome: 'FULLTEXT_UNAVAILABLE' as const,
          attempts: [],
          reason: 'no legal PDF candidate from any adapter',
        }
        if (args.pushId !== undefined) markAcquisitionOutcome(rt.db, args.pushId, args.paperId, 'FULLTEXT_UNAVAILABLE', out.reason)
        return jsonSafe(out)
      }

      // All guards passed → this is a real acquisition attempt: consume the
      // attempt slot now (preflight normally allocated it; manual/edge paths
      // allocate here). A rejected call never consumes a slot.
      if (args.pushId !== undefined) {
        const turn = ensureAcquisitionTurn(rt.db, args.pushId, args.paperId, rt.cfg)
        if (turn.attemptOrder === null) allocateAttemptOrder(rt.db, args.pushId, args.paperId)
      }

      // Institutional provider chain: opt-in + enabled + maxPerPush success cap.
      // (minIntervalMinutes spacing is enforced inside each provider ledger.)
      if (wantInstitutional && rt.providers.length > 0) {
        const maxPerPush = Math.min(rt.cfg.publisherBrowser.maxPerPush, rt.cfg.carsi.maxPerPush)
        const done = args.pushId !== undefined ? institutionalSuccessCount(rt, args.pushId) : 0
        if (done >= maxPerPush) {
          // Per-push acquisition budget exhausted: park on the SAME rank as a
          // RATE_LIMITED-style terminal WITHOUT writing a FULLTEXT_UNAVAILABLE
          // fetch_log row (that would arm the 72h cooldown). The agent must
          // stop acquisition for this push rather than degrade to a lower
          // ranked candidate.
          const reason = `机构访问每推送上限已满（maxPerPush=${maxPerPush}）：本推送不可再尝试机构获取；保持当前 Rank，不得降级到下一候选`
          if (args.pushId !== undefined) markAcquisitionOutcome(rt.db, args.pushId, args.paperId, 'RATE_LIMITED', reason)
          return jsonSafe({
            paperId: args.paperId,
            outcome: 'RATE_LIMITED',
            attempts: [],
            reason,
          })
        }
      }

      const t0 = performance.now()
      const result = await fetchPdf(rt.db, args.paperId, candidates, rt.pdfsDir, {
        timeoutMs: rt.cfg.http.timeoutMs,
        minPdfBytes: rt.cfg.http.minPdfBytes,
        fetchImpl: rt.fetchImpl,
        providers: wantInstitutional && rt.providers.length > 0 ? rt.providers : [],
        paper,
      })
      if (args.pushId !== undefined) {
        rt.perf.add(args.pushId, {
          pdfDownloadMs: performance.now() - t0,
          pdfAttemptCount: result.attempts.length,
        })
      }
      const out: FetchPdfOutput = { paperId: args.paperId, ...result }
      if (out.outcome === 'AUTH_REQUIRED') out.userAction = 'publisher_login'
      if (args.pushId !== undefined) {
        const mapped = out.outcome === 'ok' || out.outcome === 'PDF_OK' ? 'SELECTED' : out.outcome === 'failed' ? 'PDF_FAILED' : out.outcome
        markAcquisitionOutcome(rt.db, args.pushId, args.paperId, mapped, out.reason ?? result.attempts.map((a) => `${a.source}:${a.status}`).join(', '))
      }
      return jsonSafe(out)
    },
  })
}

const PDF_MAGIC = Buffer.from('%PDF-')

/**
 * Register a user-provided PDF (HITL manual download): validate %PDF- magic +
 * minimum size, store as pdfs/<sha256>.pdf with provenance source=manual and
 * is_open_access=0 (a private, non-OA acquisition).
 */
function registerManualPdf(rt: LiteratureRuntime, paperId: string, manualPath: string): FetchPdfOutput {
  const minBytes = rt.cfg.http.minPdfBytes
  let buf: Buffer
  try {
    buf = readFileSync(manualPath)
  } catch {
    return jsonSafe({
      paperId,
      outcome: 'failed',
      attempts: [],
      reason: `manualPdfPath 不存在或不可读：${manualPath}`,
    })
  }
  if (buf.length < PDF_MAGIC.length || !buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return jsonSafe({
      paperId,
      outcome: 'failed',
      attempts: [{ source: 'manual', url: manualPath, status: 'not_pdf' }],
      reason: `手动提供的文件不是 PDF（缺少 %PDF- 文件头）：${manualPath}`,
    })
  }
  if (buf.length < minBytes) {
    return jsonSafe({
      paperId,
      outcome: 'failed',
      attempts: [{ source: 'manual', url: manualPath, status: 'too_small' }],
      reason: `手动提供的 PDF 过小：${buf.length}B < ${minBytes}B`,
    })
  }
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const pdfPath = join(rt.pdfsDir, `${sha256}.pdf`)
  mkdirSync(rt.pdfsDir, { recursive: true })
  copyFileSync(manualPath, pdfPath)
  const pdfSource = `manual: ${manualPath}`
  rt.db
    .prepare(
      `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access)
       VALUES (?, ?, 'PDF_OK', ?, ?, ?, 'manual', 0)`,
    )
    .run(
      paperId,
      JSON.stringify([{ source: 'manual', url: manualPath, status: 'ok' }]),
      pdfPath,
      pdfSource,
      sha256,
    )
  return {
    paperId,
    outcome: 'PDF_OK',
    pdfPath,
    sha256,
    pdfSource,
    accessType: 'manual',
    isOpenAccess: false,
    attempts: [{ source: 'manual', url: manualPath, status: 'ok' }],
    reason: '用户手动下载的 PDF 已登记（source=manual，非 OA，仅私人文献库）',
  }
}
