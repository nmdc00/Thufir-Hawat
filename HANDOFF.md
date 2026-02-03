# Handoff Document

This document provides everything needed to continue development on Thufir.

## Latest Session (2026-02-02, Session 15)

### What Was Done
1. **Autonomous NL trigger**
   - Natural-language requests like "find good bets" or "start trading" now trigger `/scan` when full auto is enabled.
   - If full auto is disabled, the bot responds with how to enable it.

2. **Mentat scan fixes**
   - Fragility score aggregation now uses average detector score (no zeroing out).
   - Mentat scan/report warns when intelCount is 0.

3. **LLM fallback diagnostics**
   - Fallback logs now show when suppression happens and why.
   - Non-critical fallback enabled by default (config flag).

---

## Prior Session (2026-02-01, Session 14)

### What Was Done
1. **Build fixes after agentic/mentat changes**
   - Decision audit accepts structured critic issues payloads
   - Anthropic client stores config for identity prelude injection
   - CLI imports corrected for trivial-task client usage
   - Conversation info LLM null-guarded in planner digest
   - Agent router merges nested agent overrides (trivial + llmBudget)

### Status
- `pnpm build` should now pass for the TypeScript errors listed in the cloud logs.

---

## Prior Session (2026-02-01, Session 13)

### What Was Done
1. **Agentic UX + persistence**
   - Added plan persistence + resume (session store + orchestrator resume)
   - Added CLI `thufir agent run` with tool/plan/critic/fragility traces
   - Tool-first guardrails for non-orchestrator chat (tool snapshot)

2. **Mentat monitoring upgrades**
   - System map persistence + report inclusion
   - Multi-timescale mentat schedules (gateway)

3. **LLM infra enforcement**
   - Execution contexts for non-chat/background LLM calls
   - Identity prelude enforced across Anthropic/OpenAI + internal/trivial paths

4. **Augur positions**
   - Portfolio tool uses Augur trade history in live mode

### What's Ready to Use
- `thufir agent run "<goal>"` with `--show-tools/--show-plan/--show-critic/--show-fragility`
- Mentat schedules via `notifications.mentat.schedules` in config
- Live-mode portfolio now surfaces CLOB positions (when wallet configured)

---

## Prior Session (2026-01-27, Session 7)

### What Was Done
1. **Augur AMM execution adapter**
   - Market metadata resolution via subgraph
   - Live executor routes trades through AMM interactions
   - CLI commands: `thufir markets tokens`, `thufir markets augur-status`

2. **LLM orchestration pipeline**
   - Claude plans, OpenAI executes trade decisions
   - OpenAI fallback on Anthropic rate limits
   - Context compression (info digest) for token efficiency

3. **Multi-agent routing + partial isolation**
   - Per-agent routing in gateway
   - Per-agent chat transcripts/summaries (shared DB/ledger/intel)
   - Tests added for session isolation

### What's Ready to Use
- Conversational chat (just type naturally)
- Persistent memory with auto-compaction
- Semantic memory recall
- `/top10` - daily opportunities
- `/fullauto on` - enable autonomous trading
- `/status` - see P&L and status
- Daily reports pushed to channels
- NewsAPI/Google News/Twitter intel
- Conversational intel alert setup + preview
- Paper trading works, live trading uses Augur adapter
- Portfolio positions + cash balance tracking (CLI `thufir portfolio --set-cash`)
- Trade ledger + realized PnL (FIFO) + market cache sync
- Proactive search loop (Clawdbot-style, local) + CLI `thufir intel proactive`
- Clawdbot-style session routing (session keys per channel)
- Research planner + prediction explanations (`thufir predictions explain`)
- Exposure limits enforced (per-market + per-domain)
- Ledger vs on-chain balance reconciliation (`thufir portfolio --reconcile`)
- Daily PnL rollups (`thufir pnl`)
- Market data live subscriptions (watchlist-only + staleness fallback)
- Intel source registry + roaming controls (trust thresholds, social opt-in)
- Env setup + validation CLI (`thufir env init`, `thufir env check`) + `.env.example`
- Live trading adapter (Augur AMM) implemented; needs a live test trade
- **QMD Knowledge Base** - Local hybrid search (BM25 + vector + LLM reranking)
  - Auto-indexes web search/fetch results
  - Mentat storage: assumptions, fragility cards
  - Orchestrator memory-first integration
  - Periodic embedding updates (hourly by default)

### Immediate Next Steps
1. Execute a $1 live trade via CLOB (verify end-to-end)
2. Decide on Clawdbot fork scope (skills/plugin lifecycle vs lightweight gateway)

---

## Quick Links

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Project overview and quick start |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical architecture and data flows |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phased implementation roadmap |
| [docs/WALLET_SECURITY.md](docs/WALLET_SECURITY.md) | Critical wallet security design |
| [docs/INTEL_SOURCES.md](docs/INTEL_SOURCES.md) | Intelligence source configuration |
| [docs/CALIBRATION.md](docs/CALIBRATION.md) | Prediction calibration system |

## What Is Thufir?

Thufir is a **prediction market AI companion** - an AI assistant that helps you make better predictions on Augur. Unlike pure trading bots that optimize for speed/arbitrage, Thufir:

1. **Learns your interests** and curates relevant intel
2. **Tracks calibration** - how accurate your predictions actually are
3. **Discusses reasoning** before executing trades
4. **Builds institutional memory** of what worked and why

## Key Design Decisions

### 1. Built on Clawdbot

Clawdbot provides battle-tested infrastructure for:
- Multi-channel messaging (WhatsApp, Telegram, Discord, Slack)
- Session management
- Gateway architecture
- Skills system

We fork Clawdbot rather than building from scratch.

### 2. Security-First Wallet

The wallet is the most critical component. Design principles:
- **Address whitelist is hardcoded** - only Augur contracts allowed
- **Spending limits enforced at app layer** - daily and per-trade limits
- **Key encrypted at rest** - AES-256-GCM with Argon2 key derivation
- **Hot wallet only** - never store more than you can afford to lose

### 3. Calibration as Core Feature

The calibration system is what makes Thufir valuable over time:
- Every prediction is recorded with reasoning
- Outcomes are tracked when markets resolve
- Brier scores calculated per domain
- Confidence adjustments applied to future predictions

### 4. Modular Intel Sources

Intel sources are pluggable:
- Start with RSS (free)
- Add NewsAPI, Twitter as needed
- Custom webhooks for specialized sources
- All feed into unified vector store

## Where to Start

### If You're a Solo Developer

1. **Week 1-2:** Fork Clawdbot, set up wallet security layer
2. **Week 3-4:** Integrate Augur API (read + execute)
3. **Week 5-6:** Build prediction recording + calibration
4. **Week 7-8:** Add RSS intel source + basic retrieval
5. **Week 9-10:** LLM integration for market analysis
6. **Week 11-12:** Telegram channel + daily briefings

### If You're a Team

Run phases in parallel:
- **Backend lead:** Wallet, Augur, execution
- **ML engineer:** Intel pipeline, embeddings, prompts
- **Full-stack:** Channels, CLI, formatting

## Critical Path Items

These must be done first and done right:

### 1. Wallet Whitelist (Day 1)

```typescript
// src/execution/wallet/whitelist.ts
// HARDCODE these addresses - do not make configurable

export const AUGUR_WHITELIST = Object.freeze([
  '0x79c3cf0553b6852890e8ba58878a5bca8b06d90c', // Augur Turbo AMM Factory
  '0x03810440953e2bcd2f17a63706a4c8325e0abf94', // MLB Market Factory
  '0xe696b8fa35e487c3a02c2444777c7a2ef6cd0297', // NBA Market Factory
  '0x1f3ef7ca2b2ca07a397e7bc1beb8c3cffc57e95a', // NFL Market Factory
  '0x6d2e53d53aec521dec3d53c533e6c6e60444c655', // MMA Market Factory
  '0x48725bac1c27c2daf5ed7df22d6a9d781053fec1', // Crypto Market Factory
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC
]);

export function isWhitelisted(address: string): boolean {
  return AUGUR_WHITELIST.includes(address.toLowerCase());
}
```

### 2. Spending Limits (Day 2)

Must be enforced before ANY transaction signing.

### 3. Test Coverage (Ongoing)

Security-critical code needs 100% test coverage:
- Whitelist enforcement
- Spending limit enforcement
- Key never logged/exposed

## Dependencies

### From Clawdbot
- Gateway WebSocket server
- Channel adapters (Telegram, WhatsApp, Discord, Slack)
- Session management
- Cron scheduler
- CLI framework

### New Dependencies
```json
{
  "ethers": "^5.7.0",
  "chromadb": "^1.5.0",
  "@xenova/transformers": "^2.15.0",
  "better-sqlite3": "^9.4.0"
}
```

## Configuration

### Minimal Config (Development)

```yaml
# config/thufir.yaml
gateway:
  port: 18789

agent:
  model: claude-sonnet-4-5-20251101
  workspace: ~/thufir

wallet:
  limits:
    daily: 50
    perTrade: 10
    confirmationThreshold: 5

intel:
  sources:
    rss:
      enabled: true
      feeds:
        - url: https://fivethirtyeight.com/feed/
          category: politics

augur:
  enabled: true
```

### Production Config

See `config/production.yaml.example` for full configuration.

## API Keys Needed

| Service | Required | Cost | Purpose |
|---------|----------|------|---------|
| Anthropic | Yes | ~$20/mo | LLM reasoning |
| Polygon RPC | Yes | Free tier | Blockchain access |
| NewsAPI | No | Free-$449/mo | News aggregation |
| Twitter | No | $100/mo | Social sentiment |
| SerpAPI | No | $50/mo | Google News |
| Gemini API | No | Free tier | Embeddings (Google) |

## File Structure

```
Thufir/
├── README.md                 # Project overview
├── HANDOFF.md               # This document
├── package.json             # Dependencies
├── tsconfig.json            # TypeScript config
├── config/
│   ├── default.yaml         # Default config
│   └── production.yaml.example
├── docs/
│   ├── ARCHITECTURE.md      # System design
│   ├── IMPLEMENTATION_PLAN.md # Build roadmap
│   ├── WALLET_SECURITY.md   # Security design
│   ├── INTEL_SOURCES.md     # Intel configuration
│   └── CALIBRATION.md       # Calibration system
├── src/
│   ├── core/                # Agent logic
│   ├── intel/               # Intel aggregation
│   ├── memory/              # Persistence
│   ├── execution/           # Trading
│   └── interface/           # User interface
├── scripts/
│   ├── setup.sh             # Initial setup
│   └── migrate.sh           # DB migrations
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

## Commands to Implement

### Phase 1 (Foundation)
```bash
thufir wallet create          # Create new wallet
thufir wallet import          # Import existing wallet
thufir wallet status          # Show balance and address
thufir wallet limits set      # Configure spending limits
thufir wallet limits show     # Show current limits
```

### Phase 2 (Markets)
```bash
thufir markets list           # List active markets
thufir markets show <id>      # Show market details
thufir markets watch <id>     # Add to watchlist
thufir trade buy <market> <outcome> <price> --amount <usd>
thufir trade sell <market> <outcome> <price> --amount <usd>
thufir portfolio              # Show positions and P&L
```

### Phase 3 (Predictions)
```bash
thufir predict <market>       # Analyze and record prediction
thufir predictions list       # List recent predictions
thufir predictions show <id>  # Show prediction details
thufir calibration show       # Show calibration stats
thufir calibration history    # Show prediction outcomes
```

### Phase 4 (Intel)
```bash
thufir intel status           # Show source status
thufir intel add <source>     # Add intel source
thufir intel search <query>   # Search intel
thufir intel recent           # Show recent intel
```

### Phase 5 (Agent)
```bash
thufir chat                   # Interactive chat
thufir briefing               # Generate daily briefing
thufir analyze <market>       # Deep market analysis
```

## Testing Strategy

### Unit Tests (Mandatory)
- `whitelist.test.ts` - Address whitelist enforcement
- `limits.test.ts` - Spending limit enforcement
- `keystore.test.ts` - Key encryption/decryption
- `calibration.test.ts` - Brier score calculation

### Integration Tests
- `intel-pipeline.test.ts` - Source → vector store

### E2E Tests
- `trade-flow.test.ts` - Full trade execution
- `prediction-flow.test.ts` - Predict → resolve → calibrate

## Known Challenges

### 1. API Rate Limits
- NewsAPI: 100 req/day free tier
- Twitter: 500K tweets/month free tier

### 3. LLM Costs
Claude Opus is expensive for heavy use. Strategies:
- Use Haiku for simple tasks
- Cache frequent queries
- Batch market analysis

### 4. Market Resolution Timing
Markets can take hours/days to resolve. Need:
- Cron job to check resolutions
- Handle partial resolutions
- Deal with voided markets

## Questions for Product Decisions

These need answers before building:

1. **Autonomy levels** - How autonomous should Thufir be by default?
   - Manual (requires confirmation for all trades)
   - Semi-auto (auto-execute small trades, confirm large)
   - Full auto (dangerous, not recommended)

2. **Default position sizing** - What fraction of Kelly criterion?
   - Conservative: 1/4 Kelly (recommended)
   - Moderate: 1/2 Kelly
   - Aggressive: Full Kelly (risky)

3. **Briefing frequency** - Daily? Twice daily? On-demand only?

4. **Alert thresholds** - When to alert about high-relevance intel?

## Resources

### Clawdbot
- [Clawdbot Repo](https://github.com/clawdbot/clawdbot)
- [Clawdbot Docs](https://docs.clawd.bot)

### Calibration
- [Brier Score](https://en.wikipedia.org/wiki/Brier_score)
- [Calibration Curves](https://scikit-learn.org/stable/modules/calibration.html)
- [Superforecasting](https://www.amazon.com/Superforecasting-Science-Prediction-Philip-Tetlock/dp/0804136718) (book)

## Contact

If you have questions about this design, the key architectural decisions are documented in:
- `docs/ARCHITECTURE.md` - System design rationale
- `docs/WALLET_SECURITY.md` - Security design rationale

---

**Good luck building Thufir!**

The hardest part is getting the wallet security right. After that, it's mostly plumbing and polish.
