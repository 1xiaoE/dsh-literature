import type { Db } from '../db.js'
import { backfillResearchFields } from '../lib/research_fields.js'

/** v16: Research fields — categories / category_aliases / paper_categories + backfill. */
export default function up(db: Db): void {
  // Research fields are a library-organization layer only. They do not
  // replace pushes.topic, curriculum stages, retrieval, or ranking state.
  db.exec(`
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
`)
  backfillResearchFields(db)
}
