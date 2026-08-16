/**
 * Query Planner tests:
 * 1. Chinese topic → all generated queries are English (no CJK), canonical
 *    queries present, stage search terms expanded, later-stage keywords do
 *    not leak into earlier stages.
 * 2. Negative terms drop off-topic (Chinese-irrelevant) candidates.
 * 3. Landmark eligibility: high citation alone is NOT enough; stage
 *    relevance + venue + impact decide; recent pool is not crowded out.
 * 4. Query merge: same paper found by multiple sources/queries via
 *    DOI/arXiv/title is correctly deduplicated with full provenance.
 */
import { describe, expect, it } from 'vitest'
import { defaultConfig, type LiteratureConfig, type TopicDef } from '../src/config.js'
import {
  applyNegativeFilter,
  firstUncoveredGoal,
  landmarkEligibility,
  matchSeed,
  planQueries,
  resolveTopic,
} from '../src/lib/planner.js'
import { venueBonus } from '../src/lib/ranking.js'
import { curriculumHint, knowledgeGapHint, landmarkConfidence, preRank, stageRelevanceHint } from '../src/lib/ranking.js'
import { SourceRegistry } from '../src/sources/registry.js'
import type { PaperRef, SearchHit, SearchParams, SourceAdapter } from '../src/sources/types.js'

const CJK = /[\u4e00-\u9fff]/

describe('topic normalization (Chinese input → English queries)', () => {
  it('generates only English queries for the default Chinese topic', () => {
    const cfg = defaultConfig()
    const topic = resolveTopic(cfg.topics, '足式机器人控制')
    expect(topic.id).toBe('legged_robot_control')
    const stage = cfg.stageOrder[0]! // 基础控制
    const recent = planQueries(topic, stage, 'recent')
    const landmark = planQueries(topic, stage, 'landmark')
    const all = [...recent, ...landmark]
    expect(all.length).toBeGreaterThan(0)
    for (const q of all) {
      expect(q.language).toBe('en')
      expect(CJK.test(q.text)).toBe(false)
    }
    // canonical queries always present
    for (const cq of topic.canonicalQueries) {
      expect(all.some((q) => q.text === cq.toLowerCase())).toBe(true)
    }
    // stage search terms expanded
    for (const sq of stage.searchQueries) {
      expect(all.some((q) => q.text === sq.toLowerCase())).toBe(true)
    }
  })

  it('secondary queries only in the recent pool; later-stage keywords do not leak', () => {
    const cfg = defaultConfig()
    const topic = cfg.topics[0]!
    const fundamentals = cfg.stageOrder[0]! // 基础控制
    const mpc = cfg.stageOrder[2]! // MPC
    const fRecent = planQueries(topic, fundamentals, 'recent')
    expect(fRecent.some((q) => q.text === 'dynamic legged locomotion')).toBe(true)
    // no MPC-stage terms in the Fundamentals plan
    const fTexts = new Set(fRecent.map((q) => q.text))
    for (const t of mpc.searchQueries) {
      expect(fTexts.has(t.toLowerCase())).toBe(false)
    }
    // landmark pool has no secondary queries (bounded cost)
    const fLandmark = planQueries(topic, fundamentals, 'landmark')
    expect(fLandmark.some((q) => q.kind === 'secondary')).toBe(false)
  })
})

describe('negative terms', () => {
  it('drops off-topic Chinese-irrelevant candidates', () => {
    const cfg = defaultConfig()
    const terms = cfg.topics[0]!.negativeTerms
    const { kept, dropped } = applyNegativeFilter(
      [
        { title: 'Learning quadruped locomotion in the wild', abstract: 'RL policy for rough terrain' },
        { title: '滑坡智能防灾减灾中的应用与发展趋势', abstract: '机器学习 landslide prediction' },
        { title: '配电网带电机器人臂架伺服控制系统设计', abstract: 'power grid robot arm servo' },
        { title: 'Bipedal walking with virtual model control', abstract: 'ZMP gait pattern generation' },
      ],
      terms,
    )
    expect(dropped).toBe(2)
    expect(kept.map((k) => k.title)).toEqual([
      'Learning quadruped locomotion in the wild',
      'Bipedal walking with virtual model control',
    ])
  })
})

describe('landmark eligibility', () => {
  it('high citation alone is not enough; stage relevance is required', () => {
    const cfg = defaultConfig()
    const stage = cfg.stageOrder[0]!
    // irrelevant but highly cited
    const irrelevantHint = stageRelevanceHint('A survey of memristor devices for neuromorphic computing', stage)
    const irrelevant = landmarkEligibility(
      {
        citations: 5000,
        venue: 'Nature',
        stageHint: irrelevantHint.score,
        stageMatched: irrelevantHint.matchedPreferred.length,
      },
      cfg,
    )
    expect(irrelevant.eligible).toBe(false)
    // relevant fundamentals classic, moderate citations, top venue
    const classicHint = stageRelevanceHint(
      'Virtual model control of a bipedal walking robot with inverted pendulum and ZMP gait patterns',
      stage,
    )
    const classic = landmarkEligibility(
      {
        citations: 800,
        venue: 'The International Journal of Robotics Research',
        stageHint: classicHint.score,
        stageMatched: classicHint.matchedPreferred.length,
      },
      cfg,
    )
    expect(classic.eligible).toBe(true)
    expect(classic.score).toBeGreaterThan(0)
  })

  it('venue bonus recognizes top robotics venues', () => {
    expect(venueBonus('Science Robotics')).toBe(1)
    expect(venueBonus('IEEE Transactions on Robotics')).toBe(1)
    expect(venueBonus('Some Unknown Journal')).toBe(0)
  })
})

describe('query merge + pools', () => {
  /** Stub adapter serving fixed hits; records queries it received. */
  function stubAdapter(
    name: string,
    mkHit: (q: string, pool: 'recent' | 'landmark') => PaperRef | null,
  ): SourceAdapter & { seen: string[] } {
    const seen: string[] = []
    return {
      name,
      seen,
      async search(params: SearchParams): Promise<SearchHit[]> {
        const hits: SearchHit[] = []
        for (const q of params.queries) {
          seen.push(`${name}:${q.pool}:${q.text}`)
          const p = mkHit(q.text, params.pool)
          if (p) hits.push({ paper: p, query: q.text, retrievalScore: 0.9 })
        }
        return hits
      },
      async expand() {
        return null
      },
      async pdfCandidates() {
        return []
      },
    }
  }

  it('dedups the same paper across sources/queries by DOI and arXiv id', async () => {
    const cfg = defaultConfig()
    const registry = new SourceRegistry()
    // arxiv finds it by arxiv id; openalex by doi — same paper
    registry.register(
      stubAdapter('arxiv', () => ({
        id: 'arxiv:2312.00123',
        title: 'Learning Robust Quadruped Locomotion',
        authors: ['A'],
        arxivId: '2312.00123',
        year: 2023,
        metadataSource: 'arxiv',
      })),
    )
    registry.register(
      stubAdapter('openalex', () => ({
        id: 'doi:10.1126/scirobotics.abc1234',
        title: 'Learning Robust Quadruped Locomotion',
        authors: ['A'],
        doi: '10.1126/scirobotics.abc1234',
        year: 2023,
        metadataSource: 'openalex',
      })),
    )
    const topic = cfg.topics[0]!
    const stage = cfg.stageOrder[0]!
    const recent = await registry.searchPool(cfg, planQueries(topic, stage, 'recent'), stage, 'recent')
    expect(recent.papers.length).toBe(1)
    expect(recent.rawCount).toBe(24) // 12 queries x 2 adapters
    // provenance keeps both source trails (per query x source)
    expect(recent.provenance.length).toBe(24)
    expect(new Set(recent.provenance.map((p) => p.source))).toEqual(new Set(['arxiv', 'openalex']))
  })

  it('recent pool is not crowded out by landmark hits', async () => {
    const cfg = defaultConfig()
    const registry = new SourceRegistry()
    let n = 0
    const mkHit = (q: string, pool: 'recent' | 'landmark'): PaperRef | null => {
      const landmark = q === 'legged robot dynamics' || q === 'inverted pendulum walking control'
      if (landmark && pool === 'recent') return null
      n += 1
      const year = landmark ? 2001 : 2024
      return {
        id: `arxiv:${landmark ? '0109.0001' : `2401.0${String(n).padStart(3, '0')}`}`,
        title: landmark
          ? 'Virtual Model Control of a Bipedal Walking Robot'
          : `Legged Locomotion Control Paper ${n}`,
        authors: ['A'],
        arxivId: landmark ? '0109.0001' : `2401.0${String(n).padStart(3, '0')}`,
        year,
        citations: landmark ? 1500 : 30,
        venue: landmark ? 'The International Journal of Robotics Research' : 'IEEE RA-L',
        abstract: landmark
          ? 'virtual model control with spring dampers and inverted pendulum gait for dynamic walking'
          : 'quadruped locomotion control with dynamics and balance',
        metadataSource: 'arxiv',
      } satisfies PaperRef
    }
    registry.register(stubAdapter('arxiv', (q, pool) => mkHit(q, pool)))
    const topic = cfg.topics[0]!
    const stage = cfg.stageOrder[0]!
    const recent = await registry.searchPool(cfg, planQueries(topic, stage, 'recent'), stage, 'recent')
    const landmark = await registry.searchPool(cfg, planQueries(topic, stage, 'landmark'), stage, 'landmark')
    // landmark pool admits the classic only (eligibility) and is capped
    expect(landmark.papers.some((p) => p.year === 2001)).toBe(true)
    expect(landmark.papers.length).toBeLessThanOrEqual(cfg.retrieval.landmarkMaxCandidates)
    // recent pool keeps recent papers, classic stays out of it
    expect(recent.papers.length).toBeGreaterThan(0)
    expect(recent.papers.every((p) => p.year !== 2001)).toBe(true)
  })
})
describe('fundamentals stage ranking', () => {
  it('deterministic pre-rank favors stage-matched fundamentals papers in Top 10', () => {
    const cfg = defaultConfig()
    const stage = cfg.stageOrder[0]! // 基础控制
    const now = 2026
    const mk = (
      title: string,
      year: number,
      citations: number,
      pool: 'recent' | 'landmark',
    ): { title: string; year: number; citations: number; fulltextAvailable: boolean; stageRelevance: number } => {
      const sr = stageRelevanceHint(title, stage)
      return {
        title,
        year,
        citations,
        fulltextAvailable: true,
        stageRelevance: sr.score,
      }
    }
    const fundamentals = [
      ['Bipedal walking pattern generation with inverted pendulum and ZMP preview control', 2018, 900, 'recent'],
      ['Virtual model control of a bipedal walking robot with spring dampers', 2001, 1500, 'landmark'],
      ['Whole body control with contact force distribution for legged robots', 2020, 700, 'recent'],
      ['Legged robot dynamics and impedance control for dynamic walking', 2019, 500, 'recent'],
      ['SLIP template model for running and hopping control', 2015, 400, 'landmark'],
      ['Ground reaction force planning for stable bipedal locomotion', 2021, 300, 'recent'],
      ['Zero moment point trajectory generation for biped robots', 2017, 600, 'landmark'],
      ['Foot placement and gait transition control of quadruped robots', 2022, 350, 'recent'],
      ['Passive dynamic walking with spring-loaded inverted pendulum', 2012, 800, 'landmark'],
      ['Contact wrench cone based walking control of humanoid robots', 2019, 450, 'recent'],
      ['Dynamic balance control using a template model of the human body', 2016, 300, 'landmark'],
      ['Joint torque and stiffness control for bipedal locomotion', 2020, 260, 'recent'],
    ]
    const offStage = [
      ['Reinforcement learning with parkour perception for quadruped robots in the wild', 2024, 1200, 'recent'],
      ['Vision language model for terrain perception and MPC planning', 2025, 800, 'recent'],
      ['Diffusion policy for manipulation and grasping tasks', 2024, 600, 'recent'],
      ['Sim to real transfer with domain randomization for neural policies', 2023, 500, 'recent'],
      ['Neural network trajectory prediction for autonomous driving', 2024, 400, 'recent'],
      ['Federated learning for edge computing optimization', 2023, 300, 'recent'],
      ['Large language model agents for code generation', 2025, 900, 'recent'],
      ['Graph neural networks for molecular property prediction', 2024, 700, 'recent'],
    ]
    const rows = [...fundamentals, ...offStage]
      .map(([title, year, citations, pool]) => {
        const r = mk(title, year, citations, pool as 'recent' | 'landmark')
        const pre = preRank(r, cfg, { topicText: cfg.topics[0]!.canonicalQueries.join(' '), currentYear: now }, pool as 'recent' | 'landmark')
        return { r, pre }
      })
      // mirror the pipeline's off-topic floor (minTopicSimilarity)
      .filter((x) => x.pre.topicSimilarity >= cfg.retrieval.minTopicSimilarity)
      .sort((a, b) => b.pre.score - a.pre.score)
    const top10 = rows.slice(0, 10)
    const fundamentalsTitles = new Set(fundamentals.map((f) => f[0]))
    // every deterministic Top-10 entry must be a fundamentals-stage paper
    // (off-stage RL/VLM/diffusion papers are pushed out by the stage-relevance
    // penalty and the topic-similarity floor)
    for (const t of top10) {
      expect(fundamentalsTitles.has(t.r.title)).toBe(true)
    }
  })
})

describe('curriculum / landmark / knowledge-gap (V0.3)', () => {
  it('curriculum hint penalizes application case studies and rewards centrality', () => {
    const core = curriculumHint(
      'A general template model for legged locomotion control with inverted pendulum and ZMP walking pattern generation',
      'The International Journal of Robotics Research',
    )
    expect(core.score).toBeGreaterThan(0.6)
    const caseStudy = curriculumHint(
      'Design of a case study prototype platform for a specific warehouse robot application',
      'Some Local Journal',
    )
    expect(caseStudy.score).toBeLessThan(core.score)
    expect(caseStudy.score).toBeLessThan(0.5)
  })

  it('landmark confidence is 1.0 for curated seeds and lower otherwise', () => {
    expect(
      landmarkConfidence({ eligibilityScore: 0.4, stageHint: 0.5, impact: 0.8, venue: 0, seedMatch: true }),
    ).toBe(1)
    const noSeed = landmarkConfidence({ eligibilityScore: 0.4, stageHint: 0.5, impact: 0.8, venue: 0, seedMatch: false })
    expect(noSeed).toBeGreaterThan(0)
    expect(noSeed).toBeLessThan(1)
  })

  it('knowledge gap hint matches only uncovered goals', () => {
    const goals = [
      { id: 'a', label: 'template dynamics', keywords: ['inverted pendulum', 'template model'] },
      { id: 'b', label: 'contact force', keywords: ['contact force', 'ground reaction'] },
    ]
    const r = knowledgeGapHint('Inverted pendulum balance with ground reaction force control', goals)
    expect(r.matched).toEqual(['a', 'b'])
    expect(r.score).toBe(2)
    const r2 = knowledgeGapHint('Neural network policy for parkour', goals)
    expect(r2.matched).toEqual([])
  })
})

describe('priority goal + curated seeds (V0.3)', () => {
  it('priority goal is the first uncovered goal in stage order', () => {
    const cfg = defaultConfig()
    const stage = cfg.stageOrder[0]! // 基础控制
    const pg = firstUncoveredGoal(stage, new Set())
    expect(pg?.id).toBe('template_dynamics')
    // after covering template_dynamics, the next priority is balance_stability
    const pg2 = firstUncoveredGoal(stage, new Set(['template_dynamics']))
    expect(pg2?.id).toBe('balance_stability')
  })

  it('landmark pool plans seed-title anchor queries', () => {
    const cfg = defaultConfig()
    const topic = cfg.topics[0]!
    const stage = cfg.stageOrder[0]!
    const landmark = planQueries(topic, stage, 'landmark')
    for (const seed of stage.landmarkSeeds) {
      expect(landmark.some((q) => q.text === seed.title.toLowerCase())).toBe(true)
    }
    // recent pool does NOT carry seed queries
    const recent = planQueries(topic, stage, 'recent')
    for (const seed of stage.landmarkSeeds) {
      expect(recent.some((q) => q.text === seed.title.toLowerCase())).toBe(false)
    }
  })

  it('matches seeds by DOI and title', () => {
    const cfg = defaultConfig()
    const stage = cfg.stageOrder[0]!
    expect(
      matchSeed({ doi: '10.1177/02783640122067309', title: 'Virtual Model Control: An Intuitive Approach for Bipedal Locomotion' }, stage.landmarkSeeds),
    ).toBe(true)
    expect(
      matchSeed({ doi: '10.1177/02783640122067309' }, stage.landmarkSeeds),
    ).toBe(true)
    expect(
      matchSeed({ title: 'Instantaneous Capture Input for Balancing the Variable Height Inverted Pendulum' }, stage.landmarkSeeds),
    ).toBe(true)
    expect(matchSeed({ title: 'Some unrelated paper' }, stage.landmarkSeeds)).toBe(false)
  })
})
