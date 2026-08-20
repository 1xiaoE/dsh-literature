import { describe, expect, it } from 'vitest'
import {
  classifyWorkflowError,
  failureFor,
  retryPolicy,
  type WorkflowErrorCode,
} from '../src/lib/workflow_errors.js'

describe('workflow error contract', () => {
  it('classifies invalid credentials as AUTH without leaking the key', () => {
    const failure = classifyWorkflowError('Authentication Fails, Your api key: sk-secret-123 is invalid')
    expect(failure).toMatchObject({ ok: false, errorCode: 'AUTH', retryable: false, provider: null, model: null })
    expect(failure.message).not.toContain('sk-secret-123')
  })

  it.each<[string, WorkflowErrorCode]>([
    ['adapter missing', 'NO_ADAPTER'],
    ['rate limit exceeded', 'RATE_LIMIT'],
    ['ECONNRESET network error', 'NETWORK'],
    ['invalid model name', 'INVALID_MODEL'],
    ['invalid argument: topic', 'INVALID_ARGUMENT'],
    ['[dsh-literature] INVALID_ARGUMENT: workflow arguments are invalid', 'INVALID_ARGUMENT'],
    ['too many arguments. Expected 0 arguments but got 1', 'INVALID_ARGUMENT'],
  ])('classifies %s', (text, code) => {
    expect(classifyWorkflowError(text).errorCode).toBe(code)
  })

  it('has bounded retry policy and never marks auth/model errors retryable', () => {
    expect(retryPolicy('RATE_LIMIT')).toEqual({ maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000 })
    expect(retryPolicy('NETWORK')).toEqual({ maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 8000 })
    expect(retryPolicy('AUTH').maxRetries).toBe(0)
    expect(retryPolicy('INVALID_MODEL').maxRetries).toBe(0)
  })

  it('uses Harness-supplied metadata only and gives user-facing messages', () => {
    expect(failureFor('AUTH', 'bad credentials', { provider: 'profile-provider', model: 'profile-model' })).toEqual({
      ok: false,
      errorCode: 'AUTH',
      retryable: false,
      provider: 'profile-provider',
      model: 'profile-model',
      message: '模型认证失败，请在当前 profile 中重新配置凭据。',
    })
  })
})
