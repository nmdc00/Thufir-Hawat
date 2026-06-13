# Thufir Current State

Last updated: 2026-06-13

## Active Release

- Current release: `release/v2.5`
- Release PRD/TDD: `release/v2.5-runtime-coherence-and-risk-containment.prd-tdd.md`
- Swarm manifest: `release/v2.5-swarm-manifest.md`
- Production branch/SHA: `main` / `1d13f8b7a7ca8deaad64ae63fcf4d6ab148dce7f`
- Deployment status: deployed 2026-06-13; `thufir.service` active on `77.42.29.26`

## Production-Visible Success Criteria

v2.5 is complete only when the promoted production SHA proves these runtime contracts:

- New reduce-only perp closes persist a canonical close reason in fill/journal metadata.
- Autonomous opens pass portfolio exposure checks for gross, net, cluster, and duplicate-underlying risk before any LLM gate call.
- Entry-gate logs distinguish deterministic skips from LLM-consulted decisions.
- Originator 7/30-day scorecards are computed from post-cutoff data and visible on the Learning dashboard.
- Scheduled heartbeat/liveness checks do not route through the full conversation/tool loop.
- Operational retention policies prune bounded tables while retaining trade-linked artifacts.

## Latest Scorecard

First v2.5 scorecard computed manually after deploy on 2026-06-13. Nightly scheduler will refresh subsequent rows.

| Window | Null Proposal Rate | Originated Share | Originated Win Rate | Originated Expectancy | Quant Expectancy |
|---:|---:|---:|---:|---:|---:|
| 7d | 100.00% | - | - | - | - |
| 30d | 100.00% | - | - | - | - |

## Active Docs

- `release/v2.5-runtime-coherence-and-risk-containment.prd-tdd.md`
- `release/v2.5-swarm-manifest.md`
- `CLAUDE.md`

## Historical Docs

Root `PROGRESS.md` and `HANDOFF.md` are historical session records. They are retained for context but are not the source of current release truth.
