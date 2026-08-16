/**
 * Tool: literature_push_now — the workflow entry point. Creates a running
 * push and returns the staged instructions the agent should follow. It
 * contains NO LLM calls; the agent (routed by the harness, DeepSeek or
 * OpenAI alike) executes the steps with the other literature_* tools.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { ensureStage, getStage, stageLabel, stageDef } from '../lib/stages.js'
import { completedPushCount, seenPaperIds, startPush } from '../lib/history.js'
import { resolveLibraryRoot } from '../lib/paths.js'
import { resolveTopic } from '../lib/planner.js'

export interface PushNowInput {
  topic?: string
}

export interface PushNowOutput {
  pushId: number
  topicId: string
  topicDisplayName: string
  stage: number
  stageLabel: string
  stageScope: string
  stageRelevanceThreshold: number
  targetPapers: number
  papersInStage: number
  historyCount: number
  seenCount: number
  reportRoot: string
  instructions: string[]
}

export function defineLiteraturePushNow(getRt: () => LiteratureRuntime, modelRoute: () => string | null) {
  return defineTool({
    name: 'literature_push_now',
    description:
      '开始一次文献精选推送：创建推送记录并返回分步工作流指令（Query Planner 检索→语义排序→下载→分块精读→报告→记录）。本工具不含 LLM 调用，执行者是你（agent）。',
    parameters: {
      topic: { type: 'string', description: '主题 id 或显示名，缺省用配置默认主题' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pushId: { type: 'integer', required: true },
          topicId: { type: 'string', required: true },
          topicDisplayName: { type: 'string', required: true },
          stage: { type: 'integer', required: true },
          stageLabel: { type: 'string', required: true },
          stageScope: { type: 'string', required: true },
          stageRelevanceThreshold: { type: 'number', required: true },
          targetPapers: { type: 'integer', required: true },
          papersInStage: { type: 'integer', required: true },
          historyCount: { type: 'integer', required: true },
          seenCount: { type: 'integer', required: true },
          reportRoot: { type: 'string', required: true },
          instructions: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value: PushNowOutput) => [
        {
          type: 'text',
          text: `开始推送 #${value.pushId}｜主题「${value.topicDisplayName}」｜阶段「${value.stageLabel}」（${value.papersInStage}/${value.targetPapers}）｜历史 ${value.historyCount} 篇、已读 ${value.seenCount} 篇。\n${value.instructions.join('\n')}`,
        },
      ],
    },
    async execute(args: PushNowInput): Promise<PushNowOutput> {
      const rt = getRt()
      const { db, cfg } = rt
      const topic = resolveTopic(cfg.topics, args.topic)
      ensureStage(db, topic.id, cfg.targetPapersPerStage)
      const stage = getStage(db, topic.id)
      const def = stageDef(cfg.stageOrder, stage.current)
      const seen = seenPaperIds(db, topic.id)
      const pushId = startPush(db, topic.id, stage.current, modelRoute()).pushId
      const reportRoot = resolveLibraryRoot(cfg)

      const knowledgeGoals = (def?.knowledgeGoals ?? []).map((g) => `${g.id}（${g.label}）`).join('；')
      const instructions = [
        `1. literature_sources：Query Planner 检索（传 pushId 复用本次推送）。它会基于 topic + 当前阶段 searchQueries 生成英文查询，Recent/Landmark 双池独立检索并合并去重，返回 raw/去重/池比例与每个候选的 stage_relevance_hint / curriculum_hint / landmark_confidence / knowledge_gap_hint / candidate_pool / 检索溯源，以及当前阶段已覆盖/未覆盖的 knowledge goals。`,
        `2. 当前阶段「${stageLabel(cfg.stageOrder, stage.current)}」scope：${def?.scope ?? ''}。`,
        `3. 本阶段 knowledge goals：${knowledgeGoals || '无'}。covered_goals 来自 stages 表；优先选择能补足未覆盖 goal 的论文（knowledge_gap_hint 高者）。`,
        `4. 语义排序（你负责，0~1 评分并记录 rationale）：对 deterministic Top 15 中至少 10 篇评估 relevance、learning_value、representativeness、novelty、stage_relevance_score（是否属于当前阶段）与 curriculum_value_score（对系统学习当前阶段是否核心/代表性/值得优先读——考虑 foundational importance、method centrality、learning value、representativeness、prerequisite suitability；过于具体的应用/单机构设计案例应给低分）。Fundamentals 阶段 curriculum_value 权重更高。`,
        `5. 质量门槛（两者都须达标才可选）：stage_relevance_score ≥ ${cfg.stageRelevanceThreshold} 且 curriculum_value ≥ ${cfg.curriculumValueThreshold}；低于任一门槛的论文不得选，即使 overall impact 很高或 PDF 可得。如无任何达标候选，用 literature_record 提交 status=no_candidate。`,
        '6. 全文选择协议（禁止 Top 1 无全文即整体失败）：按语义排名对达标候选依次调用 literature_pdf_preflight（最多尝试 6 篇）；选择排名最高且 quality gates 达标 + fulltext available 的论文；被跳过的候选在 literature_record 的 selection 里记录 (rank, outcome, reason)——例如 rank1: FULLTEXT_UNAVAILABLE, rank2: SELECTED。',
        '7. 池说明：candidate_pool=landmark 不受 5 年限制，但同样必须过质量门槛；跳过 isSeen=true 的候选。',
        '8. literature_fetch_pdf：下载选中论文 PDF（多源回退）。',
        '9. literature_fulltext_index：解析为分块全文并取索引；再按 seq 用 literature_fulltext_read 逐块精读。',
        `10. 若所有达标候选均无全文：用 literature_record 提交 status=fulltext_unavailable（selection 记录全部尝试与原因），禁止仅凭摘要伪装全文精读。`,
        `11. 全文精读后，撰写结构化 Markdown 精读报告（研究问题/现有方法局限/核心方法/控制架构/实验设计/重要定量结果/主要结论/局限性/与其他工作的关系/学习价值；说明该论文为何适合当前阶段及其覆盖的 knowledge goals），用 write 归档到 canonical 报告根目录：${reportRoot}/<阶段>/<作者_年份_关键词>.md，并追加 ${reportRoot}/Templates/push_record.md。`,
        `12. literature_record：提交 status=completed、paperId、scores（至少 10 篇，picked 必须 stageRelevance ≥ ${cfg.stageRelevanceThreshold} 且 curriculumValue ≥ ${cfg.curriculumValueThreshold}）、selection 轨迹、knowledgeGoals（picked 论文覆盖的 goal id）、rationale、reportPath；需要人工切换阶段时传 advanceStage=true。`,
      ]

      return {
        pushId,
        topicId: topic.id,
        topicDisplayName: topic.displayName,
        stage: stage.current,
        stageLabel: stageLabel(cfg.stageOrder, stage.current),
        stageScope: def?.scope ?? '',
        stageRelevanceThreshold: cfg.stageRelevanceThreshold,
        targetPapers: stage.targetPapers,
        papersInStage: stage.papersInStage,
        historyCount: completedPushCount(db, topic.id),
        seenCount: seen.size,
        reportRoot,
        instructions,
      } satisfies PushNowOutput
    },
  })
}
