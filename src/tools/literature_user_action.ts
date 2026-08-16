/**
 * Tool: literature_user_action — Human-in-the-loop (NEED_USER_ACTION).
 *
 * open:    park the workflow with a five-part issue record (where stuck /
 *          missing resource / what was tried / what the user should do /
 *          how to continue) and switch the push to user_action_required.
 * resolve: mark an action done (user finished); the push returns to
 *          'running' when no action remains open, so literature_resume can
 *          continue from the original step WITHOUT re-running retrieval or
 *          re-scoring.
 *
 * Rules: NEVER blind-retry a resource/auth/permission problem and NEVER
 * record it as FULLTEXT_UNAVAILABLE. Typical kinds: carsi_relogin,
 * manual_pdf, version_choice, topic_decision, user_resource_needed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { jsonSafe } from '../lib/json_safe.js'
import { openUserAction, resolveUserAction } from '../lib/user_actions.js'

export interface UserActionInput {
  action: 'open' | 'resolve'
  pushId: number
  /** open: where the workflow is stuck (sources/selection/preflight/fetch_pdf/fulltext_index/report/record) */
  step?: string
  /** open: carsi_relogin | manual_pdf | version_choice | topic_decision | user_resource_needed | ... */
  kind?: string
  paperId?: string
  /** open: what resource/permission/information is missing */
  issue?: string
  /** open: what has already been tried (non-empty only) */
  attempts?: string[]
  /** open: what the user must do */
  whatUserShouldDo?: string
  /** open: how the workflow continues after the user is done */
  howToContinue?: string
  /** resolve: the action id to mark done */
  actionId?: number
  /** resolve: optional note about what the user did */
  note?: string
}

export interface UserActionOutput {
  action: 'open' | 'resolve'
  pushId: number
  actionId?: number
  state?: 'open' | 'resolved'
  pushStatus?: string
  remainingOpen?: number
  detail?: string
}

export function defineLiteratureUserAction(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_user_action',
    description:
      'Human-in-the-loop：注册（open）或完成（resolve）一个需要用户介入的动作。遇到资源访问/认证/权限/下载渠道/研究选择问题且用户更容易解决时：open 记录五要素（卡点/缺什么/试过什么/用户做什么/如何继续）并把 push 置为 user_action_required；用户完成后 resolve，push 回到 running，可用 literature_resume 从原步骤继续（不重新检索/评分）。禁止盲目重试，禁止误记 FULLTEXT_UNAVAILABLE。',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'resolve'], description: 'open=注册待办；resolve=用户已处理完成' },
      pushId: { type: 'integer', required: true, description: '推送号' },
      step: { type: 'string', description: 'open：卡在哪一步（sources/selection/preflight/fetch_pdf/fulltext_index/report/record）' },
      kind: { type: 'string', description: 'open：动作类型（carsi_relogin/manual_pdf/version_choice/topic_decision/user_resource_needed/…）' },
      paperId: { type: 'string', description: 'open：涉及的论文（如有）' },
      issue: { type: 'string', description: 'open：缺少什么资源/权限/信息' },
      attempts: { type: 'array', items: { type: 'string' }, description: 'open：已经尝试过哪些方法（非空）' },
      whatUserShouldDo: { type: 'string', description: 'open：用户需要做什么' },
      howToContinue: { type: 'string', description: 'open：完成后如何继续（如：重新运行 dsh-literature-push.mjs --resume <pushId>）' },
      actionId: { type: 'integer', description: 'resolve：待办 id' },
      note: { type: 'string', description: 'resolve：用户处理说明（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          pushId: { type: 'integer', required: true },
          actionId: { type: 'integer' },
          state: { type: 'string', enum: ['open', 'resolved'] },
          pushStatus: { type: 'string' },
          remainingOpen: { type: 'integer' },
          detail: { type: 'string' },
        },
      },
      render: (_args, value: UserActionOutput) => [
        {
          type: 'text',
          text:
            value.action === 'open'
              ? `NEED_USER_ACTION：push #${value.pushId} 已暂停（action #${value.actionId}，kind=${value.detail ?? ''}）。请按 howToContinue 提示通知用户处理；完成后用 literature_resume 从原步骤继续。`
              : `action #${value.actionId} 已标记完成；push #${value.pushId} 状态=${value.pushStatus}（剩余待办 ${value.remainingOpen}）。`,
        },
      ],
    },
    async execute(args: UserActionInput): Promise<UserActionOutput> {
      const rt = getRt()
      if (args.action === 'open') {
        if (
          !args.step || !args.kind || !args.issue || !args.whatUserShouldDo || !args.howToContinue
        ) {
          throw new Error('open 需要 step/kind/issue/whatUserShouldDo/howToContinue（五要素）')
        }
        const row = openUserAction(rt.db, {
          pushId: args.pushId,
          paperId: args.paperId,
          step: args.step,
          kind: args.kind,
          issue: args.issue,
          attempts: args.attempts,
          whatUserShouldDo: args.whatUserShouldDo,
          howToContinue: args.howToContinue,
        })
        return jsonSafe({
          action: 'open',
          pushId: args.pushId,
          actionId: row.id,
          state: 'open',
          pushStatus: 'user_action_required',
          detail: row.kind,
        })
      }
      if (!args.actionId) throw new Error('resolve 需要 actionId')
      const row = resolveUserAction(rt.db, args.actionId)
      if (!row) throw new Error(`action #${args.actionId} 不存在`)
      const open = rt.db
        .prepare('SELECT COUNT(*) AS n FROM user_actions WHERE push_id = ? AND state = \'open\'')
        .get(args.pushId) as { n: number }
      const push = rt.db
        .prepare('SELECT status FROM pushes WHERE id = ?')
        .get(args.pushId) as { status: string } | undefined
      return jsonSafe({
        action: 'resolve',
        pushId: args.pushId,
        actionId: row.id,
        state: 'resolved',
        pushStatus: push?.status ?? 'unknown',
        remainingOpen: open.n,
        detail: args.note,
      })
    },
  })
}
