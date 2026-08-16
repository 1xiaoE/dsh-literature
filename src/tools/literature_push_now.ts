/**
 * Tool: literature_push_now — the workflow entry point. Creates a running
 * push and returns the staged instructions the agent should follow. It
 * contains NO LLM calls; the agent (routed by the harness, DeepSeek or
 * OpenAI alike) executes the steps with the other literature_* tools.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { ensureStage, getStage, stageLabel } from '../lib/stages.js'
import { completedPushCount, seenPaperIds, startPush } from '../lib/history.js'

export interface PushNowInput {
  topic?: string
}

export interface PushNowOutput {
  pushId: number
  topic: string
  stage: number
  stageLabel: string
  targetPapers: number
  papersInStage: number
  historyCount: number
  seenCount: number
  instructions: string[]
}

const INSTRUCTIONS = [
  '1. literature_sources：检索候选（传 pushId 复用本次推送），得到预排序 Top N。',
  '2. 语义排序（你负责）：综合考虑相关性、学习价值、方法代表性、新颖性，并参照当前阅读阶段主线，从候选中选择最值得精读的 1 篇。',
  '3. 跳过 isSeen=true 的候选（已推荐过）；如全部已读或无可选，用 literature_record 提交 status=no_candidate。',
  '4. literature_fetch_pdf：下载选中论文 PDF（多源回退）。',
  '5. literature_fulltext_index：解析为分块全文并取索引；再按 seq 用 literature_fulltext_read 逐块精读。',
  '6. 若 outcome=FULLTEXT_UNAVAILABLE：必须停止精读，用 literature_record 提交 status=fulltext_unavailable，禁止仅凭摘要伪装全文精读。',
  '7. 全文精读后，撰写结构化 Markdown 精读报告（研究问题/现有方法局限/核心方法/控制架构/实验设计/重要定量结果/主要结论/局限性/与其他工作的关系/学习价值），归档到文献库（可用 write 工具写入 <libraryRoot>/<分类>/<作者_年份_关键词>.md，并追加 Templates/push_record.md）。',
  '8. literature_record：提交 status=completed、paperId、scores（含 rationale）、reportPath；需要人工切换阶段时传 advanceStage=true。',
]

export function defineLiteraturePushNow(getRt: () => LiteratureRuntime, modelRoute: () => string | null) {
  return defineTool({
    name: 'literature_push_now',
    description:
      '开始一次文献精选推送：创建推送记录并返回分步工作流指令（检索→语义排序→下载→分块精读→报告→记录）。本工具不含 LLM 调用，执行者是你（agent）。',
    parameters: {
      topic: { type: 'string', description: '主题，缺省用配置默认主题' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pushId: { type: 'integer', required: true },
          topic: { type: 'string', required: true },
          stage: { type: 'integer', required: true },
          stageLabel: { type: 'string', required: true },
          targetPapers: { type: 'integer', required: true },
          papersInStage: { type: 'integer', required: true },
          historyCount: { type: 'integer', required: true },
          seenCount: { type: 'integer', required: true },
          instructions: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value: PushNowOutput) => [
        {
          type: 'text',
          text: `开始推送 #${value.pushId}｜主题「${value.topic}」｜阶段「${value.stageLabel}」（${value.papersInStage}/${value.targetPapers}）｜历史 ${value.historyCount} 篇、已读 ${value.seenCount} 篇。\n${value.instructions.join('\n')}`,
        },
      ],
    },
    async execute(args: PushNowInput): Promise<PushNowOutput> {
      const rt = getRt()
      const { db, cfg } = rt
      const topic = args.topic ?? cfg.topics[0] ?? '足式机器人控制'
      ensureStage(db, topic, cfg.targetPapersPerStage)
      const stage = getStage(db, topic)
      const seen = seenPaperIds(db, topic)
      const pushId = startPush(db, topic, stage.current, modelRoute()).pushId

      return {
        pushId,
        topic,
        stage: stage.current,
        stageLabel: stageLabel(cfg.stageOrder, stage.current),
        targetPapers: stage.targetPapers,
        papersInStage: stage.papersInStage,
        historyCount: completedPushCount(db, topic),
        seenCount: seen.size,
        instructions: [...INSTRUCTIONS],
      } satisfies PushNowOutput
    },
  })
}
