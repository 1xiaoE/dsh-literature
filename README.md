# dsh-literature

An AI-assisted literature reading and recommendation workflow built around DeepSeek Harness, with staged curriculum learning, multi-source retrieval, verified full-text reading, knowledge-gap-aware ranking, and structured research notes.

This repository is a **pure plugin / workflow source repository**: it contains no personal reading library, no runtime data, and no credentials. All runtime data lives locally under `~/.local/share/dsh-literature/` (see [Runtime Data](#runtime-data)).

## Features

- **Multi-source retrieval** — arXiv, OpenAlex, Crossref (metadata), Unpaywall (legal-OA locations)
- **RecentPool + LandmarkPool** — year-windowed recent candidates and year-unconstrained, eligibility-scored landmark candidates (curated seeds supported)
- **Deterministic pre-ranking** — recency / impact / topic similarity / full-text availability / stage relevance / knowledge-gap / priority-goal signals with configurable weights
- **Batch agent semantic ranking** — one-shot (at most two) LLM calls score the whole Top-15 candidate table; no per-paper LLM fan-out
- **Stage relevance** — keyword-guided stage fit hint + agent score, with a hard gate
- **Curriculum value** — agent-assessed learning value per stage, with a hard gate
- **Priority knowledge goal** — first uncovered goal of the stage drives retrieval weighting
- **requiredGoals stage gate** — a stage graduates only when required goals are actually covered (e.g. Fundamentals requires template_dynamics + balance_stability + impedance_compliance), never by paper count alone
- **Legal full-text verification** — PDFs validated by HTTP status, Content-Type, `%PDF-` magic, non-HTML login-page rejection, minimum size, and sha256
- **Chunked full-text reading** — pdftotext → bounded chunks → token-safe indexed reading, never a whole paper in context
- **Reading coverage provenance** — `total_chunks / read_chunks / read_coverage / coverage_basis` per completed push
- **SQLite provenance** — papers, candidates (full scoring trace), fetch log, fulltexts+chunks, retrievals (query provenance + auth mode), pushes (per-phase timings), stages, user actions
- **Human-in-the-loop** — resource/auth/permission problems park the push with a five-part user action record and resume from the original step (deterministic 0-LLM finalize when everything but the user action is done)
- **OpenAlex API key via environment variable** — optional but recommended (`OPENALEX_API_KEY`), never stored or logged
- **arXiv rate limiting** — serial scheduler (≥3.1s between requests), request-level dedup, 429 circuit breaker
- **Optional institutional full-text fallback (CARSI)** — note: institutional access ≠ open access; CARSI results are private-library only, never marked as OA
- **Headless execution** — OS cron / systemd friendly CLI, no GUI required

## Architecture

```
topic → search (Recent + Landmark pools) → dedupe → deterministic pre-rank (Top 15)
      → batch agent semantic ranking (Top 10) → quality gates (stage + curriculum)
      → full-text preflight → PDF (public/OA chain → optional CARSI) → verified download
      → chunked full-text index → bounded reads → structured report (plugin-owned canonical write)
      → literature_record (provenance + stage progression) → history
```

- **Model-agnostic by construction** — the plugin never calls an LLM itself; all intelligent steps (semantic ranking, full-text analysis, report writing) are executed by the harness-routed agent. No model ids are hardcoded.
- **Data/code separation** — code lives in this repo; runtime data lives in the XDG data dir.
- **Plugin boundary** — installs as a DeepSeek Harness plugin (`dsh plugin --profile <name> add link:<repo>`); the DeepSeek Harness core is never modified.

## Requirements

- Node.js >= 22.19
- pnpm
- `pdftotext` (poppler-utils) on PATH
- A DeepSeek Harness checkout (external; not bundled here)
- Optional: `playwright` + Chromium for the CARSI institutional fallback

## Installation

```sh
git clone https://github.com/1xiaoE/dsh-literature.git
cd dsh-literature
pnpm install
```

Install into a DeepSeek Harness profile (web and/or headless):

```sh
dsh plugin --profile web add link:/path/to/dsh-literature
dsh plugin --profile headless add link:/path/to/dsh-literature
```

## Configuration

Configuration is provided via the plugin row config (cordis patch). See `cordis.patch.yml` and `DESIGN.md` for the full schema: topics, reading stages (scope/keywords/knowledge goals/required goals/landmark seeds), ranking weights, retrieval pools, thresholds, full-text parser, HTTP timeouts, and the optional `carsi` block.

### OpenAlex API key (optional but recommended)

```sh
export OPENALEX_API_KEY='YOUR_KEY'
```

`OPENALEX_API_KEY` is optional but recommended — without it OpenAlex runs in anonymous mode (`openalex_auth_mode=anonymous`). The key is read from the environment only; it is never written to source, logs, SQLite, or Git. Check your quota with:

```sh
node bin/dsh-literature-openalex-status.mjs
```

A `.env.example` is provided as a template; never commit a real `.env`.

## Usage

One complete push (recommended paper selection + full-text reading + report):

```sh
node bin/dsh-literature-push.mjs --topic "足式机器人控制"
```

Resume a parked or interrupted push from its original step (0-LLM deterministic finalize when possible):

```sh
node bin/dsh-literature-push.mjs --resume <pushId>
```

Human-in-the-loop actions:

```sh
node bin/dsh-literature-actions.mjs list            # pending user actions (five-part record)
node bin/dsh-literature-actions.mjs resolve <id>    # mark one resolved
```

CARSI institutional login (optional fallback; first-time setup):

```sh
node bin/dsh-literature-carsi-login.mjs
```

## Curriculum

Reading proceeds through configurable stages, each with:

- scope, preferred/downweight/exclude keywords
- knowledge goals (coverage-gated stage progression)
- `requiredGoals` — goals that MUST be covered before the stage graduates
- curated landmark seeds as retrieval anchors
- per-stage curriculum weight

When `papers_in_stage >= target - 1` and a required goal is still uncovered, the stage enters **required-goal completion mode**: the priority goal is pinned to the pending required goal, and only a paper whose full text genuinely covers it (agent judgment, not keyword hits) can graduate the stage.

## Retrieval Sources

| Source | Role |
|---|---|
| arXiv | preprint candidates + open PDFs (serial scheduler, dedup, 429 breaker) |
| OpenAlex | metadata, citations, venue, OA locations, relevance scores (API key via env) |
| Crossref | DOI metadata completion + publisher links |
| Unpaywall | legal-OA locations for DOI-carrying papers |
| CARSI (optional) | institutional full-text fallback — **institutional access ≠ open access**, private library only |

## Full-text Handling

- PDF acquisition order: arXiv / OA location → Unpaywall → publisher links → (optional) CARSI → `FULLTEXT_UNAVAILABLE`
- Every download is verified (HTTP / Content-Type / `%PDF-` magic / non-HTML / size / sha256)
- Full text is extracted with pdftotext, split into bounded chunks, and read back chunk-by-chunk (token-safe)
- Reading coverage (`total_chunks / read_chunks / read_coverage / coverage_basis`) is recorded per push; a report must never claim "read everything" when `read_coverage < 1`

## Human-in-the-loop

When the workflow hits a resource / auth / permission / download-channel / research-choice problem that the user can solve more easily than the automation, it:

1. parks the push in `user_action_required` with a five-part record (where stuck / what's missing / what was tried / what to do / how to continue),
2. never misreports `AUTH_REQUIRED` / `USER_RESOURCE_NEEDED` as `FULLTEXT_UNAVAILABLE`,
3. resumes from the original step after the user is done — reusing persisted candidates, scores, selection trail and fetch log; a deterministic finalize path completes pushes with `resume_llm_call_count = 0` when nothing else is pending.

## Runtime Data

All runtime state stays local (never committed):

```
~/.local/share/dsh-literature/
├── literature.db          # SQLite (papers, candidates, fetch log, fulltexts, pushes, stages, user actions)
├── pdfs/<sha256>.pdf      # downloaded PDFs, content-hashed
├── cache/                 # adapter caches
├── reports/               # canonical reading reports
└── browser-profile/       # CARSI persistent browser profile (never your daily browser)
```

## Development

```sh
pnpm typecheck
pnpm build       # tsc → lib/
pnpm test        # vitest
```

## Tests

The suite covers: PDF fallback chains, fulltext chunking, ranking/pre-ranking, stage gates, graduation rules (requiredGoals), priority-goal matching, HITL lifecycle + resume, report writer + deterministic finalize, OpenAlex auth isolation (host-env safe), arXiv scheduler/dedup/429, SQLite migrations (fresh init to current version), and a strict lossless-JSON boundary for every tool output.

## Current Status

- **V0.1** — stable feature set as described above; the project is a workflow/plugin source repository, not a standalone application.

## Roadmap

- Zotero integration
- More retrieval sources
- GUI scheduling inside the Harness web shell
- PDF vision understanding

## License

License not specified yet.
