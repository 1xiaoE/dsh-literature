import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate, openDb, upsertPaper, type Db } from '../src/db.js'

interface TempDb {
  db: Db
  dir: string
}

function tempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-'))
  const db = openDb(dir)
  return { db, dir }
}

describe('sqlite migration', () => {
  it('is idempotent and sets user_version', () => {
    const { db, dir } = tempDb()
    migrate(db)
    migrate(db)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(21)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    for (const t of ['papers', 'pushes', 'candidates', 'fetch_log', 'fulltexts', 'fulltext_chunks', 'stages', 'retrievals', 'knowledge_coverage', 'categories', 'category_aliases', 'paper_categories']) {
      expect(names).toContain(t)
    }
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upserts papers idempotently', () => {
    const { db, dir } = tempDb()
    const row = {
      id: 'arxiv:2401.001',
      title: 'A Paper',
      authors: '["A"]',
      venue: null,
      year: 2024,
      doi: '10.1/abc',
      arxiv_id: '2401.001',
      openalex_id: null,
      url: null,
      oa_pdf_url: null,
      abstract: null,
      citations: 10,
      bibtex: null,
      metadata_source: 'arxiv',
    }
    upsertPaper(db, row)
    upsertPaper(db, { ...row, citations: 11, authors: '["A","B"]' })
    const got = db.prepare('SELECT * FROM papers WHERE id = ?').get('arxiv:2401.001') as {
      citations: number
      authors: string
    }
    expect(got.citations).toBe(11)
    expect(got.authors).toBe('["A","B"]')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('enforces one SELECTED per push and unique agent ranks (v19 hard constraints)', () => {
    const { db, dir } = tempDb()
    db.prepare(`INSERT INTO pushes (id, topic, stage, status) VALUES (1, 'control', 1, 'completed')`).run()
    db.prepare(`INSERT INTO papers (id, title, metadata_source) VALUES ('p:1', 'One', 'test')`).run()
    db.prepare(`INSERT INTO papers (id, title, metadata_source) VALUES ('p:2', 'Two', 'test')`).run()
    db.prepare(
      `INSERT INTO candidates (push_id, paper_id, agent_rank, selection_outcome, candidate_pool)
       VALUES (1, 'p:1', 1, 'SELECTED', 'recent')`,
    ).run()
    // A second SELECTED on the same push must be rejected by SQLite itself.
    expect(() =>
      db.prepare(
        `INSERT INTO candidates (push_id, paper_id, agent_rank, selection_outcome, candidate_pool)
         VALUES (1, 'p:2', 2, 'SELECTED', 'recent')`,
      ).run(),
    ).toThrow(/UNIQUE/)
    // A duplicate agent_rank (p:2 with rank 1) must also be rejected.
    expect(() =>
      db.prepare(
        `INSERT INTO candidates (push_id, paper_id, agent_rank, candidate_pool)
         VALUES (1, 'p:2', 1, 'recent')`,
      ).run(),
    ).toThrow(/UNIQUE/)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('v19 migration repairs legacy duplicate agent_rank rows before enforcing uniqueness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-v19-'))
    const db = openDb(dir)
    db.prepare(`INSERT INTO pushes (id, topic, stage, status) VALUES (1, 'control', 1, 'completed')`).run()
    db.prepare(`INSERT INTO papers (id, title, metadata_source) VALUES ('p:1', 'One', 'test')`).run()
    db.prepare(`INSERT INTO papers (id, title, metadata_source) VALUES ('p:2', 'Two', 'test')`).run()
    db.prepare(`INSERT INTO papers (id, title, metadata_source) VALUES ('p:3', 'Three', 'test')`).run()
    // Simulate a pre-v19 DB: drop the unique index, insert colliding ranks.
    db.exec('DROP INDEX IF EXISTS uq_candidates_agent_rank')
    db.exec(`INSERT INTO candidates (push_id, paper_id, agent_rank, final_score, candidate_pool) VALUES (1, 'p:1', 1, 0.9, 'recent')`)
    db.exec(`INSERT INTO candidates (push_id, paper_id, agent_rank, final_score, selection_outcome, candidate_pool) VALUES (1, 'p:2', 1, 0.5, 'SELECTED', 'recent')`)
    db.exec(`INSERT INTO candidates (push_id, paper_id, agent_rank, final_score, candidate_pool) VALUES (1, 'p:3', 1, 0.2, 'recent')`)
    // Re-run migration: the SELECTED row keeps rank 1, others are nulled.
    db.exec('PRAGMA user_version = 18')
    migrate(db)
    const rows = db.prepare('SELECT paper_id, agent_rank, selection_outcome FROM candidates ORDER BY paper_id').all() as Array<{ paper_id: string; agent_rank: number | null; selection_outcome: string | null }>
    const selected = rows.find((r) => r.selection_outcome === 'SELECTED')!
    expect(selected.agent_rank).toBe(1)
    expect(rows.filter((r) => r.agent_rank === 1)).toHaveLength(1)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('v6 topic alias migration', () => {
  it('maps legacy topic names to the canonical id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-alias-'))
    const db = new DatabaseSync(join(dir, 'alias.db'))
    // minimal pre-v6 schema so legacy rows exist before the migration runs
    // (pushes carries the full v6 column set so the v7 rebuild can copy it)
    db.exec(
      `CREATE TABLE pushes (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         topic TEXT NOT NULL,
         stage INTEGER NOT NULL DEFAULT 1,
         status TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','completed','failed','no_candidate','fulltext_unavailable')),
         started_at TEXT NOT NULL DEFAULT (datetime('now')),
         finished_at TEXT,
         error_code TEXT,
         error_detail TEXT,
         paper_id TEXT,
         report_path TEXT,
         model_route TEXT,
         notes TEXT
       );
       CREATE TABLE stages (
         topic TEXT PRIMARY KEY,
         current INTEGER NOT NULL DEFAULT 1,
         papers_in_stage INTEGER NOT NULL DEFAULT 0,
         target_papers INTEGER NOT NULL DEFAULT 3,
         covered_goals TEXT NOT NULL DEFAULT '[]'
       );`,
    )
    db.prepare("INSERT INTO pushes (topic, stage, status) VALUES ('足式机器人控制', 1, 'completed')").run()
    db.prepare("INSERT INTO pushes (topic, stage, status) VALUES ('legged robot control', 1, 'completed')").run()
    db.prepare("INSERT INTO pushes (topic, stage, status) VALUES ('legged_robot_control', 1, 'completed')").run()
    db.prepare("INSERT INTO stages (topic, current) VALUES ('足式机器人控制', 1)").run()
    db.prepare("INSERT INTO stages (topic, current, papers_in_stage, target_papers, covered_goals) VALUES ('legged_robot_control', 1, 2, 3, '[]')").run()
    migrate(db) // v6 alias rewrite runs inside migrate
    const topics = db.prepare('SELECT DISTINCT topic FROM pushes').all() as Array<{ topic: string }>
    expect(topics.map((t) => t.topic).sort()).toEqual(['legged_robot_control'])
    // alias stage rows are dropped; the canonical row survives untouched
    const stages = db.prepare('SELECT topic FROM stages').all() as Array<{ topic: string }>
    expect(stages.map((t) => t.topic)).toEqual(['legged_robot_control'])
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
