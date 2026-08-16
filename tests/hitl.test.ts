/**
 * Human-in-the-loop (NEED_USER_ACTION) tests:
 * - user_actions lifecycle (open → push parked; resolve → push back to running);
 * - resume-step inference (never re-retrieves/re-scores unless the user's own
 *   topic_decision requires it);
 * - literature_record invariants (user_action_required requires an open
 *   action; AUTH_REQUIRED must never be recorded as fulltext_unavailable);
 * - manual PDF registration (manualPdfPath) + fulltext indexing of PDF_OK;
 * - literature_resume end-to-end with a parked push.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig, type LiteratureConfig } from '../src/config.js'
import { createRuntime, type LiteratureRuntime } from '../src/lib/runtime.js'
import { openDb, upsertPaper } from '../src/db.js'
import { startPush } from '../src/lib/history.js'
import {
  openUserAction,
  resolveUserAction,
  resolveUserActionsByKind,
  openActionsOfPush,
} from '../src/lib/user_actions.js'
import { inferResumeFrom, type ResumeStateSummary } from '../src/tools/literature_resume.js'
import { defineLiteratureFetchPdf } from '../src/tools/literature_fetch_pdf.js'
import { defineLiteratureRecord } from '../src/tools/literature_record.js'
import { defineLiteratureResume } from '../src/tools/literature_resume.js'
import { defineLiteratureUserAction } from '../src/tools/literature_user_action.js'
import { defineLiteratureFulltextIndex } from '../src/tools/literature_fulltext_index.js'

function pdfBytes(n: number): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, n - 8), 0x61)])
}

/** Minimal valid single-page PDF with extractable text (pdftotext-safe). */
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

function setup(): { rt: LiteratureRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-hitl-'))
  const rt = createRuntime(normalizeConfig({ dataDir: dir }))
  return { rt, dir }
}

async function run<T>(tool: { execute: (a: never, e: never) => Promise<T> }, args: unknown): Promise<T> {
  return tool.execute(args as never, { signal: new AbortController().signal } as never)
}

function seedPaper(db: import('../src/db.js').Db, id: string): void {
  upsertPaper(db, {
    id,
    title: 'HITL Test Paper',
    authors: '["T"]',
    venue: null,
    year: 2024,
    doi: '10.1000/hitl',
    arxiv_id: null,
    openalex_id: null,
    url: 'https://publisher.example/article/1',
    oa_pdf_url: null,
    abstract: null,
    citations: 1,
    bibtex: null,
    metadata_source: 'crossref',
  })
}

/* ---------------- user_actions lifecycle ---------------- */

describe('user_actions lifecycle (NEED_USER_ACTION)', () => {
  it('open parks the push; resolve returns it to running', () => {
    const { rt, dir } = setup()
    seedPaper(rt.db, 'doi:10.1000/hitl')
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const row = openUserAction(rt.db, {
      pushId,
      paperId: 'doi:10.1000/hitl',
      step: 'fetch_pdf',
      kind: 'carsi_relogin',
      issue: 'CARSI 机构会话已失效',
      attempts: ['公开源 3 个全失败', 'CARSI 探测返回登录墙'],
      whatUserShouldDo: '运行 dsh-literature-carsi-login 重新登录',
      howToContinue: '重新运行 dsh-literature-push.mjs --resume ' + pushId,
    })
    expect(row.state).toBe('open')
    const push = rt.db.prepare('SELECT status, error_code FROM pushes WHERE id = ?').get(pushId) as {
      status: string
      error_code: string
    }
    expect(push.status).toBe('user_action_required')
    expect(push.error_code).toBe('NEED_USER_ACTION')
    expect(openActionsOfPush(rt.db, pushId)).toHaveLength(1)

    const done = resolveUserAction(rt.db, row.id)
    expect(done?.state).toBe('resolved')
    expect(done?.resolved_at).toBeTruthy()
    const after = rt.db.prepare('SELECT status FROM pushes WHERE id = ?').get(pushId) as { status: string }
    expect(after.status).toBe('running')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('push stays parked while other actions remain open', () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const a1 = openUserAction(rt.db, { pushId, step: 'fetch_pdf', kind: 'carsi_relogin', issue: 'x', whatUserShouldDo: 'y', howToContinue: 'z' })
    const a2 = openUserAction(rt.db, { pushId, step: 'selection', kind: 'version_choice', issue: 'x2', whatUserShouldDo: 'y2', howToContinue: 'z2' })
    resolveUserAction(rt.db, a1.id)
    const push = rt.db.prepare('SELECT status FROM pushes WHERE id = ?').get(pushId) as { status: string }
    expect(push.status).toBe('user_action_required') // a2 still open
    resolveUserAction(rt.db, a2.id)
    expect((rt.db.prepare('SELECT status FROM pushes WHERE id = ?').get(pushId) as { status: string }).status).toBe('running')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolveUserActionsByKind resolves all open actions of a kind (login CLI path)', () => {
    const { rt, dir } = setup()
    const p1 = startPush(rt.db, 'topic_a', 1).pushId
    const p2 = startPush(rt.db, 'topic_b', 1).pushId
    openUserAction(rt.db, { pushId: p1, step: 'fetch_pdf', kind: 'carsi_relogin', issue: 'a', whatUserShouldDo: 'b', howToContinue: 'c' })
    openUserAction(rt.db, { pushId: p2, step: 'fetch_pdf', kind: 'carsi_relogin', issue: 'a', whatUserShouldDo: 'b', howToContinue: 'c' })
    openUserAction(rt.db, { pushId: p1, step: 'selection', kind: 'version_choice', issue: 'a', whatUserShouldDo: 'b', howToContinue: 'c' })
    const n = resolveUserActionsByKind(rt.db, 'carsi_relogin')
    expect(n).toBe(2)
    expect(openActionsOfPush(rt.db, p1)).toHaveLength(1) // version_choice remains
    expect(openActionsOfPush(rt.db, p2)).toHaveLength(0)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to park a terminal push', () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    rt.db.prepare("UPDATE pushes SET status = 'completed' WHERE id = ?").run(pushId)
    expect(() =>
      openUserAction(rt.db, { pushId, step: 'fetch_pdf', kind: 'carsi_relogin', issue: 'a', whatUserShouldDo: 'b', howToContinue: 'c' }),
    ).toThrow(/不能停车/)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- resume-step inference ---------------- */

describe('inferResumeFrom (continue from original step, no re-retrieval)', () => {
  const base: ResumeStateSummary = {
    status: 'running',
    openKinds: [],
    manualPdfRegistered: false,
    reportPath: null,
    fulltextOk: false,
    anyPdfOk: false,
    anyFetchLog: false,
    scoredCandidates: false,
  }
  it('open carsi_relogin / version_choice → fetch_pdf', () => {
    expect(inferResumeFrom({ ...base, openKinds: ['carsi_relogin'] })).toBe('fetch_pdf')
    expect(inferResumeFrom({ ...base, openKinds: ['version_choice'] })).toBe('fetch_pdf')
  })
  it('open manual_pdf → fetch_pdf until the PDF is registered, then fulltext_index', () => {
    expect(inferResumeFrom({ ...base, openKinds: ['manual_pdf'] })).toBe('fetch_pdf')
    expect(inferResumeFrom({ ...base, openKinds: ['manual_pdf'], manualPdfRegistered: true })).toBe('fulltext_index')
  })
  it('open topic_decision → sources (user-driven re-retrieval is NOT blind retry)', () => {
    expect(inferResumeFrom({ ...base, openKinds: ['topic_decision'] })).toBe('sources')
  })
  it('resolved user_action_required/auth_required → fetch_pdf', () => {
    expect(inferResumeFrom({ ...base, status: 'user_action_required' })).toBe('fetch_pdf')
    expect(inferResumeFrom({ ...base, status: 'auth_required' })).toBe('fetch_pdf')
  })
  it('a resolved action continues from its parked step (no re-retrieval)', () => {
    expect(inferResumeFrom({ ...base, status: 'running', resolvedStep: 'fetch_pdf', resolvedKind: 'carsi_relogin' })).toBe('fetch_pdf')
    expect(inferResumeFrom({ ...base, status: 'running', resolvedStep: 'selection', resolvedKind: 'version_choice' })).toBe('selection')
    expect(inferResumeFrom({ ...base, status: 'running', resolvedStep: 'fetch_pdf', resolvedKind: 'topic_decision' })).toBe('sources')
    expect(inferResumeFrom({ ...base, status: 'running', resolvedStep: 'fetch_pdf', resolvedKind: 'manual_pdf' })).toBe('fetch_pdf')
    expect(inferResumeFrom({ ...base, status: 'running', resolvedStep: 'fetch_pdf', resolvedKind: 'manual_pdf', manualPdfRegistered: true })).toBe('fulltext_index')
  })
  it('interrupted running push continues from the deepest completed step', () => {
    expect(inferResumeFrom({ ...base })).toBe('sources')
    expect(inferResumeFrom({ ...base, scoredCandidates: true })).toBe('selection')
    expect(inferResumeFrom({ ...base, anyFetchLog: true, scoredCandidates: true })).toBe('fetch_pdf')
    expect(inferResumeFrom({ ...base, anyPdfOk: true, anyFetchLog: true })).toBe('fulltext_index')
    expect(inferResumeFrom({ ...base, fulltextOk: true, anyPdfOk: true })).toBe('report')
    expect(inferResumeFrom({ ...base, reportPath: '/r.md', fulltextOk: true })).toBe('record')
  })
  it('terminal statuses → null (nothing to resume)', () => {
    for (const s of ['completed', 'failed', 'no_candidate', 'fulltext_unavailable']) {
      expect(inferResumeFrom({ ...base, status: s })).toBeNull()
    }
  })
})

/* ---------------- record invariants ---------------- */

describe('literature_record NEED_USER_ACTION invariants', () => {
  it('rejects user_action_required without a registered open action', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    await expect(
      run(recordTool, { pushId, status: 'user_action_required', errorCode: 'AUTH_REQUIRED' }),
    ).rejects.toThrow(/literature_user_action/)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts user_action_required after openUserAction; AUTH_REQUIRED never fulltext_unavailable', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    openUserAction(rt.db, { pushId, step: 'fetch_pdf', kind: 'carsi_relogin', issue: '会话失效', whatUserShouldDo: '重新登录', howToContinue: '--resume' })
    const recordTool = defineLiteratureRecord(() => rt, () => null)
    const out = await run(recordTool, { pushId, status: 'user_action_required', errorCode: 'AUTH_REQUIRED' })
    expect(out.status).toBe('user_action_required')
    const row = rt.db.prepare('SELECT status, error_code FROM pushes WHERE id = ?').get(pushId) as {
      status: string
      error_code: string
    }
    expect(row.status).toBe('user_action_required')
    expect(row.error_code).toBe('AUTH_REQUIRED')
    // misrecording as fulltext_unavailable must be rejected
    const other = startPush(rt.db, 'legged_robot_control', 1).pushId
    await expect(
      run(recordTool, {
        pushId: other,
        status: 'fulltext_unavailable',
        errorCode: 'AUTH_REQUIRED',
        selection: [{ paperId: 'doi:10.1000/hitl', agentRank: 1, attemptOrder: 1, outcome: 'FULLTEXT_UNAVAILABLE' }],
      }),
    ).rejects.toThrow(/auth_required|user_action_required/)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- manual PDF + PDF_OK indexing ---------------- */

describe('manual PDF registration (HITL download channel)', () => {
  it('literature_fetch_pdf(manualPdfPath) validates, hashes and registers the PDF', async () => {
    const { rt, dir } = setup()
    seedPaper(rt.db, 'doi:10.1000/hitl')
    const src = join(dir, 'user-download.pdf')
    writeFileSync(src, makePdf('Abstract We propose a whole-body MPC controller. ' + 'padding padding padding padding padding padding '.repeat(600)))
    const fetchTool = defineLiteratureFetchPdf(() => rt)
    const res = await run(fetchTool, { paperId: 'doi:10.1000/hitl', pushId: 0, manualPdfPath: src })
    expect(res.outcome).toBe('PDF_OK')
    expect(res.sha256).toHaveLength(64)
    expect(res.pdfSource).toMatch(/^manual:/)
    expect(res.isOpenAccess).toBe(false)
    expect(existsSync(res.pdfPath!)).toBe(true)
    const log = rt.db.prepare('SELECT outcome, pdf_source, is_open_access FROM fetch_log').get() as {
      outcome: string
      pdf_source: string
      is_open_access: number
    }
    expect(log.outcome).toBe('PDF_OK')
    expect(log.is_open_access).toBe(0)

    // regression fix: fulltext index must accept PDF_OK (CARSI/manual) rows
    const indexTool = defineLiteratureFulltextIndex(() => rt)
    const idx = await run(indexTool, { paperId: 'doi:10.1000/hitl' })
    expect(idx.status).toBe('ok')
    expect(idx.chunks.length).toBeGreaterThan(0)
    expect(idx.parser).toMatch(/^pdftotext/)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a non-PDF manual file', async () => {
    const { rt, dir } = setup()
    seedPaper(rt.db, 'doi:10.1000/hitl')
    const src = join(dir, 'login.html')
    writeFileSync(src, '<html><body>please sign in</body></html>')
    const fetchTool = defineLiteratureFetchPdf(() => rt)
    const res = await run(fetchTool, { paperId: 'doi:10.1000/hitl', manualPdfPath: src })
    expect(res.outcome).toBe('failed')
    expect(res.attempts[0]!.status).toBe('not_pdf')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- literature_resume end-to-end ---------------- */

describe('literature_resume (continue parked push without re-retrieval)', () => {
  it('reports the open action (five parts) and resumes from fetch_pdf', async () => {
    const { rt, dir } = setup()
    seedPaper(rt.db, 'doi:10.1000/hitl')
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    rt.db
      .prepare(
        `INSERT INTO candidates (push_id, paper_id, rank_hint, final_score, candidate_pool)
         VALUES (?, 'doi:10.1000/hitl', 1, 0.9, 'recent')`,
      )
      .run(pushId)
    const uaTool = defineLiteratureUserAction(() => rt)
    const opened = await run(uaTool, {
      action: 'open',
      pushId,
      step: 'fetch_pdf',
      kind: 'carsi_relogin',
      paperId: 'doi:10.1000/hitl',
      issue: 'CARSI 机构会话已失效',
      attempts: ['公开源 3 个全失败'],
      whatUserShouldDo: '运行 dsh-literature-carsi-login 重新登录',
      howToContinue: `重新运行 dsh-literature-push.mjs --resume ${pushId}`,
    })
    expect(opened.state).toBe('open')

    const resumeTool = defineLiteratureResume(() => rt)
    const res = await run(resumeTool, { pushId })
    expect(res.status).toBe('user_action_required')
    expect(res.candidatesCount).toBe(1)
    expect(res.scoredCount).toBe(1)
    expect(res.openActions).toHaveLength(1)
    expect(res.openActions[0]!.issue).toContain('CARSI')
    expect(res.openActions[0]!.whatUserShouldDo).toContain('carsi-login')
    expect(res.resumeFrom).toBe('fetch_pdf')
    expect(res.instructions.join(' ')).toContain('不要重新运行 literature_sources')

    // user logs in → resolve → resume now continues
    await run(uaTool, { action: 'resolve', pushId, actionId: opened.actionId })
    const res2 = await run(resumeTool, { pushId })
    expect(res2.status).toBe('running')
    expect(res2.openActions).toHaveLength(0)
    expect(res2.resumeFrom).toBe('fetch_pdf')
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses nothing: terminal push → canResume=false', async () => {
    const { rt, dir } = setup()
    const pushId = startPush(rt.db, 'legged_robot_control', 1).pushId
    rt.db
      .prepare("UPDATE pushes SET status = 'completed', finished_at = datetime('now') WHERE id = ?")
      .run(pushId)
    const resumeTool = defineLiteratureResume(() => rt)
    const res = await run(resumeTool, { pushId })
    expect(res.canResume).toBe(false)
    expect(res.resumeFrom).toBeUndefined()
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/* ---------------- fresh-db migration sanity ---------------- */

describe('v8 schema', () => {
  it('exposes user_actions and the extended push status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-v8-'))
    const db = openDb(dir)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(12)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain('user_actions')
    // CHECK constraint accepts the new status
    db.prepare("INSERT INTO pushes (topic, status) VALUES ('t', 'user_action_required')").run()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
