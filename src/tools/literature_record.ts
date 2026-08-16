/**
 * Tool: literature_record — finalize a push: status transition, semantic
 * ranking trace (Stage B scores incl. stage_relevance + curriculum_value +
 * methodological_centrality), selection attempt trail, knowledge-goal
 * coverage, provenance, and stage progression.
 *
 * Gates:
 * - picked paper must pass BOTH stage_relevance >= threshold AND
 *   curriculum_value >= threshold (below either → reject, even with high
 *   overall impact or easy fulltext).
 * - selection trail (selection_rank / selection_outcome /
 *   selection_rejection_reason) is recorded per tried candidate.
 * - stage advancement requires target paper count AND minimum knowledge
 *   coverage (union of goals covered by stage-matched picks).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { getPush } from '../lib/history.js'
import { agentFinalScore } from '../lib/ranking.js'
import { recordPaperInStage, getStage, stageLabel, stageDef } from '../lib/stages.js'

export type PushStatus = 'completed' | 'failed' | 'no_candidate' | 'fulltext_unavailable'
export type SelectionOutcome = 'SELECTED' | 'FULLTEXT_UNAVAILABLE' | 'BELOW_QUALITY_GATE' | 'PDF_FAILED'

export interface RecordScoreEntry {
  paperId: string
  relevance: number
  learningValue: number
  representativeness: number
  novelty: number
  stageRelevance: number
  curriculumValue: number
  methodologicalCentrality?: number
  rationale: string
}

export interface SelectionEntry {
  paperId: string
  /** agent semantic ranking position of this paper (agent_rank) */
  agentRank: number
  /** order in which this paper was preflight-attempted (1-based) */
  attemptOrder: number
  outcome: SelectionOutcome
  reason?: string
}

export interface RecordInput {
  pushId: number
  status: PushStatus
  paperId?: string
  reportPath?: string
  errorCode?: string
  errorDetail?: string
  scores?: RecordScoreEntry[]
  selection?: SelectionEntry[]
  knowledgeGoals?: string[]
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
  coveredGoals: string[]
  stageAdvanced: boolean
  duplicate: boolean
  stageMatched: boolean
  readsCount: number
}

export function defineLiteratureRecord(getRt: () => LiteratureRuntime, modelRoute: () => string | null) {
  return defineTool({
    name: 'literature_record',
    description:
      '结束一次推送：写入状态、语义排序评分追溯（relevance/learning_value/representativeness/novelty/stage_relevance/curriculum_value/methodological_centrality + rationale）、selection 尝试轨迹（rank/outcome/reason）、知识目标覆盖（knowledgeGoals）与溯源。门控：picked 论文须 stage_relevance ≥ 阈值 且 curriculum_value ≥ 阈值；阶段推进须同时满足目标篇数与最小知识覆盖（advanceStage=true 强制推进）。',
    parameters: {
      pushId: { type: 'integer', required: true, description: '推送号' },
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
      knowledgeGoals: {
        type: 'array',
        items: { type: 'string' },
        description: '本论文覆盖的知识目标 id（completed 时必填）',
      },
      scores: {
        type: 'array',
        description: '语义排序评分追溯（0~1；picked 论文须 stageRelevance 与 curriculumValue 均 ≥ 阈值）',
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
            curriculumValue: { type: 'number', required: true },
            methodologicalCentrality: { type: 'number' },
            rationale: { type: 'string', required: true },
          },
        },
      },
      selection: {
        type: 'array',
        description:
          '全文预检选择轨迹：每篇被尝试的论文记录 agentRank（语义排名）与 attemptOrder（预检顺序，1 起连续）。不变式：SELECTED 出现后不得再有更高 attemptOrder 的条目；每 push 至多一个 SELECTED。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            paperId: { type: 'string', required: true },
            agentRank: { type: 'integer', required: true, description: 'agent 语义排名（1 = 最高）' },
            attemptOrder: { type: 'integer', required: true, description: '预检尝试顺序（1-based，连续）' },
            outcome: {
              type: 'string',
              required: true,
              enum: ['SELECTED', 'FULLTEXT_UNAVAILABLE', 'BELOW_QUALITY_GATE', 'PDF_FAILED'],
            },
            reason: { type: 'string' },
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
          coveredGoals: { type: 'array', items: { type: 'string' }, required: true },
          stageAdvanced: { type: 'boolean', required: true },
          duplicate: { type: 'boolean', required: true },
          stageMatched: { type: 'boolean', required: true },
          readsCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value: RecordOutput) => [
        {
          type: 'text',
          text: `push #${value.pushId} → ${value.status}；阶段「${value.stageLabel}」进度 ${value.papersInStage}/${value.targetPapers}（覆盖 ${value.coveredGoals.join(',') || '无'}）${value.stageAdvanced ? '（已推进到下一阶段）' : ''}${value.duplicate ? '（重复推荐，不计进度）' : ''}${value.stageMatched ? '' : '（与当前阶段不匹配，不计进度）'}`,
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
      const stageDefNow = stageDef(cfg.stageOrder, push.stage)
      const curriculumWeight = stageDefNow?.curriculumWeight

      // --- semantic ranking trace (Stage B) ---
      if (args.scores && args.scores.length > 0) {
        const update = db.prepare(
          `UPDATE candidates SET
             relevance_score = ?, learning_value_score = ?, representative_score = ?,
             novelty_score = ?, stage_relevance_score = ?, curriculum_value = ?,
             methodological_centrality = ?, final_score = ?, rationale = ?
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
              curriculumValue: s.curriculumValue,
            },
            cfg,
            curriculumWeight,
          )
          update.run(
            s.relevance,
            s.learningValue,
            s.representativeness,
            s.novelty,
            s.stageRelevance,
            s.curriculumValue,
            s.methodologicalCentrality ?? null,
            final,
            s.rationale,
            args.pushId,
            s.paperId,
          )
        }
      }

      // --- selection trail (invariant-enforced) ---
      if (args.status === 'fulltext_unavailable' && (!args.selection || args.selection.length === 0)) {
        throw new Error(
          'fulltext_unavailable 必须提交 selection 轨迹（全部尝试的候选、agentRank、attemptOrder、outcome 与原因）',
        )
      }
      if (args.selection && args.selection.length > 0) {
        const sorted = [...args.selection].sort((a, b) => a.attemptOrder - b.attemptOrder)
        const orders = sorted.map((s) => s.attemptOrder)
        for (let i = 0; i < orders.length; i += 1) {
          if (orders[i] !== i + 1) {
            throw new Error(`attemptOrder 必须从 1 连续递增：${JSON.stringify(orders)}`)
          }
        }
        const selectedCount = sorted.filter((s) => s.outcome === 'SELECTED').length
        if (selectedCount > 1) {
          throw new Error('invariant: 每个 push 至多一个 SELECTED')
        }
        const selectedIdx = sorted.findIndex((s) => s.outcome === 'SELECTED')
        if (selectedIdx !== -1 && selectedIdx !== sorted.length - 1) {
          throw new Error(
            'invariant: SELECTED 出现后不得再对更低排名候选执行 preflight/download',
          )
        }
        const updateSel = db.prepare(
          `UPDATE candidates SET agent_rank = ?, preflight_attempt_order = ?,
             selection_outcome = ?, selection_rejection_reason = ?
           WHERE push_id = ? AND paper_id = ?`,
        )
        for (const s of sorted) {
          updateSel.run(s.agentRank, s.attemptOrder, s.outcome, s.reason ?? null, args.pushId, s.paperId)
        }
      }

      // --- agent_rank for scored candidates WITHOUT an explicit selection rank ---
      if (args.scores && args.scores.length > 0) {
        db.exec(
          `UPDATE candidates SET agent_rank = (
             SELECT 1 + COUNT(*) FROM candidates c2
             WHERE c2.push_id = candidates.push_id AND c2.final_score > candidates.final_score
           ) WHERE push_id = ${args.pushId} AND final_score IS NOT NULL AND agent_rank IS NULL`,
        )
      }

      // --- quality gates: picked paper must pass stage AND curriculum ---
      let stageMatched = false
      let readsCount = 0
      if (args.status === 'completed' && args.paperId) {
        // full-text reading coverage: the picked paper must have been read
        // chunk-by-chunk through literature_fulltext_read within this push
        readsCount = (
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM fulltext_reads WHERE push_id = ? AND paper_id = ?',
            )
            .get(args.pushId, args.paperId) as { n: number }
        ).n
        const ft = db
          .prepare("SELECT chunk_count FROM fulltexts WHERE paper_id = ? AND status = 'ok'")
          .get(args.paperId) as { chunk_count: number } | undefined
        if (ft && ft.chunk_count > 0 && readsCount === 0) {
          throw new Error(
            `picked 论文 ${args.paperId} 尚未通过 literature_fulltext_read 阅读任何 chunk（全文 ${ft.chunk_count} 块）；完成前请先逐块精读`,
          )
        }
        if (args.selection) {
          const pickedSel = args.selection.find((s) => s.paperId === args.paperId)
          if (!pickedSel || pickedSel.outcome !== 'SELECTED') {
            throw new Error(
              `picked 论文 ${args.paperId} 必须在其 selection 条目中标记为 SELECTED（当前：${pickedSel?.outcome ?? '缺失'}）`,
            )
          }
        }
        const row = db
          .prepare(
            'SELECT stage_relevance_score, curriculum_value FROM candidates WHERE push_id = ? AND paper_id = ?',
          )
          .get(args.pushId, args.paperId) as
          | { stage_relevance_score: number | null; curriculum_value: number | null }
          | undefined
        if (!row || row.stage_relevance_score === null || row.curriculum_value === null) {
          throw new Error(
            `评分缺失：论文 ${args.paperId} 必须同时提供 stageRelevance 与 curriculumValue 评分。`,
          )
        }
        if (row.stage_relevance_score < cfg.stageRelevanceThreshold) {
          throw new Error(
            `stage_relevance_score=${row.stage_relevance_score} 低于阈值 ${cfg.stageRelevanceThreshold}：该论文不得选为 Top 1。`,
          )
        }
        if (row.curriculum_value < cfg.curriculumValueThreshold) {
          throw new Error(
            `curriculum_value=${row.curriculum_value} 低于阈值 ${cfg.curriculumValueThreshold}：该论文对当前阶段的课程价值不足，不得选为 Top 1（不得因 PDF 可获取而选择低课程价值论文）。`,
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

      // --- knowledge coverage + stage progression ---
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

        const goals = args.knowledgeGoals ?? []
        if (goals.length > 0 && !duplicate) {
          const ins = db.prepare(
            'INSERT OR IGNORE INTO knowledge_coverage (push_id, paper_id, goal) VALUES (?, ?, ?)',
          )
          for (const g of goals) ins.run(args.pushId, args.paperId, g)
        }

        if (!duplicate) {
          const res = recordPaperInStage(db, topic, {
            targetPapers: cfg.targetPapersPerStage,
            minCoverage: cfg.minKnowledgeCoverage,
            coveredGoals: goals,
            forceAdvance: args.advanceStage ?? false,
          })
          advanced = res.advanced
        } else if (args.advanceStage) {
          const res = recordPaperInStage(db, topic, {
            targetPapers: cfg.targetPapersPerStage,
            minCoverage: cfg.minKnowledgeCoverage,
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
        coveredGoals: stage.coveredGoals,
        stageAdvanced: advanced,
        duplicate,
        stageMatched,
        readsCount,
      } satisfies RecordOutput
    },
  })
}
