# Thufir LLM Usage Guardrails

## Product Requirements Document / Technical Design Document

Status: Proposed  
Scope: Thufir autonomous runtime  
Explicitly excluded: fixed daily or weekly token/request budgets

## 1. Problem

Thufir can issue repeated remote LLM calls during autonomous scans, exit consultations, retries, fallback handling, and non-critical context refinement. This can exhaust the available Codex allowance rapidly even when no trade is executed.

The system needs to reduce avoidable remote calls while preserving trade safety and runtime responsiveness.

## 2. Goals

- Keep non-critical work local-only or disabled.
- Make trade exits mechanical by default.
- Bound exit-consult frequency per position.
- Bound LLM concurrency and calls per autonomous scan.
- Prevent local-model failures from escalating trivial work to Codex.
- Cache equivalent analyses.
- Stop retry storms after provider, authentication, or quota failures.
- Provide usage attribution and threshold alerts.

## 3. Non-goals

- No fixed daily or weekly allowance cap.
- No change to exchange execution semantics.
- No automatic changes to position size, leverage, or risk limits.
- No removal of Codex from genuinely ambiguous high-impact decisions.

## 4. User-visible requirements

### 4.1 Proactive refinement

`proactive_query_refine` and equivalent non-critical context tasks MUST either:

- run on the local provider, or
- be skipped when the local provider is unavailable.

They MUST NOT fall back to Codex.

### 4.2 Mechanical exits

For every managed position, the runtime MUST evaluate deterministic rules before any LLM request:

- stop loss
- take profit
- time stop
- trailing stop
- thesis invalidation
- position/exposure safety rules

If a deterministic rule decides the exit, no LLM call is allowed.

The LLM may be consulted only when the deterministic evaluator returns `ambiguous` and the position is eligible under the exit cooldown.

### 4.3 Exit consultation cooldown

The default cooldown MUST be 60 minutes per position. A consultation may bypass the cooldown only for a new hard invalidation signal or an operator-forced review.

The cooldown key MUST include the stable position/lifecycle identity, not only the symbol, so multiple positions in one symbol do not suppress each other incorrectly.

### 4.4 Concurrency and scan limits

- Maximum concurrent remote LLM calls: `2` by default.
- Maximum remote LLM calls per autonomous scan: `3` by default.
- Calls beyond either limit MUST be deferred, handled mechanically, or skipped with an observable reason.
- Retries count against the same scan limit.

### 4.5 Local timeout behavior

A local-model timeout on a trivial or non-critical task MUST return a safe local fallback result. It MUST NOT promote that task to Codex.

For a critical trade decision, a local timeout MUST result in a deterministic safe outcome such as `hold`, `reject`, or `no decision`, according to the existing caller contract. It MUST not create an unbounded provider fallback chain.

### 4.6 Caching

Equivalent requests MUST use a short-lived cache keyed by:

- task type
- symbol or position identity
- relevant timeframe
- normalized input hash
- policy/config version

Default TTL: 15 minutes for market context and 60 minutes for exit analysis. Safety-triggered invalidation MUST bypass the cache.

### 4.7 Circuit breaker

The provider circuit breaker MUST open after either:

- 3 consecutive authentication/quota failures, or
- 5 provider failures within 10 minutes.

When open:

- no remote retries are attempted for 15 minutes;
- deterministic trade management continues;
- non-critical work is skipped or local-only;
- the state and reason are logged.

The breaker MUST use separate state for authentication/quota failures and transient timeouts.

### 4.8 Usage observability

Every LLM attempt MUST record:

- provider and model
- task kind
- trigger reason
- position/lifecycle ID when applicable
- cache hit/miss
- retry number
- latency
- success/failure category
- input/output token counts when available
- whether the call was prevented by cooldown, scan limit, concurrency limit, or circuit breaker

The system MUST expose aggregates by provider, model, task, trigger, and time window.

Alerts MUST fire at 50%, 75%, and 90% of the configured rolling usage-warning threshold. This is an observability threshold, not a hard allowance cap.

## 5. Technical design

### 5.1 Request policy

Introduce a single request-policy decision point before provider invocation:

```ts
type LlmRequestDecision =
  | { action: 'allow'; reason: string }
  | { action: 'cache'; cacheKey: string; reason: string }
  | { action: 'local_only'; reason: string }
  | { action: 'mechanical'; reason: string }
  | { action: 'defer'; reason: string }
  | { action: 'skip'; reason: string };
```

All autonomous callers, including entry gating, originator, exit consultation, heartbeat, and proactive refinement, MUST use this policy point.

Provider selection MUST happen after policy evaluation. This prevents a suppressed local task from being silently re-routed to Codex.

### 5.2 Exit decision pipeline

```text
position update
  -> deterministic rule evaluator
  -> decided exit: execute and do not call LLM
  -> ambiguous result
  -> cache lookup
  -> lifecycle cooldown check
  -> scan/concurrency policy
  -> remote exit consultation
  -> bounded fallback or safe hold
```

The LLM response MUST not override a deterministic hard stop in either direction.

### 5.3 Admission control

Use a process-wide semaphore for remote calls and a scan-scoped counter. The counter must be propagated through nested tool and fallback calls so retries cannot evade the limit.

Suggested configuration:

```yaml
llm:
  remoteConcurrency: 2
  maxRemoteCallsPerAutonomousScan: 3
  exitConsultCooldownMinutes: 60
  cache:
    contextTtlMinutes: 15
    exitTtlMinutes: 60
  circuitBreaker:
    authQuotaFailures: 3
    transientFailures: 5
    transientWindowMinutes: 10
    openMinutes: 15
```

### 5.4 Failure classification

Provider failures MUST be classified before fallback:

- `auth`: token invalid, revoked, or expired
- `quota`: allowance or rate limit exhausted
- `timeout`: request exceeded deadline
- `transport`: connection or upstream availability failure
- `schema`: invalid model response
- `policy`: request denied by local guardrail

`auth` and `quota` failures MUST never trigger immediate retries to the same provider.

### 5.5 Persistence

Extend the existing LLM usage/audit surface or add a normalized table with indexes on:

- `created_at`
- `provider`
- `task_kind`
- `position_id`
- `decision`

Cooldown state MUST be persisted or recoverable from existing consultation logs so a process restart does not immediately repeat all exit consultations.

### 5.6 Backward compatibility

- Existing deterministic exit behavior remains authoritative.
- Existing LLM logs remain queryable.
- Missing token metadata is allowed and recorded as null.
- Existing callers without a position identity use a task-level cooldown key until migrated.

## 6. Acceptance criteria

### Functional

- A proactive refinement request never reaches Codex when local inference is unavailable.
- A position with a triggered stop-loss exits without an LLM request.
- An ambiguous position produces at most one exit consultation per cooldown window.
- Two concurrent remote requests are allowed; a third is deferred or skipped.
- A scan produces no more than three remote calls, including retries and fallbacks.
- A local timeout on a trivial task does not generate a remote request.
- Three consecutive auth failures open the auth circuit breaker.
- Requests are served from cache when the normalized key and TTL match.
- Hard invalidation bypasses the exit cache and cooldown.

### Observability

- Every denied, cached, deferred, skipped, and executed request has a reason code.
- Usage aggregates can distinguish exit consultations from proposals, entry gates, heartbeats, and proactive tasks.
- Circuit-breaker state changes are logged with provider and reason.
- Alerts identify the highest-volume task and trigger reason.

### Safety

- A guardrail cannot prevent a deterministic stop-loss or take-profit execution.
- A failed or unavailable LLM produces a safe mechanical result.
- No fallback path can recursively invoke the same provider without consuming admission budget.

## 7. Test plan

### Unit tests

- Policy decisions for each task kind.
- Local-only enforcement for proactive refinement.
- Exit rule precedence over LLM consultation.
- Position/lifecycle cooldown keys.
- Scan counter includes retries and fallback calls.
- Semaphore admission and deferral.
- Cache key normalization, TTL, and invalidation.
- Circuit-breaker thresholds and reset behavior.
- Failure classification.

### Integration tests

- Autonomous scan with 20 candidates results in at most three remote calls.
- Ten open positions with unchanged prices generate zero repeated exit consultations inside cooldown.
- A hard invalidation triggers one consultation despite an active cooldown.
- Local provider timeout does not produce a Codex request for trivial work.
- Codex auth failure opens the breaker and subsequent scans remain mechanical.
- Restarting Thufir preserves cooldown behavior.

### Runtime lifecycle tests

- Open position -> deterministic stop -> close persistence.
- Open position -> ambiguous state -> one consultation -> hold.
- Open position -> consultation failure -> safe hold and recorded failure.
- Partial reduction -> remaining lifecycle retains independent cooldown state.
- Full close -> no future consultations for the closed lifecycle.

### Load tests

- 100 candidate expressions per scan.
- 100 open positions with simultaneous price updates.
- Local model timeout under concurrency.
- Provider outage for 15 minutes.

## 8. Rollout plan

1. Add usage decision codes and metrics in shadow mode.
2. Enable proactive local-only routing.
3. Enable mechanical-exit precedence and exit cooldown.
4. Enable cache and bounded concurrency.
5. Enable circuit breaker and failure-specific fallback rules.
6. Compare remote-call volume, exit latency, and missed-decision metrics for 24 hours.
7. Make guardrails mandatory after runtime evidence confirms no safety regression.

## 9. Success metrics

- At least 80% reduction in remote LLM calls per autonomous scan.
- At least 90% reduction in repeated exit consultations for unchanged positions.
- Zero remote calls for proactive refinement.
- Zero missed deterministic exits caused by an LLM guardrail.
- No increase in close latency for deterministic exits.
- Provider failures produce bounded, observable behavior rather than retry storms.

## 10. Open decisions

- Whether the default exit cooldown should be 30 or 60 minutes after observing current position volatility.
- Whether ambiguous exit decisions should default to `hold` or a mechanically bounded reduction.
- Which existing dashboard or alert channel should receive usage warnings.
- Whether local model capacity should be increased before enabling local-only non-critical processing.

## 11. Implementation status

- Implemented: non-critical fallback is local-only by default; local failure degrades instead of escalating to a remote provider.
- Implemented: exit consultation defaults are one consultation per position per hour, with 60-minute first/cadence/spacing defaults.
- Existing and retained: rolling hourly LLM budget, serialized local inference, provider cooldown handling, deterministic exit rules, and per-position consultation accounting.
- Deferred: dedicated per-autonomous-scan remote-call counter, normalized request cache, persisted circuit-breaker state, and usage threshold alert delivery.
