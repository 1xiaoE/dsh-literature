/**
 * Human-in-the-loop user actions (NEED_USER_ACTION). A push parks here when
 * the workflow hits a resource / auth / permission / download-channel /
 * research-choice problem that the USER can solve more easily than the
 * automation — instead of blind retries or a fake FULLTEXT_UNAVAILABLE.
 *
 * Each action carries the five-part record the user needs:
 *   step             — where the workflow is stuck
 *   issue            — what resource/permission/information is missing
 *   attempts         — what has already been tried
 *   whatUserShouldDo — what the user must do
 *   howToContinue    — how the workflow resumes after the user is done
 *
 * A push may hold several actions; it stays in 'user_action_required' until
 * every action is resolved, then flips back to 'running' so literature_resume
 * can continue from the original step (no re-retrieval, no re-scoring).
 */
import type { Db } from '../db.js'

export type UserActionState = 'open' | 'resolved'

export interface UserActionRow {
  id: number
  push_id: number
  paper_id: string | null
  step: string
  kind: string
  state: UserActionState
  issue: string
  attempts: string | null
  what_user_should_do: string
  how_to_continue: string
  created_at: string
  resolved_at: string | null
}

export interface NewUserAction {
  pushId: number
  paperId?: string
  /** where the workflow is stuck (sources/selection/preflight/fetch_pdf/fulltext_index/report/record) */
  step: string
  /** publisher_login | carsi_relogin | manual_pdf | version_choice | topic_decision | user_resource_needed | ... */
  kind: string
  issue: string
  attempts?: string[]
  whatUserShouldDo: string
  howToContinue: string
}

/** Park a push: insert an open action and switch the push to NEED_USER_ACTION. */
export function openUserAction(db: Db, a: NewUserAction): UserActionRow {
  const push = db.prepare('SELECT status FROM pushes WHERE id = ?').get(a.pushId) as
    | { status: string }
    | undefined
  if (!push) throw new Error(`push #${a.pushId} 不存在`)
  if (push.status !== 'running' && push.status !== 'user_action_required') {
    throw new Error(
      `push #${a.pushId} 状态为 ${push.status}，不能停车（仅 running / user_action_required 可注册 NEED_USER_ACTION）`,
    )
  }
  const info = db
    .prepare(
      `INSERT INTO user_actions (push_id, paper_id, step, kind, state, issue, attempts, what_user_should_do, how_to_continue)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    )
    .run(
      a.pushId,
      a.paperId ?? null,
      a.step,
      a.kind,
      a.issue,
      a.attempts && a.attempts.length > 0 ? JSON.stringify(a.attempts) : null,
      a.whatUserShouldDo,
      a.howToContinue,
    )
  db.prepare(
    `UPDATE pushes SET status = 'user_action_required', error_code = 'NEED_USER_ACTION',
       error_detail = ?, finished_at = NULL
     WHERE id = ? AND status IN ('running', 'user_action_required')`,
  ).run(`[${a.kind}] ${a.issue}`, a.pushId)
  const row = db
    .prepare('SELECT * FROM user_actions WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as unknown as UserActionRow
  return row
}

/** Mark one action resolved; flips the push back to 'running' when none remain open. */
export function resolveUserAction(db: Db, actionId: number): UserActionRow | undefined {
  const before = db.prepare('SELECT * FROM user_actions WHERE id = ?').get(actionId) as
    | UserActionRow
    | undefined
  if (!before) return undefined
  if (before.state !== 'resolved') {
    db.prepare(
      `UPDATE user_actions SET state = 'resolved', resolved_at = datetime('now') WHERE id = ?`,
    ).run(actionId)
  }
  const row = db.prepare('SELECT * FROM user_actions WHERE id = ?').get(actionId) as unknown as UserActionRow
  const open = db
    .prepare(
      `SELECT COUNT(*) AS n FROM user_actions WHERE push_id = ? AND state = 'open'`,
    )
    .get(before.push_id) as { n: number }
  if (open.n === 0) {
    db.prepare(
      `UPDATE pushes SET status = 'running', finished_at = NULL, error_code = NULL, error_detail = NULL
       WHERE id = ? AND status = 'user_action_required'`,
    ).run(before.push_id)
  }
  return row
}

/** Resolve every open action of a kind (e.g. all carsi_relogin after a manual re-login). */
export function resolveUserActionsByKind(db: Db, kind: string): number {
  const open = db
    .prepare(`SELECT id, push_id FROM user_actions WHERE kind = ? AND state = 'open'`)
    .all(kind) as Array<{ id: number; push_id: number }>
  for (const a of open) resolveUserAction(db, a.id)
  return open.length
}

/** Open actions of one push, newest first. */
export function openActionsOfPush(db: Db, pushId: number): UserActionRow[] {
  return db
    .prepare(
      `SELECT * FROM user_actions WHERE push_id = ? AND state = 'open' ORDER BY id DESC`,
    )
    .all(pushId) as unknown as UserActionRow[]
}

/** All open actions across pushes (for the user-facing CLI), newest first. */
export function listOpenActions(db: Db): UserActionRow[] {
  return db
    .prepare(
      `SELECT * FROM user_actions WHERE state = 'open' ORDER BY id DESC`,
    )
    .all() as unknown as UserActionRow[]
}

export function getPushActions(db: Db, pushId: number): UserActionRow[] {
  return db
    .prepare(`SELECT * FROM user_actions WHERE push_id = ? ORDER BY id`)
    .all(pushId) as unknown as UserActionRow[]
}
