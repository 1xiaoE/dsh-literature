import { useState } from 'react'
import type { LiteratureApi } from './api.ts'
import { getLanguage, t, type LiteratureKey } from './locales.ts'
import { CSS } from './styles.ts'
import type { UiCategory } from './wire.ts'

interface CategoriesPanelProps {
  api: LiteratureApi
  categories: UiCategory[]
  active: string
  onSelect: (id: string) => void
  onChanged: () => void
}

const GROUP_KEYS: Record<UiCategory['kind'], LiteratureKey> = {
  workflow: 'category.workflow', field: 'category.subjects', topic: 'category.topics',
}

const WORKFLOW: Record<string, { key: LiteratureKey; icon: string }> = {
  all: { key: 'category.all', icon: '▤' }, selected: { key: 'category.selected', icon: '✓' },
  'to-read': { key: 'category.toRead', icon: '◌' },
  read: { key: 'category.read', icon: '▣' }, reports: { key: 'category.reports', icon: '≣' },
  favorites: { key: 'category.favorites', icon: '☆' },
}

function categoryLabel(category: UiCategory): string {
  const workflow = WORKFLOW[category.id]
  if (workflow !== undefined) return t(workflow.key)
  if (category.kind === 'field') return getLanguage() === 'zh-CN' ? category.labelZh ?? category.label : category.labelEn ?? category.label
  return category.label
}

export function CategoriesPanel({ api, categories, active, onSelect, onChanged }: CategoriesPanelProps) {
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UiCategory | null>(null)
  const [menuId, setMenuId] = useState<number | null>(null)
  const [nameEn, setNameEn] = useState('')
  const [nameZh, setNameZh] = useState('')
  const [targetId, setTargetId] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const fields = categories.filter((category) => category.kind === 'field' && category.categoryId !== undefined)
  const startCreate = (): void => { setCreating(true); setEditing(null); setNameEn(''); setNameZh(''); setMessage(null) }
  const startRename = (field: UiCategory): void => {
    setCreating(false); setEditing(field); setMenuId(field.categoryId ?? null)
    setNameEn(field.labelEn ?? field.label); setNameZh(field.labelZh ?? field.label); setMessage(null)
  }
  const submitNames = async (): Promise<void> => {
    try {
      if (editing === null) await api.createField({ nameEn, nameZh })
      else await api.renameField(editing.categoryId!, { nameEn, nameZh })
      setCreating(false); setEditing(null); setMenuId(null); onChanged()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  const merge = async (sourceId: number): Promise<void> => {
    if (targetId === null) return
    try { await api.mergeField(sourceId, targetId); setMenuId(null); onChanged() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  const remove = async (field: UiCategory, mode: 'detach' | 'move'): Promise<void> => {
    try { await api.deleteField(field.categoryId!, mode, mode === 'move' ? targetId ?? undefined : undefined); setMenuId(null); onChanged() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }

  return (
    <section className={`${CSS.panel} ${CSS.categories}`}>
      <h3 className={CSS.panelTitle}>{t('panel.categories')}</h3>
      {(['workflow', 'field', 'topic'] as const).map((kind) => {
        const items = categories.filter((category) => category.kind === kind)
        if (items.length === 0 && kind !== 'field') return null
        return (
          <details key={kind} className={CSS.categoryGroup} open>
            <summary className={CSS.categorySummary}>
              <span>{t(GROUP_KEYS[kind])}</span>
              {kind === 'field' && <button type="button" className={CSS.categoryAdd} onClick={(event) => { event.preventDefault(); startCreate() }}>＋</button>}
            </summary>
            <div className={CSS.categoryBody}>
              {items.map((category) => (
                <div key={category.id} className={CSS.categoryRow}>
                  <button type="button" className={`${CSS.categoryItem} ${active === category.id ? CSS.categoryItemActive : ''}`} onClick={() => { onSelect(category.id) }}>
                    {WORKFLOW[category.id] !== undefined && <span className={CSS.categoryIcon}>{WORKFLOW[category.id]?.icon}</span>}
                    <span className={CSS.categoryLabel}>{categoryLabel(category)}</span>
                    <span className={CSS.categoryCount}>{category.count}</span>
                  </button>
                  {kind === 'field' && <button type="button" className={CSS.categoryManage} aria-label={t('category.manage')} onClick={() => { setMenuId(menuId === category.categoryId ? null : category.categoryId!); setTargetId(null); setMessage(null) }}>⋯</button>}
                  {kind === 'field' && menuId === category.categoryId && (
                    <div className={CSS.categoryMenu}>
                      <button type="button" className={CSS.button} onClick={() => { startRename(category) }}>{t('category.rename')}</button>
                      <select className={CSS.input} value={targetId ?? ''} onChange={(event) => { setTargetId(event.target.value === '' ? null : Number(event.target.value)) }}>
                        <option value="">{t('category.moveTo')}</option>
                        {fields.filter((field) => field.categoryId !== category.categoryId).map((field) => <option key={field.id} value={field.categoryId}>{categoryLabel(field)}</option>)}
                      </select>
                      <button type="button" className={CSS.button} disabled={targetId === null} onClick={() => { void merge(category.categoryId!) }}>{t('category.merge')}</button>
                      <button type="button" className={CSS.button} onClick={() => { void remove(category, 'detach') }}>{t('category.detach')}</button>
                      <button type="button" className={CSS.button} disabled={targetId === null} onClick={() => { void remove(category, 'move') }}>{t('category.delete')}</button>
                    </div>
                  )}
                </div>
              ))}
              {kind === 'field' && creating && (
                <div className={CSS.fieldForm}>
                  <label>{t('category.nameZh')}<input className={CSS.input} value={nameZh} onChange={(event) => { setNameZh(event.target.value) }} /></label>
                  <label>{t('category.nameEn')}<input className={CSS.input} value={nameEn} onChange={(event) => { setNameEn(event.target.value) }} /></label>
                  <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={() => { setCreating(false) }}>{t('category.cancel')}</button>
                  <button type="button" className={`${CSS.button} ${CSS.buttonPrimary}`} onClick={() => { void submitNames() }}>{t('category.create')}</button>
                </div>
              )}
              {kind === 'field' && editing !== null && (
                <div className={CSS.fieldForm}>
                  <label>{t('category.nameZh')}<input className={CSS.input} value={nameZh} onChange={(event) => { setNameZh(event.target.value) }} /></label>
                  <label>{t('category.nameEn')}<input className={CSS.input} value={nameEn} onChange={(event) => { setNameEn(event.target.value) }} /></label>
                  <button type="button" className={`${CSS.button} ${CSS.buttonGhost}`} onClick={() => { setEditing(null) }}>{t('category.cancel')}</button>
                  <button type="button" className={`${CSS.button} ${CSS.buttonPrimary}`} onClick={() => { void submitNames() }}>{t('category.confirm')}</button>
                </div>
              )}
            </div>
          </details>
        )
      })}
      {message !== null && <p className={CSS.searchMessage}>{message}</p>}
    </section>
  )
}
