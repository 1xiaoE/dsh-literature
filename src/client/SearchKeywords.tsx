import { useState } from 'react'
import type { LiteratureApi } from './api.ts'
import { t } from './locales.ts'
import { CSS } from './styles.ts'
import type { UiModelSelection, UiModelSelectionInput, UiRunResult } from './wire.ts'

interface SearchKeywordsProps {
  api: LiteratureApi
  active: boolean
  unavailable?: boolean
  modelSelection?: UiModelSelection | null
  onRunResult?: (result: UiRunResult) => void
  onModelSelectionSaved?: (selection: UiModelSelection) => void
}

export function SearchKeywords({ api, active, unavailable = false, modelSelection = null, onRunResult, onModelSelectionSaved }: SearchKeywordsProps) {
  const [mode, setMode] = useState<'default' | 'custom'>('default')
  const [keyword, setKeyword] = useState('')
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [logPath, setLogPath] = useState<string | null>(null)
  const [logContent, setLogContent] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [modelSaving, setModelSaving] = useState(false)
  const [modelMessage, setModelMessage] = useState<string | null>(null)

  const loadLog = async (path: string): Promise<void> => {
    const log = await api.runnerLog()
    if (log !== null && log.path === path) {
      setLogContent(log.content)
      setLogPath(path)
    } else {
      setLogPath(path)
      setLogContent(null)
    }
  }

  const run = async (): Promise<void> => {
    if (running || active || unavailable) return
    setRunning(true)
    setMessage(null)
    setLogPath(null)
    setLogContent(null)
    setShowLog(false)
    const query = mode === 'custom' ? keyword.trim() : ''
    const result = await api.run(query)
    setRunning(false)
    onRunResult?.(result)
    if (result.logPath !== undefined && result.logPath !== null) void loadLog(result.logPath)
    if (result.ok) {
      setMessage(t('search.started'))
      if (mode === 'custom') setKeyword('')
    } else {
      // Early-exit failures (e.g. ENOSPC at runner boot) now surface here.
      setMessage(`${t('search.failed')} ${result.message}`)
      setShowLog(true)
    }
  }

  const current = modelSelection?.current
  const modelOptions = modelSelection?.options ?? []
  const currentProvider = current === null || current === undefined
    ? null
    : modelOptions.find((option) => option.provider === current.provider)
  const currentModel = currentProvider?.models.find((model) => model.id === current?.model)
  const selectedModelValue = current === null || current === undefined ? '' : JSON.stringify({ provider: current.provider, model: current.model })

  const chooseModel = async (value: string): Promise<void> => {
    let input: UiModelSelectionInput
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { provider?: unknown }).provider !== 'string' || typeof (parsed as { model?: unknown }).model !== 'string') return
      input = { provider: (parsed as { provider: string }).provider, model: (parsed as { model: string }).model }
    } catch {
      return
    }
    setModelSaving(true)
    setModelMessage(null)
    try {
      const selection = await api.saveModelSelection(input)
      onModelSelectionSaved?.(selection)
    } catch (error) {
      setModelMessage(`${t('search.modelSaveFailed')} ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setModelSaving(false)
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
      {modelOptions.length > 0 && (
        <div className={CSS.searchRow}>
          <select
            className={CSS.input}
            aria-label={t('search.selectModel')}
            value={selectedModelValue}
            disabled={modelSaving}
            onChange={(event) => { void chooseModel(event.target.value) }}
          >
            <option value="" disabled>{t('search.selectModel')}</option>
            {modelOptions.map((option) => (
              <optgroup key={option.provider} label={option.providerName}>
                {option.models.map((model) => (
                  <option key={`${option.provider}:${model.id}`} value={JSON.stringify({ provider: option.provider, model: model.id })}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {modelSaving && <span className={CSS.searchMessage}>{t('search.modelSaving')}</span>}
        </div>
      )}
      {modelOptions.length === 0 && current !== null && current !== undefined && (
        <p className={CSS.searchMessage}>
          {t('search.currentModel')}: {currentProvider?.providerName ?? current.provider} · {currentModel?.name ?? current.model}
        </p>
      )}
      {modelMessage !== null && <p className={CSS.searchMessage} role="alert">{modelMessage}</p>}
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
      {logPath !== null && (
        <div className={CSS.searchRow} style={{ marginTop: 4 }}>
          <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={() => { setShowLog((v) => !v) }}>
            {showLog ? t('runner.hide') : t('runner.show')}
          </button>
          {!showLog && <span className={CSS.searchMessage} style={{ fontSize: 11 }}>{logPath}</span>}
        </div>
      )}
      {showLog && logPath !== null && (
        <pre className={CSS.runnerLog}>
          {logContent !== null ? logContent : '…'}
        </pre>
      )}
    </section>
  )
}
