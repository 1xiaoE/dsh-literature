# Harness Model Selector Design

## Goal

Turn the Literature workbench's read-only current-model label into a selector
that uses the Harness-owned provider/model catalog and persists the choice
through `ctx.agentDefaultModel.saveSelection()`.

## Boundaries

- Harness remains the source of truth for providers, models, credentials, and
  the active profile.
- The plugin does not store provider/model settings or API keys.
- The selector writes only the Harness default model for the current profile.
- A running workflow is not changed; the next workflow observes the saved
  selection.
- The plugin never falls back to another provider after a failed save or run.

## Data flow

1. The node route reads `ctx.llm.listProviders()`, `ctx.llm.listModels()` and
   `ctx.agentDefaultModel.currentSelection()`.
2. The browser renders grouped provider/model options from that response.
3. A selection posts `{ provider, model }` to a guarded node route.
4. The node route validates that the requested provider/model exists in the
   Harness catalog, then calls `saveSelection` with the exact Harness-owned
   selection.
5. The route returns the refreshed current selection. The browser refreshes
   its catalog and displays the saved value.

## Error behavior

Invalid or unavailable selections return `INVALID_MODEL`; Harness save errors
are classified without switching provider/model. The existing structured run
error contract remains unchanged.

## UI behavior

The current model row becomes a native grouped `<select>` with provider and
model labels. It is disabled while loading or saving, shows a saving state,
and reports a save failure inline. The selector is hidden when the Harness
catalog service is unavailable.

## Verification

- Route tests cover catalog validation, successful `saveSelection`, and save
  failure responses.
- Component tests cover rendering options and issuing a selection change.
- Typecheck, build, and the full test suite must pass.
