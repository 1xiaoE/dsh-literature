import { existsSync, statSync } from 'node:fs'
import type { LiteratureConfig } from '../config.js'
import type { Db } from '../db.js'
import { getStage, recordPaperInStage, stageDef } from './stages.js'

export interface ReadingCoverage {
  totalChunks: number
  readChunks: number
  readCoverage: number
  coverageBasis: 'full_read' | 'index_exposed' | 'read_log'
}

export function readingCoverage(db: Db, pushId: number, paperId: string): ReadingCoverage {
  const ft = db
    .prepare("SELECT chunk_count FROM fulltexts WHERE paper_id = ? AND status = 'ok'")
    .get(paperId) as { chunk_count: number } | undefined
  const total = ft?.chunk_count ?? 0
  const readRow = db
    .prepare('SELECT COUNT(DISTINCT seq) AS n FROM fulltext_reads WHERE push_id = ? AND paper_id = ?')
    .get(pushId, paperId) as { n: number }
  const read = readRow?.n ?? 0
  if (total <= 0) return { totalChunks: 0, readChunks: 0, readCoverage: 0, coverageBasis: 'read_log' }
  const rawCoverage = Math.min(1, read / total)
  return {
    totalChunks: total,
    readChunks: read,
    readCoverage: Math.round(rawCoverage * 100) / 100,
    coverageBasis: read >= total ? 'full_read' : 'index_exposed',
  }
}

export interface FinalizeCompletedInput {
  pushId: number
  paperId: string
  reportPath: string
  knowledgeGoals?: string[]
  advanceStage?: boolean
  notes?: string
  modelRoute?: string | null
}

export interface FinalizeCompletedResult {
  coverage: ReadingCoverage
  duplicate: boolean
  stageMatched: boolean
  stageAdvanced: boolean
  pendingRequiredGoals: string[]
}

/**
 * Single durable completion path shared by literature_record and deterministic
 * resume. It validates report/full-read/quality/selection, marks picked,
 * persists goal coverage and advances the curriculum stage exactly once.
 */
export function finalizeCompletedPush(
  db: Db,
  cfg: LiteratureConfig,
  input: FinalizeCompletedInput,
): FinalizeCompletedResult {
  const push = db
    .prepare('SELECT id, topic, stage, status, report_path FROM pushes WHERE id = ?')
    .get(input.pushId) as
    | { id: number; topic: string; stage: number; status: string; report_path: string | null }
    | undefined
  if (!push) throw new Error(`push #${input.pushId} 不存在`)
  if (push.status === 'completed') throw new Error(`push #${input.pushId} 已 completed，拒绝重复 finalize`)

  const reportPath = input.reportPath || push.report_path || ''

  // Validate research/selection invariants before filesystem/report checks so
  // failures explain the real workflow violation (missing score, wrong rank,
  // incomplete reading) instead of being masked by a later missing artifact.
  const cand = db
    .prepare(
      `SELECT stage_relevance_score, curriculum_value, selection_outcome, acquisition_outcome
       FROM candidates WHERE push_id = ? AND paper_id = ?`,
    )
    .get(input.pushId, input.paperId) as
    | {
        stage_relevance_score: number | null
        curriculum_value: number | null
        selection_outcome: string | null
        acquisition_outcome: string | null
      }
    | undefined
  if (!cand) throw new Error(`论文 ${input.paperId} 不属于 push #${input.pushId}`)
  if (cand.stage_relevance_score === null || cand.curriculum_value === null) {
    throw new Error(`评分缺失：论文 ${input.paperId} 必须同时提供 stageRelevance 与 curriculumValue`)
  }
  if (cand.stage_relevance_score < cfg.stageRelevanceThreshold) {
    throw new Error(`stage_relevance_score=${cand.stage_relevance_score} 低于阈值 ${cfg.stageRelevanceThreshold}`)
  }
  if (cand.curriculum_value < cfg.curriculumValueThreshold) {
    throw new Error(`curriculum_value=${cand.curriculum_value} 低于阈值 ${cfg.curriculumValueThreshold}`)
  }
  if (cand.selection_outcome !== 'SELECTED' && cand.acquisition_outcome !== 'SELECTED') {
    throw new Error(`picked 论文 ${input.paperId} 尚未被 acquisition 状态机标记为 SELECTED`)
  }

  const coverage = readingCoverage(db, input.pushId, input.paperId)
  if (coverage.totalChunks <= 0) {
    throw new Error(`picked 论文 ${input.paperId} 无已索引全文，不能 completed`)
  }
  const rawCoverage = coverage.totalChunks > 0 ? coverage.readChunks / coverage.totalChunks : 0
  if (rawCoverage + Number.EPSILON < cfg.fulltext.minReadCoverage) {
    throw new Error(
      `全文阅读覆盖不足：${coverage.readChunks}/${coverage.totalChunks}=${rawCoverage.toFixed(3)} < minReadCoverage=${cfg.fulltext.minReadCoverage}；完成前继续 literature_fulltext_read`,
    )
  }
  if (!reportPath || !existsSync(reportPath) || !statSync(reportPath).isFile() || statSync(reportPath).size <= 0) {
    throw new Error(`completed 必须有已存在、为文件且非空的 canonical 报告：${reportPath || '无路径'}`)
  }

  const def = stageDef(cfg.stageOrder, push.stage)
  if (!def && cfg.stageOrder.length > 0) {
    throw new Error(`push #${input.pushId} 的阶段 ${push.stage} 超出 stageOrder 范围（共 ${cfg.stageOrder.length} 个阶段），无法确定 requiredGoals`)
  }

  const duplicate = Boolean(
    db
      .prepare(
        `SELECT 1 FROM candidates c JOIN pushes p ON p.id = c.push_id
         WHERE p.topic = ? AND c.paper_id = ? AND c.picked = 1 AND p.status = 'completed' AND p.id <> ? LIMIT 1`,
      )
      .get(push.topic, input.paperId, input.pushId),
  )

  let advanced = false
  let pendingRequired: string[] = []
  const goals = [...new Set(input.knowledgeGoals ?? [])]

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE candidates SET picked = 1, selection_outcome = \'SELECTED\', acquisition_outcome = \'SELECTED\' WHERE push_id = ? AND paper_id = ?')
      .run(input.pushId, input.paperId)

    if (!duplicate && goals.length > 0) {
      const ins = db.prepare('INSERT OR IGNORE INTO knowledge_coverage (push_id, paper_id, goal) VALUES (?, ?, ?)')
      for (const g of goals) ins.run(input.pushId, input.paperId, g)
    }

    if (!duplicate) {
      const res = recordPaperInStage(db, push.topic, {
        targetPapers: cfg.targetPapersPerStage,
        minCoverage: cfg.minKnowledgeCoverage,
        coveredGoals: goals,
        forceAdvance: input.advanceStage ?? false,
        requiredGoals: def?.requiredGoals ?? [],
      })
      advanced = res.advanced
      pendingRequired = res.pendingRequired
    } else if (input.advanceStage) {
      const res = recordPaperInStage(db, push.topic, {
        targetPapers: cfg.targetPapersPerStage,
        minCoverage: cfg.minKnowledgeCoverage,
        forceAdvance: true,
      })
      advanced = res.advanced
    }

    db.prepare(
      `UPDATE pushes SET status = 'completed', finished_at = datetime('now'), paper_id = ?,
         report_path = ?, error_code = NULL, error_detail = NULL,
         notes = CASE WHEN ? IS NULL OR ? = '' THEN notes
                      ELSE COALESCE(NULLIF(notes, ''), '') || ' ' || ? END,
         model_route = COALESCE(?, model_route),
         total_chunks = ?, read_chunks = ?, read_coverage = ?, coverage_basis = ?
       WHERE id = ?`,
    ).run(
      input.paperId,
      reportPath,
      input.notes ?? null,
      input.notes ?? null,
      input.notes ?? null,
      input.modelRoute ?? null,
      coverage.totalChunks,
      coverage.readChunks,
      coverage.readCoverage,
      coverage.coverageBasis,
      input.pushId,
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return {
    coverage,
    duplicate,
    stageMatched: true,
    stageAdvanced: advanced,
    pendingRequiredGoals: pendingRequired,
  }
}

export function currentStageSnapshot(db: Db, topic: string) {
  return getStage(db, topic)
}
