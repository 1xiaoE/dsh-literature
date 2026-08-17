/**
 * Tool: literature_pdf_preflight — cheap full-text availability check for the
 * selection loop. Probes PDF candidates with bounded fetches (no file
 * written). The agent tries Top-K candidates in rank order and selects the
 * highest-ranked paper that passes the quality gates AND this preflight.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { jsonSafe } from '../lib/json_safe.js'
import { getPaper } from '../db.js'
import { preflightPdf, type PreflightProbe } from '../fetch/pdf.js'
import { rowToRef } from './literature_sources.js'
import { inRetryCooldown } from '../fetch/pdf.js'
import { allocateAttemptOrder, ensureAcquisitionTurn, markPublicPreflight } from '../lib/selection.js'

export interface PreflightInput {
  paperId: string
  pushId?: number
}

export interface PreflightOutput {
  paperId: string
  available: boolean
  candidates: number
  probes: PreflightProbe[]
  /** invariant guard: a paper was already SELECTED in this push */
  alreadySelected?: boolean
  reason?: string
}

export function defineLiteraturePdfPreflight(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_pdf_preflight',
    description:
      '合法全文 public/OA preflight：必须先调用 literature_rank_candidates 固化语义排名。提供 pushId 时，代码硬性只允许当前最高排名且质量门达标的候选；preflight 失败后仍不得跳 Rank，必须继续同一论文的 literature_fetch_pdf(allowInstitutional=true)。',
    parameters: {
      paperId: { type: 'string', required: true, description: '候选论文 id' },
      pushId: { type: 'integer', description: '推送号；提供时执行 SELECTED 不变式检查' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paperId: { type: 'string', required: true },
          available: { type: 'boolean', required: true },
          candidates: { type: 'integer', required: true },
          alreadySelected: { type: 'boolean' },
          reason: { type: 'string' },
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
      if (args.pushId !== undefined) {
        try {
          const turn = ensureAcquisitionTurn(rt.db, args.pushId, args.paperId, rt.cfg)
          if (turn.publicPreflightStatus) {
            return jsonSafe({
              paperId: args.paperId,
              available: turn.publicPreflightStatus === 'AVAILABLE',
              candidates: 0,
              probes: [],
              reason: `已复用持久化 public preflight=${turn.publicPreflightStatus}；下一步必须继续同一 Rank 的 literature_fetch_pdf`,
            })
          }
        } catch (err) {
          return jsonSafe({
            paperId: args.paperId,
            available: false,
            candidates: 0,
            probes: [],
            alreadySelected: String(err).includes('已 SELECTED'),
            reason: String(err instanceof Error ? err.message : err),
          })
        }
      }
      // retry cooldown: FULLTEXT_UNAVAILABLE outcomes within the TTL are not re-probed
      const cooldown = inRetryCooldown(rt.db, args.paperId, rt.cfg.fulltext.retryCooldownHours)
      if (cooldown) {
        return {
          paperId: args.paperId,
          available: false,
          candidates: 0,
          probes: [],
          reason: `FULLTEXT_UNAVAILABLE retry cooldown (until ${cooldown})`,
        }
      }
      const row = getPaper(rt.db, args.paperId)
      if (!row) {
        return { paperId: args.paperId, available: false, candidates: 0, probes: [] }
      }
      const paper = rowToRef(row)
      const candidates = await rt.registry.pdfCandidates(paper)
      const t0 = performance.now()
      const result = await preflightPdf(candidates, {
        timeoutMs: rt.cfg.http.timeoutMs,
        fetchImpl: rt.fetchImpl,
      })
      const pushId = args.pushId ?? (
        rt.db
          .prepare(
            `SELECT c.push_id FROM candidates c JOIN pushes p ON p.id = c.push_id
             WHERE c.paper_id = ? AND p.status IN ('running','user_action_required') ORDER BY c.push_id DESC LIMIT 1`,
          )
          .get(args.paperId) as { push_id: number } | undefined
      )?.push_id
      if (pushId !== undefined) {
        rt.perf.add(pushId, { pdfPreflightMs: performance.now() - t0 })
        markPublicPreflight(rt.db, pushId, args.paperId, result.available)
        // First real preflight of this rank consumes the acquisition attempt slot.
        allocateAttemptOrder(rt.db, pushId, args.paperId)
      }
      return jsonSafe({ paperId: args.paperId, available: result.available, candidates: candidates.length, probes: result.probes })
    },
  })
}
