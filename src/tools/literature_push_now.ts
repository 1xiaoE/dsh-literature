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

      const instructions = [
        `1. literature_sources：Query Planner 检索（传 pushId 复用本次推送）。它会基于 topic（canonical/secondary）+ 当前阶段 searchQueries 生成英文查询，Recent/Landmark 双池独立检索并合并去重，返回 raw/去重/池比例与每个候选的 stage_relevance_hint / stage_excluded / candidate_pool / 检索溯源。`,
        `2. 当前阶段「${stageLabel(cfg.stageOrder, stage.current)}」scope：${def?.scope ?? ''}。`,
        '3. 语义排序（你负责，0~1 评分并记录 rationale）：对 deterministic Top 15 中至少 10 篇评估 relevance、learning_value、representativeness、novelty 与 stage_relevance_score（参考 stage 的 preferred/downweight/exclude 关键词与 scope）。',
        `4. 阶段门控：stage_relevance_score 低于 ${cfg.stageRelevanceThreshold} 或 stage_excluded=true 的论文不得选为 Top 1，即使 overall impact 很高；如无任何达标候选，用 literature_record 提交 status=no_candidate。`,
        '5. 池说明：candidate_pool=landmark 的论文可不受 5 年限制（经典/奠基性工作），但同样必须满足阶段契合门控；candidate_pool=recent 的论文优先考虑。跳过 isSeen=true 的候选。',
        '6. literature_fetch_pdf：下载选中论文 PDF（多源回退）。',
        '7. literature_fulltext_index：解析为分块全文并取索引；再按 seq 用 literature_fulltext_read 逐块精读。',
        '8. 若 outcome=FULLTEXT_UNAVAILABLE：必须停止精读，用 literature_record 提交 status=fulltext_unavailable，禁止仅凭摘要伪装全文精读。',
        `9. 全文精读后，撰写结构化 Markdown 精读报告（研究问题/现有方法局限/核心方法/控制架构/实验设计/重要定量结果/主要结论/局限性/与其他工作的关系/学习价值；说明该论文为何适合当前阶段），用 write 归档到 canonical 报告根目录：${reportRoot}/<阶段>/<作者_年份_关键词>.md，并追加 ${reportRoot}/Templates/push_record.md。`,
        `10. literature_record：提交 status=completed、paperId、scores（至少 10 篇，picked 必须在内且 stageRelevance ≥ ${cfg.stageRelevanceThreshold}）、rationale、reportPath；需要人工切换阶段时传 advanceStage=true。`,
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
