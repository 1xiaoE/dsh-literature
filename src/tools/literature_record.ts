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
import { jsonSafe } from '../lib/json_safe.js'
import { getPush } from '../lib/history.js'
import { getStage, stageLabel, stageDef } from '../lib/stages.js'
import { persistSemanticScores, rankedCandidateStates } from '../lib/selection.js'
import { finalizeCompletedPush, readingCoverage } from '../lib/finalize.js'

export type PushStatus =
  | 'completed'
  | 'failed'
  | 'no_candidate'
  | 'fulltext_unavailable'
  | 'auth_required'
  | 'user_action_required'
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
  /** performance audit (agent-side, reported by the agent) */
  agentRankingMs?: number
  reportGenerationMs?: number
  llmCallCount?: number
  llmRetryCount?: number
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
  /** required goals still uncovered — why the stage did not graduate */
  pendingRequiredGoals: string[]
  duplicate: boolean
  stageMatched: boolean
  readsCount: number
  /** full-text reading coverage provenance (completed picks) */
  totalChunks: number
  readChunks: number
  readCoverage: number
  coverageBasis: 'full_read' | 'index_exposed' | 'read_log'
  /** performance audit summary (plugin-timed + agent-reported phases) */
  perfSummary: Record<string, number>
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
        enum: ['completed', 'failed', 'no_candidate', 'fulltext_unavailable', 'auth_required', 'user_action_required'],
        description:
          '推送结果状态。需要用户介入（认证/资源/权限/下载渠道/研究选择）时用 user_action_required（先 literature_user_action open，不得记为 fulltext_unavailable）；CARSI 会话失效可用 auth_required（errorCode=AUTH_REQUIRED）。',
      },
      paperId: { type: 'string', description: '选中的论文 id（completed 时必填）' },
      reportPath: { type: 'string', description: '精读报告归档路径（provenance）' },
      errorCode: { type: 'string', description: '失败码（failed 时）' },
      errorDetail: { type: 'string', description: '失败详情' },
      advanceStage: { type: 'boolean', description: '强制推进到下一阶段（人工切换）' },
      notes: { type: 'string', description: '备注' },
      agentRankingMs: { type: 'number', description: '性能审计：语义排序阶段耗时（ms，agent 自报，允许小数，输出取整）' },
      reportGenerationMs: { type: 'number', description: '性能审计：报告撰写耗时（ms，agent 自报，允许小数，输出取整）' },
      llmCallCount: { type: 'integer', description: '性能审计：本推送 LLM 调用次数（agent 自报；语义排序应批量，目标 1~2 次）' },
      llmRetryCount: { type: 'integer', description: '性能审计：LLM 重试次数' },
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
          pendingRequiredGoals: { type: 'array', items: { type: 'string' }, required: true },
          duplicate: { type: 'boolean', required: true },
          stageMatched: { type: 'boolean', required: true },
          readsCount: { type: 'integer', required: true },
          totalChunks: { type: 'integer', required: true },
          readChunks: { type: 'integer', required: true },
          readCoverage: { type: 'number', required: true },
          coverageBasis: {
            type: 'string',
            required: true,
            enum: ['full_read', 'index_exposed', 'read_log'],
          },
          perfSummary: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              retrievalMs: { type: 'integer' },
              deterministicRankingMs: { type: 'integer' },
              agentRankingMs: { type: 'integer' },
              pdfPreflightMs: { type: 'integer' },
              pdfDownloadMs: { type: 'integer' },
              parsingMs: { type: 'integer' },
              fulltextReadMs: { type: 'integer' },
              reportGenerationMs: { type: 'integer' },
              totalMs: { type: 'integer' },
              rawCandidates: { type: 'integer' },
              deterministicCandidates: { type: 'integer' },
              agentScoredCandidates: { type: 'integer' },
              llmCallCount: { type: 'integer' },
              llmRetryCount: { type: 'integer' },
              pdfAttemptCount: { type: 'integer' },
              arxivRequests: { type: 'integer' },
              arxivDedupHits: { type: 'integer' },
              arxiv429Count: { type: 'integer' },
              arxivRetryCount: { type: 'integer' },
              arxivRateLimited: { type: 'integer' },
              arxivWaitMs: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value: RecordOutput) => [
        {
          type: 'text',
          text: `push #${value.pushId} → ${value.status}；阶段「${value.stageLabel}」进度 ${value.papersInStage}/${value.targetPapers}（覆盖 ${value.coveredGoals.join(',') || '无'}）${value.stageAdvanced ? '（已推进到下一阶段）' : ''}${value.pendingRequiredGoals.length > 0 ? `（required goal pending: ${value.pendingRequiredGoals.join(',')}）` : ''}${value.duplicate ? '（重复推荐，不计进度）' : ''}${value.stageMatched ? '' : '（与当前阶段不匹配，不计进度）'}${value.status === 'completed' ? `；阅读 ${value.readChunks}/${value.totalChunks}（覆盖率 ${value.readCoverage}，basis=${value.coverageBasis}）` : ''}${value.perfSummary.totalMs ? `；性能：检索${value.perfSummary.retrievalMs}ms/预排序${value.perfSummary.deterministicRankingMs}ms/语义排序${value.perfSummary.agentRankingMs}ms/下载${value.perfSummary.pdfDownloadMs}ms/解析${value.perfSummary.parsingMs}ms/精读${value.perfSummary.fulltextReadMs}ms/报告${value.perfSummary.reportGenerationMs}ms/总计${value.perfSummary.totalMs}ms（LLM ${value.perfSummary.llmCallCount} 次，raw ${value.perfSummary.rawCandidates}，Top ${value.perfSummary.deterministicCandidates}）` : ''}`,
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

      // --- semantic ranking trace (Stage B; backward-compatible) ---
      // New workflow persists this earlier through literature_rank_candidates.
      if (args.scores && args.scores.length > 0) {
        persistSemanticScores(db, args.pushId, args.scores, cfg, curriculumWeight)
      }

      // --- selection trail / status invariants ---
      if (args.errorCode === 'AUTH_REQUIRED' && args.status !== 'auth_required' && args.status !== 'user_action_required') {
        throw new Error(
          'errorCode=AUTH_REQUIRED 时 status 必须为 auth_required 或 user_action_required（认证墙≠fulltext_unavailable）',
        )
      }
      if (args.status === 'user_action_required') {
        const open = db
          .prepare("SELECT COUNT(*) AS n FROM user_actions WHERE push_id = ? AND state = 'open'")
          .get(args.pushId) as { n: number }
        if (open.n === 0) {
          throw new Error(
            'status=user_action_required 必须先调用 literature_user_action(open) 注册至少一项待办（五要素）',
          )
        }
      }

      const ranked = rankedCandidateStates(db, args.pushId)
      const eligible = ranked
        .filter((c) => c.stageRelevance >= cfg.stageRelevanceThreshold && c.curriculumValue >= cfg.curriculumValueThreshold)
        .slice(0, cfg.maxSelectionAttempts)
      const persistedTrail = eligible.filter((c) => c.attemptOrder !== null)

      if (args.selection && args.selection.length > 0) {
        const sorted = [...args.selection].sort((a, b) => a.attemptOrder - b.attemptOrder)
        for (let i = 0; i < sorted.length; i += 1) {
          const s = sorted[i]!
          if (s.attemptOrder !== i + 1) {
            throw new Error(`attemptOrder 必须从 1 连续递增：${JSON.stringify(sorted.map((x) => x.attemptOrder))}`)
          }
        }
        // Validate generic trail shape first, then the stronger Quality First
        // rank mapping. This keeps errors precise while still making rank order
        // a hard invariant rather than an agent convention.
        const selectedCount = sorted.filter((x) => x.outcome === 'SELECTED').length
        if (selectedCount > 1) throw new Error('invariant: 每个 push 至多一个 SELECTED')
        const selectedIdx = sorted.findIndex((x) => x.outcome === 'SELECTED')
        if (selectedIdx !== -1 && selectedIdx !== sorted.length - 1) {
          throw new Error('invariant: SELECTED 出现后不得继续 acquisition')
        }
        for (let i = 0; i < sorted.length; i += 1) {
          const s = sorted[i]!
          const expected = eligible[i]
          if (!expected || expected.paperId !== s.paperId || expected.agentRank !== s.agentRank) {
            throw new Error(
              `Quality First invariant: attemptOrder=${s.attemptOrder} 应对应 ${expected ? `agentRank #${expected.agentRank} ${expected.paperId}` : '无候选'}，收到 agentRank #${s.agentRank} ${s.paperId}`,
            )
          }
        }
        const updateSel = db.prepare(
          `UPDATE candidates SET preflight_attempt_order = ?, selection_outcome = ?, selection_rejection_reason = ?
           WHERE push_id = ? AND paper_id = ?`,
        )
        for (const item of sorted) {
          updateSel.run(item.attemptOrder, item.outcome, item.reason ?? null, args.pushId, item.paperId)
        }
      }

      const trailCount = args.selection?.length ?? persistedTrail.length
      if ((args.status === 'fulltext_unavailable' || args.status === 'auth_required') && trailCount === 0) {
        throw new Error(`${args.status} 必须存在 acquisition/selection 轨迹`)
      }

      let coverage: ReturnType<typeof readingCoverage> = {
        totalChunks: 0,
        readChunks: 0,
        readCoverage: 0,
        coverageBasis: 'read_log',
      }
      let stageMatched = false
      let advanced = false
      let pendingRequired: string[] = []
      let duplicate = false

      if (args.status === 'completed') {
        if (!args.paperId) throw new Error('completed 时 paperId 必填')
        const reportRow = db.prepare('SELECT report_path FROM pushes WHERE id = ?').get(args.pushId) as { report_path: string | null } | undefined
        const reportPath = args.reportPath ?? reportRow?.report_path ?? ''
        const done = finalizeCompletedPush(db, cfg, {
          pushId: args.pushId,
          paperId: args.paperId,
          reportPath,
          knowledgeGoals: args.knowledgeGoals,
          advanceStage: args.advanceStage,
          notes: args.notes,
          modelRoute: modelRoute(),
        })
        coverage = done.coverage
        stageMatched = done.stageMatched
        advanced = done.stageAdvanced
        pendingRequired = done.pendingRequiredGoals
        duplicate = done.duplicate
      } else {
        db.prepare(
          `UPDATE pushes SET status = ?, finished_at = datetime('now'), paper_id = COALESCE(?, paper_id),
             report_path = COALESCE(?, report_path), error_code = ?, error_detail = ?,
             notes = COALESCE(?, notes), model_route = COALESCE(?, model_route)
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
      }
      const readsCount = coverage.readChunks

      // --- performance audit flush (plugin phases + agent-reported phases) ---
      const pushRow2 = db.prepare('SELECT started_at FROM pushes WHERE id = ?').get(args.pushId) as
        | { started_at: string }
        | undefined
      const totalMs = pushRow2?.started_at
        ? Math.max(0, Date.now() - new Date(`${pushRow2.started_at.replace(' ', 'T')}Z`).getTime())
        : undefined
      const scoredCount = args.scores?.length ?? 0
      const perf = rt.perf.flush(db, args.pushId, {
        agentRankingMs: args.agentRankingMs,
        reportGenerationMs: args.reportGenerationMs,
        agentScoredCandidates: scoredCount || undefined,
        llmCallCount: args.llmCallCount,
        llmRetryCount: args.llmRetryCount,
        totalMs,
      })

      const stage = getStage(db, topic)
      // perf timings may be fractional (performance.now() deltas): round all
      // of them at the output boundary so instrumentation can never break a
      // push's tool call (lossless-JSON boundary accepts only integers here)
      const R = (n: number): number => Math.round(n)
      return jsonSafe({
        pushId: args.pushId,
        status: args.status,
        perfSummary: {
          retrievalMs: R(perf.retrievalMs),
          deterministicRankingMs: R(perf.deterministicRankingMs),
          agentRankingMs: R(perf.agentRankingMs),
          pdfPreflightMs: R(perf.pdfPreflightMs),
          pdfDownloadMs: R(perf.pdfDownloadMs),
          parsingMs: R(perf.parsingMs),
          fulltextReadMs: R(perf.fulltextReadMs),
          reportGenerationMs: R(perf.reportGenerationMs),
          totalMs: R(perf.totalMs ?? 0),
          rawCandidates: R(perf.rawCandidates),
          deterministicCandidates: R(perf.deterministicCandidates),
          agentScoredCandidates: R(perf.agentScoredCandidates),
          llmCallCount: R(perf.llmCallCount),
          llmRetryCount: R(perf.llmRetryCount),
          pdfAttemptCount: R(perf.pdfAttemptCount),
          arxivRequests: R(perf.arxivRequests),
          arxivDedupHits: R(perf.arxivDedupHits),
          arxiv429Count: R(perf.arxiv429Count),
          arxivRetryCount: R(perf.arxivRetryCount),
          arxivRateLimited: R(perf.arxivRateLimited),
          arxivWaitMs: R(perf.arxivWaitMs),
        },
        stage: stage.current,
        stageLabel: stageLabel(cfg.stageOrder, stage.current),
        papersInStage: stage.papersInStage,
        targetPapers: stage.targetPapers,
        coveredGoals: stage.coveredGoals,
        stageAdvanced: advanced,
        pendingRequiredGoals: pendingRequired,
        duplicate,
        stageMatched,
        readsCount,
        totalChunks: coverage.totalChunks,
        readChunks: coverage.readChunks,
        readCoverage: coverage.readCoverage,
        coverageBasis: coverage.coverageBasis,
      } satisfies RecordOutput)
    },
  })
}
