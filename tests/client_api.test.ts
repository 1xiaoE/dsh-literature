import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiteratureApi } from '../src/client/api.ts'

describe('LiteratureApi workflow errors', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves structured failure fields from Run responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      errorCode: 'AUTH',
      retryable: false,
      provider: null,
      model: null,
      message: '模型认证失败',
    }), { status: 500, headers: { 'content-type': 'application/json' } })))

    await expect(new LiteratureApi().run('契约分层')).resolves.toMatchObject({
      ok: false,
      errorCode: 'AUTH',
      retryable: false,
      provider: null,
      model: null,
      message: '模型认证失败',
    })
  })

  it('reads the Harness-owned current model selection without inventing defaults', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      current: { provider: 'local-gateway', model: 'research-large' },
      options: [{
        provider: 'local-gateway',
        providerName: 'Local Gateway',
        models: [{ id: 'research-large', name: 'Research Large' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(new LiteratureApi().modelSelection()).resolves.toEqual({
      current: { provider: 'local-gateway', model: 'research-large' },
      options: [{
        provider: 'local-gateway',
        providerName: 'Local Gateway',
        models: [{ id: 'research-large', name: 'Research Large' }],
      }],
    })
  })

  it('saves the selected Harness model through the model-selection route', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ provider: 'p', model: 'm' }))
      return new Response(JSON.stringify({ current: { provider: 'p', model: 'm' }, options: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new LiteratureApi().saveModelSelection({ provider: 'p', model: 'm' })).resolves.toMatchObject({ current: { provider: 'p', model: 'm' } })
  })
})
