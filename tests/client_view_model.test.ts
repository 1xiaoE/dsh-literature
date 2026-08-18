import { describe, expect, it } from 'vitest'
import type { UiPaperSummary, UiPushStatus } from '../src/client/wire.js'
import {
  defaultPaperId,
  formatAgentScore,
  formatTimestamp,
  isPushActive,
  paperMetaLine,
  recentWorkflowLogs,
  workflowStages,
} from '../src/client/view-model.js'
import {
  LANGUAGE_STORAGE_KEY,
  localeKeys,
  resolveInitialLanguage,
  setLanguage,
  subscribeLanguage,
  t,
} from '../src/client/locales.js'
import { fallbackMode } from '../src/client/api.js'

function status(phase: UiPushStatus['phase']): UiPushStatus {
  return {
    present: true,
    pushId: 22,
    phase,
    label: phase,
    rawStatus: phase,
    topic: 'control',
    stage: 1,
    stageLabel: null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorDetail: null,
    running: !['idle', 'completed', 'failed', 'auth_required'].includes(phase),
    retrieving: [{ source: 'OpenAlex', retrievedAt: '2026-08-18' }],
    retrievedPapers: 218,
    candidatesRanked: 15,
    acquisition: [{
      agentRank: 1,
      paperId: 'paper:1',
      title: 'Control Paper',
      publicPreflight: 'AVAILABLE',
      outcome: 'SELECTED',
      reason: null,
    }],
    reading: { totalChunks: 23, readChunks: 12, coverage: 12 / 23 },
    reporting: { reportGenerationMs: null, reportPath: null },
    authRequired: null,
    notes: null,
    perf: { retrievalMs: 10, rankingMs: 20, totalMs: null, llmCallCount: 1 },
  }
}

const paper = {
  id: 'paper:1',
  title: 'Paper',
  authors: ['Ada Lovelace'],
  year: 2026,
  venue: 'RA-L',
  doi: null,
  citations: null,
  agentRank: 1,
  finalScore: 0.82,
  selected: true,
  hasPdf: false,
  readCount: 0,
  reportCount: 0,
  topic: null,
  createdAt: null,
} satisfies UiPaperSummary

describe('client view model', () => {
  it('formats the confirmed 0..1 agent score on a 0..10 display scale', () => {
    expect(formatAgentScore(0.82)).toBe('8.2')
    expect(formatAgentScore(1)).toBe('10.0')
    expect(formatAgentScore(null)).toBeNull()
  })

  it('builds paper metadata without empty separators', () => {
    expect(paperMetaLine(paper)).toBe('Ada Lovelace · RA-L · 2026')
    expect(paperMetaLine({ ...paper, authors: [], venue: null })).toBe('2026')
    expect(paperMetaLine({ ...paper, authors: ['A', 'B', 'C', 'D'] })).toBe('A, B, C et al. · RA-L · 2026')
  })

  it('renders SQLite UTC timestamps in the local timezone', () => {
    // SQLite datetime('now') is UTC ('YYYY-MM-DD HH:MM:SS'); the displayed
    // value must match the user's clock, so the conversion is TZ-aware.
    const utc = '2026-08-18 04:58:23'
    const expected = new Date('2026-08-18T04:58:23Z')
    const pad = (n: number): string => String(n).padStart(2, '0')
    const local = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())} ${pad(expected.getHours())}:${pad(expected.getMinutes())}:${pad(expected.getSeconds())}`
    expect(formatTimestamp(utc)).toBe(local)
    expect(formatTimestamp(null)).toBe('')
    expect(formatTimestamp('')).toBe('')
    // Already-ISO input with an explicit offset is left to Date parsing.
    expect(formatTimestamp('not-a-date')).toBe('not-a-date')
  })

  it('derives five workflow stages and reading numerator/denominator', () => {
    const stages = workflowStages(status('reading'))
    expect(stages.map((stage) => [stage.key, stage.state])).toEqual([
      ['retrieval', 'completed'],
      ['ranking', 'completed'],
      ['acquisition', 'completed'],
      ['reading', 'running'],
      ['report', 'pending'],
    ])
    expect(stages[3]?.progress).toBe('12/23')
  })

  it('maps AUTH_REQUIRED to acquisition user action without advancing later stages', () => {
    const stages = workflowStages(status('auth_required'))
    expect(stages[2]?.state).toBe('user_action_required')
    expect(stages[3]?.state).toBe('pending')
  })

  it('places a failure on the stage reached by persisted progress', () => {
    const failedDuringRetrieval = status('failed')
    failedDuringRetrieval.retrieving = []
    failedDuringRetrieval.retrievedPapers = null
    failedDuringRetrieval.candidatesRanked = null
    failedDuringRetrieval.acquisition = []
    failedDuringRetrieval.reading = { totalChunks: null, readChunks: null, coverage: null }
    expect(workflowStages(failedDuringRetrieval).map((stage) => stage.state)).toEqual([
      'failed', 'pending', 'pending', 'pending', 'pending',
    ])
    expect(workflowStages(status('idle')).every((stage) => stage.state === 'pending')).toBe(true)
  })

  it('keeps only the latest three persisted workflow summaries', () => {
    expect(recentWorkflowLogs(status('reading')).map((log) => log.kind)).toEqual([
      'retrieved',
      'ranked',
      'acquired',
    ])
  })

  it('chooses the adapter-ordered first result and detects active pushes', () => {
    expect(defaultPaperId([paper, { ...paper, id: 'paper:2' }])).toBe('paper:1')
    expect(defaultPaperId([])).toBeNull()
    expect(isPushActive(status('reading'))).toBe(true)
    expect(isPushActive(status('auth_required'))).toBe(true)
    expect(isPushActive(status('completed'))).toBe(false)
  })
})

describe('locales', () => {
  it('keeps zh-CN and en-US dictionaries key-complete', () => {
    const keys = localeKeys()
    expect(keys['zh-CN']).toEqual(keys['en-US'])
    expect(keys['en-US']).toContain('panel.details')
    expect(keys['en-US']).toContain('backend.unavailable')
  })

  it('prefers a valid saved language, then navigator language', () => {
    const saved = { getItem: (key: string) => key === LANGUAGE_STORAGE_KEY ? 'zh-CN' : null }
    expect(resolveInitialLanguage(saved, 'en-US')).toBe('zh-CN')
    expect(resolveInitialLanguage({ getItem: () => null }, 'zh-HK')).toBe('zh-CN')
    expect(resolveInitialLanguage({ getItem: () => 'invalid' }, 'fr-FR')).toBe('en-US')
  })

  it('switches language synchronously and notifies mounted views without refresh', () => {
    const writes: Array<[string, string]> = []
    const storage = {
      getItem: () => null,
      setItem: (key: string, value: string) => { writes.push([key, value]) },
    }
    let notifications = 0
    const unsubscribe = subscribeLanguage(() => { notifications += 1 })
    setLanguage('zh-CN', storage)
    expect(t('panel.details')).toBe('论文详情')
    setLanguage('en-US', storage)
    expect(t('panel.details')).toBe('Paper Details')
    unsubscribe()
    expect(notifications).toBe(2)
    expect(writes).toEqual([
      [LANGUAGE_STORAGE_KEY, 'zh-CN'],
      [LANGUAGE_STORAGE_KEY, 'en-US'],
    ])
  })
})

describe('API fallback mode', () => {
  it('uses explicit demo only in development and unavailable in production', () => {
    expect(fallbackMode('development')).toBe('demo')
    expect(fallbackMode('production')).toBe('unavailable')
  })
})
