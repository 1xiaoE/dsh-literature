/**
 * Reading-stage progression. A stage does NOT auto-advance per push: it
 * advances only when BOTH (a) the number of stage-matched completed picks
 * reaches target_papers AND (b) the minimum knowledge-goal coverage is met
 * (union of goals covered by completed picks in the current stage), or when
 * the agent explicitly requests a manual advance.
 */
import type { Db } from '../db.js'

export interface StageState {
  topic: string
  current: number
  papersInStage: number
  targetPapers: number
  /** goal ids covered by completed picks in the current stage */
  coveredGoals: string[]
}

export function ensureStage(db: Db, topic: string, targetPapers: number): StageState {
  db.prepare(
    `INSERT INTO stages (topic, current, papers_in_stage, target_papers, covered_goals)
     VALUES (?, 1, 0, ?, '[]')
     ON CONFLICT(topic) DO UPDATE SET target_papers = excluded.target_papers`,
  ).run(topic, targetPapers)
  return getStage(db, topic)
}

function parseGoals(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function getStage(db: Db, topic: string): StageState {
  const row = db
    .prepare('SELECT current, papers_in_stage, target_papers, covered_goals FROM stages WHERE topic = ?')
    .get(topic) as
    | { current: number; papers_in_stage: number; target_papers: number; covered_goals: string | null }
    | undefined
  if (!row) {
    return { topic, current: 1, papersInStage: 0, targetPapers: 3, coveredGoals: [] }
  }
  return {
    topic,
    current: row.current,
    papersInStage: row.papers_in_stage,
    targetPapers: row.target_papers,
    coveredGoals: parseGoals(row.covered_goals),
  }
}

/**
 * Record one completed pick in the current stage, tagging the goals it
 * covers. Advances only when ALL of these hold (or force is set):
 *   1. papers_in_stage >= targetPapers
 *   2. covered goals >= minKnowledgeCoverage
 *   3. every requiredGoals entry is covered (e.g. Fundamentals requires
 *      template_dynamics + balance_stability + impedance_compliance — a
 *      stage whose papers reached the target but is missing a required goal
 *      stays put and shows the pending goal)
 * @returns the resulting stage state, whether it advanced, and any required
 *          goals still pending (the reason the stage did NOT graduate).
 */
export function recordPaperInStage(
  db: Db,
  topic: string,
  opts: {
    targetPapers?: number
    minCoverage?: number
    coveredGoals?: string[]
    forceAdvance?: boolean
    duplicate?: boolean
    /** goal ids that MUST be covered before this stage can graduate */
    requiredGoals?: string[]
  },
): { state: StageState; advanced: boolean; pendingRequired: string[] } {
  const target = opts.targetPapers ?? 3
  const minCoverage = opts.minCoverage ?? 1
  const required = opts.requiredGoals ?? []
  const state = ensureStage(db, topic, target)

  if (opts.forceAdvance) {
    db.prepare(
      'UPDATE stages SET current = current + 1, papers_in_stage = 0, covered_goals = \'[]\', updated_at = datetime(\'now\') WHERE topic = ?',
    ).run(topic)
    return { state: getStage(db, topic), advanced: true, pendingRequired: [] }
  }
  if (opts.duplicate) {
    // re-recommended paper: do not count toward stage progress
    return { state, advanced: false, pendingRequired: required.filter((g) => !state.coveredGoals.includes(g)) }
  }

  const union = new Set<string>(state.coveredGoals)
  for (const g of opts.coveredGoals ?? []) union.add(g)
  const unionList = [...union]
  const pendingRequired = required.filter((g) => !union.has(g))
  const next = state.papersInStage + 1
  if (next >= target && union.size >= minCoverage && pendingRequired.length === 0) {
    db.prepare(
      'UPDATE stages SET current = current + 1, papers_in_stage = 0, covered_goals = \'[]\', updated_at = datetime(\'now\') WHERE topic = ?',
    ).run(topic)
    return { state: getStage(db, topic), advanced: true, pendingRequired: [] }
  }
  // papers counter caps at target: a stage that reached 3/3 but still has a
  // pending required goal stays at 3/3 (never 4/3) until the goal is covered
  const capped = Math.min(next, target)
  db.prepare(
    'UPDATE stages SET papers_in_stage = ?, covered_goals = ?, updated_at = datetime(\'now\') WHERE topic = ?',
  ).run(capped, JSON.stringify(unionList), topic)
  return { state: { ...state, papersInStage: capped, coveredGoals: unionList }, advanced: false, pendingRequired }
}

/** Human-readable stage label from the configured order. */
export function stageLabel(stageOrder: Array<{ label: string }>, index: number): string {
  if (index < 1) return stageOrder[0]?.label ?? `stage-${index}`
  return stageOrder[index - 1]?.label ?? `stage-${index}`
}

/** The current stage definition, or undefined when the index is out of range. */
export function stageDef<T extends { label: string }>(stageOrder: T[], index: number): T | undefined {
  if (index < 1) return stageOrder[0]
  return stageOrder[index - 1]
}
