/**
 * SQLite access via node:sqlite (zero native dependencies; Node >= 22.19).
 * The schema lives in schema.sql; migrations key off PRAGMA user_version and
 * must stay in sync with that file.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export const SCHEMA_VERSION = 1

export type Db = DatabaseSync

export interface PushRow {
  id: number
  topic: string
  stage: number
  status: 'running' | 'completed' | 'failed' | 'no_candidate' | 'fulltext_unavailable'
  started_at: string
  finished_at: string | null
  error_code: string | null
  error_detail: string | null
  paper_id: string | null
  report_path: string | null
  model_route: string | null
  notes: string | null
}

/** Open (creating when needed) the database and migrate to SCHEMA_VERSION. */
export function openDb(dataDir: string): Db {
  const db = new DatabaseSync(join(dataDir, 'literature.db'))
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

/** Run idempotent schema migration; safe to call on every open. */
export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const version = row?.user_version ?? 0
  if (version >= SCHEMA_VERSION) return
  db.exec(`
CREATE TABLE IF NOT EXISTS papers (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  authors         TEXT,
  venue           TEXT,
  year            INTEGER,
  doi             TEXT,
  arxiv_id        TEXT,
  openalex_id     TEXT,
  url             TEXT,
  abstract        TEXT,
  citations       INTEGER,
  bibtex          TEXT,
  metadata_source TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_doi   ON papers(doi)      WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id) WHERE arxiv_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pushes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic          TEXT NOT NULL,
  stage          INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','no_candidate','fulltext_unavailable')),
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  error_code     TEXT,
  error_detail   TEXT,
  paper_id       TEXT,
  report_path    TEXT,
  model_route    TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  push_id              INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  paper_id             TEXT    NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  rank_hint            REAL,
  picked               INTEGER NOT NULL DEFAULT 0,
  recency_score        REAL,
  impact_score         REAL,
  topic_similarity     REAL,
  fulltext_available   INTEGER NOT NULL DEFAULT 0,
  relevance_score      REAL,
  learning_value_score REAL,
  representative_score REAL,
  novelty_score        REAL,
  final_score          REAL,
  rationale            TEXT,
  is_seen              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (push_id, paper_id)
);

CREATE TABLE IF NOT EXISTS fetch_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  attempts   TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('ok','FULLTEXT_UNAVAILABLE','failed')),
  pdf_path   TEXT,
  pdf_source TEXT,
  sha256     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fulltexts (
  paper_id    TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('ok','unavailable')),
  parser      TEXT,
  char_count  INTEGER,
  chunk_count INTEGER,
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fulltext_chunks (
  paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  section    TEXT,
  char_start INTEGER NOT NULL,
  char_end   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  PRIMARY KEY (paper_id, seq)
);

CREATE TABLE IF NOT EXISTS stages (
  topic           TEXT PRIMARY KEY,
  current         INTEGER NOT NULL DEFAULT 1,
  papers_in_stage INTEGER NOT NULL DEFAULT 0,
  target_papers   INTEGER NOT NULL DEFAULT 2,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

export interface PaperRow {
  id: string
  title: string
  authors: string | null
  venue: string | null
  year: number | null
  doi: string | null
  arxiv_id: string | null
  openalex_id: string | null
  url: string | null
  abstract: string | null
  citations: number | null
  bibtex: string | null
  metadata_source: string
}

/** Upsert a paper; returns its canonical id. */
export function upsertPaper(db: Db, p: PaperRow): string {
  db.prepare(
    `INSERT INTO papers (id,title,authors,venue,year,doi,arxiv_id,openalex_id,url,abstract,citations,bibtex,metadata_source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, authors=excluded.authors, venue=excluded.venue, year=excluded.year,
       doi=excluded.doi, arxiv_id=excluded.arxiv_id, openalex_id=excluded.openalex_id,
       url=excluded.url, abstract=excluded.abstract, citations=excluded.citations,
       bibtex=excluded.bibtex, metadata_source=excluded.metadata_source`,
  ).run(
    p.id,
    p.title,
    p.authors,
    p.venue,
    p.year,
    p.doi,
    p.arxiv_id,
    p.openalex_id,
    p.url,
    p.abstract,
    p.citations,
    p.bibtex,
    p.metadata_source,
  )
  return p.id
}

export function getPaper(db: Db, id: string): PaperRow | undefined {
  return db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as PaperRow | undefined
}

export function getPaperByDoi(db: Db, doi: string): PaperRow | undefined {
  return db.prepare('SELECT * FROM papers WHERE doi = ?').get(doi) as PaperRow | undefined
}

export function getPaperByArxiv(db: Db, arxivId: string): PaperRow | undefined {
  return db.prepare('SELECT * FROM papers WHERE arxiv_id = ?').get(arxivId) as PaperRow | undefined
}
