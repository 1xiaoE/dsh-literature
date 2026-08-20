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
import { createCurrentProfileWorkflowRunner } from './ui/adapter.js'
import type { UiModelSelection, UiModelSelectionInput } from './ui/types.js'
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

/**
 * Read provider/model discovery from the active Harness profile. This is a
 * read-only presentation seam: the Harness model dialog remains the owner of
 * selection and credentials, while Literature only mirrors the current value.
 */
function modelSelectionReader(ctx: Context): () => Promise<UiModelSelection> {
  return async () => {
    try {
      const llm = ctx.get('llm') as {
        listProviders?: () => Array<{ id?: string; name?: string }>
        listModels?: (provider: string) => Promise<Array<{ id?: string; name?: string; description?: string }>>
      } | undefined
      const defaultModel = ctx.get('agentDefaultModel') as {
        currentSelection?: () => { provider?: string; model?: string }
      } | undefined
      const rawSelection = defaultModel?.currentSelection?.()
      const current = typeof rawSelection?.provider === 'string' && rawSelection.provider.trim() !== ''
        && typeof rawSelection.model === 'string' && rawSelection.model.trim() !== ''
        ? { provider: rawSelection.provider, model: rawSelection.model }
        : null
      const providers = llm?.listProviders?.() ?? []
      const options = await Promise.all(providers.flatMap((provider) => {
        if (typeof provider.id !== 'string' || provider.id.trim() === '') return []
        const id = provider.id
        return [Promise.resolve(llm?.listModels?.(id) ?? []).then((models) => ({
          provider: id,
          providerName: typeof provider.name === 'string' && provider.name.trim() !== '' ? provider.name : id,
          models: models.flatMap((model) => {
            if (typeof model.id !== 'string' || model.id.trim() === '') return []
            return [{
              id: model.id,
              name: typeof model.name === 'string' && model.name.trim() !== '' ? model.name : model.id,
              ...(typeof model.description === 'string' && model.description.trim() !== '' ? { description: model.description } : {}),
            }]
          }),
        }))]
      }))
      return { current, options }
    } catch {
      return { current: null, options: [] }
    }
  }
}

function modelSelectionWriter(ctx: Context): (input: UiModelSelectionInput) => Promise<UiModelSelection> {
  return async (input) => {
    const svc = ctx.get('agentDefaultModel') as
      | { saveSelection?: (selection: { provider: string; model: string }) => Promise<void> }
      | undefined
    if (svc?.saveSelection === undefined) throw new Error('model selection persistence is unavailable in this Harness profile')
    await svc.saveSelection({ provider: input.provider, model: input.model })
    return modelSelectionReader(ctx)()
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
    const workflowRunner = createCurrentProfileWorkflowRunner({
      agentDefaultModel: ctx.get('agentDefaultModel') as {
        currentSelection?: () => { provider: string; model: string }
      } | undefined,
      agents: ctx.get('agents') as {
        create: (options: {
          sessionId: string
          meta: { cwd: string }
          agentOptions: { provider: string; model: string }
        }) => Promise<{
          agent: {
            followup: (message: {
              id: string
              role: 'user'
              content: Array<{ type: 'text'; text: string }>
              source: { kind: 'user' }
            }) => void
            whenIdle: () => Promise<void>
            session: { events: readonly unknown[] }
          }
          dispose: () => Promise<void>
        }>
      } | undefined,
    })
    ctx.effect(() => webServer.register(makeUiRoutes({
      getRt,
      startPush: workflowRunner.startPush,
      startResume: workflowRunner.startResume,
      modelSelection: modelSelectionReader(ctx),
      saveModelSelection: modelSelectionWriter(ctx),
    })), 'dsh-literature: ui routes')
  }
}
