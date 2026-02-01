# Wallet Security Guide

This document describes the security architecture for Thufir's crypto wallet integration.

## Overview

Thufir requires a Polygon wallet with USDC to execute trades on Polymarket. This is the most security-critical component of the system.

**Principle:** The wallet should be a "hot wallet" with limited funds, used exclusively for Polymarket trading. Never store more than you're willing to lose.

## Security Architecture

### Defense in Depth

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: Application Controls                              │
│  • Spending limits (daily, per-trade)                       │
│  • Confirmation requirements above threshold                │
│  • Cooldown periods after losses                            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: Address Whitelist                                 │
│  • Only Polymarket contract addresses allowed               │
│  • NO external transfers permitted                          │
│  • Whitelist is hardcoded, not configurable                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3: Key Isolation                                     │
│  • Private key encrypted at rest (AES-256-GCM)              │
│  • Key only decrypted in memory for signing                 │
│  • Memory cleared immediately after use                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 4: Encryption Key Management                         │
│  • Encryption key derived from user password (Argon2)       │
│  • Optional: System keychain integration                    │
│  • Optional: Hardware security module                       │
└─────────────────────────────────────────────────────────────┘
```

### What We Protect Against

| Threat | Mitigation |
|--------|------------|
| Malware stealing private key | Key encrypted at rest, memory cleared after use |
| Rogue code draining wallet | Address whitelist blocks external transfers |
| Runaway bot losing money | Spending limits and cooldowns |
| Social engineering attacks | Confirmation required for large trades |
| Physical access to machine | Password-protected keystore |

### What We Don't Protect Against

- Compromised password (use a strong, unique password)
- Sophisticated memory-reading malware (use dedicated machine if concerned)
- $5 wrench attack (physical coercion)
- Polymarket itself being compromised

## Implementation Details

### Key Storage

```typescript
interface KeyStore {
  // Encrypted private key (never stored plaintext)
  encryptedKey: string;

  // Salt for key derivation
  salt: string;

  // IV for AES encryption
  iv: string;

  // Address (public, not sensitive)
  address: string;

  // Version for migration
  version: number;
}
```

**Encryption Process:**

```
User Password
      │
      ▼
┌─────────────────┐
│    Argon2id     │  (memory-hard KDF)
│  ─────────────  │
│  memory: 64MB   │
│  iterations: 3  │
│  parallelism: 4 │
└────────┬────────┘
         │
         ▼
   Encryption Key (256-bit)
         │
         ▼
┌─────────────────┐
│   AES-256-GCM   │
│  ─────────────  │
│  + random IV    │
│  + private key  │
└────────┬────────┘
         │
         ▼
  Encrypted Private Key
  (stored in ~/.thufir/keystore.json)
```

### Address Whitelist

The address whitelist is **hardcoded** and cannot be modified by configuration:

```typescript
// src/execution/wallet/whitelist.ts

// These are the ONLY addresses the wallet can interact with
export const POLYMARKET_WHITELIST = Object.freeze([
  // Polymarket CTF Exchange (Polygon)
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',

  // Polymarket Neg Risk CTF Exchange
  '0xC5d563A36AE78145C45a50134d48A1215220f80a',

  // Polymarket Neg Risk Adapter
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',

  // USDC on Polygon (for approvals)
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
]);

// This function is called before ANY transaction
export function isWhitelisted(address: string): boolean {
  return POLYMARKET_WHITELIST.includes(address.toLowerCase());
}
```

**Critical:** If a transaction targets any address not in this list, it is **rejected unconditionally**.

### Spending Limits

```typescript
interface SpendingLimits {
  // Maximum spend per calendar day (UTC)
  dailyLimit: number;

  // Maximum spend per single trade
  perTradeLimit: number;

  // Trades above this amount require explicit confirmation
  confirmationThreshold: number;

  // Tracking
  todaySpent: number;
  lastResetDate: string;
}

class SpendingLimitEnforcer {
  async checkAndRecord(amount: number): Promise<LimitCheckResult> {
    // Reset daily counter if new day
    if (this.isNewDay()) {
      this.limits.todaySpent = 0;
      this.limits.lastResetDate = today();
    }

    // Check per-trade limit
    if (amount > this.limits.perTradeLimit) {
      return {
        allowed: false,
        reason: `Amount $${amount} exceeds per-trade limit of $${this.limits.perTradeLimit}`
      };
    }

    // Check daily limit
    if (this.limits.todaySpent + amount > this.limits.dailyLimit) {
      return {
        allowed: false,
        reason: `Would exceed daily limit. Spent today: $${this.limits.todaySpent}, Limit: $${this.limits.dailyLimit}`
      };
    }

    // Check if confirmation required
    if (amount > this.limits.confirmationThreshold) {
      return {
        allowed: true,
        requiresConfirmation: true,
        reason: `Amount $${amount} requires confirmation (threshold: $${this.limits.confirmationThreshold})`
      };
    }

    return { allowed: true, requiresConfirmation: false };
  }
}
```

### Loss Cooldown

After significant losses, trading is paused to prevent emotional/runaway trading:

```typescript
interface CooldownConfig {
  // Trigger cooldown if daily loss exceeds this percentage
  lossThresholdPercent: number;

  // How long to pause trading (seconds)
  cooldownDuration: number;
}

class CooldownEnforcer {
  async checkCooldown(): Promise<CooldownStatus> {
    const dailyPnL = await this.getDailyPnL();
    const portfolioValue = await this.getPortfolioValue();

    const lossPercent = (dailyPnL / portfolioValue) * -100;

    if (lossPercent > this.config.lossThresholdPercent) {
      const cooldownEnd = this.cooldownStartTime + this.config.cooldownDuration;
      const now = Date.now() / 1000;

      if (now < cooldownEnd) {
        return {
          inCooldown: true,
          reason: `Daily loss of ${lossPercent.toFixed(1)}% triggered cooldown`,
          remainingSeconds: cooldownEnd - now
        };
      }
    }

    return { inCooldown: false };
  }
}
```

## Live Execution Mode

When you set `execution.mode: live` in your config, Thufir will execute real trades on Polymarket using your wallet. This requires:

1. **Wallet Setup**: Create or import a wallet using `thufir wallet create` or `thufir wallet import`
2. **Password**: Set `THUFIR_WALLET_PASSWORD` environment variable with your keystore password
3. **USDC Balance**: Fund your wallet with USDC on Polygon
4. **MATIC for Gas**: Small amount of MATIC (~$5) for transaction fees

### How Live Execution Works

```
┌─────────────────────────────────────────────────────────────┐
│                    Trade Decision                           │
│  (from autonomous scan or manual command)                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  LiveExecutor checks:                                       │
│  1. Spending limits (daily & per-trade)                     │
│  2. Address whitelist (Polymarket contracts only)           │
│  3. Wallet balance                                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Order Signing:                                             │
│  • Wallet decrypted using THUFIR_WALLET_PASSWORD             │
│  • Order signed with EIP-712 typed data                     │
│  • Private key cleared from memory                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  CLOB API Submission:                                       │
│  • Signed order sent to Polymarket CLOB                     │
│  • API credentials derived from wallet signature            │
│  • Response logged and position recorded                    │
└─────────────────────────────────────────────────────────────┘
```

### Switching Execution Modes

```yaml
# Paper mode (default) - no real trades
execution:
  mode: paper

# Webhook mode - external execution
execution:
  mode: webhook
  webhookUrl: "https://your-service.com/execute"

# Live mode - real Polymarket trades
execution:
  mode: live
```

## Setup Guide

### 1. Create a Dedicated Wallet

**Do not use your main wallet.** Create a new wallet specifically for Thufir:

```bash
# Option 1: Let Thufir create one
thufir wallet create

# Option 2: Import existing (for advanced users)
thufir wallet import
```

### 2. Fund the Wallet

Transfer USDC on Polygon to your Thufir wallet. **Start small:**

- Initial testing: $50-100
- Normal operation: $200-500
- Maximum recommended: $1000

You also need a small amount of MATIC for gas (~$5 worth).

### 3. Configure Limits

```bash
# Set spending limits
thufir wallet limits set \
  --daily 100 \
  --per-trade 25 \
  --confirmation-threshold 10

# View current limits
thufir wallet limits show
```

### 4. Test the Setup

```bash
# Check wallet status
thufir wallet status

# Test a tiny trade ($1)
thufir trade buy "Some Market" YES 0.50 --amount 1 --dry-run

# Execute for real
thufir trade buy "Some Market" YES 0.50 --amount 1
```

## Operational Security

### Do's

- Use a strong, unique password for the keystore
- Keep your machine updated and secure
- Monitor your positions regularly
- Set conservative limits initially
- Use a dedicated machine if trading significant amounts
- Keep backups of your encrypted keystore

### Don'ts

- Don't store more than you can afford to lose
- Don't share your password
- Don't run Thufir on a shared/compromised machine
- Don't disable the address whitelist
- Don't increase limits without careful consideration
- Don't ignore the cooldown warnings

## Emergency Procedures

### Suspected Compromise

If you suspect your wallet or machine has been compromised:

1. **Immediately** transfer funds out using a different device
2. Stop the Thufir process
3. Investigate the compromise
4. Create a new wallet before resuming

```bash
# Emergency stop
thufir stop --force

# Transfer funds out (from another device/wallet app)
# Do NOT use Thufir for this - use MetaMask or similar
```

### Lost Password

If you lose your keystore password:

- **The encrypted key cannot be recovered**
- You'll need to create a new wallet
- Transfer any remaining funds from the old wallet (if you still have the seed phrase from initial creation)

### Backup and Recovery

```bash
# Export encrypted keystore (safe to backup)
thufir wallet export --output ./thufir-wallet-backup.json

# Import on new machine
thufir wallet import --input ./thufir-wallet-backup.json
```

The exported file is encrypted and requires your password to use.

## Future Enhancements

### Hardware Wallet Support (Planned)

For users with significant funds, hardware wallet integration is planned:

- Ledger Nano S/X support
- Transactions require physical button press
- Private key never leaves hardware device

### Multi-Signature (Considered)

For team/fund use cases:

- Require 2-of-3 signatures for trades
- Separate "proposer" and "approver" roles
- Time-locked transactions

## Audit Log

All wallet operations are logged (without sensitive data):

```
2026-01-26T10:00:00Z INFO  [wallet] Transaction signed: to=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E amount=25.00 USDC
2026-01-26T10:00:01Z INFO  [wallet] Transaction submitted: hash=0xabc123...
2026-01-26T10:00:05Z INFO  [wallet] Transaction confirmed: hash=0xabc123... block=12345678
2026-01-26T10:00:05Z INFO  [limits] Daily spend updated: $25.00 / $100.00
```

Logs are stored in `~/.thufir/logs/wallet.log` and rotated daily.
