import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { CategoriesPanel } from '../src/client/CategoriesPanel.js'
import { ExecutionPanel } from '../src/client/ExecutionPanel.js'
import { PaperDetailPanel } from '../src/client/PaperDetailPanel.js'
import { PapersPanel } from '../src/client/PapersPanel.js'
import { SearchKeywords } from '../src/client/SearchKeywords.js'
import { setLanguage } from '../src/client/locales.js'
import type { UiPaperDetail, UiPaperSummary, UiPushStatus } from '../src/client/wire.js'

const summary: UiPaperSummary = {
  id: 'doi:10.1000/test',
  title: 'Fault-Tolerant Legged Locomotion',
  authors: ['Ada Lovelace', 'Grace Hopper'],
  year: 2026,
  venue: 'IEEE RA-L',
  doi: '10.1000/test',
  citations: 10,
  agentRank: 1,
  finalScore: 0.82,
  selected: true,
  hasPdf: true,
  readCount: 23,
  reportCount: 1,
  topic: 'legged_robot_control',
  createdAt: '2026-08-18',
}

const detail: UiPaperDetail = {
  ...summary,
  researchFields: [{ id: 1, slug: 'robotics', nameEn: 'Robotics', nameZh: '机器人学', source: 'manual' }],
  abstract: 'A real persisted abstract.',
  arxivId: null,
  openalexId: null,
  url: null,
  oaPdfUrl: null,
  bibtex: null,
  metadataSource: 'OpenAlex',
  selectionReason: 'Strong curriculum match.',
  stage: 2,
  selectionOutcome: 'SELECTED',
  acquisitionOutcome: 'SELECTED',
  acquisitionReason: null,
  fulltextStatus: 'ok',
  fulltextChunks: 23,
  readCoverage: 1,
  pdfPath: '/real/paper.pdf',
  pdfSource: 'https://publisher.example/paper.pdf',
  accessType: 'institutional',
  isOpenAccess: false,
  reportPath: '/real/report.md',
}

function pushStatus(phase: UiPushStatus['phase']): UiPushStatus {
  return {
    present: true,
    pushId: 22,
    phase,
    label: phase,
    rawStatus: phase === 'auth_required' ? 'auth_required' : 'running',
    topic: 'legged_robot_control',
    stage: 2,
    stageLabel: 'Robust Control',
    startedAt: '2026-08-18T10:00:00',
    finishedAt: null,
    errorCode: null,
    errorDetail: null,
    running: phase !== 'auth_required',
    retrieving: [{ source: 'OpenAlex', retrievedAt: '2026-08-18T10:00:01' }],
    retrievedPapers: 218,
    candidatesRanked: 15,
    acquisition: [{
      agentRank: 1,
      paperId: summary.id,
      title: summary.title,
      publicPreflight: 'AVAILABLE',
      outcome: phase === 'auth_required' ? 'AUTH_REQUIRED' : 'SELECTED',
      reason: phase === 'auth_required' ? 'Authentication required' : null,
    }],
    reading: { totalChunks: 23, readChunks: 12, coverage: 12 / 23 },
    reporting: { reportGenerationMs: null, reportPath: null },
    authRequired: phase === 'auth_required' ? {
      paperTitle: summary.title,
      publisher: 'ieee.org',
      rank: 1,
      reason: 'Authentication required',
      nextStep: 'Sign in to IEEE',
      actions: [{
        id: 1,
        paperId: summary.id,
        paperTitle: summary.title,
        step: 'fetch_pdf',
        kind: 'user_resource_needed',
        issue: 'https://ieee.org/login',
        attempts: ['publisher_browser'],
        whatUserShouldDo: 'Sign in to IEEE',
        howToContinue: 'Resume push 22',
      }],
    } : null,
    notes: null,
    perf: { retrievalMs: 20, rankingMs: 30, totalMs: null, llmCallCount: 1 },
  }
}

const api = {
  run: async () => ({ ok: true, message: 'started' }),
  resume: async () => ({ ok: true, message: 'resumed' }),
  toggleFavorite: async () => ({ paperId: 'doi:10.1000/test', favorite: true }),
  bulkRemoveRetrieved: async () => ({ removedRetrievedCount: 1, protectedLibraryCount: 0, orphanPaperDeletedCount: 0, failedCount: 0 }),
  importPdf: async () => ({ paperId: 'doi:10.1000/test' }),
} as never

beforeEach(() => { setLanguage('en-US', undefined) })

describe('Paper Detail', () => {
  it('renders title hierarchy, three populated sections and truthful actions', () => {
    const html = renderToStaticMarkup(<PaperDetailPanel detail={detail} loading={false} api={api as never} />)
    expect(html).toContain('Fault-Tolerant Legged Locomotion')
    expect(html).toContain('IEEE RA-L · 2026')
    expect(html).toContain('Metadata')
    expect(html).toContain('Research Fields')
    expect(html).toContain('Robotics')
    expect(html).toContain('Agent Evaluation')
    expect(html).toContain('Fulltext &amp; Report')
    expect(html).toContain('Open DOI')
    expect(html).toContain('Open PDF')
    expect(html).toContain('Read Report')
    expect(html).toContain('Favorite')
  })

  it('hides empty fields, sections, and unavailable document actions', () => {
    const sparse: UiPaperDetail = {
      ...detail,
      researchFields: [],
      authors: [],
      doi: null,
      abstract: null,
      agentRank: null,
      finalScore: null,
      selectionReason: null,
      topic: null,
      stage: null,
      selectionOutcome: null,
      acquisitionOutcome: null,
      fulltextStatus: null,
      readCoverage: null,
      pdfPath: null,
      pdfSource: null,
      accessType: null,
      isOpenAccess: null,
      reportPath: null,
      reportCount: 0,
      hasPdf: false,
    }
    const html = renderToStaticMarkup(<PaperDetailPanel detail={sparse} loading={false} />)
    expect(html).not.toContain('Authors</span>')
    expect(html).not.toContain('Agent Evaluation')
    expect(html).not.toContain('Fulltext &amp; Report')
    expect(html).not.toContain('Open DOI')
    expect(html).not.toContain('Open PDF')
    expect(html).not.toContain('Read Report')
    expect(html).not.toContain('>-<')
  })
})

describe('Papers and Categories', () => {
  it('uses semantic localized badges and clean metadata', () => {
    const html = renderToStaticMarkup(
      <PapersPanel papers={[summary]} selectedId={summary.id} onSelect={() => {}} loading={false} />,
    )
    expect(html).toContain('Ada Lovelace, Grace Hopper · IEEE RA-L · 2026')
    expect(html).toContain('Rank #1')
    expect(html).toContain('Score 8.2')
    expect(html).toContain('Selected')
    expect(html).toContain('Read')
    expect(html).toContain('Report')
  })

  it('localizes fixed category groups and known category labels', () => {
    setLanguage('zh-CN', undefined)
    const html = renderToStaticMarkup(
      <CategoriesPanel
        api={api}
        categories={[
          { id: 'all', label: 'All Papers', kind: 'workflow', count: 1 },
          { id: 'field:1', categoryId: 1, label: 'Robotics', labelEn: 'Robotics', labelZh: '机器人学', kind: 'field', count: 1, createdBy: 'system' },
        ]}
        active="all"
        onSelect={() => {}}
        onChanged={() => {}}
      />,
    )
    expect(html).toContain('工作流')
    expect(html).toContain('已检索')
    expect(html).toContain('研究领域')
    expect(html).toContain('机器人学')
    expect(html).not.toContain('All Papers')
  })
})

describe('Execution and Search', () => {
  it('renders the five-stage progress and Reading 12/23', () => {
    const html = renderToStaticMarkup(<ExecutionPanel status={pushStatus('reading')} live api={api} />)
    for (const label of ['Retrieval', 'Ranking', 'Acquisition', 'Reading', 'Report']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('12/23')
    expect(html).toContain('218 unique papers retrieved')
  })

  it('renders AUTH_REQUIRED as a warning with only the stuck Rank #1 controls', () => {
    const html = renderToStaticMarkup(<ExecutionPanel status={pushStatus('auth_required')} live api={api} />)
    expect(html).toContain('User Action Required')
    expect(html).toContain('Rank #1')
    expect(html).toContain('Authentication required')
    expect(html).toContain('Sign in to IEEE')
    expect(html).toContain('Open Publisher')
    expect(html).toContain('Resume')
    expect(html).not.toContain('Rank #2')
  })

  it('shows both search modes and disables Run for an active push', () => {
    const html = renderToStaticMarkup(<SearchKeywords api={api} active />)
    expect(html).toContain('Default Push')
    expect(html).toContain('Custom Search')
    expect(html).toContain('Use curriculum, stage and knowledge-gap based automatic query planning.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Run<\/button>/)
  })
})
