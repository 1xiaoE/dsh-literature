/**
 * Tool: literature_push_now — the workflow entry point. Creates a running
 * push and returns the staged instructions the agent should follow. It
 * contains NO LLM calls; the agent (routed by the harness, DeepSeek or
 * OpenAI alike) executes the steps with the other literature_* tools.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { jsonSafe } from '../lib/json_safe.js'
import { ensureStage, getStage, stageLabel, stageDef } from '../lib/stages.js'
import { completedPushCount, seenPaperIds, startPush } from '../lib/history.js'
import { resolveLibraryRoot } from '../lib/paths.js'
import { resolveTopic, decidePriorityGoal } from '../lib/planner.js'

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
  priorityGoal?: { id: string; label: string }
  priorityGoalMode: 'normal' | 'completion'
  pendingRequiredGoals: string[]
  stageRelevanceThreshold: number
  targetPapers: number
  papersInStage: number
  historyCount: number
  seenCount: number
  reportRoot: string
  instructions: string[]
}

/** Resolve the user's first topic, then keep using the latest topic on resume-less pushes. */
function resolveWorkflowTopic(rt: LiteratureRuntime, input?: string) {
  const requested = input?.trim() || (rt.db.prepare('SELECT topic FROM pushes ORDER BY id DESC LIMIT 1').get() as { topic?: string } | undefined)?.topic?.trim()
  if (!requested) throw new Error('INVALID_ARGUMENT: first literature push requires a topic')
  return resolveTopic(rt.cfg.topics, requested)
}

export function defineLiteraturePushNow(getRt: () => LiteratureRuntime, modelRoute: () => string | null) {
  return defineTool({
    name: 'literature_push_now',
    description:
      '开始一次文献精选推送：创建推送记录并返回分步工作流指令（Query Planner 检索→语义排序→下载→分块精读→报告→记录）。本工具不含 LLM 调用，执行者是你（agent）。',
    parameters: {
      topic: { type: 'string', description: '首次执行必填；后续省略时沿用最近主题，也可输入新主题切换' },
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
          priorityGoal: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string', required: true }, label: { type: 'string', required: true } },
          },
          priorityGoalMode: { type: 'string', required: true, enum: ['normal', 'completion'] },
          pendingRequiredGoals: { type: 'array', items: { type: 'string' }, required: true },
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
      const topic = resolveWorkflowTopic(rt, args.topic)
      ensureStage(db, topic.id, cfg.targetPapersPerStage)
      const stage = getStage(db, topic.id)
      const def = stageDef(cfg.stageOrder, stage.current)
      const pgDecision = def
        ? decidePriorityGoal(def, new Set(stage.coveredGoals), stage.papersInStage, cfg.targetPapersPerStage)
        : { goal: undefined, mode: 'normal' as const, pendingRequired: [] as string[] }
      const seen = seenPaperIds(db, topic.id)
      const pushId = startPush(db, topic.id, stage.current, modelRoute()).pushId
      // Freeze the policy used by this push so a later --resume can finalize
      // deterministically under the same thresholds instead of today's config.
      db.prepare('UPDATE pushes SET policy_json = ? WHERE id = ?').run(JSON.stringify(cfg), pushId)
      const reportRoot = resolveLibraryRoot(cfg)

      const knowledgeGoals = (def?.knowledgeGoals ?? []).map((g) => `${g.id}（${g.label}）`).join('；')
      const instructions = [
        `1. literature_sources：Query Planner 检索（传 pushId 复用本次推送）。它会基于 topic + 当前阶段 searchQueries 生成英文查询，Recent/Landmark 双池独立检索并合并去重，返回 raw/去重/池比例与每个候选的 stage_relevance_hint / curriculum_hint / landmark_confidence / knowledge_gap_hint / candidate_pool / 检索溯源，以及当前阶段已覆盖/未覆盖的 knowledge goals。`,
        `2. 当前阶段「${stageLabel(cfg.stageOrder, stage.current)}」scope：${def?.scope ?? ''}。`,
        `3. 本阶段 knowledge goals：${knowledgeGoals || '无'}。covered_goals 来自 stages 表；优先选择能补足未覆盖 goal 的论文（knowledge_gap_hint 高者）。`,
        `4. 语义排序（你负责，0~1 评分并记录 rationale）——必须 BATCH：一次（至多两次）LLM 调用对 deterministic Top 15 做批量语义评估，逐篇给出 relevance、learning_value、representativeness、novelty、stage_relevance_score 与 curriculum_value_score。禁止逐篇发起独立 LLM 请求。评分完成后**立即调用 literature_rank_candidates(pushId, scores, agentRankingMs, llmCallCount, llmRetryCount)** 固化 final_score + 唯一 agentRank；任何 PDF preflight/fetch 之前必须完成这一步。之后顺序由代码状态机强制，agent 不得自行重排。Fundamentals 阶段 curriculum_value 权重更高。`,
        `5. 质量门槛（两者都须达标才可选）：stage_relevance_score ≥ ${cfg.stageRelevanceThreshold} 且 curriculum_value ≥ ${cfg.curriculumValueThreshold}；低于任一门槛的论文不得选，即使 overall impact 很高或 PDF 可得。如无任何达标候选，用 literature_record 提交 status=no_candidate。`,
        `6. 全文获取协议（Quality First 硬状态机；最多 ${cfg.maxSelectionAttempts} 个质量门达标候选）：对当前最高 agentRank 的达标候选完成**整条 acquisition chain**后才能考虑下一篇。顺序固定：RankN → literature_pdf_preflight(pushId) → literature_fetch_pdf(pushId, allowInstitutional=true)。fetch 内部始终 public/OA 优先，失败后才进入 publisher_browser。public preflight 失败绝不允许先试 RankN+1；preflight/fetch 都会由代码拒绝跳 Rank。只有 ACCESS_DENIED / PDF_NOT_FOUND / FULLTEXT_UNAVAILABLE 等明确论文级终态才进入下一 Rank；ok/PDF_OK → SELECTED 并立即停止。`,
        `6b. 机构访问终态：PDF_OK → SELECTED（institutional，is_open_access=false）；AUTH_REQUIRED → 立即停止并 literature_user_action(open, kind=publisher_login)，再 literature_record(status=user_action_required,errorCode=AUTH_REQUIRED)，用户登录后 --resume 仍继续**同一 Rank**；RATE_LIMITED → 立即停止当前运行，保持同一 Rank，达到 reason 中最早重试时间后 --resume（不是 PDF_NOT_FOUND，不刷新限流计时戳，不得跳 Rank）；ACCESS_DENIED / PDF_NOT_FOUND → 才允许进入下一 Rank。CARSI 为 legacy 且默认禁用。`,
        `6c. Human-in-the-loop（NEED_USER_ACTION）总规则：遇到资源访问/认证/权限/下载渠道/研究选择问题、且用户比自动化更容易解决时——不要盲目重试，不要直接判定失败。用 literature_user_action(open) 注册待办（五要素：①卡在哪一步 ②缺少什么资源/权限/信息 ③已尝试过哪些方法 ④用户需要做什么 ⑤完成后如何继续，howToContinue 填「重新运行 dsh-literature-push.mjs --resume <pushId>」），再 literature_record 提交 status=user_action_required（errorCode 用 AUTH_REQUIRED / USER_RESOURCE_NEEDED / MANUAL_PDF_NEEDED / VERSION_CHOICE / TOPIC_DECISION 等）。典型场景：出版社登录墙、机构订阅需人工登录、PDF 需人工确认下载入口、经典论文无公开全文但可能有机构访问、多个版本无法判断优先版本、候选论文质量不足需用户决定调整主题/阶段。用户处理后：literature_resume 从原步骤继续（候选与评分已持久化，不重新检索/评分）。`,
        `7. 知识缺口引导：priority goal（${pgDecision.mode === 'completion' ? 'required-goal COMPLETION MODE' : '普通偏好模式'}）= ${pgDecision.goal ? pgDecision.goal.id + '（' + pgDecision.goal.label + '）' : '无'}；priorityGoalMatch 为 0~1 匹配强度（检索/排序信号），预排序已加权。${pgDecision.mode === 'completion' ? `⚠️ 毕业模式：papers 已达 ${cfg.targetPapersPerStage - 1}/3 且 required goal 未覆盖（pending: ${pgDecision.pendingRequired.join(',')}）——本阶段「完成阶段」的论文必须真正覆盖该 required goal：stage_relevance ≥ ${cfg.stageRelevanceThreshold}、curriculum_value ≥ ${cfg.curriculumValueThreshold}、合法全文可得、全文精读达标，并由你基于全文确认确实覆盖（不能只靠关键词命中）。优秀但与 required goal 无关的论文：可保留候选/阅读历史，但不得用来完成本阶段、不得让阶段毕业。` : `普通模式：priority goal 只是推荐偏好，不是全局硬阈值。`}${pgDecision.goal?.id === 'impedance_compliance' ? ' 重点概念：impedance control / compliant locomotion / virtual model control / stiffness control / spring-damper / force-position compliance / task-space impedance / compliant control。' : ''}`,
        '8. 池说明：candidate_pool=landmark 不受 5 年限制（含 curated landmark seeds 锚点），但同样必须过质量门槛；跳过 isSeen=true 的候选。种子论文本身无全文时，不强制选择——可依据其标题/关键词扩展检索相关候选（如 OpenAlex 引用它的后续工作）。',
        '9. acquisition 返回 ok/PDF_OK 并把候选标记 SELECTED 后，立即停止候选获取；不得再 preflight/fetch 其他论文。',
        `10. literature_fulltext_index：解析为分块全文；再按 seq 用 literature_fulltext_read 逐块精读。当前配置 completed 最低阅读覆盖率=${cfg.fulltext.minReadCoverage}（默认 1.0，即全部 indexed chunks 均须读过）。`,
        `11. 若最多 ${cfg.maxSelectionAttempts} 个达标候选都获得明确论文级不可得终态：用 literature_record 提交 status=fulltext_unavailable；acquisition 轨迹已由数据库持久化，禁止仅凭摘要伪装全文精读。`,
        `11. 全文精读后，撰写结构化 Markdown 精读报告（研究问题/现有方法局限/核心方法/控制架构/实验设计/重要定量结果/主要结论/局限性/与其他工作的关系/学习价值；说明该论文为何适合当前阶段及其覆盖的 knowledge goals），调用 literature_report_write(pushId, stageLabel, filename, content) 写入 canonical：${reportRoot}/<阶段>/<作者_年份_关键词>.md（plugin 进程原子写，不经你的 shell；返回 reportPath 供 literature_record 使用）。不要用通用 write 工具写 canonical 路径（sandbox 可能不可达）；staging 副本仅作异常恢复备份。报告必须记录全文阅读 coverage 四字段：total_chunks（literature_record 输出的总块数）、read_chunks（实际 read 的块数）、read_coverage、coverage_basis（full_read / index_exposed / read_log）。当 read_coverage < 1 时禁止写「全文 N 块全部精读」——如实写「精读 M/N 块（basis=index_exposed 表示未读块的 preview 已由 literature_fulltext_index 暴露，完整正文未读）」。`,
        `12. literature_record：提交最终 status、paperId、knowledgeGoals、reportPath 与 reportGenerationMs。scores 已由 literature_rank_candidates 持久化，不需要重复提交（保留兼容）；selection/acquisition 轨迹也已由 preflight/fetch 状态机持久化。completed 会硬校验：SELECTED、质量门、canonical 报告存在且非空、fulltext 已索引、readCoverage ≥ ${cfg.fulltext.minReadCoverage}，随后由同一个 finalize core 原子完成 picked/knowledge_coverage/阶段推进。若 literature_report_write 返回 REPORT_WRITE_FAILED/SYSTEM_ERROR，则 record status=failed。`,
      ]

      return jsonSafe({
        pushId,
        topicId: topic.id,
        topicDisplayName: topic.displayName,
        stage: stage.current,
        stageLabel: stageLabel(cfg.stageOrder, stage.current),
        stageScope: def?.scope ?? '',
        priorityGoal: pgDecision.goal ? { id: pgDecision.goal.id, label: pgDecision.goal.label } : undefined,
        priorityGoalMode: pgDecision.mode,
        pendingRequiredGoals: pgDecision.pendingRequired,
        stageRelevanceThreshold: cfg.stageRelevanceThreshold,
        targetPapers: stage.targetPapers,
        papersInStage: stage.papersInStage,
        historyCount: completedPushCount(db, topic.id),
        seenCount: seen.size,
        reportRoot,
        instructions,
      } satisfies PushNowOutput)
    },
  })
}
