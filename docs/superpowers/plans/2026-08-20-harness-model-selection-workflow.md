# Harness Model Selection Workflow Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the literature workflow uses the provider/model selected in the currently running Harness profile, while keeping all provider, model, adapter, and credential ownership inside Harness.

**Architecture:** The web plugin derives the outer Harness profile from the launcher invocation and passes it explicitly to `dsh-literature-push.mjs`. The runner then starts the same profile, whose persisted `agentDefaultModel` selection is already the source of truth used by the Harness new-chat dialog. The Literature UI exposes only read-only current-model provenance; it does not create a second model configuration surface.

**Tech Stack:** TypeScript, React, Vitest, Harness `ctx.llm`/`ctx.agentDefaultModel` services, existing HTTP route and runner layers.

## Global Constraints

- dsh-literature must not hardcode Codex, DeepSeek, Claude, modlens, a provider id, a model id, or an API key.
- Harness profile selection remains the source of provider, adapter, model, and credential configuration.
- Model selection must be provider-neutral and read from the active Harness profile; no plugin-owned provider/model registry is allowed.
- Authentication failures remain `AUTH` and must not trigger provider/model fallback.
- Preserve the existing custom-topic and default-learning-context behavior.
- Do not change the literature workflow implementation or add a second LLM execution path.

---

### Task 1: Preserve the outer Harness profile when the UI launches the runner

**Files:**
- Modify: `src/ui/adapter.ts` — add a pure launcher-profile resolver and pass the resolved profile to `dsh-literature-push.mjs`.
- Test: `tests/ui_adapter.test.ts` — cover `--profile`, the `web` alias, and environment fallback.

**Interfaces:**
- Produces `currentHarnessProfile(argv?: readonly string[], env?: NodeJS.ProcessEnv): string | undefined`.
- `spawnCli()` prepends `--profile <current-profile>` when the outer Harness invocation exposes one.
- If no profile can be discovered, preserve the existing launcher fallback to `headless`.

- [x] **Step 1: Write the failing test**

Add assertions that `currentHarnessProfile(['/node', '/dsh/bin.ts', '--profile', 'research'], {})` returns `research`, `currentHarnessProfile(['/node', '/dsh/bin.ts', 'web'], {})` returns `web`, and an environment-only invocation returns `DSH_LITERATURE_PROFILE`.

- [ ] **Step 2: Run the focused test and verify it fails for the missing helper**

Run: `pnpm vitest run tests/ui_adapter.test.ts -t "resolves the profile selected by the outer Harness invocation"`

Expected: FAIL because `currentHarnessProfile` is not exported yet.

- [ ] **Step 3: Implement the minimal profile resolver and argv propagation**

Parse `--profile <name>`, `--profile=<name>`, and the `web` alias from the outer process argv. Use `DSH_LITERATURE_PROFILE` only when argv has no explicit profile. In `spawnCli`, pass `['--profile', profile]` before the existing `--topic`/`--resume` arguments.

- [ ] **Step 4: Run the focused test and the existing runner-argv tests**

Run: `pnpm vitest run tests/ui_adapter.test.ts -t "resolves the profile selected|builds the existing CLI argv|maps resume"`

Expected: PASS, with existing topic/resume behavior unchanged.

- [ ] **Step 5: Commit the isolated profile propagation change**

Run: `git add src/ui/adapter.ts tests/ui_adapter.test.ts && git commit -m "fix: preserve Harness profile for literature runner"`

If the workspace Git index remains read-only, retain the working-tree changes and report that commit creation was blocked.

---

### Task 2: Expose Harness-owned current model provenance to the Literature UI

**Files:**
- Modify: `src/index.ts` — read current selection from `ctx.agentDefaultModel` and discover available providers/models through `ctx.llm`.
- Modify: `src/ui/routes.ts` — add a loopback-only `GET /api/dsh-literature/model-selection` endpoint.
- Modify: `src/ui/types.ts` and `src/client/wire.ts` — define provider-neutral model-selection DTOs.
- Modify: `src/client/api.ts` — fetch the model-selection DTO.
- Test: `tests/ui_routes.test.ts`, `tests/client_api.test.ts` — verify the route and client preserve Harness-owned values.

**Interfaces:**
- `UiModelSelection` contains `current: { provider: string; model: string } | null` and `options: Array<{ provider: string; providerName: string; models: Array<{ id: string; name: string; description?: string }> }>`.
- The route reads `ctx.llm.listProviders()` and `ctx.llm.listModels(provider)`; it never supplies defaults.
- The route reads `ctx.agentDefaultModel.currentSelection()` and never writes settings.
- If discovery is unavailable, return an empty options list and a null current selection rather than inventing a provider/model.

- [ ] **Step 1: Write failing route/client tests**

Add a route test with fake Harness services exposing two arbitrary providers and models, then assert the JSON preserves both provider/model identities and the current selection. Add a client test asserting `api.modelSelection()` decodes the same DTO.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm vitest run tests/ui_routes.test.ts tests/client_api.test.ts -t "model selection"`

Expected: FAIL because the endpoint, DTO, and client method do not exist.

- [ ] **Step 3: Implement the read-only Harness discovery callback and route**

Extend `UiRouteDeps` with an optional async `modelSelection` callback. In `src/index.ts`, create the callback from `ctx.llm` and `ctx.agentDefaultModel`; use only service-returned provider/model strings. Register `GET /model-selection` with the existing loopback and JSON guards.

- [ ] **Step 4: Implement the client DTO and API method**

Add mirrored browser/node types and a `modelSelection()` method that uses the existing live API/failure handling conventions.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run tests/ui_routes.test.ts tests/client_api.test.ts -t "model selection"` and `pnpm typecheck`.

Expected: PASS with no provider-specific literals in plugin code.

- [ ] **Step 6: Commit the read-only model provenance surface**

Run: `git add src/index.ts src/ui/routes.ts src/ui/types.ts src/client/wire.ts src/client/api.ts tests/ui_routes.test.ts tests/client_api.test.ts && git commit -m "feat: expose Harness model selection to literature UI"`

If the workspace Git index remains read-only, retain the working-tree changes and report that commit creation was blocked.

---

### Task 3: Show the current Harness model without duplicating model configuration

**Files:**
- Modify: `src/client/SearchKeywords.tsx` — load and display the current provider/model as read-only metadata near the run controls.
- Modify: `src/client/locales.ts` — add localized labels for current model and unavailable selection.
- Modify: `src/client/styles.ts` — use existing panel styling or add one small metadata style.
- Test: existing client component tests or the nearest UI test file — assert current-model display and graceful empty state.

**Interfaces:**
- The Literature UI never renders provider/model editors or credentials.
- Clicking the Harness new-chat model selection remains the only model configuration action.
- A changed Harness selection is visible after the next model-selection fetch/panel render.

- [ ] **Step 1: Write the failing component test**

Render `SearchKeywords` with a fake API returning an arbitrary current selection and assert the provider/model label is shown; render with null selection and assert the panel remains usable without a fake default.

- [ ] **Step 2: Run the focused UI test and verify it fails**

Run the repository’s existing client test command filtered to the new case.

Expected: FAIL because `SearchKeywords` does not request or render model provenance.

- [ ] **Step 3: Implement the read-only display**

Fetch `api.modelSelection()` on mount, render the returned current selection, and keep Run behavior unchanged. Do not add selection mutation, provider fallback, or credential inputs.

- [ ] **Step 4: Run focused UI tests and build the client**

Run: `pnpm test -- --runInBand` is not supported by Vitest; instead run the relevant Vitest file(s), then `pnpm typecheck` and `pnpm build`.

Expected: PASS; build warnings, if any, are limited to the existing tsdown warnings.

- [ ] **Step 5: Commit the read-only UI display**

Run: `git add src/client/SearchKeywords.tsx src/client/locales.ts src/client/styles.ts tests/client_components.test.tsx && git commit -m "feat: show Harness model in literature panel"`

If the workspace Git index remains read-only, retain the working-tree changes and report that commit creation was blocked.

---

### Task 4: Verify end-to-end profile/model behavior and regressions

**Files:**
- Modify: `tests/push_cli.test.ts` or `tests/ui_adapter.test.ts` only if an end-to-end argv assertion is needed.
- Modify: documentation only if the user-facing run instructions need to state that Harness’s current model is used.

- [ ] **Step 1: Add the end-to-end argv regression assertion**

Assert that a web invocation resolves to `web` and the spawned literature CLI receives `--profile web`; assert that no provider/model/key literal is injected by the plugin.

- [ ] **Step 2: Run the complete verification suite**

Run:

```sh
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all tests pass, typecheck and build exit 0, and `git diff --check` emits no output.

- [ ] **Step 3: Inspect the latest runner log**

Start one workflow from the web profile and confirm the runner log begins with `running profile web` (or the user’s selected profile), not an implicit `headless`. Confirm the workflow’s persisted model provenance matches the Harness selection without exposing credentials.

- [ ] **Step 4: Commit the verified integration**

Run: `git add src/ui/adapter.ts src/ui/routes.ts src/ui/types.ts src/index.ts src/client/api.ts src/client/wire.ts src/client/SearchKeywords.tsx src/client/locales.ts src/client/styles.ts tests/ui_adapter.test.ts tests/ui_routes.test.ts tests/client_api.test.ts tests/client_components.test.tsx && git commit -m "feat: use Harness model selection for literature workflow"`

If the workspace Git index remains read-only, do not retry destructively; report the exact limitation and leave all verified changes in the working tree.
