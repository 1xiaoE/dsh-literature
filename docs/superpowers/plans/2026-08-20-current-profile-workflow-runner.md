# Current-Profile Workflow Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute Web UI literature pushes through the active Harness profile and its currently selected model.

**Architecture:** The Web plugin creates and drives a temporary Harness Agent in-process, passing the exact selection from `agentDefaultModel.currentSelection()`. The existing push and resume prompts remain unchanged; only the UI launch boundary stops spawning the `headless` CLI. The runner ledger records the in-process run so the existing UI status and structured errors remain authoritative.

**Tech Stack:** TypeScript, Cordis, DeepSeek Harness Agent services, SQLite runner ledger, Vitest.

## Global Constraints

- Do not hardcode a provider, model, adapter, profile, endpoint, or credential.
- Read selection only from `ctx.agentDefaultModel.currentSelection()` at launch time.
- Preserve the CLI runner for cron and explicit command-line use.
- `AUTH`, `NO_ADAPTER`, and `INVALID_MODEL` stop without provider fallback.
- No new runtime dependency.

---

### Task 1: Add an in-process runner lifecycle seam

**Files:**
- Modify: `src/lib/runner_service.ts`
- Test: `tests/runner_service.test.ts`

**Interfaces:**
- Produces `RunnerService.startInProcess(kind, selection, task): Promise<UiRunResult-like outcome>`.
- Consumes a callback that starts the active-profile Agent and resolves when it becomes idle.
- Persists `provider` and `model` from the supplied selection, not from text parsing.

- [x] **Step 1: Write the failing test**

```ts
it('records the selected active-profile model for an in-process run', async () => {
  const service = new RunnerService(t.db, { dataDir: t.dir })
  const out = await service.startInProcess('push', { provider: 'chosen', model: 'chosen-model' }, async () => {})
  expect(out).toMatchObject({ ok: true, provider: 'chosen', model: 'chosen-model' })
  expect(service.latestJob()).toMatchObject({ status: 'running', provider: 'chosen', model: 'chosen-model' })
})
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `pnpm test tests/runner_service.test.ts`

Expected: failure because `startInProcess` does not exist.

- [ ] **Step 3: Implement the minimal ledger method**

```ts
async startInProcess(
  kind: RunnerKind,
  selection: { provider: string; model: string },
  start: () => Promise<{ done: Promise<void> }>,
): Promise<RunOutcome> {
  const run = await start()
  void run.done.then(() => finish('exited', 0, 'completed in current Harness profile'))
  return { ok: true, runId, pid: null, logPath: null, ...selection, message: 'started in current Harness profile' }
}
```

The method must retain the double-launch check and classify a rejected
`launch()` promise with `classifyWorkflowError`.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `pnpm test tests/runner_service.test.ts`

Expected: PASS.

### Task 2: Launch the current-profile Agent from the UI adapter

**Files:**
- Modify: `src/ui/adapter.ts`
- Test: `tests/ui_adapter.test.ts`

**Interfaces:**
- Produces `createCurrentProfileWorkflowRunner(ctx)` returning `startPush` and `startResume` route callbacks.
- Consumes `{ agents, agentDefaultModel }` from the current Cordis context.
- Reuses existing `buildTaskPrompt`, `buildResumePrompt`, `pushCliArgs` topic validation, and `RunnerService` status persistence.

- [x] **Step 1: Write the failing test**

```ts
it('starts a UI push with the active profile selection instead of a headless profile', async () => {
  const calls: unknown[] = []
  const runner = createCurrentProfileWorkflowRunner(fakeContext({
    selection: { provider: 'web-provider', model: 'web-model' },
    onCreate: (options) => calls.push(options),
  }))
  await runner.startPush('contract layering', runtime)
  expect(calls).toContainEqual(expect.objectContaining({
    agentOptions: { provider: 'web-provider', model: 'web-model' },
  }))
})
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `pnpm test tests/ui_adapter.test.ts`

Expected: failure because no current-profile runner factory exists.

- [ ] **Step 3: Implement the minimal current-profile launch**

```ts
const selection = agentDefaultModel.currentSelection()
const handle = await agents.create({
  sessionId: `literature-${randomUUID()}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model },
})
handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
return {
  done: (async () => {
    try { await handle.agent.whenIdle() } finally { await handle.dispose() }
  })(),
}
```

Keep the call detached after the route has accepted it, and use the runner
ledger to surface asynchronous failures. Do not call the headless CLI from
these callbacks.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `pnpm test tests/ui_adapter.test.ts`

Expected: PASS.

### Task 3: Wire Web routes to the in-process runner

**Files:**
- Modify: `src/index.ts`
- Modify: `src/ui/routes.ts`
- Test: `tests/ui_routes.test.ts`

**Interfaces:**
- `makeUiRoutes()` receives the current-profile `startPush` / `startResume` callbacks.
- CLI exports `startPush` / `startResume` remain available for non-Web callers.

- [x] **Step 1: Verify the existing route contract accepts a structured runner result**

```ts
it('returns the selected model from the Web current-profile runner', async () => {
  const routes = makeUiRoutes({ getRt, startPush: async () => ({
    ok: true, provider: 'web-provider', model: 'web-model', message: 'started',
  }) })
  const response = await post(routes, '/api/dsh-literature/run', { keyword: 'contract layering' })
  expect(response.body).toMatchObject({ ok: true, provider: 'web-provider', model: 'web-model' })
})
```

- [x] **Step 2: Verify the active-profile launcher test fails before implementation**

Run: `pnpm test tests/ui_routes.test.ts`

Expected: failure because the route result does not carry the active-profile selection.

- [x] **Step 3: Inject the current-profile callbacks in `apply()`**

```ts
const workflowRunner = createCurrentProfileWorkflowRunner(ctx)
makeUiRoutes({
  getRt,
  startPush: workflowRunner.startPush,
  startResume: workflowRunner.startResume,
  modelSelection: modelSelectionReader(ctx),
  saveModelSelection: modelSelectionWriter(ctx),
})
```

The callbacks must be registered only when `webServer` exists. Headless and
CLI paths continue to use their existing entry points.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `pnpm test tests/ui_routes.test.ts`

Expected: PASS.

### Task 4: Verify and document the corrected boundary

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Test: `tests/client_components.test.tsx`

- [x] **Step 1: Add an active-profile runner regression assertion**

```ts
expect(rendered).toContain('web-model')
```

The assertion must exercise an accepted workflow launch using a supplied
current-profile selection.

- [x] **Step 2: Update documentation**

State that the Web UI runner uses the live profile's selected model; the
headless CLI remains a separate, explicitly configured automation path.

- [x] **Step 3: Run full verification**

Run: `pnpm test && pnpm typecheck && pnpm build && git diff --check`

Expected: all tests, typecheck, build and whitespace validation pass.
