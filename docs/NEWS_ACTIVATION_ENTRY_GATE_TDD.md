# News Activation, Entry-Gate, and Hyperliquid Resolution TDD

**Status:** Proposed
**Date:** 2026-09-23
**Scope:** Telegram-triggered autonomous scans, entry-gate LLM reliability, trade-plan completeness, and Hyperliquid candidate identity

## Production evidence

The deployed service is running commit `524211b93cd66948abbf9c60fddc16e4607cc6de` in paper mode with full auto enabled.

Observed after the deploy:

- Telegram channel polling, intel storage, keyword activation, relevance screening, and event-scan invocation all work.
- Autonomous scans repeatedly finish with `executed: 0`; no exchange order failure is present because no candidate reaches execution.
- Primary entry-gate failures recur as `json_parse / Unexpected end of JSON input`; fallback attempts can time out and safely reject.
- Quant entry candidates commonly lack `expectedRMultiple`, `suggestedTtlMinutes`, verified catalyst publication, and execution-quality data.
- Telegram posts are stored as social intel, but the event-driven callback invokes a generic `runScan()`; the originator bundle reads structured events rather than the newly stored Telegram item.
- Plain symbols such as `ETH`, `XPL`, `PUMP`, `ENA`, and `BCH` repeatedly fail market resolution because multiple qualified Hyperliquid markets share the same base ticker.

The three failures are separate layers:

| Issue | Layer | Current consequence |
|---|---|---|
| Empty/truncated primary LLM decision content | LLM transport/response parsing | Fallback or safe reject |
| News and trade-plan fields absent from quant candidates | Runtime wiring/data contract | Entry gate rejects incomplete plans |
| Base ticker loses canonical market identity | Discovery/market resolution | Candidate skipped before entry gate |

## Goals

1. Make entry-gate response handling distinguish valid JSON, empty output, truncated output, and schema-invalid output, with bounded fallback behavior and actionable telemetry.
2. Carry a Telegram activation into the autonomous scan as typed, source-grounded news context.
3. Ensure a candidate cannot be presented as news-supported unless it has a source reference and publication timestamp.
4. Ensure executable candidates carry an explicit, machine-readable invalidation, target/reward-risk plan, and TTL. Do not invent these values from prose, edge, or a broad signal horizon.
5. Preserve exact Hyperliquid market identity through discovery and resolve exact identifiers before applying base-symbol ambiguity rules.
6. Keep fail-closed behavior: missing evidence, malformed LLM output, or unresolved identity must never place an order.

## Non-goals

- Lowering entry-gate standards to increase trade count.
- Treating every Telegram post as a trade catalyst.
- Selecting a HIP-3 DEX automatically for a genuinely ambiguous bare ticker.
- Switching paper execution to live execution.
- Modifying `docs/HYPERLIQUID_SYMBOL_IDENTITY_TDD.md` or `docs/OPERATIONS.md`.

## Proposed design

### Fix 1: Harden primary entry-gate LLM response handling

#### Current path

`src/core/llm_entry_gate.ts` calls `client.complete()` and immediately parses `response.content` with `JSON.parse()`. The production primary client is the proxied OpenAI decision client. In this configuration, `src/core/llm.ts` requests a streaming chat completion and reconstructs the response by collecting `data:` lines. An empty or incomplete reconstruction reaches `JSON.parse()`, producing `Unexpected end of JSON input`.

#### Proposed behavior

Introduce a typed response-normalization boundary between the LLM client and the entry gate:

```ts
type DecisionResponse =
  | { ok: true; content: string; transport: 'stream' | 'non_stream' }
  | { ok: false; code: 'empty_response' | 'truncated_stream' | 'invalid_json' | 'schema_invalid'; detail: string };
```

The boundary must:

1. Collect streamed assistant deltas from valid SSE records, accepting both `data:` and `data: ` forms.
2. Ignore keep-alive/comment lines and stop cleanly at `[DONE]`.
3. Detect an empty stream, a stream ending without assistant content, and malformed JSON before the gate’s schema parser.
4. Preserve the first 120 characters of a safely redacted response preview, response mode, model, provider, and request correlation ID in diagnostics. Never log credentials or the complete trading prompt.
5. Attempt at most one bounded primary retry for an empty/truncated response when budget permits. The retry must use the same candidate and an explicit JSON-only instruction.
6. Fall back once to the configured fallback LLM. If fallback fails, retain `rejectOnBothFail` safe rejection.
7. Record `usedFallback`, `failureType`, `primaryModel`, `fallbackModel`, and `llmConsulted` in the entry-gate log.

Do not silently turn an empty response into an approval, and do not retry indefinitely.

#### Acceptance criteria

- A valid streamed decision reaches `DecisionSchema` unchanged.
- An empty or truncated primary stream produces a typed failure, not an uncaught `SyntaxError`.
- A primary failure emits one fallback notification and one structured diagnostic.
- A failed fallback produces a safe reject with `reasonCode: 'llm_unavailable'`.
- A valid primary decision does not invoke the fallback.
- Production logs identify whether the failure was transport-empty, invalid JSON, schema-invalid, timeout, or budget-degraded.

### Fix 2: Carry activation context and complete the candidate contract

#### Current path

`src/intel/telegram_monitor.ts` stores a Telegram post and calls the activation callback with `(itemCount, text, source)`. `src/gateway/index.ts` logs the activation and calls `maybeRunEventDrivenScan('intel', itemCount)`, which invokes an unparameterized `runScan()`.

The originator path assembles `recentEvents` from `listEvents()`, while Telegram posts are stored through the intel store. The quant entry path constructs an `EntryGateCandidate` without `expectedRMultiple` or `suggestedTtlMinutes`; `src/core/quant_entry_gate.ts` explicitly preserves edge and horizon as evidence rather than converting them into an executable target or TTL.

#### Proposed typed activation

Add a typed activation object:

```ts
interface NewsActivation {
  id: string;
  source: string;
  text: string;
  receivedAtMs: number;
  publishedAtMs?: number;
  intelId?: string;
  matchedKeyword?: string;
}
```

Pass it through:

```text
Telegram monitor
  -> onBreakingNews(activation)
  -> maybeRunEventDrivenScan('intel', activation)
  -> autonomous.runScan({ activation })
  -> originator bundle + candidate enrichment
```

The activation must be included in the originator bundle as source-grounded context, alongside recent stored intel. The originator prompt must distinguish:

- headline text and source evidence;
- a proposed thesis;
- a complete executable trade plan.

#### Candidate contract

Extend discovery/entry candidate data with explicit plan fields:

```ts
interface TradePlanEvidence {
  invalidationPrice: number | null;
  targetPrice: number | null;
  expectedRMultiple: number | null;
  suggestedTtlMinutes: number | null;
  provenance: 'originator' | 'strategy' | 'none';
}
```

Rules:

1. Originator proposals must provide a machine-readable invalidation, target/reward-risk estimate, and TTL before they can be executable.
2. Quant expressions may execute only when a deterministic strategy produces those values explicitly. Unstructured `expectedMove`, edge, or `timeHorizon` must not be parsed heuristically into a target or TTL.
3. If no complete plan exists, the candidate remains observable but is rejected with `missing_plan_fields` and a precise reason.
4. For a news candidate, `newsTrigger.sources` must contain the activation/intel reference and a valid publication or receipt timestamp. A default technical catalyst must not be labeled as verified news.
5. The activation may influence discovery, but it must not force a trade or bypass global, risk, cooldown, or entry-gate checks.

#### Acceptance criteria

- A Telegram activation is visible in the originator input with source, text, and timestamp.
- A news-backed candidate preserves the activation reference and timestamp through entry-gate logging and trade journaling.
- Candidates with missing target/R:R/TTL are rejected before execution with structured `missingPlanFields`.
- A complete candidate contains non-null machine-readable plan fields and reaches normal risk and entry-gate evaluation.
- A Telegram headline with no asset mapping or no complete plan produces no order while remaining traceable.

### Fix 3: Preserve and resolve canonical Hyperliquid symbols

#### Current path

`src/discovery/market_selector.ts` emits symbols derived from Hyperliquid metadata. `HyperliquidMarketClient.getMarket()` computes exact matches but checks base-symbol ambiguity first. Thus a bare `ETH` can be rejected even when an exact main-market `ETH` exists alongside `hyna:ETH` and `cash:ETH`.

#### Proposed behavior

Use exact-first resolution in `src/execution/hyperliquid/markets.ts`:

1. Normalize the query.
2. Return a unique exact market match immediately, including exact main `ETH`.
3. Only if no exact match exists, evaluate base matches.
4. Return a single base match when exactly one exists.
5. Reject multiple base matches with canonical candidates in the error.

Preserve the exact metadata identity through discovery. A canonical symbol is the exact Hyperliquid universe name:

```text
ETH       main market
hyna:ETH  HIP-3 market
cash:ETH  HIP-3 market
```

If the discovery layer needs a display ticker, add a separate `baseSymbol`; never substitute it for the execution `symbol`.

The existing candidate-level catch-and-continue behavior remains required, but it becomes a containment fallback rather than the normal path for exact main markets.

#### Acceptance criteria

- Exact `ETH` resolves to main `ETH` when qualified collisions exist.
- Exact `hyna:ETH` and `cash:ETH` resolve to their respective markets.
- A genuinely ambiguous base-only query fails closed and lists qualified choices.
- Discovery preserves qualified symbols and does not collapse them to base tickers.
- An unresolved candidate does not abort the scan or submit an order.
- Resolution telemetry distinguishes exact-main, exact-HIP-3, ambiguous, and not-found outcomes.

## TDD test plan

Tests are written red-first against the current behavior, then turned green by the proposed implementation.

### Entry-gate transport tests

Add or extend `tests/core/llm-decision-clients.test.ts` and `tests/core/llm_entry_gate.test.ts`:

1. Collect a normal multi-line SSE decision into valid JSON.
2. Accept `data:` and `data: ` SSE prefixes.
3. Ignore keep-alive lines and `[DONE]`.
4. Return a typed `empty_response` for an empty stream.
5. Return a typed `truncated_stream` when the stream ends without a complete decision.
6. Return a typed `invalid_json` for non-empty malformed content.
7. Verify one bounded retry, then one fallback, then safe rejection.
8. Verify a valid primary result makes zero fallback calls.
9. Verify diagnostics contain failure classification but no prompt, token, or credential.

### Candidate-contract tests

Add or extend `tests/core/quant-entry-gate-lifecycle.test.ts`, `tests/core/origination-pipeline.test.ts`, and a Telegram activation test:

1. A Telegram activation object reaches `runScan()` and the originator bundle.
2. The activation source, text, reference, and timestamp survive candidate enrichment.
3. A candidate with no `expectedRMultiple` or TTL is logged with both missing fields and cannot execute.
4. A complete originator plan reaches the entry gate with `provenance: 'originator'`.
5. A deterministic strategy plan reaches the entry gate with `provenance: 'strategy'`.
6. Edge, prose expected move, and broad time horizon alone do not populate numeric target/R:R/TTL.
7. A Telegram headline without asset mapping does not become a trade candidate.
8. A candidate with valid news evidence but an entry-gate rejection remains traceable to the activation.

### Hyperliquid identity tests

Extend `tests/execution/hyperliquid-markets-cache.test.ts` and `tests/discovery/market_selector.test.ts`:

1. Exact main `ETH` resolves despite `hyna:ETH` and `cash:ETH` collisions.
2. Exact qualified symbols resolve correctly.
3. Multiple non-exact base matches remain ambiguous.
4. Discovery preserves `hyna:ETH` instead of emitting only `ETH`.
5. Configured canonical symbols select only their intended market.
6. An ambiguous candidate is skipped while later candidates continue.
7. No executor call occurs after resolution failure.

## Observability requirements

Add structured fields to logs and persisted gate decisions:

```text
scanId
activationId
activationSource
activationPublishedAtMs
candidateSymbol
canonicalSymbol
entryTrigger
missingPlanFields
planProvenance
llmFailureType
llmTransport
primaryModel
fallbackModel
marketResolutionCode
canonicalCandidates
```

Do not log Telegram credentials, session strings, authorization headers, or full unredacted prompts.

The autonomous summary must separate:

- `llmFallbacks`
- `missingPlanFields`
- `ambiguousMarketSymbols`
- `entryGateRejects`
- `executed`

## Validation gates

Before implementation is considered complete:

1. Run focused tests for all three areas.
2. Run `pnpm typecheck`.
3. Run the full Vitest suite.
4. Run the autonomous, perps, Hyperliquid-live, and Telegram polling critical-path tests.
5. Verify a production-like activation with a complete synthetic plan reaches the executor in paper mode.
6. Verify malformed primary output falls back safely without an order.
7. Verify exact main and qualified HIP-3 symbols resolve correctly.
8. Deploy only after the release SHA passes the release gate, then confirm production logs show the new classifications and at least one controlled paper execution.

## Rollout and rollback

1. Implement Fix 1 with focused parser/fallback tests.
2. Implement Fix 2 with activation-context and candidate-contract tests.
3. Implement Fix 3 with exact-first resolution and identity-preservation tests.
4. Run the full validation gate on the moving integration branch.
5. Deploy to paper mode and observe fallback, missing-field, resolution, and execution counters.
6. Roll back the release if malformed responses cause uncategorized failures, activation context is lost, a base symbol resolves to the wrong market, or any candidate bypasses fail-closed gates.
