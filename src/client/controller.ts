/**
 * Workbench open/close controller — framework-free state shared by the
 * sidebar entry (active highlight) and the center-column mount (visibility).
 */
export interface LiteratureController {
  isOpen(): boolean
  open(): void
  close(): void
  toggle(): void
  subscribe(listener: () => void): () => void
}

/** Create the controller (open defaults to false). */
export function createLiteratureController(): LiteratureController {
  let open = false
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    isOpen: () => open,
    open: () => {
      if (open) return
      open = true
      emit()
    },
    close: () => {
      if (!open) return
      open = false
      emit()
    },
    toggle: () => {
      open = !open
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
