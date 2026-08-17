# dsh-literature

> **English** | [中文](README.zh.md)

An AI-assisted literature reading and recommendation workflow built around DeepSeek Harness — staged curriculum learning, multi-source retrieval, verified full-text reading, knowledge-gap-aware ranking, and structured research notes.

This is a **pure plugin / workflow source repository**: no personal reading library, no runtime data, no credentials. All runtime state lives locally under `~/.local/share/dsh-literature/` (see [Runtime Data](#runtime-data)).

## Features

- **Multi-source retrieval** — arXiv, OpenAlex, Crossref, Unpaywall; RecentPool + LandmarkPool with curated seeds
- **Two-stage ranking** — deterministic pre-ranking (Top 15) → one-shot batch agent semantic ranking, with stage-relevance and curriculum-value gates
- **Knowledge-gap guidance** — priority knowledge goal weighting; `requiredGoals` stage gate (a stage never graduates by paper count alone)
- **Quality First, Access Second** — papers are ranked on academic merit; fulltext acquisition happens rank-by-rank afterwards and never overrides quality (OA availability does not raise academic quality)
- **Exploration-first recommendation** — already-read papers are excluded from the shortlist and attempted-but-failed ones are decayed (×0.35), so each push surfaces fresh material instead of re-recommending the same "hard" papers forever
- **Direct Publisher Access** — generic `publisher_browser` provider: DOI direct resolution → publisher article page → PDF; login walls park the push as `AUTH_REQUIRED` (HITL), never a fake failure
- **Manual PDF cut-in (HITL)** — when the browser session cannot download a PDF automatically, the user downloads it by hand; the agent registers it via `manualPdfPath`, and the file is **moved (剪切) into the library** (`pdfs/<sha256>.pdf`) instead of copied — the `~/Downloads` copy is removed on success, leaving no duplicates
- **Per-domain rate limit** — attempts are throttled per publisher host (IEEE never blocks Springer); a manual login clears the gate so resume retries immediately
- **Verified full-text** — legal PDF fallback chain, %PDF- magic / size / sha256 validation, chunked token-safe reading, reading-coverage provenance (`total_chunks / read_chunks / read_coverage / coverage_basis`)
- **Full SQLite provenance** — papers, scoring traces, fetch log (access_type: `oa` / `institutional` / `manual`, `is_open_access`), retrievals, per-phase timings, stages, user actions
- **Human-in-the-loop** — five-part user-action records, resume from the original step, 0-LLM deterministic finalize
- **Headless-first** — cron-friendly CLI (institutional access ≠ open access; legacy CARSI off by default)

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

See `cordis.patch.yml` and `DESIGN.md` for the full schema (topics, stages, goals, ranking weights, thresholds, `publisherBrowser` block, legacy `carsi` block).

Key knobs:

| Key | Default | Meaning |
|---|---|---|
| `publisherBrowser.enabled` | `true` | master switch for the generic publisher-browser institutional access |
| `publisherBrowser.minIntervalMinutes` | `2` | per-publisher-domain rate limit (IEEE ≠ Springer); login clears it for immediate resume |
| `carsi.enabled` | `false` | LEGACY CARSI portal navigation — kept for history/tests only |
| `ranking.fulltextAvailability` | `0.03` | OA availability is only an acquisition-cost hint, never a quality signal |

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
node bin/dsh-literature-browser-login.mjs --url <article>   # login for a specific article page
node bin/dsh-literature-browser-login.mjs --check           # browser session status
```

> **手动 PDF 剪切入库**：登录墙/限流时，用户在浏览器里手动下载论文 PDF 到 `~/Downloads`，再把路径告诉 agent；agent 调用 `literature_fetch_pdf(pushId, paperId, manualPdfPath=<path>)` 校验后**剪切**进知识库（源文件不再残留）。详见 [Human-in-the-loop](#human-in-the-loop)。

### Full acquisition order (per ranked candidate)

```
Rank #1 → quality gate pass? → public/OA chain (arXiv / OpenAlex OA / Unpaywall / publisher public PDF)
  ├─ available → SELECTED
  └─ unavailable → publisher_browser (DOI direct → publisher article page → PDF)
       ├─ PDF_OK → SELECTED
       ├─ AUTH_REQUIRED (login wall) → HITL park, NEVER skip to a lower-quality OA Rank #2
       │    └─ user logs in (browser-login) OR downloads the PDF by hand
       │         → literature_fetch_pdf(manualPdfPath) MOVES it into the library (剪切) → SELECTED
       ├─ ACCESS_DENIED (403 / not entitled) → next ranked candidate
       └─ PDF_NOT_FOUND → next ranked candidate
Then Rank #2, #3, ... — once SELECTED, all further acquisition stops (≤ 1 per push)
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
| publisher_browser (default) | institutional access via direct publisher browser — **Quality First, Access Second**, **≠ open access**, private library only |
| CARSI (legacy, off by default) | kept for history/tests; re-enable deliberately via `carsi.enabled` |

## Full-text Handling

**Quality First, Access Second**: papers are batch-scored first and `literature_rank_candidates` freezes a unique `agent_rank`; a hard acquisition state machine then completes the full chain for one rank before any lower rank can start. Per candidate: public/OA preflight → public download chain → publisher_browser (DOI resolution → article page → PDF). `AUTH_REQUIRED` and `RATE_LIMITED` stay on the same rank; only explicit paper-level terminal outcomes (`ACCESS_DENIED / PDF_NOT_FOUND / FULLTEXT_UNAVAILABLE / PDF_FAILED`) allow advancing. A login wall parks the push as `AUTH_REQUIRED` (HITL: `bin/dsh-literature-browser-login`), not a fake failure. Every download is validated (HTTP / Content-Type / %PDF- magic / non-HTML / size / sha256); text is chunked and read token-safely; `total_chunks / read_chunks / read_coverage / coverage_basis` are recorded per push.

## Human-in-the-loop

Resource/auth/permission problems park the push with a five-part record (where / what's missing / what was tried / what to do / how to continue), never misreport `AUTH_REQUIRED` as `FULLTEXT_UNAVAILABLE`, and resume from the original step — reusing persisted candidates, scores, and fetch log.

Login flow:

```sh
# 1. the push parks with AUTH_REQUIRED (kind=publisher_login)
node bin/dsh-literature-actions.mjs list          # see the five-part record
# 2. open the article in a headed browser with the SAME persistent profile
node bin/dsh-literature-browser-login.mjs --push <pushId>
#    (complete a legal login yourself — the tool never fills credentials)
# 3. resume from the exact step, no re-retrieval / re-ranking
node bin/dsh-literature-push.mjs --resume <pushId>
```

The login clears all rate-limit timestamps, so the same paper can be retried immediately. If the login succeeds but the institution is not entitled, the provider reports `ACCESS_DENIED` and the pipeline moves to the next ranked candidate.

Manual download flow (preferred when the automated browser still can't fetch the PDF):

```sh
# 1. while the push is parked (AUTH_REQUIRED / RATE_LIMITED / etc.), download
#    the article PDF yourself in the headed browser → save to ~/Downloads
# 2. hand the file path to the agent (e.g. "已下载到 ~/Downloads/xxx.pdf"),
#    it calls literature_fetch_pdf(pushId, paperId, manualPdfPath=<path>)
# 3. the PDF is validated (%PDF- / size / sha256) and MOVED (剪切) into the
#    library as pdfs/<sha256>.pdf — the ~/Downloads copy is removed, so the
#    original is never left behind as a duplicate
# 4. resume proceeds to full-text indexing + reading + report as usual
```

The manual PDF is recorded with `access_type=manual`, `is_open_access=0` (a private, non-OA acquisition), and its provenance (original path, sha256, moved flag) stays in `fetch_log`.

## Runtime Data

```
~/.local/share/dsh-literature/
├── literature.db      # SQLite provenance
├── pdfs/<sha256>.pdf  # content-hashed downloads
├── cache/             # adapter caches
├── reports/           # canonical reading reports
├── browser-profile/   # dedicated publisher browser (never your daily browser)
├── publisher_browser/ # per-domain rate-limit ledger
└── carsi/             # legacy CARSI ledger (disabled by default)
```

## Development

```sh
pnpm typecheck
pnpm build       # tsc → lib/
pnpm test        # vitest
```

## Tests

PDF fallback chains, per-domain rate limiting, publisher-browser login-wall classification (AUTH_REQUIRED / ACCESS_DENIED / PDF_NOT_FOUND), %PDF- / size / sha256 validation, manual PDF cut-in (source file moved into the library), institutional/manual provenance (`is_open_access=false`), chunking, ranking (OA decoupled from quality), stage/graduation gates, priority-goal matching, HITL + resume (no re-retrieval/re-ranking), report writer + deterministic finalize, OpenAlex auth isolation, arXiv scheduler/dedup/429, migrations (fresh init + v13→v14 manual provenance), lossless-JSON output boundary.

## Current Status

**V0.1** — stable; a workflow/plugin source repository, not a standalone application. Smoke-tested end-to-end on real non-OA papers (IEEE T-RO via manual/institutional login; publisher login-wall HITL flow verified).

## Roadmap

Zotero integration · more sources · GUI scheduling · PDF vision understanding.

## License

License not specified yet.
