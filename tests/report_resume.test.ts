/**
 * Canonical report persistence (plugin-owned atomic writer) + deterministic
 * resume (0-LLM finalize) tests.
 *
 * D. canonical report writer succeeds (mkdir + temp + atomic rename);
 * E. writer failure → REPORT_WRITE_FAILED (system error), NOT a HITL action;
 * F. deterministic resume finalizes WITHOUT any LLM call (resume_llm_call_count=0);
 * G. deterministic resume does NOT repeat retrieval/ranking/PDF/fulltext/report;
 * H. resume keeps the original pushId.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.js'
import { createRuntime, type LiteratureRuntime } from '../src/lib/runtime.js'
import { upsertPaper } from '../src/db.js'
import { ensureStage } from '../src/lib/stages.js'
import { startPush } from '../src/lib/history.js'
import { tryDeterministicFinalize } from '../src/lib/resume.js'
import { openUserAction } from '../src/lib/user_actions.js'
import { defineLiteratureReportWrite } from '../src/tools/literature_report_write.js'

function setup(): { rt: LiteratureRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-rep-'))
  const rt = createRuntime(normalizeConfig({ dataDir: dir }))
  return { rt, dir }
}

async function run<T>(tool: { execute: (a: never, e: never) => Promise<T> }, args: unknown): Promise<T> {
  return tool.execute(args as never, { signal: new AbortController().signal } as never)
}

function seedPaper(rt: LiteratureRuntime, paperId: string): void {
  upsertPaper(rt.db, {
    id: paperId, title: 'Report Test Paper', authors: '["T"]', venue: null, year: 2024,
    doi: null, arxiv_id: paperId.replace('arxiv:', ''), openalex_id: null, url: null,
    oa_pdf_url: null, abstract: null, citations: 5, bibtex: null, metadata_source: 'arxiv',
  })
}

/** Fully built push state: selected paper + fulltext ok + canonical report. */
async function buildReadyPush(rt: LiteratureRuntime, pushId: number, paperId: string): Promise<{ reportPath: string }> {
  seedPaper(rt, paperId)
  rt.db
    .prepare(
      `INSERT INTO candidates (push_id, paper_id, rank_hint, picked, stage_relevance_score,
        curriculum_value, selection_outcome, agent_rank, preflight_attempt_order, candidate_pool, is_seen)
       VALUES (?, ?, 1, 0, 0.85, 0.8, 'SELECTED', 1, 1, 'recent', 0)`,
    )
    .run(pushId, paperId)
  rt.db
    .prepare("INSERT INTO fulltexts (paper_id, status, parser, char_count, chunk_count) VALUES (?, 'ok', 'pdftotext', 1000, 8)")
    .run(paperId)
  rt.db
    .prepare('INSERT INTO fulltext_reads (push_id, paper_id, seq) VALUES (?, ?, 0)')
    .run(pushId, paperId)
  const rw = defineLiteratureReportWrite(() => rt)
  const rep = (await run(rw, {
    pushId, stageLabel: '基础控制', filename: 'T_2024_report.md', content: '# 精读报告\n正文',
  })) as { ok: boolean; reportPath: string }
  expect(rep.ok).toBe(true)
  return { reportPath: rep.reportPath }
}

describe('D: canonical report writer (plugin-owned, atomic)', () => {
  it('writes to <dataDir>/reports/<stage>/<file>.md via temp+rename, non-empty', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const rw = defineLiteratureReportWrite(() => rt)
    const out = (await run(rw, {
      pushId, stageLabel: '基础控制', filename: 'Pratt_2001_vmc.md', content: '# VMC\n内容',
    })) as { ok: boolean; reportPath: string; bytes: number }
    expect(out.ok).toBe(true)
    expect(out.reportPath).toContain(join(dir, 'reports', '基础控制'))
    expect(existsSync(out.reportPath)).toBe(true)
    expect(statSync(out.reportPath).size).toBeGreaterThan(0)
    expect(readFileSync(out.reportPath, 'utf8')).toContain('VMC')
    // provenance: pushes.report_path updated
    const row = rt.db.prepare('SELECT report_path FROM pushes WHERE id = ?').get(pushId) as { report_path: string }
    expect(row.report_path).toBe(out.reportPath)
    // no leftover temp files
    const leftovers = readdirOf(join(dir, 'reports', '基础控制')).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('E: report writer failure → REPORT_WRITE_FAILED (never HITL)', () => {
  it('invalid filename → REPORT_WRITE_FAILED with ok=false', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const rw = defineLiteratureReportWrite(() => rt)
    const out = (await run(rw, {
      pushId, stageLabel: '基础控制', filename: 'bad name!.md', content: 'x',
    })) as { ok: boolean; errorCode: string }
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe('REPORT_WRITE_FAILED')
    // the push must NOT be marked as needing user action
    const row = rt.db.prepare('SELECT status FROM pushes WHERE id = ?').get(pushId) as { status: string }
    expect(row.status).toBe('running')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('unwritable target (libraryRoot is a file) → REPORT_WRITE_FAILED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-rep-bad-'))
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'i am a file')
    const rt = createRuntime(normalizeConfig({ dataDir: dir, libraryRoot: blocker }))
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const rw = defineLiteratureReportWrite(() => rt)
    const out = (await run(rw, {
      pushId, stageLabel: '基础控制', filename: 'T.md', content: 'x',
    })) as { ok: boolean; errorCode: string }
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe('REPORT_WRITE_FAILED')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('F/G/H: deterministic resume (0-LLM finalize)', () => {
  it('finalizes a fully-built push without LLM and without repeating steps', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const paperId = 'arxiv:2208.01786'
    await buildReadyPush(rt, pushId, paperId)

    // simulate the resolved user-action history: push parked, action resolved
    const a = openUserAction(rt.db, { pushId, step: 'report', kind: 'user_resource_needed', issue: 'x', whatUserShouldDo: 'y', howToContinue: 'z' })
    rt.db.prepare("UPDATE user_actions SET state = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(a.id)
    rt.db.prepare("UPDATE pushes SET status = 'user_action_required' WHERE id = ?").run(pushId)

    const beforeFetchLog = (rt.db.prepare('SELECT COUNT(*) n FROM fetch_log').get() as { n: number }).n
    const beforeFulltext = (rt.db.prepare('SELECT COUNT(*) n FROM fulltexts').get() as { n: number }).n
    const beforeReads = (rt.db.prepare('SELECT COUNT(*) n FROM fulltext_reads').get() as { n: number }).n

    const res = tryDeterministicFinalize(rt.db, pushId, { now: () => 1_000_000 })
    expect(res.finalized).toBe(true) // F: no LLM involved
    expect(res.resumeLlmCallCount).toBe(0)
    expect(res.resumeMs).toBeGreaterThanOrEqual(0)
    expect(res.pushId).toBe(pushId) // H: same pushId
    expect(res.paperId).toBe(paperId)
    expect(res.reportPath).toBeTruthy()

    // G: no step was repeated — row counts unchanged
    expect((rt.db.prepare('SELECT COUNT(*) n FROM fetch_log').get() as { n: number }).n).toBe(beforeFetchLog)
    expect((rt.db.prepare('SELECT COUNT(*) n FROM fulltexts').get() as { n: number }).n).toBe(beforeFulltext)
    expect((rt.db.prepare('SELECT COUNT(*) n FROM fulltext_reads').get() as { n: number }).n).toBe(beforeReads)

    const row = rt.db.prepare('SELECT status, resume_ms, resume_llm_call_count FROM pushes WHERE id = ?').get(pushId) as {
      status: string
      resume_ms: number
      resume_llm_call_count: number
    }
    expect(row.status).toBe('completed')
    expect(row.resume_llm_call_count).toBe(0)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to finalize while user actions are still open (fallback to agent resume)', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const paperId = 'arxiv:2208.01786'
    await buildReadyPush(rt, pushId, paperId)
    openUserAction(rt.db, { pushId, step: 'fetch_pdf', kind: 'carsi_relogin', issue: 'x', whatUserShouldDo: 'y', howToContinue: 'z' })
    rt.db.prepare("UPDATE pushes SET status = 'user_action_required' WHERE id = ?").run(pushId)
    const res = tryDeterministicFinalize(rt.db, pushId)
    expect(res.finalized).toBe(false)
    expect(res.reason).toMatch(/未解决待办/)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to finalize without a canonical report (report must exist non-empty)', async () => {
    const { rt, dir } = setup()
    ensureStage(rt.db, 'legged_robot_control', 3)
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const paperId = 'arxiv:2208.01786'
    seedPaper(rt, paperId)
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
    rt.db.prepare("UPDATE pushes SET paper_id = ?, status = 'running' WHERE id = ?").run(paperId, pushId)
    const res = tryDeterministicFinalize(rt.db, pushId)
    expect(res.finalized).toBe(false)
    expect(res.reason).toMatch(/报告缺失/)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('already-completed push is not re-finalized', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    rt.db.prepare("UPDATE pushes SET status = 'completed' WHERE id = ?").run(pushId)
    const res = tryDeterministicFinalize(rt.db, pushId)
    expect(res.finalized).toBe(false)
    expect(res.reason).toMatch(/已是 completed/)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

function readdirOf(p: string): string[] {
  return readdirSync(p)
}
