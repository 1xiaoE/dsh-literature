/**
 * Tool: literature_fetch_pdf — download a paper's PDF with multi-source
 * fallback: public/OA chain (arxiv → openalex OA → unpaywall → crossref
 * publisher links) first; when the agent explicitly opts in (allowCarsi) and
 * all public sources failed for a quality-gated paper, the CARSI
 * institutional-access provider is consulted as the LAST resort.
 *
 * Terminals: ok (public) / PDF_OK (CARSI) / AUTH_REQUIRED (session broken —
 * NEVER a paper-level cooldown; user must re-login) / ACCESS_DENIED /
 * PDF_NOT_FOUND / FULLTEXT_UNAVAILABLE. The full attempt trail is persisted.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { getPaper } from '../db.js'
import { fetchPdf, inRetryCooldown, type FetchAttempt } from '../fetch/pdf.js'
import { rowToRef } from './literature_sources.js'

export interface FetchPdfInput {
  paperId: string
  pushId?: number
  /**
   * Opt into the institutional-access fallback (CARSI) for this paper.
   * MUST only be set after (a) the paper passed the ranking quality gates and
   * (b) every public/open-access fulltext source failed. CARSI is never a
   * batch/bulk source — strict low-frequency gates apply.
   */
  allowCarsi?: boolean
  /**
   * Human-in-the-loop: the user manually downloaded the PDF (e.g. via the
   * CARSI headed login or a publisher's human flow). The file is validated
   * (%PDF- magic, size), hashed and registered as pdfs/<sha256>.pdf with
   * provenance source=manual (NOT open access).
   */
  manualPdfPath?: string
}

export interface FetchPdfOutput {
  paperId: string
  outcome: 'ok' | 'PDF_OK' | 'AUTH_REQUIRED' | 'ACCESS_DENIED' | 'PDF_NOT_FOUND' | 'FULLTEXT_UNAVAILABLE' | 'failed'
  pdfPath?: string
  sha256?: string
  pdfSource?: string
  accessType?: 'oa' | 'institutional'
  isOpenAccess?: boolean
  attempts: FetchAttempt[]
  reason?: string
  /** set when the user must act (e.g. re-run the CARSI login CLI) */
  userAction?: 'carsi_relogin'
}

/** How many CARSI PDF_OK successes this push already has (maxPerPush cap). */
function carsiSuccessCount(rt: LiteratureRuntime, pushId: number): number {
  const row = rt.db
    .prepare(
      `SELECT COUNT(*) AS n FROM fetch_log f
       JOIN candidates c ON c.paper_id = f.paper_id
       WHERE c.push_id = ? AND f.outcome = 'PDF_OK'`,
    )
    .get(pushId) as { n: number }
  return row?.n ?? 0
}

export function defineLiteratureFetchPdf(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_fetch_pdf',
    description:
      '多源回退下载论文 PDF：公开/OA 链（arXiv → OpenAlex OA → Unpaywall → Crossref 出版社链接）；全部失败且传入 allowCarsi=true（仅限已过质量门、公开全文全失败的论文）时，最后尝试 CARSI 机构授权（非 OA、低频）。终态：ok / PDF_OK / AUTH_REQUIRED（会话失效，需人工重新登录 CARSI）/ ACCESS_DENIED / PDF_NOT_FOUND / FULLTEXT_UNAVAILABLE。',
    parameters: {
      paperId: { type: 'string', required: true, description: '候选论文 id（来自 literature_sources）' },
      pushId: { type: 'integer', description: '推送号；提供时执行 SELECTED 不变式检查' },
      allowCarsi: {
        type: 'boolean',
        description:
          '公开/OA 全失败后是否允许 CARSI 机构授权兜底（仅限质量门达标论文；严格低频，默认不传）',
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
            enum: ['ok', 'PDF_OK', 'AUTH_REQUIRED', 'ACCESS_DENIED', 'PDF_NOT_FOUND', 'FULLTEXT_UNAVAILABLE', 'failed'],
          },
          pdfPath: { type: 'string' },
          sha256: { type: 'string' },
          pdfSource: { type: 'string' },
          accessType: { type: 'string', enum: ['oa', 'institutional'] },
          isOpenAccess: { type: 'boolean' },
          reason: { type: 'string' },
          userAction: { type: 'string', enum: ['carsi_relogin'] },
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
                  enum: ['ok', 'http_error', 'not_pdf', 'too_small', 'network_error', 'skipped', 'auth_required', 'access_denied', 'not_found'],
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
                ? `PDF 下载成功（CARSI 机构授权，非 OA，仅私人文献库）：${value.pdfSource} (sha256=${value.sha256?.slice(0, 12)}…)`
                : value.outcome === 'AUTH_REQUIRED'
                  ? `AUTH_REQUIRED：CARSI 机构会话缺失或已失效（${value.attempts.filter((a) => a.status === 'auth_required').map((a) => a.detail).join('; ') || '详见 attempts'}）。请运行 dsh-literature-carsi-login 重新登录 CARSI 后重试；本次不进入 cooldown。`
                  : value.outcome === 'FULLTEXT_UNAVAILABLE'
                    ? `FULLTEXT_UNAVAILABLE：${value.attempts.length} 个源均失败。${value.attempts.map((a) => `${a.source}:${a.status}${a.detail ? `(${a.detail})` : ''}`).join(', ')}`
                    : `失败（${value.outcome}）：${value.reason ?? '未知原因'}。${value.attempts.map((a) => `${a.source}:${a.status}`).join(', ')}`,
        },
      ],
    },
    async execute(args: FetchPdfInput): Promise<FetchPdfOutput> {
      const rt = getRt()
      if (args.pushId !== undefined) {
        const selected = rt.db
          .prepare(
            "SELECT paper_id FROM candidates WHERE push_id = ? AND selection_outcome = 'SELECTED'",
          )
          .all(args.pushId) as Array<{ paper_id: string }>
        const selOther = selected.find((s) => s.paper_id !== args.paperId)
        if (selOther) {
          return {
            paperId: args.paperId,
            outcome: 'failed',
            attempts: [],
            reason: `invariant: push #${args.pushId} 已 SELECTED ${selOther.paper_id}；禁止对更低排名候选执行下载`,
          }
        }
      }
      const cooldown = inRetryCooldown(rt.db, args.paperId, rt.cfg.fulltext.retryCooldownHours)
      if (cooldown) {
        return {
          paperId: args.paperId,
          outcome: 'failed',
          attempts: [],
          reason: `FULLTEXT_UNAVAILABLE retry cooldown (until ${cooldown})`,
        }
      }
      const row = getPaper(rt.db, args.paperId)
      if (!row) {
        return {
          paperId: args.paperId,
          outcome: 'failed',
          attempts: [],
          reason: 'paper not found — 先运行 literature_sources 生成候选',
        }
      }

      // Human-in-the-loop: user manually downloaded the PDF — validate,
      // hash and register it directly (skips the automatic chain).
      if (args.manualPdfPath) {
        return registerManualPdf(rt, args.paperId, args.manualPdfPath)
      }

      const paper = rowToRef(row)
      const candidates = await rt.registry.pdfCandidates(paper)
      if (candidates.length === 0 && !(args.allowCarsi && rt.carsi)) {
        return {
          paperId: args.paperId,
          outcome: 'FULLTEXT_UNAVAILABLE',
          attempts: [],
          reason: 'no legal PDF candidate from any adapter',
        }
      }

      // CARSI provider chain: opt-in + enabled + maxPerPush success cap.
      // (minIntervalMinutes spacing is enforced inside the provider ledger.)
      let providers: NonNullable<Parameters<typeof fetchPdf>[4]>['providers'] = []
      let capBlocked = false
      if (args.allowCarsi && rt.carsi) {
        const maxPerPush = rt.cfg.carsi.maxPerPush
        const done = args.pushId !== undefined ? carsiSuccessCount(rt, args.pushId) : 0
        if (done >= maxPerPush) {
          capBlocked = true
        } else {
          providers = rt.providers
        }
      }

      const result = await fetchPdf(rt.db, args.paperId, candidates, rt.pdfsDir, {
        timeoutMs: rt.cfg.http.timeoutMs,
        minPdfBytes: rt.cfg.http.minPdfBytes,
        fetchImpl: rt.fetchImpl,
        providers,
        paper,
      })
      const out: FetchPdfOutput = { paperId: args.paperId, ...result }
      if (capBlocked && result.outcome === 'FULLTEXT_UNAVAILABLE') {
        out.reason = `CARSI 每推送上限已满（carsi.maxPerPush=${rt.cfg.carsi.maxPerPush}），本次未尝试机构授权`
      }
      if (result.outcome === 'AUTH_REQUIRED') out.userAction = 'carsi_relogin'
      return out
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
    return {
      paperId,
      outcome: 'failed',
      attempts: [],
      reason: `manualPdfPath 不存在或不可读：${manualPath}`,
    }
  }
  if (buf.length < PDF_MAGIC.length || !buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return {
      paperId,
      outcome: 'failed',
      attempts: [{ source: 'manual', url: manualPath, status: 'not_pdf' }],
      reason: `手动提供的文件不是 PDF（缺少 %PDF- 文件头）：${manualPath}`,
    }
  }
  if (buf.length < minBytes) {
    return {
      paperId,
      outcome: 'failed',
      attempts: [{ source: 'manual', url: manualPath, status: 'too_small' }],
      reason: `手动提供的 PDF 过小：${buf.length}B < ${minBytes}B`,
    }
  }
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const pdfPath = join(rt.pdfsDir, `${sha256}.pdf`)
  mkdirSync(rt.pdfsDir, { recursive: true })
  copyFileSync(manualPath, pdfPath)
  const pdfSource = `manual: ${manualPath}`
  rt.db
    .prepare(
      `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source, sha256, is_open_access)
       VALUES (?, ?, 'PDF_OK', ?, ?, ?, 0)`,
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
    isOpenAccess: false,
    attempts: [{ source: 'manual', url: manualPath, status: 'ok' }],
    reason: '用户手动下载的 PDF 已登记（source=manual，非 OA，仅私人文献库）',
  }
}
