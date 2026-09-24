# News ingestion release assignment and validation

**Release branch:** `release/news-ingestion-20260924`  
**Release PR target:** `develop`  
**Feature PR target:** `release/news-ingestion-20260924`  
**Baseline:** `main` at `3db1c8d`; `develop` sync PR #647 brings its prior 127-commit lag up to date.

| Task | Status | Branch | Worktree | Runtime entrypoint | Persistence | Path | Required proof | Owning document section |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Durable screening | **Implemented and proven (focused)** | `feat/news-ingestion-jobs` | `/tmp/thufir-worktrees/news-release/jobs/feat-news-ingestion-jobs` | Screening worker | `news_screen_jobs`, call admission log, worker state | Write/read | Seven temporary-SQLite lifecycle/retry/lease/outbox/cap tests; `tsc --noEmit` | TDD §2, §4, red-first contracts 8-9 |
| Local inference priority | **Implemented and proven** | `feat/news-ingestion-priority` | `/tmp/thufir-worktrees/news-release/priority/feat-news-ingestion-priority` | Trivial local client | None | Runtime queue | Local/global queue ordering, single-flight, queue wait, and abort | TDD §2, red-first contract 15 |
| Monitor and routing | **Implemented and proven (focused)** | `feat/news-ingestion-routing` | `/tmp/thufir-worktrees/news-release/routing/feat-news-ingestion-routing` | Telegram monitor, gateway scheduled/event paths | Dispatch keys and outcomes | Write/read | Monitor-to-worker-to-gateway SQLite integration; burst, shadow, cap, restart, briefing and originator wiring tests | TDD §1, §3-4, red-first contracts 1-7, 10-13 |
| Contract and release evidence | Code release gate passed; live shadow pending | `docs/news-ingestion-release-gates` | `/tmp/thufir-worktrees/news-release/docs/docs-news-ingestion-contract` | Release gate | Evidence only | Promotion gate | Exact code SHA full coverage/build passed; live burst, latency and production proof pending | TDD acceptance and this release doc |

## Merge order

1. Contract documentation.
2. Local inference priority and durable screening foundation.
3. Monitor and gateway routing after foundation interfaces are integrated.
4. Release branch test and lifecycle gates; `release → develop → main → production`.

## Release contract

- Every distinct non-seed Telegram post receives a durable screen job independent of keywords.
- Screening failure remains visible and cannot be recorded as `NO`.
- Screening does not initiate a scan before an urgent relevant verdict and tradable-market mapping.
- Routine posts enter one bounded scheduled assessment, without per-post full-agent calls.
- Local background news work cannot hold the global LLM permit while waiting for the local model, and normal work overtakes waiting news.
- Scan/briefing dispatch persists idempotent keys and respects existing trade gates.
- Production mode remains paper; the previously approved production-only `minEdge=0.02` is independent of this release.

## Status

Local inference admission is **implemented and proven** by focused TDD contract 15 tests. Durable screening persistence is **implemented and proven** by eight focused temporary-SQLite lifecycle and prompt-bound tests. Monitor-to-gateway routing is **implemented and proven (focused)** by the real monitor → durable worker → router temporary-SQLite test, the 11-post deferred-inference burst, routine originator wiring, cap and restart tests. On code release SHA `730ad871449d5b7de28d33e00e1c5b38955e458d`, the production build and full V8 coverage run passed: 229 test files, 1,225 tests, 72.83% overall lines, 67.65% branches. The live full-shadow capacity and normal-task latency gates, promotion-SHA checks, and production restart/replay remain pending. Active rollout requires the TDD's shadow latency gates and production-like restart/replay proof.

The shadow rollout deliberately retains only **safe legacy keyword routing**: keyword posts are always screened even when sampled shadow would omit them, and may reach a scan or briefing only after relevance/urgency, dynamic tradable-market mapping, existing cooldown and hourly cap. Other shadow classifications are observational. This replaces the old unconditional keyword scan-before-screen behavior rather than preserving it verbatim.

## Post-deployment shadow snapshot

On 2026-09-24 after main deployment, production ran `sampled_shadow` with an explicit `newsScreenSampleRate: 1.0` override to exercise every new post. The first 22 screened posts had no failed jobs; maximum recorded queue age was 25.7 seconds through a 12-post two-minute burst. One relevant legacy keyword post requested a bounded autonomous scan, and the normal trade entry gate rejected its candidate. Six short normal-task probes measured a warm p50 of about 0.43 seconds; one call rose to 0.84 seconds during the burst. This limited sample does **not** establish the TDD's 25% p95 latency or 127-post peak-hour gate, so active routing remains disabled. Paper mode, `fullAuto: true`, and the separately approved `minEdge: 0.02` remained in place.
