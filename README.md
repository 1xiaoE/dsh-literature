# dsh-literature

> **English** | [中文](README.zh.md)

An AI-assisted literature reading and recommendation workflow built around DeepSeek Harness — staged curriculum learning, multi-source retrieval, verified full-text reading, knowledge-gap-aware ranking, and structured research notes.

This is a **pure plugin / workflow source repository**: no personal reading library, no runtime data, no credentials. All runtime state lives locally under `~/.local/share/dsh-literature/` (see [Runtime Data](#runtime-data)).

## Features

- **Staged curriculum & knowledge-gap ranking** — multi-source retrieval (arXiv, OpenAlex, Crossref, Unpaywall) with Recent + Landmark pools; deterministic pre-rank (Top 15) → one-shot batch agent ranking, gated by stage-relevance and curriculum-value
- **Quality First, Access Second** — papers are ranked on academic merit; full text is acquired rank-by-rank afterwards (public/OA → publisher browser), so a login wall parks the push as `AUTH_REQUIRED` (HITL) instead of ever faking a failure
- **Verified full-text reading** — legal PDF fallback chain with %PDF- / size / sha256 validation, chunked token-safe reading, and reading-coverage provenance (`total_chunks / read_chunks / read_coverage / coverage_basis`)
- **Human-in-the-loop** — five-part action records, resume from the original step, 0-LLM deterministic finalize when possible
- **Harness UI** — a **Literature** sidebar entry opens the Literature Workflow page (Execution / Search Keywords / Categories / Papers / Paper Details); a pure presentation layer over the existing SQLite
- **Retrieved pool vs Library** — "retrieved" (检索到过) is explicitly NOT "in the library": every paper ever surfaced by retrieval/candidate generation lives in the **Retrieved** pool (candidate/search-history), while the **Library** is only papers the user owns — Selected by the workflow, manual PDF imports, or papers with real content (PDF / read / report / favorite / manual category)
- **Library-scoped Research Fields** — Research Fields & Topics count and filter only library papers; retrieved-only candidates never pollute classification; auto category resolution triggers on SELECTED / manual import, not on mere retrieval
- **Safe retrieved removal** — the Retrieved page supports single & batch removal of retrieval history; library papers are protected (their Selected / PDF / read / report / categories / favorite state is never touched), and only genuinely orphaned retrieved-only metadata can be cleaned up
- **Favorites** — a first-class library signal (`papers.is_favorite`), linked to paper categories; favorites appear in the workflow count, protect papers from orphan cleanup, and toggle from the paper detail panel
- **Library organization** — research-field categories, local PDF import, and pushless deep-read, all with full SQLite provenance

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
pnpm install      # `prepare` runs pnpm build automatically; skip with DSH_LIT_SKIP_PREPARE=1
pnpm build        # explicit build (tsc → lib/ + client bundle) — required before linking
dsh plugin --profile web add link:/path/to/dsh-literature
```

`lib/` is git-ignored (source-only repository), so a fresh clone must build
before the plugin can be loaded. `prepare`/`prepack` build on install/pack for
consumers; `pnpm build` is always safe to run again.

## Configuration

Full schema (topics, stages, goals, ranking weights, thresholds, `publisherBrowser` block, legacy `carsi` block) lives in `cordis.patch.yml` and `DESIGN.md`.

| Key | Default | Meaning |
|---|---|---|
| `publisherBrowser.enabled` | `true` | master switch for the generic publisher-browser institutional access |
| `publisherBrowser.minIntervalMinutes` | `2` | per-publisher-domain rate limit (IEEE ≠ Springer); login clears it for immediate resume |
| `carsi.enabled` | `false` | LEGACY CARSI portal navigation — kept for history/tests only |
| `ranking.fulltextAvailability` | `0.03` | OA availability is only an acquisition-cost hint, never a quality signal |
| `fulltext.minReadCoverage` | `1.0` | minimum full-text coverage before `completed`; default requires all indexed chunks to be read |
| `retrieval.maxQueriesPerPool` | `8` | balanced query cap per pool for normal retrieval adapters |
| `retrieval.arxivMaxQueriesPerPool` | `4` | stricter per-pool query cap for the rate-limited arXiv API |
| `retrieval.sourceConcurrency` | `4` | bounded concurrency for non-arXiv retrieval adapters |

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

> **Manual PDF cut-in**: when a login wall or rate limit blocks the automated browser, download the article PDF yourself to `~/Downloads` and hand the path to the agent — `literature_fetch_pdf(pushId, paperId, manualPdfPath=<path>)` validates it and **moves (剪切) it into the library** (`pdfs/<sha256>.pdf`), removing the source copy. See [Human-in-the-loop](#human-in-the-loop).

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

## Library Organization

Independent of workflow topics: `categories` / `paper_categories` organize the library by research field (deterministic, local classification), while `pushes` / `stages` keep their own curriculum semantics.

- **Research fields** — papers can be tagged with fields (auto or manual); counts and management are exposed in the Harness UI's Categories panel
- **Local PDF import** — drop a PDF into the library (binary upload via `/api/dsh-literature/import-pdf`); metadata is completed through the existing source adapters (`lookupMetadata`, DOI-preferred) without creating a push
- **Deep read** — re-read an already-library-owned PDF pushlessly (`/papers/:id/deep-read`), reusing the full-text index / chunk reads / report storage
- **Reports table** — every workflow or deep-read report is recorded (`reports`), and reading jobs track `paper_reading_jobs` status

## Library vs Retrieved Pool

"检索到过" ≠ "进入知识库"。

```
               RETRIEVED POOL (候选/历史池)
                      │
        ┌─────────────┴─────────────┐
        │                           │
   未选择候选                    SELECTED
        │                           │
        │                           ▼
        │                        LIBRARY ──► Auto Category ──► Research Fields
        │
        └── 可以清理（孤立检索论文）
```

- **Retrieved**（`已检索`, UI 左侧第一个分类）：历史检索 / 候选生成中发现过的论文——`papers` 行 + `retrievals` / `candidates` 历史。它本质是候选池 / 搜索历史，不是正式知识库。
- **Library**（正式知识库）：`isLibraryPaper` 为真的论文——**Selected**（`candidates.selection_outcome='SELECTED'`）、**手动导入 PDF**（`fetch_log.access_type IN ('manual','manual_upload')`）、有可用 PDF / fulltext / read / report、**收藏**（`papers.is_favorite=1`）、或带 **manual category**。Read/report/favorite 行只可能因论文已入库而存在，因此作为旧数据兼容保护条件。
- **Research Fields / Topics 只统计 Library**：Retrieved-only 论文不参与自动分类、不进入研究领域与长期主题统计。`resolvePaperFields` 仅在论文进入知识库时（SELECTED / 手动导入）触发；对 Retrieved-only 论文会清理其历史 auto 分类。
- **安全删除检索记录**：`已检索` 页面支持单条 / 批量删除。删除只移除 `retrievals` 与（非 SELECTED 的）`candidates` 历史——Library 论文的 Selected / PDF / 精读 / 报告 / 分类 / 收藏全部保留；SELECTED 候选行是论文的入库凭证，被保留。只有真正孤立的 Retrieved-only 论文（`isPaperOrphaned`：无剩余引用、非 Library、无 open user action）才可清理其 `papers` 行。批量删除逐条执行保护检查，绝不 `DELETE FROM papers WHERE id IN (...)`，并返回 `removedRetrievedCount / protectedLibraryCount / orphanPaperDeletedCount / failedCount`。

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
├── literature.db      # SQLite provenance (papers, pushes, categories, reports, …)
├── pdfs/<sha256>.pdf  # content-hashed downloads
├── cache/             # adapter caches
├── reports/           # canonical reading reports
├── browser-profile/   # dedicated publisher browser (never your daily browser)
├── publisher_browser/ # per-domain rate-limit ledger
└── carsi/             # legacy CARSI ledger (disabled by default)
```

## Harness UI (Literature Workflow)

A **Literature** entry in the left sidebar opens the **Literature Workflow** page: **Execution** (real push state, including the `AUTH_REQUIRED` card with Open Publisher / Resume), **Search Keywords** (Run / Resume invoke the existing CLI runner), **Categories** (workflow + research fields + workflow topics), **Papers** (real SQLite records with agentRank / score / SELECTED / PDF / READ / REPORT flags), and **Paper Details** (real fields mapped from the schema; missing ones render `-`). The UI is a pure presentation layer: every payload comes from `/api/dsh-literature/*` routes served by this plugin's own node half, which reads the **existing** SQLite. No second database, no re-implemented retrieval/ranking/acquisition, no duplicated workflow.

- `src/ui/` — node-half adapter + HTTP routes (dashboard, push status, papers, PDF/report streaming, local PDF import, research-field management, deep-read, run/resume)
- `src/client/` — browser half: sidebar entry + workbench React tree (view-model driven panels)
- When the route family is unreachable, development builds may use clearly marked **Demo** payloads; production shows **Backend unavailable** with **Retry** and never silently substitutes mock data.

To open it in the GUI: restart `dsh web` (the client bundle is discovered at boot), then click the book-shaped **Literature** entry in the sidebar.

## Development

```sh
pnpm typecheck   # node half + client half (tsconfig.json + tsconfig.client.json)
pnpm build       # tsc → lib/ then tsdown → lib/client.js (Harness UI bundle)
pnpm test        # vitest
pnpm watch       # tsdown --watch (client bundle HMR)
```

## Tests

PDF fallback chains, per-domain rate limiting, publisher-browser login-wall classification (AUTH_REQUIRED / ACCESS_DENIED / PDF_NOT_FOUND), %PDF- / size / sha256 validation, manual PDF cut-in (source file moved into the library), institutional/manual provenance (`is_open_access=false`), chunking, ranking (OA decoupled from quality), stage/graduation gates, priority-goal matching, HITL + resume (no re-retrieval/re-ranking), report writer + deterministic finalize, OpenAlex auth isolation, arXiv scheduler/dedup/429, migrations (fresh init + v13→v14 manual provenance, v15 acquisition state, v17 library organization), UI adapter / routes / client view-model + components, and the lossless-JSON output boundary.

## Current Status

**V0.1** — stable; a workflow/plugin source repository, not a standalone application. Smoke-tested end-to-end on real non-OA papers (IEEE T-RO via manual/institutional login; publisher login-wall HITL flow verified). Harness UI and library-organization layer (schema v17) shipped.

## Roadmap

Zotero integration · more sources · GUI scheduling · PDF vision understanding.

## License

License not specified yet.
