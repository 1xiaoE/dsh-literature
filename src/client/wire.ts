/**
 * Browser mirror of the node-half wire DTOs (src/ui/types.ts). The client
 * bundle must not import node code, so these shapes are duplicated by hand —
 * keep both files in sync. They are TYPE-only for the browser; the runtime
 * payloads come from fetch('/api/dsh-literature/*').
 */

export type UiPushPhase =
  | 'idle'
  | 'retrieving'
  | 'ranking'
  | 'acquiring'
  | 'auth_required'
  | 'reading'
  | 'reporting'
  | 'completed'
  | 'failed'

export interface UiPaperSummary {
  id: string
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  citations: number | null
  agentRank: number | null
  finalScore: number | null
  selected: boolean
  hasPdf: boolean
  isOpenAccess?: boolean | null
  readCount: number
  fulltextChunks?: number | null
  readCoverage?: number | null
  readingStatus?: 'running' | 'completed' | 'failed' | null
  reportCount: number
  topic: string | null
  createdAt: string | null
  /** true when the paper is bookmarked (first-class library signal). */
  favorite?: boolean
  /** true when the paper belongs to the formal library (selected/import/pdf/read/report/favorite/manual category). */
  isLibrary?: boolean
}

export interface UiPaperDetail extends UiPaperSummary {
  researchFields: UiResearchField[]
  abstract: string | null
  arxivId: string | null
  openalexId: string | null
  url: string | null
  oaPdfUrl: string | null
  bibtex: string | null
  metadataSource: string | null
  affiliation?: string | null
  keywords?: string[]
  metadataStatus?: 'complete' | 'partial'
  selectionReason: string | null
  stage: number | null
  selectionOutcome: string | null
  acquisitionOutcome: string | null
  acquisitionReason: string | null
  fulltextStatus: string | null
  pdfPath: string | null
  pdfSource: string | null
  accessType: string | null
  isOpenAccess: boolean | null
  reportPath: string | null
}

export interface UiCategory {
  id: string
  label: string
  labelEn?: string
  labelZh?: string
  categoryId?: number
  createdBy?: 'system' | 'auto' | 'user'
  kind: 'workflow' | 'field' | 'topic'
  count: number
}

export interface UiResearchField {
  id: number
  slug: string
  nameEn: string
  nameZh: string
  source: 'auto' | 'manual'
}

export interface UiStageSummary {
  topic: string
  current: number
  label: string | null
  papersInStage: number
  targetPapers: number
}

export interface UiDashboard {
  paperCount: number
  /** papers that actually entered the formal library (not just retrieved). */
  libraryCount: number
  pushCount: number
  reportCount: number
  categories: UiCategory[]
  latestPush: { id: number; status: string; topic: string } | null
  stages: UiStageSummary[]
}

/** Provider-neutral model discovery from the active Harness profile. */
export interface UiModelSelection {
  current: { provider: string; model: string } | null
  options: Array<{
    provider: string
    providerName: string
    models: Array<{ id: string; name: string; description?: string }>
  }>
}

export interface UiModelSelectionInput {
  provider: string
  model: string
}

export interface UiRetrievalLine {
  source: string
  retrievedAt: string
}

export interface UiAcquisitionLine {
  agentRank: number
  paperId: string
  title: string
  publicPreflight: string | null
  outcome: string | null
  reason: string | null
}

export interface UiUserAction {
  id: number
  paperId: string | null
  paperTitle: string | null
  step: string
  kind: string
  issue: string
  attempts: string[]
  whatUserShouldDo: string
  howToContinue: string
}

export interface UiPushStatus {
  present: boolean
  pushId: number | null
  phase: UiPushPhase
  label: string
  rawStatus: string | null
  topic: string | null
  stage: number | null
  stageLabel: string | null
  startedAt: string | null
  finishedAt: string | null
  errorCode: string | null
  errorDetail: string | null
  running: boolean
  /** 'running' push with no persisted activity for a long time (runner died). */
  staleRunning: boolean
  lastActivityAt: string | null
  retrieving: UiRetrievalLine[]
  retrievedPapers: number | null
  candidatesRanked: number | null
  acquisition: UiAcquisitionLine[]
  reading: { totalChunks: number | null; readChunks: number | null; coverage: number | null }
  reporting: { reportGenerationMs: number | null; reportPath: string | null }
  authRequired: {
    paperTitle: string | null
    publisher: string | null
    rank: number | null
    reason: string | null
    nextStep: string | null
    actions: UiUserAction[]
  } | null
  notes: string | null
  perf: {
    retrievalMs: number | null
    rankingMs: number | null
    totalMs: number | null
    llmCallCount: number | null
  }
  /** Latest runner lifecycle, including failures that happen before a push exists. */
  runner?: UiRunnerStatus | null
}

export interface UiRunnerStatus {
  status: 'running' | 'exited' | 'failed'
  kind: 'push' | 'resume'
  message: string | null
  errorCode: string | null
  retryable: boolean | null
  provider: string | null
  model: string | null
  startedAt: string
  finishedAt: string | null
  logPath: string | null
}

export interface UiRunResult {
  ok: boolean
  errorCode?:
    | 'NO_ADAPTER'
    | 'AUTH'
    | 'RATE_LIMIT'
    | 'NETWORK'
    | 'INVALID_MODEL'
    | 'INVALID_ARGUMENT'
    | 'WORKFLOW_ALREADY_RUNNING'
    | 'RESUME_NOT_AVAILABLE'
  retryable?: boolean
  provider?: string | null
  model?: string | null
  pushId?: number | null
  pid?: number | null
  /** Captured runner log (stderr/stdout) path; set when logging is enabled. */
  logPath?: string | null
  message: string
}

export interface UiPaperTranslation {
  paperId: string
  language: 'zh-CN'
  title?: string
  affiliation?: string
  keywords?: string[]
  abstract?: string
  selectionReason?: string
}

/** Every payload from the API carries a provenance flag for the UI badge. */
export type UiDataMode = 'live' | 'demo' | 'unavailable'

export interface ApiResult<T> {
  data: T | null
  live: boolean
  mode: UiDataMode
  error?: string
}
