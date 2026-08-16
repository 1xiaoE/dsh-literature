/**
 * Performance audit regression tests:
 * - PerfTracker accumulates per-phase timings and flushes them into pushes;
 * - literature_sources records retrieval_ms / deterministic_ranking_ms /
 *   raw_candidates / deterministic_candidates;
 * - literature_fetch_pdf records pdf_download_ms / pdf_attempt_count;
 * - literature_record flushes the full perfSummary (agent-reported phases +
 *   total_ms) and exposes it;
 * - v10 schema: performance columns exist;
 * - push_now instructions mandate BATCH semantic ranking (no per-paper LLM
 *   fan-out).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.js'
import { createRuntime, type LiteratureRuntime } from '../src/lib/runtime.js'
import { openDb, upsertPaper } from '../src/db.js'
import { ensureStage, getStage } from '../src/lib/stages.js'
import { startPush } from '../src/lib/history.js'
import { PerfTracker } from '../src/lib/perf.js'
import { SourceRegistry } from '../src/sources/registry.js'
import type { PaperRef, PdfCandidate, SearchHit, SearchParams, SourceAdapter } from '../src/sources/types.js'
import { defineLiteratureSources } from '../src/tools/literature_sources.js'
import { defineLiteratureRecord } from '../src/tools/literature_record.js'
import { defineLiteraturePushNow } from '../src/tools/literature_push_now.js'

async function run<T>(tool: { execute: (a: never, e: never) => Promise<T> }, args: unknown): Promise<T> {
  return tool.execute(args as never, { signal: new AbortController().signal } as never)
}

function setup(): { rt: LiteratureRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-perf-'))
  const rt = createRuntime(normalizeConfig({ dataDir: dir }))
  return { rt, dir }
}

class FakeAdapter implements SourceAdapter {
  readonly name = 'fake'
  constructor(private readonly paper: PaperRef) {}
  async search(_params: SearchParams): Promise<SearchHit[]> {
    await new Promise((r) => setTimeout(r, 5)) // simulate network latency
    return [{ paper: this.paper, query: 'fake query' }]
  }
  async expand(): Promise<Partial<PaperRef> | null> {
    return null
  }
  async pdfCandidates(): Promise<PdfCandidate[]> {
    return []
  }
}

describe('PerfTracker', () => {
  it('accumulates patches and flushes them into the pushes row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-perf-track-'))
    const db = openDb(dir)
    const pushId = startPush(db, 't', 1).pushId
    const tracker = new PerfTracker()
    tracker.add(pushId, { retrievalMs: 100 })
    tracker.add(pushId, { retrievalMs: 50, pdfDownloadMs: 300 })
    tracker.add(pushId, { fulltextReadMs: 40 })
    const perf = tracker.flush(db, pushId, { llmCallCount: 2, totalMs: 1000 })
    expect(perf.retrievalMs).toBe(150)
    expect(perf.pdfDownloadMs).toBe(300)
    expect(perf.fulltextReadMs).toBe(40)
    expect(perf.llmCallCount).toBe(2)
    const row = db.prepare('SELECT retrieval_ms, pdf_download_ms, llm_call_count, total_ms FROM pushes WHERE id = ?').get(pushId) as {
      retrieval_ms: number
      pdf_download_ms: number
      llm_call_count: number
      total_ms: number
    }
    expect(row.retrieval_ms).toBe(150)
    expect(row.pdf_download_ms).toBe(300)
    expect(row.llm_call_count).toBe(2)
    expect(row.total_ms).toBe(1000)
    // flush clears the accumulator
    expect(tracker.get(pushId).retrievalMs).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('literature_sources performance recording', () => {
  it('records retrieval_ms / deterministic_ranking_ms / raw / deterministic candidates', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    const registry = new SourceRegistry()
    registry.register(new FakeAdapter({
      id: 'doi:10.1/perf',
      title: 'Impedance Control for Legged Robot Locomotion',
      authors: ['A'],
      year: 2024,
      citations: 10,
      doi: '10.1/perf',
      metadataSource: 'fake',
    }))
    rt.registry = registry
    const out = await run(defineLiteratureSources(() => rt), {})
    const perf = rt.perf.get(out.pushId)
    expect(perf.retrievalMs).toBeGreaterThanOrEqual(5) // simulated latency
    expect(perf.deterministicRankingMs).toBeGreaterThanOrEqual(0)
    expect(perf.rawCandidates).toBeGreaterThan(0)
    expect(perf.deterministicCandidates).toBeGreaterThan(0)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('literature_record perf flush (agent-reported phases + total_ms)', () => {
  it('persists full perfSummary with agent-reported fields and total_ms', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const paperId = 'arxiv:2401.555'
    upsertPaper(rt.db, {
      id: paperId,
      title: 'Perf Test Paper',
      authors: '["T"]',
      venue: null,
      year: 2024,
      doi: null,
      arxiv_id: '2401.555',
      openalex_id: null,
      url: null,
      oa_pdf_url: null,
      abstract: null,
      citations: 5,
      bibtex: null,
      metadata_source: 'arxiv',
    })
    rt.db
      .prepare(
        `INSERT INTO candidates (push_id, paper_id, rank_hint, picked, stage_relevance_score,
          curriculum_value, selection_outcome, agent_rank, preflight_attempt_order, candidate_pool, is_seen)
         VALUES (?, ?, 1, 0, 0.8, 0.7, 'SELECTED', 1, 1, 'recent', 0)`,
      )
      .run(pushId, paperId)
    rt.perf.add(pushId, { retrievalMs: 1200, deterministicRankingMs: 40, pdfDownloadMs: 900, parsingMs: 300, fulltextReadMs: 2500 })

    const recordTool = defineLiteratureRecord(() => rt, () => null)
    const rec = (await run(recordTool, {
      pushId,
      status: 'completed',
      paperId,
      scores: [
        {
          paperId,
          relevance: 0.9,
          learningValue: 0.8,
          representativeness: 0.8,
          novelty: 0.6,
          stageRelevance: 0.8,
          curriculumValue: 0.7,
          rationale: 'perf test',
        },
      ],
      selection: [{ paperId, agentRank: 1, attemptOrder: 1, outcome: 'SELECTED', reason: 'ok' }],
      knowledgeGoals: ['impedance_compliance'],
      agentRankingMs: 4500,
      reportGenerationMs: 8000,
      llmCallCount: 2,
      llmRetryCount: 0,
    })) as { perfSummary: Record<string, number> }

    expect(rec.perfSummary.retrievalMs).toBe(1200)
    expect(rec.perfSummary.deterministicRankingMs).toBe(40)
    expect(rec.perfSummary.pdfDownloadMs).toBe(900)
    expect(rec.perfSummary.agentRankingMs).toBe(4500)
    expect(rec.perfSummary.reportGenerationMs).toBe(8000)
    expect(rec.perfSummary.agentScoredCandidates).toBe(1)
    expect(rec.perfSummary.llmCallCount).toBe(2)
    expect(rec.perfSummary.totalMs).toBeGreaterThan(0)

    const row = rt.db.prepare('SELECT agent_ranking_ms, llm_call_count, total_ms FROM pushes WHERE id = ?').get(pushId) as {
      agent_ranking_ms: number
      llm_call_count: number
      total_ms: number
    }
    expect(row.agent_ranking_ms).toBe(4500)
    expect(row.llm_call_count).toBe(2)
    expect(row.total_ms).toBeGreaterThan(0)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('BATCH semantic ranking mandate', () => {
  it('push_now instructions require one-shot batch ranking (no per-paper LLM fan-out)', async () => {
    const { rt, dir } = setup()
    const out = (await run(defineLiteraturePushNow(() => rt, () => null), {})) as { instructions: string[] }
    const joined = out.instructions.join('\n')
    expect(joined).toMatch(/BATCH/)
    expect(joined).toMatch(/禁止逐篇发起独立 LLM 请求/)
    expect(joined).toMatch(/llmCallCount/)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('v10 schema', () => {
  it('exposes the performance columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-v10-'))
    const db = openDb(dir)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(10)
    const cols = (db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>).map((c) => c.name)
    for (const c of ['retrieval_ms', 'deterministic_ranking_ms', 'agent_ranking_ms', 'pdf_preflight_ms', 'pdf_download_ms', 'parsing_ms', 'fulltext_read_ms', 'report_generation_ms', 'total_ms', 'raw_candidates', 'deterministic_candidates', 'agent_scored_candidates', 'llm_call_count', 'llm_retry_count', 'pdf_attempt_count']) {
      expect(cols, c).toContain(c)
    }
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
