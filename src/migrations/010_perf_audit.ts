import type { Db } from '../db.js'

/** v10: performance audit — per-phase timings + candidate/LLM metrics on pushes. */
export default function up(db: Db): void {
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
