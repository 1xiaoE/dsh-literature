import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig, currentYear } from '../src/config.js'
import { agentFinalScore, curriculumHint, impactScore, knowledgeGapHint, landmarkConfidence, preRank, recencyScore, stageRelevanceHint, topicSimilarity } from '../src/lib/ranking.js'
import { recordPaperInStage, ensureStage, getStage } from '../src/lib/stages.js'
import { openDb, type Db } from '../src/db.js'
import { startPush, getPush } from '../src/lib/history.js'

describe('ranking', () => {
  it('recency decays with age', () => {
    const now = currentYear()
    expect(recencyScore(now, now, 5)).toBe(1)
    expect(recencyScore(now - 5, now, 5)).toBe(0)
    expect(recencyScore(now - 2, now, 5)).toBeCloseTo(0.6)
  })

  it('impact is log-scaled and saturated', () => {
    expect(impactScore(undefined)).toBe(0)
    expect(impactScore(0)).toBe(0)
    expect(impactScore(1000)).toBe(1)
    expect(impactScore(100)).toBeCloseTo(Math.log10(101) / 3)
  })

  it('topic similarity responds to overlap', () => {
    expect(topicSimilarity('legged robot', 'Legged Robot Control')).toBeGreaterThan(0)
    expect(topicSimilarity('legged robot', 'totally unrelated astronomy')).toBe(0)
  })

  it('pre-rank is deterministic and weight-configurable', () => {
    const cfg = defaultConfig()
    const now = currentYear()
    const good = preRank(
      { title: 'Legged Robot Control via MPC', year: now, citations: 500, fulltextAvailable: true },
      cfg,
      now,
    )
    const bad = preRank(
      { title: 'Legged Robot Control via MPC', year: now - 9, citations: 0, fulltextAvailable: false },
      cfg,
      now,
    )
    expect(good.score).toBeGreaterThan(bad.score)

    const zeroWeights = {
      ...cfg,
      ranking: { recency: 0, impact: 0, topicSimilarity: 0, fulltextAvailability: 0, stageRelevance: 0, knowledgeGap: 0 },
    }
    const zero = preRank(
      { title: 'Legged Robot Control via MPC', year: now, citations: 500, fulltextAvailable: true },
      zeroWeights,
      now,
    )
    expect(zero.score).toBe(0)
  })

  it('agent final score is weighted', () => {
    const cfg = defaultConfig()
    const s = agentFinalScore(
      {
        relevance: 0.8,
        learningValue: 0.6,
        representativeness: 0.4,
        novelty: 0.2,
        stageRelevance: 0.9,
        curriculumValue: 0.7,
      },
      cfg,
    )
    const w = cfg.agentRanking
    expect(s).toBeCloseTo(
      w.relevance * 0.8 + w.learningValue * 0.6 + w.representativeness * 0.4 + w.novelty * 0.2 + w.stageRelevance * 0.9 + w.curriculumValue * 0.7,
    )
  })

  it('stage relevance hint reacts to preferred/downweight keywords', () => {
    const cfg = defaultConfig()
    const stage = cfg.stageOrder[0]! // 基础控制
    const good = stageRelevanceHint('Bipedal walking pattern generation with inverted pendulum and ZMP', stage)
    expect(good.score).toBeGreaterThan(0.5)
    expect(good.matchedPreferred.length).toBeGreaterThan(0)

    const mixed = stageRelevanceHint(
      'Reinforcement learning with model predictive control for parkour locomotion',
      stage,
    )
    expect(mixed.score).toBeLessThan(good.score)
    expect(mixed.matchedDownweight.length).toBeGreaterThan(0)
  })
})

describe('stages', () => {
  function tempDb(): { db: Db; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-stage-'))
    return { db: openDb(dir), dir }
  }

  it('advances only when target reached', () => {
    const { db, dir } = tempDb()
    ensureStage(db, '足式机器人控制', 2)
    const r1 = recordPaperInStage(db, '足式机器人控制', { targetPapers: 2, minCoverage: 1, coveredGoals: ['g1'] })
    expect(r1.advanced).toBe(false)
    expect(getStage(db, '足式机器人控制').papersInStage).toBe(1)
    const r2 = recordPaperInStage(db, '足式机器人控制', { targetPapers: 2, minCoverage: 1, coveredGoals: ['g2'] })
    expect(r2.advanced).toBe(true)
    expect(getStage(db, '足式机器人控制').current).toBe(2)
    expect(getStage(db, '足式机器人控制').papersInStage).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('force advance skips the gate', () => {
    const { db, dir } = tempDb()
    ensureStage(db, 't', 5)
    const r = recordPaperInStage(db, 't', { targetPapers: 5, minCoverage: 3, forceAdvance: true })
    expect(r.advanced).toBe(true)
    expect(getStage(db, 't').current).toBe(2)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('duplicate picks do not count toward progress', () => {
    const { db, dir } = tempDb()
    ensureStage(db, 't', 2)
    const r = recordPaperInStage(db, 't', { targetPapers: 2, minCoverage: 1, duplicate: true })
    expect(r.advanced).toBe(false)
    expect(getStage(db, 't').papersInStage).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not advance without minimum knowledge coverage', () => {
    const { db, dir } = tempDb()
    ensureStage(db, 't', 2)
    // two papers but zero goals covered — coverage gate blocks advancement
    recordPaperInStage(db, 't', { targetPapers: 2, minCoverage: 2, coveredGoals: [] })
    const r2 = recordPaperInStage(db, 't', { targetPapers: 2, minCoverage: 2, coveredGoals: [] })
    expect(r2.advanced).toBe(false)
    expect(getStage(db, 't').current).toBe(1)
    // with coverage met, it advances
    const r3 = recordPaperInStage(db, 't', { targetPapers: 2, minCoverage: 2, coveredGoals: ['g1', 'g2'] })
    expect(r3.advanced).toBe(true)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('history.startPush supersede', () => {
  it('supersedes stale running pushes of the same topic', () => {
    const { db, dir } = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-push-'))
      return { db: openDb(dir), dir }
    })()
    const p1 = startPush(db, 't', 1)
    const p2 = startPush(db, 't', 1)
    expect(getPush(db, p1.pushId)?.status).toBe('failed')
    expect(getPush(db, p2.pushId)?.status).toBe('running')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
