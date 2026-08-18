import type { LiteratureConfig } from '../config.js'
import type { Db } from '../db.js'
import { agentFinalScore } from './ranking.js'
import { resolvePaperFields } from './research_fields.js'

export interface SemanticScoreEntry {
  paperId: string
  relevance: number
  learningValue: number
  representativeness: number
  novelty: number
  stageRelevance: number
  curriculumValue: number
  methodologicalCentrality?: number
  rationale: string
}

export type AcquisitionOutcome =
  | 'SELECTED'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'ACCESS_DENIED'
  | 'PDF_NOT_FOUND'
  | 'FULLTEXT_UNAVAILABLE'
  | 'PDF_FAILED'

export interface RankedCandidateState {
  paperId: string
  agentRank: number
  attemptOrder: number | null
  stageRelevance: number
  curriculumValue: number
  finalScore: number
  publicPreflightStatus: 'AVAILABLE' | 'UNAVAILABLE' | null
  acquisitionOutcome: AcquisitionOutcome | null
  acquisitionReason: string | null
}

function check01(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 必须位于 0..1（收到 ${value}）`)
  }
}

/**
 * Persist the agent's batch semantic scores BEFORE any PDF acquisition and
 * assign a stable, unique agent_rank. Ties are broken by deterministic
 * rank_hint, then paper_id, so acquisition never depends on agent call order.
 */
export function persistSemanticScores(
  db: Db,
  pushId: number,
  scores: SemanticScoreEntry[],
  cfg: LiteratureConfig,
  curriculumWeight?: number,
): RankedCandidateState[] {
  if (scores.length === 0) throw new Error('语义评分为空：必须先对 deterministic Top-N 做批量评分')
  db.exec('BEGIN IMMEDIATE')
  try {
    const seen = new Set<string>()
    const update = db.prepare(
      `UPDATE candidates SET
         relevance_score = ?, learning_value_score = ?, representative_score = ?,
         novelty_score = ?, stage_relevance_score = ?, curriculum_value = ?,
         methodological_centrality = ?, final_score = ?, rationale = ?
       WHERE push_id = ? AND paper_id = ?`,
    )

    for (const s of scores) {
      if (seen.has(s.paperId)) throw new Error(`scores 中 paperId 重复：${s.paperId}`)
      seen.add(s.paperId)
      check01('relevance', s.relevance)
      check01('learningValue', s.learningValue)
      check01('representativeness', s.representativeness)
      check01('novelty', s.novelty)
      check01('stageRelevance', s.stageRelevance)
      check01('curriculumValue', s.curriculumValue)
      if (s.methodologicalCentrality !== undefined) check01('methodologicalCentrality', s.methodologicalCentrality)
      const final = agentFinalScore(
        {
          relevance: s.relevance,
          learningValue: s.learningValue,
          representativeness: s.representativeness,
          novelty: s.novelty,
          stageRelevance: s.stageRelevance,
          curriculumValue: s.curriculumValue,
        },
        cfg,
        curriculumWeight,
      )
      const res = update.run(
        s.relevance,
        s.learningValue,
        s.representativeness,
        s.novelty,
        s.stageRelevance,
        s.curriculumValue,
        s.methodologicalCentrality ?? null,
        final,
        s.rationale,
        pushId,
        s.paperId,
      )
      if (Number(res.changes) !== 1) throw new Error(`评分论文不属于 push #${pushId}：${s.paperId}`)
    }

    // Rank ONLY the papers scored in this batch: a partial re-score must never
    // let stale scores from an earlier batch re-enter the ranking.
    const placeholders = scores.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT paper_id, final_score, rank_hint, stage_relevance_score, curriculum_value
         FROM candidates
         WHERE push_id = ? AND final_score IS NOT NULL AND paper_id IN (${placeholders})
         ORDER BY final_score DESC, COALESCE(rank_hint, 999999) ASC, paper_id ASC`,
      )
      .all(pushId, ...scores.map((s) => s.paperId)) as Array<{
      paper_id: string
      final_score: number
      rank_hint: number | null
      stage_relevance_score: number
      curriculum_value: number
    }>

    const setRank = db.prepare('UPDATE candidates SET agent_rank = ? WHERE push_id = ? AND paper_id = ?')
    const setBelow = db.prepare(
      `UPDATE candidates SET selection_outcome = 'BELOW_QUALITY_GATE', selection_rejection_reason = ?
       WHERE push_id = ? AND paper_id = ? AND acquisition_outcome IS NULL`,
    )
    const clearBelow = db.prepare(
      `UPDATE candidates SET selection_outcome = NULL, selection_rejection_reason = NULL
       WHERE push_id = ? AND paper_id = ? AND selection_outcome = 'BELOW_QUALITY_GATE' AND acquisition_outcome IS NULL`,
    )
    rows.forEach((r, i) => {
      const rank = i + 1
      setRank.run(rank, pushId, r.paper_id)
      if (r.stage_relevance_score < cfg.stageRelevanceThreshold || r.curriculum_value < cfg.curriculumValueThreshold) {
        setBelow.run(
          `quality gate: stage=${r.stage_relevance_score} (>=${cfg.stageRelevanceThreshold}), curriculum=${r.curriculum_value} (>=${cfg.curriculumValueThreshold})`,
          pushId,
          r.paper_id,
        )
      } else {
        clearBelow.run(pushId, r.paper_id)
      }
    })
    db.exec('COMMIT')
    return rankedCandidateStates(db, pushId)
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function rankedCandidateStates(db: Db, pushId: number): RankedCandidateState[] {
  return db
    .prepare(
      `SELECT paper_id, agent_rank, preflight_attempt_order, stage_relevance_score, curriculum_value,
              final_score, public_preflight_status, acquisition_outcome, acquisition_reason
       FROM candidates WHERE push_id = ? AND agent_rank IS NOT NULL
       ORDER BY agent_rank ASC`,
    )
    .all(pushId)
    .map((r: any) => ({
      paperId: String(r.paper_id),
      agentRank: Number(r.agent_rank),
      attemptOrder: r.preflight_attempt_order == null ? null : Number(r.preflight_attempt_order),
      stageRelevance: Number(r.stage_relevance_score),
      curriculumValue: Number(r.curriculum_value),
      finalScore: Number(r.final_score),
      publicPreflightStatus: r.public_preflight_status as 'AVAILABLE' | 'UNAVAILABLE' | null,
      acquisitionOutcome: r.acquisition_outcome as AcquisitionOutcome | null,
      acquisitionReason: r.acquisition_reason == null ? null : String(r.acquisition_reason),
    }))
}

function isQualityPassed(c: RankedCandidateState, cfg: LiteratureConfig): boolean {
  return c.stageRelevance >= cfg.stageRelevanceThreshold && c.curriculumValue >= cfg.curriculumValueThreshold
}

function isSkippableTerminal(outcome: AcquisitionOutcome | null): boolean {
  return outcome === 'ACCESS_DENIED' || outcome === 'PDF_NOT_FOUND' || outcome === 'FULLTEXT_UNAVAILABLE' || outcome === 'PDF_FAILED'
}

/**
 * Return the only candidate that may be acquired now. AUTH_REQUIRED and
 * RATE_LIMITED deliberately remain on the same paper; they never allow a
 * lower-ranked paper to leapfrog it. Only explicit paper-level terminal
 * outcomes advance the queue.
 */
export function nextAcquisitionCandidate(
  db: Db,
  pushId: number,
  cfg: LiteratureConfig,
): { candidate?: RankedCandidateState; selected?: RankedCandidateState; exhausted: boolean } {
  const ranked = rankedCandidateStates(db, pushId)
  const eligible = ranked.filter((c) => isQualityPassed(c, cfg)).slice(0, cfg.maxSelectionAttempts)
  const selected = eligible.find((c) => c.acquisitionOutcome === 'SELECTED')
  if (selected) return { selected, exhausted: false }
  for (const c of eligible) {
    if (isSkippableTerminal(c.acquisitionOutcome)) continue
    return { candidate: c, exhausted: false }
  }
  return { exhausted: true }
}

export function ensureAcquisitionTurn(
  db: Db,
  pushId: number,
  paperId: string,
  cfg: LiteratureConfig,
): RankedCandidateState {
  const next = nextAcquisitionCandidate(db, pushId, cfg)
  if (next.selected) {
    throw new Error(`invariant: push #${pushId} 已 SELECTED ${next.selected.paperId}；禁止继续 acquisition`)
  }
  if (!next.candidate) {
    throw new Error(`push #${pushId} 没有剩余的质量门达标候选可获取`)
  }
  if (next.candidate.paperId !== paperId) {
    throw new Error(
      `Quality First invariant: 当前必须处理 agentRank #${next.candidate.agentRank} ${next.candidate.paperId}；不得跳到 ${paperId}`,
    )
  }
  return next.candidate
}

/**
 * Allocate the next acquisition attemptOrder (1-based, contiguous) for the
 * paper. Called only AFTER every guard (preflight done, allowInstitutional,
 * rank match) passed — a rejected call must never consume an attempt slot.
 */
export function allocateAttemptOrder(db: Db, pushId: number, paperId: string): number {
  const n = (
    db
      .prepare('SELECT COUNT(*) AS n FROM candidates WHERE push_id = ? AND preflight_attempt_order IS NOT NULL')
      .get(pushId) as { n: number }
  ).n
  const order = n + 1
  db.prepare('UPDATE candidates SET preflight_attempt_order = ? WHERE push_id = ? AND paper_id = ?').run(
    order,
    pushId,
    paperId,
  )
  return order
}

export function markPublicPreflight(db: Db, pushId: number, paperId: string, available: boolean): void {
  db.prepare(
    `UPDATE candidates SET public_preflight_status = ? WHERE push_id = ? AND paper_id = ?`,
  ).run(available ? 'AVAILABLE' : 'UNAVAILABLE', pushId, paperId)
}

export function markAcquisitionOutcome(
  db: Db,
  pushId: number,
  paperId: string,
  outcome: AcquisitionOutcome,
  reason?: string,
): void {
  const selectionOutcome =
    outcome === 'SELECTED'
      ? 'SELECTED'
      : isSkippableTerminal(outcome)
        ? outcome === 'PDF_FAILED'
          ? 'PDF_FAILED'
          : 'FULLTEXT_UNAVAILABLE'
        : null
  db.prepare(
    `UPDATE candidates SET acquisition_outcome = ?, acquisition_reason = ?,
       selection_outcome = COALESCE(?, selection_outcome),
       selection_rejection_reason = COALESCE(?, selection_rejection_reason)
     WHERE push_id = ? AND paper_id = ?`,
  ).run(outcome, reason ?? null, selectionOutcome, reason ?? null, pushId, paperId)
  // Library entry point: a SELECTED paper enters the knowledge base and is
  // auto-classified into Research Fields. Retrieved-only candidates stay out.
  if (outcome === 'SELECTED') resolvePaperFields(db, paperId)
}
