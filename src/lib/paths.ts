/**
 * Path resolution. Code and data are separated: code lives in the repo,
 * runtime data defaults to ~/dsh-literature/Data.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { LiteratureConfig } from '../config.js'
import type { Db } from '../db.js'

/** Expand a leading `~` to the user home directory. */
export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** Default runtime data location, intentionally outside the source repository. */
export const DEFAULT_DATA_DIR = join(homedir(), 'dsh-literature', 'Data')

/** Resolve the runtime data dir from config (or the isolated default). */
export function resolveDataDir(config: LiteratureConfig): string {
  return config.dataDir ? expandHome(config.dataDir) : DEFAULT_DATA_DIR
}

/** Resolve the literature library root (report archive). */
export function resolveLibraryRoot(config: LiteratureConfig): string {
  // Canonical storage: the data dir reports path. Desktop/library exports are
  // handled by an outer script or Zotero sync, never by relaxing the sandbox.
  if (config.libraryRoot) return expandHome(config.libraryRoot)
  return join(resolveDataDir(config), 'reports')
}

/** Absolute paths of the runtime subdirectories. */
export function dataDirs(dataDir: string): {
  pdfs: string
  cache: string
  fulltext: string
  reports: string
} {
  return {
    pdfs: join(dataDir, 'pdfs'),
    cache: join(dataDir, 'cache'),
    fulltext: join(dataDir, 'fulltext'),
    reports: join(dataDir, 'reports'),
  }
}

/** Ensure the data dir tree exists; returns the data dir. */
export function ensureDataDir(config: LiteratureConfig): string {
  const dir = resolve(resolveDataDir(config))
  for (const d of [dir, dataDirs(dir).pdfs, dataDirs(dir).cache, dataDirs(dir).fulltext, dataDirs(dir).reports]) {
    mkdirSync(d, { recursive: true })
  }
  return dir
}

/** Repair PDF references left behind when the runtime data directory moves. */
export function repairPdfPaths(db: Db, dataDir: string): number {
  const pdfDir = dataDirs(resolve(dataDir)).pdfs
  const rows = db.prepare(
    "SELECT pdf_path FROM fetch_log WHERE outcome IN ('ok','PDF_OK') AND pdf_path IS NOT NULL AND pdf_path <> ''",
  ).all() as unknown as Array<{ pdf_path: string }>
  let repaired = 0
  for (const row of rows) {
    const candidate = join(pdfDir, basename(row.pdf_path))
    if (!existsSync(candidate)) continue
    if (row.pdf_path === candidate) continue
    db.prepare('UPDATE fetch_log SET pdf_path = ? WHERE pdf_path = ?').run(candidate, row.pdf_path)
    repaired += 1
  }
  return repaired
}
