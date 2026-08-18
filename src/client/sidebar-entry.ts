/**
 * Sidebar entry injection for dsh-literature.
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into
 * (`sidebar.workspaces` / `sidebar.settings` are single-occupant and taken),
 * so — following the task-board / ssh precedent — the entry row is injected
 * into the sidebar at the DOM level, between the shell's New Session button
 * and the workspace browser. The injection self-heals: a MutationObserver
 * re-inserts the row whenever a React re-render displaces it.
 *
 * The row is plain DOM (no React tree) so it never disturbs the shell's
 * reconciliation; the workbench it toggles is a separate React root mounted
 * in the center column (see mount.tsx).
 */
import type { LiteratureController } from './controller.ts'
import { subscribeLanguage, t } from './locales.ts'
import { CSS } from './styles.ts'

/** Stable data attribute identifying the injected entry row. */
export const ENTRY_SELECTOR = '[data-dsh-literature-entry]'

/** Book icon, inline SVG matching the shell's 16px nav-icon look. */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.2C6.8 2.4 5 2.2 2.5 2.5v10.3c2.5-.3 4.3-.1 5.5.7 1.2-.8 3-1 5.5-.7V2.5C11 2.2 9.2 2.4 8 3.2z"/><path d="M8 3.2v10.3"/></svg>'

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(controller: LiteratureController): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshLiteratureEntry = ''
  entry.className = CSS.entry
  entry.setAttribute('aria-label', t('entry.label'))
  entry.setAttribute('title', t('entry.tooltip'))
  entry.innerHTML = `<span class="${CSS.entryIcon}">${ICON}</span><span class="${CSS.entryLabel}">${t('entry.label')}</span>`
  entry.addEventListener('click', () => { controller.toggle() })
  return entry
}

/**
 * Re-insert the entry after the family block (task board / ssh), so the
 * three sibling plugin entries keep a stable relative order regardless of
 * observer callback order or shell wrapper changes.
 */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement
        && el.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-literature-entry]'),
    )
    // literature sits after the whole family block.
    const last = family[family.length - 1]
    const anchor = last !== undefined ? last.nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param controller - the workbench controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(controller: LiteratureController): () => void {
  if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {}
  const entry = createEntry(controller)
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })

  // Active highlight when the workbench is open.
  const syncActive = (): void => {
    if (controller.isOpen()) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = controller.subscribe(syncActive)
  const syncLanguage = (): void => {
    entry.setAttribute('aria-label', t('entry.label'))
    entry.setAttribute('title', t('entry.tooltip'))
    const label = entry.querySelector<HTMLElement>(`.${CSS.entryLabel}`)
    if (label !== null) label.textContent = t('entry.label')
  }
  const unsubscribeLanguage = subscribeLanguage(syncLanguage)
  syncActive()

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    unsubscribeLanguage()
    entry.remove()
  }
}
