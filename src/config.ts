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
}

export interface LiteratureConfig {
  /** normalized topics (Chinese display name + English queries); first is default */
  topics: TopicDef[]
  /**
   * Report archive root. Empty string resolves to the canonical data-dir
   * reports path (~/.local/share/dsh-literature/reports). Desktop/library
   * exports are handled by an outer script or Zotero sync, never by the
   * plugin relaxing the harness sandbox.
   */
  libraryRoot: string
  /** XDG data dir for db/pdfs/cache/reports; empty string resolves to the default */
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
     * Master switch for the CARSI institutional-access fallback. CARSI is
     * NOT an OA source (access_type=institutional, is_open_access=false) and
     * is only ever used AFTER the whole public chain failed, for papers that
     * already passed the ranking quality gates.
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
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  recency: 0.15,
  impact: 0.15,
  topicSimilarity: 0.15,
  fulltextAvailability: 0.15,
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

/** Default topic: Chinese display name, English academic queries. */
export const DEFAULT_TOPICS: TopicDef[] = [
  {
    id: 'legged_robot_control',
    displayName: '足式机器人控制',
    canonicalQueries: [
      'legged robot locomotion control',
      'legged robot control',
      'quadruped locomotion control',
    ],
    secondaryQueries: ['dynamic legged locomotion', 'biped locomotion control'],
    negativeTerms: [
      'agricultural robot',
      'uav',
      'unmanned aerial',
      'surgical robot',
      'welding',
      'assembly line',
      'grasping',
      'manipulation',
      'landslide',
      'power grid',
    ],
  },
]

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  recentYears: 5,
  perQueryLimit: 8,
  landmarkMaxCandidates: 6,
  landmarkMinScore: 0.35,
  landmarkMinHint: 0.25,
  minTopicSimilarity: 0.1,
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
    searchQueries: [
      'legged robot dynamics',
      'locomotion control fundamentals',
      'contact dynamics legged robot',
      'impedance control legged robot',
      'whole body control legged robot',
      'inverted pendulum walking control',
      'virtual model control locomotion'
    ],
    knowledgeGoals: [
      { id: 'template_dynamics', label: 'template / simplified dynamics', keywords: ['template model', 'inverted pendulum', 'lipm', 'slip', 'spring loaded', 'centroidal', 'zmp', 'simplified model'] },
      { id: 'balance_stability', label: 'balance and stability', keywords: ['balance', 'stability', 'push recovery', 'capture point', 'postural', 'equilibrium', 'capture input', 'ankle strategy'] },
      { id: 'gait_representation', label: 'gait representation / walking pattern', keywords: ['gait', 'walking pattern', 'gait generation', 'gait synthesis', 'gait pattern', 'gait cycle', 'foot placement', 'footstep', 'step planning', 'step-to-step', 'phase', 'gait transition'] },
      { id: 'kinematics_jacobian', label: 'kinematics / jacobian', keywords: ['kinematics', 'jacobian', 'inverse kinematics', 'leg kinematics', 'kinematic model', 'workspace'] },
      { id: 'impedance_compliance', label: 'impedance / compliance', keywords: ['impedance', 'impedance control', 'compliance', 'compliance control', 'compliant', 'stiffness', 'stiffness control', 'damping', 'damper', 'spring', 'spring-damper', 'virtual spring', 'virtual model', 'force position compliance'] },
    ],
    landmarkSeeds: [
      {
        doi: '10.1177/02783640122067309',
        title: 'Virtual Model Control: An Intuitive Approach for Bipedal Locomotion',
        goals: ['impedance_compliance', 'balance_stability'],
      },
      {
        doi: '10.1109/ROBOT.2006.1641685',
        title: 'Instantaneous Capture Input for Balancing the Variable Height Inverted Pendulum',
        goals: ['template_dynamics', 'balance_stability'],
      },
    ],
    curriculumWeight: 0.35,
    requiredGoals: ['template_dynamics', 'balance_stability', 'impedance_compliance'],
  },
  {
    label: '动力学/接触控制',
    scope: '全身动力学、接触力分配、WBC、足端力/力矩控制、力位混合、摩擦锥、地面反作用力。',
    knowledgeGoals: [
      { id: 'contact_force', label: 'contact / force control', keywords: ['contact force', 'ground reaction', 'grf', 'force control', 'friction cone', 'wrench', 'reaction force'] },
      { id: 'whole_body', label: 'whole-body locomotion control', keywords: ['whole-body control', 'whole body control', 'whole body dynamics', 'full body control', 'wbc'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
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
    searchQueries: [
      'legged robot contact force control',
      'whole body control quadruped',
      'ground reaction force legged locomotion',
      'friction cone contact planning legged robot',
      'dynamic biped walking control',
      'force distribution legged robot'
    ],
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
    searchQueries: [
      'model predictive control legged locomotion',
      'whole body mpc quadruped',
      'trajectory optimization legged robot',
      'centroidal dynamics mpc biped',
      'receding horizon legged robot control'
    ],
    knowledgeGoals: [
      { id: 'centroidal_mpc', label: 'centroidal dynamics MPC', keywords: ['centroidal', 'model predictive control', 'mpc'] },
      { id: 'trajectory_optimization', label: 'trajectory optimization', keywords: ['trajectory optimization', 'convex optimization', 'qp', 'sqp', 'receding horizon'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
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
    searchQueries: [
      'reinforcement learning quadruped locomotion',
      'deep reinforcement learning legged locomotion',
      'teacher student policy locomotion',
      'reward design legged locomotion',
      'learning bipedal walking'
    ],
    knowledgeGoals: [
      { id: 'policy_learning', label: 'policy learning', keywords: ['reinforcement learning', 'policy gradient', 'ppo', 'actor-critic'] },
      { id: 'reward_design', label: 'reward design', keywords: ['reward', 'shaping', 'curriculum'] },
      { id: 'sim2real_rl', label: 'sim-to-real transfer', keywords: ['sim-to-real', 'domain randomization', 'zero-shot'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
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
    searchQueries: [
      'robust legged locomotion control',
      'push recovery biped robot',
      'capture point humanoid balancing',
      'disturbance rejection quadruped',
      'legged robot fall recovery'
    ],
    knowledgeGoals: [
      { id: 'push_recovery', label: 'push recovery', keywords: ['push recovery', 'capture point', 'recovery'] },
      { id: 'disturbance_rejection', label: 'disturbance rejection', keywords: ['disturbance', 'robust', 'perturbation', 'rejection'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
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
    searchQueries: [
      'perceptive locomotion quadruped',
      'terrain adaptation legged robot',
      'rough terrain quadruped locomotion',
      'parkour legged robot',
      'elevation mapping legged locomotion'
    ],
    knowledgeGoals: [
      { id: 'rough_terrain', label: 'rough terrain locomotion', keywords: ['terrain', 'rough', 'stairs', 'slope', 'parkour'] },
      { id: 'perception_mapping', label: 'perception / elevation mapping', keywords: ['perception', 'elevation map', 'point cloud', 'exteroception'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
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
    searchQueries: [
      'sim to real legged robot',
      'domain randomization locomotion',
      'zero shot transfer quadruped',
      'simulation to reality legged robot',
      'hardware deployment legged locomotion'
    ],
    knowledgeGoals: [
      { id: 'domain_randomization', label: 'domain randomization', keywords: ['domain randomization', 'randomization'] },
      { id: 'zero_shot_deploy', label: 'zero-shot deployment', keywords: ['zero-shot', 'deployment', 'real robot', 'hardware'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
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
    searchQueries: [
      'foundation model robot locomotion',
      'diffusion policy legged robot',
      'world model legged robot',
      'vision language model robot control',
      'generalist robot locomotion'
    ],
    knowledgeGoals: [
      { id: 'foundation_models', label: 'foundation models', keywords: ['foundation model', 'large language model', 'vision-language'] },
      { id: 'generative_policies', label: 'generative / world-model policies', keywords: ['diffusion policy', 'world model', 'generative'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
  },
]

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
    fulltext: { maxChunkChars: 6000, minChars: 200, parserCommand: 'pdftotext', retryCooldownHours: 72 },
    http: { timeoutMs: 30000, minPdfBytes: 10240, unpaywallEmail: 'dsh-literature@example.org' },
    carsi: {
      enabled: true,
      maxPerPush: 1,
      minIntervalMinutes: 120,
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
  return out
}
