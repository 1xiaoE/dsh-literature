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
  /** true when the active category is the Retrieved pool (deletion available). */
  retrievedMode?: boolean
  onChanged?: () => void
}

export function PapersPanel({ papers, selectedId, onSelect, loading, api, onImported, retrievedMode = false, onChanged }: PapersPanelProps) {
  const input = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const choose = (): void => { input.current?.click() }
  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file || api === undefined) return
    if (file.type !== 'application/pdf' && !/\.pdf$/iu.test(file.name)) { setMessage(t('import.failed')); return }
    setImporting(true); setMessage(null)
    try { const result = await api.importPdf(file); setMessage(t('import.success')); onImported?.(result.paperId) }
    catch (error) { setMessage(error instanceof Error ? error.message : t('import.failed')) }
    finally { setImporting(false); if (input.current) input.current.value = '' }
  }
  const toggleOne = (id: string): void => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }
  const toggleAllVisible = (): void => {
    if (checked.size === papers.length) setChecked(new Set())
    else setChecked(new Set(papers.map((paper) => paper.id)))
  }
  const removeSelected = async (): Promise<void> => {
    if (api === undefined || checked.size === 0) return
    setRemoving(true); setMessage(null)
    try {
      const result = await api.bulkRemoveRetrieved([...checked])
      const parts: string[] = []
      if (result.removedRetrievedCount > 0) parts.push(t('retrieved.removed').replace('{n}', String(result.removedRetrievedCount)))
      if (result.protectedLibraryCount > 0) parts.push(t('retrieved.removedDetail').replace('{n}', String(result.protectedLibraryCount)))
      if (result.orphanPaperDeletedCount > 0) parts.push(t('retrieved.orphanCleaned').replace('{n}', String(result.orphanPaperDeletedCount)))
      setMessage(parts.join(' '))
      setSelecting(false); setChecked(new Set()); setConfirming(false)
      onChanged?.()
    } catch (error) {
      setMessage(t('retrieved.failed').replace('{msg}', error instanceof Error ? error.message : String(error)))
    } finally { setRemoving(false) }
  }
  return (
    <section className={`${CSS.panel} ${CSS.papers}`}>
      <h3 className={CSS.panelTitle}>
        {t('panel.papers')}
        <span className={CSS.categoryCount}>{papers.length} {t('papers.results')}</span>
        {retrievedMode && api !== undefined && papers.length > 0 && (
          !selecting
            ? <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={() => { setSelecting(true); setChecked(new Set()) }}>{t('retrieved.select')}</button>
            : (
              <>
                <span className={CSS.categoryCount}>{t('retrieved.selectedCount').replace('{n}', String(checked.size))}</span>
                <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={() => { setSelecting(false); setChecked(new Set()); setConfirming(false) }}>{t('retrieved.cancel')}</button>
                <button
                  type="button"
                  className={`${CSS.button} ${CSS.buttonPrimary}`}
                  disabled={checked.size === 0 || removing}
                  onClick={() => { setConfirming(true) }}
                >
                  {t('retrieved.removeBulk')}
                </button>
              </>
            )
        )}
        {api !== undefined && <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} disabled={importing} onClick={choose}>{importing ? t('import.importing') : `＋ ${t('import.addDocument')}`}</button>}
        <input ref={input} type="file" accept=".pdf,application/pdf" hidden onChange={(event) => { void importFile(event.target.files?.[0]) }} />
      </h3>
      {message !== null && <p className={CSS.searchMessage}>{message}</p>}
      {selecting && checked.size === 0 && papers.length > 0 && (
        <p className={CSS.searchMessage}>
          <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={toggleAllVisible}>{t('retrieved.selectAll') ?? (checked.size === papers.length ? 'Deselect all' : 'Select all')}</button>
        </p>
      )}
      {confirming && (
        <p className={CSS.searchMessage}>
          <span>{t('retrieved.confirmBulk').replace('{n}', String(checked.size))}</span>
          <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={() => { setConfirming(false) }}>{t('retrieved.cancel')}</button>
          <button type="button" className={`${CSS.button} ${CSS.buttonPrimary}`} disabled={removing} onClick={() => { void removeSelected() }}>{t('retrieved.removeBulk')}</button>
        </p>
      )}
      {loading && <p className={CSS.empty}>…</p>}
      {!loading && papers.length === 0 && <p className={CSS.empty}>{t('empty.papers')}</p>}
      {papers.map((paper) => {
        const score = formatAgentScore(paper.finalScore)
        const meta = paperMetaLine(paper)
        const isChecked = checked.has(paper.id)
        return (
          <button
            key={paper.id}
            type="button"
            className={`${CSS.paperCard} ${selectedId === paper.id ? CSS.paperCardActive : ''}`}
            onClick={() => {
              if (selecting) { toggleOne(paper.id); return }
              onSelect(paper.id)
            }}
          >
            <span className={CSS.paperTitle} title={paper.title}>
              {selecting && <input type="checkbox" className={CSS.checkbox} checked={isChecked} onChange={() => { toggleOne(paper.id) }} onClick={(event) => { event.stopPropagation() }} />}
              {paper.title}
            </span>
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
              {paper.favorite && <span className={CSS.flag} data-kind="favorite">★</span>}
            </span>
          </button>
        )
      })}
    </section>
  )
}
