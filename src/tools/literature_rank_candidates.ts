/**
 * Tool: literature_rank_candidates — persist one batched semantic-ranking
 * result before acquisition. This turns the LLM's quality judgement into a
 * deterministic, database-backed order that preflight/fetch must obey.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { jsonSafe } from '../lib/json_safe.js'
import { getPush } from '../lib/history.js'
import { stageDef } from '../lib/stages.js'
import { persistSemanticScores, type SemanticScoreEntry } from '../lib/selection.js'

export interface RankCandidatesInput {
  pushId: number
  scores: SemanticScoreEntry[]
  agentRankingMs?: number
  llmCallCount?: number
  llmRetryCount?: number
}

export function defineLiteratureRankCandidates(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_rank_candidates',
    description:
      '保存一次 BATCH 语义评分并生成确定性 agentRank。必须在任何 PDF preflight/fetch 之前调用；随后 acquisition 工具会硬性要求按最高质量门达标 Rank 逐篇处理，禁止跳 Rank。',
    parameters: {
      pushId: { type: 'integer', required: true },
      agentRankingMs: { type: 'number' },
      llmCallCount: { type: 'integer' },
      llmRetryCount: { type: 'integer' },
      scores: {
        type: 'array',
        required: true,
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pushId: { type: 'integer', required: true },
          scoredCount: { type: 'integer', required: true },
          eligibleCount: { type: 'integer', required: true },
          ranked: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paperId: { type: 'string', required: true },
                agentRank: { type: 'integer', required: true },
                finalScore: { type: 'number', required: true },
                stageRelevance: { type: 'number', required: true },
                curriculumValue: { type: 'number', required: true },
                qualityPassed: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: any) => [{
        type: 'text',
        text: `push #${value.pushId} 已固化语义排名：评分 ${value.scoredCount} 篇，质量门达标 ${value.eligibleCount} 篇。下一步只能从最高排名达标候选开始 acquisition。`,
      }],
    },
    async execute(args: RankCandidatesInput) {
      const rt = getRt()
      const push = getPush(rt.db, args.pushId)
      if (!push) throw new Error(`push #${args.pushId} 不存在`)
      if (!['running', 'user_action_required', 'auth_required'].includes(push.status)) {
        throw new Error(`push #${args.pushId} 状态 ${push.status} 不允许重新评分`)
      }
      const def = stageDef(rt.cfg.stageOrder, push.stage)
      const ranked = persistSemanticScores(rt.db, args.pushId, args.scores, rt.cfg, def?.curriculumWeight)
      rt.perf.add(args.pushId, {
        agentRankingMs: args.agentRankingMs ?? 0,
        agentScoredCandidates: args.scores.length,
        llmCallCount: args.llmCallCount ?? 0,
        llmRetryCount: args.llmRetryCount ?? 0,
      })
      return jsonSafe({
        pushId: args.pushId,
        scoredCount: ranked.length,
        eligibleCount: ranked.filter(
          (c) => c.stageRelevance >= rt.cfg.stageRelevanceThreshold && c.curriculumValue >= rt.cfg.curriculumValueThreshold,
        ).length,
        ranked: ranked.map((c) => ({
          paperId: c.paperId,
          agentRank: c.agentRank,
          finalScore: c.finalScore,
          stageRelevance: c.stageRelevance,
          curriculumValue: c.curriculumValue,
          qualityPassed:
            c.stageRelevance >= rt.cfg.stageRelevanceThreshold && c.curriculumValue >= rt.cfg.curriculumValueThreshold,
        })),
      })
    },
  })
}
