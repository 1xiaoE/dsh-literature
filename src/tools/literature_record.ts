/**
 * Tool: literature_record — finalize a push: status transition, semantic
 * ranking trace (Stage B scores recorded by the agent, including
 * stage_relevance_score), picked paper, provenance (report path / model
 * route), and stage progression.
 *
 * Stage gates (per design):
 * - A paper below stageRelevanceThreshold (or missing its score) is NOT
 *   pickable as Top 1 — literature_record rejects it so the agent must
 *   choose a stage-matched paper or report no_candidate.
 * - Stage progression counts ONLY stage-matched completed picks.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { getPush } from '../lib/history.js'
import { agentFinalScore } from '../lib/ranking.js'
import { recordPaperInStage, getStage, stageLabel } from '../lib/stages.js'

export type PushStatus = 'completed' | 'failed' | 'no_candidate' | 'fulltext_unavailable'

export interface RecordScoreEntry {
  paperId: string
  relevance: number
  learningValue: number
  representativeness: number
  novelty: number
  stageRelevance: number
  rationale: string
}

export interface RecordInput {
  pushId: number
  status: PushStatus
  paperId?: string
  reportPath?: string
  errorCode?: string
  errorDetail?: string
  scores?: RecordScoreEntry[]
  advanceStage?: boolean
  notes?: string
}

export interface RecordOutput {
  pushId: number
  status: PushStatus
  stage: number
  stageLabel: string
  papersInStage: number
  targetPapers: number
  stageAdvanced: boolean
  duplicate: boolean
  stageMatched: boolean
}

export function defineLiteratureRecord(getRt: () => LiteratureRuntime, modelRoute: () => string | null) {
  return defineTool({
    name: 'literature_record',
    description:
      '结束一次推送：写入状态（completed/failed/no_candidate/fulltext_unavailable）、语义排序评分追溯（relevance/learning_value/representativeness/novelty/stage_relevance + rationale）、选中论文与溯源。阶段门控：stage_relevance 低于阈值的论文不可选为 Top 1；阶段推进只统计符合当前阶段的成功论文（advanceStage=true 强制推进）。',
    parameters: {
      pushId: { type: 'integer', required: true, description: '推送号（literature_push_now / literature_sources 返回）' },
      status: {
        type: 'string',
        required: true,
        enum: ['completed', 'failed', 'no_candidate', 'fulltext_unavailable'],
        description: '推送结果状态',
      },
      paperId: { type: 'string', description: '选中的论文 id（completed 时必填）' },
      reportPath: { type: 'string', description: '精读报告归档路径（provenance）' },
      errorCode: { type: 'string', description: '失败码（failed 时）' },
      errorDetail: { type: 'string', description: '失败详情' },
      advanceStage: { type: 'boolean', description: '强制推进到下一阶段（人工切换）' },
      notes: { type: 'string', description: '备注' },
      scores: {
        type: 'array',
        description: '语义排序评分追溯（0~1，含 stage_relevance；picked 论文必须 ≥ 阈值）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            paperId: { type: 'string', required: true },
            relevance: { type: 'number', required: true },
            learningValue: { type: 'number', required: true },
            representativeness: { type: 'number', required: true },
            novelty: { type: 'number', required: true },
            stageRelevance: { type: 'number', required: true },
            rationale: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pushId: { type: 'integer', required: true },
          status: { type: 'string', required: true },
          stage: { type: 'integer', required: true },
          stageLabel: { type: 'string', required: true },
          papersInStage: { type: 'integer', required: true },
          targetPapers: { type: 'integer', required: true },
          stageAdvanced: { type: 'boolean', required: true },
          duplicate: { type: 'boolean', required: true },
          stageMatched: { type: 'boolean', required: true },
        },
      },
      render: (_args, value: RecordOutput) => [
        {
          type: 'text',
          text: `push #${value.pushId} → ${value.status}；阶段「${value.stageLabel}」进度 ${value.papersInStage}/${value.targetPapers}${value.stageAdvanced ? '（已推进到下一阶段）' : ''}${value.duplicate ? '（重复推荐，不计阶段进度）' : ''}${value.stageMatched ? '' : '（与当前阶段不匹配，不计阶段进度）'}`,
        },
      ],
    },
    async execute(args: RecordInput): Promise<RecordOutput> {
      const rt = getRt()
      const { db, cfg } = rt
      const push = getPush(db, args.pushId)
      if (!push) {
        throw new Error(`push #${args.pushId} 不存在`)
      }
      const topic = push.topic

      // --- semantic ranking trace (Stage B) ---
      if (args.scores && args.scores.length > 0) {
        const update = db.prepare(
          `UPDATE candidates SET
             relevance_score = ?, learning_value_score = ?, representative_score = ?,
             novelty_score = ?, stage_relevance_score = ?, final_score = ?, rationale = ?
           WHERE push_id = ? AND paper_id = ?`,
        )
        for (const s of args.scores) {
          const final = agentFinalScore(
            {
              relevance: s.relevance,
              learningValue: s.learningValue,
              representativeness: s.representativeness,
              novelty: s.novelty,
              stageRelevance: s.stageRelevance,
            },
            cfg,
          )
          update.run(
            s.relevance,
            s.learningValue,
            s.representativeness,
            s.novelty,
            s.stageRelevance,
            final,
            s.rationale,
            args.pushId,
            s.paperId,
          )
        }
      }

      // --- stage relevance gate: below-threshold papers are not pickable ---
      let stageMatched = false
      if (args.status === 'completed' && args.paperId) {
        const row = db
          .prepare('SELECT stage_relevance_score FROM candidates WHERE push_id = ? AND paper_id = ?')
          .get(args.pushId, args.paperId) as { stage_relevance_score: number | null } | undefined
        const score = row?.stage_relevance_score ?? null
        if (score === null) {
          throw new Error(
            `stage_relevance_score 缺失：论文 ${args.paperId} 未在 scores 中提供 stage_relevance。请为 picked 论文记录 stageRelevance 评分后再提交。`,
          )
        }
        if (score < cfg.stageRelevanceThreshold) {
          throw new Error(
            `stage_relevance_score=${score} 低于阈值 ${cfg.stageRelevanceThreshold}：该论文不得选为 Top 1（即使 overall impact 很高）。请改选符合当前阶段的论文，或以 no_candidate 结束。`,
          )
        }
        stageMatched = true
      }

      // --- status + provenance ---
      db.prepare(
        `UPDATE pushes SET status = ?, finished_at = datetime('now'), paper_id = ?,
           report_path = ?, error_code = ?, error_detail = ?, notes = ?, model_route = ?
         WHERE id = ?`,
      ).run(
        args.status,
        args.paperId ?? null,
        args.reportPath ?? null,
        args.errorCode ?? null,
        args.errorDetail ?? null,
        args.notes ?? null,
        modelRoute(),
        args.pushId,
      )

      // --- stage progression: only stage-matched completed picks count ---
      let advanced = false
      let duplicate = false
      if (args.status === 'completed' && args.paperId) {
        const seenBefore = db
          .prepare(
            `SELECT 1 FROM candidates c JOIN pushes p ON p.id = c.push_id
             WHERE p.topic = ? AND c.paper_id = ? AND c.picked = 1 AND p.status = 'completed'`,
          )
          .get(topic, args.paperId)
        duplicate = Boolean(seenBefore)
        db.prepare('UPDATE candidates SET picked = 1 WHERE push_id = ? AND paper_id = ?').run(
          args.pushId,
          args.paperId,
        )
        if (!duplicate && stageMatched) {
          const res = recordPaperInStage(db, topic, {
            targetPapers: cfg.targetPapersPerStage,
            forceAdvance: args.advanceStage ?? false,
          })
          advanced = res.advanced
        } else if (args.advanceStage) {
          // manual switch is allowed regardless of match
          const res = recordPaperInStage(db, topic, {
            targetPapers: cfg.targetPapersPerStage,
            forceAdvance: true,
          })
          advanced = res.advanced
        }
      }

      const stage = getStage(db, topic)
      return {
        pushId: args.pushId,
        status: args.status,
        stage: stage.current,
        stageLabel: stageLabel(cfg.stageOrder, stage.current),
        papersInStage: stage.papersInStage,
        targetPapers: stage.targetPapers,
        stageAdvanced: advanced,
        duplicate,
        stageMatched,
      } satisfies RecordOutput
    },
  })
}
