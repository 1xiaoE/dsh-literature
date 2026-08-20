# Profile-Driven Workflow Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the literature plugin profile-driven and return classified, retry-aware workflow errors without naming or switching providers.

**Architecture:** Keep the existing Harness CLI boundary and topic workflow intact. Add one provider-neutral error module used by the launcher and UI runner, pass a resolved profile through the existing install/run path, and persist structured runner errors in the existing SQLite job ledger.

**Tech Stack:** TypeScript, Node.js `child_process`, SQLite migrations, Vitest, existing React client wire types.

## Global Constraints

- The plugin owns literature workflow execution only; the selected Harness profile owns provider, adapter, model, and credentials.
- No provider name, model ID, or API key may be added to plugin code, prompts, defaults, tests, or documentation.
- No automatic provider/model fallback is allowed.
- Custom topics must continue to be forwarded unchanged to the workflow.
- A fresh push may omit a custom topic; the workflow then resolves its configured current learning topic/stage. No concrete research topic may be embedded in launcher code.
- Preserve unrelated existing worktree changes.
- Use existing dependencies and Node standard-library APIs only.

## Files and responsibilities

- Create: `src/lib/workflow_errors.ts` — error-code type, structured failure shape, classifier, safe message helpers, and retry policy.
- Create: `tests/workflow_errors.test.ts` — classifier, redaction, retry policy, and provider/model null-default tests.
- Modify: `bin/dsh-literature-push.mjs` — parse/resolve `--profile`, use it for install and execution, capture child output, and perform bounded retry without provider switching.
- Create: `tests/push_cli.test.ts` — pure CLI argument/profile/topic helper tests; keep subprocess tests limited to deterministic helpers.
- Modify: `src/lib/runner_service.ts` — expose structured runner error fields, classify immediate failures, and persist them.
- Modify: `src/ui/types.ts`, `src/client/wire.ts` — expose the shared structured result shape.
- Modify: `src/ui/adapter.ts` — pass profile to the launcher, return structured failures, and map runner rows.
- Modify: `src/ui/routes.ts` — return structured invalid-argument, already-running, and resume-unavailable errors.
- Modify: `src/client/api.ts` — preserve structured HTTP errors in Run/Resume results.
- Modify: `src/migrations/021_runner_jobs.ts`, `src/migrations/index.ts`, `src/db.ts`, `schema.sql` — add runner error columns and advance schema version.
- Modify: `src/tools/literature_push_now.ts`, `src/tools/literature_sources.ts`, `src/lib/planner.ts` — require the first topic, persist/reuse the latest topic, and preserve arbitrary user topics through source planning.
- Modify: `tests/runner_service.test.ts`, `tests/ui_routes.test.ts` — cover persistence and HTTP contract.

### Task 1: Lock the provider-neutral error contract

**Files:**
- Create: `src/lib/workflow_errors.ts`
- Test: `tests/workflow_errors.test.ts`

**Interfaces:**
- Produces `WorkflowErrorCode`, `WorkflowFailure`, `classifyWorkflowError(text, context?)`, `failureFor(code, message, context?)`, `retryPolicy(code)`, and `redactSensitiveText(text)`.
- `provider` and `model` default to `null`; callers may pass values only when Harness supplies them.

- [ ] **Step 1: Write failing tests**

```ts
it('classifies invalid credentials as AUTH without leaking the key', () => {
  const failure = classifyWorkflowError('Authentication Fails, Your api key: sk-secret-123 is invalid')
  expect(failure).toMatchObject({ ok: false, errorCode: 'AUTH', retryable: false, provider: null, model: null })
  expect(failure.message).not.toContain('sk-secret-123')
})

it.each([
  ['adapter missing', 'NO_ADAPTER'],
  ['rate limit exceeded', 'RATE_LIMIT'],
  ['ECONNRESET network error', 'NETWORK'],
  ['invalid model name', 'INVALID_MODEL'],
  ['invalid argument: topic', 'INVALID_ARGUMENT'],
])('classifies %s', (text, code) => {
  expect(classifyWorkflowError(text).errorCode).toBe(code)
})

it('has bounded retry policy and never marks auth/model errors retryable', () => {
  expect(retryPolicy('RATE_LIMIT')).toEqual({ maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000 })
  expect(retryPolicy('NETWORK')).toEqual({ maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 8000 })
  expect(retryPolicy('AUTH').maxRetries).toBe(0)
})
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm vitest run tests/workflow_errors.test.ts`

Expected: FAIL because the new module and exports do not exist.

- [ ] **Step 3: Implement the minimal classifier**

Use ordered, provider-neutral token checks: invalid arguments, missing adapter, auth/credential failures, invalid model, rate-limit markers, then network markers; otherwise return `INVALID_ARGUMENT` only for explicit caller validation and a safe generic `NETWORK` for an unknown non-zero runner failure. Redact API-key-like values and credential suffixes before building `message`. Keep the source free of provider/model literals.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `pnpm vitest run tests/workflow_errors.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit when repository permissions allow**

```bash
git add src/lib/workflow_errors.ts tests/workflow_errors.test.ts
git commit -m "feat: add provider-neutral workflow errors"
```

### Task 2: Make the CLI profile-driven and retry only classified transient failures

**Files:**
- Modify: `bin/dsh-literature-push.mjs`
- Create: `tests/push_cli.test.ts`

**Interfaces:**
- Produces pure helpers `parseArgs`, `resolveProfile`, `buildHarnessArgs`, and `buildInstallArgs` that tests can import without running `main()`.
- `--profile` has precedence over `DSH_LITERATURE_PROFILE`; the compatibility fallback is `headless`.

- [ ] **Step 1: Write failing helper tests**

```ts
it('uses explicit profile before the environment and compatibility fallback', () => {
  expect(resolveProfile({ profile: 'research' }, { DSH_LITERATURE_PROFILE: 'env-profile' })).toBe('research')
  expect(resolveProfile({ profile: undefined }, { DSH_LITERATURE_PROFILE: 'env-profile' })).toBe('env-profile')
  expect(resolveProfile({ profile: undefined }, {})).toBe('headless')
})

it('passes the same profile to install and execution', () => {
  expect(buildInstallArgs('research')).toContain('--profile')
  expect(buildHarnessArgs('research', 'topic prompt')).toEqual(expect.arrayContaining(['--profile', 'research', 'topic prompt']))
})

it('preserves custom topic text in the task prompt', () => {
  expect(buildTaskPrompt('契约分层')).toContain('主题：契约分层')
})

it('uses configured learning context when no custom topic is supplied', () => {
  const prompt = buildTaskPrompt(undefined)
  expect(prompt).toContain('当前 profile/配置中的学习主题与阶段')
  expect(prompt).not.toContain('足式机器人控制')
})
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm vitest run tests/push_cli.test.ts`

Expected: FAIL because profile helpers and injectable main guard do not exist.

- [ ] **Step 3: Implement profile resolution and bounded retry**

Parse `--profile`, validate non-empty values, install with the resolved profile, and invoke the Harness command with that exact profile. Capture stdout/stderr for each attempt, relay it to the parent process, classify non-zero output, and retry only `RATE_LIMIT` and `NETWORK` using the shared policy. Stop retrying when the SQLite workflow snapshot changes, so a persisted push is never duplicated. Use a bounded synchronous delay compatible with the current synchronous CLI wrapper. Keep the original prompt and environment unchanged for every retry.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `pnpm vitest run tests/push_cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify first-topic and persisted-topic behavior**

Run: `pnpm vitest run tests/push_now_topic.test.ts tests/planner.test.ts`

Expected: the first push without a topic returns `INVALID_ARGUMENT`; a supplied arbitrary topic is persisted, reused by a later topic-less push, and preserved by source planning instead of falling back to a preset.

- [ ] **Step 6: Run existing runner CLI tests**

Run: `pnpm vitest run tests/runner_service.test.ts tests/ui_routes.test.ts`

Expected: existing behavior remains green.

### Task 3: Persist and expose structured runner failures

**Files:**
- Modify: `src/migrations/021_runner_jobs.ts`
- Modify: `src/migrations/index.ts`
- Modify: `src/db.ts`
- Modify: `schema.sql`
- Modify: `src/lib/runner_service.ts`
- Modify: `src/ui/types.ts`
- Modify: `src/client/wire.ts`
- Modify: `src/ui/adapter.ts`
- Test: `tests/runner_service.test.ts`

**Interfaces:**
- `RunnerJob` and `RunOutcome` expose `errorCode`, `retryable`, `provider`, and `model`.
- New migration version adds nullable `error_code`, integer `retryable`, `provider`, and `model` columns to `runner_jobs`.

- [ ] **Step 1: Write failing persistence tests**

```ts
it('persists structured authentication failure details', async () => {
  const out = await service.start('push', ['-e', "console.error('Authentication Fails, Your api key: secret is invalid'); process.exit(1)"], { bin: process.execPath })
  expect(out).toMatchObject({ ok: false, errorCode: 'AUTH', retryable: false, provider: null, model: null })
  expect(service.latestJob()).toMatchObject({ errorCode: 'AUTH', retryable: false, provider: null, model: null })
})
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm vitest run tests/runner_service.test.ts -t "structured authentication"`

Expected: FAIL because the runner result and database row have no structured fields.

- [ ] **Step 3: Add the migration and wire classification**

Bump `SCHEMA_VERSION` and `schema.sql` to 22. Add the four nullable runner columns. Have `RunnerService` classify immediate child failures, store safe fields, and return them. Keep normal running/success results with null error fields. Map persisted rows without changing the existing lifecycle states.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest run tests/runner_service.test.ts`

Expected: PASS.

### Task 4: Return the same contract through HTTP and client wires

**Files:**
- Modify: `src/ui/types.ts`
- Modify: `src/client/wire.ts`
- Modify: `src/ui/adapter.ts`
- Modify: `src/ui/routes.ts`
- Modify: `src/client/api.ts`
- Modify: `tests/ui_routes.test.ts`

**Interfaces:**
- `UiRunResult` uses the full `WorkflowFailure` fields for failures while preserving `message`, `pid`, `logPath`, and optional `pushId`.
- Route-generated errors use `INVALID_ARGUMENT`, `WORKFLOW_ALREADY_RUNNING`, and `RESUME_NOT_AVAILABLE` rather than an ad hoc `{ error: string }` body.

- [ ] **Step 1: Write failing route contract tests**

```ts
it('returns structured already-running errors', async () => {
  db.prepare(`INSERT INTO pushes (topic, status) VALUES ('control', 'running')`).run()
  const response = await invoke(db, request('POST', '/api/dsh-literature/run', JSON.stringify({ keyword: '' })))
  expect(JSON.parse(response.text())).toMatchObject({ ok: false, errorCode: 'WORKFLOW_ALREADY_RUNNING', retryable: false, provider: null, model: null })
})
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm vitest run tests/ui_routes.test.ts -t "structured already-running"`

Expected: FAIL because the route currently returns `{ error: ... }`.

- [ ] **Step 3: Implement route/client compatibility**

Use a single response helper for deterministic route failures. Accept an optional profile in the launcher boundary only if the caller supplies it; otherwise inherit the configured profile. Preserve structured fields when `fetch` rejects in the browser client. Do not make the UI infer provider/model from logs.

- [ ] **Step 4: Run focused route and client tests**

Run: `pnpm vitest run tests/ui_routes.test.ts tests/client_components.test.tsx`

Expected: PASS.

### Task 5: Verify the complete change

**Files:**
- Modify: `README.md`, `README.zh.md`, and `DESIGN.md` only if existing hardcoded profile/provider wording contradicts the new boundary.
- Test: full repository suite.

- [ ] **Step 1: Search for forbidden coupling**

Run: `rg -n -i "modlens|codex|claude|deepseek api|api key|gpt-[0-9]" src bin tests package.json README.md README.zh.md DESIGN.md`

Expected: no new provider/model/API-key coupling introduced by this change; existing framework references are reviewed and only boundary-accurate wording remains.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Run all tests**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 4: Build the package**

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 5: Inspect final diff and report environment limitation**

Run: `git diff --check; git status --short`

Expected: only intended implementation files plus pre-existing user changes are present. If `.git/index` remains read-only, report that the design/implementation commits could not be created rather than claiming a commit.
