import { useState } from 'react'
import type { LiteratureApi } from './api.ts'
import { t } from './locales.ts'
import { CSS } from './styles.ts'

interface SearchKeywordsProps {
  api: LiteratureApi
  active: boolean
  unavailable?: boolean
}

export function SearchKeywords({ api, active, unavailable = false }: SearchKeywordsProps) {
  const [mode, setMode] = useState<'default' | 'custom'>('default')
  const [keyword, setKeyword] = useState('')
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    if (running || active || unavailable) return
    setRunning(true)
    setMessage(null)
    const query = mode === 'custom' ? keyword.trim() : ''
    const result = await api.run(query)
    setRunning(false)
    if (result.ok) {
      setMessage(t('search.started'))
      if (mode === 'custom') setKeyword('')
    } else {
      setMessage(`${t('search.failed')} ${result.message}`)
    }
  }

  return (
    <section className={`${CSS.panel} ${CSS.search}`}>
      <h3 className={CSS.panelTitle}>{t('panel.search')}</h3>
      <div className={CSS.searchModes}>
        <button type="button" className={`${CSS.searchMode} ${mode === 'default' ? CSS.searchModeActive : ''}`} onClick={() => { setMode('default'); setMessage(null) }}>
          {t('search.default')}
        </button>
        <button type="button" className={`${CSS.searchMode} ${mode === 'custom' ? CSS.searchModeActive : ''}`} onClick={() => { setMode('custom'); setMessage(null) }}>
          {t('search.custom')}
        </button>
      </div>
      <p className={CSS.searchMessage}>{mode === 'default' ? t('search.defaultDescription') : t('search.customDescription')}</p>
      <div className={CSS.searchRow}>
        {mode === 'custom' && (
          <input
            className={CSS.input}
            type="text"
            placeholder={t('search.placeholder')}
            value={keyword}
            onChange={(event) => { setKeyword(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') void run() }}
          />
        )}
        <button type="button" className={`${CSS.button} ${CSS.buttonPrimary}`} disabled={running || active || unavailable} onClick={() => { void run() }}>
          {running ? t('search.running') : t('search.run')}
        </button>
      </div>
      {active && <p className={CSS.searchMessage}>{t('search.active')}</p>}
      {unavailable && <p className={CSS.searchMessage}>{t('backend.unavailable')}</p>}
      {message !== null && <p className={CSS.searchMessage}>{message}</p>}
    </section>
  )
}
