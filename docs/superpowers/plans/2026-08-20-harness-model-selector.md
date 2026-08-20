# Harness Model Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Literature workbench's read-only Harness model label with a selector that persists the chosen provider/model through the active Harness profile.

**Architecture:** Keep `ctx.llm` and `ctx.agentDefaultModel` as the only catalog and persistence owners. Add a loopback-protected POST route that validates a requested provider/model against the live catalog before calling `ctx.agentDefaultModel.saveSelection()`. The browser uses a grouped native select, updates from the route response, and keeps the current workflow untouched.

**Tech Stack:** TypeScript, React, existing Node HTTP route adapter, Vitest, Harness Cordis services.

## Global Constraints

- Harness remains the source of truth for providers, models, credentials, and the active profile.
- The plugin does not store provider/model settings or API keys.
- The selector writes only the Harness default model for the current profile.
- A running workflow is not changed; the next workflow observes the saved selection.
- The plugin never falls back to another provider after a failed save or run.
- Use the existing loopback and structured-error route conventions.

## File Map

- Modify `src/ui/types.ts` and `src/client/wire.ts` with the selection request/response types.
- Modify `src/index.ts` with a writer callback that validates through the reader and calls `saveSelection`.
- Modify `src/ui/routes.ts` with the guarded POST `/model-selection` handler and structured failures.
- Modify `src/client/api.ts` with `saveModelSelection`.
- Modify `src/client/SearchKeywords.tsx` and `src/client/Workbench.tsx` with the grouped selector, save state, and refreshed selection.
- Modify `src/client/locales.ts` with saving/error/placeholder copy.
- Modify `tests/ui_routes.test.ts`, `tests/client_api.test.ts`, and `tests/client_components.test.tsx` with route, API, and UI coverage.
- Keep `docs/superpowers/specs/2026-08-20-harness-model-selector-design.md` as the design record.

### Task 1: Define the selection write contract and route behavior

**Files:**
- Modify: `src/ui/types.ts`
- Modify: `src/client/wire.ts`
- Modify: `src/ui/routes.ts`
- Modify: `src/index.ts`
- Test: `tests/ui_routes.test.ts`

**Interfaces:**
- Add `UiModelSelectionInput = { provider: string; model: string }` to both wire halves.
- Extend `UiRouteDeps` with `saveModelSelection?: (input: UiModelSelectionInput) => UiModelSelection | Promise<UiModelSelection>`.
- Add POST `/api/dsh-literature/model-selection` accepting exactly non-empty string `provider` and `model` fields.
- On catalog mismatch return `failureFor('INVALID_MODEL')` with HTTP 400.
- On writer failure classify the error with `classifyWorkflowError`, return its structured failure with HTTP 400 for `INVALID_MODEL` and HTTP 500 otherwise.
- In `src/index.ts`, implement `modelSelectionWriter(ctx)` that calls `modelSelectionReader(ctx)`, requires an exact provider/model match in the live catalog, calls `ctx.get('agentDefaultModel').saveSelection({ provider, model })`, then returns a fresh reader result.

- [ ] **Step 1: Write failing route tests**

Add tests that invoke the real route handler with a loopback request:

```ts
it('persists a catalog model through the Harness selection writer', async () => {
  let saved: { provider: string; model: string } | undefined
  const route = makeUiRoutes({
    getRt: () => runtime,
    modelSelection: async () => ({
      current: { provider: 'p', model: 'old' },
      options: [{ provider: 'p', providerName: 'Provider', models: [{ id: 'new', name: 'New' }] }],
    }),
    saveModelSelection: async input => {
      saved = input
      return { current: input, options: [{ provider: 'p', providerName: 'Provider', models: [{ id: 'new', name: 'New' }] }] }
    },
  })
  const response = new CaptureResponse()
  await route.handler(request('POST', '/api/dsh-literature/model-selection', JSON.stringify({ provider: 'p', model: 'new' }), { 'content-type': 'application/json' }), response as unknown as ServerResponse)
  expect(response.status).toBe(200)
  expect(saved).toEqual({ provider: 'p', model: 'new' })
})

it('rejects a model that is not present in the Harness catalog', async () => {
  const route = makeUiRoutes({
    getRt: () => runtime,
    modelSelection: async () => ({
      current: { provider: 'p', model: 'old' },
      options: [{ provider: 'p', providerName: 'Provider', models: [{ id: 'new', name: 'New' }] }],
    }),
  })
  const response = new CaptureResponse()
  await route.handler(request('POST', '/api/dsh-literature/model-selection', JSON.stringify({ provider: 'unknown', model: 'model' }), { 'content-type': 'application/json' }), response as unknown as ServerResponse)
  expect(response.status).toBe(400)
  expect(JSON.parse(response.text())).toMatchObject({ ok: false, errorCode: 'INVALID_MODEL', retryable: false, provider: null, model: null })
})

it('returns a structured failure when Harness refuses to save the selection', async () => {
  const route = makeUiRoutes({
    getRt: () => runtime,
    modelSelection: async () => ({
      current: { provider: 'p', model: 'old' },
      options: [{ provider: 'p', providerName: 'Provider', models: [{ id: 'new', name: 'New' }] }],
    }),
    saveModelSelection: async () => { throw new Error('settings write failed') },
  })
  const response = new CaptureResponse()
  await route.handler(request('POST', '/api/dsh-literature/model-selection', JSON.stringify({ provider: 'p', model: 'new' }), { 'content-type': 'application/json' }), response as unknown as ServerResponse)
  expect(response.status).toBe(500)
  expect(JSON.parse(response.text())).toMatchObject({ ok: false, errorCode: 'NETWORK', retryable: true, provider: 'p', model: 'new' })
})
```

- [ ] **Step 2: Run the route tests and verify the expected RED failure**

Run: `pnpm vitest run tests/ui_routes.test.ts -t "selection"`

Expected: the POST route is not implemented, so the valid request does not return HTTP 200 and the invalid request is not classified as `INVALID_MODEL`.

- [ ] **Step 3: Implement the minimal node contract**

Add the dependency, body validation, catalog lookup, and writer call. Keep the route loopback guard and return the refreshed selection from the writer. Do not write files, environment variables, SQLite settings, or provider-specific values from the plugin.

- [ ] **Step 4: Run the route tests and verify GREEN**

Run: `pnpm vitest run tests/ui_routes.test.ts -t "selection"`

Expected: all selection route tests pass.

### Task 2: Add the browser API and selectable model control

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/SearchKeywords.tsx`
- Modify: `src/client/Workbench.tsx`
- Modify: `src/client/locales.ts`
- Test: `tests/client_api.test.ts`
- Test: `tests/client_components.test.tsx`

**Interfaces:**
- Add `LiteratureApi.saveModelSelection(input: UiModelSelectionInput): Promise<UiModelSelection>` using POST `/api/dsh-literature/model-selection`.
- Add `onModelSelectionSaved?: (selection: UiModelSelection) => void` to `SearchKeywords`.
- Keep `modelSelection` controlled by `Workbench`; the child must not create a second persistent model state.

- [ ] **Step 1: Write failing API and component tests**

Add an API test asserting the exact POST body and returned selection, and a component test asserting the current selection plus grouped provider/model options:

```ts
it('saves the selected Harness model through the model-selection route', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ provider: 'p', model: 'm' }))
    return new Response(JSON.stringify({ current: { provider: 'p', model: 'm' }, options: [] }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  await expect(new LiteratureApi().saveModelSelection({ provider: 'p', model: 'm' })).resolves.toMatchObject({ current: { provider: 'p', model: 'm' } })
})

it('renders Harness models as selectable provider groups', () => {
  const html = renderToStaticMarkup(<SearchKeywords api={api} active={false} modelSelection={selection} />)
  expect(html).toContain('<select')
  expect(html).toContain('Local Gateway')
  expect(html).toContain('Research Large')
})
```

- [ ] **Step 2: Run the API/component tests and verify RED**

Run: `pnpm vitest run tests/client_api.test.ts tests/client_components.test.tsx -t "model|Harness"`

Expected: `saveModelSelection` is missing and the current model row contains no `<select>`.

- [ ] **Step 3: Implement the minimal browser selector**

Render one native `<select>` with one `<optgroup>` per provider and JSON-encoded option values `{ provider, model }`. Disable it while `api.saveModelSelection` is pending. On success call `onModelSelectionSaved` with the returned selection; on failure restore the controlled current value and show the returned structured message. Add localized labels for “select model”, “saving”, and “save failed”.

- [ ] **Step 4: Wire Workbench state and verify GREEN**

Pass `setModelSelection` as `onModelSelectionSaved`. Run:

```sh
pnpm vitest run tests/client_api.test.ts tests/client_components.test.tsx -t "model|Harness"
```

Expected: all API/component selector tests pass.

### Task 3: Full verification and documentation consistency

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`

- [ ] **Step 1: Check docs for the new write behavior**

Document that the selector changes the active Harness profile's default model for future workflow runs, while credentials and provider installation remain Harness-owned. State that a running workflow is not changed and that unavailable models return `INVALID_MODEL` without fallback.

- [ ] **Step 2: Run the complete verification suite**

Run:

```sh
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all tests pass, both TypeScript projects typecheck, the client/node bundle builds, and the diff has no whitespace errors.
