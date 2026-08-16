/**
 * Two-stage ranking. Stage A (this module) is deterministic and runs
 * program-side with configurable weights: recency, impact, topic similarity,
 * fulltext availability. Stage B (agent semantic ranking) is executed by the
 * agent's model and recorded via literature_record — the plugin never calls
 * an LLM itself.
 */
import type { LiteratureConfig, StageDef } from '../config.js'

export interface PreRankInput {
  title: string
  abstract?: string
  year?: number
  citations?: number
  /** whether an open/legal PDF candidate was found without downloading */
  fulltextAvailable: boolean
  /** deterministic stage relevance hint (0..1), from the caller */
  stageRelevance?: number
  /** normalized uncovered-knowledge-goal coverage hint (0..1) */
  knowledgeGap?: number
  /** priority knowledge goal match strength (0..1), from priorityGoalMatchScore */
  priorityGoalMatch?: number
}

export interface PreRankContext {
  /** resolved topic text (canonical queries of the ACTIVE topic — not cfg.topics[0]) */
  topicText: string
  currentYear: number
}

export interface PreRankResult {
  recencyScore: number
  impactScore: number
  topicSimilarity: number
  fulltextAvailable: boolean
  stageRelevanceScore: number
  /** weighted deterministic total */
  score: number
}

export interface StageRelevanceResult {
  /** deterministic hint in [0,1] from keyword overlap */
  score: number
  /** true when any exclude keyword matches (paper is ineligible for this stage) */
  excluded: boolean
  matchedPreferred: string[]
  matchedDownweight: string[]
}

const STOP = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'on', 'in', 'with', 'to', 'from', 'via',
  '基于', '一种', '用于', '及其', '与', '和', '的', '在',
])

function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (t.length > 1 && !STOP.has(t)) out.add(t)
  }
  return out
}

/** Jaccard-style overlap between the topic token set and candidate text tokens. */
export function topicSimilarity(topic: string, text: string): number {
  const a = tokens(topic)
  const b = tokens(text)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / Math.sqrt(a.size * b.size)
}

/** Linear recency: 1 for the current year, 0 at the start of the window. */
export function recencyScore(year: number | undefined, currentYear: number, windowYears: number): number {
  if (year === undefined) return 0.5
  const age = currentYear - year
  if (age <= 0) return 1
  return Math.max(0, 1 - age / windowYears)
}

/** Log-scaled citation impact, saturated at ~1000 citations. */
export function impactScore(citations: number | undefined): number {
  if (citations === undefined) return 0
  if (citations <= 0) return 0
  return Math.min(1, Math.log10(citations + 1) / 3)
}

/** Deterministic pre-ranking of one candidate (Stage A). */
export function preRank(
  input: PreRankInput,
  cfg: LiteratureConfig,
  ctx: PreRankContext,
  pool: 'recent' | 'landmark' = 'recent',
): PreRankResult {
  const w = cfg.ranking
  const sim = topicSimilarity(ctx.topicText, `${input.title} ${input.abstract ?? ''}`)
  // landmark candidates are old by definition: neutral recency so impact/stage
  // signals (not the year filter) decide their standing
  const recency =
    pool === 'landmark'
      ? 0.5
      : recencyScore(input.year, ctx.currentYear, cfg.yearsPrefer.length || 5)
  const impact = impactScore(input.citations)
  const fulltext = input.fulltextAvailable ? 1 : 0
  const stageRel = input.stageRelevance ?? 0
  const gap = Math.max(0, Math.min(1, input.knowledgeGap ?? 0))
  const pg = Math.max(0, Math.min(1, input.priorityGoalMatch ?? 0))
  const pgW = w.priorityGoal ?? 0
  let score =
    w.recency * recency +
    w.impact * impact +
    w.topicSimilarity * sim +
    w.fulltextAvailability * fulltext +
    w.stageRelevance * stageRel +
    w.knowledgeGap * gap +
    pgW * pg
  if (stageRel <= 0) {
    // stage-excluded papers are heavily penalized in the deterministic order
    score *= 0.6
  }
  return {
    recencyScore: recency,
    impactScore: impact,
    topicSimilarity: sim,
    fulltextAvailable: input.fulltextAvailable,
    stageRelevanceScore: stageRel,
    score,
  }
}

/** Agent-side weighted final score (Stage B), computed from recorded scores. */
export function agentFinalScore(
  scores: {
    relevance: number
    learningValue: number
    representativeness: number
    novelty: number
    stageRelevance: number
    curriculumValue: number
  },
  cfg: LiteratureConfig,
  curriculumWeight?: number,
): number {
  const w = { ...cfg.agentRanking }
  if (curriculumWeight !== undefined) {
    // per-stage curriculum boost (e.g. Fundamentals 0.35): substitute the
    // curriculum weight and renormalize the remaining weights to sum to 1
    const old = w.curriculumValue
    const others = Math.max(0, 1 - old)
    const scale = others > 0 ? (1 - curriculumWeight) / others : 0
    w.curriculumValue = curriculumWeight
    w.relevance *= scale
    w.learningValue *= scale
    w.representativeness *= scale
    w.novelty *= scale
    w.stageRelevance *= scale
  }
  return (
    w.relevance * scores.relevance +
    w.learningValue * scores.learningValue +
    w.representativeness * scores.representativeness +
    w.novelty * scores.novelty +
    w.stageRelevance * scores.stageRelevance +
    w.curriculumValue * scores.curriculumValue
  )
}

function normKw(kw: string): string {
  return kw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * Deterministic stage-relevance hint: keyword overlap between the paper
 * (title + abstract) and the stage's preferred/downweight/exclude concepts.
 * Any exclude hit disqualifies (score 0, excluded=true).
 */
export function stageRelevanceHint(text: string, stage: StageDef): StageRelevanceResult {
  const hay = ` ${normKw(text)} `
  const matchedPreferred: string[] = []
  const matchedDownweight: string[] = []
  for (const kw of stage.preferredKeywords) {
    const n = normKw(kw)
    if (n.length >= 2 && hay.includes(` ${n} `)) matchedPreferred.push(kw)
  }
  for (const kw of stage.downweightKeywords) {
    const n = normKw(kw)
    if (n.length >= 2 && hay.includes(` ${n} `)) matchedDownweight.push(kw)
  }
  const excluded = stage.excludeKeywords.some((kw) => {
    const n = normKw(kw)
    return n.length >= 2 && hay.includes(` ${n} `)
  })
  if (excluded) {
    return { score: 0, excluded: true, matchedPreferred, matchedDownweight }
  }
  const p = matchedPreferred.length
  const d = matchedDownweight.length
  // logistic-ish: baseline 0.3, +0.18 per preferred hit, -0.22 per downweight hit
  const raw = 0.3 + 0.18 * p - 0.22 * d
  const score = Math.max(0, Math.min(1, raw))
  return { score, excluded, matchedPreferred, matchedDownweight }
}

/** Top venues whose presence counts toward landmark/curriculum signals. */
const LANDMARK_VENUES: Array<{ re: RegExp; name: string }> = [
  { re: /international journal of robotics research/i, name: 'IJRR' },
  { re: /ieee transactions on robotics/i, name: 'IEEE T-RO' },
  { re: /science robotics/i, name: 'Science Robotics' },
  { re: /nature machine intelligence/i, name: 'Nature Machine Intelligence' },
  { re: /robotics and automation letters/i, name: 'RA-L' },
  { re: /intelligent robots and systems/i, name: 'IROS' },
  { re: /robotics and automation.*conference/i, name: 'ICRA' },
  { re: /robotics: science and systems/i, name: 'RSS' },
  { re: /conference on robot learning/i, name: 'CoRL' },
]

export function venueBonus(venue: string | undefined): number {
  if (!venue) return 0
  for (const v of LANDMARK_VENUES) {
    if (v.re.test(venue)) return 1
  }
  return 0
}

/**
 * Deterministic curriculum hint: how central/representative a paper is for
 * systematically learning the current stage. Boosts foundational/method-
 * central signals and top venues; penalizes overly specific application /
 * single-robot design-case studies.
 */
export function curriculumHint(
  text: string,
  venue: string | undefined,
  opts: { centrality?: string[]; caseStudy?: string[] } = {},
): { score: number; reasons: string[] } {
  const hay = ` ${normKw(text)} `
  const centrality =
    opts.centrality ??
    [
      'template model', 'inverted pendulum', 'control framework', 'control architecture',
      'simplified model', 'analysis', 'principle', 'dynamics model', 'general framework',
      'walking pattern', 'gait generation', 'zmp', 'impedance control', 'whole-body control',
    ]
  const caseStudy =
    opts.caseStudy ??
    [
      'case study', 'design of a', 'prototype', 'experimental platform',
      'application', 'specific robot', 'a novel leg design', 'mechanism design',
    ]
  const centralHits = centrality.filter((k) => {
    const n = normKw(k)
    return n.length >= 2 && hay.includes(` ${n} `)
  })
  const caseHits = caseStudy.filter((k) => {
    const n = normKw(k)
    return n.length >= 2 && hay.includes(` ${n} `)
  })
  const venueScore = venueBonus(venue)
  let raw = 0.25 + 0.18 * Math.min(2, centralHits.length) - 0.25 * Math.min(1, caseHits.length) + 0.2 * venueScore
  const score = Math.max(0, Math.min(1, raw))
  const reasons: string[] = []
  if (centralHits.length > 0) reasons.push(`centrality: ${centralHits.slice(0, 3).join(',')}`)
  if (caseHits.length > 0) reasons.push(`case-study: ${caseHits.slice(0, 3).join(',')}`)
  if (venueScore > 0) reasons.push('top-venue')
  return { score, reasons }
}

/** Deterministic landmark confidence: seeds → 1.0; else eligibility + venue. */
export function landmarkConfidence(
  input: { eligibilityScore: number; stageHint: number; impact: number; venue: number; seedMatch: boolean },
): number {
  if (input.seedMatch) return 1
  return Math.max(
    0,
    Math.min(1, 0.3 * input.eligibilityScore + 0.35 * input.impact + 0.2 * input.venue + 0.15 * input.stageHint),
  )
}

/**
 * Knowledge-gap hint: how many of the stage's UNCOVERED goals this paper's
 * keywords plausibly cover. Returns the matched uncovered goal ids.
 */
export function knowledgeGapHint(
  text: string,
  uncoveredGoals: Array<{ id: string; label: string; keywords: string[] }>,
): { matched: string[]; score: number } {
  const hay = ` ${normKw(text)} `
  const matched: string[] = []
  for (const g of uncoveredGoals) {
    for (const k of g.keywords) {
      const n = normKw(k)
      if (n.length >= 2 && hay.includes(` ${n} `)) {
        matched.push(g.id)
        break
      }
    }
  }
  return { matched, score: matched.length }
}

/**
 * Priority-goal match STRENGTH (0..1): how clearly the paper's title+abstract
 * hits the priority knowledge goal's concept keywords. The more independent
 * concepts of the goal are present, the stronger the match — a single
 * keyword hit is a weak hint (~0.35), three or more saturate at 1.0.
 *
 * This is a deterministic pre-ranking signal only; it never bypasses the
 * stage/curriculum/fulltext gates.
 */
export function priorityGoalMatchScore(
  text: string,
  goal: { keywords: string[] },
): { score: number; matched: string[] } {
  const hay = ` ${normKw(text)} `
  const matched: string[] = []
  for (const k of goal.keywords) {
    const n = normKw(k)
    if (n.length >= 2 && hay.includes(` ${n} `)) matched.push(k)
  }
  if (matched.length === 0) return { score: 0, matched }
  return { score: Math.min(1, 0.35 * matched.length), matched }
}
