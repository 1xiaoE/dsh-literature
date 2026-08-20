# Contributing

Thanks for your interest in dsh-literature! This document covers how to
contribute code, report issues, and keep the repository healthy.

## Development setup

```sh
pnpm install
pnpm build        # tsc → lib/ + client bundle (required before `link` or tests)
pnpm typecheck
pnpm test
```

The repository commits **source only** — `lib/` and other build artifacts are
git-ignored. Run `pnpm build` before installing the plugin into a profile:

```sh
dsh plugin --profile web add link:/path/to/dsh-literature
```

## Code layout

- `src/tools/` — agent-facing literature tools (retrieval → ranking → fetch →
  fulltext → report → record)
- `src/sources/` — retrieval adapters (arXiv / OpenAlex / Crossref / Unpaywall)
  and the registry that dedups and merges hits
- `src/lib/` — shared libraries (selection state machine, research fields,
  library/retrieved-pool separation, runner, deep-read, report writing)
- `src/presets/` — pluggable curriculum bundles (topic + stage definitions)
- `src/ui/` + `src/client/` — the Harness web UI (node-half routes + browser
  components)
- `src/migrations/` — one file per SQLite schema version
- `tests/` — vitest suites; every behavior change should carry a test

## Conventions

- **Model-agnostic**: plugin code never calls an LLM. Agent-facing "intelligence"
  lives in tool descriptions and prompts routed by the harness.
- **Provenance first**: any new write path records its source in SQLite
  (`metadata_source`, `fetch_log.access_type`, `paper_categories.source`, …).
- **Library vs Retrieved pool**: "retrieved" is a candidate/history pool;
  "library" means Selected / manual import / PDF / read / report / favorite /
  manual category. Never let retrieved-only candidates pollute Research Fields,
  and never delete library content when removing retrieval history.
- **Schema changes**: bump `SCHEMA_VERSION` in `src/db.ts`, add a new file in
  `src/migrations/`, and keep `schema.sql` in sync. `tests/schema_consistency.test.ts`
  asserts migrated schema == fresh schema.sql.
- **Tests**: `pnpm test` must stay green. Add a focused test alongside any
  behavior change.

## Pull requests

1. Fork and create a branch.
2. Make your change with tests.
3. Run `pnpm typecheck && pnpm build && pnpm test`.
4. Open a PR describing the problem, the change, and the evidence.

## Reporting issues

Include: the dsh version, plugin commit, reproduction steps, and (when
relevant) the SQLite state under `~/dsh-literature/Data/`.
