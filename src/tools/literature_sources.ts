/**
 * Tool: literature_sources — Literature Query Planner driven retrieval:
 *
 * 1. topic + current stage → planned queries (English; canonical/secondary/
 *    stage-search terms; recent + landmark pools planned separately).
 * 2. RecentPool (recent_years window) and LandmarkPool (year-unconstrained,
 *    eligibility-scored, capped) are retrieved independently, tagged and
 *    merged; negative terms drop off-topic hits.
 * 3. Deterministic pre-ranking (recency/impact/topic-similarity/fulltext +
 *    stage relevance hint) keeps the Top N for agent semantic ranking.
 * 4. Full retrieval provenance (generated_query / language / source /
 *    retrieval_score / pool / retrieved_at) is persisted per hit.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { upsertPaper, type PaperRow } from '../db.js'
import {
  preRank,
  stageRelevanceHint,
  curriculumHint,
  landmarkConfidence,
  knowledgeGapHint,
  priorityGoalMatchScore,
  type PreRankResult,
  type StageRelevanceResult,
} from '../lib/ranking.js'
import { currentYear, type TopicDef } from '../config.js'
import { seenPaperIds, startPush } from '../lib/history.js'
import { ensureStage, getStage, stageLabel, stageDef } from '../lib/stages.js'
import { planQueries, resolveTopic, applyNegativeFilter, landmarkEligibility, matchSeed, decidePriorityGoal } from '../lib/planner.js'
import type { PaperRef, PlannedQuery } from '../sources/types.js'
import { canonicalId } from '../sources/types.js'
import { mergeWithLabels, type RetrievalProvenance } from '../sources/registry.js'
import { inRetryCooldown } from '../fetch/pdf.js'

export interface SourcesInput {
  topic?: string
  years?: number[]
  limit?: number
  pushId?: number
}

export interface SourcesOutput {
  pushId: number
  topicId: string
  topicDisplayName: string
  stage: number
  stageLabel: string
  stageScope: string
  stagePreferredKeywords: string[]
  stageDownweightKeywords: string[]
  stageExcludeKeywords: string[]
  stageRelevanceThreshold: number
  curriculumValueThreshold: number
  coveredGoals: string[]
  uncoveredGoals: Array<{ id: string; label: string }>
  priorityGoal?: { id: string; label: string }
  /** 'completion' = required-goal completion mode (priority goal pinned to a pending required goal) */
  priorityGoalMode: 'normal' | 'completion'
  /** required goals still uncovered — the stage cannot graduate until these are covered */
  pendingRequiredGoals: string[]
  queriesGenerated: Array<{ text: string; kind: string; pool: string }>
  rawCount: number
  dedupedCount: number
  recentCount: number
  landmarkCount: number
  negativeDropped: number
  offTopicDropped: number
  total: number
  candidates: Array<{
    paperId: string
    title: string
    year?: number
    venue?: string
    authors: string[]
    doi?: string
    arxivId?: string
    url?: string
    citations?: number
    abstract?: string
    isSeen: boolean
    candidatePool: 'recent' | 'landmark'
    fulltextAvailable: boolean
    recencyScore: number
    impactScore: number
    topicSimilarity: number
    preRankScore: number
    stageRelevanceHint: number
    stageExcluded: boolean
    matchedPreferred: string[]
    matchedDownweight: string[]
    curriculumHint: number
    landmarkConfidence: number
    knowledgeGapHint: number
    knowledgeGapGoals: string[]
    priorityGoalMatch: number
    inCooldown: boolean
    retrieval: Array<{ source: string; query: string; score?: number }>
    rankHint: number
  }>
}

/** Omit keys whose value is undefined — tool output must be lossless JSON. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
}

/** Convert a stored row back to the PaperRef shape the adapters understand. */
export function rowToRef(row: PaperRow): PaperRef {
  return {
    id: row.id,
    title: row.title,
    authors: (() => {
      try {
        return (JSON.parse(row.authors ?? '[]') as string[])
      } catch {
        return []
      }
    })(),
    venue: row.venue ?? undefined,
    year: row.year ?? undefined,
    doi: row.doi ?? undefined,
    arxivId: row.arxiv_id ?? undefined,
    openalexId: row.openalex_id ?? undefined,
    url: row.url ?? undefined,
    oaPdfUrl: row.oa_pdf_url ?? undefined,
    abstract: row.abstract ?? undefined,
    citations: row.citations ?? undefined,
    metadataSource: row.metadata_source,
  }
}

function paperToRow(paper: PaperRef): PaperRow {
  return {
    id: canonicalId(paper),
    title: paper.title,
    authors: JSON.stringify(paper.authors),
    venue: paper.venue ?? null,
    year: paper.year ?? null,
    doi: paper.doi ?? null,
    arxiv_id: paper.arxivId ?? null,
    openalex_id: paper.openalexId ?? null,
    url: paper.url ?? null,
    oa_pdf_url: paper.oaPdfUrl ?? null,
    abstract: paper.abstract ?? null,
    citations: paper.citations ?? null,
    bibtex: null,
    metadata_source: paper.metadataSource,
  }
}

/** Cheap availability heuristic for pre-ranking; only real PDF signals count. */
function quickPdfAvailability(paper: PaperRef): boolean {
  return Boolean(paper.arxivId || paper.oaPdfUrl)
}

export function defineLiteratureSources(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_sources',
    description:
      'Query Planner 驱动的候选检索：topic+stage 生成英文查询（Recent/Landmark 双池独立检索、合并去重、负向词过滤），确定性预排序后返回 Top N 供 agent 语义排序。输出全部生成查询与检索溯源。',
    parameters: {
      topic: { type: 'string', description: '主题 id 或显示名，缺省用配置默认主题' },
      years: {
        type: 'array',
        items: { type: 'integer' },
        description: '覆盖 recent 池年份（一般不需要）',
      },
      limit: { type: 'integer', description: '每源每查询上限（默认用配置）' },
      pushId: { type: 'integer', description: '复用已开始的推送号；缺省自动新建推送' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pushId: { type: 'integer', required: true },
          topicId: { type: 'string', required: true },
          topicDisplayName: { type: 'string', required: true },
          stage: { type: 'integer', required: true },
          stageLabel: { type: 'string', required: true },
          stageScope: { type: 'string', required: true },
          stagePreferredKeywords: { type: 'array', items: { type: 'string' }, required: true },
          stageDownweightKeywords: { type: 'array', items: { type: 'string' }, required: true },
          stageExcludeKeywords: { type: 'array', items: { type: 'string' }, required: true },
          stageRelevanceThreshold: { type: 'number', required: true },
          curriculumValueThreshold: { type: 'number', required: true },
          coveredGoals: { type: 'array', items: { type: 'string' }, required: true },
          priorityGoal: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string', required: true }, label: { type: 'string', required: true } },
          },
          priorityGoalMode: { type: 'string', required: true, enum: ['normal', 'completion'] },
          pendingRequiredGoals: { type: 'array', items: { type: 'string' }, required: true },
          uncoveredGoals: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
              },
            },
          },
          queriesGenerated: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                pool: { type: 'string', required: true },
              },
            },
          },
          rawCount: { type: 'integer', required: true },
          dedupedCount: { type: 'integer', required: true },
          recentCount: { type: 'integer', required: true },
          landmarkCount: { type: 'integer', required: true },
          negativeDropped: { type: 'integer', required: true },
          offTopicDropped: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paperId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                year: { type: 'integer' },
                venue: { type: 'string' },
                authors: { type: 'array', items: { type: 'string' }, required: true },
                doi: { type: 'string' },
                arxivId: { type: 'string' },
                url: { type: 'string' },
                citations: { type: 'integer' },
                abstract: { type: 'string' },
                isSeen: { type: 'boolean', required: true },
                candidatePool: { type: 'string', required: true, enum: ['recent', 'landmark'] },
                fulltextAvailable: { type: 'boolean', required: true },
                recencyScore: { type: 'number', required: true },
                impactScore: { type: 'number', required: true },
                topicSimilarity: { type: 'number', required: true },
                preRankScore: { type: 'number', required: true },
                stageRelevanceHint: { type: 'number', required: true },
                stageExcluded: { type: 'boolean', required: true },
                matchedPreferred: { type: 'array', items: { type: 'string' }, required: true },
                matchedDownweight: { type: 'array', items: { type: 'string' }, required: true },
                curriculumHint: { type: 'number', required: true },
                landmarkConfidence: { type: 'number', required: true },
                knowledgeGapHint: { type: 'number', required: true },
                knowledgeGapGoals: { type: 'array', items: { type: 'string' }, required: true },
                priorityGoalMatch: { type: 'number', required: true },
                inCooldown: { type: 'boolean', required: true },
                retrieval: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      source: { type: 'string', required: true },
                      query: { type: 'string', required: true },
                      score: { type: 'number' },
                    },
                  },
                },
                rankHint: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: SourcesOutput) => [
        {
          type: 'text',
          text: `push #${value.pushId} 主题「${value.topicDisplayName}」阶段「${value.stageLabel}」：raw ${value.rawCount} → 去重 ${value.dedupedCount}（recent ${value.recentCount} / landmark ${value.landmarkCount}，负向过滤 ${value.negativeDropped}，离题 ${value.offTopicDropped}），Top ${value.candidates.length}：\n` +
            value.candidates
              .map(
                (c, i) =>
                  `${i + 1}. [${c.candidatePool === 'landmark' ? 'L' : 'R'}${c.isSeen ? '·已读' : ''}] ${c.title} (${c.year ?? '?'}, 引用 ${c.citations ?? '?'}, 预排序 ${c.preRankScore.toFixed(3)}, 阶段契合 ${c.stageRelevanceHint.toFixed(2)})`,
              )
              .join('\n'),
        },
      ],
    },
    async execute(args: SourcesInput): Promise<SourcesOutput> {
      const rt = getRt()
      const { db, cfg } = rt
      const topic: TopicDef = resolveTopic(cfg.topics, args.topic)
      const years = args.years && args.years.length > 0 ? args.years : cfg.yearsPrefer

      let pushId = args.pushId
      if (pushId === undefined) {
        const stage = ensureStage(db, topic.id, cfg.targetPapersPerStage)
        pushId = startPush(db, topic.id, stage.current).pushId
      }
      const stage = getStage(db, topic.id)
      const def = stageDef(cfg.stageOrder, stage.current)
      const covered = new Set(stage.coveredGoals)
      const uncoveredGoals = (def?.knowledgeGoals ?? []).filter((g) => !covered.has(g.id))

      // --- planner: queries per pool ---
      const recentQueries = planQueries(topic, def, 'recent')
      const landmarkQueries = planQueries(topic, def, 'landmark')

      // --- retrieve both pools independently (performance: retrieval phase) ---
      const tRetrievalStart = performance.now()
      const recent = await rt.registry.searchPool(cfg, recentQueries, def, 'recent')
      const landmark = await rt.registry.searchPool(cfg, landmarkQueries, def, 'landmark')
      const tRankingStart = performance.now()

      // --- negative terms filter (before merge) ---
      const negRecent = applyNegativeFilter(recent.papers, topic.negativeTerms)
      const negLandmark = applyNegativeFilter(landmark.papers, topic.negativeTerms)
      const recentPapers = negRecent.kept as PaperRef[]
      const landmarkPapers = negLandmark.kept as PaperRef[]
      const negativeDropped = negRecent.dropped + negLandmark.dropped

      // --- merge with pool tagging (recent wins the label) ---
      const merged = mergeWithLabels([
        ...recentPapers.map((paper) => ({ paper, pool: 'recent' as const })),
        ...landmarkPapers.map((paper) => ({ paper, pool: 'landmark' as const })),
      ])

      const seen = seenPaperIds(db, topic.id)
      const now = currentYear()
      let offTopicDropped = 0

      const insertCandidate = db.prepare(
        `INSERT INTO candidates
           (push_id, paper_id, rank_hint, picked, recency_score, impact_score,
            topic_similarity, fulltext_available, stage_relevance_hint,
            priority_goal_match, candidate_pool, is_seen)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(push_id, paper_id) DO UPDATE SET
           recency_score=excluded.recency_score, impact_score=excluded.impact_score,
           topic_similarity=excluded.topic_similarity,
           fulltext_available=excluded.fulltext_available,
           stage_relevance_hint=excluded.stage_relevance_hint,
           priority_goal_match=excluded.priority_goal_match,
           candidate_pool=excluded.candidate_pool, is_seen=excluded.is_seen`,
      )
      const insertRetrieval = db.prepare(
        `INSERT INTO retrievals
           (push_id, paper_id, generated_query, query_language, source_adapter,
            retrieval_score, candidate_pool, auth_mode, retrieved_at)
         VALUES (?, ?, ?, 'en', ?, ?, ?, ?, datetime('now'))`,
      )

      // provenance bookkeeping: paperId (pre-merge canonical) → provenance rows
      const provByPaper = new Map<string, RetrievalProvenance[]>()
      for (const prov of [...recent.provenance, ...landmark.provenance]) {
        const list = provByPaper.get(prov.paperId) ?? []
        list.push(prov)
        provByPaper.set(prov.paperId, list)
      }

      const rows: Array<{
        paper: PaperRef
        pool: 'recent' | 'landmark'
        pre: PreRankResult
        sr: StageRelevanceResult
        curriculum: number
        landmarkConf: number
        gapGoals: string[]
        pgMatch: number
        inCooldown: boolean
        isSeen: boolean
        prov: RetrievalProvenance[]
      }> = []
      const pgDecision = def
        ? decidePriorityGoal(def, covered, stage.papersInStage, cfg.targetPapersPerStage)
        : { goal: undefined, mode: 'normal' as const, pendingRequired: [] }
      for (const { paper, pool } of merged) {
        const id = canonicalId(paper)
        upsertPaper(db, paperToRow(paper))
        const isSeen = seen.has(id)
        const text = `${paper.title} ${paper.abstract ?? ''}`
        const sr = def
          ? stageRelevanceHint(text, def)
          : { score: 0.5, excluded: false, matchedPreferred: [], matchedDownweight: [] }
        const seedMatch = Boolean(def && matchSeed(paper, def.landmarkSeeds))
        const chRaw = curriculumHint(text, paper.venue)
        // curated seeds are curriculum anchors: floor their curriculum hint
        const ch = seedMatch ? { score: Math.max(chRaw.score, 0.75), reasons: [...chRaw.reasons, 'curated-seed'] } : chRaw
        const gap = knowledgeGapHint(text, uncoveredGoals)
        const el = landmarkEligibility(
          { citations: paper.citations, venue: paper.venue, stageHint: sr.score, stageMatched: sr.matchedPreferred.length },
          cfg,
        )
        const lc = landmarkConfidence({
          eligibilityScore: el.score,
          stageHint: sr.score,
          impact: paper.citations !== undefined ? Math.min(1, Math.log10(paper.citations + 1) / 3) : 0,
          venue: paper.venue ? 1 : 0,
          seedMatch,
        })
        const priorityGoal = pgDecision.goal
        const pgMatch = priorityGoal
          ? priorityGoalMatchScore(text, priorityGoal)
          : { score: 0, matched: [] }
        const cooldownUntil = inRetryCooldown(db, id, cfg.fulltext.retryCooldownHours)
        const fulltextAvailable = quickPdfAvailability(paper) && cooldownUntil === null
        const pre = preRank(
          {
            title: paper.title,
            abstract: paper.abstract,
            year: paper.year,
            citations: paper.citations,
            fulltextAvailable,
            stageRelevance: sr.score,
            knowledgeGap: uncoveredGoals.length > 0 ? gap.score / uncoveredGoals.length : 0,
            priorityGoalMatch: pgMatch.score,
          },
          cfg,
          { topicText: topic.canonicalQueries.join(' '), currentYear: now },
          pool,
        )
        const prov = provByPaper.get(id) ?? []
        if (pre.topicSimilarity < cfg.retrieval.minTopicSimilarity) {
          offTopicDropped += 1
          continue
        }
        rows.push({ paper, pool, pre, sr, curriculum: ch.score, landmarkConf: lc, gapGoals: gap.matched, pgMatch: pgMatch.score, inCooldown: cooldownUntil !== null, isSeen, prov })
        if (prov.length > 0) {
          for (const p of prov) {
            insertRetrieval.run(pushId, id, p.query, p.source, p.retrievalScore, pool, p.authMode ?? null)
          }
        } else {
          insertRetrieval.run(
            pushId,
            id,
            recentQueries[0]?.text ?? '',
            'unknown',
            null,
            pool,
            null,
          )
        }
      }
      rows.sort((a, b) => b.pre.score - a.pre.score)
      const tRankingEnd = performance.now()

      const topN = rows.slice(0, Math.max(1, cfg.preRankTopN))
      for (let i = 0; i < topN.length; i += 1) {
        const { paper, pool, pre, sr, pgMatch, isSeen } = topN[i]!
        insertCandidate.run(
          pushId,
          canonicalId(paper),
          i + 1,
          pre.recencyScore,
          pre.impactScore,
          pre.topicSimilarity,
          pre.fulltextAvailable ? 1 : 0,
          sr.score,
          pgMatch,
          pool,
          isSeen ? 1 : 0,
        )
      }

      rt.perf.add(pushId, {
        retrievalMs: tRankingStart - tRetrievalStart,
        deterministicRankingMs: tRankingEnd - tRankingStart,
        rawCandidates: recent.rawCount + landmark.rawCount,
        deterministicCandidates: rows.length,
      })

      return {
        pushId,
        topicId: topic.id,
        topicDisplayName: topic.displayName,
        stage: stage.current,
        stageLabel: stageLabel(cfg.stageOrder, stage.current),
        stageScope: def?.scope ?? '',
        stagePreferredKeywords: def?.preferredKeywords ?? [],
        stageDownweightKeywords: def?.downweightKeywords ?? [],
        stageExcludeKeywords: def?.excludeKeywords ?? [],
        stageRelevanceThreshold: cfg.stageRelevanceThreshold,
        curriculumValueThreshold: cfg.curriculumValueThreshold,
        coveredGoals: [...covered],
        uncoveredGoals: uncoveredGoals.map((g) => ({ id: g.id, label: g.label })),
        priorityGoal: pgDecision.goal
          ? { id: pgDecision.goal.id, label: pgDecision.goal.label }
          : undefined,
        priorityGoalMode: pgDecision.mode,
        pendingRequiredGoals: pgDecision.pendingRequired,
        queriesGenerated: [...recentQueries, ...landmarkQueries].map((q) => ({
          text: q.text,
          kind: q.kind,
          pool: q.pool,
        })),
        rawCount: recent.rawCount + landmark.rawCount,
        dedupedCount: merged.length,
        recentCount: merged.filter((m) => m.pool === 'recent').length,
        landmarkCount: merged.filter((m) => m.pool === 'landmark').length,
        negativeDropped,
        offTopicDropped,
        total: rows.length,
        candidates: topN.map(({ paper, pool, pre, sr, curriculum, landmarkConf, gapGoals, pgMatch, inCooldown, isSeen, prov }, i) => {
          return clean({
            paperId: canonicalId(paper),
            title: paper.title,
            year: paper.year,
            venue: paper.venue,
            authors: paper.authors,
            doi: paper.doi,
            arxivId: paper.arxivId,
            url: paper.url,
            citations: paper.citations,
            abstract: paper.abstract,
            isSeen,
            candidatePool: pool,
            fulltextAvailable: pre.fulltextAvailable,
            recencyScore: pre.recencyScore,
            impactScore: pre.impactScore,
            topicSimilarity: pre.topicSimilarity,
            preRankScore: pre.score,
            stageRelevanceHint: sr.score,
            stageExcluded: sr.excluded,
            matchedPreferred: sr.matchedPreferred,
            matchedDownweight: sr.matchedDownweight,
            curriculumHint: curriculum,
            landmarkConfidence: landmarkConf,
            knowledgeGapHint: uncoveredGoals.length > 0 ? gapGoals.length / uncoveredGoals.length : 0,
            knowledgeGapGoals: gapGoals,
            priorityGoalMatch: pgMatch,
            inCooldown: inCooldown,
            retrieval: prov.map((p) =>
              clean({
                source: p.source,
                query: p.query,
                score: p.retrievalScore ?? undefined,
              }),
            ),
            rankHint: i + 1,
          })
        }),
      } satisfies SourcesOutput
    },
  })
}
