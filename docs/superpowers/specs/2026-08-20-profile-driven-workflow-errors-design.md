# Profile-Driven Workflow Errors Design

## Goal

Keep `dsh-literature` provider-agnostic: the plugin owns the literature workflow, while the active Harness profile owns the model adapter, provider, model, and credentials.

## Scope and boundary

- The workflow launcher accepts a Harness profile and uses that same profile for plugin installation and execution.
- The plugin does not name or install a model provider, model, or API credential.
- Provider/model metadata is reported only when supplied by the Harness; otherwise it is `null`.
- Existing topic forwarding remains unchanged: `--topic` is passed into the workflow prompt.
- A fresh push with a custom topic forwards that topic; without one, the workflow keeps using the configured current learning topic/stage. The plugin has no hardcoded research-topic fallback.
- Existing SQLite workflow and resume semantics remain the source of truth for persisted literature progress.
- The first fresh push requires a user topic; it is persisted as the workflow topic. Later fresh pushes may omit the custom topic and reuse the latest persisted topic/stage, while an explicit new topic switches the learning track.

## Profile resolution

`bin/dsh-literature-push.mjs` resolves the profile in this order:

1. `--profile <name>`
2. `DSH_LITERATURE_PROFILE`
3. `headless` for backward compatibility with existing cron/systemd invocations

The resolved value is validated as a non-empty profile name, used by `plugin --profile` during installation, and passed to the Harness command during execution. No provider-specific fallback is allowed.

## Structured errors

The shared workflow error contract is:

```ts
type WorkflowErrorCode =
  | 'NO_ADAPTER'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'INVALID_MODEL'
  | 'INVALID_ARGUMENT'
  | 'WORKFLOW_ALREADY_RUNNING'
  | 'RESUME_NOT_AVAILABLE'

interface WorkflowFailure {
  ok: false
  errorCode: WorkflowErrorCode
  retryable: boolean
  provider: string | null
  model: string | null
  message: string
}
```

Harness/child-process output is classified into this contract and sensitive values are not copied into messages. Classification is descriptive only: it never selects a different provider or model.

Policy:

- `NO_ADAPTER`: stop and tell the user to install/configure the adapter in the selected profile.
- `AUTH`: stop and tell the user to reconfigure credentials in the selected profile.
- `INVALID_MODEL`: stop and tell the user the selected profile/model is unsupported.
- `INVALID_ARGUMENT`: stop and report the invalid workflow input.
- `RATE_LIMIT`: retry with exponential backoff, then return a retryable failure if the bound is exhausted.
- `NETWORK`: retry a bounded number of times, then return a retryable failure if the bound is exhausted.
- `WORKFLOW_ALREADY_RUNNING` and `RESUME_NOT_AVAILABLE`: return deterministic non-retryable failures.

The legacy human-readable `message` field remains present for compatibility.

## Retry behavior

Retries apply only to the Harness invocation boundary before any new workflow state is persisted. Defaults are three retries for `RATE_LIMIT` and two retries for `NETWORK`, with exponential delays starting at one second and capped at eight seconds. A retry reuses the exact task, profile, and environment. If the SQLite workflow snapshot changes, retrying stops to avoid duplicating a push; recovery then follows the existing persisted workflow/resume path. No retry invokes a different provider or model.

If the workflow has already persisted progress, the existing `--resume` path is used instead of creating a second workflow. The plugin does not reconstruct or duplicate literature state in the launcher.

## UI and persistence

`UiRunResult` and runner job records expose `errorCode`, `retryable`, `provider`, and `model` alongside the existing message, process identifiers, and log path. Existing route status codes remain compatible, while error bodies use the structured contract for Run/Resume failures. The client preserves the fields and displays the user-facing message without inventing provider information.

The runner job migration adds nullable structured error columns so an asynchronously completed child retains the same classification visible for an immediate failure.

## Testing and acceptance

- Profile parsing and precedence tests prove explicit, environment, and compatibility fallback behavior.
- Tests prove custom topics are preserved.
- Classifier tests cover all required error codes, sensitive-value redaction, retryability, and null provider/model defaults.
- Runner tests prove structured immediate failures and no provider switch during retry.
- Route/client contract tests prove structured Run/Resume responses.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` must pass.
- Source must contain no hardcoded provider names, model IDs, or API keys in the launcher/error policy.
