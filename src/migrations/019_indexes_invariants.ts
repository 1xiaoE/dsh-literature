import type { Db } from '../db.js'

/** v19: query hot-path indexes + hard Quality-First invariants (unique agent ranks / single SELECTED per push). */
export default function up(db: Db): void {
  // Query hot-path indexes + hard Quality-First invariants. The unique
  // constraints are only created after repairing any legacy rank
  // collisions: a (push_id, agent_rank) pair may keep at most one row —
  // SELECTED rows win, then the highest final_score. Losing rows get
  // agent_rank NULL (the candidate record itself is preserved).
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_candidates_paper ON candidates(paper_id);
CREATE INDEX IF NOT EXISTS idx_candidates_push ON candidates(push_id);
CREATE INDEX IF NOT EXISTS idx_candidates_selection ON candidates(push_id, selection_outcome);
CREATE INDEX IF NOT EXISTS idx_candidates_rank ON candidates(push_id, agent_rank) WHERE agent_rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_retrievals_paper ON retrievals(paper_id);
CREATE INDEX IF NOT EXISTS idx_retrievals_push ON retrievals(push_id);
CREATE INDEX IF NOT EXISTS idx_fetch_log_paper ON fetch_log(paper_id);
CREATE INDEX IF NOT EXISTS idx_fetch_log_sha ON fetch_log(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fulltext_reads_paper ON fulltext_reads(paper_id);
CREATE INDEX IF NOT EXISTS idx_fulltext_reads_seq ON fulltext_reads(paper_id, seq);
CREATE INDEX IF NOT EXISTS idx_reports_paper ON reports(paper_id);
`)
  // Repair duplicate agent_rank rows before enforcing uniqueness.
  const dupes = db.prepare(
    `SELECT push_id, agent_rank FROM candidates
     WHERE agent_rank IS NOT NULL
     GROUP BY push_id, agent_rank HAVING COUNT(*) > 1`,
  ).all() as Array<{ push_id: number; agent_rank: number }>
  for (const d of dupes) {
    const rows = db.prepare(
      `SELECT paper_id, final_score, selection_outcome FROM candidates
       WHERE push_id = ? AND agent_rank = ? ORDER BY
         CASE WHEN selection_outcome = 'SELECTED' THEN 0 ELSE 1 END,
         COALESCE(final_score, 0) DESC`,
    ).all(d.push_id, d.agent_rank) as Array<{ paper_id: string; final_score: number | null; selection_outcome: string | null }>
    for (const loser of rows.slice(1)) {
      db.prepare(
        `UPDATE candidates SET agent_rank = NULL WHERE push_id = ? AND paper_id = ?`,
      ).run(d.push_id, loser.paper_id)
    }
  }
  db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_selected ON candidates(push_id) WHERE selection_outcome = 'SELECTED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_agent_rank ON candidates(push_id, agent_rank) WHERE agent_rank IS NOT NULL;
`)
}
