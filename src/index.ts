/**
 * dsh-literature plugin entry. Registers the literature_* tools on ctx.tools.
 * Model-agnostic by construction: this plugin never calls an LLM and never
 * hardcodes a model id; intelligent steps are executed by the harness-routed
 * agent. Model route is only recorded for provenance (if the harness exposes
 * agentDefaultModel).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeConfig, type LiteratureConfig } from './config.js'
import { createRuntime, type LiteratureRuntime } from './lib/runtime.js'
import { makeUiRoutes, type WebRouteLike } from './ui/routes.js'
import { defineLiteratureSources } from './tools/literature_sources.js'
import { defineLiteratureFetchPdf } from './tools/literature_fetch_pdf.js'
import { defineLiteraturePdfPreflight } from './tools/literature_pdf_preflight.js'
import { defineLiteratureFulltextIndex } from './tools/literature_fulltext_index.js'
import { defineLiteratureFulltextRead } from './tools/literature_fulltext_read.js'
import { defineLiteratureRecord } from './tools/literature_record.js'
import { defineLiteraturePushNow } from './tools/literature_push_now.js'
import { defineLiteratureUserAction } from './tools/literature_user_action.js'
import { defineLiteratureResume } from './tools/literature_resume.js'
import { defineLiteratureReportWrite } from './tools/literature_report_write.js'
import { defineLiteratureRankCandidates } from './tools/literature_rank_candidates.js'

export const name = 'dsh-literature'
export const inject = ['tools']

export type { LiteratureConfig } from './config.js'
export { chunkText } from './fetch/fulltext.js'

/**
 * Read the harness-resolved model route for provenance via the official
 * AgentDefaultModel service (a Cordis Service registered as
 * 'agentDefaultModel'); absent service yields null. Business code never
 * hardcodes a model id.
 */
function modelRouteReader(ctx: Context): () => string | null {
  return () => {
    try {
      const svc = ctx.get('agentDefaultModel') as
        | { currentSelection?: () => { provider?: string; model?: string; reasoningEffort?: string } }
        | undefined
      const sel = svc?.currentSelection?.()
      if (!sel) return null
      const out: Record<string, string> = { provider: String(sel.provider ?? 'unknown'), model: String(sel.model ?? 'unknown') }
      if (sel.reasoningEffort) out.reasoningEffort = String(sel.reasoningEffort)
      return JSON.stringify(out)
    } catch {
      return null
    }
  }
}

export function apply(ctx: Context, config?: Partial<LiteratureConfig>): void {
  const cfg = normalizeConfig(config)
  let runtime: LiteratureRuntime | undefined
  const getRt = (): LiteratureRuntime => (runtime ??= createRuntime(cfg))
  const modelRoute = modelRouteReader(ctx)

  for (const tool of [
    defineLiteratureSources(getRt),
    defineLiteratureRankCandidates(getRt),
    defineLiteratureFetchPdf(getRt),
    defineLiteraturePdfPreflight(getRt),
    defineLiteratureFulltextIndex(getRt),
    defineLiteratureFulltextRead(getRt),
    defineLiteratureRecord(getRt, modelRoute),
    defineLiteraturePushNow(getRt, modelRoute),
    defineLiteratureUserAction(getRt),
    defineLiteratureResume(getRt),
    defineLiteratureReportWrite(getRt),
  ]) {
    ctx.tools.register(tool)
  }

  // Harness UI presentation layer: serve the /api/dsh-literature route family
  // when a web profile provides the webserver. Optional on purpose — the
  // headless profile has no webserver and must stay unaffected. Bundle order
  // (dsh-web-app before dsh-literature) guarantees webServer is active here in
  // web mode; if it is somehow absent the UI simply has no data route.
  const webServer = ctx.get('webServer') as
    | { register: (route: WebRouteLike) => () => void }
    | undefined
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register(makeUiRoutes({ getRt })), 'dsh-literature: ui routes')
  }
}
