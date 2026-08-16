/**
 * Per-push performance accumulator (V0.1 performance audit).
 *
 * Plugin-side phases are timed inside the literature_* tools and accumulated
 * per pushId; agent-side phases (agent_ranking_ms, report_generation_ms,
 * llm_call_count, llm_retry_count) are reported by the agent through
 * literature_record. literature_record flushes everything into the pushes
 * row (columns added by the v10 migration).
 *
 * All values are additive: a tool may run several times per push (e.g.
 * fulltext_read per chunk) and the timings accumulate.
 */
import type { Db } from '../db.js'

export interface PushPerf {
  totalMs: number
  retrievalMs: number
  deterministicRankingMs: number
  agentRankingMs: number
  pdfPreflightMs: number
  pdfDownloadMs: number
  parsingMs: number
  fulltextReadMs: number
  reportGenerationMs: number
  rawCandidates: number
  deterministicCandidates: number
  agentScoredCandidates: number
  llmCallCount: number
  llmRetryCount: number
  pdfAttemptCount: number
  arxivRequests: number
  arxivDedupHits: number
  arxiv429Count: number
  arxivRetryCount: number
  arxivRateLimited: number
  arxivWaitMs: number
}

export type PushPerfPatch = Partial<PushPerf>

export class PerfTracker {
  private readonly map = new Map<number, PushPerf>()

  /** Accumulate a patch for a push (missing keys treated as 0). */
  add(pushId: number, patch: PushPerfPatch): void {
    if (pushId === undefined || pushId === null) return
    const cur = this.map.get(pushId) ?? emptyPerf()
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        cur[k as keyof PushPerf] = (cur[k as keyof PushPerf] ?? 0) + v
      }
    }
    this.map.set(pushId, cur)
  }

  /** Snapshot the accumulated perf of a push (zeros when absent). */
  get(pushId: number): PushPerf {
    return { ...emptyPerf(), ...(this.map.get(pushId) ?? {}) }
  }

  /** Persist the accumulated perf into the pushes row and clear the entry. */
  flush(db: Db, pushId: number, overrides: PushPerfPatch = {}): PushPerf {
    const perf = this.get(pushId)
    const merged: PushPerf = { ...perf, ...overrides }
    db.prepare(
      `UPDATE pushes SET
         retrieval_ms = ?, deterministic_ranking_ms = ?, agent_ranking_ms = ?,
         pdf_preflight_ms = ?, pdf_download_ms = ?, parsing_ms = ?,
         fulltext_read_ms = ?, report_generation_ms = ?, total_ms = ?,
         raw_candidates = ?, deterministic_candidates = ?, agent_scored_candidates = ?,
         llm_call_count = ?, llm_retry_count = ?, pdf_attempt_count = ?,
         arxiv_requests = ?, arxiv_dedup_hits = ?, arxiv_429_count = ?,
         arxiv_retry_count = ?, arxiv_rate_limited = ?, arxiv_wait_ms = ?
       WHERE id = ?`,
    ).run(
      merged.retrievalMs || null,
      merged.deterministicRankingMs || null,
      merged.agentRankingMs || null,
      merged.pdfPreflightMs || null,
      merged.pdfDownloadMs || null,
      merged.parsingMs || null,
      merged.fulltextReadMs || null,
      merged.reportGenerationMs || null,
      merged.totalMs || null,
      merged.rawCandidates || null,
      merged.deterministicCandidates || null,
      merged.agentScoredCandidates || null,
      merged.llmCallCount || null,
      merged.llmRetryCount || null,
      merged.pdfAttemptCount || null,
      merged.arxivRequests || null,
      merged.arxivDedupHits || null,
      merged.arxiv429Count || null,
      merged.arxivRetryCount || null,
      merged.arxivRateLimited || null,
      merged.arxivWaitMs || null,
      pushId,
    )
    this.map.delete(pushId)
    return merged
  }
}

export function emptyPerf(): PushPerf {
  return {
    totalMs: 0,
    retrievalMs: 0,
    deterministicRankingMs: 0,
    agentRankingMs: 0,
    pdfPreflightMs: 0,
    pdfDownloadMs: 0,
    parsingMs: 0,
    fulltextReadMs: 0,
    reportGenerationMs: 0,
    rawCandidates: 0,
    deterministicCandidates: 0,
    agentScoredCandidates: 0,
    llmCallCount: 0,
    llmRetryCount: 0,
    pdfAttemptCount: 0,
    arxivRequests: 0,
    arxivDedupHits: 0,
    arxiv429Count: 0,
    arxivRetryCount: 0,
    arxivRateLimited: 0,
    arxivWaitMs: 0,
  }
}

/**
 * Resolve the push a paper belongs to (for tools without a pushId argument):
 * the most recent running / user_action_required push containing the paper.
 */
export function resolvePushId(
  db: Db,
  paperId: string,
  explicitPushId?: number,
): number | undefined {
  if (explicitPushId !== undefined && explicitPushId !== null) return explicitPushId
  const row = db
    .prepare(
      `SELECT c.push_id FROM candidates c
       JOIN pushes p ON p.id = c.push_id
       WHERE c.paper_id = ? AND p.status IN ('running','user_action_required')
       ORDER BY c.push_id DESC LIMIT 1`,
    )
    .get(paperId) as { push_id: number } | undefined
  return row?.push_id
}
