/**
 * Workbench view mounting — the Literature Workflow page.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the workbench takes over the center column
 * at the DOM level: a container is appended inside the center column
 * (`[data-pane="conversation"]` / `[class*="centerCol"]`) as an extra trailing
 * child React never manages, and a stylesheet rule hides the conversation
 * content while the workbench is active. Toggling is a data attribute on
 * <html> — no React involvement, so the conversation subtree underneath stays
 * mounted and stateful.
 */
import { createRoot, type Root } from 'react-dom/client'
import type { LiteratureController } from './controller.ts'
import { Workbench } from './Workbench.tsx'
import { CSS } from './styles.ts'

/** The injected workbench container (kept in the DOM, hidden when inactive). */
export const WORKBENCH_VIEW_SELECTOR = '[data-dsh-literature-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-literature-active'
/** Sibling panels' activation attributes (evicted when this panel opens). */
const SIBLING_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active'] as const
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'literature'

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * Mount the workbench React tree into the center column and bind its
 * visibility to the controller's open state.
 * @param controller - the workbench controller driving the view.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountWorkbench(controller: LiteratureController): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container?.isConnected === true) return
    if (container !== undefined) {
      root?.unmount()
      root = undefined
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshLiteratureView = ''
    container.className = CSS.view
    column.appendChild(container)
    root = createRoot(container)
    root.render(<Workbench controller={controller} />)
  }

  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.isOpen()) {
      // Single-occupant center column: opening this panel evicts sibling
      // panels (task board / ssh), both their html attributes.
      for (const attr of SIBLING_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== PANEL_NAME && controller.isOpen()) controller.close()
  }
  // Jump out on sidebar context clicks (session/workspace rows, New Session).
  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.isOpen()) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
