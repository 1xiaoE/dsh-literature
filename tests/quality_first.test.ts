/** Hard-state-machine regressions for Quality First, Access Second. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.js'
import { openDb, upsertPaper } from '../src/db.js'
import { startPush } from '../src/lib/history.js'
import {
  allocateAttemptOrder,
  ensureAcquisitionTurn,
  markAcquisitionOutcome,
  markPublicPreflight,
  nextAcquisitionCandidate,
  persistSemanticScores,
} from '../src/lib/selection.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-quality-first-'))
  const db = openDb(dir)
  const cfg = normalizeConfig({ dataDir: dir })
  const pushId = startPush(db, 'legged_robot_control', 1).pushId
  for (const [i, id] of ['p1', 'p2'].entries()) {
    upsertPaper(db, {
      id,
      title: `Paper ${i + 1}`,
      authors: '[]', venue: null, year: 2024, doi: null, arxiv_id: null,
      openalex_id: null, url: null, oa_pdf_url: null, abstract: null, citations: 0,
      bibtex: null, metadata_source: 'test',
    })
    db.prepare('INSERT INTO candidates (push_id, paper_id, rank_hint, picked, is_seen) VALUES (?, ?, ?, 0, 0)')
      .run(pushId, id, i + 1)
  }
  return { dir, db, cfg, pushId }
}

const score = (paperId: string, relevance: number, stageRelevance = 0.9, curriculumValue = 0.9) => ({
  paperId,
  relevance,
  learningValue: relevance,
  representativeness: relevance,
  novelty: 0.5,
  stageRelevance,
  curriculumValue,
  rationale: 'quality-first regression',
})

describe('Quality First hard acquisition order', () => {
  it('public failure on Rank1 still blocks Rank2 until Rank1 gets a paper-level terminal outcome', () => {
    const { dir, db, cfg, pushId } = setup()
    persistSemanticScores(db, pushId, [score('p1', 0.95), score('p2', 0.80)], cfg)

    const first = ensureAcquisitionTurn(db, pushId, 'p1', cfg)
    expect(first.agentRank).toBe(1)
    expect(allocateAttemptOrder(db, pushId, 'p1')).toBe(1)
    markPublicPreflight(db, pushId, 'p1', false)

    // This is the bug the old workflow allowed: lower-ranked OA must NOT leapfrog.
    expect(() => ensureAcquisitionTurn(db, pushId, 'p2', cfg)).toThrow(/当前必须处理 agentRank #1/)

    // AUTH_REQUIRED and RATE_LIMITED are parking outcomes, not skip outcomes.
    markAcquisitionOutcome(db, pushId, 'p1', 'AUTH_REQUIRED', 'login wall')
    expect(nextAcquisitionCandidate(db, pushId, cfg).candidate?.paperId).toBe('p1')
    markAcquisitionOutcome(db, pushId, 'p1', 'RATE_LIMITED', 'retry later')
    expect(nextAcquisitionCandidate(db, pushId, cfg).candidate?.paperId).toBe('p1')

    // Only an explicit paper-level terminal result advances to Rank2.
    markAcquisitionOutcome(db, pushId, 'p1', 'ACCESS_DENIED', 'subscription unavailable')
    const second = ensureAcquisitionTurn(db, pushId, 'p2', cfg)
    expect(second.agentRank).toBe(2)
    expect(allocateAttemptOrder(db, pushId, 'p2')).toBe(2)
    db.close(); rmSync(dir, { recursive: true, force: true })
  })

  it('a global Rank1 that fails the quality gate is skipped before acquisition; Rank2 becomes attemptOrder 1', () => {
    const { dir, db, cfg, pushId } = setup()
    // p1 can rank highly overall but is not valid for the current curriculum stage.
    persistSemanticScores(db, pushId, [score('p1', 1.0, 0.2, 0.9), score('p2', 0.8, 0.9, 0.9)], cfg)
    const next = ensureAcquisitionTurn(db, pushId, 'p2', cfg)
    expect(next.agentRank).toBe(2)
    expect(allocateAttemptOrder(db, pushId, 'p2')).toBe(1)
    expect(() => ensureAcquisitionTurn(db, pushId, 'p1', cfg)).toThrow(/当前必须处理 agentRank #2/)
    db.close(); rmSync(dir, { recursive: true, force: true })
  })

  it('SELECTED is a hard stop: no later acquisition can start', () => {
    const { dir, db, cfg, pushId } = setup()
    persistSemanticScores(db, pushId, [score('p1', 0.95), score('p2', 0.80)], cfg)
    ensureAcquisitionTurn(db, pushId, 'p1', cfg)
    markAcquisitionOutcome(db, pushId, 'p1', 'SELECTED', 'PDF_OK')
    expect(() => ensureAcquisitionTurn(db, pushId, 'p2', cfg)).toThrow(/已 SELECTED/)
    db.close(); rmSync(dir, { recursive: true, force: true })
  })
})
