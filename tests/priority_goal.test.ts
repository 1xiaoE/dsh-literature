/**
 * V0.1 correctness closeout — priority_goal_match + reading coverage.
 *
 * 1. priorityGoalMatchScore: gait_representation / impedance_compliance
 *    keyword-concept mapping (regression: gait-synthesis / step-to-step /
 *    spring-damper / virtual-model papers must match).
 * 2. preRank actually consumes the numeric priorityGoalMatch via
 *    ranking.priorityGoal weight.
 * 3. literature_sources WRITES priority_goal_match into SQLite (regression:
 *    the column existed but was never inserted → always DEFAULT 0).
 * 4. literature_record reading-coverage provenance: total_chunks /
 *    read_chunks / read_coverage / coverage_basis (index_exposed vs
 *    full_read) persisted on pushes.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig, normalizeConfig } from '../src/config.js'
import { createRuntime, type LiteratureRuntime } from '../src/lib/runtime.js'
import { openDb, upsertPaper } from '../src/db.js'
import { ensureStage, getStage } from '../src/lib/stages.js'
import { startPush } from '../src/lib/history.js'
import {
  preRank,
  priorityGoalMatchScore,
  type PreRankResult,
} from '../src/lib/ranking.js'
import { SourceRegistry } from '../src/sources/registry.js'
import type { PaperRef, PdfCandidate, SearchHit, SearchParams, SourceAdapter } from '../src/sources/types.js'
import { defineLiteratureSources } from '../src/tools/literature_sources.js'
import { defineLiteratureRecord } from '../src/tools/literature_record.js'

/* ---------------- helpers ---------------- */

const GAIT_GOAL = {
  id: 'gait_representation',
  label: 'gait representation / walking pattern',
  keywords: ['gait', 'walking pattern', 'gait generation', 'gait synthesis', 'gait pattern', 'gait cycle', 'foot placement', 'footstep', 'step planning', 'step-to-step', 'phase', 'gait transition'],
}
const IMPEDANCE_GOAL = {
  id: 'impedance_compliance',
  label: 'impedance / compliance',
  keywords: ['impedance', 'impedance control', 'compliance', 'compliance control', 'compliant', 'stiffness', 'stiffness control', 'damping', 'damper', 'spring', 'spring-damper', 'virtual spring', 'virtual model', 'force position compliance'],
}

function setup(): { rt: LiteratureRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-pg-'))
  const rt = createRuntime(normalizeConfig({ dataDir: dir }))
  return { rt, dir }
}

async function run<T>(tool: { execute: (a: never, e: never) => Promise<T> }, args: unknown): Promise<T> {
  return tool.execute(args as never, { signal: new AbortController().signal } as never)
}

/** Fake retrieval adapter: always returns the same paper for every query. */
class FakeAdapter implements SourceAdapter {
  readonly name = 'fake'
  constructor(private readonly paper: PaperRef) {}
  async search(_params: SearchParams): Promise<SearchHit[]> {
    return [{ paper: this.paper, query: 'fake query' }]
  }
  async expand(): Promise<Partial<PaperRef> | null> {
    return null
  }
  async pdfCandidates(): Promise<PdfCandidate[]> {
    return []
  }
}

function ref(title: string): PaperRef {
  return {
    id: `title:${title}`,
    title,
    authors: ['A'],
    year: 2024,
    citations: 100,
    venue: 'IEEE Transactions on Robotics',
    doi: `10.1000/${title.length}`,
    metadataSource: 'fake',
  }
}

function withFakeRegistry(rt: LiteratureRuntime, paper: PaperRef): void {
  const registry = new SourceRegistry()
  registry.register(new FakeAdapter(paper))
  rt.registry = registry
}

/** Insert a candidates row with the scores a completed record needs. */
function seedScoredCandidate(rt: LiteratureRuntime, pushId: number, paperId: string): void {
  rt.db
    .prepare(
      `INSERT INTO candidates (push_id, paper_id, rank_hint, picked, stage_relevance_score,
        curriculum_value, selection_outcome, selection_rejection_reason, agent_rank,
        preflight_attempt_order, candidate_pool, is_seen)
       VALUES (?, ?, 1, 1, 0.85, 0.8, 'SELECTED', 'priority goal paper', 1, 1, 'recent', 0)`,
    )
    .run(pushId, paperId)
}

/* ---------------- 1. keyword-concept mapping ---------------- */

describe('priorityGoalMatchScore (regression: concept mapping)', () => {
  it('gait_representation: gait/walking-pattern/gait-synthesis/step-to-step papers match > 0', () => {
    const cases = [
      'Gait Synthesis for Dynamic Bipedal Walking',
      'A New Walking Pattern Generator with Foot Placement Planning',
      'Step-to-Step Locomotion Planning on Rough Terrain',
      'Gait Generation and Footstep Adjustment for Quadruped Locomotion',
    ]
    for (const t of cases) {
      const r = priorityGoalMatchScore(t, GAIT_GOAL)
      expect(r.score, t).toBeGreaterThan(0)
    }
  })

  it('gait_representation: an unrelated paper does NOT match', () => {
    const r = priorityGoalMatchScore('Neural Network Image Classification with Transformers', GAIT_GOAL)
    expect(r.score).toBe(0)
  })

  it('impedance_compliance: core-concept papers get a STRONGLY elevated match', () => {
    const multi = priorityGoalMatchScore(
      'Impedance Control and Virtual Model Control with Spring-Damper Stiffness Regulation for Compliant Legged Locomotion',
      IMPEDANCE_GOAL,
    )
    expect(multi.score).toBeGreaterThanOrEqual(0.7) // clearly elevated

    const single = priorityGoalMatchScore('Stiffness Control for a Series Elastic Actuator', IMPEDANCE_GOAL)
    expect(single.score).toBeGreaterThan(0)
    expect(single.score).toBeLessThan(multi.score)
  })

  it('impedance_compliance: unrelated paper does NOT match', () => {
    const r = priorityGoalMatchScore('Visual Odometry with Deep Feature Matching', IMPEDANCE_GOAL)
    expect(r.score).toBe(0)
  })
})

/* ---------------- 2. preRank consumes the weight ---------------- */

describe('preRank consumes priorityGoalMatch numerically', () => {
  it('ranking.priorityGoal weight really changes the score', () => {
    const cfg = defaultConfig()
    const now = 2026
    const base = {
      title: 'Legged Robot Control',
      year: 2026,
      citations: 10,
      fulltextAvailable: false,
      stageRelevance: 0.5, // > 0 so no 0.6 stage-exclusion penalty distorts the delta
    }
    const ctx = { topicText: 'legged robot locomotion control', currentYear: now }
    const without = preRank({ ...base, priorityGoalMatch: 0 }, cfg, ctx)
    const withFull = preRank({ ...base, priorityGoalMatch: 1 }, cfg, ctx)
    const withHalf = preRank({ ...base, priorityGoalMatch: 0.5 }, cfg, ctx)
    expect(withFull.score - without.score).toBeCloseTo(cfg.ranking.priorityGoal, 6)
    expect(withHalf.score - without.score).toBeCloseTo(cfg.ranking.priorityGoal * 0.5, 6)
    expect(cfg.ranking.priorityGoal).toBeGreaterThan(0)
  })
})

/* ---------------- 3. literature_sources WRITES the column ---------------- */

describe('literature_sources persists priority_goal_match (regression: was never inserted)', () => {
  it('gait priority goal → gait paper stored with priority_goal_match > 0', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    // covered = template_dynamics + balance_stability → priority goal = gait_representation
    rt.db
      .prepare(
        "UPDATE stages SET covered_goals = '[\"template_dynamics\",\"balance_stability\"]' WHERE topic = 'legged_robot_control'",
      )
      .run()
    withFakeRegistry(rt, ref('Gait Synthesis and Step-to-Step Foot Placement for Legged Robot Locomotion'))
    const out = await run(defineLiteratureSources(() => rt), {})
    expect(out.priorityGoal?.id).toBe('gait_representation')
    const rows = rt.db.prepare('SELECT paper_id, priority_goal_match FROM candidates').all() as Array<{
      paper_id: string
      priority_goal_match: number
    }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.priority_goal_match).toBeGreaterThan(0)
    expect(out.candidates[0]!.priorityGoalMatch).toBeGreaterThan(0)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('impedance priority goal → impedance paper stored with clearly elevated match', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    // covered = everything except impedance_compliance → priority goal = impedance_compliance
    rt.db
      .prepare(
        "UPDATE stages SET covered_goals = '[\"template_dynamics\",\"balance_stability\",\"gait_representation\",\"kinematics_jacobian\"]' WHERE topic = 'legged_robot_control'",
      )
      .run()
    withFakeRegistry(
      rt,
      ref('Impedance Control and Virtual Model Control with Spring-Damper Compliance for Legged Robot Locomotion'),
    )
    const out = await run(defineLiteratureSources(() => rt), {})
    expect(out.priorityGoal?.id).toBe('impedance_compliance')
    const rows = rt.db.prepare('SELECT paper_id, priority_goal_match FROM candidates').all() as Array<{
      paper_id: string
      priority_goal_match: number
    }>
    expect(rows[0]!.priority_goal_match).toBeGreaterThanOrEqual(0.7)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('unrelated paper under impedance priority goal → 0', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    rt.db
      .prepare(
        "UPDATE stages SET covered_goals = '[\"template_dynamics\",\"balance_stability\",\"gait_representation\",\"kinematics_jacobian\"]' WHERE topic = 'legged_robot_control'",
      )
      .run()
    withFakeRegistry(rt, ref('A Survey of Vision-based Terrain Mapping for Legged Robot Locomotion'))
    await run(defineLiteratureSources(() => rt), {})
    const rows = rt.db.prepare('SELECT priority_goal_match FROM candidates').all() as Array<{
      priority_goal_match: number
    }>
    expect(rows[0]!.priority_goal_match).toBe(0)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- 4. reading-coverage provenance ---------------- */

describe('literature_record reading-coverage provenance', () => {
  const TOPIC = 'legged_robot_control'
  const PAPER = 'arxiv:2208.01786'

  async function recordCompleted(rt: LiteratureRuntime, pushId: number, reads: number[]): Promise<unknown> {
    upsertPaper(rt.db, {
      id: PAPER,
      title: 'Resolved Motion Control for 3D Underactuated Bipedal Walking',
      authors: '["Paredes","Hereid"]',
      venue: null,
      year: 2022,
      doi: null,
      arxiv_id: '2208.01786',
      openalex_id: null,
      url: null,
      oa_pdf_url: null,
      abstract: null,
      citations: 20,
      bibtex: null,
      metadata_source: 'arxiv',
    })
    seedScoredCandidate(rt, pushId, PAPER)
    rt.db
      .prepare(
        `INSERT INTO fulltexts (paper_id, status, parser, char_count, chunk_count)
         VALUES (?, 'ok', 'pdftotext', 50000, 10)`,
      )
      .run(PAPER)
    for (const seq of reads) {
      rt.db
        .prepare(
          `INSERT INTO fulltext_reads (push_id, paper_id, seq) VALUES (?, ?, ?)`,
        )
        .run(pushId, PAPER, seq)
    }
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    return run(recordTool, {
      pushId,
      status: 'completed',
      paperId: PAPER,
      scores: [
        {
          paperId: PAPER,
          relevance: 0.9,
          learningValue: 0.8,
          representativeness: 0.8,
          novelty: 0.6,
          stageRelevance: 0.85,
          curriculumValue: 0.8,
          rationale: 'coverage test',
        },
      ],
      selection: [{ paperId: PAPER, agentRank: 1, attemptOrder: 1, outcome: 'SELECTED', reason: 'ok' }],
      knowledgeGoals: ['impedance_compliance'],
    })
  }

  it('9/10 read → readCoverage 0.9 with coverage_basis=index_exposed (chunk 0 preview exposed by index)', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, TOPIC, 3)
    const pushId = startPush(rt.db, TOPIC, 1).pushId
    const rec = (await recordCompleted(rt, pushId, [1, 2, 3, 4, 5, 6, 7, 8, 9])) as {
      totalChunks: number
      readChunks: number
      readCoverage: number
      coverageBasis: string
    }
    expect(rec.totalChunks).toBe(10)
    expect(rec.readChunks).toBe(9)
    expect(rec.readCoverage).toBe(0.9)
    expect(rec.coverageBasis).toBe('index_exposed')
    const push = rt.db.prepare('SELECT total_chunks, read_chunks, read_coverage, coverage_basis FROM pushes WHERE id = ?').get(pushId) as {
      total_chunks: number
      read_chunks: number
      read_coverage: number
      coverage_basis: string
    }
    expect(push.total_chunks).toBe(10)
    expect(push.read_chunks).toBe(9)
    expect(push.read_coverage).toBeCloseTo(0.9)
    expect(push.coverage_basis).toBe('index_exposed')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('10/10 read → full_read basis', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, TOPIC, 3)
    const pushId = startPush(rt.db, TOPIC, 1).pushId
    const rec = (await recordCompleted(rt, pushId, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])) as {
      readCoverage: number
      coverageBasis: string
    }
    expect(rec.readCoverage).toBe(1)
    expect(rec.coverageBasis).toBe('full_read')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('no index → read_log basis with zeros', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, TOPIC, 3)
    const pushId = startPush(rt.db, TOPIC, 1).pushId
    upsertPaper(rt.db, {
      id: 'arxiv:9999.00001',
      title: 'No Fulltext Paper',
      authors: '[]',
      venue: null,
      year: 2024,
      doi: null,
      arxiv_id: '9999.00001',
      openalex_id: null,
      url: null,
      oa_pdf_url: null,
      abstract: null,
      citations: 0,
      bibtex: null,
      metadata_source: 'arxiv',
    })
    // fulltext_unavailable record: no index, no reads
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    const rec = (await run(recordTool, {
      pushId,
      status: 'fulltext_unavailable',
      selection: [{ paperId: 'arxiv:9999.00001', agentRank: 1, attemptOrder: 1, outcome: 'FULLTEXT_UNAVAILABLE' }],
    })) as { totalChunks: number; readChunks: number; readCoverage: number; coverageBasis: string }
    expect(rec.totalChunks).toBe(0)
    expect(rec.coverageBasis).toBe('read_log')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- schema sanity ---------------- */

describe('v9 schema', () => {
  it('priority_goal_match accepts REAL strength values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-v9-'))
    const db = openDb(dir)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(12)
    const pushId = startPush(db, 't', 1).pushId
    db.prepare(
      `INSERT INTO papers (id, title, authors, metadata_source)
       VALUES ('x', 'X Paper', '[]', 'fake')`,
    ).run()
    db.prepare(
      `INSERT INTO candidates (push_id, paper_id, priority_goal_match, candidate_pool)
       VALUES (?, 'x', 0.7, 'recent')`,
    ).run(pushId)
    const got = db.prepare('SELECT priority_goal_match FROM candidates').get() as { priority_goal_match: number }
    expect(got.priority_goal_match).toBeCloseTo(0.7)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
