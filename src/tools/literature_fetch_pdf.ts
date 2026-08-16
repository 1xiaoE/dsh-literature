/**
 * Tool: literature_fetch_pdf — download a paper's PDF with multi-source
 * fallback. When no source yields a valid PDF the outcome is
 * FULLTEXT_UNAVAILABLE; the full attempt trail is persisted.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { getPaper } from '../db.js'
import { fetchPdf, type FetchAttempt } from '../fetch/pdf.js'
import { rowToRef } from './literature_sources.js'
import { inRetryCooldown } from '../fetch/pdf.js'

export interface FetchPdfInput {
  paperId: string
  pushId?: number
}

export interface FetchPdfOutput {
  paperId: string
  outcome: 'ok' | 'FULLTEXT_UNAVAILABLE' | 'failed'
  pdfPath?: string
  sha256?: string
  pdfSource?: string
  attempts: FetchAttempt[]
  reason?: string
}

export function defineLiteratureFetchPdf(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_fetch_pdf',
    description:
      '多源回退下载论文 PDF（arXiv → OpenAlex OA → Crossref 出版社链接），落盘到数据目录并记录 sha256 与来源溯源；全部失败时 outcome=FULLTEXT_UNAVAILABLE。',
    parameters: {
      paperId: { type: 'string', required: true, description: '候选论文 id（来自 literature_sources）' },
      pushId: { type: 'integer', description: '推送号；提供时执行 SELECTED 不变式检查' },
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
            enum: ['ok', 'FULLTEXT_UNAVAILABLE', 'failed'],
          },
          pdfPath: { type: 'string' },
          sha256: { type: 'string' },
          pdfSource: { type: 'string' },
          reason: { type: 'string' },
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
                  enum: ['ok', 'http_error', 'not_pdf', 'too_small', 'network_error', 'skipped'],
                },
                http: { type: 'integer' },
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
              ? `PDF 下载成功：${value.pdfSource} (sha256=${value.sha256?.slice(0, 12)}…)`
              : value.outcome === 'FULLTEXT_UNAVAILABLE'
                ? `FULLTEXT_UNAVAILABLE：${value.attempts.length} 个源均失败。${value.attempts.map((a) => `${a.source}:${a.status}`).join(', ')}`
                : `失败：${value.reason ?? '未知原因'}`,
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
      const paper = rowToRef(row)
      const candidates = await rt.registry.pdfCandidates(paper)
      if (candidates.length === 0) {
        return {
          paperId: args.paperId,
          outcome: 'FULLTEXT_UNAVAILABLE',
          attempts: [],
          reason: 'no legal PDF candidate from any adapter',
        }
      }
      const result = await fetchPdf(rt.db, args.paperId, candidates, rt.pdfsDir, {
        timeoutMs: rt.cfg.http.timeoutMs,
        minPdfBytes: rt.cfg.http.minPdfBytes,
        fetchImpl: rt.fetchImpl,
      })
      return { paperId: args.paperId, ...result }
    },
  })
}
