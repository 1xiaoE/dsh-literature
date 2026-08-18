import type { Db } from '../db.js'

/** v9: correctness closeout — priority_goal_match → REAL, coverage provenance on pushes, candidates rebuild. */
export default function up(db: Db): void {
  // V0.1 correctness closeout:
  // - candidates.priority_goal_match: INTEGER → REAL (0..1 match strength;
  //   the value is now actually written by literature_sources — previously
  //   the column existed but was never inserted, so it stayed DEFAULT 0);
  // - pushes gains full-text reading coverage provenance columns
  //   (total_chunks / read_chunks / read_coverage / coverage_basis) so a
  //   completed push's report can state the exact coverage basis.
  const cols = (db.prepare('PRAGMA table_info(candidates)').all() as Array<{ name: string }>).map((c) => c.name)
  // Column definitions mirror schema.sql so the rebuilt table keeps every
  // declared type/constraint (SQLite would otherwise lose them on rebuild).
  const colDef = (name: string): string => {
    switch (name) {
      case 'push_id':
        return 'INTEGER NOT NULL REFERENCES pushes(id) ON DELETE CASCADE'
      case 'paper_id':
        return 'TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE'
      case 'rank_hint':
      case 'recency_score':
      case 'impact_score':
      case 'topic_similarity':
      case 'relevance_score':
      case 'learning_value_score':
      case 'representative_score':
      case 'novelty_score':
      case 'final_score':
      case 'stage_relevance_hint':
      case 'stage_relevance_score':
      case 'curriculum_hint':
      case 'curriculum_value':
      case 'landmark_confidence':
      case 'methodological_centrality':
        return 'REAL'
      case 'priority_goal_match':
        return 'REAL NOT NULL DEFAULT 0'
      case 'candidate_pool':
        return "TEXT NOT NULL DEFAULT 'recent' CHECK (candidate_pool IN ('recent','landmark'))"
      case 'picked':
      case 'fulltext_available':
      case 'is_seen':
        return 'INTEGER NOT NULL DEFAULT 0'
      case 'agent_rank':
      case 'preflight_attempt_order':
        return 'INTEGER'
      case 'selection_outcome':
      case 'selection_rejection_reason':
      case 'rationale':
        return 'TEXT'
      default:
        return ''
    }
  }
  const quoted = cols.map((c) => `"${c}"`)
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec(
      `CREATE TABLE candidates_new (
  ${cols.map((c) => `  "${c}" ${colDef(c)}`).join(',\n')},
  PRIMARY KEY (push_id, paper_id)
);`,
    )
    db.exec(
      `INSERT INTO candidates_new (${quoted.join(',')})
       SELECT ${quoted.join(',')} FROM candidates;`,
    )
    db.exec('DROP TABLE candidates;')
    db.exec('ALTER TABLE candidates_new RENAME TO candidates;')
    const pushCols = db.prepare('PRAGMA table_info(pushes)').all() as Array<{ name: string }>
    const add = (name: string, ddl: string): void => {
      if (!pushCols.some((c) => c.name === name)) db.exec(`ALTER TABLE pushes ADD COLUMN ${ddl};`)
    }
    add('total_chunks', 'total_chunks INTEGER')
    add('read_chunks', 'read_chunks INTEGER')
    add('read_coverage', 'read_coverage REAL')
    add('coverage_basis', "coverage_basis TEXT CHECK (coverage_basis IS NULL OR coverage_basis IN ('full_read','index_exposed','read_log'))")
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
