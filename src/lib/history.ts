/**
 * Recommendation history / dedup. "Seen" means the paper was picked in a
 * completed push. Seen papers are flagged in candidates (is_seen) and the
 * agent is expected to avoid re-picking them.
 */
import type { Db } from '../db.js'

/** ids of papers already picked in completed pushes (per topic). */
export function seenPaperIds(db: Db, topic: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT c.paper_id FROM candidates c
       JOIN pushes p ON p.id = c.push_id
       WHERE p.topic = ? AND c.picked = 1 AND p.status = 'completed'`,
    )
    .all(topic) as Array<{ paper_id: string }>
  return new Set(rows.map((r) => r.paper_id))
}

/** number of completed picks for a topic (for provenance in reports). */
export function completedPushCount(db: Db, topic: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM pushes WHERE topic = ? AND status = 'completed'`)
    .get(topic) as { n: number }
  return row.n
}

export interface PushStartResult {
  pushId: number
  topic: string
  stage: number
}

/** Open a new push row (status running); supersede stale running pushes of the same topic. */
export function startPush(
  db: Db,
  topic: string,
  stage: number,
  modelRoute?: string | null,
): PushStartResult {
  db.prepare(
    `UPDATE pushes SET status = 'failed', finished_at = datetime('now'),
       error_code = 'superseded', error_detail = 'superseded by push at ' || datetime('now')
     WHERE topic = ? AND status = 'running'`,
  ).run(topic)
  const info = db
    .prepare('INSERT INTO pushes (topic, stage, status, model_route) VALUES (?, ?, \'running\', ?)')
    .run(topic, stage, modelRoute ?? null)
  return { pushId: Number(info.lastInsertRowid), topic, stage }
}

export function getPush(db: Db, pushId: number): { topic: string; stage: number; status: string } | undefined {
  return db.prepare('SELECT topic, stage, status FROM pushes WHERE id = ?').get(pushId) as
    | { topic: string; stage: number; status: string }
    | undefined
}
