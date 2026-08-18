import { useEffect, useRef, useState } from 'react'
import { LiteratureApi } from './api.ts'
import { CategoriesPanel } from './CategoriesPanel.tsx'
import type { LiteratureController } from './controller.ts'
import { ExecutionPanel } from './ExecutionPanel.tsx'
import { getLanguage, setLanguage, subscribeLanguage, t } from './locales.ts'
import { PaperDetailPanel } from './PaperDetailPanel.tsx'
import { PapersPanel } from './PapersPanel.tsx'
import { SearchKeywords } from './SearchKeywords.tsx'
import { CSS } from './styles.ts'
import { defaultPaperId, isPushActive } from './view-model.ts'
import type { UiCategory, UiDashboard, UiDataMode, UiPaperDetail, UiPaperSummary, UiPushStatus } from './wire.ts'

const POLL_MS = 4000

interface WorkbenchProps { controller: LiteratureController }

function combineModes(modes: Array<UiDataMode | null>): UiDataMode | null {
  if (modes.includes('unavailable')) return 'unavailable'
  if (modes.includes('demo')) return 'demo'
  return modes.includes('live') ? 'live' : null
}

export function Workbench({ controller: _controller }: WorkbenchProps) {
  const apiRef = useRef<LiteratureApi>()
  apiRef.current ??= new LiteratureApi()
  const api = apiRef.current
  const [dashboard, setDashboard] = useState<UiDashboard | null>(null)
  const [status, setStatus] = useState<UiPushStatus | null>(null)
  const [coreMode, setCoreMode] = useState<UiDataMode | null>(null)
  const [paperMode, setPaperMode] = useState<UiDataMode | null>(null)
  const [detailMode, setDetailMode] = useState<UiDataMode | null>(null)
  const [activeCategory, setActiveCategory] = useState('all')
  const [papers, setPapers] = useState<UiPaperSummary[]>([])
  const [papersLoading, setPapersLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<UiPaperDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [language, setLanguageState] = useState(getLanguage())

  useEffect(() => subscribeLanguage(() => { setLanguageState(getLanguage()) }), [])

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const [dashboardResult, statusResult] = await Promise.all([api.dashboard(), api.pushStatus()])
      if (cancelled) return
      setDashboard(dashboardResult.data)
      setStatus(statusResult.data)
      setCoreMode(combineModes([dashboardResult.mode, statusResult.mode]))
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [api, retryKey])

  useEffect(() => {
    let cancelled = false
    setPapersLoading(true)
    // Keep the user's current selection across refreshes: reloading the list
    // must NOT reset the selected paper to the first row (that makes actions
    // like "enrich metadata" appear to jump to a different paper whenever the
    // list order changes). Only fall back to the first paper when the previous
    // selection no longer exists in the new list.
    void api.papers(activeCategory).then((result) => {
      if (cancelled) return
      const next = result.data ?? []
      setPapers(next)
      setSelectedId((current) =>
        current !== null && next.some((p) => p.id === current) ? current : defaultPaperId(next),
      )
      setPaperMode(result.mode)
      setPapersLoading(false)
    })
    return () => { cancelled = true }
  }, [api, activeCategory, retryKey])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      setDetailMode(null)
      setDetailLoading(false)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    void api.paperDetail(selectedId).then((result) => {
      if (cancelled) return
      setDetail(result.data)
      setDetailMode(result.mode)
      setDetailLoading(false)
    })
    return () => { cancelled = true }
  }, [api, selectedId, retryKey])

  const dataMode = combineModes([coreMode, paperMode, detailMode])
  const categories: UiCategory[] = dashboard?.categories ?? []
  useEffect(() => {
    if (dashboard !== null && !categories.some((category) => category.id === activeCategory)) setActiveCategory('all')
  }, [dashboard, categories, activeCategory])
  const backendUnavailable = dataMode === 'unavailable'
  const retry = (): void => {
    setCoreMode(null)
    setPaperMode(null)
    setDetailMode(null)
    setRetryKey((value) => value + 1)
  }
  const categoriesChanged = (): void => { setRetryKey((value) => value + 1) }

  return (
    <div className={CSS.workbench} data-language={language}>
      <header className={CSS.header}>
        <h2 className={CSS.title}>{t('page.title')}</h2>
        {dataMode !== null && (
          <span className={`${CSS.badge} ${dataMode === 'live' ? CSS.badgeLive : dataMode === 'demo' ? CSS.badgeDemo : CSS.badgeUnavailable}`}>
            {dataMode === 'live' ? `● ${t('live.badge')}` : dataMode === 'demo' ? `● ${t('mock.badge')}` : `! ${t('backend.unavailable')}`}
          </span>
        )}
        {dashboard !== null && (
          <span className={CSS.footer}>{dashboard.paperCount} · {dashboard.pushCount} · {dashboard.reportCount} {t('footer.counts')}</span>
        )}
        <div className={CSS.headerActions}>
          {backendUnavailable && <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={retry}>{t('backend.retry')}</button>}
          <button type="button" className={`${CSS.searchMode} ${language === 'zh-CN' ? CSS.searchModeActive : ''}`} onClick={() => { setLanguage('zh-CN') }}>{t('language.zh')}</button>
          <span className={CSS.footer}>|</span>
          <button type="button" className={`${CSS.searchMode} ${language === 'en-US' ? CSS.searchModeActive : ''}`} onClick={() => { setLanguage('en-US') }}>{t('language.en')}</button>
        </div>
      </header>

      {backendUnavailable && (
        <div className={CSS.backendBanner} role="status">
          <span>{t('backend.unavailable')}</span>
          <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={retry}>{t('backend.retry')}</button>
        </div>
      )}

      <div className={CSS.grid}>
        <div className={CSS.topRow}>
          {status === null
            ? <section className={`${CSS.panel} ${CSS.execution}`}><h3 className={CSS.panelTitle}>{t('panel.execution')}</h3><p className={CSS.empty}>{backendUnavailable ? t('backend.unavailable') : '…'}</p></section>
            : <ExecutionPanel status={status} live={dataMode === 'live'} api={api} />}
          <SearchKeywords api={api} active={isPushActive(status)} unavailable={backendUnavailable} />
        </div>
        <div className={CSS.bottomRow}>
          <CategoriesPanel api={api} categories={categories} active={activeCategory} onSelect={setActiveCategory} onChanged={categoriesChanged} />
          <PapersPanel papers={papers} selectedId={selectedId} onSelect={setSelectedId} loading={papersLoading} api={api} onImported={(paperId) => { setActiveCategory('all'); setSelectedId(paperId); setRetryKey((value) => value + 1) }} retrievedMode={activeCategory === 'all' || activeCategory === ''} onChanged={() => { setRetryKey((value) => value + 1) }} />
          <PaperDetailPanel key={detail?.id ?? 'none'} detail={detail} loading={detailLoading} api={api} fields={categories.filter((category) => category.kind === 'field')} onChanged={categoriesChanged} />
        </div>
      </div>
      <p className={CSS.footer}>dsh-literature · {t('footer.adapter')}</p>
    </div>
  )
}
