# Calibration System

This document describes Thufir's prediction calibration system - a key differentiator from simple trading bots.

## Why Calibration Matters

Most people (and AI systems) are poorly calibrated:
- When they say "90% confident," they're right maybe 70% of the time
- They're overconfident in some domains, underconfident in others
- They don't track or learn from their prediction errors

Thufir tracks every prediction and its outcome, building a personalized calibration model that adjusts confidence over time.

## How It Works

### The Calibration Loop

```
┌─────────────────────────────────────────────────────────────┐
│  1. PREDICT                                                 │
│     You (or Thufir) make a prediction with a probability     │
│     "Fed will hold rates: 72% YES"                          │
└───────────────────────────────┬─────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│  2. RECORD                                                  │
│     Prediction stored with reasoning and confidence         │
│     domain: economics, confidence: high, probability: 0.72  │
└───────────────────────────────┬─────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│  3. RESOLVE                                                 │
│     Market resolves → outcome recorded                      │
│     Result: YES (Fed held rates)                            │
└───────────────────────────────┬─────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│  4. SCORE                                                   │
│     Calculate Brier score contribution                      │
│     Brier = (0.72 - 1.0)² = 0.0784 (good!)                  │
└───────────────────────────────┬─────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│  5. UPDATE CALIBRATION                                      │
│     Update domain-specific calibration curves               │
│     "In economics, when you predict 70-80%, actual is 75%"  │
└───────────────────────────────┬─────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│  6. ADJUST FUTURE PREDICTIONS                               │
│     Next economics prediction: raw 72% → adjusted 70%       │
└─────────────────────────────────────────────────────────────┘
```

## Metrics

### Brier Score

The primary metric for prediction quality. Measures how close your probability estimates are to outcomes.

**Formula:**
```
Brier Score = (1/N) * Σ (probability - outcome)²

where:
- probability = your predicted probability (0-1)
- outcome = 1 if YES resolved, 0 if NO resolved
- N = number of predictions
```

**Interpretation:**
- 0.00 = Perfect (impossible in practice)
- 0.10 = Excellent
- 0.20 = Good
- 0.25 = Random guessing (predicting 0.5 always)
- 0.33+ = Poor (worse than random)

**Example:**
```
Prediction: "Tesla beats deliveries" = 70% YES
Outcome: YES (Tesla beat deliveries)

Brier contribution = (0.70 - 1.0)² = 0.09 ✓ Good!

---

Prediction: "Rain tomorrow" = 90% YES
Outcome: NO (didn't rain)

Brier contribution = (0.90 - 0.0)² = 0.81 ✗ Very bad!
```

### Calibration Curve

Shows relationship between predicted probability and actual frequency.

**Perfect calibration:**
```
Predicted  |  Actual
   10%     |   10%
   30%     |   30%
   50%     |   50%
   70%     |   70%
   90%     |   90%
```

**Typical overconfident predictor:**
```
Predicted  |  Actual
   10%     |   15%    (underconfident when uncertain)
   30%     |   35%
   50%     |   50%
   70%     |   60%    (overconfident when confident)
   90%     |   75%    (very overconfident)
```

### Domain Breakdown

Calibration varies by domain. Track separately:

```
Domain          Predictions   Brier    Accuracy   Calibration
─────────────────────────────────────────────────────────────
Politics             45       0.18       71%      Overconfident
Economics            32       0.12       78%      Well-calibrated
Sports               28       0.24       54%      Poor
Technology           19       0.15       73%      Slight overconf
Entertainment        12       0.21       58%      Underconfident
```

## Confidence Levels

Thufir uses three confidence levels to bucket predictions:

| Level | Description | Typical Range |
|-------|-------------|---------------|
| Low | High uncertainty, limited data | 35-65% |
| Medium | Reasonable confidence, some uncertainty | 25-35% or 65-75% |
| High | Strong conviction, good data | <25% or >75% |

Each level is calibrated separately because overconfidence patterns differ by confidence level.

## Calibration Adjustment Algorithm

When making a new prediction, Thufir adjusts based on historical performance:

```python
def adjust_confidence(raw_probability: float, domain: str) -> float:
    """
    Adjust raw probability based on historical calibration.
    """
    # Get calibration data for this domain
    calibration = get_calibration_curve(domain)

    # Find the calibration bucket for this probability
    bucket = find_bucket(raw_probability, calibration)

    # Calculate adjustment factor
    # If predicted 70% but actual was 60%, factor = 60/70 = 0.857
    if bucket.predicted_avg > 0:
        factor = bucket.actual_avg / bucket.predicted_avg
    else:
        factor = 1.0

    # Apply adjustment
    adjusted = raw_probability * factor

    # Clamp to valid range
    return max(0.01, min(0.99, adjusted))

# Example:
# Raw prediction: 80% YES
# Historical: when predicting 75-85%, actual was 65%
# Factor: 0.65 / 0.80 = 0.8125
# Adjusted: 0.80 * 0.8125 = 0.65 (65% YES)
```

## Position Sizing

Calibration affects position sizing via the Kelly Criterion:

**Basic Kelly:**
```
Kelly % = (p * b - q) / b

where:
- p = probability of winning
- q = probability of losing (1 - p)
- b = odds (payout ratio)
```

**Calibration-Adjusted Kelly:**
```python
def kelly_position(probability: float, price: float, domain: str) -> float:
    """
    Calculate position size using calibrated probability.
    """
    # Adjust probability based on calibration
    calibrated_prob = adjust_confidence(probability, domain)

    # Get confidence level
    confidence = get_confidence_level(probability)

    # Additional confidence penalty based on historical accuracy
    # at this confidence level
    accuracy_at_confidence = get_accuracy_at_confidence(domain, confidence)

    # If you're historically less accurate at "high confidence"
    # predictions, reduce the Kelly fraction
    confidence_factor = min(1.0, accuracy_at_confidence / 0.7)

    # Calculate edge
    edge = calibrated_prob - price

    # Kelly fraction (use 1/4 Kelly for safety)
    if edge > 0:
        kelly = (edge / (1 - price)) * 0.25 * confidence_factor
    else:
        kelly = 0

    return kelly
```

## User Interface

### Viewing Calibration

```bash
# Overall calibration stats
thufir calibration show

# Output:
# ══════════════════════════════════════════════════════════════
#                     CALIBRATION REPORT
# ══════════════════════════════════════════════════════════════
#
# Overall Brier Score: 0.168 (Good)
# Total Predictions: 142 (89 resolved)
# Overall Accuracy: 67%
#
# By Domain:
# ──────────────────────────────────────────────────────────────
# Domain          Predictions   Brier    Accuracy   Trend
# Politics             34       0.142      73%       ↑
# Economics            28       0.121      79%       →
# Sports               15       0.234      53%       ↓
# Technology           12       0.156      75%       →
#
# Calibration Curve (all domains):
# ──────────────────────────────────────────────────────────────
# Predicted    Actual    Count    Status
#    0-20%      18%        8      ✓ Well-calibrated
#   20-40%      31%       14      ✓ Well-calibrated
#   40-60%      48%       22      ✓ Well-calibrated
#   60-80%      62%       31      ⚠ Slightly overconfident
#   80-100%     71%       14      ⚠ Overconfident
#
# Recommendation: Reduce confidence on high-conviction predictions
# ══════════════════════════════════════════════════════════════
```

### Domain-Specific View

```bash
thufir calibration show --domain politics

# Shows detailed calibration for politics predictions
```

### Historical Analysis

```bash
thufir calibration history --domain economics --limit 20

# Shows recent predictions in this domain with outcomes
```

## Conversation Integration

Thufir uses calibration data in conversations:

**Example:**

> **You:** What do you think about the UK election market?
>
> **Thufir:** Looking at the UK General Election market (Labour majority):
>
> **Current price:** 0.62 YES
>
> **My estimate:** 0.68 YES
>
> **Confidence:** Medium
>
> **Note:** Your historical accuracy on political predictions is 73%, but you tend to be overconfident at this confidence level (predicted 65-75% → actual 60%). Adjusting my estimate down slightly.
>
> **Adjusted estimate:** 0.64 YES
>
> This suggests slight value on YES, but the edge is small after calibration adjustment. Recommended position: $15 (0.3% of portfolio).

## Building Good Calibration Data

### Cold Start Problem

When you first start, there's no calibration data. Thufir handles this by:

1. Using conservative defaults (slight overconfidence adjustment)
2. Encouraging many small predictions to build data
3. Recommending smaller position sizes until calibration stabilizes

### Minimum Sample Size

Calibration becomes meaningful after:
- 30+ predictions overall
- 10+ predictions per domain
- 5+ predictions per confidence level

Before these thresholds, calibration adjustments are minimal.

### Prediction Diversity

Good calibration requires diverse predictions:
- Multiple domains
- Various probability ranges (not just 50-50s)
- Different time horizons
- Both wins and losses

## Improving Calibration

### Common Patterns and Fixes

**Overconfidence (most common):**
- Symptom: High-confidence predictions have lower actual accuracy
- Fix: Thufir automatically adjusts down; consciously hedge strong views

**Domain blindspots:**
- Symptom: One domain has much worse Brier score
- Fix: Either improve expertise or avoid that domain

**Confirmation bias:**
- Symptom: Predictions align with desired outcomes, poor accuracy
- Fix: Seek disconfirming evidence before predicting

**Hindsight updates:**
- Symptom: Reasoning sounds good but predictions miss
- Fix: Record reasoning BEFORE outcome is known

### Deliberate Practice

```bash
# Get practice recommendations
thufir calibration practice

# Output:
# To improve calibration, consider:
#
# 1. Make more predictions in the 30-40% range
#    (Current: 8 predictions, need more data)
#
# 2. Your sports predictions are poorly calibrated (Brier: 0.23)
#    Consider: more research, or avoid sports markets
#
# 3. Practice with resolved markets:
#    - "Super Bowl 2026 Winner" (resolves in 2 weeks)
#    - "Fed March Decision" (resolves in 6 weeks)
```

## Data Export

Export calibration data for external analysis:

```bash
# Export all predictions
thufir calibration export --format csv --output predictions.csv

# Export calibration summary
thufir calibration export --format json --output calibration.json
```

## Privacy

Calibration data is stored locally and never leaves your machine unless you explicitly export it.

```
~/.thufir/
  └── data/
      └── predictions.db     # SQLite database with all predictions
      └── calibration.json   # Cached calibration curves
```
