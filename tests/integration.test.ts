/**
 * Integration tests over the real tool chain (defineLiterature* + real
 * pdftotext + node:sqlite) with a stubbed fetch.
 *
 * - PDF_FALLBACK_SUCCESS: first source fails, a later legal source succeeds,
 *   full-text is indexed and readable chunk-by-chunk.
 * - FULLTEXT_UNAVAILABLE_TERMINAL: every source fails → push terminal status
 *   fulltext_unavailable, no analyze, no fake report, no stage progress.
 * - stage gate: below-threshold stage_relevance papers cannot be picked.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig, type LiteratureConfig } from '../src/config.js'
import { createRuntime, type LiteratureRuntime } from '../src/lib/runtime.js'
import { upsertPaper } from '../src/db.js'
import { startPush } from '../src/lib/history.js'
import { getStage, ensureStage } from '../src/lib/stages.js'
import { defineLiteratureFetchPdf } from '../src/tools/literature_fetch_pdf.js'
import { defineLiteratureFulltextIndex } from '../src/tools/literature_fulltext_index.js'
import { defineLiteratureFulltextRead } from '../src/tools/literature_fulltext_read.js'
import { defineLiteratureRecord } from '../src/tools/literature_record.js'

/** Build a minimal valid single-page PDF whose text pdftotext can extract. */
function makePdf(text: string): Buffer {
  const objs: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  }
  // wrap text in 60-char lines so the page width does not truncate extraction
  const lines: string[] = []
  for (let i = 0; i < text.length; i += 60) lines.push(text.slice(i, i + 60))
  const stream =
    'BT /F1 12 Tf 72 720 Td ' + lines.map((l) => `(${l}) Tj 0 -14 Td`).join(' ') + ' ET'
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefPos = out.length
  out += 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Stub fetch: serves routes in order, then repeats the last. */
function routeFetch(routes: Array<{ status: number; body: Buffer | string }>): typeof fetch {
  let i = 0
  return (async () => {
    const r = routes[Math.min(i, routes.length - 1)]!
    i += 1
    if (r.status !== 200) return new Response('nope', { status: r.status })
    return new Response(r.body, { status: 200 })
  }) as typeof fetch
}

function setup(cfg: Partial<LiteratureConfig>, fetchImpl: typeof fetch): { rt: LiteratureRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-int-'))
  const rt = createRuntime(normalizeConfig({ ...cfg, dataDir: dir }), { fetchImpl })
  return { rt, dir }
}

function seed(rt: LiteratureRuntime, over: Record<string, unknown> = {}): string {
  const id = 'arxiv:2401.001'
  upsertPaper(rt.db, {
    id,
    title: 'Whole-Body Control for Legged Robot Locomotion',
    authors: '["A","B"]',
    venue: null,
    year: 2024,
    doi: '10.1/x',
    arxiv_id: '2401.001',
    openalex_id: null,
    url: null,
    oa_pdf_url: null,
    abstract: 'A whole-body control approach with contact force distribution.',
    citations: 10,
    bibtex: null,
    metadata_source: 'arxiv',
    ...over,
  })
  return id
}

/** Run a tool's execute with a stub exec context (tools do not use exec). */
async function run<T>(tool: { execute: (a: never, e: never) => Promise<T> }, args: unknown): Promise<T> {
  return tool.execute(args as never, { signal: new AbortController().signal } as never)
}

describe('PDF_FALLBACK_SUCCESS', () => {
  it('first source fails, later legal source succeeds → full-text readable in chunks', async () => {
    // pad the PDF so it exceeds the default minPdfBytes (10240)
    const pdf = makePdf(
      'Abstract We propose a whole-body MPC controller for legged robot locomotion on rough terrain. ' +
        'padding padding padding padding padding padding '.repeat(600),
    )
    const { rt, dir } = setup({}, routeFetch([{ status: 404, body: 'nf' }, { status: 200, body: pdf }]))
    // arxiv candidate (will 404) + openalex url candidate (succeeds); no doi so
    // crossref's pdfCandidates does not consume a stub route
    seed(rt, { oa_pdf_url: 'https://oa.example/paper.pdf', doi: null })

    const fetchTool = defineLiteratureFetchPdf(() => rt)
    const fetchRes = await run(fetchTool, { paperId: 'arxiv:2401.001' })
    expect(fetchRes.outcome).toBe('ok')
    expect(fetchRes.sha256).toHaveLength(64)
    expect(fetchRes.attempts.map((a) => a.status)).toEqual(['http_error', 'ok'])

    const indexTool = defineLiteratureFulltextIndex(() => rt)
    const indexRes = await run(indexTool, { paperId: 'arxiv:2401.001' })
    expect(indexRes.status).toBe('ok')
    expect(indexRes.parser).toMatch(/pdftotext/)
    expect(indexRes.chunks.length).toBeGreaterThan(0)

    const readTool = defineLiteratureFulltextRead(() => rt)
    const readRes = await run(readTool, { paperId: 'arxiv:2401.001', seq: 0 })
    expect(readRes.found).toBe(true)
    expect(readRes.content).toContain('whole-body MPC controller')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('FULLTEXT_UNAVAILABLE_TERMINAL', () => {
  it('all sources fail → terminal status, no analyze, no stage progress', async () => {
    const { rt, dir } = setup({}, routeFetch([{ status: 403, body: 'denied' }]))
    // single candidate (openalex url) that always 403s; no arxiv id, no doi → no other sources
    seed(rt, { arxiv_id: null, doi: null, url: 'https://bad.example/paper.pdf' })

    const fetchTool = defineLiteratureFetchPdf(() => rt)
    const fetchRes = await run(fetchTool, { paperId: 'arxiv:2401.001' })
    expect(fetchRes.outcome).toBe('FULLTEXT_UNAVAILABLE')

    // analyze must not happen: index reports unavailable with zero chunks
    const indexTool = defineLiteratureFulltextIndex(() => rt)
    const indexRes = await run(indexTool, { paperId: 'arxiv:2401.001' })
    expect(indexRes.status).toBe('unavailable')
    expect(indexRes.chunks).toEqual([])
    const ftRow = rt.db.prepare('SELECT status FROM fulltexts WHERE paper_id = ?').get('arxiv:2401.001') as
      | { status: string }
      | undefined
    expect(ftRow?.status).toBe('unavailable')

    // terminal record: no fake report, no stage progress
    ensureStage(rt.db, '足式机器人控制', 3)
    const pushId = startPush(rt.db, '足式机器人控制', 1).pushId
    rt.db.prepare('INSERT INTO candidates (push_id, paper_id, rank_hint, picked, is_seen) VALUES (?, ?, 1, 0, 0)').run(pushId, 'arxiv:2401.001')
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    const rec = await run(recordTool, {
      pushId,
      status: 'fulltext_unavailable',
      errorCode: 'NO_LEGAL_FULLTEXT',
      errorDetail: 'all sources failed: 403',
      scores: [{ paperId: 'arxiv:2401.001', relevance: 0.8, learningValue: 0.8, representativeness: 0.7, novelty: 0.4, stageRelevance: 0.8, curriculumValue: 0.8, rationale: 'quality-passed but inaccessible' }],
      selection: [
        { paperId: 'arxiv:2401.001', agentRank: 1, attemptOrder: 1, outcome: 'FULLTEXT_UNAVAILABLE', reason: 'all sources 403' },
      ],
    })
    expect(rec.status).toBe('fulltext_unavailable')
    expect(rec.stageAdvanced).toBe(false)
    expect(getStage(rt.db, '足式机器人控制').papersInStage).toBe(0)
    const push = rt.db.prepare('SELECT status, report_path, error_code FROM pushes WHERE id = ?').get(pushId) as {
      status: string
      report_path: string | null
      error_code: string | null
    }
    expect(push.status).toBe('fulltext_unavailable')
    expect(push.report_path).toBeNull()
    expect(push.error_code).toBe('NO_LEGAL_FULLTEXT')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('stage relevance gate', () => {
  it('rejects picked paper without stage_relevance score', async () => {
    const { rt, dir } = setup({}, routeFetch([]))
    seed(rt)
    ensureStage(rt.db, '足式机器人控制', 3)
    const pushId = startPush(rt.db, '足式机器人控制', 1).pushId
    rt.db
      .prepare(
        'INSERT INTO candidates (push_id, paper_id, rank_hint, picked, is_seen) VALUES (?, ?, 1, 0, 0)',
      )
      .run(pushId, 'arxiv:2401.001')
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    await expect(
      run(recordTool, { pushId, status: 'completed', paperId: 'arxiv:2401.001', scores: [] }),
    ).rejects.toThrow(/评分缺失/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects below-threshold picked paper even with high overall impact', async () => {
    const { rt, dir } = setup({}, routeFetch([]))
    seed(rt)
    ensureStage(rt.db, '足式机器人控制', 3)
    const pushId = startPush(rt.db, '足式机器人控制', 1).pushId
    rt.db
      .prepare(
        'INSERT INTO candidates (push_id, paper_id, rank_hint, picked, is_seen) VALUES (?, ?, 1, 0, 0)',
      )
      .run(pushId, 'arxiv:2401.001')
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    await expect(
      run(recordTool, {
        pushId,
        status: 'completed',
        paperId: 'arxiv:2401.001',
        scores: [
          {
            paperId: 'arxiv:2401.001',
            relevance: 0.9,
            learningValue: 0.9,
            representativeness: 0.9,
            novelty: 0.5,
            stageRelevance: 0.4, // below default threshold 0.6
            curriculumValue: 0.9,
            rationale: 'high impact but not stage-matched',
          },
        ],
      }),
    ).rejects.toThrow(/低于阈值/)
    // push stays running (not completed)
    const push = rt.db.prepare('SELECT status FROM pushes WHERE id = ?').get(pushId) as { status: string }
    expect(push.status).toBe('running')
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts stage-matched pick and counts stage progress only for it', async () => {
    const { rt, dir } = setup({}, routeFetch([]))
    seed(rt)
    ensureStage(rt.db, '足式机器人控制', 3)
    const pushId = startPush(rt.db, '足式机器人控制', 1).pushId
    rt.db
      .prepare(
        'INSERT INTO candidates (push_id, paper_id, rank_hint, picked, is_seen) VALUES (?, ?, 1, 0, 0)',
      )
      .run(pushId, 'arxiv:2401.001')
    rt.db.prepare("INSERT INTO fulltexts (paper_id, status, parser, char_count, chunk_count) VALUES ('arxiv:2401.001', 'ok', 'test', 100, 1)").run()
    rt.db.prepare("INSERT INTO fulltext_reads (push_id, paper_id, seq) VALUES (?, 'arxiv:2401.001', 0)").run(pushId)
    const reportPath = join(dir, 'stage-match.md')
    writeFileSync(reportPath, '# stage matched report\n')
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    const rec = await run(recordTool, {
      pushId,
      status: 'completed',
      paperId: 'arxiv:2401.001',
      reportPath,
      selection: [
        { paperId: 'arxiv:2401.001', agentRank: 1, attemptOrder: 1, outcome: 'SELECTED', reason: 'arXiv OA' },
      ],
      scores: [
        {
          paperId: 'arxiv:2401.001',
          relevance: 0.8,
          learningValue: 0.7,
          representativeness: 0.7,
          novelty: 0.4,
          stageRelevance: 0.9,
          curriculumValue: 0.85,
          rationale: 'stage-matched fundamentals paper',
        },
      ],
      knowledgeGoals: ['template_dynamics'],
    })
    expect(rec.stageMatched).toBe(true)
    expect(rec.papersInStage).toBe(1)
    expect(rec.targetPapers).toBe(3)
    expect(rec.stageAdvanced).toBe(false)
    const cand = rt.db
      .prepare('SELECT stage_relevance_score, final_score, rationale, picked FROM candidates WHERE push_id = ? AND paper_id = ?')
      .get(pushId, 'arxiv:2401.001') as { stage_relevance_score: number; final_score: number; rationale: string; picked: number }
    expect(cand.stage_relevance_score).toBe(0.9)
    expect(cand.rationale).toContain('stage-matched')
    expect(cand.picked).toBe(1)
    expect(cand.final_score).toBeGreaterThan(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('selection invariant (V0.3)', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-sel-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }), {
      fetchImpl: (async () => new Response('nope', { status: 403 })) as typeof fetch,
    })
    const paperId = seed(rt)
    ensureStage(rt.db, 'legged_robot_control', 3)
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    rt.db
      .prepare('INSERT INTO candidates (push_id, paper_id, rank_hint, picked, is_seen) VALUES (?, ?, 1, 0, 0)')
      .run(pushId, paperId)
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    return { rt, dir, pushId, paperId, recordTool }
  }
  const okScores = (pid: string) => [
    {
      paperId: pid,
      relevance: 0.8,
      learningValue: 0.7,
      representativeness: 0.7,
      novelty: 0.4,
      stageRelevance: 0.9,
      curriculumValue: 0.85,
      rationale: 'ok',
    },
  ]

  it('rejects attempts after SELECTED (invariant)', async () => {
    const { rt, dir, pushId, paperId, recordTool } = setup()
    await expect(
      run(recordTool, {
        pushId,
        status: 'completed',
        paperId,
        selection: [
          { paperId, agentRank: 1, attemptOrder: 1, outcome: 'SELECTED', reason: 'OA' },
          { paperId, agentRank: 2, attemptOrder: 2, outcome: 'FULLTEXT_UNAVAILABLE', reason: 'late' },
        ],
        scores: okScores(paperId),
      }),
    ).rejects.toThrow(/SELECTED 出现后/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a second SELECTED (selected_count == 1)', async () => {
    const { rt, dir, pushId, paperId, recordTool } = setup()
    await expect(
      run(recordTool, {
        pushId,
        status: 'completed',
        paperId,
        selection: [
          { paperId, agentRank: 1, attemptOrder: 1, outcome: 'SELECTED', reason: 'OA' },
          { paperId, agentRank: 3, attemptOrder: 2, outcome: 'SELECTED', reason: 'again' },
        ],
        scores: okScores(paperId),
      }),
    ).rejects.toThrow(/至多一个 SELECTED/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects attemptOrder not starting at 1 / non-contiguous', async () => {
    const { rt, dir, pushId, paperId, recordTool } = setup()
    await expect(
      run(recordTool, {
        pushId,
        status: 'completed',
        paperId,
        selection: [
          { paperId, agentRank: 1, attemptOrder: 2, outcome: 'SELECTED', reason: 'OA' },
        ],
        scores: okScores(paperId),
      }),
    ).rejects.toThrow(/attemptOrder/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('hard-rejects a selection trail that skips the current highest quality rank', async () => {
    const { rt, dir, pushId, paperId, recordTool } = setup()
    await expect(run(recordTool, {
      pushId,
      status: 'completed',
      paperId,
      selection: [
        { paperId, agentRank: 3, attemptOrder: 1, outcome: 'SELECTED', reason: 'OA' },
      ],
      scores: okScores(paperId),
    })).rejects.toThrow(/Quality First invariant/)
    rmSync(dir, { recursive: true, force: true })
  })
})

const okScoresForUnavailable = (paperId: string) => [{
  paperId, relevance: 0.8, learningValue: 0.7, representativeness: 0.7, novelty: 0.4,
  stageRelevance: 0.9, curriculumValue: 0.85, rationale: 'quality-passed but unavailable',
}]

describe('fulltext_unavailable trail enforcement (V0.3)', () => {
  it('requires a selection trail for fulltext_unavailable status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-ftu-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }), {
      fetchImpl: (async () => new Response('nope', { status: 403 })) as typeof fetch,
    })
    const paperId = seed(rt)
    ensureStage(rt.db, 'legged_robot_control', 3)
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    rt.db
      .prepare('INSERT INTO candidates (push_id, paper_id, rank_hint, picked, is_seen) VALUES (?, ?, 1, 0, 0)')
      .run(pushId, paperId)
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    await expect(
      run(recordTool, { pushId, status: 'fulltext_unavailable' }),
    ).rejects.toThrow(/selection 轨迹/)
    // with the trail, it succeeds and persists attempt order
    const rec = await run(recordTool, {
      pushId,
      status: 'fulltext_unavailable',
      scores: okScoresForUnavailable(paperId),
      selection: [
        { paperId, agentRank: 1, attemptOrder: 1, outcome: 'FULLTEXT_UNAVAILABLE', reason: 'all sources 403' },
      ],
    })
    expect(rec.status).toBe('fulltext_unavailable')
    const row = rt.db
      .prepare('SELECT agent_rank, preflight_attempt_order, selection_outcome FROM candidates WHERE push_id = ? AND paper_id = ?')
      .get(pushId, paperId) as { agent_rank: number | null; preflight_attempt_order: number | null; selection_outcome: string }
    expect(row.agent_rank).toBe(1)
    expect(row.preflight_attempt_order).toBe(1)
    expect(row.selection_outcome).toBe('FULLTEXT_UNAVAILABLE')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('fulltext reads coverage (audit fix)', () => {
  it('completed without any fulltext_read is rejected; reads are recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-reads-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }), {
      fetchImpl: (async () => new Response('nope', { status: 403 })) as typeof fetch,
    })
    const paperId = seed(rt)
    ensureStage(rt.db, 'legged_robot_control', 3)
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    rt.db
      .prepare('INSERT INTO candidates (push_id, paper_id, rank_hint, picked, is_seen) VALUES (?, ?, 1, 0, 0)')
      .run(pushId, paperId)
    // pretend the fulltext was indexed (chunks exist)
    rt.db
      .prepare("INSERT INTO fulltexts (paper_id, status, parser, char_count, chunk_count) VALUES (?, 'ok', 'pdftotext', 1000, 5)")
      .run(paperId)
    const insChunk = rt.db.prepare(
      'INSERT INTO fulltext_chunks (paper_id, seq, section, char_start, char_end, content) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < 5; i += 1) insChunk.run(paperId, i, 'chunk', i * 10, i * 10 + 10, 'content ' + i)
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    const args = {
      pushId,
      status: 'completed' as const,
      paperId,
      selection: [{ paperId, agentRank: 1, attemptOrder: 1, outcome: 'SELECTED' as const, reason: 'OA' }],
      scores: [
        {
          paperId,
          relevance: 0.8,
          learningValue: 0.7,
          representativeness: 0.7,
          novelty: 0.4,
          stageRelevance: 0.9,
          curriculumValue: 0.85,
          rationale: 'ok',
        },
      ],
      knowledgeGoals: ['template_dynamics'],
    }
    // no reads yet → rejected
    await expect(run(recordTool, args)).rejects.toThrow(/全文阅读覆盖不足/)
    // partial reads still cannot complete under the default 100% gate.
    const readTool = defineLiteratureFulltextRead(() => rt)
    await run(readTool, { paperId, seq: 0, pushId })
    await run(readTool, { paperId, seq: 1, pushId })
    await expect(run(recordTool, args)).rejects.toThrow(/全文阅读覆盖不足/)
    for (const seq of [2, 3, 4]) await run(readTool, { paperId, seq, pushId })
    const reportPath = join(dir, 'full-read.md')
    writeFileSync(reportPath, '# full read report\n')
    const rec = await run(recordTool, { ...args, reportPath })
    expect(rec.readsCount).toBe(5)
    const reads = rt.db
      .prepare('SELECT seq FROM fulltext_reads WHERE push_id = ? AND paper_id = ? ORDER BY seq')
      .all(pushId, paperId) as Array<{ seq: number }>
    expect(reads.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4])
    rmSync(dir, { recursive: true, force: true })
  })
})
