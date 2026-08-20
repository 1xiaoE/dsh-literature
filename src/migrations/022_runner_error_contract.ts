import type { Db } from '../db.js'

/** v22: structured provider-neutral runner error fields. */
export default function up(db: Db): void {
  for (const statement of [
    'ALTER TABLE runner_jobs ADD COLUMN error_code TEXT',
    'ALTER TABLE runner_jobs ADD COLUMN retryable INTEGER',
    'ALTER TABLE runner_jobs ADD COLUMN provider TEXT',
    'ALTER TABLE runner_jobs ADD COLUMN model TEXT',
  ]) {
    try { db.exec(statement) } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error
    }
  }
}
