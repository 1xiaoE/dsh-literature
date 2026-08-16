/**
 * Tool: literature_sources — search candidates via all SourceAdapters,
 * merge/dedup, run deterministic pre-ranking (Stage A) with configurable
 * weights, persist papers + candidates for the push, and return the Top N.
 * Stage B (semantic ranking) is the agent's job.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { upsertPaper, type PaperRow } from '../db.js'
import { preRank, type PreRankResult } from '../lib/ranking.js'
import { currentYear } from '../config.js'
import { seenPaperIds, startPush } from '../lib/history.js'
import { ensureStage, getStage, stageLabel } from '../lib/stages.js'
import type { PaperRef } from '../sources/types.js'
import { canonicalId } from '../sources/types.js'

export interface SourcesInput {
  topic?: string
  years?: number[]
  limit?: number
  pushId?: number
}

export interface SourcesOutput {
  pushId: number
  topic: string
  stage: number
  stageLabel: string
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
    fulltextAvailable: boolean
    recencyScore: number
    impactScore: number
    topicSimilarity: number
    preRankScore: number
    rankHint: number
  }>
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
    abstract: paper.abstract ?? null,
    citations: paper.citations ?? null,
    bibtex: null,
    metadata_source: paper.metadataSource,
  }
}

/** Cheap availability heuristic for pre-ranking; the fetch tool verifies for real. */
function quickPdfAvailability(paper: PaperRef): boolean {
  return Boolean(paper.arxivId || paper.url)
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
    abstract: row.abstract ?? undefined,
    citations: row.citations ?? undefined,
    metadataSource: row.metadata_source,
  }
}

export function defineLiteratureSources(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_sources',
    description:
      '检索主题候选论文（arXiv/OpenAlex/Crossref 多源合并去重），运行确定性预排序（时效/影响力/主题相似度/全文可得性，权重可配置）并落库，返回 Top N 候选供语义排序。',
    parameters: {
      topic: { type: 'string', description: '主题，缺省用配置默认主题' },
      years: {
        type: 'array',
        items: { type: 'integer' },
        description: '优先年份列表，缺省用配置（近5年）',
      },
      limit: { type: 'integer', description: '每源检索上限（默认 20）' },
      pushId: { type: 'integer', description: '复用已开始的推送号；缺省自动新建推送' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pushId: { type: 'integer', required: true },
          topic: { type: 'string', required: true },
          stage: { type: 'integer', required: true },
          stageLabel: { type: 'string', required: true },
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
                fulltextAvailable: { type: 'boolean', required: true },
                recencyScore: { type: 'number', required: true },
                impactScore: { type: 'number', required: true },
                topicSimilarity: { type: 'number', required: true },
                preRankScore: { type: 'number', required: true },
                rankHint: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: SourcesOutput) => [
        {
          type: 'text',
          text: `push #${value.pushId} 主题「${value.topic}」阶段「${value.stageLabel}」：共 ${value.total} 篇候选，预排序 Top ${value.candidates.length}：\n` +
            value.candidates
              .map(
                (c, i) =>
                  `${i + 1}. [${c.isSeen ? '已读' : '新'}] ${c.title} (${c.year ?? '?'}, 引用 ${c.citations ?? '?'}, 预排序 ${c.preRankScore.toFixed(3)}, 全文可得 ${c.fulltextAvailable})`,
              )
              .join('\n'),
        },
      ],
    },
    async execute(args: SourcesInput) {
      const rt = getRt()
      const { db, cfg } = rt
      const topic = args.topic ?? cfg.topics[0] ?? '足式机器人控制'
      const years = args.years && args.years.length > 0 ? args.years : cfg.yearsPrefer
      const limit = args.limit ?? 20

      let pushId = args.pushId
      if (pushId === undefined) {
        const stage = ensureStage(db, topic, cfg.targetPapersPerStage)
        pushId = startPush(db, topic, stage.current).pushId
      }
      const stage = getStage(db, topic)

      const papers = await rt.registry.search({ topic, years, limit })
      const seen = seenPaperIds(db, topic)
      const now = currentYear()

      const insertCandidate = db.prepare(
        `INSERT INTO candidates
           (push_id, paper_id, rank_hint, picked, recency_score, impact_score,
            topic_similarity, fulltext_available, is_seen)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(push_id, paper_id) DO UPDATE SET
           recency_score=excluded.recency_score, impact_score=excluded.impact_score,
           topic_similarity=excluded.topic_similarity,
           fulltext_available=excluded.fulltext_available, is_seen=excluded.is_seen`,
      )

      const rows: Array<{ paper: PaperRef; pre: PreRankResult; isSeen: boolean }> = []
      for (const paper of papers) {
        const id = canonicalId(paper)
        upsertPaper(db, paperToRow(paper))
        const isSeen = seen.has(id)
        const pre = preRank(
          {
            title: paper.title,
            abstract: paper.abstract,
            year: paper.year,
            citations: paper.citations,
            fulltextAvailable: quickPdfAvailability(paper),
          },
          cfg,
          now,
        )
        rows.push({ paper, pre, isSeen })
      }
      rows.sort((a, b) => b.pre.score - a.pre.score)

      const topN = rows.slice(0, Math.max(1, cfg.preRankTopN))
      for (let i = 0; i < topN.length; i += 1) {
        const { paper, pre, isSeen } = topN[i]!
        insertCandidate.run(
          pushId,
          canonicalId(paper),
          i + 1,
          pre.recencyScore,
          pre.impactScore,
          pre.topicSimilarity,
          pre.fulltextAvailable ? 1 : 0,
          isSeen ? 1 : 0,
        )
      }

      return {
        pushId,
        topic,
        stage: stage.current,
        stageLabel: stageLabel(cfg.stageOrder, stage.current),
        total: rows.length,
        candidates: topN.map(({ paper, pre, isSeen }, i) =>
          clean({
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
            fulltextAvailable: pre.fulltextAvailable,
            recencyScore: pre.recencyScore,
            impactScore: pre.impactScore,
            topicSimilarity: pre.topicSimilarity,
            preRankScore: pre.score,
            rankHint: i + 1,
          }),
        ),
      } satisfies SourcesOutput
    },
  })
}
