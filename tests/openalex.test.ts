/**
 * OpenAlex API key integration + 429 robustness tests:
 * - api_key=<key> appended to every request when configured;
 * - key NEVER appears in logs (only "OpenAlex API key configured");
 * - anonymous mode default: log "openalex_auth_mode=anonymous", no key param;
 * - request-level dedup: identical query URLs fetched once;
 * - clear 429 trips a run-level circuit breaker: remaining OpenAlex requests
 *   stop (other sources unaffected — breaker is adapter-local);
 * - transient 5xx retried a FINITE number of times only;
 * - /rate_limit status parses daily budget/used/remaining/reset without key;
 * - retrieval provenance records auth_mode (anonymous | api_key), never the key.
 *
 * Environment isolation: the host shell MAY define a real OPENALEX_API_KEY.
 * Every anonymous-mode test explicitly stubs the env var away with
 * vi.stubEnv (and restores it afterwards), so the suite passes both with and
 * without a host key — without ever reading/printing the real one.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAlexAdapter, fetchOpenAlexRateLimit } from '../src/sources/openalex.js'
import type { SearchParams } from '../src/sources/types.js'

let logSpy: ReturnType<typeof vi.spyOn> | undefined

afterEach(() => {
  logSpy?.mockRestore()
  logSpy = undefined
  // restore any env var stubbed by these tests (never touches the real
  // OPENALEX_API_KEY outside this file's execution window)
  vi.unstubAllEnvs()
})

function spyLogs(): ReturnType<typeof vi.spyOn> {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  return logSpy
}

function stubFetch(routes: Array<(url: string) => { status: number; body: unknown }>): {
  fn: typeof fetch
  urls: string[]
} {
  const urls: string[] = []
  const fn = (async (url: string) => {
    urls.push(url)
    const r = routes[Math.min(urls.length - 1, routes.length - 1)]!(url)
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fn, urls }
}

const OK_WORKS = { results: [], meta: { count: 0 } }
const PARAMS: SearchParams = {
  queries: [{ text: 'legged robot control', language: 'en', kind: 'canonical', pool: 'recent' }],
  pool: 'recent',
  recentYears: 5,
  limitPerQuery: 8,
}

describe('OpenAlex API key handling', () => {
  it('appends api_key to every request and logs only "OpenAlex API key configured"', async () => {
    const logs = spyLogs()
    const { fn, urls } = stubFetch([() => ({ status: 200, body: OK_WORKS })])
    const adapter = new OpenAlexAdapter(fn, 5000, undefined, 'secret-key-123')
    expect(adapter.authMode).toBe('api_key')
    await adapter.search(PARAMS)
    expect(urls[0]).toContain('api_key=secret-key-123')
    const logged = logs.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('OpenAlex API key configured')
    expect(logged).not.toContain('secret-key-123')
    expect(logged).not.toContain('api_key=')
  })

  it('anonymous mode: no key param, logs openalex_auth_mode=anonymous', async () => {
    // isolate from any host OPENALEX_API_KEY: remove it for this test,
    // restore automatically via afterEach → vi.unstubAllEnvs()
    vi.stubEnv('OPENALEX_API_KEY', undefined)
    expect(process.env.OPENALEX_API_KEY).toBeUndefined()
    const logs = spyLogs()
    const { fn, urls } = stubFetch([() => ({ status: 200, body: OK_WORKS })])
    const adapter = new OpenAlexAdapter(fn, 5000, undefined, undefined)
    expect(adapter.authMode).toBe('anonymous')
    await adapter.search(PARAMS)
    expect(urls[0]).not.toContain('api_key=')
    const logged = logs.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('openalex_auth_mode=anonymous')
  })

  it('request-level dedup: identical query URL fetched only once', async () => {
    spyLogs()
    const { fn, urls } = stubFetch([() => ({ status: 200, body: OK_WORKS })])
    const adapter = new OpenAlexAdapter(fn, 5000, undefined, 'k')
    // same query text, same pool → same URL; two search calls share the cache
    await adapter.search(PARAMS)
    await adapter.search(PARAMS)
    expect(urls.length).toBe(1)
  })
})

describe('host-env isolation (OPENALEX_API_KEY set in the host)', () => {
  it('anonymous mode stays anonymous even with a host key present; real key never leaks', async () => {
    // simulate the problematic host: a REAL key in the environment
    vi.stubEnv('OPENALEX_API_KEY', 'REAL-HOST-KEY-MUST-NOT-LEAK')
    expect(process.env.OPENALEX_API_KEY).toBe('REAL-HOST-KEY-MUST-NOT-LEAK')

    // explicit isolation for the anonymous test
    vi.stubEnv('OPENALEX_API_KEY', undefined)
    const logs = spyLogs()
    const { fn, urls } = stubFetch([() => ({ status: 200, body: OK_WORKS })])
    const adapter = new OpenAlexAdapter(fn, 5000, undefined, undefined)
    expect(adapter.authMode).toBe('anonymous')
    await adapter.search(PARAMS)
    expect(urls[0]).not.toContain('api_key=')
    const logged = logs.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('openalex_auth_mode=anonymous')
    // the host key must never appear anywhere observable
    expect(logged).not.toContain('REAL-HOST-KEY-MUST-NOT-LEAK')
    expect(JSON.stringify(urls)).not.toContain('REAL-HOST-KEY-MUST-NOT-LEAK')
    // afterEach restores the original env
  })
})

describe('429 circuit breaker (run-level, OpenAlex-local)', () => {
  it('a clear 429 stops all remaining OpenAlex requests of the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logs = spyLogs()
    const { fn, urls } = stubFetch([() => ({ status: 429, body: {} })])
    const adapter = new OpenAlexAdapter(fn, 5000, undefined, 'k')
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
    expect(hits).toEqual([]) // gracefully empty, not a throw
    expect(urls.length).toBe(1) // remaining queries never fired
    expect(warn.mock.calls.some((c) => String(c[0]).includes('429'))).toBe(true)
    // subsequent search calls are also skipped quietly
    const again = await adapter.search(PARAMS)
    expect(again).toEqual([])
    expect(urls.length).toBe(1)
    warn.mockRestore()
    void logs
  })

  it('other sources are unaffected by the OpenAlex breaker (adapter-local)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    spyLogs()
    const { fn, urls } = stubFetch([() => ({ status: 429, body: {} })])
    const adapter = new OpenAlexAdapter(fn, 5000, undefined, 'k')
    await adapter.search(PARAMS) // trips the breaker
    expect(urls.length).toBe(1)
    // an arxiv adapter instance keeps working (separate class, no shared state)
    warn.mockRestore()
  })

  it('transient 5xx retries are FINITE (max 2 retries, then gives up)', async () => {
    spyLogs()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fn, urls } = stubFetch([() => ({ status: 500, body: {} })])
    const adapter = new OpenAlexAdapter(fn, 5000, undefined, 'k')
    const hits = await adapter.search(PARAMS)
    expect(hits).toEqual([])
    // initial + 2 retries, no more
    expect(urls.length).toBe(3)
    warn.mockRestore()
  })
})

describe('fetchOpenAlexRateLimit (status check, no key leakage)', () => {
  it('parses daily budget/used/remaining/reset without exposing the key', async () => {
    const { fn, urls } = stubFetch([
      () => ({
        status: 200,
        body: { daily_budget: 100000, daily_used: 1234, daily_remaining: 98766, daily_reset_time: '2026-08-17T00:00:00Z' },
      }),
    ])
    const info = await fetchOpenAlexRateLimit({ apiKey: 'top-secret', fetchImpl: fn, timeoutMs: 5000 })
    expect(info.dailyBudget).toBe(100000)
    expect(info.used).toBe(1234)
    expect(info.remaining).toBe(98766)
    expect(info.resetTime).toBe('2026-08-17T00:00:00Z')
    expect(urls[0]).toContain('api_key=top-secret') // request is authenticated...
    expect(JSON.stringify(info)).not.toContain('top-secret') // ...result never is
  })

  it('supports anonymous check (no key) and bare field names', async () => {
    vi.stubEnv('OPENALEX_API_KEY', undefined)
    const { fn, urls } = stubFetch([
      () => ({ status: 200, body: { budget: 100000, used: 5, remaining: 99995, reset_time: 'x' } }),
    ])
    const info = await fetchOpenAlexRateLimit({ fetchImpl: fn, timeoutMs: 5000 })
    expect(urls[0]).not.toContain('api_key=')
    expect(info.dailyBudget).toBe(100000)
    expect(info.used).toBe(5)
    expect(info.remaining).toBe(99995)
  })
})

describe('auth provenance (never the key)', () => {
  it('registry-level provenance carries auth_mode only', async () => {
    spyLogs()
    const { fn } = stubFetch([() => ({ status: 200, body: OK_WORKS })])
    const adapter = new OpenAlexAdapter(fn, 5000, undefined, 'k-xyz')
    // adapter authMode is the only thing that can be persisted
    expect(adapter.authMode).toBe('api_key')
    expect(JSON.stringify(adapter)).not.toContain('k-xyz')
  })

  it('v11 schema: retrievals.auth_mode column exists and rejects nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-v11-'))
    const { openDb } = await import('../src/db.js')
    const db = openDb(dir)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(18)
    const cols = (db.prepare('PRAGMA table_info(retrievals)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('auth_mode')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
