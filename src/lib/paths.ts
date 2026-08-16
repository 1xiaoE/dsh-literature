/**
 * Path resolution. Code and data are separated: code lives in the repo,
 * runtime data under the XDG data directory (default ~/.local/share/dsh-literature).
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LiteratureConfig } from '../config.js'

/** Expand a leading `~` to the user home directory. */
export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** Resolve the runtime data dir from config (or XDG default). */
export function resolveDataDir(config: LiteratureConfig): string {
  if (config.dataDir) return expandHome(config.dataDir)
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'dsh-literature')
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
