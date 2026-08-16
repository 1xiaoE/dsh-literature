/**
 * Literature Agent configuration. All deployment-varying choices are
 * configurable via the plugin row config (cordis patch); no hardcoded tunables
 * beyond protocol/external-spec constants. Contains NO model ids — model
 * routing is owned by the harness (ctx.llm / agentDefaultModel).
 */

export interface RankingWeights {
  /** weight of recency_score (deterministic pre-ranking) */
  recency: number
  /** weight of impact_score (citation signal) */
  impact: number
  /** weight of topic_similarity (keyword overlap) */
  topicSimilarity: number
  /** weight of fulltext_available (open PDF obtainable) */
  fulltextAvailability: number
}

export interface AgentRankingWeights {
  relevance: number
  learningValue: number
  representativeness: number
  novelty: number
}

export interface LiteratureConfig {
  /** default topic(s); the first is used when a tool call omits topic */
  topics: string[]
  /** root of the literature library (output/archive target) */
  libraryRoot: string
  /** XDG data dir for db/pdfs/cache; empty string resolves to the default */
  dataDir: string
  /** preferred publication years (recency); empty computes last 5 years */
  yearsPrefer: number[]
  /** papers per push (1 per spec) */
  perPush: number
  /** reading-stage order (progression) */
  stageOrder: string[]
  /** how many completed picks gate an automatic stage advance */
  targetPapersPerStage: number
  /** deterministic pre-ranking keeps the top N candidates */
  preRankTopN: number
  ranking: RankingWeights
  agentRanking: AgentRankingWeights
  fulltext: {
    /** max chars per chunk handed to the agent (token safety) */
    maxChunkChars: number
    /** below this many chars the extracted text is treated as unavailable */
    minChars: number
    /** full-text parser command */
    parserCommand: string
  }
  http: {
    /** per-request timeout for source adapters and PDF downloads (ms) */
    timeoutMs: number
    /** minimum bytes for a plausible PDF */
    minPdfBytes: number
  }
}

export const DEFAULT_STAGE_ORDER = [
  '基础控制',
  '动力学/接触控制',
  'MPC',
  'RL locomotion',
  '鲁棒控制',
  'terrain adaptation',
  'sim-to-real',
  '前沿方法',
] as const

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  recency: 0.2,
  impact: 0.25,
  topicSimilarity: 0.3,
  fulltextAvailability: 0.25,
}

export const DEFAULT_AGENT_RANKING_WEIGHTS: AgentRankingWeights = {
  relevance: 0.4,
  learningValue: 0.3,
  representativeness: 0.2,
  novelty: 0.1,
}

/** Recency window used when config.yearsPrefer is empty. */
export const RECENCY_WINDOW_YEARS = 5

/** @returns the current UTC year. */
export function currentYear(): number {
  return new Date().getUTCFullYear()
}

/** Default config with yearsPrefer computed from the current year. */
export function defaultConfig(): LiteratureConfig {
  const now = currentYear()
  const years: number[] = []
  for (let y = now - RECENCY_WINDOW_YEARS + 1; y <= now; y += 1) years.push(y)
  return {
    topics: ['足式机器人控制'],
    libraryRoot: '~/Desktop/文献阅读',
    dataDir: '',
    yearsPrefer: years,
    perPush: 1,
    stageOrder: [...DEFAULT_STAGE_ORDER],
    targetPapersPerStage: 2,
    preRankTopN: 10,
    ranking: { ...DEFAULT_RANKING_WEIGHTS },
    agentRanking: { ...DEFAULT_AGENT_RANKING_WEIGHTS },
    fulltext: { maxChunkChars: 6000, minChars: 200, parserCommand: 'pdftotext' },
    http: { timeoutMs: 30000, minPdfBytes: 10240 },
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function pickNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function pickString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function pickStringArray(obj: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const v = obj[key]
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
    return v as string[]
  }
  return [...fallback]
}

function pickNumberArray(obj: Record<string, unknown>, key: string, fallback: number[]): number[] {
  const v = obj[key]
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number')) {
    return v as number[]
  }
  return [...fallback]
}

/** Merge a partial (from cordis plugin config) over defaults, per-field. */
export function normalizeConfig(partial: Partial<LiteratureConfig> | undefined): LiteratureConfig {
  const base = defaultConfig()
  if (!partial) return base
  const out: LiteratureConfig = {
    topics: pickStringArray(partial, 'topics', base.topics),
    libraryRoot: pickString(partial, 'libraryRoot', base.libraryRoot),
    dataDir: pickString(partial, 'dataDir', base.dataDir),
    yearsPrefer: pickNumberArray(partial, 'yearsPrefer', base.yearsPrefer),
    perPush: pickNumber(partial, 'perPush', base.perPush),
    stageOrder: pickStringArray(partial, 'stageOrder', base.stageOrder),
    targetPapersPerStage: pickNumber(partial, 'targetPapersPerStage', base.targetPapersPerStage),
    preRankTopN: pickNumber(partial, 'preRankTopN', base.preRankTopN),
    ranking: { ...base.ranking },
    agentRanking: { ...base.agentRanking },
    fulltext: { ...base.fulltext },
    http: { ...base.http },
  }
  if (isRecord(partial.ranking)) {
    out.ranking = {
      recency: pickNumber(partial.ranking, 'recency', base.ranking.recency),
      impact: pickNumber(partial.ranking, 'impact', base.ranking.impact),
      topicSimilarity: pickNumber(partial.ranking, 'topicSimilarity', base.ranking.topicSimilarity),
      fulltextAvailability: pickNumber(
        partial.ranking,
        'fulltextAvailability',
        base.ranking.fulltextAvailability,
      ),
    }
  }
  if (isRecord(partial.agentRanking)) {
    out.agentRanking = {
      relevance: pickNumber(partial.agentRanking, 'relevance', base.agentRanking.relevance),
      learningValue: pickNumber(
        partial.agentRanking,
        'learningValue',
        base.agentRanking.learningValue,
      ),
      representativeness: pickNumber(
        partial.agentRanking,
        'representativeness',
        base.agentRanking.representativeness,
      ),
      novelty: pickNumber(partial.agentRanking, 'novelty', base.agentRanking.novelty),
    }
  }
  if (isRecord(partial.fulltext)) {
    out.fulltext = {
      maxChunkChars: pickNumber(partial.fulltext, 'maxChunkChars', base.fulltext.maxChunkChars),
      minChars: pickNumber(partial.fulltext, 'minChars', base.fulltext.minChars),
      parserCommand: pickString(partial.fulltext, 'parserCommand', base.fulltext.parserCommand),
    }
  }
  if (isRecord(partial.http)) {
    out.http = {
      timeoutMs: pickNumber(partial.http, 'timeoutMs', base.http.timeoutMs),
      minPdfBytes: pickNumber(partial.http, 'minPdfBytes', base.http.minPdfBytes),
    }
  }
  return out
}
