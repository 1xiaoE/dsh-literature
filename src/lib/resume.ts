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
import type { Db } from '../db.js'
import type { LiteratureConfig } from '../config.js'
import { openActionsOfPush } from './user_actions.js'
import { finalizeCompletedPush } from './finalize.js'

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
  opts: { now?: () => number; config?: LiteratureConfig } = {},
): DeterministicFinalizeResult {
  const now = opts.now ?? (() => Date.now())
  const started = now()
  const push = db
    .prepare('SELECT id, topic, stage, status, paper_id, report_path, started_at, policy_json FROM pushes WHERE id = ?')
    .get(pushId) as
    | { id: number; topic: string; stage: number; status: string; paper_id: string | null; report_path: string | null; started_at: string; policy_json: string | null }
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

  // 3. Full completion is delegated to the SAME finalize core used by
  // literature_record. This prevents a 0-LLM resume from marking completed
  // while forgetting picked/knowledge_coverage/stage progression.
  const reportPath = push.report_path
  if (!reportPath) {
    return { finalized: false, reason: `push #${pushId} canonical 报告路径缺失 — 需要 agent 调用 literature_report_write` }
  }
  const goals = db
    .prepare('SELECT goal FROM knowledge_coverage WHERE push_id = ? AND paper_id = ? ORDER BY goal')
    .all(pushId, paperId) as Array<{ goal: string }>

  // Prefer an explicit runtime config (tests/in-process resume). For CLI resume,
  // use the normalized policy snapshot persisted when the push started. Old
  // pushes that predate policy snapshots safely fall back to the agent path.
  let cfg = opts.config
  if (!cfg && push.policy_json) {
    try {
      cfg = JSON.parse(push.policy_json) as LiteratureConfig
    } catch {
      // handled by the safe fallback below
    }
  }
  if (!cfg) {
    return {
      finalized: false,
      reason: `push #${pushId} 缺少创建时的 policy snapshot；为避免阶段/门槛配置漂移，安全回退到 literature_record`,
    }
  }
  try {
    finalizeCompletedPush(db, cfg, {
      pushId,
      paperId,
      reportPath,
      knowledgeGoals: goals.map((g) => g.goal),
      notes: '[deterministic resume finalize]',
    })
  } catch (err) {
    return {
      finalized: false,
      reason: `push #${pushId} 无法安全确定性收口：${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const resumeMs = Math.max(0, now() - started)
  db.prepare(
    `UPDATE pushes SET resume_ms = ?, resume_llm_call_count = 0,
       notes = COALESCE(notes, '') || ' [resume_llm=0]'
     WHERE id = ?`,
  ).run(resumeMs, pushId)
  return {
    finalized: true,
    pushId,
    paperId,
    reportPath,
    resumeMs,
    resumeLlmCallCount: 0,
  }
}
