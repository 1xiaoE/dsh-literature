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
import { defineLiteratureSources } from './tools/literature_sources.js'
import { defineLiteratureFetchPdf } from './tools/literature_fetch_pdf.js'
import { defineLiteraturePdfPreflight } from './tools/literature_pdf_preflight.js'
import { defineLiteratureFulltextIndex } from './tools/literature_fulltext_index.js'
import { defineLiteratureFulltextRead } from './tools/literature_fulltext_read.js'
import { defineLiteratureRecord } from './tools/literature_record.js'
import { defineLiteraturePushNow } from './tools/literature_push_now.js'

export const name = 'dsh-literature'
export const inject = ['tools']

export type { LiteratureConfig } from './config.js'
export { chunkText } from './fetch/fulltext.js'

/**
 * Read the harness-resolved model route for provenance without depending on
 * the agent-default-model package: absent service yields null.
 */
function modelRouteReader(ctx: Context): () => string | null {
  return () => {
    try {
      const maybe = ctx as unknown as {
        agentDefaultModel?: { currentSelection?: () => unknown }
      }
      const sel = maybe.agentDefaultModel?.currentSelection?.()
      return sel ? JSON.stringify(sel) : null
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
    defineLiteratureFetchPdf(getRt),
    defineLiteraturePdfPreflight(getRt),
    defineLiteratureFulltextIndex(getRt),
    defineLiteratureFulltextRead(getRt),
    defineLiteratureRecord(getRt, modelRoute),
    defineLiteraturePushNow(getRt, modelRoute),
  ]) {
    ctx.tools.register(tool)
  }
}
