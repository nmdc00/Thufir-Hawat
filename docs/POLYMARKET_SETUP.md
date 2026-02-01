# Polymarket Setup Guide

This guide walks you through setting up Thufir to trade on Polymarket.

## Prerequisites

1. **Polygon Wallet** with:
   - USDC (for trading)
   - Small amount of MATIC (~$5 for gas fees)

2. **Polymarket Account** (optional but recommended):
   - Go to [polymarket.com](https://polymarket.com)
   - Connect your wallet
   - This helps you verify positions in their UI

## Step 1: Create a Dedicated Wallet

**Important:** Use a separate "hot wallet" for Thufir. Never use your main wallet.

```bash
# Option A: Let Thufir create a new wallet
thufir wallet create

# Option B: Import an existing wallet (for advanced users)
thufir wallet import
```

When creating, you'll be prompted for a password. This password:
- Encrypts your private key at rest
- Is required every time you start live mode
- Should be strong and unique (16+ characters)

The wallet is saved to `~/.thufir/keystore.json` (encrypted).

## Step 2: Fund Your Wallet

1. Get your wallet address:
   ```bash
   thufir wallet status
   ```

2. Send funds to this address on **Polygon network**:
   - **USDC**: Start with $50-100 for testing
   - **MATIC**: ~$5 for gas fees

3. Verify the balance:
   ```bash
   thufir wallet status
   ```

## Step 3: Configure Spending Limits

Edit `~/.thufir/config.yaml`:

```yaml
wallet:
  keystorePath: ~/.thufir/keystore.json
  limits:
    daily: 100           # Max $100/day
    perTrade: 25         # Max $25 per trade
    confirmationThreshold: 10  # Confirm trades > $10
```

Or use CLI:
```bash
thufir wallet limits set --daily 100 --per-trade 25 --confirmation-threshold 10
thufir wallet limits show
```

## Step 4: Set Environment Variables

Add to your `.env` file or export:

```bash
# Required for live mode
export THUFIR_WALLET_PASSWORD="your-strong-password"

# Optional: Custom RPC (faster/more reliable)
export POLYGON_RPC_URL="https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
```

## Step 5: Enable Live Execution Mode

Edit `~/.thufir/config.yaml`:

```yaml
execution:
  mode: live  # Changed from 'paper'
```

## Step 6: Test the Setup

```bash
# 1. Verify wallet and connection
thufir wallet status

# 2. Test with paper mode first (change mode back to 'paper')
thufir trade buy "Some Market" YES --amount 5

# 3. When ready, switch to live mode and test small
thufir trade buy "Some Market" YES --amount 1
```

## Polymarket API Details

### Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `https://gamma-api.polymarket.com` | Market data, prices, outcomes |
| `https://clob.polymarket.com` | Order submission (CLOB = Central Limit Order Book) |

### Authentication

Thufir handles authentication automatically:

1. **First trade**: Derives API credentials from your wallet signature
2. **Subsequent trades**: Uses cached credentials
3. **Credentials expire**: Auto-renewed when needed

You don't need to manually create API keys on Polymarket.

### Order Flow

```
1. Thufir decides to trade (autonomous or manual)
         │
         ▼
2. Spending limits checked (daily, per-trade)
         │
         ▼
3. Address whitelist verified (Polymarket contracts only)
         │
         ▼
4. Order built using EIP-712 typed data signing
         │
         ▼
5. Order signed with your wallet's private key
         │
         ▼
6. Signed order submitted to CLOB API
         │
         ▼
7. Polymarket matches order on-chain
         │
         ▼
8. Position recorded in Thufir memory
```

## Execution Modes Comparison

| Mode | Description | Use Case |
|------|-------------|----------|
| `paper` | Simulated trades, no real money | Testing, practice, calibration tracking |
| `webhook` | Forwards decisions to external URL | Custom execution, external signing service |
| `live` | Real trades on Polymarket | Production trading |

## Security Architecture

### Whitelisted Addresses

Thufir can **only** interact with these addresses (hardcoded):

```
0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E  # CTF Exchange
0xC5d563A36AE78145C45a50134d48A1215220f80a  # Neg Risk CTF Exchange
0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296  # Neg Risk Adapter
0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174  # USDC (Polygon)
```

Any transaction to other addresses is **blocked**.

### Defense Layers

1. **Spending Limits**: Daily and per-trade caps
2. **Address Whitelist**: Only Polymarket contracts
3. **Encrypted Keystore**: AES-256-GCM encryption
4. **Password Protection**: Required for decryption

See [WALLET_SECURITY.md](./WALLET_SECURITY.md) for full details.

## Troubleshooting

### "Wallet not found"

```bash
# Check keystore exists
ls -la ~/.thufir/keystore.json

# Create if missing
thufir wallet create
```

### "Invalid password"

The password you entered doesn't match. Try again or recreate the wallet.

### "Insufficient USDC balance"

Fund your wallet with more USDC on Polygon.

### "Daily limit exceeded"

Wait for the next day (UTC reset) or increase limits in config.

### "CLOB error: Unauthorized"

API credentials expired. Thufir will auto-renew on next trade.

### "Transaction failed"

Check:
1. Sufficient MATIC for gas
2. Market is still active
3. Price hasn't moved significantly

## Recommended Settings

### Conservative (Beginners)

```yaml
wallet:
  limits:
    daily: 50
    perTrade: 10
    confirmationThreshold: 5

autonomy:
  fullAuto: false  # Manual confirmation required
```

### Moderate

```yaml
wallet:
  limits:
    daily: 100
    perTrade: 25
    confirmationThreshold: 10

autonomy:
  fullAuto: true
  minEdge: 0.08  # Only trade with 8%+ edge
  pauseOnLossStreak: 3
```

### Aggressive (Experienced)

```yaml
wallet:
  limits:
    daily: 500
    perTrade: 100
    confirmationThreshold: 50

autonomy:
  fullAuto: true
  minEdge: 0.05
  maxTradesPerScan: 5
```

## Next Steps

1. Start in **paper mode** to test your setup
2. Run for a few days to verify calibration
3. Switch to **live mode** with small amounts
4. Gradually increase limits as you gain confidence

See also:
- [WALLET_SECURITY.md](./WALLET_SECURITY.md) - Security details
- [README.md](../README.md) - Full documentation
