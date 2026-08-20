# Current-Profile Workflow Runner Design

## Goal

Run a literature workflow through the currently running Harness profile, so the
model selected in the Harness UI supplies the adapter, provider, model and
credentials used by the workflow.

## Problem

The Web UI currently starts `bin/dsh-literature-push.mjs`. When the host
profile is `web`, `currentHarnessProfile()` intentionally omits that profile
and the CLI falls back to `headless`. The headless profile explicitly isolates
its settings and therefore selects `deepseek-official/deepseek-v4-flash`, not
the model selected in the Web UI. This makes the UI model selector misleading
and can produce an unrelated DeepSeek authentication failure.

## Design

The Web route launches an Agent through the active Cordis `agents` service
instead of spawning the headless CLI. It reads the active profile's
`agentDefaultModel.currentSelection()` once, creates the Agent with that exact
provider and model, sends the existing literature push/resume prompt, and
waits for the Agent to become idle in a detached task.

The existing prompt builders, SQLite workflow records, UI status refresh,
structured error classifier, and double-launch guard remain the workflow
contract. The UI does not accept provider, model, credential, or profile
values for execution. It only changes Harness's existing model selection via
`agentDefaultModel.saveSelection()`.

## Error Handling

Agent creation and completion errors are classified with the existing
provider-neutral taxonomy. `AUTH`, `NO_ADAPTER`, and `INVALID_MODEL` stop
without fallback. Rate-limit and network behavior remains owned by the
existing structured error policy. No provider is installed, selected, or
credentialed by dsh-literature.

## Scope

- Replace only UI-initiated push/resume launch with an in-process active-profile
  Agent runner.
- Keep `bin/dsh-literature-push.mjs` unchanged for cron and explicit CLI use;
  it remains a headless/dedicated-profile entry point.
- Display the active runner's provider/model in structured runner status where
  available.
- Add regression tests proving a Web launch does not resolve to `headless` and
  uses the selection supplied by the current Harness profile.
