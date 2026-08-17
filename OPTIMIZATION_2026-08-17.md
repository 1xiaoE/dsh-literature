# dsh-literature optimization closeout — 2026-08-17

## Scope

This pass turns **Quality First, Access Second** from an agent convention into a hard, persisted acquisition state machine and reduces retrieval latency without relaxing source rate limits.

## Correctness changes

- Added `literature_rank_candidates`: batch semantic scores are persisted before any PDF operation and a stable unique `agent_rank` is assigned.
- Added candidate acquisition state: `public_preflight_status`, `acquisition_outcome`, `acquisition_reason`.
- `literature_pdf_preflight` / `literature_fetch_pdf` now reject lower-ranked papers while a higher quality-passed rank is unresolved.
- `AUTH_REQUIRED` and `RATE_LIMITED` park on the same rank. Only paper-level terminal outcomes (`ACCESS_DENIED`, `PDF_NOT_FOUND`, `FULLTEXT_UNAVAILABLE`, `PDF_FAILED`) advance the queue.
- `SELECTED` is a hard stop (`selected_count <= 1`).
- Publisher-browser rate-limit blocks return `RATE_LIMITED` and no longer refresh the last-attempt timestamp, preventing sliding lockout.
- Added shared `finalizeCompletedPush` for both `literature_record` and deterministic resume. Completion now atomically handles picked state, knowledge coverage, stage progress, and push completion.
- `completed` requires: quality gates passed, selected acquisition state, indexed full text, `readCoverage >= fulltext.minReadCoverage`, and a non-empty canonical report.
- Default `fulltext.minReadCoverage = 1.0` (all indexed chunks read).
- New pushes snapshot normalized config into `pushes.policy_json`; CLI `--resume` can use the exact policy that created the push. Old pushes without a snapshot safely fall back to agent resume.
- Performance flush ignores undefined overrides so earlier `agentRankingMs` / `llmCallCount` values cannot be erased.

## Retrieval latency changes

New defaults:

- `retrieval.maxQueriesPerPool = 8`
- `retrieval.arxivMaxQueriesPerPool = 4`
- `retrieval.sourceConcurrency = 4`

Query budgets are balanced across canonical/stage/secondary intent. Landmark selection preserves curated seed-title anchors. Non-arXiv sources use bounded concurrency; arXiv remains serial with the existing >=3.1 s request spacing.

For the Fundamentals planner that previously generated about 12 recent + 12 landmark queries, the worst-case arXiv request count is reduced from 24 to 8. With no 429s, scheduler-only spacing falls from roughly 71 s to roughly 22 s.

## Database

Schema version: **15**. Existing v14 databases migrate automatically when opened.

## Validation

- TypeScript typecheck: PASS
- Build (`tsc -p tsconfig.json`): PASS
- Full Vitest regression suite: PASS
- New regressions cover rank-leapfrog prevention, non-sliding publisher rate limits, retrieval query budgets/concurrency, full-read completion gating, shared finalize behavior, and policy-snapshot 0-LLM resume.
