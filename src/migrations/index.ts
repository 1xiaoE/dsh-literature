/**
 * Migration registry: every schema migration, keyed by its target version.
 * migrate() in ../db.js runs these in version order for any DB whose
 * user_version is below the migration's version.
 */
import type { Db } from '../db.js'

import up001 from './001_base_schema.js'
import up002 from './002_stage_relevance.js'
import up003 from './003_retrievals.js'
import up004 from './004_curriculum_coverage.js'
import up005 from './005_agent_rank.js'
import up006 from './006_oa_pdf_reads_aliases.js'
import up007 from './007_carsi_fetchlog.js'
import up008 from './008_user_actions.js'
import up009 from './009_correctness_closeout.js'
import up010 from './010_perf_audit.js'
import up011 from './011_openalex_auth.js'
import up012 from './012_arxiv_scheduler.js'
import up013 from './013_resume_provenance.js'
import up014 from './014_manual_pdf.js'
import up015 from './015_quality_first.js'
import up016 from './016_research_fields.js'
import up017 from './017_library_imports.js'
import up018 from './018_library_pool.js'
import up019 from './019_indexes_invariants.js'
import up020 from './020_reports_version_history.js'
import up021 from './021_runner_jobs.js'

export interface Migration {
  version: number
  up: (db: Db) => void
}

export const migrations: Migration[] = [
  { version: 1, up: up001 },
  { version: 2, up: up002 },
  { version: 3, up: up003 },
  { version: 4, up: up004 },
  { version: 5, up: up005 },
  { version: 6, up: up006 },
  { version: 7, up: up007 },
  { version: 8, up: up008 },
  { version: 9, up: up009 },
  { version: 10, up: up010 },
  { version: 11, up: up011 },
  { version: 12, up: up012 },
  { version: 13, up: up013 },
  { version: 14, up: up014 },
  { version: 15, up: up015 },
  { version: 16, up: up016 },
  { version: 17, up: up017 },
  { version: 18, up: up018 },
  { version: 19, up: up019 },
  { version: 20, up: up020 },
  { version: 21, up: up021 },
].sort((a, b) => a.version - b.version)
