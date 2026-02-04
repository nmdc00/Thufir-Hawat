# Calibration

Thufir tracks trade decisions and outcomes to understand confidence quality and error modes. Calibration is treated as a learning signal, not as a promise of accuracy.

## Goals
- Measure decision quality over time
- Identify systematic bias (over/under-confidence)
- Adjust future sizing and hypothesis prioritization

## Metrics
- Win rate (directional accuracy)
- Brier-style scoring (when probabilities are logged)
- Realized vs unrealized PnL

Calibration is evolving as the system shifts fully to perps.
