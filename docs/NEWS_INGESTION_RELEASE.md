# News ingestion release assignment and validation

**Release branch:** `release/news-ingestion-20260924`  
**Release PR target:** `develop`  
**Feature PR target:** `release/news-ingestion-20260924`  
**Baseline:** `main` at `3db1c8d`; `develop` sync PR #647 brings its prior 127-commit lag up to date.

| Task | Status | Branch | Worktree | Runtime entrypoint | Persistence | Path | Required proof | Owning document section |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Durable screening | **Implemented and proven (focused)** | `feat/news-ingestion-jobs` | `/tmp/thufir-worktrees/news-release/jobs/feat-news-ingestion-jobs` | Screening worker | `news_screen_jobs`, call admission log, worker state | Write/read | Seven temporary-SQLite lifecycle/retry/lease/outbox/cap tests; `tsc --noEmit` | TDD §2, §4, red-first contracts 8-9 |
| Local inference priority | **Implemented and proven** | `feat/news-ingestion-priority` | `/tmp/thufir-worktrees/news-release/priority/feat-news-ingestion-priority` | Trivial local client | None | Runtime queue | Local/global queue ordering, single-flight, queue wait, and abort | TDD §2, red-first contract 15 |
| Monitor and routing | In progress | `feat/news-ingestion-routing` | `/tmp/thufir-worktrees/news-release/routing/feat-news-ingestion-routing` | Telegram monitor, gateway scheduled/event paths | Dispatch keys and outcomes | Write/read | Monitor-to-worker-to-gateway SQLite integration; scan/briefing caps | TDD §1, §3-4, red-first contracts 1-7, 10-13 |
| Contract and release evidence | In progress | `docs/news-ingestion-contract` | `/tmp/thufir-worktrees/news-release/docs/docs-news-ingestion-contract` | Release gate | Evidence only | Promotion gate | Reconcile TDD to code; full tests, replay, latency and production proof | TDD acceptance and this release doc |

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

Local inference admission is **implemented and proven** by focused TDD contract 15 tests. Durable screening persistence is **implemented and proven** by the seven focused temporary-SQLite lifecycle tests and typecheck. Monitor-to-gateway wiring, full shadow capacity replay, and production restart/replay remain in progress. Active rollout requires the TDD's shadow latency gates and production-like restart/replay proof.
