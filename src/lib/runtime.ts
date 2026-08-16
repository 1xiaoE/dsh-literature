/**
 * Runtime assembly: config + sqlite + source registry + data dirs, created
 * lazily on first tool use (plugin apply stays side-effect free). Also wires
 * the institutional-access PdfProviders (CARSI) that the fetch pipeline
 * consults only after every public/open-access candidate has failed.
 */
import type { LiteratureConfig } from '../config.js'
import type { Db } from '../db.js'
import { openDb } from '../db.js'
import { dataDirs, ensureDataDir, expandHome } from './paths.js'
import { createRegistry, type SourceRegistry } from '../sources/registry.js'
import { CarsiPdfProvider } from '../providers/carsi.js'
import type { PdfProvider } from '../providers/types.js'
import { PerfTracker } from './perf.js'

export interface LiteratureRuntime {
  cfg: LiteratureConfig
  db: Db
  registry: SourceRegistry
  dataDir: string
  pdfsDir: string
  cacheDir: string
  /** fetch implementation (injectable for tests); defaults to global fetch */
  fetchImpl: typeof fetch
  /**
   * Institutional / licensed-access providers. Invoked by the fetch pipeline
   * ONLY after the public open-access chain failed for the picked paper
   * (strict low frequency is enforced inside the providers + tools).
   */
  providers: PdfProvider[]
  /** typed CARSI provider handle (session status / login CLI); null when disabled */
  carsi: CarsiPdfProvider | null
  /** per-push performance accumulator (retrieval/ranking/pdf/read timings) */
  perf: PerfTracker
}

export function createRuntime(cfg: LiteratureConfig, opts: { fetchImpl?: typeof fetch } = {}): LiteratureRuntime {
  const dataDir = ensureDataDir(cfg)
  const db = openDb(dataDir)
  const fetchImpl = opts.fetchImpl ?? fetch
  const registry = createRegistry({
    fetchImpl,
    timeoutMs: cfg.http.timeoutMs,
    unpaywallEmail: cfg.http.unpaywallEmail,
  })
  const carsi = new CarsiPdfProvider({
    dataDir,
    enabled: cfg.carsi.enabled,
    minIntervalMinutes: cfg.carsi.minIntervalMinutes,
    headless: cfg.carsi.headless,
    timeoutMs: cfg.carsi.timeoutMs,
    profileDir: cfg.carsi.profileDir ? expandHome(cfg.carsi.profileDir) : undefined,
    userAgent: cfg.carsi.userAgent,
  })
  return {
    cfg,
    db,
    registry,
    dataDir,
    pdfsDir: dataDirs(dataDir).pdfs,
    cacheDir: dataDirs(dataDir).cache,
    fetchImpl,
    providers: cfg.carsi.enabled ? [carsi] : [],
    carsi: cfg.carsi.enabled ? carsi : null,
    perf: new PerfTracker(),
  }
}
