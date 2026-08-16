/**
 * Tool: literature_pdf_preflight — cheap full-text availability check for the
 * selection loop. Probes PDF candidates with bounded fetches (no file
 * written). The agent tries Top-K candidates in rank order and selects the
 * highest-ranked paper that passes the quality gates AND this preflight.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { getPaper } from '../db.js'
import { preflightPdf, type PreflightProbe } from '../fetch/pdf.js'
import { rowToRef } from './literature_sources.js'

export interface PreflightInput {
  paperId: string
}

export interface PreflightOutput {
  paperId: string
  available: boolean
  candidates: number
  probes: PreflightProbe[]
}

export function defineLiteraturePdfPreflight(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_pdf_preflight',
    description:
      '合法全文可得性 preflight：对论文的全部 PDF 候选做有界探测（不落盘），返回 available。选择协议：按语义排名依次 preflight，取排名最高且 质量门槛达标 + available=true 的论文。',
    parameters: {
      paperId: { type: 'string', required: true, description: '候选论文 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paperId: { type: 'string', required: true },
          available: { type: 'boolean', required: true },
          candidates: { type: 'integer', required: true },
          probes: {
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
                  enum: ['ok', 'http_error', 'not_pdf', 'network_error'],
                },
                http: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value: PreflightOutput) => [
        {
          type: 'text',
          text: value.available
            ? `preflight OK：${value.paperId}（${value.candidates} 个候选源）`
            : `preflight FAIL：${value.paperId}（${value.candidates} 个候选源均不可得：${value.probes.map((p) => `${p.source}:${p.status}`).join(', ')}）`,
        },
      ],
    },
    async execute(args: PreflightInput): Promise<PreflightOutput> {
      const rt = getRt()
      const row = getPaper(rt.db, args.paperId)
      if (!row) {
        return { paperId: args.paperId, available: false, candidates: 0, probes: [] }
      }
      const paper = rowToRef(row)
      const candidates = await rt.registry.pdfCandidates(paper)
      const result = await preflightPdf(candidates, {
        timeoutMs: rt.cfg.http.timeoutMs,
        fetchImpl: rt.fetchImpl,
      })
      return { paperId: args.paperId, available: result.available, candidates: candidates.length, probes: result.probes }
    },
  })
}
