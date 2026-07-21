# TDD: Background LLM Call Economy Hotfix

## Incident

Production exhausted 3% of the weekly provider allowance in roughly 20 minutes. The exit consultant
recorded repeated reviews for an unchanged position inside two minutes, and production had accumulated
hundreds of exit reviews per day.

## Root cause

`LlmExitConsultant.shouldConsult()` treated TTL proximity as a level-trigger on a 30-second position
loop. A `hold` response left the position inside that level, so the next tick could call the model
again. Structural drawdown and invalidation-proximity signals had the same repeated-level shape.

## Runtime contract

1. TTL proximity fires once and then respects the configured consultation cadence.
2. No soft review signal may reconsult a position inside the minimum spacing window.
3. A position may start no more than three consultations in a rolling hour by default.
4. New ROE threshold crossings remain event-driven and may review before normal cadence.
5. Hard invalidation and emergency-risk actions remain deterministic and immediate.
6. Scheduled liveness with no new proactive summary returns `HEARTBEAT_OK` without an LLM call.
7. Production enables the existing rolling remote-call/token budget before restart.

## Proof

- Unit tests cover first TTL approach, repeated TTL suppression, ROE crossing, and hourly cap.
- Gateway tests prove routine liveness does not require a model.
- Position-heartbeat lifecycle tests preserve TTL review, invalidation, and emergency behavior.
- Production validation queries same-symbol reviews inside five minutes and remote usage errors.

## Rollback

Revert the hotfix commit and restore the prior production config. Keep Thufir stopped if provider
usage again exceeds the release contract.
