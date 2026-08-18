import type { Db } from '../db.js'

/** v1: base schema — every table the plugin owns (idempotent CREATE IF NOT EXISTS). */
export default function up(db: Db): void {
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
  oa_pdf_url      TEXT,
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

CREATE TABLE IF NOT EXISTS retrievals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  push_id         INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  generated_query TEXT NOT NULL,
  query_language  TEXT NOT NULL DEFAULT 'en',
  source_adapter  TEXT NOT NULL,
  retrieval_score REAL,
  candidate_pool  TEXT NOT NULL CHECK (candidate_pool IN ('recent','landmark')),
  retrieved_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fulltext_reads (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  push_id  INTEGER REFERENCES pushes(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  read_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stages (
  topic           TEXT PRIMARY KEY,
  current         INTEGER NOT NULL DEFAULT 1,
  papers_in_stage INTEGER NOT NULL DEFAULT 0,
  target_papers   INTEGER NOT NULL DEFAULT 3,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`)
}
