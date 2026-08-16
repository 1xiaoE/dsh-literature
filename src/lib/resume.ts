/**
 * Deterministic resume finalization — the 0-LLM path of `--resume`.
 *
 * For a push whose retrieval / ranking / selection / PDF / fulltext / report
 * are ALL already done and whose only remaining blocker was a user action
 * that is now resolved, resuming does NOT need a fresh agent reasoning pass:
 * this module reads the persisted state from SQLite, verifies everything the
 * finalize needs, and marks the push completed — resume_llm_call_count = 0,
 * no repeated retrieval/ranking/PDF/fulltext/report work.
 *
 * When the state does NOT satisfy the deterministic conditions (missing
 * paper, missing fulltext, missing canonical report, open user actions),
 * the caller falls back to the LLM-driven resume (literature_resume tool).
 */
import { existsSync, statSync } from 'node:fs'
import type { Db } from '../db.js'
import { getPush } from './history.js'
import { openActionsOfPush } from './user_actions.js'

export interface DeterministicFinalizeResult {
  finalized: boolean
  /** why the deterministic path cannot finalize (for the fallback decision) */
  reason?: string
  pushId?: number
  paperId?: string | null
  reportPath?: string | null
  /** elapsed wall time of the finalize step */
  resumeMs?: number
  /** always 0 on this path */
  resumeLlmCallCount?: number
}

/**
 * Try to finalize a parked push deterministically. Conditions:
 * 1. push exists and is not already terminal-completed;
 * 2. no open user actions (the user resolved them);
 * 3. a selected paper exists (pushes.paper_id or a SELECTED candidate);
 * 4. fulltext indexed ok for that paper;
 * 5. the canonical report exists and is non-empty.
 *
 * On success the push is set to completed with resume provenance
 * (resume_ms / resume_llm_call_count = 0) — nothing else is re-run.
 */
export function tryDeterministicFinalize(
  db: Db,
  pushId: number,
  opts: { now?: () => number } = {},
): DeterministicFinalizeResult {
  const now = opts.now ?? (() => Date.now())
  const started = now()
  const push = db
    .prepare('SELECT id, topic, stage, status, paper_id, report_path, started_at FROM pushes WHERE id = ?')
    .get(pushId) as
    | { id: number; topic: string; stage: number; status: string; paper_id: string | null; report_path: string | null; started_at: string }
    | undefined
  if (!push) return { finalized: false, reason: `push #${pushId} 不存在` }
  if (push.status === 'completed') {
    return { finalized: false, reason: `push #${pushId} 已是 completed` }
  }
  if (!['running', 'user_action_required', 'auth_required'].includes(push.status)) {
    return { finalized: false, reason: `push #${pushId} 状态 ${push.status} 不可确定性收口（终态）` }
  }

  // 1. pending user actions must be resolved
  const open = openActionsOfPush(db, pushId)
  if (open.length > 0) {
    return {
      finalized: false,
      reason: `push #${pushId} 仍有 ${open.length} 项未解决待办（${open.map((a) => `${a.id}:${a.kind}`).join('、')}）— 用户完成后重试`,
    }
  }

  // 2. selected paper
  let paperId = push.paper_id
  if (!paperId) {
    const sel = db
      .prepare(
        "SELECT paper_id FROM candidates WHERE push_id = ? AND selection_outcome = 'SELECTED' ORDER BY preflight_attempt_order LIMIT 1",
      )
      .get(pushId) as { paper_id: string } | undefined
    paperId = sel?.paper_id ?? null
  }
  if (!paperId) {
    return { finalized: false, reason: `push #${pushId} 无选中论文（SELECTED/picked 缺失）— 需要 agent 完成选择` }
  }

  // 3. fulltext indexed
  const ft = db
    .prepare("SELECT status FROM fulltexts WHERE paper_id = ? AND status = 'ok'")
    .get(paperId) as { status: string } | undefined
  if (!ft) {
    return { finalized: false, reason: `push #${pushId} 论文 ${paperId} 无已索引全文 — 需要 agent 完成下载/精读` }
  }

  // 4. canonical report exists and is non-empty
  const reportPath = push.report_path
  if (!reportPath || !existsSync(reportPath) || statSync(reportPath).size <= 0) {
    return { finalized: false, reason: `push #${pushId} canonical 报告缺失或为空（${reportPath ?? '无路径'}）— 需要 agent 调用 literature_report_write` }
  }

  // 5. finalize: mark completed, record deterministic-resume provenance
  const resumeMs = Math.max(0, now() - started)
  db.prepare(
    `UPDATE pushes SET status = 'completed', finished_at = datetime('now'),
       error_code = NULL, error_detail = NULL, paper_id = ?,
       resume_ms = ?, resume_llm_call_count = 0,
       notes = COALESCE(notes, '') || ' [deterministic resume finalize]'
     WHERE id = ?`,
  ).run(paperId, resumeMs, pushId)
  return {
    finalized: true,
    pushId,
    paperId,
    reportPath,
    resumeMs,
    resumeLlmCallCount: 0,
  }
}
