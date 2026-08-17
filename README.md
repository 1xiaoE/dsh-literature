# dsh-literature

> **English** | [中文](README.zh.md)

An AI-assisted literature reading and recommendation workflow built around DeepSeek Harness — staged curriculum learning, multi-source retrieval, verified full-text reading, knowledge-gap-aware ranking, and structured research notes.

This is a **pure plugin / workflow source repository**: no personal reading library, no runtime data, no credentials. All runtime state lives locally under `~/.local/share/dsh-literature/` (see [Runtime Data](#runtime-data)).

## Features

- **Multi-source retrieval** — arXiv, OpenAlex, Crossref, Unpaywall; RecentPool + LandmarkPool with curated seeds
- **Two-stage ranking** — deterministic pre-ranking (Top 15) → one-shot batch agent semantic ranking, with stage-relevance and curriculum-value gates
- **Knowledge-gap guidance** — priority knowledge goal weighting; `requiredGoals` stage gate (a stage never graduates by paper count alone)
- **Verified full-text** — legal PDF fallback chain, %PDF- magic / size / sha256 validation, chunked token-safe reading, reading-coverage provenance
- **Full SQLite provenance** — papers, scoring traces, fetch log, retrievals, per-phase timings, stages, user actions
- **Human-in-the-loop** — five-part user-action records, resume from the original step, 0-LLM deterministic finalize
- **Headless-first** — cron-friendly CLI; institutional access via a generic publisher browser (Quality First, Access Second; institutional access ≠ open access; legacy CARSI off by default)

## Architecture

```
topic → search (Recent + Landmark) → dedupe → pre-rank (Top 15)
      → batch agent ranking → quality gates → full-text preflight
      → verified PDF → chunked index → bounded reads → report (plugin-owned write)
      → literature_record (provenance + stage progression) → history
```

- **Model-agnostic**: the plugin never calls an LLM; intelligent steps are executed by the harness-routed agent.
- **Data/code separation**: code here, runtime data in the XDG dir.
- **Plugin boundary**: installs as a DeepSeek Harness plugin; the harness core is never modified.

## Requirements

- Node.js >= 22.19, pnpm, `pdftotext` (poppler-utils)
- A DeepSeek Harness checkout (external, not bundled)
- Optional: `playwright` + Chromium for the publisher-browser institutional access (and the legacy CARSI path)

## Installation

```sh
git clone https://github.com/1xiaoE/dsh-literature.git
cd dsh-literature
pnpm install
dsh plugin --profile web add link:/path/to/dsh-literature
```

## Configuration

See `cordis.patch.yml` and `DESIGN.md` for the full schema (topics, stages, goals, weights, thresholds, `carsi` block).

### OpenAlex API key (optional but recommended)

```sh
export OPENALEX_API_KEY='YOUR_KEY'
```

Read from the environment only — never stored in source, logs, SQLite, or Git. Check quota with `node bin/dsh-literature-openalex-status.mjs`. A `.env.example` template is included; never commit a real `.env`.

## Usage

```sh
node bin/dsh-literature-push.mjs --topic "足式机器人控制"   # one full push
node bin/dsh-literature-push.mjs --resume <pushId>          # resume (0-LLM when possible)
node bin/dsh-literature-actions.mjs list | resolve <id>     # human-in-the-loop actions
node bin/dsh-literature-browser-login.mjs --push <pushId>   # publisher login wall (HITL)
node bin/dsh-literature-browser-login.mjs --check           # browser session status
```

## Curriculum

Stages define scope, keywords, knowledge goals, `requiredGoals`, and curated landmark seeds. When papers reach the target but a required goal is uncovered, the stage enters completion mode: only a paper whose full text genuinely covers it can graduate the stage.

## Retrieval Sources

| Source | Role |
|---|---|
| arXiv | candidates + open PDFs (serial scheduler, dedup, 429 breaker) |
| OpenAlex | metadata / citations / OA locations (env API key) |
| Crossref | DOI metadata + publisher links |
| Unpaywall | legal-OA locations |
| Unpaywall | legal-OA locations |
| publisher_browser (default) | institutional access via direct publisher browser — **Quality First, Access Second**, **≠ open access**, private library only |
| CARSI (legacy, off by default) | kept for history/tests; re-enable deliberately via `carsi.enabled` |

## Full-text Handling

**Quality First, Access Second**: papers are ranked on academic merit (topic / stage / curriculum / venue / learning value / knowledge gap); fulltext acquisition happens rank-by-rank afterwards and never overrides quality. Order per candidate: arXiv/OA → Unpaywall → publisher links → publisher_browser (DOI direct resolution → publisher article page → PDF) → `FULLTEXT_UNAVAILABLE`. A login wall parks the push as `AUTH_REQUIRED` (HITL: `bin/dsh-literature-browser-login`), not a fake failure. Every download is validated (HTTP / Content-Type / %PDF- magic / non-HTML / size / sha256); text is chunked and read token-safely; `total_chunks / read_chunks / read_coverage / coverage_basis` are recorded per push.

## Human-in-the-loop

Resource/auth/permission problems park the push with a five-part record (where / what's missing / what was tried / what to do / how to continue), never misreport `AUTH_REQUIRED` as `FULLTEXT_UNAVAILABLE`, and resume from the original step — reusing persisted candidates, scores, and fetch log.

## Runtime Data

```
~/.local/share/dsh-literature/
├── literature.db      # SQLite provenance
├── pdfs/<sha256>.pdf  # content-hashed downloads
├── cache/             # adapter caches
├── reports/           # canonical reading reports
└── browser-profile/   # dedicated publisher browser (never your daily browser)
```

## Development

```sh
pnpm typecheck
pnpm build       # tsc → lib/
pnpm test        # vitest
```

## Tests

PDF fallback chains, chunking, ranking, stage/graduation gates, priority-goal matching, HITL + resume, report writer + deterministic finalize, OpenAlex auth isolation, arXiv scheduler/dedup/429, migrations (fresh init), lossless-JSON output boundary.

## Current Status

**V0.1** — stable; a workflow/plugin source repository, not a standalone application.

## Roadmap

Zotero integration · more sources · GUI scheduling · PDF vision understanding.

## License

License not specified yet.
