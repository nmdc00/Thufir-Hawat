# Wallet Security

## Principles
- Never store private keys in config files.
- Use environment variables for sensitive material.
- Keep trade sizing and loss limits enforced at execution.

## Hyperliquid
- Export `HYPERLIQUID_PRIVATE_KEY` in the environment.
- Optionally set `hyperliquid.accountAddress` in config.
- Do not commit keys to git.

## Risk Controls
- Daily and per-trade limits (DbSpendingLimitEnforcer)
- Perp risk checks (max notional, leverage, liquidation buffer)

## Operational Guidance
- Start in paper mode, validate tool outputs, then switch to live mode.
