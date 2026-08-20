/**
 * Literature Agent configuration. All deployment-varying choices are
 * configurable via the plugin row config (cordis patch); no hardcoded tunables
 * beyond protocol/external-spec constants. Contains NO model ids — model
 * routing is owned by the harness (ctx.llm / agentDefaultModel).
 *
 * Curriculum data (topics + stage progression) lives in pluggable presets
 * (src/presets) so the core stays domain-agnostic; these re-exports keep
 * existing imports working unchanged.
 */
import { DEFAULT_STAGES, DEFAULT_TOPICS } from './presets/index.js'

export { DEFAULT_STAGES, DEFAULT_TOPICS }

export interface RankingWeights {
  /** weight of recency_score (deterministic pre-ranking) */
  recency: number
  /** weight of impact_score (citation signal) */
  impact: number
  /** weight of topic_similarity (keyword overlap) */
  topicSimilarity: number
  /** weight of fulltext_available (open PDF obtainable) */
  fulltextAvailability: number
  /** weight of the deterministic stage relevance hint */
  stageRelevance: number
  /** weight of the uncovered-knowledge-goal hint */
  knowledgeGap: number
  /** weight of the priority-goal match hint */
  priorityGoal: number
}

export interface AgentRankingWeights {
  relevance: number
  learningValue: number
  representativeness: number
  novelty: number
  /** weight of the agent-assigned stage_relevance_score */
  stageRelevance: number
  /** weight of the agent-assigned curriculum_value_score */
  curriculumValue: number
}

/** One knowledge goal of a stage; papers are tagged with covered goals. */
export interface KnowledgeGoal {
  id: string
  label: string
  /** keywords used for the deterministic gap hint */
  keywords: string[]
}

/** One reading stage: scope + keyword guidance for stage relevance. */
export interface StageDef {
  label: string
  /** what this stage covers (shown to the agent) */
  scope: string
  /** concepts that make a paper a good fit for this stage */
  preferredKeywords: string[]
  /** concepts that lower the fit */
  downweightKeywords: string[]
  /** concepts that disqualify a paper for this stage (stage_relevance = 0) */
  excludeKeywords: string[]
  /** stage-specific retrieval queries (English, combined with topic queries) */
  searchQueries: string[]
  /** knowledge goals for stage progress (coverage-gated advancement) */
  knowledgeGoals: KnowledgeGoal[]
  /**
   * Goal ids that MUST be covered before the stage can graduate, regardless
   * of paper count. When papers_in_stage reaches targetPapers - 1 and a
   * required goal is still pending, the stage enters required-goal
   * completion mode (priority goal pinned to the pending required goal).
   * Empty = no hard requirement (ordinary stages).
   */
  requiredGoals: string[]
  /** curated landmark seeds as retrieval/curriculum anchors (title/doi/arxiv + goals) */
  landmarkSeeds: Array<{ doi?: string; arxivId?: string; title: string; goals: string[] }>
  /** optional per-stage override of the curriculum_value weight (Fundamentals boost) */
  curriculumWeight?: number
}

/**
 * A normalized topic. The user may type Chinese, but academic retrieval uses
 * the English canonical/secondary queries; the display name is for tracking.
 */
export interface TopicDef {
  id: string
  displayName: string
  /** primary academic queries (English) */
  canonicalQueries: string[]
  /** secondary queries (English) */
  secondaryQueries: string[]
  /** candidates matching any negative term are dropped at merge time */
  negativeTerms: string[]
}

export interface RetrievalConfig {
  /** recent pool window in years */
  recentYears: number
  /** per (source, query) result limit */
  perQueryLimit: number
  /** max landmark candidates admitted to the merged pool */
  landmarkMaxCandidates: number
  /** minimum deterministic landmark-eligibility score */
  landmarkMinScore: number
  /** minimum stage_relevance_hint for landmark eligibility */
  landmarkMinHint: number
  /** candidates with lower topic similarity are dropped as off-topic noise */
  minTopicSimilarity: number
  /** maximum planned queries per pool for normal retrieval adapters (0 = unlimited) */
  maxQueriesPerPool: number
  /** stricter per-pool query budget for the rate-limited arXiv API (0 = unlimited) */
  arxivMaxQueriesPerPool: number
  /** bounded concurrency for non-arXiv retrieval adapters */
  sourceConcurrency: number
}

export interface LiteratureConfig {
  /** normalized topics (Chinese display name + English queries); first is default */
  topics: TopicDef[]
  /**
   * Report archive root. Empty string resolves to the canonical data-dir
   * reports path (~/dsh-literature/Data/reports). Desktop/library
   * exports are handled by an outer script or Zotero sync, never by the
   * plugin relaxing the harness sandbox.
   */
  libraryRoot: string
  /** Isolated data dir for db/pdfs/cache/reports; empty string resolves to ~/dsh-literature/Data */
  dataDir: string
  /** preferred publication years (recency); empty computes from retrieval.recentYears */
  yearsPrefer: number[]
  /** papers per push (1 per spec) */
  perPush: number
  /** reading-stage progression with scope + keyword guidance */
  stageOrder: StageDef[]
  /** how many stage-matched completed picks gate an automatic stage advance */
  targetPapersPerStage: number
  /** minimum agent stage_relevance_score for a paper to be pickable as Top 1 */
  stageRelevanceThreshold: number
  /** minimum agent curriculum_value_score for a paper to be pickable as Top 1 */
  curriculumValueThreshold: number
  /** deterministic pre-ranking keeps the top N candidates for the agent */
  preRankTopN: number
  /** how many top candidates the full-text preflight tries before giving up */
  maxSelectionAttempts: number
  /** minimum knowledge goals covered before a stage can advance */
  minKnowledgeCoverage: number
  /** retrieval pool configuration (recent / landmark) */
  retrieval: RetrievalConfig
  ranking: RankingWeights
  agentRanking: AgentRankingWeights
  fulltext: {
    /** max chars per chunk handed to the agent (token safety) */
    maxChunkChars: number
    /** below this many chars the extracted text is treated as unavailable */
    minChars: number
    /** full-text parser command */
    parserCommand: string
    /** hours a FULLTEXT_UNAVAILABLE outcome stays in retry cooldown */
    retryCooldownHours: number
    /** minimum fraction of indexed chunks that must be read before completion (0..1) */
    minReadCoverage: number
  }
  http: {
    /** per-request timeout for source adapters and PDF downloads (ms) */
    timeoutMs: number
    /** minimum bytes for a plausible PDF */
    minPdfBytes: number
    /** email required by the Unpaywall legal-OA locator */
    unpaywallEmail: string
  }
  carsi: {
    /**
     * Master switch for the CARSI institutional-access fallback.
     *
     * LEGACY / EXPERIMENTAL — DISABLED BY DEFAULT. The CARSI portal
     * auto-navigation workflow is no longer part of the normal acquisition
     * chain (see publisherBrowser). Kept for history and tests only; normal
     * pushes never invoke CARSI unless explicitly re-enabled here.
     *
     * CARSI is NOT an OA source (access_type=institutional,
     * is_open_access=false) and is only ever used AFTER the whole public
     * chain failed, for papers that already passed the ranking quality gates.
     */
    enabled: boolean
    /** max CARSI-involved papers per push (strict low frequency; 1 = the picked paper only) */
    maxPerPush: number
    /** minimum minutes between CARSI browser attempts */
    minIntervalMinutes: number
    /** headless for cron pushes; the login CLI forces a headed browser */
    headless: boolean
    /** per-attempt browser timeout (ms) */
    timeoutMs: number
    /** persistent profile dir override; empty = <dataDir>/browser-profile */
    profileDir: string
    /** desktop User-Agent for the browser (SPs often block automation UAs) */
    userAgent: string
  }
  /**
   * Generic publisher-browser institutional access (replaces CARSI as the
   * non-OA acquisition path). Quality First, Access Second: papers are ranked
   * on academic merit; fulltext is acquired rank-by-rank afterwards.
   *
   * Flow: paper DOI / publisher URL → dedicated persistent browser →
   * publisher article page → PDF. DOI direct resolution is preferred; when a
   * login wall appears the workflow parks as AUTH_REQUIRED and the user
   * completes a legal login in a headed browser (bin/dsh-literature-browser-login).
   *
   * Uses the SAME persistent profile as the (legacy) CARSI provider:
   * ~/dsh-literature/Data/browser-profile/ — never the user's daily
   * browser cookies. Sessions are reused across pushes until they expire.
   */
  publisherBrowser: {
    /** master switch; default true (CARSI default false) */
    enabled: boolean
    /** max publisher-browser-involved papers per push (strict low frequency) */
    maxPerPush: number
    /** minimum minutes between browser attempts */
    minIntervalMinutes: number
    /** headless for cron pushes; the login CLI forces a headed browser */
    headless: boolean
    /** per-attempt browser timeout (ms) */
    timeoutMs: number
    /** persistent profile dir override; empty = <dataDir>/browser-profile */
    profileDir: string
    /** desktop User-Agent for the browser (SPs often block automation UAs) */
    userAgent: string
  }
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  recency: 0.15,
  impact: 0.15,
  topicSimilarity: 0.15,
  // OA/fulltext availability is NOT an academic-quality signal. It only hints
  // at acquisition cost; quality must be decided on merit first (Quality
  // First, Access Second). Kept at a near-zero floor so it can never let an
  // easily-downloadable but weaker OA paper outrank a stronger non-OA one.
  fulltextAvailability: 0.03,
  stageRelevance: 0.2,
  knowledgeGap: 0.1,
  priorityGoal: 0.1,
}

export const DEFAULT_AGENT_RANKING_WEIGHTS: AgentRankingWeights = {
  relevance: 0.3,
  learningValue: 0.2,
  representativeness: 0.15,
  novelty: 0.1,
  stageRelevance: 0.15,
  curriculumValue: 0.1,
}

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  recentYears: 5,
  perQueryLimit: 8,
  landmarkMaxCandidates: 6,
  landmarkMinScore: 0.35,
  landmarkMinHint: 0.25,
  minTopicSimilarity: 0.1,
  maxQueriesPerPool: 8,
  arxivMaxQueriesPerPool: 4,
  sourceConcurrency: 4,
}

/** Recency window used when config.yearsPrefer is empty. */
export const RECENCY_WINDOW_YEARS = 5

/** Default desktop Chrome User-Agent for the CARSI browser session. */
export const DEFAULT_CARSI_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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
    topics: DEFAULT_TOPICS.map((t) => ({
      ...t,
      canonicalQueries: [...t.canonicalQueries],
      secondaryQueries: [...t.secondaryQueries],
      negativeTerms: [...t.negativeTerms],
    })),
    libraryRoot: '',
    dataDir: '',
    yearsPrefer: years,
    perPush: 1,
    stageOrder: DEFAULT_STAGES.map((s) => ({
      ...s,
      preferredKeywords: [...s.preferredKeywords],
      downweightKeywords: [...s.downweightKeywords],
      excludeKeywords: [...s.excludeKeywords],
      searchQueries: [...s.searchQueries],
    })),
    targetPapersPerStage: 3,
    stageRelevanceThreshold: 0.6,
    curriculumValueThreshold: 0.5,
    preRankTopN: 15,
    maxSelectionAttempts: 8,
    minKnowledgeCoverage: 3,
    retrieval: { ...DEFAULT_RETRIEVAL },
    ranking: { ...DEFAULT_RANKING_WEIGHTS },
    agentRanking: { ...DEFAULT_AGENT_RANKING_WEIGHTS },
    fulltext: { maxChunkChars: 6000, minChars: 200, parserCommand: 'pdftotext', retryCooldownHours: 72, minReadCoverage: 1 },
    http: { timeoutMs: 30000, minPdfBytes: 10240, unpaywallEmail: 'dsh-literature@example.org' },
    carsi: {
      // LEGACY / EXPERIMENTAL — DISABLED BY DEFAULT. Normal pushes never
      // invoke CARSI; the generic publisher-browser provider (publisherBrowser)
      // is the institutional-access path. Re-enable only deliberately.
      enabled: false,
      maxPerPush: 1,
      minIntervalMinutes: 120,
      headless: true,
      timeoutMs: 90000,
      profileDir: '',
      userAgent: DEFAULT_CARSI_USER_AGENT,
    },
    publisherBrowser: {
      enabled: true,
      maxPerPush: 1,
      // Direct Publisher Access: per-domain rate limit only (NOT a global
      // 120-min gate). 2 minutes between attempts on the SAME publisher
      // domain; different domains (IEEE vs Springer) never block each other.
      // A manual login (browser-login) clears the gate so resume retries
      // immediately. CARSI keeps its legacy 120-min gate (disabled by default).
      minIntervalMinutes: 2,
      headless: true,
      timeoutMs: 90000,
      profileDir: '',
      userAgent: DEFAULT_CARSI_USER_AGENT,
    },
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

function isStageDef(v: unknown): v is StageDef {
  return (
    isRecord(v) &&
    typeof v.label === 'string' &&
    typeof v.scope === 'string' &&
    Array.isArray(v.preferredKeywords) &&
    Array.isArray(v.downweightKeywords) &&
    Array.isArray(v.excludeKeywords) &&
    Array.isArray(v.searchQueries)
  )
}

function isTopicDef(v: unknown): v is TopicDef {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.displayName === 'string' &&
    Array.isArray(v.canonicalQueries) &&
    Array.isArray(v.secondaryQueries) &&
    Array.isArray(v.negativeTerms)
  )
}

/** Merge a partial (from cordis plugin config) over defaults, per-field. */
export function normalizeConfig(partial: Partial<LiteratureConfig> | undefined): LiteratureConfig {
  const base = defaultConfig()
  if (!partial) return base
  const out: LiteratureConfig = {
    topics: base.topics.map((t) => ({ ...t, canonicalQueries: [...t.canonicalQueries], secondaryQueries: [...t.secondaryQueries], negativeTerms: [...t.negativeTerms] })),
    libraryRoot: pickString(partial, 'libraryRoot', base.libraryRoot),
    dataDir: pickString(partial, 'dataDir', base.dataDir),
    yearsPrefer: pickNumberArray(partial, 'yearsPrefer', base.yearsPrefer),
    perPush: pickNumber(partial, 'perPush', base.perPush),
    stageOrder: base.stageOrder.map((s) => ({ ...s })),
    targetPapersPerStage: pickNumber(partial, 'targetPapersPerStage', base.targetPapersPerStage),
    stageRelevanceThreshold: pickNumber(partial, 'stageRelevanceThreshold', base.stageRelevanceThreshold),
    curriculumValueThreshold: pickNumber(partial, 'curriculumValueThreshold', base.curriculumValueThreshold),
    preRankTopN: pickNumber(partial, 'preRankTopN', base.preRankTopN),
    maxSelectionAttempts: pickNumber(partial, 'maxSelectionAttempts', base.maxSelectionAttempts),
    minKnowledgeCoverage: pickNumber(partial, 'minKnowledgeCoverage', base.minKnowledgeCoverage),
    retrieval: { ...base.retrieval },
    ranking: { ...base.ranking },
    agentRanking: { ...base.agentRanking },
    fulltext: { ...base.fulltext },
    http: { ...base.http },
    carsi: { ...base.carsi },
    publisherBrowser: { ...base.publisherBrowser },
  }
  if (Array.isArray(partial.topics)) {
    const defs = partial.topics.filter(isTopicDef)
    if (defs.length > 0) out.topics = defs
  }
  if (Array.isArray(partial.stageOrder)) {
    const defs = partial.stageOrder.filter(isStageDef)
    if (defs.length > 0) {
      out.stageOrder = defs.map((s) => ({ ...s, requiredGoals: s.requiredGoals ?? [] }))
    }
  }
  if (isRecord(partial.retrieval)) {
    out.retrieval = {
      recentYears: pickNumber(partial.retrieval, 'recentYears', base.retrieval.recentYears),
      perQueryLimit: pickNumber(partial.retrieval, 'perQueryLimit', base.retrieval.perQueryLimit),
      landmarkMaxCandidates: pickNumber(
        partial.retrieval,
        'landmarkMaxCandidates',
        base.retrieval.landmarkMaxCandidates,
      ),
      landmarkMinScore: pickNumber(partial.retrieval, 'landmarkMinScore', base.retrieval.landmarkMinScore),
      landmarkMinHint: pickNumber(partial.retrieval, 'landmarkMinHint', base.retrieval.landmarkMinHint),
      minTopicSimilarity: pickNumber(partial.retrieval, 'minTopicSimilarity', base.retrieval.minTopicSimilarity),
      maxQueriesPerPool: Math.max(0, Math.floor(pickNumber(partial.retrieval, 'maxQueriesPerPool', base.retrieval.maxQueriesPerPool))),
      arxivMaxQueriesPerPool: Math.max(0, Math.floor(pickNumber(partial.retrieval, 'arxivMaxQueriesPerPool', base.retrieval.arxivMaxQueriesPerPool))),
      sourceConcurrency: Math.max(1, Math.floor(pickNumber(partial.retrieval, 'sourceConcurrency', base.retrieval.sourceConcurrency))),
    }
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
      stageRelevance: pickNumber(partial.ranking, 'stageRelevance', base.ranking.stageRelevance),
      knowledgeGap: pickNumber(partial.ranking, 'knowledgeGap', base.ranking.knowledgeGap),
      priorityGoal: pickNumber(partial.ranking, 'priorityGoal', base.ranking.priorityGoal),
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
      stageRelevance: pickNumber(
        partial.agentRanking,
        'stageRelevance',
        base.agentRanking.stageRelevance,
      ),
      curriculumValue: pickNumber(
        partial.agentRanking,
        'curriculumValue',
        base.agentRanking.curriculumValue,
      ),
    }
  }
  if (isRecord(partial.fulltext)) {
    out.fulltext = {
      maxChunkChars: pickNumber(partial.fulltext, 'maxChunkChars', base.fulltext.maxChunkChars),
      minChars: pickNumber(partial.fulltext, 'minChars', base.fulltext.minChars),
      parserCommand: pickString(partial.fulltext, 'parserCommand', base.fulltext.parserCommand),
      retryCooldownHours: pickNumber(partial.fulltext, 'retryCooldownHours', base.fulltext.retryCooldownHours),
      minReadCoverage: Math.max(0, Math.min(1, pickNumber(partial.fulltext, 'minReadCoverage', base.fulltext.minReadCoverage))),
    }
  }
  if (isRecord(partial.http)) {
    out.http = {
      timeoutMs: pickNumber(partial.http, 'timeoutMs', base.http.timeoutMs),
      minPdfBytes: pickNumber(partial.http, 'minPdfBytes', base.http.minPdfBytes),
      unpaywallEmail: pickString(partial.http, 'unpaywallEmail', base.http.unpaywallEmail),
    }
  }
  if (isRecord(partial.carsi)) {
    out.carsi = {
      enabled: typeof partial.carsi.enabled === 'boolean' ? partial.carsi.enabled : base.carsi.enabled,
      maxPerPush: pickNumber(partial.carsi, 'maxPerPush', base.carsi.maxPerPush),
      minIntervalMinutes: pickNumber(partial.carsi, 'minIntervalMinutes', base.carsi.minIntervalMinutes),
      headless: typeof partial.carsi.headless === 'boolean' ? partial.carsi.headless : base.carsi.headless,
      timeoutMs: pickNumber(partial.carsi, 'timeoutMs', base.carsi.timeoutMs),
      profileDir: pickString(partial.carsi, 'profileDir', base.carsi.profileDir),
      userAgent: pickString(partial.carsi, 'userAgent', base.carsi.userAgent),
    }
  }
  if (isRecord(partial.publisherBrowser)) {
    out.publisherBrowser = {
      enabled:
        typeof partial.publisherBrowser.enabled === 'boolean'
          ? partial.publisherBrowser.enabled
          : base.publisherBrowser.enabled,
      maxPerPush: pickNumber(partial.publisherBrowser, 'maxPerPush', base.publisherBrowser.maxPerPush),
      minIntervalMinutes: pickNumber(
        partial.publisherBrowser,
        'minIntervalMinutes',
        base.publisherBrowser.minIntervalMinutes,
      ),
      headless:
        typeof partial.publisherBrowser.headless === 'boolean'
          ? partial.publisherBrowser.headless
          : base.publisherBrowser.headless,
      timeoutMs: pickNumber(partial.publisherBrowser, 'timeoutMs', base.publisherBrowser.timeoutMs),
      profileDir: pickString(partial.publisherBrowser, 'profileDir', base.publisherBrowser.profileDir),
      userAgent: pickString(partial.publisherBrowser, 'userAgent', base.publisherBrowser.userAgent),
    }
  }
  return out
}
