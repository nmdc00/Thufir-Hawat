# Thufir Current State

Last updated: 2026-06-13

## Active Release

- Current release: `release/v2.5`
- Release PRD/TDD: `release/v2.5-runtime-coherence-and-risk-containment.prd-tdd.md`
- Swarm manifest: `release/v2.5-swarm-manifest.md`
- Production branch/SHA: pending v2.5 promotion
- Deployment status: pending

## Production-Visible Success Criteria

v2.5 is complete only when the promoted production SHA proves these runtime contracts:

- New reduce-only perp closes persist a canonical close reason in fill/journal metadata.
- Autonomous opens pass portfolio exposure checks for gross, net, cluster, and duplicate-underlying risk before any LLM gate call.
- Entry-gate logs distinguish deterministic skips from LLM-consulted decisions.
- Originator 7/30-day scorecards are computed from post-cutoff data and visible on the Learning dashboard.
- Scheduled heartbeat/liveness checks do not route through the full conversation/tool loop.
- Operational retention policies prune bounded tables while retaining trade-linked artifacts.

## Latest Scorecard

Pending first v2.5 production nightly run.

| Window | Null Proposal Rate | Originated Share | Originated Win Rate | Originated Expectancy | Quant Expectancy |
|---:|---:|---:|---:|---:|---:|
| 7d | pending | pending | pending | pending | pending |
| 30d | pending | pending | pending | pending | pending |

## Active Docs

- `release/v2.5-runtime-coherence-and-risk-containment.prd-tdd.md`
- `release/v2.5-swarm-manifest.md`
- `CLAUDE.md`

## Historical Docs

Root `PROGRESS.md` and `HANDOFF.md` are historical session records. They are retained for context but are not the source of current release truth.
