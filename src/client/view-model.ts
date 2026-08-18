import type { UiPaperSummary, UiPushStatus } from './wire.ts'

export type WorkflowStageKey = 'retrieval' | 'ranking' | 'acquisition' | 'reading' | 'report'
export type WorkflowStageState = 'pending' | 'running' | 'completed' | 'failed' | 'user_action_required'

export interface WorkflowStageView {
  key: WorkflowStageKey
  state: WorkflowStageState
  progress: string | null
}

export type WorkflowLog =
  | { kind: 'retrieved'; count: number }
  | { kind: 'ranked'; count: number }
  | { kind: 'acquired'; rank: number; title: string }
  | { kind: 'report' }
  | { kind: 'failed'; detail: string }

const STAGE_KEYS: WorkflowStageKey[] = ['retrieval', 'ranking', 'acquisition', 'reading', 'report']

export function formatAgentScore(score: number | null): string | null {
  return score === null ? null : (score * 10).toFixed(1)
}

export function paperMetaLine(paper: Pick<UiPaperSummary, 'authors' | 'venue' | 'year'>): string {
  const authors = paper.authors.length > 3
    ? `${paper.authors.slice(0, 3).join(', ')} et al.`
    : paper.authors.length > 0 ? paper.authors.join(', ') : null
  return [
    authors,
    paper.venue?.trim() || null,
    paper.year === null ? null : String(paper.year),
  ].filter((part): part is string => part !== null).join(' · ')
}

function runningStageIndex(status: UiPushStatus): number {
  if (status.phase === 'failed') {
    if (status.retrievedPapers === null && status.retrieving.length === 0) return 0
    if (status.candidatesRanked === null) return 1
    const acquired = status.acquisition.some((line) =>
      line.outcome === 'SELECTED' || line.outcome === 'PDF_OK' || line.outcome === 'ok')
    if (!acquired) return 2
    const { totalChunks, readChunks } = status.reading
    if (totalChunks === null || readChunks === null || readChunks < totalChunks) return 3
    return 4
  }
  return {
    idle: -1,
    retrieving: 0,
    ranking: 1,
    acquiring: 2,
    auth_required: 2,
    reading: 3,
    reporting: 4,
    completed: 5,
    failed: 0,
  }[status.phase]
}

export function workflowStages(status: UiPushStatus): WorkflowStageView[] {
  const active = runningStageIndex(status)
  return STAGE_KEYS.map((key, index) => {
    let state: WorkflowStageState = 'pending'
    if (status.phase === 'completed') state = 'completed'
    else if (index < active) state = 'completed'
    else if (index === active) {
      if (status.phase === 'auth_required') state = 'user_action_required'
      else if (status.phase === 'failed') state = 'failed'
      else if (status.phase !== 'idle') state = 'running'
    }
    const progress = key === 'reading' && status.reading.totalChunks !== null
      ? `${status.reading.readChunks ?? 0}/${status.reading.totalChunks}`
      : null
    return { key, state, progress }
  })
}

export function recentWorkflowLogs(status: UiPushStatus): WorkflowLog[] {
  const logs: WorkflowLog[] = []
  if (status.retrievedPapers !== null) logs.push({ kind: 'retrieved', count: status.retrievedPapers })
  if (status.candidatesRanked !== null) logs.push({ kind: 'ranked', count: status.candidatesRanked })
  const acquired = [...status.acquisition].reverse().find((line) =>
    line.outcome === 'SELECTED' || line.outcome === 'PDF_OK' || line.outcome === 'ok')
  if (acquired !== undefined) logs.push({ kind: 'acquired', rank: acquired.agentRank, title: acquired.title })
  if (status.reporting.reportPath !== null) logs.push({ kind: 'report' })
  if (status.phase === 'failed') logs.push({ kind: 'failed', detail: status.errorDetail ?? status.errorCode ?? '' })
  return logs.slice(-3)
}

export function defaultPaperId(papers: UiPaperSummary[]): string | null {
  return papers[0]?.id ?? null
}

export function isPushActive(status: UiPushStatus | null): boolean {
  return status !== null && (status.running || status.phase === 'auth_required')
}
