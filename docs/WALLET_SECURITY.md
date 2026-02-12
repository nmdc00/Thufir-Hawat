# Wallet Security

## Principles
- Never store private keys in config files.
- Use environment variables for sensitive material.
- Keep trade sizing and loss limits enforced at execution.

## Hyperliquid
- Export `HYPERLIQUID_PRIVATE_KEY` in the environment.
- Optionally set `hyperliquid.accountAddress` in config.
- Do not commit keys to git.
- Funding requires EVM RPC access for Polygon/Arbitrum when using cross-chain tools:
  - `THUFIR_EVM_RPC_POLYGON`
  - `THUFIR_EVM_RPC_ARBITRUM`
- Cross-chain funding/deposit tools are side-effecting and must require confirmation unless explicitly allowed by policy.

## Risk Controls
- Daily and per-trade limits (DbSpendingLimitEnforcer)
- Perp risk checks (max notional, leverage, liquidation buffer)

## Operational Guidance
- Start in paper mode, validate tool outputs, then switch to live mode.
- Ensure Arbitrum ETH is available for gas before attempting bridge receive or USDC deposit transfers.
