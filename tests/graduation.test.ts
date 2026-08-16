/**
 * Fundamentals graduation rules (V0.1 final closeout):
 *
 * Test A — 3/3 papers but a required goal (impedance_compliance) uncovered:
 *          the stage must NOT advance to Stage 2 and must report the pending
 *          required goal.
 * Test B — papers >= target AND all requiredGoals covered: stage advances.
 * Test C — completion mode: an excellent-but-unrelated paper must NOT count
 *          toward the required goal (no graduation).
 * Test D — a genuine impedance/compliance paper (full-text-confirmed goal)
 *          covers the required goal and lets Fundamentals graduate.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig, normalizeConfig } from '../src/config.js'
import { createRuntime, type LiteratureRuntime } from '../src/lib/runtime.js'
import { upsertPaper } from '../src/db.js'
import { ensureStage, getStage, recordPaperInStage } from '../src/lib/stages.js'
import { startPush } from '../src/lib/history.js'
import { decidePriorityGoal } from '../src/lib/planner.js'
import { defineLiteratureRecord } from '../src/tools/literature_record.js'

const FUNDAMENTALS_REQUIRED = ['template_dynamics', 'balance_stability', 'impedance_compliance']
const FUNDAMENTALS = defaultConfig().stageOrder[0]!
const COVERED_3 = new Set(['template_dynamics', 'balance_stability', 'gait_representation'])
const COVERED_4 = new Set(['template_dynamics', 'balance_stability', 'gait_representation', 'kinematics_jacobian'])

function setup(): { rt: LiteratureRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-grad-'))
  const rt = createRuntime(normalizeConfig({ dataDir: dir }))
  return { rt, dir }
}

async function run<T>(tool: { execute: (a: never, e: never) => Promise<T> }, args: unknown): Promise<T> {
  return tool.execute(args as never, { signal: new AbortController().signal } as never)
}

function seedPaper(rt: LiteratureRuntime, id: string): void {
  upsertPaper(rt.db, {
    id,
    title: 'Graduation Test Paper',
    authors: '["T"]',
    venue: null,
    year: 2024,
    doi: null,
    arxiv_id: id.replace('arxiv:', ''),
    openalex_id: null,
    url: null,
    oa_pdf_url: null,
    abstract: null,
    citations: 10,
    bibtex: null,
    metadata_source: 'arxiv',
  })
}

/* ---------------- Test A ---------------- */

describe('Test A: 3/3 papers with a pending required goal → NO advance', () => {
  it('stays in Fundamentals at 3/3 and reports pending impedance_compliance', () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    rt.db
      .prepare(
        "UPDATE stages SET papers_in_stage = 2, covered_goals = '[\"template_dynamics\",\"balance_stability\",\"gait_representation\"]' WHERE topic = 'legged_robot_control'",
      )
      .run()
    const res = recordPaperInStage(rt.db, 'legged_robot_control', {
      targetPapers: 3,
      minCoverage: 3,
      coveredGoals: ['kinematics_jacobian'], // reaches 3/3 but NOT impedance_compliance
      requiredGoals: FUNDAMENTALS_REQUIRED,
    })
    expect(res.advanced).toBe(false)
    expect(res.pendingRequired).toEqual(['impedance_compliance'])
    const stage = getStage(rt.db, 'legged_robot_control')
    expect(stage.current).toBe(1) // Fundamentals kept
    expect(stage.papersInStage).toBe(3) // capped at 3/3, never 4/3
    expect(stage.coveredGoals).toEqual(['template_dynamics', 'balance_stability', 'gait_representation', 'kinematics_jacobian'])
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- Test B ---------------- */

describe('Test B: papers >= target AND all required goals covered → advance', () => {
  it('graduates Fundamentals to Stage 2 when impedance_compliance gets covered', () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    rt.db
      .prepare(
        "UPDATE stages SET papers_in_stage = 2, covered_goals = '[\"template_dynamics\",\"balance_stability\",\"gait_representation\",\"kinematics_jacobian\"]' WHERE topic = 'legged_robot_control'",
      )
      .run()
    const res = recordPaperInStage(rt.db, 'legged_robot_control', {
      targetPapers: 3,
      minCoverage: 3,
      coveredGoals: ['impedance_compliance'],
      requiredGoals: FUNDAMENTALS_REQUIRED,
    })
    expect(res.advanced).toBe(true)
    expect(res.pendingRequired).toEqual([])
    expect(getStage(rt.db, 'legged_robot_control').current).toBe(2)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- completion mode ---------------- */

describe('required-goal completion mode', () => {
  it('kicks in at targetPapers-1 with an uncovered required goal and pins it', () => {
    // 1/3: normal mode, priority = first uncovered knowledge goal
    const normal = decidePriorityGoal(FUNDAMENTALS, COVERED_4, 1, 3)
    expect(normal.mode).toBe('normal')
    expect(normal.goal?.id).toBe('impedance_compliance') // the only uncovered goal
    // 2/3 (target-1): completion mode, pinned to the pending required goal
    const completion = decidePriorityGoal(FUNDAMENTALS, COVERED_4, 2, 3)
    expect(completion.mode).toBe('completion')
    expect(completion.goal?.id).toBe('impedance_compliance')
    expect(completion.pendingRequired).toEqual(['impedance_compliance'])
    // required goals fully covered → no completion mode even at target-1
    const done = decidePriorityGoal(FUNDAMENTALS, new Set([...COVERED_4, 'impedance_compliance']), 2, 3)
    expect(done.mode).toBe('normal')
    expect(done.pendingRequired).toEqual([])
  })

  it('normal mode stays a preference when no required goals exist (later stages)', () => {
    const stage2 = defaultConfig().stageOrder[1]! // 动力学/接触控制: requiredGoals []
    const d = decidePriorityGoal(stage2, new Set(), 2, 3)
    expect(d.mode).toBe('normal')
    expect(d.pendingRequired).toEqual([])
  })
})

/* ---------------- Test C + D (record-level, agent full-text judgment) ---------------- */

describe('Test C/D: agent full-text judgment decides required-goal coverage', () => {
  async function recordWithGoals(rt: LiteratureRuntime, pushId: number, paperId: string, goals: string[]) {
    seedPaper(rt, paperId)
    // picked stays 0 here — record sets it AFTER the duplicate check (real flow)
    rt.db
      .prepare(
        `INSERT INTO candidates (push_id, paper_id, rank_hint, picked, stage_relevance_score,
          curriculum_value, selection_outcome, agent_rank, preflight_attempt_order, candidate_pool, is_seen)
         VALUES (?, ?, 1, 0, 0.8, 0.7, 'SELECTED', 1, 1, 'recent', 0)`,
      )
      .run(pushId, paperId)
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    return run(recordTool, {
      pushId,
      status: 'completed',
      paperId,
      scores: [
        {
          paperId,
          relevance: 0.9,
          learningValue: 0.85,
          representativeness: 0.85,
          novelty: 0.6,
          stageRelevance: 0.8,
          curriculumValue: 0.7,
          rationale: 'graduation test',
        },
      ],
      selection: [{ paperId, agentRank: 1, attemptOrder: 1, outcome: 'SELECTED', reason: 'ok' }],
      knowledgeGoals: goals,
    })
  }

  it('Test C: excellent but impedance-unrelated paper → no graduation, pending reported', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    rt.db
      .prepare(
        "UPDATE stages SET papers_in_stage = 2, covered_goals = '[\"template_dynamics\",\"balance_stability\",\"gait_representation\",\"kinematics_jacobian\"]' WHERE topic = 'legged_robot_control'",
      )
      .run()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    // excellent paper (high scores) but agent's full-text judgment: covers only
    // template_dynamics — NOT impedance_compliance
    const rec = (await recordWithGoals(rt, pushId, 'arxiv:2401.999', ['template_dynamics'])) as {
      stageAdvanced: boolean
      pendingRequiredGoals: string[]
      papersInStage: number
    }
    expect(rec.stageAdvanced).toBe(false)
    expect(rec.pendingRequiredGoals).toEqual(['impedance_compliance'])
    const stage = getStage(rt.db, 'legged_robot_control')
    expect(stage.current).toBe(1)
    expect(stage.papersInStage).toBe(3) // capped at 3/3, Fundamentals NOT graduated
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('Test D: genuine impedance/compliance paper confirmed via full text → graduation', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    rt.db
      .prepare(
        "UPDATE stages SET papers_in_stage = 2, covered_goals = '[\"template_dynamics\",\"balance_stability\",\"gait_representation\",\"kinematics_jacobian\"]' WHERE topic = 'legged_robot_control'",
      )
      .run()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const rec = (await recordWithGoals(rt, pushId, 'arxiv:2401.998', ['impedance_compliance'])) as {
      stageAdvanced: boolean
      pendingRequiredGoals: string[]
    }
    expect(rec.stageAdvanced).toBe(true)
    expect(rec.pendingRequiredGoals).toEqual([])
    expect(getStage(rt.db, 'legged_robot_control').current).toBe(2)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
