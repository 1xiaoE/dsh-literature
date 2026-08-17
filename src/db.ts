/**
 * SQLite access via node:sqlite (zero native dependencies; Node >= 22.19).
 * The schema lives in schema.sql; migrations key off PRAGMA user_version and
 * must stay in sync with that file.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export const SCHEMA_VERSION = 14

export type Db = DatabaseSync

export interface PushRow {
  id: number
  topic: string
  stage: number
  status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'no_candidate'
    | 'fulltext_unavailable'
    | 'auth_required'
    | 'user_action_required'
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
  if (version < 2) {
    // stage relevance: deterministic hint (program) + agent-assigned score
    db.exec('ALTER TABLE candidates ADD COLUMN stage_relevance_hint REAL;')
    db.exec('ALTER TABLE candidates ADD COLUMN stage_relevance_score REAL;')
  }
  if (version < 3) {
    db.exec("ALTER TABLE candidates ADD COLUMN candidate_pool TEXT NOT NULL DEFAULT 'recent';")
    db.exec(
      `CREATE TABLE IF NOT EXISTS retrievals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        push_id         INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
        paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        generated_query TEXT NOT NULL,
        query_language  TEXT NOT NULL DEFAULT 'en',
        source_adapter  TEXT NOT NULL,
        retrieval_score REAL,
        candidate_pool  TEXT NOT NULL CHECK (candidate_pool IN ('recent','landmark')),
        retrieved_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    )
  }
  if (version < 4) {
    db.exec('ALTER TABLE candidates ADD COLUMN curriculum_hint REAL;')
    db.exec('ALTER TABLE candidates ADD COLUMN curriculum_value REAL;')
    db.exec('ALTER TABLE candidates ADD COLUMN selection_rank INTEGER;')
    db.exec(
      "ALTER TABLE candidates ADD COLUMN selection_outcome TEXT "
      + "CHECK (selection_outcome IS NULL OR selection_outcome IN ('SELECTED','FULLTEXT_UNAVAILABLE','BELOW_QUALITY_GATE','PDF_FAILED'));",
    )
    db.exec('ALTER TABLE candidates ADD COLUMN selection_rejection_reason TEXT;')
    db.exec('ALTER TABLE candidates ADD COLUMN landmark_confidence REAL;')
    db.exec('ALTER TABLE candidates ADD COLUMN methodological_centrality REAL;')
    const stageCols = db.prepare('PRAGMA table_info(stages)').all() as Array<{ name: string }>
    if (!stageCols.some((c) => c.name === 'covered_goals')) {
      db.exec("ALTER TABLE stages ADD COLUMN covered_goals TEXT NOT NULL DEFAULT '[]';")
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS knowledge_coverage (
        push_id  INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        goal     TEXT NOT NULL,
        PRIMARY KEY (push_id, paper_id, goal)
      );`,
    )
  }
  if (version < 5) {
    db.exec('ALTER TABLE candidates ADD COLUMN agent_rank INTEGER;')
    db.exec('ALTER TABLE candidates ADD COLUMN preflight_attempt_order INTEGER;')
    db.exec('ALTER TABLE candidates ADD COLUMN priority_goal_match INTEGER NOT NULL DEFAULT 0;')
    // split the conflated selection_rank column (agent rank ≠ preflight order)
    const cols = db.prepare('PRAGMA table_info(candidates)').all() as Array<{ name: string }>
    if (cols.some((c) => c.name === 'selection_rank')) {
      db.exec('ALTER TABLE candidates DROP COLUMN selection_rank;')
    }
  }
  if (version < 6) {
    // oa pdf url split (landing page is NOT a fulltext signal)
    const paperCols = db.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>
    if (!paperCols.some((c) => c.name === 'oa_pdf_url')) {
      db.exec('ALTER TABLE papers ADD COLUMN oa_pdf_url TEXT;')
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS fulltext_reads (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        push_id  INTEGER REFERENCES pushes(id) ON DELETE CASCADE,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        seq      INTEGER NOT NULL,
        read_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    )
    // legacy topic aliases → canonical id (keeps historical dedup working)
    db.exec(
      "UPDATE pushes SET topic = 'legged_robot_control' WHERE topic IN ('足式机器人控制', 'legged robot control', 'legged robot')",
    )
    db.exec(
      "DELETE FROM stages WHERE topic IN ('足式机器人控制', 'legged robot control', 'legged robot') AND topic != 'legged_robot_control'",
    )
  }
  if (version < 7) {
    // CARSI institutional-access fallback:
    // - fetch_log: new terminal outcomes (PDF_OK / AUTH_REQUIRED / ACCESS_DENIED /
    //   PDF_NOT_FOUND) + provenance columns (access_type / is_open_access);
    // - pushes: new terminal status 'auth_required' (distinct from
    //   fulltext_unavailable — a broken institutional session needs a re-login
    //   prompt, NOT a permanent paper-level cooldown).
    // SQLite cannot alter CHECK constraints, so both tables are rebuilt.
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      db.exec(`
CREATE TABLE fetch_log_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id       TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  attempts       TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','PDF_OK','AUTH_REQUIRED','ACCESS_DENIED','PDF_NOT_FOUND','FULLTEXT_UNAVAILABLE','failed')),
  pdf_path       TEXT,
  pdf_source     TEXT,
  sha256         TEXT,
  access_type    TEXT CHECK (access_type IS NULL OR access_type IN ('oa','institutional')),
  is_open_access INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO fetch_log_new (id, paper_id, attempts, outcome, pdf_path, pdf_source, sha256, created_at)
  SELECT id, paper_id, attempts, outcome, pdf_path, pdf_source, sha256, created_at FROM fetch_log;
DROP TABLE fetch_log;
ALTER TABLE fetch_log_new RENAME TO fetch_log;

CREATE TABLE pushes_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic          TEXT NOT NULL,
  stage          INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','no_candidate','fulltext_unavailable','auth_required')),
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  error_code     TEXT,
  error_detail   TEXT,
  paper_id       TEXT,
  report_path    TEXT,
  model_route    TEXT,
  notes          TEXT
);
INSERT INTO pushes_new (id, topic, stage, status, started_at, finished_at, error_code, error_detail, paper_id, report_path, model_route, notes)
  SELECT id, topic, stage, status, started_at, finished_at, error_code, error_detail, paper_id, report_path, model_route, notes FROM pushes;
DROP TABLE pushes;
ALTER TABLE pushes_new RENAME TO pushes;
`)
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
  if (version < 8) {
    // Human-in-the-loop (NEED_USER_ACTION):
    // - pushes gain the generic 'user_action_required' terminal (a resource /
    //   auth / permission / download-channel / research-choice problem that
    //   the USER can solve more easily than the automation — never blind
    //   retries, never misreported as FULLTEXT_UNAVAILABLE);
    // - user_actions stores the five-part issue record (where stuck / what's
    //   missing / what was tried / what the user should do / how to continue)
    //   so a resumed workflow can continue from the original step without
    //   re-running retrieval and scoring.
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      db.exec(`
CREATE TABLE pushes_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic          TEXT NOT NULL,
  stage          INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','no_candidate','fulltext_unavailable','auth_required','user_action_required')),
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  error_code     TEXT,
  error_detail   TEXT,
  paper_id       TEXT,
  report_path    TEXT,
  model_route    TEXT,
  notes          TEXT
);
INSERT INTO pushes_new (id, topic, stage, status, started_at, finished_at, error_code, error_detail, paper_id, report_path, model_route, notes)
  SELECT id, topic, stage, status, started_at, finished_at, error_code, error_detail, paper_id, report_path, model_route, notes FROM pushes;
DROP TABLE pushes;
ALTER TABLE pushes_new RENAME TO pushes;

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
`)
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
  if (version < 9) {
    // V0.1 correctness closeout:
    // - candidates.priority_goal_match: INTEGER → REAL (0..1 match strength;
    //   the value is now actually written by literature_sources — previously
    //   the column existed but was never inserted, so it stayed DEFAULT 0);
    // - pushes gains full-text reading coverage provenance columns
    //   (total_chunks / read_chunks / read_coverage / coverage_basis) so a
    //   completed push's report can state the exact coverage basis.
    const cols = (db.prepare('PRAGMA table_info(candidates)').all() as Array<{ name: string }>).map((c) => c.name)
    const colDef = (name: string): string => {
      switch (name) {
        case 'push_id':
          return 'INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE'
        case 'paper_id':
          return 'TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE'
        case 'priority_goal_match':
          return 'REAL NOT NULL DEFAULT 0'
        case 'candidate_pool':
          return "TEXT NOT NULL DEFAULT 'recent' CHECK (candidate_pool IN ('recent','landmark'))"
        case 'picked':
        case 'fulltext_available':
        case 'is_seen':
          return 'INTEGER NOT NULL DEFAULT 0'
        default:
          return ''
      }
    }
    const quoted = cols.map((c) => `"${c}"`)
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      db.exec(
        `CREATE TABLE candidates_new (
  ${cols.map((c) => `  "${c}" ${colDef(c)}`).join(',\n')},
  PRIMARY KEY (push_id, paper_id)
);`,
      )
      db.exec(
        `INSERT INTO candidates_new (${quoted.join(',')})
         SELECT ${quoted.join(',')} FROM candidates;`,
      )
      db.exec('DROP TABLE candidates;')
      db.exec('ALTER TABLE candidates_new RENAME TO candidates;')
      const pushCols = db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>
      const add = (name: string, ddl: string): void => {
        if (!pushCols.some((c) => c.name === name)) db.exec(`ALTER TABLE pushes ADD COLUMN ${ddl};`)
      }
      add('total_chunks', 'total_chunks INTEGER')
      add('read_chunks', 'read_chunks INTEGER')
      add('read_coverage', 'read_coverage REAL')
      add('coverage_basis', "coverage_basis TEXT CHECK (coverage_basis IS NULL OR coverage_basis IN ('full_read','index_exposed','read_log'))")
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
  if (version < 10) {
    // Performance audit: per-phase timings + candidate/LLM metrics on pushes.
    // Phase timings are accumulated plugin-side (retrieval / deterministic
    // ranking / preflight / download / parsing / reads); agent-side phases
    // (agent ranking, report generation, llm calls) are reported by the agent
    // via literature_record. All values are ms or counts, nullable.
    const cols = db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>
    const add = (name: string, ddl: string): void => {
      if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE pushes ADD COLUMN ${ddl};`)
    }
    add('retrieval_ms', 'retrieval_ms INTEGER')
    add('deterministic_ranking_ms', 'deterministic_ranking_ms INTEGER')
    add('agent_ranking_ms', 'agent_ranking_ms INTEGER')
    add('pdf_preflight_ms', 'pdf_preflight_ms INTEGER')
    add('pdf_download_ms', 'pdf_download_ms INTEGER')
    add('parsing_ms', 'parsing_ms INTEGER')
    add('fulltext_read_ms', 'fulltext_read_ms INTEGER')
    add('report_generation_ms', 'report_generation_ms INTEGER')
    add('total_ms', 'total_ms INTEGER')
    add('raw_candidates', 'raw_candidates INTEGER')
    add('deterministic_candidates', 'deterministic_candidates INTEGER')
    add('agent_scored_candidates', 'agent_scored_candidates INTEGER')
    add('llm_call_count', 'llm_call_count INTEGER')
    add('llm_retry_count', 'llm_retry_count INTEGER')
    add('pdf_attempt_count', 'pdf_attempt_count INTEGER')
  }
  if (version < 11) {
    // OpenAlex auth provenance: how the retrieval adapter authenticated.
    // Only the MODE is stored ('anonymous' | 'api_key') — never the key.
    const cols = db.prepare('PRAGMA table_info(retrievals)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'auth_mode')) {
      db.exec("ALTER TABLE retrievals ADD COLUMN auth_mode TEXT;")
    }
  }
  if (version < 12) {
    // arXiv request-scheduling provenance (scheduler gaps / dedup / 429 / breaker).
    const cols = db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>
    const add = (name: string, ddl: string): void => {
      if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE pushes ADD COLUMN ${ddl};`)
    }
    add('arxiv_requests', 'arxiv_requests INTEGER')
    add('arxiv_dedup_hits', 'arxiv_dedup_hits INTEGER')
    add('arxiv_429_count', 'arxiv_429_count INTEGER')
    add('arxiv_retry_count', 'arxiv_retry_count INTEGER')
    add('arxiv_rate_limited', 'arxiv_rate_limited INTEGER')
    add('arxiv_wait_ms', 'arxiv_wait_ms INTEGER')
  }
  if (version < 13) {
    // Deterministic resume provenance (0-LLM finalize path).
    const cols = db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>
    const add = (name: string, ddl: string): void => {
      if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE pushes ADD COLUMN ${ddl};`)
    }
    add('resume_ms', 'resume_ms INTEGER')
    add('resume_llm_call_count', 'resume_llm_call_count INTEGER')
  }
  if (version < 14) {
    // HITL manual PDF provenance: fetch_log.access_type now also admits
    // 'manual' (user-downloaded via a publisher's human flow / Edge etc.).
    // SQLite cannot alter CHECK constraints, so the table is rebuilt
    // preserving all rows (source=manual is NOT open access).
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      db.exec(`
CREATE TABLE fetch_log_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id       TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  attempts       TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','PDF_OK','AUTH_REQUIRED','ACCESS_DENIED','PDF_NOT_FOUND','FULLTEXT_UNAVAILABLE','failed')),
  pdf_path       TEXT,
  pdf_source     TEXT,
  sha256         TEXT,
  access_type    TEXT CHECK (access_type IS NULL OR access_type IN ('oa','institutional','manual')),
  is_open_access INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO fetch_log_new (id, paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access, created_at)
  SELECT id, paper_id, attempts, outcome, pdf_path, pdf_source, sha256, access_type, is_open_access, created_at FROM fetch_log;
DROP TABLE fetch_log;
ALTER TABLE fetch_log_new RENAME TO fetch_log;
`)
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
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
  oa_pdf_url: string | null
  abstract: string | null
  citations: number | null
  bibtex: string | null
  metadata_source: string
}

/** Upsert a paper; returns its canonical id. */
export function upsertPaper(db: Db, p: PaperRow): string {
  db.prepare(
    `INSERT INTO papers (id,title,authors,venue,year,doi,arxiv_id,openalex_id,url,oa_pdf_url,abstract,citations,bibtex,metadata_source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, authors=excluded.authors, venue=excluded.venue, year=excluded.year,
       doi=excluded.doi, arxiv_id=excluded.arxiv_id, openalex_id=excluded.openalex_id,
       url=excluded.url, oa_pdf_url=excluded.oa_pdf_url, abstract=excluded.abstract, citations=excluded.citations,
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
    p.oa_pdf_url,
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
