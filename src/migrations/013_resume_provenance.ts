import type { Db } from '../db.js'

/** v13: deterministic resume provenance (0-LLM finalize path). */
export default function up(db: Db): void {
  // Deterministic resume provenance (0-LLM finalize path).
  const cols = db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>
  const add = (name: string, ddl: string): void => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE pushes ADD COLUMN ${ddl};`)
  }
  add('resume_ms', 'resume_ms INTEGER')
  add('resume_llm_call_count', 'resume_llm_call_count INTEGER')
}
