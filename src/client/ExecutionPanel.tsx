import { useState } from 'react'
import type { LiteratureApi } from './api.ts'
import { t, type LiteratureKey } from './locales.ts'
import { CSS } from './styles.ts'
import { recentWorkflowLogs, workflowStages, formatTimestamp, type WorkflowLog, type WorkflowStageKey } from './view-model.ts'
import type { UiPushStatus } from './wire.ts'

interface ExecutionPanelProps {
  status: UiPushStatus
  live: boolean
  api: LiteratureApi
}

const STAGE_LABELS: Record<WorkflowStageKey, LiteratureKey> = {
  retrieval: 'stage.retrieval',
  ranking: 'stage.ranking',
  acquisition: 'stage.acquisition',
  reading: 'stage.reading',
  report: 'stage.report',
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '–'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function phaseLabel(phase: UiPushStatus['phase']): string {
  const keys: Record<UiPushStatus['phase'], LiteratureKey> = {
    idle: 'status.idle',
    retrieving: 'status.retrieving',
    ranking: 'status.ranking',
    acquiring: 'status.acquiring',
    auth_required: 'status.auth_required',
    reading: 'status.reading',
    reporting: 'status.reporting',
    completed: 'status.completed',
    failed: 'status.failed',
  }
  return t(keys[phase])
}

function phaseClass(phase: UiPushStatus['phase']): string {
  if (phase === 'completed') return CSS.statusOk
  if (phase === 'failed') return CSS.statusErr
  if (phase === 'auth_required') return CSS.statusWarn
  if (phase === 'idle') return ''
  return CSS.statusRunning
}

function WorkflowProgress({ status }: { status: UiPushStatus }) {
  return (
    <ol className={CSS.workflowProgress} aria-label={t('panel.execution')}>
      {workflowStages(status).map((stage) => (
        <li key={stage.key} className={CSS.workflowStage} data-state={stage.state}>
          <span className={CSS.workflowMarker} aria-hidden="true">
            {stage.state === 'completed' ? '✓'
              : stage.state === 'running' ? <span className={CSS.spinner} />
                : stage.state === 'failed' ? '×'
                  : stage.state === 'user_action_required' ? '!'
                    : '○'}
          </span>
          <span>{t(STAGE_LABELS[stage.key])}{stage.progress === null ? '' : ` ${stage.progress}`}</span>
        </li>
      ))}
    </ol>
  )
}

function logText(log: WorkflowLog): string {
  switch (log.kind) {
    case 'retrieved': return `${log.count} ${t('log.retrieved')}`
    case 'ranked': return `${log.count} ${t('log.ranked')}`
    case 'acquired': return `${t('badge.rank')} #${log.rank} · ${log.title} · ${t('log.acquired')}`
    case 'report': return t('log.report')
    case 'failed': return `${t('status.failed')}${log.detail === '' ? '' : ` · ${log.detail}`}`
  }
}

function WorkflowLogs({ status }: { status: UiPushStatus }) {
  const logs = recentWorkflowLogs(status)
  if (logs.length === 0) return null
  return <ul className={CSS.workflowLogs}>{logs.map((log, index) => <li key={`${log.kind}-${index}`}>{logText(log)}</li>)}</ul>
}

function extractPublisherUrl(auth: NonNullable<UiPushStatus['authRequired']>): string | null {
  for (const text of [
    ...auth.actions.map((action) => action.issue),
    ...auth.actions.map((action) => action.howToContinue),
    auth.reason,
    auth.publisher,
  ]) {
    if (text === null || text === undefined) continue
    const match = /https?:\/\/[^\s"'<>)\]]+/.exec(text)
    if (match !== null) return match[0]
  }
  if (auth.publisher?.includes('.') === true && !auth.publisher.includes(' ')) {
    return `https://${auth.publisher.replace(/^https?:\/\//, '').split('/')[0]}`
  }
  return null
}

function AuthCard({ status, api }: { status: UiPushStatus; api: LiteratureApi }) {
  const [resuming, setResuming] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const auth = status.authRequired
  if (auth === null) return null
  const publisherUrl = extractPublisherUrl(auth)
  const resume = async (): Promise<void> => {
    if (resuming || status.pushId === null) return
    setResuming(true)
    setMessage(null)
    const result = await api.resume(status.pushId)
    setResuming(false)
    setMessage(result.ok ? t('auth.resumed') : `${t('auth.resumeFailed')} ${result.message}`)
  }
  const fields = [
    [t('auth.rank'), auth.rank === null ? null : `${t('badge.rank')} #${auth.rank}`],
    [t('auth.paper'), auth.paperTitle],
    [t('auth.publisher'), auth.publisher],
    [t('auth.reason'), auth.reason],
    [t('auth.next'), auth.nextStep],
  ] as const
  return (
    <div className={CSS.authCard}>
      <p className={CSS.authTitle}>! {t('auth.title')}</p>
      <div className={CSS.authGrid}>
        {fields.map(([label, value]) => value === null || value === '' ? null : (
          <div key={label} className={CSS.detailField}>
            <span className={CSS.authLabel}>{label}</span>
            <span className={CSS.authValue}>{value}</span>
          </div>
        ))}
      </div>
      <div className={CSS.detailActions}>
        {publisherUrl !== null && (
          <a className={`${CSS.button} ${CSS.buttonGhost}`} href={publisherUrl} target="_blank" rel="noreferrer">{t('auth.open')}</a>
        )}
        <button type="button" className={`${CSS.button} ${CSS.buttonPrimary}`} disabled={resuming || status.pushId === null} onClick={() => { void resume() }}>
          {resuming ? t('auth.resuming') : t('auth.resume')}
        </button>
      </div>
      {message !== null && <p className={CSS.searchMessage}>{message}</p>}
    </div>
  )
}

export function ExecutionPanel({ status, api }: ExecutionPanelProps) {
  const warning = status.phase === 'auth_required'

  // Elapsed wall time for a live push (SQLite timestamps are UTC).
  const elapsedMinutes = (iso: string | null): number | null => {
    if (iso === null) return null
    const parsed = Date.parse(`${iso.replace(' ', 'T')}Z`)
    return Number.isNaN(parsed) ? null : Math.max(0, Math.floor((Date.now() - parsed) / 60000))
  }

  return (
    <section className={`${CSS.panel} ${CSS.execution} ${warning ? CSS.executionWarning : ''}`}>
      <header className={CSS.detailHeader}>
        <div className={CSS.header}>
          <h3 className={CSS.panelTitle}>{t('panel.execution')}</h3>
          <span className={`${CSS.statusBadge} ${phaseClass(status.phase)}`}>
            {status.pushId === null ? phaseLabel(status.phase) : `${t('push.prefix')} #${status.pushId} · ${phaseLabel(status.phase)}`}
          </span>
          {status.running && status.startedAt !== null && (
            <span className={CSS.detailMeta}>{`${t('push.elapsed')} ${elapsedMinutes(status.startedAt)}m`}</span>
          )}
          {status.topic !== null && <span className={CSS.detailMeta}>{status.topic}{status.stageLabel === null ? '' : ` · ${status.stageLabel}`}</span>}
        </div>
        {status.staleRunning && (
          <p className={CSS.searchMessage} style={{ color: 'var(--dsh-lit-warn, #b58900)' }}>
            ⚠ {t('push.stale').replace('{m}', String(elapsedMinutes(status.lastActivityAt) ?? 0))}
          </p>
        )}
        {status.present ? <WorkflowProgress status={status} /> : <p className={CSS.empty}>{t('push.none')}</p>}
        <WorkflowLogs status={status} />
      </header>
      <AuthCard status={status} api={api} />
      {status.present && (
        <p className={CSS.footer}>
          {t('time.started')} {formatTimestamp(status.startedAt)}
          {status.finishedAt === null ? '' : ` · ${t('time.finished')} ${formatTimestamp(status.finishedAt)}`}
          {` · ${t('perf.retrieval')} ${fmtMs(status.perf.retrievalMs)} · ${t('perf.ranking')} ${fmtMs(status.perf.rankingMs)} · ${t('perf.total')} ${fmtMs(status.perf.totalMs)}`}
        </p>
      )}
    </section>
  )
}
