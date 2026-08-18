/**
 * dsh-literature client half — the DeepSeek Harness visualization UI.
 *
 * Mounts two DOM surfaces without touching the shell's React tree (the
 * sidebar exposes no slot for external plugins; the conversation slot is
 * single-occupant):
 *   - a "Literature" sidebar entry (book icon, family block with task
 *     board / ssh, active highlight);
 *   - the Literature Workflow page in the center column.
 *
 * All data flows through fetch('/api/dsh-literature/*') — served by THIS
 * plugin's node half — which reads the existing SQLite. There is no second
 * database, no new retrieval/ranking/acquisition, and no duplicated workflow.
 */
import { createLiteratureController } from './controller.ts'
import { injectStyles } from './styles.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { mountWorkbench } from './mount.tsx'

/**
 * Minimal structural client context. Cordis hands apply() the real client
 * root context; we only use ctx.effect for lifecycle ownership, so a narrow
 * structural type keeps the bundle free of runtime @deepseek-ai imports.
 */
export interface ClientCtx {
  /** Run a setup function now and its disposer when the fiber unloads. */
  effect<T>(fn: () => T | (() => void), label?: string): void
}

export const inject: string[] = []

/**
 * Mount the literature workbench.
 * @param ctx - client root context (lifecycle only).
 */
export function apply(ctx: ClientCtx): void {
  injectStyles()

  const controller = createLiteratureController()
  const disposers: Array<() => void> = []

  ctx.effect(() => {
    try {
      disposers.push(mountSidebarEntry(controller))
      disposers.push(mountWorkbench(controller))
    } catch (error) {
      // DOM mounting problems degrade the workbench, never the GUI.
      console.error('[dsh-literature] mount failed:', error)
    }
    return () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* best effort on unload */ }
      }
    }
  }, 'dsh-literature: workbench ui')
}
