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
  oa_pdf_url       TEXT,                            -- landing page URL is NOT a fulltext signal
  abstract         TEXT,
  citations        INTEGER,
  bibtex           TEXT,
  metadata_source  TEXT NOT NULL,                 -- provenance: adapter that supplied metadata
  affiliation      TEXT,
  keywords         TEXT,                          -- JSON array when extracted/enriched
  metadata_enriched_at TEXT,
  is_favorite          INTEGER NOT NULL DEFAULT 0, -- first-class library signal (favorites)
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_doi   ON papers(doi)      WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id) WHERE arxiv_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pushes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic          TEXT NOT NULL,
  stage          INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','no_candidate','fulltext_unavailable','auth_required','user_action_required')),
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  error_code     TEXT,
  error_detail   TEXT,
  paper_id       TEXT,                            -- picked paper (FK enforced at app level)
  report_path    TEXT,
  model_route    TEXT,                            -- provenance: {provider,model} if harness exposes it
  notes          TEXT,
  total_chunks   INTEGER,                         -- full-text reading coverage provenance
  read_chunks    INTEGER,
  read_coverage  REAL,
  coverage_basis TEXT CHECK (coverage_basis IS NULL OR coverage_basis IN ('full_read','index_exposed','read_log')),
  retrieval_ms INTEGER,                           -- performance audit (ms / counts)
  deterministic_ranking_ms INTEGER,
  agent_ranking_ms INTEGER,
  pdf_preflight_ms INTEGER,
  pdf_download_ms INTEGER,
  parsing_ms INTEGER,
  fulltext_read_ms INTEGER,
  report_generation_ms INTEGER,
  total_ms INTEGER,
  raw_candidates INTEGER,
  deterministic_candidates INTEGER,
  agent_scored_candidates INTEGER,
  llm_call_count INTEGER,
  llm_retry_count INTEGER,
  pdf_attempt_count INTEGER,
  arxiv_requests INTEGER,                        -- arXiv scheduler provenance
  arxiv_dedup_hits INTEGER,
  arxiv_429_count INTEGER,
  arxiv_retry_count INTEGER,
  arxiv_rate_limited INTEGER,
  arxiv_wait_ms INTEGER,
  resume_ms INTEGER,                             -- deterministic --resume provenance
  resume_llm_call_count INTEGER,                 -- 0 = finalized without LLM
  policy_json TEXT                                -- normalized config snapshot for deterministic resume
);

-- Human-in-the-loop (NEED_USER_ACTION): five-part issue record per push.
-- state='open' → the workflow is parked and needs the user; 'resolved' → the
-- user finished, the push can be resumed from the original step.
CREATE TABLE IF NOT EXISTS user_actions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  push_id            INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
  paper_id           TEXT REFERENCES papers(id) ON DELETE CASCADE,
  step               TEXT NOT NULL,   -- where the workflow is stuck (sources/selection/preflight/fetch_pdf/fulltext_index/report/record)
  kind               TEXT NOT NULL,   -- carsi_relogin | manual_pdf | version_choice | topic_decision | user_resource_needed | ...
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  issue              TEXT NOT NULL,   -- what resource/permission/info is missing
  attempts           TEXT,            -- JSON array: what has already been tried
  what_user_should_do TEXT NOT NULL,
  how_to_continue    TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_actions_push ON user_actions(push_id);
CREATE INDEX IF NOT EXISTS idx_user_actions_state ON user_actions(state);

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
  priority_goal_match   REAL NOT NULL DEFAULT 0,   -- priority-goal match STRENGTH 0..1 (deterministic)
  selection_outcome     TEXT,                      -- SELECTED | FULLTEXT_UNAVAILABLE | BELOW_QUALITY_GATE | PDF_FAILED
  selection_rejection_reason TEXT,
  public_preflight_status TEXT CHECK (public_preflight_status IS NULL OR public_preflight_status IN ('AVAILABLE','UNAVAILABLE')),
  acquisition_outcome TEXT CHECK (acquisition_outcome IS NULL OR acquisition_outcome IN ('SELECTED','AUTH_REQUIRED','RATE_LIMITED','ACCESS_DENIED','PDF_NOT_FOUND','FULLTEXT_UNAVAILABLE','PDF_FAILED')),
  acquisition_reason TEXT,
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
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id       TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  attempts       TEXT NOT NULL,                       -- JSON: [{source,url,status,http,detail}]
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','PDF_OK','AUTH_REQUIRED','RATE_LIMITED','ACCESS_DENIED','PDF_NOT_FOUND','FULLTEXT_UNAVAILABLE','failed')),
  pdf_path       TEXT,
  pdf_source     TEXT,                                -- provenance: winning URL + license
  sha256         TEXT,
  access_type    TEXT CHECK (access_type IS NULL OR access_type IN ('oa','institutional','manual')),  -- provenance (req 1)
  is_open_access INTEGER,                             -- provenance: 0 for institutional/manual
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
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
  auth_mode       TEXT,                          -- 'anonymous' | 'api_key' (never the key itself)
  retrieved_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fulltext_reads (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  push_id  INTEGER REFERENCES pushes(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  read_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Research fields organize papers in the library. They intentionally do not
-- replace the workflow's topic/stage/curriculum vocabulary.
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name_en     TEXT NOT NULL,
  name_zh     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('field','topic')),
  created_by  TEXT NOT NULL CHECK (created_by IN ('system','auto','user')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS category_aliases (
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL UNIQUE,
  PRIMARY KEY (category_id, normalized_name)
);
CREATE TABLE IF NOT EXISTS paper_categories (
  paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('auto','manual')),
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','excluded')),
  confidence  REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (paper_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_paper_categories_category ON paper_categories(category_id, state);

-- Report version history: a paper may hold multiple report versions (deep
-- read / workflow re-run / model or prompt comparisons); id orders them.
-- `pushes.report_path` remains supported for legacy workflow provenance.
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  report_path TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('workflow','deep_read')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_paper ON reports(paper_id);
CREATE INDEX IF NOT EXISTS idx_reports_paper_created ON reports(paper_id, created_at);
CREATE TABLE IF NOT EXISTS paper_reading_jobs (
  paper_id    TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  read_chunks INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_reading_jobs_status ON paper_reading_jobs(status);

-- Query hot-path indexes: every list/count/rank read touches these columns.
-- (Created after all tables, so schema.sql executes linearly on an empty DB.)
CREATE INDEX IF NOT EXISTS idx_candidates_paper ON candidates(paper_id);
CREATE INDEX IF NOT EXISTS idx_candidates_push ON candidates(push_id);
CREATE INDEX IF NOT EXISTS idx_candidates_selection ON candidates(push_id, selection_outcome);
CREATE INDEX IF NOT EXISTS idx_candidates_rank ON candidates(push_id, agent_rank) WHERE agent_rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_retrievals_paper ON retrievals(paper_id);
CREATE INDEX IF NOT EXISTS idx_retrievals_push ON retrievals(push_id);
CREATE INDEX IF NOT EXISTS idx_fetch_log_paper ON fetch_log(paper_id);
CREATE INDEX IF NOT EXISTS idx_fetch_log_sha ON fetch_log(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fulltext_reads_paper ON fulltext_reads(paper_id);
CREATE INDEX IF NOT EXISTS idx_fulltext_reads_seq ON fulltext_reads(paper_id, seq);
CREATE INDEX IF NOT EXISTS idx_reports_paper ON reports(paper_id);

-- Hard invariants of the Quality-First state machine, enforced by SQLite:
-- (1) one push may SELECT at most one paper; (2) agent ranks within a push
-- are unique (no two candidates claim the same rank).
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_selected ON candidates(push_id)
  WHERE selection_outcome = 'SELECTED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_agent_rank ON candidates(push_id, agent_rank)
  WHERE agent_rank IS NOT NULL;

-- Runner jobs: Web UI → child-process lifecycle ledger (Run/Resume spawn rows).
CREATE TABLE IF NOT EXISTS runner_jobs (
  run_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN ('push','resume')),
  push_id      INTEGER,
  pid          INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('running','exited','failed')),
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  exit_code    INTEGER,
  log_path     TEXT,
  message      TEXT,
  error_code   TEXT,
  retryable    INTEGER,
  provider     TEXT,
  model        TEXT
);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_status ON runner_jobs(status);

PRAGMA user_version = 22;
