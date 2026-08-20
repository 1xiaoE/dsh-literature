/**
 * V0.1 final hardening tests:
 * A. every literature_* tool output passes the strict lossless-JSON boundary
 *    (no undefined / NaN / ±Infinity / -0 / BigInt / Date / function / symbol
 *    / non-plain instances / sparse arrays — verified recursively);
 * B. undefined optional fields never appear in returned objects;
 * C. literature_record succeeds at DB level AND returns a valid tool result;
 * I. fractional perf timings are rounded and never break serialization.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.js'
import { createRuntime, type LiteratureRuntime } from '../src/lib/runtime.js'
import { upsertPaper } from '../src/db.js'
import { ensureStage, getStage } from '../src/lib/stages.js'
import { startPush } from '../src/lib/history.js'
import { assertLosslessJsonSafe, jsonSafe } from '../src/lib/json_safe.js'
import { SourceRegistry } from '../src/sources/registry.js'
import type { PaperRef, PdfCandidate, SearchHit, SearchParams, SourceAdapter } from '../src/sources/types.js'
import { defineLiteratureSources } from '../src/tools/literature_sources.js'
import { defineLiteratureFetchPdf } from '../src/tools/literature_fetch_pdf.js'
import { defineLiteraturePdfPreflight } from '../src/tools/literature_pdf_preflight.js'
import { defineLiteratureFulltextIndex } from '../src/tools/literature_fulltext_index.js'
import { defineLiteratureFulltextRead } from '../src/tools/literature_fulltext_read.js'
import { defineLiteraturePushNow } from '../src/tools/literature_push_now.js'
import { defineLiteratureRecord } from '../src/tools/literature_record.js'
import { defineLiteratureUserAction } from '../src/tools/literature_user_action.js'
import { defineLiteratureResume } from '../src/tools/literature_resume.js'
import { defineLiteratureReportWrite } from '../src/tools/literature_report_write.js'

function setup(): { rt: LiteratureRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-safe-'))
  const rt = createRuntime(normalizeConfig({ dataDir: dir }))
  return { rt, dir }
}

async function run<T>(tool: { execute: (a: never, e: never) => Promise<T> }, args: unknown): Promise<T> {
  return tool.execute(args as never, { signal: new AbortController().signal } as never)
}

/** Assert a tool output is strictly lossless-JSON safe and survives round-trip. */
function expectLossless<T>(v: T): T {
  assertLosslessJsonSafe(v)
  const round = JSON.parse(JSON.stringify(v)) // must not throw
  expect(round).toEqual(JSON.parse(JSON.stringify(jsonSafe(v))))
  return v
}

function makePdf(text: string): Buffer {
  const objs: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  }
  const lines: string[] = []
  for (let i = 0; i < text.length; i += 60) lines.push(text.slice(i, i + 60))
  const stream = 'BT /F1 12 Tf 72 720 Td ' + lines.map((l) => `(${l}) Tj 0 -14 Td`).join(' ') + ' ET'
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefPos = out.length
  out += 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

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

describe('jsonSafe helper', () => {
  it('strips undefined, NaN/Infinity→null, -0→0, BigInt→string, Date→ISO, fn/symbol removed, class flattened', () => {
    class Thing {
      constructor(public a = 1, public b?: number) {}
    }
    const input = {
      keep: 'x',
      undef: undefined,
      nan: Number.NaN,
      inf: Infinity,
      ninf: -Infinity,
      negZero: -0,
      big: 10n,
      date: new Date('2026-01-01T00:00:00Z'),
      fn: () => 1,
      sym: Symbol('s'),
      arr: [1, undefined, Number.NaN, 2],
      sparse: [1, , 3], // eslint-disable-line no-sparse-arrays
      inst: new Thing(7),
      nested: { deepUndef: undefined, deep: 1 },
    }
    const out = jsonSafe(input)
    expect(out).toEqual({
      keep: 'x',
      nan: null,
      inf: null,
      ninf: null,
      negZero: 0,
      big: '10',
      date: '2026-01-01T00:00:00.000Z',
      arr: [1, null, null, 2],
      sparse: [1, null, 3],
      inst: { a: 7 },
      nested: { deep: 1 },
    })
    expectLossless(out)
  })

  it('throws on circular references (explicit bug signal)', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => jsonSafe(a)).toThrow(/circular/)
  })
})

/* ---------------- A/B: every tool output is lossless-JSON safe ---------------- */

describe('A: all literature_* tool outputs pass the lossless-JSON boundary', () => {
  it('literature_sources', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    const registry = new SourceRegistry()
    registry.register(new FakeAdapter({
      id: 'doi:10.1/safe',
      title: 'Impedance Control for Legged Robot Locomotion',
      authors: ['A'],
      year: 2024,
      citations: 10,
      doi: '10.1/safe',
      metadataSource: 'fake',
    }))
    rt.registry = registry
    expectLossless(await run(defineLiteratureSources(() => rt), {}))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('literature_push_now', async () => {
    const { rt, dir } = setup()
    expectLossless(await run(defineLiteraturePushNow(() => rt, () => null), { topic: 'legged_robot_control' }))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('literature_pdf_preflight (all sources fail → available false)', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    const paperId = 'arxiv:2401.001'
    upsertPaper(rt.db, {
      id: paperId, title: 'T', authors: '["A"]', venue: null, year: 2024,
      doi: null, arxiv_id: '2401.001', openalex_id: null, url: null, oa_pdf_url: null,
      abstract: null, citations: 1, bibtex: null, metadata_source: 'arxiv',
    })
    const rt2 = { ...rt, fetchImpl: (async () => new Response('nope', { status: 404 })) as typeof fetch }
    expectLossless(await run(defineLiteraturePdfPreflight(() => rt2 as LiteratureRuntime), { paperId }))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('literature_fetch_pdf (manualPdfPath path)', async () => {
    const { rt, dir } = setup()
    const paperId = 'arxiv:2401.002'
    upsertPaper(rt.db, {
      id: paperId, title: 'T', authors: '["A"]', venue: null, year: 2024,
      doi: null, arxiv_id: '2401.002', openalex_id: null, url: null, oa_pdf_url: null,
      abstract: null, citations: 1, bibtex: null, metadata_source: 'arxiv',
    })
    const pdf = join(dir, 'manual.pdf')
    writeFileSync(pdf, makePdf('Abstract safe output. ' + 'padding padding padding padding padding padding '.repeat(600)))
    expectLossless(await run(defineLiteratureFetchPdf(() => rt), { paperId, manualPdfPath: pdf }))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('literature_fulltext_index + literature_fulltext_read (no pdf → unavailable / not found)', async () => {
    const { rt, dir } = setup()
    const paperId = 'arxiv:2401.003'
    upsertPaper(rt.db, {
      id: paperId, title: 'T', authors: '["A"]', venue: null, year: 2024,
      doi: null, arxiv_id: '2401.003', openalex_id: null, url: null, oa_pdf_url: null,
      abstract: null, citations: 1, bibtex: null, metadata_source: 'arxiv',
    })
    expectLossless(await run(defineLiteratureFulltextIndex(() => rt), { paperId }))
    expectLossless(await run(defineLiteratureFulltextRead(() => rt), { paperId, seq: 0 }))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('literature_user_action (open + resolve)', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const ua = defineLiteratureUserAction(() => rt)
    const opened = await run(ua, {
      action: 'open', pushId, step: 'fetch_pdf', kind: 'carsi_relogin',
      issue: 'x', whatUserShouldDo: 'y', howToContinue: 'z',
    })
    expectLossless(opened)
    expectLossless(await run(ua, { action: 'resolve', pushId, actionId: (opened as { actionId: number }).actionId }))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('literature_resume (terminal push → canResume false, no undefined props)', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    rt.db.prepare("UPDATE pushes SET status = 'completed' WHERE id = ?").run(pushId)
    const out = await run(defineLiteratureResume(() => rt), { pushId })
    expectLossless(out)
    expect((out as { canResume: boolean }).canResume).toBe(false)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('literature_report_write (ok + failure)', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const rw = defineLiteratureReportWrite(() => rt)
    const ok = await run(rw, { pushId, stageLabel: '基础控制', filename: 'T_2024_test.md', content: '# 报告\n内容' })
    expectLossless(ok)
    expect((ok as { ok: boolean }).ok).toBe(true)
    const bad = await run(rw, { pushId, stageLabel: '基础控制', filename: 'bad name!.md', content: 'x' })
    expectLossless(bad)
    expect((bad as { ok: boolean }).ok).toBe(false)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('literature_record completed (DB success AND tool success, fractional perf)', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const paperId = 'arxiv:2401.004'
    upsertPaper(rt.db, {
      id: paperId, title: 'T', authors: '["A"]', venue: null, year: 2024,
      doi: null, arxiv_id: '2401.004', openalex_id: null, url: null, oa_pdf_url: null,
      abstract: null, citations: 1, bibtex: null, metadata_source: 'arxiv',
    })
    rt.db
      .prepare(
        `INSERT INTO candidates (push_id, paper_id, rank_hint, picked, stage_relevance_score,
          curriculum_value, selection_outcome, agent_rank, preflight_attempt_order, candidate_pool, is_seen)
         VALUES (?, ?, 1, 0, 0.85, 0.8, 'SELECTED', 1, 1, 'recent', 0)`,
      )
      .run(pushId, paperId)
    rt.db
      .prepare("INSERT INTO fulltexts (paper_id, status, parser, char_count, chunk_count) VALUES (?, 'ok', 'pdftotext', 100, 2)")
      .run(paperId)
    rt.db.prepare('INSERT INTO fulltext_reads (push_id, paper_id, seq) VALUES (?, ?, 0)').run(pushId, paperId)
    rt.db.prepare('INSERT INTO fulltext_reads (push_id, paper_id, seq) VALUES (?, ?, 1)').run(pushId, paperId)
    // canonical report must exist before completed is accepted
    const rw = defineLiteratureReportWrite(() => rt)
    const rep = (await run(rw, { pushId, stageLabel: '基础控制', filename: 'T_2024_safe.md', content: '# ok' })) as { reportPath: string }
    rt.perf.add(pushId, { retrievalMs: 1234.567, pdfDownloadMs: 88.2, fulltextReadMs: 9.5 })

    const rec = (await run(defineLiteratureRecord(() => rt, () => null), {
      pushId,
      status: 'completed',
      paperId,
      reportPath: rep.reportPath,
      scores: [{
        paperId, relevance: 0.9, learningValue: 0.8, representativeness: 0.8,
        novelty: 0.6, stageRelevance: 0.85, curriculumValue: 0.8, rationale: 'safe',
      }],
      selection: [{ paperId, agentRank: 1, attemptOrder: 1, outcome: 'SELECTED', reason: 'ok' }],
      knowledgeGoals: ['impedance_compliance'],
      agentRankingMs: 4500.999,
      llmCallCount: 2,
    })) as { status: string; perfSummary: Record<string, number> }

    expect(rec.status).toBe('completed')
    expect(rec.perfSummary.retrievalMs).toBe(1235) // fractional → rounded integer
    expect(rec.perfSummary.agentRankingMs).toBe(4501)
    expect(Number.isInteger(rec.perfSummary.pdfDownloadMs)).toBe(true)
    expectLossless(rec) // C: DB success AND tool returns valid JSON
    const pushRow = rt.db.prepare('SELECT status FROM pushes WHERE id = ?').get(pushId) as { status: string }
    expect(pushRow.status).toBe('completed')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
