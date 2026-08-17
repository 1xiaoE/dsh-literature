/** Retrieval latency controls: source query budgets + bounded concurrency. */
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.js'
import { SourceRegistry, selectQueriesForBudget } from '../src/sources/registry.js'
import type { PlannedQuery, SearchHit, SearchParams, SourceAdapter } from '../src/sources/types.js'

function queries(pool: 'recent' | 'landmark'): PlannedQuery[] {
  return [
    ...['c1', 'c2', 'c3'].map((text) => ({ text, language: 'en' as const, kind: 'canonical' as const, pool })),
    ...['s1', 's2'].map((text) => ({ text, language: 'en' as const, kind: 'secondary' as const, pool })),
    ...['stage1', 'stage2', 'stage3', 'seedA', 'seedB'].map((text) => ({ text, language: 'en' as const, kind: 'stage' as const, pool })),
  ]
}

class CountingAdapter implements SourceAdapter {
  calls = 0
  active = 0
  maxActive = 0
  constructor(readonly name: string) {}
  async search(params: SearchParams): Promise<SearchHit[]> {
    this.calls += 1
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await new Promise((r) => setTimeout(r, 2))
    this.active -= 1
    const q = params.queries[0]!
    return [{ query: q.text, paper: { id: `title:${q.text}`, title: q.text, authors: [], metadataSource: this.name } }]
  }
  async expand() { return null }
  async pdfCandidates() { return [] }
}

describe('retrieval query budget', () => {
  it('balanced cap keeps canonical + stage + secondary coverage; landmark cap includes a seed anchor', () => {
    const recent = selectQueriesForBudget(queries('recent'), 4)
    expect(recent).toHaveLength(4)
    expect(new Set(recent.map((q) => q.kind))).toEqual(new Set(['canonical', 'stage', 'secondary']))

    const landmark = selectQueriesForBudget(queries('landmark'), 4)
    expect(landmark).toHaveLength(4)
    expect(landmark.map((q) => q.text)).toContain('seedB') // planner appends curated seeds at the end
  })

  it('arXiv uses the stricter cap and remains serial at the registry level', async () => {
    const cfg = normalizeConfig({ retrieval: { maxQueriesPerPool: 8, arxivMaxQueriesPerPool: 4, sourceConcurrency: 4 } } as never)
    const registry = new SourceRegistry()
    const arxiv = new CountingAdapter('arxiv')
    registry.register(arxiv)
    await registry.searchPool(cfg, queries('recent'), undefined, 'recent')
    expect(arxiv.calls).toBe(4)
    expect(arxiv.maxActive).toBe(1)
  })

  it('normal retrieval adapters use bounded concurrency instead of a serial query waterfall', async () => {
    const cfg = normalizeConfig({ retrieval: { maxQueriesPerPool: 6, arxivMaxQueriesPerPool: 4, sourceConcurrency: 2 } } as never)
    const registry = new SourceRegistry()
    const openalex = new CountingAdapter('openalex')
    registry.register(openalex)
    await registry.searchPool(cfg, queries('recent'), undefined, 'recent')
    expect(openalex.calls).toBe(6)
    expect(openalex.maxActive).toBe(2)
  })
})
