import { useRef, useState } from 'react'
import type { LiteratureApi } from './api.ts'
import { t } from './locales.ts'
import { CSS } from './styles.ts'
import { formatAgentScore, paperMetaLine } from './view-model.ts'
import type { UiPaperSummary } from './wire.ts'

interface PapersPanelProps {
  papers: UiPaperSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  loading: boolean
  api?: LiteratureApi
  onImported?: (paperId: string) => void
}

export function PapersPanel({ papers, selectedId, onSelect, loading, api, onImported }: PapersPanelProps) {
  const input = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const choose = (): void => { input.current?.click() }
  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file || api === undefined) return
    if (file.type !== 'application/pdf' && !/\.pdf$/iu.test(file.name)) { setMessage(t('import.failed')); return }
    setImporting(true); setMessage(null)
    try { const result = await api.importPdf(file); setMessage(t('import.success')); onImported?.(result.paperId) }
    catch (error) { setMessage(error instanceof Error ? error.message : t('import.failed')) }
    finally { setImporting(false); if (input.current) input.current.value = '' }
  }
  return (
    <section className={`${CSS.panel} ${CSS.papers}`}>
      <h3 className={CSS.panelTitle}>
        {t('panel.papers')}
        <span className={CSS.categoryCount}>{papers.length} {t('papers.results')}</span>
        {api !== undefined && <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} disabled={importing} onClick={choose}>{importing ? t('import.importing') : `＋ ${t('import.addDocument')}`}</button>}
        <input ref={input} type="file" accept=".pdf,application/pdf" hidden onChange={(event) => { void importFile(event.target.files?.[0]) }} />
      </h3>
      {message !== null && <p className={CSS.searchMessage}>{message}</p>}
      {loading && <p className={CSS.empty}>…</p>}
      {!loading && papers.length === 0 && <p className={CSS.empty}>{t('empty.papers')}</p>}
      {papers.map((paper) => {
        const score = formatAgentScore(paper.finalScore)
        const meta = paperMetaLine(paper)
        return (
          <button
            key={paper.id}
            type="button"
            className={`${CSS.paperCard} ${selectedId === paper.id ? CSS.paperCardActive : ''}`}
            onClick={() => { onSelect(paper.id) }}
          >
            <span className={CSS.paperTitle} title={paper.title}>{paper.title}</span>
            {meta !== '' && <span className={CSS.paperMeta}>{meta}</span>}
            <span className={CSS.paperFlags}>
              {paper.agentRank !== null && <span className={CSS.flag} data-kind="rank">{t('badge.rank')} #{paper.agentRank}</span>}
              {score !== null && <span className={CSS.flag} data-kind="score">{t('badge.score')} {score}</span>}
              {paper.selected && <span className={CSS.flag} data-kind="selected">{t('badge.selected')}</span>}
              {paper.hasPdf && <span className={CSS.flag} data-kind="pdf">{t('badge.pdf')}</span>}
              {paper.hasPdf && paper.readingStatus === 'running' && <span className={CSS.flag} data-kind="read">{t('import.reading')} {paper.readCount}/{paper.fulltextChunks ?? '?'}</span>}
              {paper.hasPdf && ((paper.readCoverage !== null && paper.readCoverage !== undefined && paper.readCoverage >= 1) || (paper.readCoverage === undefined && paper.readCount > 0)) && <span className={CSS.flag} data-kind="read">{t('badge.read')}</span>}
              {paper.hasPdf && (paper.readCoverage === null || (paper.readCoverage !== undefined && paper.readCoverage < 1) || (paper.readCoverage === undefined && paper.readCount === 0)) && paper.readingStatus !== 'running' && <span className={CSS.flag} data-kind="read">{t('import.unread')}</span>}
              {paper.reportCount > 0 && <span className={CSS.flag} data-kind="report">{t('badge.report')}</span>}
            </span>
          </button>
        )
      })}
    </section>
  )
}
