/**
 * Tool: literature_resume — continue a parked (NEED_USER_ACTION) or
 * interrupted push from its ORIGINAL step, without re-running retrieval or
 * re-scoring: candidates, scores, the selection trail and fetch attempts are
 * all persisted in SQLite, so the resumed workflow reuses them.
 *
 * The tool is read-only/advisory: it reports where the workflow is stuck,
 * what the user must do (open actions carry the five-part record), and which
 * step to resume from. The agent then executes the remaining steps with the
 * existing literature_* tools.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { getPush } from '../lib/history.js'
import { getStage, stageLabel, stageDef } from '../lib/stages.js'
import { openActionsOfPush, type UserActionRow } from '../lib/user_actions.js'

export type ResumeStep =
  | 'sources'
  | 'selection'
  | 'fetch_pdf'
  | 'fulltext_index'
  | 'report'
  | 'record'

export interface ResumeStateSummary {
  status: string
  openKinds: string[]
  /** step of the most recently resolved action, if the user finished one */
  resolvedStep?: string
  /** kind of that resolved action */
  resolvedKind?: string
  /** a manual PDF (outcome PDF_OK, source manual:*) is already registered for the manual_pdf action's paper */
  manualPdfRegistered: boolean
  reportPath: string | null
  fulltextOk: boolean
  anyPdfOk: boolean
  anyFetchLog: boolean
  scoredCandidates: boolean
}

/**
 * Deterministic step inference (pure, unit-tested). Never re-runs retrieval
 * or scoring unless the user's own decision (topic_decision) requires it.
 */
export function inferResumeFrom(s: ResumeStateSummary): ResumeStep | null {
  if (s.openKinds.length > 0) {
    if (s.openKinds.includes('topic_decision')) return 'sources'
    if (s.openKinds.includes('manual_pdf')) {
      return s.manualPdfRegistered ? 'fulltext_index' : 'fetch_pdf'
    }
    // carsi_relogin / version_choice / user_resource_needed / ...
    return 'fetch_pdf'
  }
  if (s.resolvedStep) {
    // the user finished a parked action — continue from where it was parked
    if (s.resolvedKind === 'topic_decision') return 'sources'
    if (s.resolvedKind === 'manual_pdf') {
      return s.manualPdfRegistered ? 'fulltext_index' : 'fetch_pdf'
    }
    if (RESUME_STEPS.includes(s.resolvedStep as ResumeStep)) return s.resolvedStep as ResumeStep
  }
  if (s.status === 'user_action_required' || s.status === 'auth_required') {
    // every action resolved → retry the failing fetch step
    return 'fetch_pdf'
  }
  if (s.status === 'running') {
    if (s.reportPath) return 'record'
    if (s.fulltextOk) return 'report'
    if (s.anyPdfOk) return 'fulltext_index'
    if (s.anyFetchLog) return 'fetch_pdf'
    if (s.scoredCandidates) return 'selection'
    return 'sources'
  }
  return null // completed / failed / no_candidate / fulltext_unavailable
}

const RESUME_STEPS: ResumeStep[] = ['sources', 'selection', 'fetch_pdf', 'fulltext_index', 'report', 'record']

export interface ResumeOutput {
  pushId: number
  status: string
  stage: number
  stageLabel: string
  stageScope: string
  topic: string
  candidatesCount: number
  scoredCount: number
  pickedPaperId?: string
  selectionTrail: Array<{
    paperId: string
    agentRank?: number
    attemptOrder?: number
    outcome?: string
  }>
  fetchLog: Array<{ paperId: string; outcome: string; created_at: string }>
  openActions: Array<{
    actionId: number
    kind: string
    step: string
    paperId?: string
    issue: string
    attempts: string[]
    whatUserShouldDo: string
    howToContinue: string
  }>
  canResume: boolean
  resumeFrom?: ResumeStep
  instructions: string[]
}

export function defineLiteratureResume(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_resume',
    description:
      '恢复一个处于 NEED_USER_ACTION（user_action_required）或被中断（running）的推送：报告卡点/待办（五要素）与 resumeFrom 步骤。候选与评分已持久化——不要重新运行 literature_sources、不要重新评分；用户处理完成后从原步骤继续。',
    parameters: {
      pushId: { type: 'integer', required: true, description: '要恢复的推送号' },
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
          stageScope: { type: 'string', required: true },
          topic: { type: 'string', required: true },
          candidatesCount: { type: 'integer', required: true },
          scoredCount: { type: 'integer', required: true },
          pickedPaperId: { type: 'string' },
          selectionTrail: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paperId: { type: 'string', required: true },
                agentRank: { type: 'integer' },
                attemptOrder: { type: 'integer' },
                outcome: { type: 'string' },
              },
            },
          },
          fetchLog: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paperId: { type: 'string', required: true },
                outcome: { type: 'string', required: true },
                created_at: { type: 'string', required: true },
              },
            },
          },
          openActions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                actionId: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                step: { type: 'string', required: true },
                paperId: { type: 'string' },
                issue: { type: 'string', required: true },
                attempts: { type: 'array', items: { type: 'string' }, required: true },
                whatUserShouldDo: { type: 'string', required: true },
                howToContinue: { type: 'string', required: true },
              },
            },
          },
          canResume: { type: 'boolean', required: true },
          resumeFrom: {
            type: 'string',
            enum: ['sources', 'selection', 'fetch_pdf', 'fulltext_index', 'report', 'record'],
          },
          instructions: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value: ResumeOutput) => [
        {
          type: 'text',
          text: value.canResume
            ? `恢复 push #${value.pushId}：状态 ${value.status}，从「${value.resumeFrom}」继续。候选 ${value.candidatesCount} 篇（已评分 ${value.scoredCount}）复用，不重新检索/评分。${value.openActions.length > 0 ? `待办 ${value.openActions.length} 项（${value.openActions.map((a) => `#${a.actionId} ${a.kind}`).join('、')}）— 用户处理完成后再次 resume。` : ''}`
            : `push #${value.pushId} 已终态（${value.status}），无需恢复。`,
        },
      ],
    },
    async execute(args: { pushId: number }): Promise<ResumeOutput> {
      const rt = getRt()
      const { db, cfg } = rt
      const push = getPush(db, args.pushId)
      if (!push) throw new Error(`push #${args.pushId} 不存在`)

      const stage = getStage(db, push.topic)
      const def = stageDef(cfg.stageOrder, stage.current)

      const candidates = db
        .prepare(
          `SELECT paper_id, agent_rank, preflight_attempt_order, selection_outcome,
                  picked, final_score
           FROM candidates WHERE push_id = ? ORDER BY preflight_attempt_order, agent_rank`,
        )
        .all(args.pushId) as Array<{
        paper_id: string
        agent_rank: number | null
        preflight_attempt_order: number | null
        selection_outcome: string | null
        picked: number
        final_score: number | null
      }>

      const fetchLog = db
        .prepare(
          `SELECT f.paper_id, f.outcome, f.created_at FROM fetch_log f
           JOIN candidates c ON c.paper_id = f.paper_id AND c.push_id = ?
           UNION
           SELECT paper_id, outcome, created_at FROM fetch_log
           WHERE paper_id IN (SELECT paper_id FROM candidates WHERE push_id = ?)
           ORDER BY created_at DESC LIMIT 20`,
        )
        .all(args.pushId, args.pushId) as Array<{ paper_id: string; outcome: string; created_at: string }>

      const fulltextOk = Boolean(
        db
          .prepare(
            `SELECT 1 FROM fulltexts f
             JOIN candidates c ON c.paper_id = f.paper_id
             WHERE c.push_id = ? AND f.status = 'ok' LIMIT 1`,
          )
          .get(args.pushId),
      )
      const pushRow = db
        .prepare('SELECT report_path, paper_id FROM pushes WHERE id = ?')
        .get(args.pushId) as { report_path: string | null; paper_id: string | null } | undefined

      const openActions = openActionsOfPush(db, args.pushId)
      const manualPaperId = openActions.find((a) => a.kind === 'manual_pdf')?.paper_id
      const manualPdfRegistered = manualPaperId
        ? Boolean(
            db
              .prepare(
                `SELECT 1 FROM fetch_log WHERE paper_id = ? AND outcome = 'PDF_OK' AND pdf_source LIKE 'manual:%' LIMIT 1`,
              )
              .get(manualPaperId),
          )
        : false
      const lastResolved = db
        .prepare(
          `SELECT step, kind FROM user_actions WHERE push_id = ? AND state = 'resolved' ORDER BY id DESC LIMIT 1`,
        )
        .get(args.pushId) as { step: string; kind: string } | undefined

      const summary: ResumeStateSummary = {
        status: push.status,
        openKinds: openActions.map((a) => a.kind),
        resolvedStep: lastResolved?.step,
        resolvedKind: lastResolved?.kind,
        manualPdfRegistered,
        reportPath: pushRow?.report_path ?? null,
        fulltextOk,
        anyPdfOk: fetchLog.some((f) => f.outcome === 'ok' || f.outcome === 'PDF_OK'),
        anyFetchLog: fetchLog.length > 0,
        scoredCandidates: candidates.some((c) => c.final_score !== null),
      }
      const resumeFrom = inferResumeFrom(summary)

      const instructions: string[] = []
      if (!resumeFrom) {
        instructions.push(`push #${args.pushId} 已终态（${push.status}），无需恢复。`)
      } else {
        instructions.push(
          `候选与评分已持久化（${candidates.length} 篇，已评分 ${summary.scoredCandidates ? '是' : '否'}）——不要重新运行 literature_sources，不要重新评分。`,
        )
        if (openActions.length > 0) {
          for (const a of openActions) {
            instructions.push(
              `待办 #${a.id}（${a.kind}，卡在 ${a.step}）：${a.issue}。已尝试：${parseAttempts(a.attempts).join('；') || '无'}。用户需要：${a.what_user_should_do}。完成后：${a.how_to_continue}。用户完成后先用 literature_user_action resolve 标记，再重新调用本工具。`,
            )
          }
        }
        const NEXT: Record<ResumeStep, string> = {
          sources:
            '用户已决定调整主题/阶段：用调整后的 topic/阶段重新 literature_sources（这是用户决策驱动的重新检索，不是盲目重试）。',
          selection:
            '继续全文选择协议：按已有语义排名对达标候选依次 literature_pdf_preflight（传 pushId）。',
          fetch_pdf:
            '对选中论文调用 literature_fetch_pdf（传 pushId；公开源全失败且质量门达标时可 allowCarsi=true；若用户已手动下载 PDF，传 manualPdfPath 登记）。',
          fulltext_index:
            '调用 literature_fulltext_index 解析为分块全文，再按 seq 用 literature_fulltext_read 逐块精读。',
          report: '基于已索引全文撰写结构化 Markdown 精读报告并归档，再调用 literature_record 提交结果。',
          record: '调用 literature_record 提交结果（status=completed 或按实际情况）。',
        }
        instructions.push(NEXT[resumeFrom])
      }

      return {
        pushId: args.pushId,
        status: push.status,
        stage: stage.current,
        stageLabel: stageLabel(cfg.stageOrder, stage.current),
        stageScope: def?.scope ?? '',
        topic: push.topic,
        candidatesCount: candidates.length,
        scoredCount: candidates.filter((c) => c.final_score !== null).length,
        pickedPaperId: pushRow?.paper_id ?? undefined,
        selectionTrail: candidates.map((c) => ({
          paperId: c.paper_id,
          agentRank: c.agent_rank ?? undefined,
          attemptOrder: c.preflight_attempt_order ?? undefined,
          outcome: c.selection_outcome ?? undefined,
        })),
        fetchLog: fetchLog.map((f) => ({ paperId: f.paper_id, outcome: f.outcome, created_at: f.created_at })),
        openActions: openActions.map((a: UserActionRow) => ({
          actionId: a.id,
          kind: a.kind,
          step: a.step,
          paperId: a.paper_id ?? undefined,
          issue: a.issue,
          attempts: parseAttempts(a.attempts),
          whatUserShouldDo: a.what_user_should_do,
          howToContinue: a.how_to_continue,
        })),
        canResume: resumeFrom !== null,
        resumeFrom: resumeFrom ?? undefined,
        instructions,
      } satisfies ResumeOutput
    },
  })
}

function parseAttempts(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
