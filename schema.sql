-- Literature Agent V0.1 schema (SQLite). Migration lives in src/db.ts and
-- must stay in sync with this file. Bump PRAGMA user_version on structural changes.

CREATE TABLE IF NOT EXISTS papers (
  id              TEXT PRIMARY KEY,              -- canonical: 'arxiv:XXXX' | 'doi:10.xxx' | 'openalex:W...'
  title           TEXT NOT NULL,
  authors          TEXT,                          -- JSON array of strings
  venue            TEXT,
  year             INTEGER,
  doi              TEXT,
  arxiv_id         TEXT,
  openalex_id      TEXT,
  url              TEXT,
  abstract         TEXT,
  citations        INTEGER,
  bibtex           TEXT,
  metadata_source  TEXT NOT NULL,                 -- provenance: adapter that supplied metadata
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
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
  paper_id       TEXT,                            -- picked paper (FK enforced at app level)
  report_path    TEXT,
  model_route    TEXT,                            -- provenance: {provider,model} if harness exposes it
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  push_id              INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  paper_id             TEXT    NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  rank_hint            REAL,                      -- deterministic pre-rank position (1 = best)
  picked               INTEGER NOT NULL DEFAULT 0,
  recency_score        REAL,                      -- deterministic pre-ranking trace
  impact_score         REAL,
  topic_similarity     REAL,
  fulltext_available   INTEGER NOT NULL DEFAULT 0,
  stage_relevance_hint REAL,                      -- deterministic hint (program)
  stage_relevance_score REAL,                     -- agent-assigned (semantic ranking)
  curriculum_hint       REAL,                      -- deterministic hint (program)
  curriculum_value      REAL,                      -- agent-assigned
  agent_rank            INTEGER,                   -- agent semantic ranking position (final_score order)
  preflight_attempt_order INTEGER,                 -- order in which preflight was attempted
  priority_goal_match   INTEGER NOT NULL DEFAULT 0,
  selection_outcome     TEXT,                      -- SELECTED | FULLTEXT_UNAVAILABLE | BELOW_QUALITY_GATE | PDF_FAILED
  selection_rejection_reason TEXT,
  landmark_confidence   REAL,
  methodological_centrality REAL,
  candidate_pool       TEXT NOT NULL DEFAULT 'recent'
                       CHECK (candidate_pool IN ('recent','landmark')),
  relevance_score      REAL,                      -- agent semantic ranking trace
  learning_value_score REAL,
  representative_score REAL,
  novelty_score        REAL,
  final_score          REAL,
  rationale            TEXT,
  is_seen              INTEGER NOT NULL DEFAULT 0, -- already recommended in an earlier push
  PRIMARY KEY (push_id, paper_id)
);

CREATE TABLE IF NOT EXISTS fetch_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  attempts   TEXT NOT NULL,                       -- JSON: [{source,url,status,http}]
  outcome    TEXT NOT NULL CHECK (outcome IN ('ok','FULLTEXT_UNAVAILABLE','failed')),
  pdf_path   TEXT,
  pdf_source TEXT,                                -- provenance: winning URL + license
  sha256     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fulltexts (
  paper_id    TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('ok','unavailable')),
  parser      TEXT,                               -- provenance: e.g. 'pdftotext 22.02.0'
  char_count  INTEGER,
  chunk_count INTEGER,
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fulltext_chunks (
  paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  section    TEXT,                                -- heading label or 'chunk-<seq>'
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

CREATE TABLE IF NOT EXISTS knowledge_coverage (
  push_id  INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  goal     TEXT NOT NULL,
  PRIMARY KEY (push_id, paper_id, goal)
);

CREATE TABLE IF NOT EXISTS stages (
  topic           TEXT PRIMARY KEY,
  current         INTEGER NOT NULL DEFAULT 1,
  papers_in_stage INTEGER NOT NULL DEFAULT 0,     -- stage-matched completed picks in the current stage
  target_papers   INTEGER NOT NULL DEFAULT 3,     -- advance gate (config override)
  covered_goals   TEXT NOT NULL DEFAULT '[]',     -- JSON array of goal ids covered in this stage
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

PRAGMA user_version = 5;
