/**
 * SQLite access via node:sqlite (zero native dependencies; Node >= 22.19).
 * The schema lives in schema.sql; migrations key off PRAGMA user_version and
 * must stay in sync with that file.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { resolvePaperFields } from './lib/research_fields.js'
import { migrations } from './migrations/index.js'

export const SCHEMA_VERSION = 21

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
  // Run every migration whose target version is above the current one, in
  // ascending version order (see src/migrations/index.ts).
  for (const migration of migrations) {
    if (version < migration.version) migration.up(db)
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
  affiliation?: string | null
  keywords?: string | null
  metadata_enriched_at?: string | null
}

/** Upsert a paper; returns its canonical id. */
export function upsertPaper(db: Db, p: PaperRow): string {
  db.prepare(
    `INSERT INTO papers (id,title,authors,venue,year,doi,arxiv_id,openalex_id,url,oa_pdf_url,abstract,citations,bibtex,metadata_source,affiliation,keywords,metadata_enriched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, authors=excluded.authors, venue=excluded.venue, year=excluded.year,
       doi=excluded.doi, arxiv_id=excluded.arxiv_id, openalex_id=excluded.openalex_id,
       url=excluded.url, oa_pdf_url=excluded.oa_pdf_url, abstract=excluded.abstract, citations=excluded.citations,
       bibtex=excluded.bibtex, metadata_source=excluded.metadata_source,
       affiliation=excluded.affiliation, keywords=excluded.keywords,
       metadata_enriched_at=excluded.metadata_enriched_at`,
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
    p.affiliation ?? null,
    p.keywords ?? null,
    p.metadata_enriched_at ?? null,
  )
  resolvePaperFields(db, p.id)
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
