import { useState, type ReactNode } from 'react'
import type { LiteratureApi } from './api.ts'
import { getLanguage, t } from './locales.ts'
import { CSS } from './styles.ts'
import { formatAgentScore } from './view-model.ts'
import type { UiCategory, UiPaperDetail } from './wire.ts'

interface PaperDetailPanelProps {
  detail: UiPaperDetail | null
  loading: boolean
  api?: LiteratureApi
  fields?: UiCategory[]
  onChanged?: () => void
}

function Field({ label, value, abstract = false }: { label: string; value: ReactNode; abstract?: boolean }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className={CSS.detailField}>
      <span className={CSS.detailLabel}>{label}</span>
      <span className={abstract ? CSS.detailAbstract : CSS.detailValue}>{value}</span>
    </div>
  )
}

function Section({ title, show, children }: { title: string; show: boolean; children: ReactNode }) {
  if (!show) return null
  return (
    <section className={CSS.detailSection}>
      <h4 className={CSS.detailSectionTitle}>{title}</h4>
      {children}
    </section>
  )
}

function doiUrl(doi: string): string {
  return `https://doi.org/${doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')}`
}

export function PaperDetailPanel({ detail, loading, api, fields, onChanged }: PaperDetailPanelProps) {
  const [favoriteMessage, setFavoriteMessage] = useState<string | null>(null)
  const [favoriteBusy, setFavoriteBusy] = useState(false)
  const [addingField, setAddingField] = useState(false)
  const [fieldId, setFieldId] = useState<number | null>(null)
  const [fieldMessage, setFieldMessage] = useState<string | null>(null)
  const [deepReadStarting, setDeepReadStarting] = useState(false)
  const [enriching, setEnriching] = useState(false)
  if (loading || detail === null) {
    return (
      <section className={`${CSS.panel} ${CSS.details}`}>
        <h3 className={CSS.panelTitle}>{t('panel.details')}</h3>
        <p className={CSS.empty}>{loading ? '…' : t('empty.details')}</p>
      </section>
    )
  }

  const venueYear = [detail.venue?.trim() || null, detail.year === null ? null : String(detail.year)]
    .filter((part): part is string => part !== null)
    .join(' · ')
  const authors = detail.authors.length > 0 ? detail.authors.join(', ') : null
  const score = formatAgentScore(detail.finalScore)
  const metadata = authors !== null || !!detail.affiliation?.trim() || (detail.keywords?.length ?? 0) > 0 || !!detail.abstract?.trim() || !!detail.doi?.trim()
  const evaluation = detail.agentRank !== null || score !== null || !!detail.selectionReason?.trim()
    || !!detail.topic?.trim() || detail.stage !== null
  const fulltext = !!detail.pdfSource?.trim() || detail.isOpenAccess !== null
    || !!(detail.acquisitionOutcome ?? detail.selectionOutcome)?.trim()
    || detail.readCoverage !== null || detail.reportPath !== null || !!detail.fulltextStatus?.trim()
  const researchFields = detail.researchFields ?? []
  const availableFields = (fields ?? []).filter((field) => field.categoryId !== undefined && !researchFields.some((assigned) => assigned.id === field.categoryId))
  const displayField = (field: { nameEn: string; nameZh: string }): string => getLanguage() === 'zh-CN' ? field.nameZh : field.nameEn
  const addField = async (): Promise<void> => {
    if (fieldId === null) return
    if (api === undefined) return
    try { await api.addPaperField(detail.id, fieldId); setAddingField(false); setFieldId(null); onChanged?.() } catch (error) { setFieldMessage(error instanceof Error ? error.message : String(error)) }
  }
  const removeField = async (categoryId: number): Promise<void> => {
    if (api === undefined) return
    try { await api.removePaperField(detail.id, categoryId); onChanged?.() } catch (error) { setFieldMessage(error instanceof Error ? error.message : String(error)) }
  }
  const needsRead = detail.pdfPath !== null && (detail.readCoverage === null || detail.readCoverage === undefined || detail.readCoverage < 1)
  const deepRead = async (): Promise<void> => {
    if (api === undefined) return
    setDeepReadStarting(true); setFieldMessage(null)
    try { await api.deepRead(detail.id); onChanged?.() } catch (error) { setFieldMessage(error instanceof Error ? error.message : String(error)) }
    finally { setDeepReadStarting(false) }
  }
  const enrich = async (): Promise<void> => {
    if (api === undefined) return
    setEnriching(true); setFieldMessage(null)
    try { await api.enrichMetadata(detail.id); onChanged?.() } catch (error) { setFieldMessage(error instanceof Error ? error.message : String(error)) }
    finally { setEnriching(false) }
  }

  return (
    <section className={`${CSS.panel} ${CSS.details}`}>
      <h3 className={CSS.panelTitle}>{t('panel.details')}</h3>
      <header className={CSS.detailHeader}>
        <h2 className={CSS.detailTitle}>{detail.title}</h2>
        {venueYear !== '' && <p className={CSS.detailMeta}>{venueYear}</p>}
        <div className={CSS.detailActions}>
          {detail.doi !== null && detail.doi.trim() !== '' && (
            <a className={`${CSS.button} ${CSS.buttonGhost}`} href={doiUrl(detail.doi)} target="_blank" rel="noreferrer">
              {t('detail.openDoi')}
            </a>
          )}
          {detail.pdfPath !== null && (
            <a className={`${CSS.button} ${CSS.buttonGhost}`} href={`/api/dsh-literature/assets/pdf/${encodeURIComponent(detail.id)}`} target="_blank" rel="noreferrer">
              {t('detail.openPdf')}
            </a>
          )}
          {detail.reportPath !== null && (
            <a className={`${CSS.button} ${CSS.buttonGhost}`} href={`/api/dsh-literature/assets/report/${encodeURIComponent(detail.id)}`} target="_blank" rel="noreferrer">
              {t('detail.readReport')}
            </a>
          )}
          {needsRead && api !== undefined && <button type="button" className={`${CSS.button} ${CSS.buttonPrimary}`} disabled={deepReadStarting || detail.readingStatus === 'running'} onClick={() => { void deepRead() }}>{deepReadStarting || detail.readingStatus === 'running' ? t('detail.deepReading') : t('detail.deepRead')}</button>}
          {detail.metadataStatus === 'partial' && api !== undefined && <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} disabled={enriching} onClick={() => { void enrich() }}>{enriching ? t('detail.enrichingMetadata') : t('detail.enrichMetadata')}</button>}
          {api !== undefined && (
            <button
              type="button"
              className={`${CSS.button} ${CSS.buttonGhost}`}
              disabled={favoriteBusy}
              onClick={() => {
                setFavoriteBusy(true); setFavoriteMessage(null)
                void api.toggleFavorite(detail.id)
                  .then(() => { onChanged?.() })
                  .catch((error) => { setFavoriteMessage(error instanceof Error ? error.message : String(error)) })
                  .finally(() => { setFavoriteBusy(false) })
              }}
            >
              {detail.favorite ? `★ ${t('detail.favoriteRemove')}` : `☆ ${t('detail.favorite')}`}
            </button>
          )}
        </div>
        {favoriteMessage !== null && <p className={CSS.searchMessage}>{favoriteMessage}</p>}
      </header>

      <Section title={t('category.researchFields')} show={researchFields.length > 0 || availableFields.length > 0}>
        <div className={CSS.fieldChips}>
          {researchFields.map((field) => (
            <span key={field.id} className={CSS.fieldChip} title={field.source === 'manual' ? t('category.manual') : t('category.auto')}>
              {displayField(field)}
              <button type="button" aria-label={t('category.remove')} onClick={() => { void removeField(field.id) }}>×</button>
            </span>
          ))}
          {!addingField && api !== undefined && availableFields.length > 0 && <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={() => { setAddingField(true); setFieldMessage(null) }}>＋ {t('category.addField')}</button>}
        </div>
        {addingField && (
          <div className={CSS.fieldPicker}>
            <select className={CSS.input} value={fieldId ?? ''} onChange={(event) => { setFieldId(event.target.value === '' ? null : Number(event.target.value)) }}>
              <option value="">{t('category.addField')}</option>
              {availableFields.map((field) => <option key={field.id} value={field.categoryId}>{getLanguage() === 'zh-CN' ? field.labelZh : field.labelEn}</option>)}
            </select>
            <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={() => { setAddingField(false) }}>{t('category.cancel')}</button>
            <button type="button" className={`${CSS.button} ${CSS.buttonPrimary}`} disabled={fieldId === null} onClick={() => { void addField() }}>{t('category.confirm')}</button>
          </div>
        )}
        {fieldMessage !== null && <p className={CSS.searchMessage}>{fieldMessage}</p>}
      </Section>

      <Section title={t('detail.metadata')} show={metadata}>
        <Field label={t('detail.venue')} value={detail.venue?.trim() || null} />
        <Field label={t('detail.authors')} value={authors} />
        <Field label={t('detail.affiliation')} value={detail.affiliation?.trim() || null} />
        <Field label={t('detail.keywords')} value={detail.keywords?.filter(Boolean).join(', ') || null} />
        <Field label={t('detail.abstract')} value={detail.abstract?.trim() || null} abstract />
        <Field label={t('detail.doi')} value={detail.doi?.trim() || null} />
      </Section>

      <Section title={t('detail.agentEvaluation')} show={evaluation}>
        <Field label={t('detail.agentRank')} value={detail.agentRank === null ? null : `#${detail.agentRank}`} />
        <Field label={t('detail.agentScore')} value={score} />
        <Field label={t('detail.selectionReason')} value={detail.selectionReason?.trim() || null} />
        <Field label={t('detail.topic')} value={detail.topic?.trim() || null} />
        <Field label={t('detail.stage')} value={detail.stage === null ? null : `#${detail.stage}`} />
      </Section>

      <Section title={t('detail.fulltextReport')} show={fulltext}>
        <Field label={t('detail.fulltextSource')} value={detail.pdfSource?.trim() || null} />
        <Field label={t('detail.openAccess')} value={detail.isOpenAccess === null ? null : detail.isOpenAccess ? t('detail.yes') : t('detail.no')} />
        <Field label={t('detail.acquisitionStatus')} value={detail.acquisitionOutcome ?? detail.selectionOutcome} />
        <Field label={t('detail.readCoverage')} value={detail.readCoverage === null || detail.readCoverage === undefined ? (detail.pdfPath !== null ? t('import.unread') : null) : `${detail.readCount}/${detail.fulltextChunks ?? '?'} · ${Math.round(detail.readCoverage * 100)}%`} />
        <Field label={t('detail.reportStatus')} value={detail.reportPath === null ? null : t('detail.available')} />
      </Section>
    </section>
  )
}
