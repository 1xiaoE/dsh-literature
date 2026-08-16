/**
 * arXiv request-scheduling tests (fake clock/sleep — never waits 3s in real
 * time):
 *
 * A. three consecutive queries: actual HTTP request START times are >= 3.1s
 *    apart (serial scheduler, no concurrency);
 * B. identical normalized query is fetched exactly once (dedup);
 * C. HTTP 429 honors Retry-After, then retries once successfully;
 * D. a second 429 trips the run-level breaker; subsequent searches send no
 *    requests;
 * E. the arXiv breaker does not affect OpenAlex/Crossref (adapter-local);
 * F. no infinite retries: 429 retries at most once (2 requests total).
 *
 * Also verifies the provenance counters (requests/dedupHits/429Count/
 * retryCount/rateLimited/waitMs) and that waitMs reflects scheduler gaps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARXIV_429_RETRY_MS, ARXIV_MIN_INTERVAL_MS, ArxivAdapter, type ArxivStats } from '../src/sources/arxiv.js'
import { OpenAlexAdapter } from '../src/sources/openalex.js'
import type { SearchParams } from '../src/sources/types.js'

/** Fake clock: test code advances time explicitly; sleep records the waits. */
function fakeClock(): {
  now: () => number
  sleep: (ms: number) => Promise<void>
  sleeps: number[]
  advance: (ms: number) => void
} {
  let t = 1_000_000
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const OK_XML = `<?xml version="1.0"?><feed><entry>
  <id>https://arxiv.org/abs/2401.00123v1</id>
  <title>Impedance Control for Legged Locomotion</title>
  <summary>We present compliant control for legged robots.</summary>
  <published>2024-01-05T00:00:00Z</published>
  <author><name>Test Author</name></author>
</entry></feed>`

const Q = (text: string): SearchParams => ({
  queries: [{ text, language: 'en', kind: 'canonical', pool: 'recent' }],
  pool: 'recent',
  recentYears: 5,
  limitPerQuery: 8,
})

/** Stub fetch that records (fakeTimeAtRequest, statusSequence). */
function stubArxivFetch(statuses: number[]): { fn: typeof fetch; calls: number[]; urls: string[] } {
  const calls: number[] = []
  const urls: string[] = []
  let i = 0
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(0) // placeholder; real clock value injected below by caller
    void init
    urls.push(String(url))
    const status = statuses[Math.min(i, statuses.length - 1)] ?? 200
    i += 1
    const headers = new Headers()
    if (status === 429) headers.set('retry-after', '5')
    return new Response(status === 200 ? OK_XML : 'rate limited', {
      status,
      headers,
    })
  }) as typeof fetch
  return { fn, calls, urls }
}

let warnSpy: ReturnType<typeof vi.spyOn> | undefined
afterEach(() => {
  warnSpy?.mockRestore()
  warnSpy = undefined
})

describe('A: serial scheduler — ≥3.1s between request start times', () => {
  it('three consecutive queries are spaced >= 3100ms and never concurrent', async () => {
    const clock = fakeClock()
    const { fn, urls } = stubArxivFetch([200, 200, 200])
    const adapter = new ArxivAdapter(fn, 5000, { now: clock.now, sleep: clock.sleep })
    const multi: SearchParams = {
      queries: [
        { text: 'legged robot control', language: 'en', kind: 'canonical', pool: 'recent' },
        { text: 'impedance control legged robot', language: 'en', kind: 'canonical', pool: 'recent' },
        { text: 'virtual model control', language: 'en', kind: 'canonical', pool: 'recent' },
      ],
      pool: 'recent',
      recentYears: 5,
      limitPerQuery: 8,
    }
    // capture the fake clock at every actual fetch by wrapping
    const atFetch: number[] = []
    const wrapped = (async (url: string, init?: RequestInit) => {
      atFetch.push(clock.now())
      return fn(url, init)
    }) as typeof fetch
    const adapter2 = new ArxivAdapter(wrapped, 5000, { now: clock.now, sleep: clock.sleep })
    const hits = await adapter2.search(multi)
    expect(hits.length).toBe(3) // 3 queries, 1 entry each
    expect(urls.length).toBe(3)
    expect(atFetch[1]! - atFetch[0]!).toBeGreaterThanOrEqual(ARXIV_MIN_INTERVAL_MS)
    expect(atFetch[2]! - atFetch[1]!).toBeGreaterThanOrEqual(ARXIV_MIN_INTERVAL_MS)
    // waitMs accumulates the scheduler gaps
    const stats = adapter2.stats() as unknown as ArxivStats
    expect(stats.waitMs).toBeGreaterThanOrEqual(2 * ARXIV_MIN_INTERVAL_MS)
    expect(stats.requests).toBe(3)
  })
})

describe('B: request-level dedup', () => {
  it('identical normalized query is fetched once and reused', async () => {
    const clock = fakeClock()
    const { fn, urls } = stubArxivFetch([200])
    const adapter = new ArxivAdapter(fn, 5000, { now: clock.now, sleep: clock.sleep })
    const a = await adapter.search(Q('legged robot control'))
    const b = await adapter.search(Q('legged robot control'))
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
    expect(urls.length).toBe(1)
    const stats = adapter.stats() as unknown as ArxivStats
    expect(stats.dedupHits).toBe(1)
    expect(stats.requests).toBe(1)
  })

  it('recent vs landmark pool with identical query text dedup only when filters match', async () => {
    const clock = fakeClock()
    const { fn, urls } = stubArxivFetch([200, 200])
    const adapter = new ArxivAdapter(fn, 5000, { now: clock.now, sleep: clock.sleep })
    const recent: SearchParams = {
      queries: [{ text: 'legged robot', language: 'en', kind: 'canonical', pool: 'recent' }],
      pool: 'recent',
      recentYears: 5,
      limitPerQuery: 8,
    }
    const landmark: SearchParams = {
      queries: [{ text: 'legged robot', language: 'en', kind: 'canonical', pool: 'landmark' }],
      pool: 'landmark',
      recentYears: 5,
      limitPerQuery: 8,
    }
    await adapter.search(recent)
    await adapter.search(landmark)
    // different filters (date clause) → two distinct HTTP queries
    expect(urls.length).toBe(2)
  })
})

describe('C: 429 honors Retry-After', () => {
  it('waits Retry-After seconds, retries once, succeeds', async () => {
    const clock = fakeClock()
    const { fn, urls } = stubArxivFetch([429, 200])
    const adapter = new ArxivAdapter(fn, 5000, { now: clock.now, sleep: clock.sleep })
    const hits = await adapter.search(Q('legged robot'))
    expect(hits.length).toBe(1)
    expect(urls.length).toBe(2) // initial + one retry, no more
    const stats = adapter.stats() as unknown as ArxivStats
    expect(stats['429Count']).toBe(1)
    expect(stats.retryCount).toBe(1)
    // Retry-After: 5 → 5000ms backoff was awaited (plus scheduler gap)
    expect(clock.sleeps.some((ms) => ms >= 5000)).toBe(true)
    expect(stats.rateLimited).toBe(0)
  })
})

describe('D: second 429 trips the breaker', () => {
  it('stops all remaining arXiv requests; subsequent searches are no-ops', async () => {
    const clock = fakeClock()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fn, urls } = stubArxivFetch([429, 429])
    const adapter = new ArxivAdapter(fn, 5000, { now: clock.now, sleep: clock.sleep })
    const multi: SearchParams = {
      queries: [
        { text: 'q1', language: 'en', kind: 'canonical', pool: 'recent' },
        { text: 'q2', language: 'en', kind: 'canonical', pool: 'recent' },
        { text: 'q3', language: 'en', kind: 'canonical', pool: 'recent' },
      ],
      pool: 'recent',
      recentYears: 5,
      limitPerQuery: 8,
    }
    const hits = await adapter.search(multi)
    expect(hits).toEqual([])
    expect(urls.length).toBe(2) // initial + exactly ONE retry, then breaker
    const stats = adapter.stats() as unknown as ArxivStats
    expect(stats.rateLimited).toBe(1)
    // later searches send zero additional requests
    const again = await adapter.search(Q('anything'))
    expect(again).toEqual([])
    expect(urls.length).toBe(2)
  })
})

describe('E: breaker is adapter-local (other sources unaffected)', () => {
  it('an OpenAlex adapter keeps working after the arXiv breaker trips', async () => {
    const clock = fakeClock()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fn: fnArxiv, urls: arxivUrls } = stubArxivFetch([429, 429])
    const arxiv = new ArxivAdapter(fnArxiv, 5000, { now: clock.now, sleep: clock.sleep })
    await arxiv.search(Q('legged robot'))
    expect((arxiv.stats() as unknown as ArxivStats).rateLimited).toBe(1)
    expect(arxivUrls.length).toBe(2)

    // OpenAlex adapter (separate instance/class) still performs requests
    const oaUrls: string[] = []
    const oaFetch = (async (url: string) => {
      oaUrls.push(String(url))
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as typeof fetch
    const openalex = new OpenAlexAdapter(oaFetch, 5000, undefined, 'test-key')
    await openalex.search({
      queries: [{ text: 'x', language: 'en', kind: 'canonical', pool: 'recent' }],
      pool: 'recent',
      recentYears: 5,
      limitPerQuery: 8,
    })
    expect(oaUrls.length).toBe(1)
  })
})

describe('F: finite retries only', () => {
  it('429 is retried at most once — never an infinite loop', async () => {
    const clock = fakeClock()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fn, urls } = stubArxivFetch([429, 429, 429, 429]) // hostile server
    const adapter = new ArxivAdapter(fn, 5000, { now: clock.now, sleep: clock.sleep })
    const multi: SearchParams = {
      queries: [
        { text: 'q1', language: 'en', kind: 'canonical', pool: 'recent' },
        { text: 'q2', language: 'en', kind: 'canonical', pool: 'recent' },
      ],
      pool: 'recent',
      recentYears: 5,
      limitPerQuery: 8,
    }
    await adapter.search(multi)
    expect(urls.length).toBe(2) // q1: 2 requests, then breaker → q2 never sent
    // and a fresh run still never exceeds initial+1 retry per query
    const adapter2 = new ArxivAdapter(fn, 5000, { now: clock.now, sleep: clock.sleep })
    await adapter2.search(Q('fresh query'))
    expect(urls.length).toBe(4) // q1(2) + fresh(2) — bounded, not infinite
  })
})

describe('provenance counters land in perf/pushes via literature_sources', () => {
  it('sources flush arxiv stats into the perf tracker', async () => {
    const clock = fakeClock()
    const { fn } = stubArxivFetch([200])
    const { createRuntime } = await import('../src/lib/runtime.js')
    const { normalizeConfig } = await import('../src/config.js')
    const { SourceRegistry } = await import('../src/sources/registry.js')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { ensureStage } = await import('../src/lib/stages.js')
    const { defineLiteratureSources } = await import('../src/tools/literature_sources.js')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-arxiv-perf-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    ensureStage(rt.db, 'legged_robot_control', 3)
    // arxiv adapter with fake clock; other adapters read-only stubs
    const registry = new SourceRegistry()
    registry.register(new ArxivAdapter(fn, 5000, { now: clock.now, sleep: clock.sleep }))
    const quiet = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch
    const { OpenAlexAdapter } = await import('../src/sources/openalex.js')
    const { CrossrefAdapter } = await import('../src/sources/crossref.js')
    const { UnpaywallAdapter } = await import('../src/sources/unpaywall.js')
    registry.register(new OpenAlexAdapter(quiet, 5000, undefined, undefined))
    registry.register(new CrossrefAdapter(quiet, 5000))
    registry.register(new UnpaywallAdapter('t@t', quiet, 5000))
    rt.registry = registry
    const out = (await (async () => {
      const { defineLiteratureSources } = await import('../src/tools/literature_sources.js')
      const tool = defineLiteratureSources(() => rt)
      return tool.execute({} as never, { signal: new AbortController().signal } as never)
    })()) as { pushId: number }
    const perf = rt.perf.get(out.pushId)
    expect(perf.arxivRequests).toBeGreaterThan(0)
    expect(perf.arxivWaitMs).toBeGreaterThanOrEqual(0)
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
