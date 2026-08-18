/**
 * Research-field organization is deliberately separate from workflow topics:
 * fields organize the paper library; pushes/stages/ranking retain their own
 * curriculum topic semantics. All classification is deterministic and local.
 *
 * Library scope: only papers that actually entered the knowledge base
 * (Selected / manual import / has PDF / read / report / favorite / manual
 * category — see lib/library.ts) are auto-classified and counted. Papers
 * merely retrieved (candidate-pool only) never pollute Research Fields.
 */
import type { Db } from '../db.js'
import { isLibraryPaper, libraryPaperExistsSql } from './library.js'

export type FieldSource = 'auto' | 'manual'
export interface ResearchField {
  id: number
  slug: string
  nameEn: string
  nameZh: string
  createdBy: 'system' | 'auto' | 'user'
  count: number
}
export interface PaperField extends ResearchField { source: FieldSource; confidence: number | null }
export interface FieldInput { nameEn: string; nameZh: string }

/** One auto-classification rule: a field plus the keyword terms that match it. */
export interface FieldRule extends FieldInput {
  slug: string
  terms: string[]
  /** true when the field should be created on demand (auto-created). */
  create?: true
}

interface FieldRow {
  id: number
  slug: string
  name_en: string
  name_zh: string
  created_by: 'system' | 'auto' | 'user'
  count?: number
}

const SEED_FIELDS: Array<FieldInput & { slug: string }> = [
  { slug: 'robotics', nameEn: 'Robotics', nameZh: '机器人学' },
  { slug: 'agricultural-robotics', nameEn: 'Agricultural Robotics', nameZh: '农业机器人' },
  { slug: 'agricultural-engineering', nameEn: 'Agricultural Engineering', nameZh: '农业工程' },
  { slug: 'control', nameEn: 'Control', nameZh: '控制' },
  { slug: 'reinforcement-learning', nameEn: 'Reinforcement Learning', nameZh: '强化学习' },
  { slug: 'soil-water', nameEn: 'Soil & Water', nameZh: '土壤与水' },
  { slug: 'uncategorized', nameEn: 'Uncategorized', nameZh: '未分类' },
]

/**
 * Default auto-classification rules (broad fields + keyword terms). Kept
 * exported so presets/configs can override or extend the rule set without
 * touching the resolver.
 */
export const AUTO_RULES: FieldRule[] = [
  { slug: 'robotics', nameEn: 'Robotics', nameZh: '机器人学', terms: ['robot', 'robotic', 'legged', 'quadruped', 'biped', 'humanoid', 'locomotion', 'manipulator', 'actuator', 'exoskeleton'] },
  { slug: 'agricultural-robotics', nameEn: 'Agricultural Robotics', nameZh: '农业机器人', terms: ['agricultural robot', 'field robot', 'harvest', 'weed', 'orchard', 'agri-robot', 'greenhouse robot'] },
  { slug: 'agricultural-engineering', nameEn: 'Agricultural Engineering', nameZh: '农业工程', terms: ['agricultural engineering', 'tractor', 'planter', 'sprayer', 'tillage', 'agronomic', 'precision agriculture'] },
  { slug: 'control', nameEn: 'Control', nameZh: '控制', terms: ['control', 'controller', 'model predictive control', 'mpc', 'feedback', 'stability', 'robust control', 'lqr', 'trajectory tracking', 'whole-body control'] },
  { slug: 'reinforcement-learning', nameEn: 'Reinforcement Learning', nameZh: '强化学习', terms: ['reinforcement learning', 'policy gradient', 'reward shaping', 'actor-critic', 'deep rl', 'imitation learning', 'learning-based', 'sim-to-real', 'ppo'] },
  { slug: 'soil-water', nameEn: 'Soil & Water', nameZh: '土壤与水', terms: ['soil', 'water', 'irrigation', 'moisture', 'hydrology', 'drainage', 'fertigation', 'runoff', 'soil sensor'] },
  { slug: 'state-estimation', nameEn: 'State Estimation', nameZh: '状态估计', create: true, terms: ['state estimation', 'visual-inertial', 'visual inertial', 'odometry', 'localization', 'slam'] },
  { slug: 'computer-vision', nameEn: 'Computer Vision', nameZh: '计算机视觉', create: true, terms: ['computer vision', 'object detection', 'semantic segmentation', 'image segmentation', 'visual perception'] },
]

function normalized(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase().replace(/[\s_\-–—,，.。/]+/g, ' ').trim()
}

function slugFor(nameEn: string): string {
  const slug = nameEn.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug === '') throw new Error('FIELD_NAME_EN_REQUIRED')
  return slug
}

function requireNames(input: FieldInput): FieldInput {
  const nameEn = input.nameEn.trim()
  const nameZh = input.nameZh.trim()
  if (nameEn === '' || nameZh === '') throw new Error('FIELD_NAMES_REQUIRED')
  return { nameEn, nameZh }
}

function mapField(row: FieldRow): ResearchField {
  return { id: row.id, slug: row.slug, nameEn: row.name_en, nameZh: row.name_zh, createdBy: row.created_by, count: row.count ?? 0 }
}

function aliasesFor(input: FieldInput): string[] {
  return [...new Set([normalized(input.nameEn), normalized(input.nameZh)].filter(Boolean))]
}

function findByAlias(db: Db, value: string): FieldRow | undefined {
  return db.prepare(
    `SELECT c.id, c.slug, c.name_en, c.name_zh, c.created_by
     FROM category_aliases a JOIN categories c ON c.id = a.category_id
     WHERE a.normalized_name = ?`,
  ).get(normalized(value)) as FieldRow | undefined
}

function addAliases(db: Db, id: number, input: FieldInput): void {
  for (const alias of aliasesFor(input)) {
    const existing = db.prepare('SELECT category_id FROM category_aliases WHERE normalized_name = ?').get(alias) as { category_id: number } | undefined
    if (existing !== undefined && existing.category_id !== id) throw new Error('CATEGORY_NAME_CONFLICT')
    db.prepare('INSERT OR IGNORE INTO category_aliases (category_id, normalized_name) VALUES (?, ?)').run(id, alias)
  }
}

function ensureField(db: Db, input: FieldInput, slug: string, createdBy: 'system' | 'auto' | 'user'): ResearchField {
  const names = requireNames(input)
  const existing = findByAlias(db, names.nameEn) ?? findByAlias(db, names.nameZh)
  if (existing !== undefined) return mapField(existing)
  const sameSlug = db.prepare('SELECT id, slug, name_en, name_zh, created_by FROM categories WHERE slug = ?').get(slug) as FieldRow | undefined
  if (sameSlug !== undefined) return mapField(sameSlug)
  const result = db.prepare(
    "INSERT INTO categories (slug, name_en, name_zh, type, created_by) VALUES (?, ?, ?, 'field', ?)",
  ).run(slug, names.nameEn, names.nameZh, createdBy)
  const id = Number(result.lastInsertRowid)
  addAliases(db, id, names)
  return { id, slug, nameEn: names.nameEn, nameZh: names.nameZh, createdBy, count: 0 }
}

/** Seed the stable broad fields; idempotent and safe on every migration. */
export function ensureResearchFieldSeeds(db: Db): void {
  for (const field of SEED_FIELDS) ensureField(db, field, field.slug, 'system')
}

export function createResearchField(db: Db, input: FieldInput): ResearchField {
  const names = requireNames(input)
  return ensureField(db, names, slugFor(names.nameEn), 'user')
}

export function listResearchFields(db: Db): ResearchField[] {
  const rows = db.prepare(
    `SELECT c.id, c.slug, c.name_en, c.name_zh, c.created_by, COUNT(pc.paper_id) AS count
     FROM categories c
     LEFT JOIN paper_categories pc ON pc.category_id = c.id AND pc.state = 'active'
     LEFT JOIN papers p ON p.id = pc.paper_id AND ${libraryPaperExistsSql('p')}
     WHERE c.type = 'field' GROUP BY c.id ORDER BY c.name_en COLLATE NOCASE`,
  ).all() as unknown as FieldRow[]
  return rows.map(mapField)
}

export function listPaperFields(db: Db, paperId: string): PaperField[] {
  const rows = db.prepare(
    `SELECT c.id, c.slug, c.name_en, c.name_zh, c.created_by, pc.source, pc.confidence
     FROM paper_categories pc JOIN categories c ON c.id = pc.category_id
     WHERE pc.paper_id = ? AND pc.state = 'active' AND c.type = 'field'
     ORDER BY c.name_en COLLATE NOCASE`,
  ).all(paperId) as unknown as Array<FieldRow & { source: FieldSource; confidence: number | null }>
  return rows.map((row) => ({ ...mapField(row), source: row.source, confidence: row.confidence }))
}

function getField(db: Db, id: number): FieldRow {
  const row = db.prepare("SELECT id, slug, name_en, name_zh, created_by FROM categories WHERE id = ? AND type = 'field'").get(id) as FieldRow | undefined
  if (row === undefined) throw new Error('FIELD_NOT_FOUND')
  return row
}

export function renameResearchField(db: Db, id: number, input: FieldInput): ResearchField {
  const names = requireNames(input)
  const field = getField(db, id)
  for (const alias of aliasesFor(names)) {
    const other = db.prepare('SELECT category_id FROM category_aliases WHERE normalized_name = ?').get(alias) as { category_id: number } | undefined
    if (other !== undefined && other.category_id !== id) throw new Error('CATEGORY_NAME_CONFLICT')
  }
  db.prepare("UPDATE categories SET name_en = ?, name_zh = ?, updated_at = datetime('now') WHERE id = ?").run(names.nameEn, names.nameZh, id)
  addAliases(db, id, names)
  return { ...mapField({ ...field, name_en: names.nameEn, name_zh: names.nameZh }), count: 0 }
}

/** Manual add overrides an earlier auto assignment or manual exclusion. */
export function assignPaperField(db: Db, paperId: string, categoryId: number): void {
  getField(db, categoryId)
  if (db.prepare('SELECT 1 FROM papers WHERE id = ?').get(paperId) === undefined) throw new Error('PAPER_NOT_FOUND')
  db.prepare(
    `INSERT INTO paper_categories (paper_id, category_id, source, state, confidence)
     VALUES (?, ?, 'manual', 'active', 1)
     ON CONFLICT(paper_id, category_id) DO UPDATE SET
       source = 'manual', state = 'active', confidence = 1, updated_at = datetime('now')`,
  ).run(paperId, categoryId)
  db.prepare(
    `DELETE FROM paper_categories
     WHERE paper_id = ? AND source = 'auto'
       AND category_id = (SELECT id FROM categories WHERE slug = 'uncategorized')`,
  ).run(paperId)
}

/** Keep a manual exclusion tombstone so later metadata refreshes cannot re-add it. */
export function removePaperField(db: Db, paperId: string, categoryId: number): void {
  getField(db, categoryId)
  if (db.prepare('SELECT 1 FROM papers WHERE id = ?').get(paperId) === undefined) throw new Error('PAPER_NOT_FOUND')
  db.prepare(
    `INSERT INTO paper_categories (paper_id, category_id, source, state, confidence)
     VALUES (?, ?, 'manual', 'excluded', NULL)
     ON CONFLICT(paper_id, category_id) DO UPDATE SET
       source = 'manual', state = 'excluded', confidence = NULL, updated_at = datetime('now')`,
  ).run(paperId, categoryId)
}

/** Copy every relation while preserving the strongest existing manual intent. */
function transferFieldRelations(db: Db, sourceId: number, targetId: number): void {
  const rows = db.prepare(
    'SELECT paper_id, source, state, confidence FROM paper_categories WHERE category_id = ?',
  ).all(sourceId) as Array<{ paper_id: string; source: FieldSource; state: 'active' | 'excluded'; confidence: number | null }>
  for (const row of rows) {
    const target = db.prepare(
      'SELECT source, state FROM paper_categories WHERE paper_id = ? AND category_id = ?',
    ).get(row.paper_id, targetId) as { source: FieldSource; state: 'active' | 'excluded' } | undefined
    // A direct manual decision on the target wins. Otherwise, a source manual
    // decision becomes the target decision; only auto rows may be replaced.
    if (target?.source === 'manual') continue
    if (row.source === 'auto' && target !== undefined) continue
    db.prepare(
      `INSERT INTO paper_categories (paper_id, category_id, source, state, confidence)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(paper_id, category_id) DO UPDATE SET
         source = excluded.source, state = excluded.state, confidence = excluded.confidence, updated_at = datetime('now')`,
    ).run(row.paper_id, targetId, row.source, row.state, row.confidence)
  }
}

export function mergeResearchFields(db: Db, sourceId: number, targetId: number): void {
  if (sourceId === targetId) throw new Error('FIELD_MERGE_SAME_TARGET')
  getField(db, sourceId)
  getField(db, targetId)
  db.exec('BEGIN')
  try {
    transferFieldRelations(db, sourceId, targetId)
    db.prepare('DELETE FROM categories WHERE id = ?').run(sourceId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function deleteResearchField(db: Db, id: number, mode: 'detach' | 'move', targetId?: number): void {
  getField(db, id)
  const relationCount = db.prepare('SELECT COUNT(*) AS n FROM paper_categories WHERE category_id = ?').get(id) as { n: number }
  if (mode === 'move') {
    if (targetId === undefined || targetId === id) throw new Error('FIELD_MOVE_TARGET_REQUIRED')
    getField(db, targetId)
    db.exec('BEGIN')
    try {
      if (relationCount.n > 0) transferFieldRelations(db, id, targetId)
      db.prepare('DELETE FROM categories WHERE id = ?').run(id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(id)
}

function confidence(matchCount: number): number { return Math.min(.96, .76 + Math.max(0, matchCount - 1) * .08) }

/**
 * Classify one paper. Library papers get auto fields; retrieved-only
 * candidates are skipped entirely (and any stale auto assignment from
 * earlier versions is removed) so the candidate pool never pollutes
 * Research Fields. Manual active/excluded rows are never altered.
 */
export function resolvePaperFields(db: Db, paperId: string): void {
  ensureResearchFieldSeeds(db)
  const paper = db.prepare('SELECT title, abstract, venue, keywords FROM papers WHERE id = ?').get(paperId) as { title: string; abstract: string | null; venue: string | null; keywords: string | null } | undefined
  if (paper === undefined) return
  if (!isLibraryPaper(db, paperId)) {
    // Retrieved-only candidate: no auto classification. Purge any stale auto
    // rows a pre-separation version may have written; manual intent survives.
    db.prepare("DELETE FROM paper_categories WHERE paper_id = ? AND source = 'auto'").run(paperId)
    return
  }
  const topic = db.prepare(
    `SELECT pu.topic FROM candidates c JOIN pushes pu ON pu.id = c.push_id
     WHERE c.paper_id = ? ORDER BY pu.id DESC LIMIT 1`,
  ).get(paperId) as { topic: string } | undefined
  // Keywords (extracted from the PDF or enriched) are first-class
  // classification text — they often carry the strongest topical signal.
  let keywords = ''
  try {
    const parsed: unknown = JSON.parse(paper.keywords ?? '[]')
    if (Array.isArray(parsed)) keywords = parsed.filter((v): v is string => typeof v === 'string').join(' ')
  } catch { /* legacy plain-text keywords tolerated */ }
  const text = normalized(`${paper.title} ${paper.abstract ?? ''} ${paper.venue ?? ''} ${keywords} ${topic?.topic ?? ''}`)
  const matches = AUTO_RULES.map((rule) => ({ rule, n: rule.terms.filter((term) => text.includes(normalized(term))).length })).filter((match) => match.n > 0)
  const autoIds: number[] = []
  for (const { rule, n } of matches) {
    const field = ensureField(db, rule, rule.slug, rule.create === true ? 'auto' : 'system')
    autoIds.push(field.id)
    db.prepare(
      `INSERT INTO paper_categories (paper_id, category_id, source, state, confidence)
       VALUES (?, ?, 'auto', 'active', ?)
       ON CONFLICT(paper_id, category_id) DO UPDATE SET
         state = 'active', confidence = excluded.confidence, updated_at = datetime('now')
       WHERE paper_categories.source = 'auto'`,
    ).run(paperId, field.id, confidence(n))
  }
  if (autoIds.length === 0) {
    const manualActive = db.prepare("SELECT 1 FROM paper_categories WHERE paper_id = ? AND source = 'manual' AND state = 'active'").get(paperId)
    if (manualActive === undefined) {
      const uncategorized = ensureField(db, SEED_FIELDS.find((field) => field.slug === 'uncategorized')!, 'uncategorized', 'system')
      autoIds.push(uncategorized.id)
      db.prepare(
        `INSERT INTO paper_categories (paper_id, category_id, source, state, confidence)
         VALUES (?, ?, 'auto', 'active', .4)
         ON CONFLICT(paper_id, category_id) DO UPDATE SET state = 'active', confidence = .4, updated_at = datetime('now')
         WHERE paper_categories.source = 'auto'`,
      ).run(paperId, uncategorized.id)
    }
  }
  const keep = autoIds.length > 0 ? `AND category_id NOT IN (${autoIds.map(() => '?').join(',')})` : ''
  db.prepare(`DELETE FROM paper_categories WHERE paper_id = ? AND source = 'auto' ${keep}`).run(paperId, ...autoIds)
}

/** One-time v16 migration backfill; repeated calls remain relation-idempotent. */
export function backfillResearchFields(db: Db): void {
  ensureResearchFieldSeeds(db)
  const papers = db.prepare('SELECT id FROM papers').all() as Array<{ id: string }>
  for (const paper of papers) resolvePaperFields(db, paper.id)
}

/**
 * Library-scope backfill for pre-separation data: removes auto category
 * assignments of retrieved-only papers that never entered the library.
 * Manual assignments and everything attached to library papers are kept.
 * Returns the number of auto relations cleaned. Relation-idempotent.
 */
export function cleanRetrievedOnlyAutoCategories(db: Db): number {
  ensureResearchFieldSeeds(db)
  const result = db.prepare(
    `DELETE FROM paper_categories WHERE source = 'auto' AND paper_id IN (
       SELECT p.id FROM papers p WHERE NOT ${libraryPaperExistsSql('p')}
     )`,
  ).run()
  return Number(result.changes)
}
