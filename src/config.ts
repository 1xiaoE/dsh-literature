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
  /** weight of the agent-assigned stage_relevance_score */
  stageRelevance: number
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
}

export interface LiteratureConfig {
  /** default topic(s); the first is used when a tool call omits topic */
  topics: string[]
  /**
   * Report archive root. Empty string resolves to the canonical data-dir
   * reports path (~/.local/share/dsh-literature/reports). Desktop/library
   * exports are handled by an outer script or Zotero sync, never by the
   * plugin relaxing the harness sandbox.
   */
  libraryRoot: string
  /** XDG data dir for db/pdfs/cache/reports; empty string resolves to the default */
  dataDir: string
  /** preferred publication years (recency); empty computes last 5 years */
  yearsPrefer: number[]
  /** papers per push (1 per spec) */
  perPush: number
  /** reading-stage progression with scope + keyword guidance */
  stageOrder: StageDef[]
  /** how many stage-matched completed picks gate an automatic stage advance */
  targetPapersPerStage: number
  /** minimum agent stage_relevance_score for a paper to be pickable as Top 1 */
  stageRelevanceThreshold: number
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

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  recency: 0.2,
  impact: 0.25,
  topicSimilarity: 0.3,
  fulltextAvailability: 0.25,
}

export const DEFAULT_AGENT_RANKING_WEIGHTS: AgentRankingWeights = {
  relevance: 0.35,
  learningValue: 0.25,
  representativeness: 0.15,
  novelty: 0.1,
  stageRelevance: 0.15,
}

/** Default stage progression for 足式机器人控制. */
export const DEFAULT_STAGES: StageDef[] = [
  {
    label: '基础控制',
    scope: '足式机器人控制的基础概念：刚体动力学/运动学、雅可比、步态、倒立摆/ZMP、虚拟模型控制、弹簧-阻尼、模板模型（SLIP/LIPM）。',
    preferredKeywords: [
      'inverted pendulum', 'zmp', 'virtual model', 'gait', 'walking pattern',
      'dynamics', 'kinematics', 'jacobian', 'balance', 'spring', 'passive',
      'slip', 'lipm', 'template model', 'torso', 'postural', 'leg design',
      'foot placement', 'zero moment point', '步态', '倒立摆', '虚拟模型', '动力学', '运动学',
    ],
    downweightKeywords: [
      'reinforcement learning', 'deep learning', 'neural network', 'model predictive control',
      'mpc', 'perceptive', 'vision', 'perception', 'terrain', 'parkour', 'sim-to-real', 'domain randomization',
    ],
    excludeKeywords: [],
  },
  {
    label: '动力学/接触控制',
    scope: '全身动力学、接触力分配、WBC、足端力/力矩控制、力位混合、摩擦锥、地面反作用力。',
    preferredKeywords: [
      'whole-body control', 'contact force', 'force distribution', 'wrench',
      'ground reaction', 'grf', 'inverse dynamics', 'hybrid force', 'friction cone',
      'contact planning', 'reaction force', 'dynamic walking', 'contact wrench',
      'force control', 'torque control', '全身控制', '接触力', '力分配',
    ],
    downweightKeywords: [
      'reinforcement learning', 'neural network', 'policy gradient', 'vision', 'perception', 'parkour',
    ],
    excludeKeywords: [],
  },
  {
    label: 'MPC',
    scope: '模型预测控制、轨迹优化、凸优化/QP、质心动力学、滚动时域、最优控制。',
    preferredKeywords: [
      'model predictive control', 'mpc', 'trajectory optimization', 'convex optimization',
      'quadratic program', 'qp', 'sequential quadratic', 'receding horizon', 'optimal control',
      'centroidal', 'sqp', 'lqr', 'linearized', 'whole-body mpc', 'motion planning', 'dynamics optimization',
    ],
    downweightKeywords: [
      'reinforcement learning', 'policy gradient', 'neural network', 'vision', 'perception',
    ],
    excludeKeywords: [],
  },
  {
    label: 'RL locomotion',
    scope: '强化学习行走：PPO/SAC、奖励设计、教师-学生特权学习、领域随机化、本体感觉策略。',
    preferredKeywords: [
      'reinforcement learning', 'policy gradient', 'ppo', 'sac', 'actor-critic',
      'reward', 'teacher-student', 'privileged', 'imitation', 'locomotion learning',
      'deep rl', 'rl', 'proprioceptive', 'domain randomization', 'sim-to-real',
      'zero-shot transfer', 'asymmetric', '强化学习', '奖励',
    ],
    downweightKeywords: ['whole-body mpc', 'model predictive control', 'trajectory optimization', 'vision', 'perception'],
    excludeKeywords: [],
  },
  {
    label: '鲁棒控制',
    scope: '抗扰/鲁棒性：外力扰动、推倒恢复、capture point、不确定性、参数摄动、故障与失稳恢复。',
    preferredKeywords: [
      'robust', 'disturbance', 'push recovery', 'capture point', 'external force',
      'perturbation', 'uncertainty', 'rejection', 'fault', 'recovery', 'impact',
      'fall', 'stability margin', 'anti-disturbance', 'adversarial', 'robustness',
      '鲁棒', '抗扰', '扰动', '推倒恢复',
    ],
    downweightKeywords: ['planning only', 'offline planning', 'map-based'],
    excludeKeywords: [],
  },
  {
    label: 'terrain adaptation',
    scope: '地形适应：崎岖地形、台阶/楼梯、斜坡、高程图、可穿越性、感知行走、野外环境。',
    preferredKeywords: [
      'terrain', 'rough', 'stairs', 'slope', 'uneven', 'elevation', 'perceptive',
      'traversability', 'step', 'obstacle', 'parkour', 'mapping', 'point cloud',
      'exteroception', 'outdoor', 'in the wild', 'elevation map', 'blind locomotion',
      '地形', '崎岖', '楼梯', '野外', '高程图',
    ],
    downweightKeywords: [],
    excludeKeywords: [],
  },
  {
    label: 'sim-to-real',
    scope: '仿真到真机迁移：域随机化、系统辨识、零样本部署、硬件实验、真机验证。',
    preferredKeywords: [
      'sim-to-real', 'domain randomization', 'transfer', 'reality gap', 'zero-shot',
      'simulation', 'real robot', 'deployment', 'system identification', 'hardware',
      'real-world', 'sim2real', '仿真', '真机', '迁移',
    ],
    downweightKeywords: ['simulation only', 'no hardware'],
    excludeKeywords: [],
  },
  {
    label: '前沿方法',
    scope: '前沿方法：基础模型、扩散策略、世界模型、大语言模型、通用/多任务、多模态具身智能。',
    preferredKeywords: [
      'foundation model', 'diffusion policy', 'world model', 'large language model',
      'llm', 'vision-language', 'generalist', 'multimodal', 'embodied', 'zero-shot generalization',
      '基础模型', '扩散策略', '世界模型', '具身智能',
    ],
    downweightKeywords: [],
    excludeKeywords: [],
  },
]

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
    libraryRoot: '',
    dataDir: '',
    yearsPrefer: years,
    perPush: 1,
    stageOrder: DEFAULT_STAGES.map((s) => ({ ...s, preferredKeywords: [...s.preferredKeywords], downweightKeywords: [...s.downweightKeywords], excludeKeywords: [...s.excludeKeywords] })),
    targetPapersPerStage: 3,
    stageRelevanceThreshold: 0.6,
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

function isStageDef(v: unknown): v is StageDef {
  return (
    isRecord(v) &&
    typeof v.label === 'string' &&
    typeof v.scope === 'string' &&
    Array.isArray(v.preferredKeywords) &&
    Array.isArray(v.downweightKeywords) &&
    Array.isArray(v.excludeKeywords)
  )
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
    stageOrder: base.stageOrder.map((s) => ({ ...s })),
    targetPapersPerStage: pickNumber(partial, 'targetPapersPerStage', base.targetPapersPerStage),
    stageRelevanceThreshold: pickNumber(partial, 'stageRelevanceThreshold', base.stageRelevanceThreshold),
    preRankTopN: pickNumber(partial, 'preRankTopN', base.preRankTopN),
    ranking: { ...base.ranking },
    agentRanking: { ...base.agentRanking },
    fulltext: { ...base.fulltext },
    http: { ...base.http },
  }
  if (Array.isArray(partial.stageOrder)) {
    const defs = partial.stageOrder.filter(isStageDef)
    if (defs.length > 0) out.stageOrder = defs
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
      stageRelevance: pickNumber(
        partial.agentRanking,
        'stageRelevance',
        base.agentRanking.stageRelevance,
      ),
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
