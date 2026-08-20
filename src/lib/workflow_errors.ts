export type WorkflowErrorCode =
  | 'NO_ADAPTER'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'INVALID_MODEL'
  | 'INVALID_ARGUMENT'
  | 'WORKFLOW_ALREADY_RUNNING'
  | 'RESUME_NOT_AVAILABLE'

export interface WorkflowFailure {
  ok: false
  errorCode: WorkflowErrorCode
  retryable: boolean
  provider: string | null
  model: string | null
  message: string
}

export interface WorkflowErrorContext {
  provider?: string | null
  model?: string | null
}

export interface RetryPolicy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

const NO_RETRY: RetryPolicy = { maxRetries: 0, baseDelayMs: 1000, maxDelayMs: 8000 }
const POLICIES: Record<WorkflowErrorCode, RetryPolicy> = {
  NO_ADAPTER: NO_RETRY,
  AUTH: NO_RETRY,
  RATE_LIMIT: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000 },
  NETWORK: { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 8000 },
  INVALID_MODEL: NO_RETRY,
  INVALID_ARGUMENT: NO_RETRY,
  WORKFLOW_ALREADY_RUNNING: NO_RETRY,
  RESUME_NOT_AVAILABLE: NO_RETRY,
}

const MESSAGES: Record<WorkflowErrorCode, string> = {
  NO_ADAPTER: '当前 profile 没有可用的模型 adapter，请在该 profile 中安装并配置 adapter。',
  AUTH: '模型认证失败，请在当前 profile 中重新配置凭据。',
  RATE_LIMIT: '请求触发限流，稍后将自动重试。',
  NETWORK: '网络请求失败，将自动重试。',
  INVALID_MODEL: '当前 profile 不支持所选模型，请检查 profile 配置。',
  INVALID_ARGUMENT: '工作流参数无效，请检查输入。',
  WORKFLOW_ALREADY_RUNNING: '文献工作流已在运行。',
  RESUME_NOT_AVAILABLE: '当前推送没有可恢复的工作流。',
}

const RETRYABLE = new Set<WorkflowErrorCode>(['RATE_LIMIT', 'NETWORK'])

/** Redact credential-shaped values before text reaches logs or UI payloads. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/((?:api[_ -]?key|access[_ -]?token|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ak|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
}

function metadata(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function retryPolicy(code: WorkflowErrorCode): RetryPolicy {
  return { ...POLICIES[code] }
}

export function failureFor(code: WorkflowErrorCode, _detail = '', context: WorkflowErrorContext = {}): WorkflowFailure {
  return {
    ok: false,
    errorCode: code,
    retryable: RETRYABLE.has(code),
    provider: metadata(context.provider),
    model: metadata(context.model),
    message: MESSAGES[code],
  }
}

/** Classify Harness/runner text without inferring or switching providers. */
export function classifyWorkflowError(text: string, context: WorkflowErrorContext = {}): WorkflowFailure {
  const normalized = text.toLowerCase()
  const code: WorkflowErrorCode =
    /invalid[\s_-]+argument|missing required|unknown option|usage:|too many arguments|expected \d+ arguments/.test(normalized) ? 'INVALID_ARGUMENT'
      : /no (?:model )?adapter|adapter (?:missing|not found|unavailable)|install.+adapter/.test(normalized) ? 'NO_ADAPTER'
        : /authentication|unauthorized|invalid.+(?:api )?key|api key.+invalid|credential|\b401\b/.test(normalized) ? 'AUTH'
          : /invalid model|unsupported model|model.+(?:not found|unavailable)|unknown model/.test(normalized) ? 'INVALID_MODEL'
            : /rate limit|too many requests|\b429\b|quota exceeded/.test(normalized) ? 'RATE_LIMIT'
              : /network|econn|etimedout|timeout|fetch failed|dns|socket|connection refused|\b50[234]\b/.test(normalized) ? 'NETWORK'
                : 'NETWORK'
  return failureFor(code, redactSensitiveText(text), context)
}
