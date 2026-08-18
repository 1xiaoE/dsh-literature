/**
 * UI adapter tests: the presentation layer reads the EXISTING schema through
 * the same openDb/migrate path the tools use — no new database, no fake
 * columns. Each test seeds a temp DB with real tables and asserts the wire
 * shapes the Harness UI consumes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, upsertPaper, type Db } from '../src/db.js'
import { resolvePaperFields } from '../src/lib/research_fields.js'
import {
  formatRunnerFailure,
  getDashboard,
  getPaperDetail,
  getPushStatus,
  latestRunnerLog,
  listCategories,
  listPapers,
  pushCliArgs,
  resumeCliArgs,
  runCli,
  runnerChildEnv,
} from '../src/ui/adapter.js'
import { defaultConfig } from '../src/config.js'
import * as uiAdapter from '../src/ui/adapter.js'

interface TempDb {
  db: Db
  dir: string
}

function tempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-ui-'))
  const db = openDb(dir)
  return { db, dir }
}

function close(t: TempDb): void {
  t.db.close()
  rmSync(t.dir, { recursive: true, force: true })
}

/** Seed one paper row (matching db.upsertPaper's column contract). */
function seedPaper(db: Db, id: string, title: string, year: number | null, venue: string | null): void {
  upsertPaper(db, {
    id,
    title,
    authors: JSON.stringify([`Author of ${id}`]),
    venue,
    year,
    doi: null,
    arxiv_id: null,
    openalex_id: null,
    url: null,
    oa_pdf_url: null,
    abstract: year !== null ? `Abstract of ${title}.` : null,
    citations: year !== null ? year * 10 : null,
    bibtex: null,
    metadata_source: 'test',
  })
}

/** Seed a push + a candidate row referencing a paper. */
function seedPush(db: Db, id: number, topic: string, status: string): void {
  db.prepare(
    `INSERT INTO pushes (id, topic, stage, status, started_at, raw_candidates, deterministic_candidates, agent_scored_candidates)
     VALUES (?, ?, 1, ?, datetime('now'), ?, ?, ?)`,
  ).run(id, topic, status, 12, 12, 12)
}

function seedCandidate(db: Db, pushId: number, paperId: string, agentRank: number | null, outcome: string | null): void {
  db.prepare(
    `INSERT INTO candidates (push_id, paper_id, agent_rank, final_score, selection_outcome, acquisition_outcome, candidate_pool)
     VALUES (?, ?, ?, ?, ?, ?, 'recent')`,
  ).run(pushId, paperId, agentRank, agentRank !== null ? agentRank / 10 : null, outcome === 'SELECTED' ? 'SELECTED' : null, outcome)
}

describe('ui adapter — papers', () => {
  it('lists paper summaries with agent data and workflow flags', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'arxiv:2401.001', 'Quadruped Locomotion Control', 2024, 'IROS')
      seedPaper(t.db, 'arxiv:2301.002', 'Agricultural Robot Harvesting', 2023, 'ICRA')
      seedPush(t.db, 1, '足式机器人控制', 'completed')
      seedCandidate(t.db, 1, 'arxiv:2401.001', 1, 'SELECTED')
      const pdfPath = join(t.dir, 'paper.pdf')
      writeFileSync(pdfPath, '%PDF-1.4 test')
      t.db.prepare(
        `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, access_type, is_open_access)
         VALUES (?, '[]', 'PDF_OK', ?, 'oa', 1)`,
      ).run('arxiv:2401.001', pdfPath)
      t.db.prepare(`INSERT INTO fulltext_reads (paper_id, seq) VALUES (?, 0)`).run('arxiv:2401.001')

      const all = listPapers(t.db)
      expect(all).toHaveLength(2)
      const first = all.find((p) => p.id === 'arxiv:2401.001')!
      expect(first.title).toBe('Quadruped Locomotion Control')
      expect(first.authors).toEqual(['Author of arxiv:2401.001'])
      expect(first.year).toBe(2024)
      expect(first.venue).toBe('IROS')
      expect(first.agentRank).toBe(1)
      expect(first.finalScore).toBeCloseTo(0.1)
      expect(first.selected).toBe(true)
      expect(first.hasPdf).toBe(true)
      expect(first.readCount).toBe(1)
      expect(first.topic).toBe('足式机器人控制')
      expect(first.isLibrary).toBe(true)

      const selected = listPapers(t.db, { category: 'selected' })
      expect(selected.map((p) => p.id)).toEqual(['arxiv:2401.001'])
      const read = listPapers(t.db, { category: 'read' })
      expect(read).toHaveLength(1)
      // Retrieved-only paper (no library content): it is NOT auto-classified
      // and therefore does NOT appear under its research field filter.
      const agricultural = listCategories(t.db).find((category) => category.labelEn === 'Agricultural Robotics')!
      expect(agricultural.count).toBe(0)
      expect(listPapers(t.db, { category: agricultural.id })).toEqual([])
    } finally {
      close(t)
    }
  })

  it('returns favorites only for papers flagged is_favorite (real schema column)', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'arxiv:2401.001', 'Some Paper', 2024, null)
      expect(listPapers(t.db, { category: 'favorites' })).toEqual([])
      t.db.prepare('UPDATE papers SET is_favorite = 1 WHERE id = ?').run('arxiv:2401.001')
      const favs = listPapers(t.db, { category: 'favorites' })
      expect(favs.map((paper) => paper.id)).toEqual(['arxiv:2401.001'])
      expect(favs[0]!.favorite).toBe(true)
      expect(favs[0]!.isLibrary).toBe(true)
    } finally {
      close(t)
    }
  })

  it('does not advertise PDF or report files that do not exist', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'doi:missing-assets', 'Missing Assets', 2025, null)
      seedPush(t.db, 2, 'control', 'completed')
      seedCandidate(t.db, 2, 'doi:missing-assets', 1, 'SELECTED')
      t.db.prepare(
        `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path)
         VALUES (?, '[]', 'PDF_OK', ?)`,
      ).run('doi:missing-assets', join(t.dir, 'missing.pdf'))
      t.db.prepare(`UPDATE pushes SET paper_id = ?, report_path = ? WHERE id = 2`).run(
        'doi:missing-assets',
        join(t.dir, 'missing.md'),
      )

      const summary = listPapers(t.db).find((paper) => paper.id === 'doi:missing-assets')!
      const detail = getPaperDetail(t.db, 'doi:missing-assets')!
      expect(summary.hasPdf).toBe(false)
      expect(summary.reportCount).toBe(0)
      expect(detail.pdfPath).toBeNull()
      expect(detail.reportPath).toBeNull()
      expect(listPapers(t.db, { category: 'reports' })).toEqual([])
    } finally {
      close(t)
    }
  })

  it('orders selected and report filters by their latest real workflow event', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'paper:old', 'Old Event', 2026, null)
      seedPaper(t.db, 'paper:new', 'New Event', 2020, null)
      seedPush(t.db, 1, 'control', 'completed')
      seedPush(t.db, 2, 'control', 'completed')
      seedCandidate(t.db, 1, 'paper:old', 1, 'SELECTED')
      seedCandidate(t.db, 2, 'paper:new', 1, 'SELECTED')
      const oldReport = join(t.dir, 'old.md')
      const newReport = join(t.dir, 'new.md')
      writeFileSync(oldReport, '# old')
      writeFileSync(newReport, '# new')
      t.db.prepare(`UPDATE pushes SET paper_id = 'paper:old', report_path = ? WHERE id = 1`).run(oldReport)
      t.db.prepare(`UPDATE pushes SET paper_id = 'paper:new', report_path = ? WHERE id = 2`).run(newReport)

      expect(listPapers(t.db, { category: 'selected' }).map((paper) => paper.id)).toEqual(['paper:new', 'paper:old'])
      expect(listPapers(t.db, { category: 'reports' }).map((paper) => paper.id)).toEqual(['paper:new', 'paper:old'])
    } finally {
      close(t)
    }
  })

  it('uses the newest usable PDF and report when a newer recorded path is stale', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'paper:asset-history', 'Asset History', 2026, null)
      const validPdf = join(t.dir, 'valid.pdf')
      const validReport = join(t.dir, 'valid.md')
      writeFileSync(validPdf, '%PDF-1.4 valid')
      writeFileSync(validReport, '# valid report')
      t.db.prepare(
        `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source)
         VALUES ('paper:asset-history', '[]', 'PDF_OK', ?, 'valid-source')`,
      ).run(validPdf)
      t.db.prepare(
        `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_path, pdf_source)
         VALUES ('paper:asset-history', '[]', 'PDF_OK', ?, 'stale-source')`,
      ).run(join(t.dir, 'stale.pdf'))
      seedPush(t.db, 1, 'control', 'completed')
      seedPush(t.db, 2, 'control', 'completed')
      t.db.prepare(`UPDATE pushes SET paper_id = 'paper:asset-history', report_path = ? WHERE id = 1`).run(validReport)
      t.db.prepare(`UPDATE pushes SET paper_id = 'paper:asset-history', report_path = ? WHERE id = 2`).run(join(t.dir, 'stale.md'))

      const summary = listPapers(t.db).find((paper) => paper.id === 'paper:asset-history')!
      const detail = getPaperDetail(t.db, 'paper:asset-history')!
      expect(summary.hasPdf).toBe(true)
      expect(summary.reportCount).toBe(1)
      expect(listPapers(t.db, { category: 'reports' }).map((paper) => paper.id)).toContain('paper:asset-history')
      expect(detail.pdfPath).toBe(validPdf)
      expect(detail.pdfSource).toBe('valid-source')
      expect(detail.reportPath).toBe(validReport)
      expect(detail.hasPdf).toBe(true)
      expect(detail.reportCount).toBe(1)
    } finally {
      close(t)
    }
  })
})

describe('ui adapter — categories & dashboard', () => {
  it('counts all papers beyond the 500-row list display cap', () => {
    const t = tempDb()
    try {
      for (let i = 0; i < 501; i += 1) seedPaper(t.db, `paper:${i}`, `Paper ${i}`, 2026, null)
      const all = listCategories(t.db).find((category) => category.id === 'all')
      expect(all?.count).toBe(501)
    } finally {
      close(t)
    }
  })

  it('exposes workflow, persisted research fields and workflow topics with counts', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'arxiv:2401.001', 'Quadruped Locomotion Control', 2024, 'IROS')
      seedPaper(t.db, 'arxiv:2301.002', 'Agricultural Robot Harvesting', 2023, 'ICRA')
      seedPush(t.db, 1, '足式机器人控制', 'completed')
      seedCandidate(t.db, 1, 'arxiv:2401.001', 1, 'SELECTED')
      // The agricultural paper is only retrieved (candidate pool) — it must
      // NOT appear in Research Fields. Promote the quadruped paper into its
      // field via manual category so it shows up as a library paper.
      resolvePaperFields(t.db, 'arxiv:2401.001')

      const categories = listCategories(t.db)
      const ids = categories.map((c) => c.id)
      expect(ids).toContain('all')
      expect(ids).toContain('selected')
      const robotics = categories.find((category) => category.kind === 'field' && category.labelEn === 'Robotics')!
      const agricultural = categories.find((category) => category.kind === 'field' && category.labelEn === 'Agricultural Robotics')!
      expect(robotics.id).toMatch(/^field:/)
      // Retrieved-only paper never counts toward Research Fields.
      expect(agricultural.count).toBe(0)
      expect(ids).toContain('topic:足式机器人控制')
      const all = categories.find((c) => c.id === 'all')!
      expect(all.count).toBe(2)
      const topic = categories.find((c) => c.id === 'topic:足式机器人控制')!
      expect(topic.count).toBe(1)
      expect(listPapers(t.db, { category: robotics.id }).map((paper) => paper.id)).toContain('arxiv:2401.001')

      const dash = getDashboard(t.db)
      expect(dash.paperCount).toBe(2)
      expect(dash.libraryCount).toBe(1)
      expect(dash.pushCount).toBe(1)
      expect(dash.latestPush).toEqual({ id: 1, status: 'completed', topic: '足式机器人控制' })
      expect(dash.stages).toEqual([])
    } finally {
      close(t)
    }
  })
})

describe('ui adapter — paper detail', () => {
  it('maps real columns and leaves missing agent fields as null', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'doi:10.1177/x', 'Virtual Model Control', 2001, 'IJRR')
      seedPush(t.db, 1, '足式机器人控制', 'completed')
      seedCandidate(t.db, 1, 'doi:10.1177/x', 2, 'AUTH_REQUIRED')
      t.db.prepare(
        `INSERT INTO fetch_log (paper_id, attempts, outcome, pdf_source, access_type, is_open_access)
         VALUES (?, '[]', 'AUTH_REQUIRED', 'publisher_browser', 'institutional', 0)`,
      ).run('doi:10.1177/x')

      const detail = getPaperDetail(t.db, 'doi:10.1177/x')
      expect(detail).not.toBeNull()
      expect(detail!.title).toBe('Virtual Model Control')
      expect(detail!.agentRank).toBe(2)
      expect(detail!.acquisitionOutcome).toBe('AUTH_REQUIRED')
      expect(detail!.pdfSource).toBe('publisher_browser')
      expect(detail!.accessType).toBe('institutional')
      expect(detail!.isOpenAccess).toBe(false)
      expect(detail!.fulltextStatus).toBeNull()
      expect(detail!.reportPath).toBeNull()
      expect(detail!.stage).toBe(1)

      expect(getPaperDetail(t.db, 'missing')).toBeNull()
    } finally {
      close(t)
    }
  })
})

describe('ui adapter — push status (Execution panel)', () => {
  it('reports idle when no push exists', () => {
    const t = tempDb()
    try {
      const status = getPushStatus(t.db, defaultConfig())
      expect(status.present).toBe(false)
      expect(status.phase).toBe('idle')
      expect(status.pushId).toBeNull()
    } finally {
      close(t)
    }
  })

  it('derives retrieving / ranking / acquiring phases from persisted columns', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'arxiv:2401.001', 'Some Paper', 2024, null)
      // Running push, nothing scored yet → retrieving
      seedPush(t.db, 5, '足式机器人控制', 'running')
      const retrieving = getPushStatus(t.db, defaultConfig())
      expect(retrieving.phase).toBe('retrieving')
      expect(retrieving.pushId).toBe(5)
      expect(retrieving.running).toBe(true)

      // Retrieval provenance lines
      t.db.prepare(
        `INSERT INTO retrievals (push_id, paper_id, generated_query, source_adapter, candidate_pool)
         VALUES (5, 'arxiv:2401.001', 'q', 'OpenAlex', 'recent')`,
      ).run()
      const withLines = getPushStatus(t.db)
      expect(withLines.retrieving.map((r) => r.source)).toContain('OpenAlex')

      // Scored → ranking (agent_ranking_ms null)
      t.db.prepare(
        `UPDATE pushes SET retrieval_ms = 500, agent_scored_candidates = 15, deterministic_candidates = 15, raw_candidates = 40 WHERE id = 5`,
      ).run()
      const ranking = getPushStatus(t.db)
      expect(ranking.phase).toBe('ranking')
      expect(ranking.candidatesRanked).toBe(15)

      // Ranking done, no reads yet → acquiring with acquisition trace
      t.db.prepare(`UPDATE pushes SET agent_ranking_ms = 900 WHERE id = 5`).run()
      seedCandidate(t.db, 5, 'arxiv:2401.001', 1, 'AUTH_REQUIRED')
      const acquiring = getPushStatus(t.db)
      expect(acquiring.phase).toBe('acquiring')
      expect(acquiring.acquisition[0]!.agentRank).toBe(1)
      expect(acquiring.acquisition[0]!.outcome).toBe('AUTH_REQUIRED')
    } finally {
      close(t)
    }
  })

  it('derives live ranking, acquisition, reading and report progress from workflow tables before final perf flush', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'paper:live', 'Live Workflow Paper', 2026, null)
      seedPush(t.db, 20, 'control', 'running')
      t.db.prepare(`UPDATE pushes SET raw_candidates = NULL, deterministic_candidates = NULL, agent_scored_candidates = NULL WHERE id = 20`).run()
      expect(getPushStatus(t.db).phase).toBe('retrieving')

      t.db.prepare(
        `INSERT INTO retrievals (push_id, paper_id, generated_query, source_adapter, candidate_pool)
         VALUES (20, 'paper:live', 'q', 'OpenAlex', 'recent')`,
      ).run()
      t.db.prepare(
        `INSERT INTO candidates (push_id, paper_id, rank_hint, candidate_pool)
         VALUES (20, 'paper:live', 1, 'recent')`,
      ).run()
      const ranking = getPushStatus(t.db)
      expect(ranking.phase).toBe('ranking')
      expect(ranking.retrievedPapers).toBe(1)

      t.db.prepare(`UPDATE candidates SET agent_rank = 1, final_score = 0.9 WHERE push_id = 20`).run()
      const acquisition = getPushStatus(t.db)
      expect(acquisition.phase).toBe('acquiring')
      expect(acquisition.candidatesRanked).toBe(1)

      t.db.prepare(`UPDATE candidates SET selection_outcome = 'SELECTED', acquisition_outcome = 'SELECTED' WHERE push_id = 20`).run()
      t.db.prepare(`INSERT INTO fulltexts (paper_id, status, chunk_count) VALUES ('paper:live', 'ok', 3)`).run()
      t.db.prepare(`INSERT INTO fulltext_reads (push_id, paper_id, seq) VALUES (20, 'paper:live', 0)`).run()
      const reading = getPushStatus(t.db)
      expect(reading.phase).toBe('reading')
      expect(reading.reading).toEqual({ totalChunks: 3, readChunks: 1, coverage: 1 / 3 })

      t.db.prepare(`UPDATE pushes SET report_path = '/persisted/report.md' WHERE id = 20`).run()
      expect(getPushStatus(t.db).phase).toBe('reporting')
    } finally {
      close(t)
    }
  })

  it('surfaces auth_required with the open user action (HITL five-part)', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'arxiv:2401.001', 'Some Paper', 2024, null)
      seedPush(t.db, 9, '足式机器人控制', 'auth_required')
      t.db.prepare(
        `INSERT INTO user_actions (push_id, paper_id, step, kind, state, issue, attempts, what_user_should_do, how_to_continue)
         VALUES (9, 'arxiv:2401.001', 'fetch_pdf', 'user_resource_needed', 'open',
                 'IEEE login wall', '["unpaywall","publisher_browser"]', 'Log in at IEEE', 'resume push 9')`,
      ).run()

      const status = getPushStatus(t.db, defaultConfig())
      expect(status.phase).toBe('auth_required')
      expect(status.authRequired).not.toBeNull()
      expect(status.authRequired!.paperTitle).toBe('Some Paper')
      expect(status.authRequired!.reason).toBe('IEEE login wall')
      expect(status.authRequired!.nextStep).toBe('Log in at IEEE')
      expect(status.authRequired!.actions).toHaveLength(1)
      expect(status.authRequired!.actions[0]!.attempts).toEqual(['unpaywall', 'publisher_browser'])
      expect(status.authRequired!.actions[0]!.howToContinue).toBe('resume push 9')
    } finally {
      close(t)
    }
  })

  it('reports the rank of the exact paper blocked by AUTH_REQUIRED', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'paper:rank-1', 'Rank One', 2026, null)
      seedPaper(t.db, 'paper:rank-2', 'Rank Two', 2026, null)
      seedPush(t.db, 30, 'control', 'auth_required')
      seedCandidate(t.db, 30, 'paper:rank-1', 1, 'ACCESS_DENIED')
      seedCandidate(t.db, 30, 'paper:rank-2', 2, 'AUTH_REQUIRED')
      t.db.prepare(
        `INSERT INTO user_actions (push_id, paper_id, step, kind, state, issue, what_user_should_do, how_to_continue)
         VALUES (30, 'paper:rank-2', 'fetch_pdf', 'user_resource_needed', 'open', 'login', 'Sign in', 'Resume 30')`,
      ).run()

      const auth = getPushStatus(t.db).authRequired!
      expect(auth.paperTitle).toBe('Rank Two')
      expect(auth.rank).toBe(2)
      expect(auth.nextStep).toBe('Sign in')
    } finally {
      close(t)
    }
  })

  it('maps completed and failed terminal states', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'arxiv:2401.001', 'Some Paper', 2024, null)
      seedPush(t.db, 10, '足式机器人控制', 'completed')
      t.db.prepare(`UPDATE pushes SET total_chunks = 10, read_chunks = 10, read_coverage = 1.0 WHERE id = 10`).run()
      const done = getPushStatus(t.db)
      expect(done.phase).toBe('completed')
      expect(done.reading.coverage).toBe(1.0)

      t.db.prepare(
        `INSERT INTO pushes (id, topic, stage, status, started_at, error_code, error_detail)
         VALUES (11, '足式机器人控制', 1, 'failed', datetime('now'), 'PDF_FAILED', 'no pdf')`,
      ).run()
      const failed = getPushStatus(t.db)
      expect(failed.phase).toBe('failed')
      expect(failed.errorCode).toBe('PDF_FAILED')
    } finally {
      close(t)
    }
  })
})

describe('ui adapter — workflow launchers', () => {
  it('rejects a new run while the latest push is active or parked for user action', () => {
    const guard = (uiAdapter as typeof uiAdapter & {
      workflowAlreadyRunning?: (db: Db) => boolean
    }).workflowAlreadyRunning
    const t = tempDb()
    try {
      expect(guard?.(t.db)).toBe(false)
      seedPush(t.db, 1, 'control', 'running')
      expect(guard?.(t.db)).toBe(true)
      t.db.prepare(`UPDATE pushes SET status = 'auth_required' WHERE id = 1`).run()
      expect(guard?.(t.db)).toBe(true)
      t.db.prepare(`UPDATE pushes SET status = 'user_action_required' WHERE id = 1`).run()
      expect(guard?.(t.db)).toBe(true)
      t.db.prepare(`UPDATE pushes SET status = 'completed' WHERE id = 1`).run()
      expect(guard?.(t.db)).toBe(false)
    } finally {
      close(t)
    }
  })

  it('allows resume only for the parked push with a real open user action', () => {
    const canResume = (uiAdapter as typeof uiAdapter & {
      canResumePush?: (db: Db, pushId: number) => boolean
    }).canResumePush
    const t = tempDb()
    try {
      seedPush(t.db, 7, 'control', 'auth_required')
      expect(canResume?.(t.db, 7)).toBe(false)
      t.db.prepare(
        `INSERT INTO user_actions (push_id, step, kind, state, issue, what_user_should_do, how_to_continue)
         VALUES (7, 'fetch_pdf', 'user_resource_needed', 'open', 'login', 'log in', 'resume')`,
      ).run()
      expect(canResume?.(t.db, 7)).toBe(true)
      seedPush(t.db, 8, 'control', 'completed')
      expect(canResume?.(t.db, 7)).toBe(false)
      t.db.prepare(`DELETE FROM pushes WHERE id = 8`).run()
      t.db.prepare(`UPDATE user_actions SET state = 'resolved' WHERE push_id = 7`).run()
      expect(canResume?.(t.db, 7)).toBe(false)
    } finally {
      close(t)
    }
  })

  it('builds the existing CLI argv (custom keyword enters as --topic)', () => {
    expect(pushCliArgs('')).toEqual([])
    expect(pushCliArgs('MPC')).toEqual(['--topic', 'MPC'])
    expect(pushCliArgs('  robust control  ')).toEqual(['--topic', 'robust control'])
  })

  it('maps resume to --resume <pushId>', () => {
    expect(resumeCliArgs(9)).toEqual(['--resume', '9'])
  })
})

describe('ui adapter — runner launch (log capture + early-exit detection)', () => {
  it('formats runner failures with the log tail', () => {
    expect(formatRunnerFailure(3, null, 'boom early\nmore')).toContain('exit code 3')
    expect(formatRunnerFailure(3, null, 'boom early\nmore')).toContain('boom early')
    expect(formatRunnerFailure(null, 'SIGTERM', '')).toContain('signal SIGTERM')
  })

  it('returns ok=false with stderr tail when the runner dies inside the grace window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-run-'))
    try {
      const result = await runCli(process.execPath, ['-e', "console.error('BOOT_FAIL'); process.exit(3)"], {
        logDir: join(dir, 'runs'),
        graceMs: 3000,
      })
      expect(result.ok).toBe(false)
      expect(result.message).toContain('exit code 3')
      expect(result.message).toContain('BOOT_FAIL')
      expect(result.logPath).toBeTruthy()
      expect(latestRunnerLog({ dataDir: dir } as never)).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports started while the runner is still alive after the grace window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-run-'))
    try {
      const result = await runCli(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        logDir: dir,
        graceMs: 1200,
      })
      expect(result.ok).toBe(true)
      expect(typeof result.pid).toBe('number')
      if (result.pid !== null && result.pid !== undefined) {
        try { process.kill(result.pid) } catch { /* already gone */ }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)

  it('latestRunnerLog returns null before any run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-run-'))
    try {
      expect(latestRunnerLog({ dataDir: dir } as never)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects the double-launch guard flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-run-'))
    try {
      const flag = { active: false }
      // First launch occupies the flag for the grace window.
      const first = runCli(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { logDir: dir, graceMs: 1500, flag })
      const second = await runCli(process.execPath, ['-e', 'process.exit(0)'], { logDir: dir, graceMs: 500, flag })
      expect(second.ok).toBe(false)
      expect(second.errorCode).toBe('WORKFLOW_ALREADY_RUNNING')
      const firstResult = await first
      expect(firstResult.ok).toBe(true)
      if (firstResult.pid !== null && firstResult.pid !== undefined) {
        try { process.kill(firstResult.pid) } catch { /* already gone */ }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})

describe('ui adapter — runner env scrub and spawn failure detail', () => {
  it('drops harness-internal DSH_* and credential-shaped keys, allowlists OPENALEX_API_KEY', () => {
    const env = runnerChildEnv({
      DSH_SESSION_ID: 'session-1',
      DSH_WEB_URL: 'http://127.0.0.1:3080',
      OPENALEX_API_KEY: 'sk-live-123',
      MY_SECRET_TOKEN: 'shh',
      PATH: '/usr/bin',
      HOME: '/home/eternal',
      PLAIN: 'value',
    })
    expect(env.DSH_SESSION_ID).toBeUndefined()
    expect(env.DSH_WEB_URL).toBeUndefined()
    expect(env.MY_SECRET_TOKEN).toBeUndefined()
    expect(env.OPENALEX_API_KEY).toBe('sk-live-123')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/eternal')
    expect(env.PLAIN).toBe('value')
  })

  it('surfaces the actual spawn error (e.g. ENOENT) instead of a bare -1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-run-'))
    try {
      const result = await runCli('/nonexistent/runner-bin', ['--topic', 'x'], { logDir: dir, graceMs: 2000 })
      expect(result.ok).toBe(false)
      expect(result.message).toContain('runner spawn failed')
      expect(result.message).toMatch(/ENOENT|spawn/i)
      expect(result.pid).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ui adapter — stale running detection', () => {
  it('flags a running push with no recent persisted activity as stale', () => {
    const t = tempDb()
    try {
      seedPaper(t.db, 'arxiv:2401.001', 'Some Paper', 2024, null)
      seedPush(t.db, 30, 'control', 'running')
      // started_at = datetime('now') → recent, not stale
      expect(getPushStatus(t.db).staleRunning).toBe(false)
      // Backdate beyond the staleness window → stale.
      t.db.prepare(`UPDATE pushes SET started_at = datetime('now', '-20 minutes') WHERE id = 30`).run()
      const stale = getPushStatus(t.db)
      expect(stale.staleRunning).toBe(true)
      expect(stale.lastActivityAt).not.toBeNull()
      // A fresh retrieval row means the runner is alive → not stale.
      t.db.prepare(
        `INSERT INTO retrievals (push_id, paper_id, generated_query, source_adapter, candidate_pool)
         VALUES (30, 'arxiv:2401.001', 'q', 'OpenAlex', 'recent')`,
      ).run()
      expect(getPushStatus(t.db).staleRunning).toBe(false)
      // A completed push is never stale.
      t.db.prepare(`UPDATE pushes SET status = 'completed' WHERE id = 30`).run()
      expect(getPushStatus(t.db).staleRunning).toBe(false)
    } finally {
      close(t)
    }
  })
})
