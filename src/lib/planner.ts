/**
 * Literature Query Planner.
 *
 * - Topic normalization: user input may be Chinese, but academic retrieval
 *   uses the topic's English canonical/secondary queries.
 * - Stage-aware query expansion: queries = topic queries ∪ stage searchQueries
 *   (later-stage keywords never pollute earlier stages by construction).
 * - Recent/Landmark pool separation: never "remove the year filter" ad hoc;
 *   landmark eligibility is scored (stage relevance + impact + venue +
 *   representativeness proxy) and capped by config.
 * - Negative terms drop off-topic hits at merge time.
 */
import type { LiteratureConfig, StageDef, TopicDef } from '../config.js'
import { impactScore, venueBonus } from './ranking.js'

export type QueryKind = 'canonical' | 'secondary' | 'stage'
export type PoolKind = 'recent' | 'landmark'

export interface PlannedQuery {
  text: string
  language: 'en'
  kind: QueryKind
  pool: PoolKind
}

export interface LandmarkEligibility {
  eligible: boolean
  score: number
  reasons: string[]
}

/** Deterministic landmark eligibility: stage relevance + impact + venue. */
export function landmarkEligibility(
  input: { year?: number; citations?: number; venue?: string; stageHint: number; stageMatched: number },
  cfg: LiteratureConfig,
): LandmarkEligibility {
  const r = cfg.retrieval
  const reasons: string[] = []
  if ((input.stageMatched ?? 0) < 1) {
    return {
      eligible: false,
      score: 0,
      reasons: [`no preferred stage concept matched (${input.stageMatched})`],
    }
  }
  if (input.stageHint < r.landmarkMinHint) {
    return { eligible: false, score: 0, reasons: [`stage_hint ${input.stageHint.toFixed(2)} < ${r.landmarkMinHint}`] }
  }
  const impact = impactScore(input.citations)
  const venue = venueBonus(input.venue)
  // representativeness proxy: venue + impact; stage fit: hint
  const score = 0.4 * input.stageHint + 0.35 * impact + 0.25 * venue
  reasons.push(`stage_hint=${input.stageHint.toFixed(2)}`, `preferred_matches=${input.stageMatched}`)
  if (input.citations !== undefined) reasons.push(`citations=${input.citations}`)
  if (venue > 0) reasons.push('top-venue')
  if (score >= r.landmarkMinScore) {
    return { eligible: true, score, reasons }
  }
  return { eligible: false, score, reasons: [...reasons, `eligibility ${score.toFixed(2)} < ${r.landmarkMinScore}`] }
}

function normQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Plan retrieval queries for (topic, stage, pool).
 * Recent: canonical + secondary + stage search queries.
 * Landmark: canonical + stage search queries (no secondary; bounded cost).
 */
export function planQueries(
  topic: TopicDef,
  stage: StageDef | undefined,
  pool: PoolKind,
): PlannedQuery[] {
  const out: PlannedQuery[] = []
  const seen = new Set<string>()
  const push = (text: string, kind: QueryKind): void => {
    const n = normQuery(text)
    if (n.length < 3 || seen.has(n)) return
    seen.add(n)
    out.push({ text: n, language: 'en', kind, pool })
  }
  for (const q of topic.canonicalQueries) push(q, 'canonical')
  if (pool === 'recent') {
    for (const q of topic.secondaryQueries) push(q, 'secondary')
  }
  for (const q of stage?.searchQueries ?? []) push(q, 'stage')
  if (pool === 'landmark') {
    // curated seeds double as retrieval anchors (title-as-query)
    for (const seed of stage?.landmarkSeeds ?? []) push(seed.title, 'stage')
  }
  return out
}

/** Resolve a configured topic or normalize an arbitrary user-supplied topic. */
export function resolveTopic(
  topics: TopicDef[],
  input: string | undefined,
): TopicDef {
  if (input) {
    const hit = topics.find((t) => t.id === input || t.displayName === input)
    if (hit) return hit
    return { id: input, displayName: input, canonicalQueries: [input], secondaryQueries: [], negativeTerms: [] }
  }
  return topics[0]!
}

/** Drop papers whose title/abstract matches any negative term. */
export function applyNegativeFilter(
  papers: Array<{ title: string; abstract?: string }>,
  negativeTerms: string[],
): { kept: Array<{ title: string; abstract?: string }>; dropped: number } {
  const hay = (p: { title: string; abstract?: string }): string =>
    `${p.title} ${p.abstract ?? ''}`.toLowerCase()
  const terms = negativeTerms.map((t) => t.toLowerCase())
  const kept: Array<{ title: string; abstract?: string }> = []
  let dropped = 0
  for (const p of papers) {
    const h = hay(p)
    if (terms.some((t) => t.length >= 2 && h.includes(t))) {
      dropped += 1
    } else {
      kept.push(p)
    }
  }
  return { kept, dropped }
}

/** Whether a paper matches a curated landmark seed (doi / arxiv id / title). */
export function matchSeed(
  paper: { doi?: string; arxivId?: string; title: string },
  seeds: Array<{ doi?: string; arxivId?: string; title: string }>,
): boolean {
  const pt = (paper.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return seeds.some((seed) => {
    if (seed.doi && paper.doi && seed.doi.toLowerCase() === paper.doi.toLowerCase()) return true
    if (seed.arxivId && paper.arxivId && seed.arxivId.toLowerCase() === paper.arxivId.toLowerCase()) return true
    const st = seed.title.toLowerCase().replace(/\s+/g, ' ').trim()
    return st.length >= 8 && (pt.includes(st) || st.includes(pt))
  })
}

/**
 * Priority knowledge goal = the FIRST uncovered goal in the stage's
 * knowledgeGoals order (the order itself encodes the curriculum priority).
 */
export function firstUncoveredGoal(
  stage: { knowledgeGoals: Array<{ id: string; label: string; keywords: string[] }> },
  covered: Set<string>,
): { id: string; label: string; keywords: string[] } | undefined {
  return stage.knowledgeGoals.find((g) => !covered.has(g.id))
}

/** Required goals of the stage that are still uncovered (pending). */
export function pendingRequiredGoals(
  stage: { requiredGoals?: string[] },
  covered: Set<string>,
): string[] {
  return (stage.requiredGoals ?? []).filter((g) => !covered.has(g))
}

export interface PriorityGoalDecision {
  /** the goal the retrieval/ranking signals should prioritize */
  goal?: { id: string; label: string; keywords: string[] }
  /**
   * 'completion': papers_in_stage already reached targetPapers - 1 and a
   * required goal is still uncovered — the FINAL paper that graduates the
   * stage MUST genuinely cover that required goal (full-text judgment), it
   * is no longer just a ranking preference.
   * 'normal': ordinary preference mode.
   */
  mode: 'normal' | 'completion'
  /** required goals still pending (the reason the stage cannot graduate yet) */
  pendingRequired: string[]
}

/**
 * Decide the priority goal and whether the stage entered required-goal
 * completion mode:
 *
 *   completion mode ⇔ papers_in_stage >= targetPapers - 1
 *                    AND at least one required goal is still uncovered.
 *
 * In completion mode the priority goal is pinned to the first uncovered
 * REQUIRED goal (e.g. impedance_compliance for Fundamentals) — never a
 * non-required preference. In normal mode it stays the first uncovered
 * knowledge goal (a recommendation, not a hard gate).
 */
export function decidePriorityGoal(
  stage: { knowledgeGoals: Array<{ id: string; label: string; keywords: string[] }>; requiredGoals?: string[] },
  covered: Set<string>,
  papersInStage: number,
  targetPapers: number,
): PriorityGoalDecision {
  const pendingRequired = pendingRequiredGoals(stage, covered)
  const completionMode = papersInStage >= Math.max(1, targetPapers - 1) && pendingRequired.length > 0
  if (completionMode) {
    const goal = stage.knowledgeGoals.find((g) => g.id === pendingRequired[0])
    return { goal, mode: 'completion', pendingRequired }
  }
  return { goal: firstUncoveredGoal(stage, covered), mode: 'normal', pendingRequired }
}
