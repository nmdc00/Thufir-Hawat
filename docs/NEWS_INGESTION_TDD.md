# News Ingestion and Relevance Routing TDD

**Status:** Implemented on release branch; active rollout pending shadow capacity and production validation
**Date:** 2026-09-24  
**Scope:** Telegram channel ingestion, local relevance screening, news briefings, and event-scan routing

## Problem and production evidence

`TelegramChannelMonitor` stores each distinct post, but calls the gateway only when the text contains a hardcoded breaking-news substring. The gateway then runs an autonomous scan **before** asking the local model whether the post is relevant. A `NO`, malformed response, or model error prevents the position briefing. This makes the keyword list an accidental admission gate for all news analysis.

On 2026-09-24, the production `@marketfeed` stream contained 816 stored posts in the preceding 24 hours, averaging 34/hour and peaking at 127/hour. Since the current service restart, 115 posts reached the relevance screen and none passed. The service and model were healthy: replay through the deployed Thufir client returned `YES` for a concrete diesel futures shock, while the conditional Iran warning and a broad market digest returned `NO`. Two concrete moves—Brent futures up 2.2% and spot gold down nearly 1%—were stored but never screened because they did not match a keyword. The model returned `YES` when the gold headline was screened directly.

The current scheduled trading scan runs every 15 minutes. The prior 24-hour window also included roughly 131 intel-triggered scans and 96 scheduled scans. Sending every post through the current callback would multiply expensive scans; screening must be separated from trading execution.

The observed peak burst was 11 posts in 60 seconds, 26 in five minutes, and 52 in 15 minutes. A ten-post replay through the deployed local client using a three-way JSON prompt averaged 6.5 seconds per post and labeled **all ten** `uncertain`. A separate nine-post replay with a short binary prompt averaged 2.6 seconds, returned parseable `YES`/`NO` for every post, and labeled seven relevant. These small, non-concurrent replays are capacity and prompt-design evidence, not a production latency guarantee or a classifier accuracy study. In particular, automatically escalating every `uncertain` or `YES` to a full agent would be overbearing.

At 816 posts/day, the binary replay mean implies roughly 35 minutes/day of first-pass local inference before urgency checks, contention, and retries. The local model is resident and local calls do not count against the configured hourly LLM budget. The previous `createTrivialTaskClient()` path held the shared global LLM queue while waiting for the separate single-flight local queue, allowing news backlog to delay other LLM work. The implemented `createBackgroundTrivialTaskClient()` now queues screening at low priority on the shared local queue without taking a global permit. Normal local trivial requests enter the local queue directly at normal priority; remote fallback stays on the global queue. This admission behavior is covered by the focused tests listed under contract 15; full-feed shadow latency and capacity still require the release gates below.

A FIFO single-worker simulation using actual post receipt times produced p95 queue waits of 5 seconds at 2.6 seconds/call, 18 seconds at 6.5 seconds/call, and 126 seconds at 20 seconds/call. The simulation excludes second-pass urgency calls and all concurrent Thufir work; it is a lower bound, not an acceptance result.

Relevant code: `src/intel/telegram_monitor.ts`, `src/gateway/index.ts`, `src/core/llm.ts`, and `src/intel/store.ts`.

## Goals

1. Give every new, distinct channel post a bounded chance to be classified without a static asset or keyword admission list.
2. Keep Telegram polling and push handlers responsive while local inference is slow or unavailable.
3. Preserve source, intel ID, receipt time, and screening outcome through briefings and optional event scans.
4. Limit full agent calls and event scans to relevant posts; retain the existing event-scan cooldown and autonomous risk gates.
5. Make failures, queue lag, false negatives, and downstream outcomes measurable.

## Non-goals

- Changing trade thresholds, order sizing, entry-gate standards, or execution mode.
- Turning every relevant headline into a trade proposal or Telegram message.
- Backfilling all historical intel automatically on deployment.
- Trusting a headline as a verified catalyst solely because the classifier marked it relevant.

## Proposed flow

```text
Telegram push/poll -> deduplicated intel_items row -> durable screening job
                                              -> single local relevance worker
                                              -> NO: record outcome
                                              -> YES: local urgency check
                                              -> routine: bounded digest for scheduled scan
                                              -> urgent + mapped market: capped event scan
                                              -> briefing only from bounded scan/assessment output
```

### 1. Enqueue every new post

Change `TelegramChannelMonitor.processMessage()` so every successfully stored, non-seed post creates a screening job and returns promptly. The existing `storeIntel()` deduplication remains the admission boundary. A push update and the subsequent poll must create one job for the same post. Seeding on startup records recent posts but does not dispatch them; pending jobs created before a restart still resume.

The callback should carry the stored intel ID and source rather than only text. The keyword match may be recorded for diagnostics, but it must not determine whether screening runs.

### 2. Durable, bounded local screening

Add a `news_screen_jobs` table keyed by `intel_id` with `status`, `attempts`, `next_attempt_at`, `lease_until`, `verdict`, `reason`, `model`, `latency_ms`, `queue_wait_ms`, `queue_age_ms`, `created_at`, and `completed_at`. The worker claims one job at a time and uses the injected trivial local client with an explicit lightweight execution context. It reads content from `intel_items`, so the headline is not duplicated in the job table. Persist only activation provenance in the job row; rebuild `NewsActivation.text` from the joined intel content/title for callbacks and restart replay. Live item storage and enqueue are atomic; sampled-out items can be stored with an explicit `unsampled` outcome.

Keep first-pass output short. The small local model performed poorly with a three-way JSON prompt in the production replay. The first pass returns exactly `YES` or `NO`; a noncompliant or empty response is an error, never a `NO`. Only `YES` items get a second short local urgency check:

```ts
type NewsScreen =
  | { relevance: 'irrelevant'; urgency: 'none' }
  | { relevance: 'relevant'; urgency: 'routine' | 'urgent' };
```

The relevance prompt asks whether the post **could materially affect a tradable market or a held position over the current or next trading session**. It accepts realized moves and credible developing events without requiring a literal asset name. The urgency prompt distinguishes a fresh event that needs immediate review from routine relevant news. Neither model response authorizes an order. Validate both prompts against labeled real headlines in shadow mode before enabling routing.

Malformed output, timeout, health failure, budget suppression, and empty output remain retryable job failures. Use at most two bounded retries with backoff; pause claims while the local model is unhealthy. The worker persists a 30-second claim pause after non-malformed model/API failures, and the local client health guard suppresses inference while its health cooldown is active, so the worker does not need a separate concurrent health probe. After exhaustion, mark `failed` and surface an alert/metric. No failure is logged as a model `NO`. Persist terminal classifier state as `routing` before invoking the gateway callback, then replay the callback after a crash until it succeeds; callback failure has its own backoff and never consumes classifier retries. Retain the original post even when screening fails. Default worker call caps are configurable at 30/minute and 320/hour; validate final settings against shadow replay and normal-task latency.

Run one local screening request at a time so the worker respects the existing single-flight Ollama client. The queue is asynchronous to Telegram polling. Background news uses the low-priority local admission path described above and does not hold a global LLM permit while waiting. Normal local requests enter that same local queue at normal priority and overtake waiting news. Bound news calls per minute/hour and pause claims when normal-task latency or queue age exceeds its limit. Record queue wait separately from inference time. Add bounded batching only if the measured peak exceeds single-worker capacity; batch parsing must preserve a verdict for every intel ID and retry omissions individually.

### 3. Route results into the normal Thufir flow

- `irrelevant`: store the verdict; no briefing or event scan.
- `relevant/routine`: accumulate and deduplicate recent intel references for the existing 15-minute originator scan and position/watchlist assessment. Pass at most five headline summaries and 1,000 total characters per scheduled cycle. The current scheduled path reads structured events but does not automatically include these Telegram items. Routine posts must not each invoke a full agent.
- `relevant/urgent`: request an event-driven autonomous scan only after a tradable market has been identified. Preserve `NewsActivation` source and intel ID, the existing 120-second event cooldown, and all downstream trade gates. Add a separate configurable news-scan budget initially capped at four extra scans per hour. The position assessment is part of that bounded event path, not a second full-agent call per post.

Do not run `maybeRunEventDrivenScan()` before screening. Deduplicate repeated reports of the same event when routing, using source/intel identity and a bounded similarity window; keep each raw intel item for audit. Issue at most one routine news briefing per scheduled cycle and only if the combined assessment finds a concrete position/watchlist impact. Persist a dispatch key for briefing and scan side effects so job retries cannot start the same action twice. If a crash leaves an external Telegram delivery outcome uncertain, record that uncertainty for reconciliation instead of blindly resending. A screening result never authorizes an order.

### 4. Observability and rollout

Log and persist one terminal outcome per intel ID: classifier verdict, model, attempt count, latency, queue age, briefing outcome, scan request outcome, and downstream scan ID where present. Record the actual `YES`/`NO` verdict or an explicit failure class rather than only response length. Avoid logging full model prompts, credentials, or entire headlines.

Deploy in three stages:

1. **Sampled shadow:** persist every new post, classify a configurable sample, and mark unsampled posts explicitly. Keep current briefing and event-scan routing. Compare classifications with labeled stored headlines and measure p50/p95 inference latency, queue age, model timeouts, and p95 latency of the local client's other tasks.
2. **Full shadow:** classify all new posts without adding briefings or event scans. Include the second-pass urgency calls in the load test. Replay the observed 11-post minute, 26-post five-minute burst, and 127-post peak hour under concurrent scheduled scans, originator calls, and chat probes. Require p95 screening queue age below five minutes, no lost posts, and no more than a 25% increase in p95 latency for existing LLM work before activating routing. If these targets fail, change the classifier/queue design and repeat shadow validation.
3. **Active:** route classifier results after the shadow checks pass. Keep a flag to return to prior routing without deleting pending jobs. A restart must drain pending work without duplicate side-effect initiation.

The shadow review must include gold and Brent moves, conditional Iran warnings, a concrete diesel shock, an unrelated pharmaceutical headline, duplicate feed posts, and a digest. A classification label is reviewed against the actual post; no target `YES` rate is imposed.

**Implementation reconciliation:** The old keyword path launched an unconditional full scan before relevance screening. The shipped shadow compatibility path screens all legacy keyword hits, including those outside the configured sample, and routes them only after a relevant/urgent verdict, dynamic market mapping, existing cooldown, and the separate hourly cap. Non-keyword shadow posts do not route. This is a deliberate safety change from the literal “keep current routing” line above. Active routing remains opt-in after the full-shadow latency gate. Focused monitor, router, autonomous-wiring, and temporary-SQLite integration tests prove the implemented entrypoints; full-shadow performance and production behavior are pending release validation.

### Implementation evidence status (2026-09-24)

- **Implemented and focused-tested:** `news_screen_jobs` persistence, atomic store-and-enqueue API, explicit unsampled state, provenance-only activation storage with callback text reconstruction, one-at-a-time claims, exact binary/urgency parsing, two retries then visible failure, persisted leases and restart recovery, callback replay after callback failure, and per-minute/hour call admission. See `tests/intel/news_screening.test.ts` (seven temporary-SQLite lifecycle tests).
- **Implemented and focused-tested:** monitor-to-worker-to-gateway temporary-SQLite fixture, shadow routing, local/global queue priority under concurrent work, 11-post nonblocking ingestion, and durable restart/dispatch replay. See `tests/intel/news_ingestion_routing.integration.test.ts`, `tests/intel/news_routing.test.ts`, and `tests/core/llm-trivial-local-isolation.test.ts`.
- **Full-suite proof on combined code release SHA `730ad871449d5b7de28d33e00e1c5b38955e458d`:** 229 files and 1,225 tests passed with V8 coverage; production build passed. Overall coverage was 72.83% lines and 67.65% branches. On the routing feature branch, the new screening, routing, and gateway router modules had 87.9%, 96.4%, and 86.3% line coverage respectively.
- **Pending release proof:** observed 26-post and 127-post burst capacity under concurrent production work, full-shadow latency targets, and production deployment validation. The test suite does not prove active-rollout capacity.

## Red-first test contracts

Add or extend tests around `src/intel/telegram_monitor.ts`, the gateway news callback, and the persisted worker:

1. A non-keyword gold move creates one screening job; the current implementation fails this test.
2. A keyword post and a non-keyword post both reach classification, while neither launches a scan before verdict.
3. Push followed by poll creates one intel item and one screening job.
4. A burst of posts returns from the monitor without awaiting local inference; all jobs eventually receive outcomes.
5. Routine relevant posts are accumulated for one bounded scheduled assessment; N routine posts do not create N full-agent calls.
6. A model `relevant/urgent` result with a mapped market requests at most one scan inside the cooldown; the activation carries the original intel ID and source.
7. Unmapped or unrelated posts cannot launch a scan or order.
8. Timeout, empty output, non-`YES`/`NO` output, and budget suppression retry and never become `irrelevant`.
9. Worker restart resumes a leased/pending job; dispatch keys prevent duplicate scan/briefing initiation and uncertain external sends are surfaced.
10. A `BREAKING_OK` assessment sends no Telegram message; a real position impact sends one per authorized recipient.
11. Shadow mode records results but leaves active routing unchanged.
12. The normal scheduled scan and its trade-risk gates still run when the screening queue is delayed or offline.
13. The separate news-scan hourly budget and one-briefing-per-cycle cap hold under a burst of relevant posts.
14. The three-way JSON prompt replay yielding all `uncertain` is a regression control: such output cannot dispatch full-agent work.
15. **Implemented and proven for local admission.** Background news does not hold a global permit while waiting for Ollama; a normal local trivial request overtakes queued news even while a remote request occupies the global permit; local inference remains single-flight; abort removes a queued background request; the background client does not fall back remotely on local health failure. Proof: `tests/core/llm-trivial-local-isolation.test.ts` tests `admits background work without taking a global permit while it waits for local inference`, `starts a normal local request ahead of queued background work and keeps local calls single-flight`, `removes an aborted background request while it is waiting for local admission`, and `never falls back to a remote provider when background local inference fails`. This proves the client and queue contract; full worker burst/latency gates remain required before active rollout.

The integration fixture must exercise the actual monitor-to-worker-to-gateway seam with a temporary SQLite database. Unit tests for the parser alone do not prove ingestion or routing.

## Acceptance and release checks

- All new distinct posts are either screened or carry a visible pending/failed job; none disappear because they lack a keyword.
- Gold and Brent examples reach screening, the unrelated control is rejected, and the conditional Iran example receives a recorded decision rather than being skipped.
- Full event scans are triggered only by `relevant/urgent` mapped posts and remain cooldown- and hourly-budget-limited. Routine posts add no per-post full-agent calls.
- Under replay of the observed 11-post minute, 26-post five-minute burst, and 127-post peak hour, the queue drains without blocking Telegram polling or losing posts. The full-shadow latency targets above must pass under concurrent normal work; do not declare capacity from isolated model calls alone.
- Focused tests, typecheck, full suite, CLI smoke, and a production-like restart/replay pass before active routing.
- After active rollout, verify production job counts against `intel_items`, inspect failed-job alerts and queue age, and confirm scheduled trading scans and Telegram delivery remain healthy.
