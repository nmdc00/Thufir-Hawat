# Thufir - Prediction Market AI Companion

**Thufir** (from Arabic بيجاز, meaning "concise oracle") is a personal AI assistant specialized in prediction markets. Unlike pure trading bots that optimize for speed and arbitrage, Thufir is a **prediction companion** that learns your interests, curates intel, discusses reasoning, and executes trades on your behalf — **fully autonomous by default**.

Built on top of [Clawdbot](https://github.com/clawdbot/clawdbot)'s multi-channel architecture and [Polymarket Agents](https://github.com/Polymarket/agents)' execution framework.

## Why Thufir?

| Existing Prediction Bots | Thufir |
|--------------------------|-------|
| Autonomous execution | Conversational + collaborative |
| No memory | Learns your interests & tracks calibration |
| Reacts to news | Proactively curates intel |
| Black box decisions | Explains reasoning + uncertainty |
| Speed-optimized | Insight-optimized |

## Core Features

### 1. Persistent Prediction Memory
- Tracks every prediction, the reasoning behind it, and the outcome
- Learns from wins and losses over time
- Remembers your domain expertise and biases

### 2. Calibration Tracking
- Brier score tracking per domain (politics, sports, crypto, etc.)
- Confidence calibration ("You're overconfident on crypto, underconfident on politics")
- Historical accuracy visualization

### 3. Multi-Channel Interface
- WhatsApp + Telegram (gateway)
- CLI for power users
- Daily briefings and alerts

### 4. Intel Aggregation
- News APIs (NewsAPI, Google News, etc.)
- Twitter/X firehose for real-time sentiment
- RSS feeds for niche sources
- Custom source integration

### 5. Autonomous Trading (Default)
- Scans markets and executes trades without manual approval
- Configurable budgets + limits
- Optional webhook execution for external signing

### 6. Configurable LLM Providers
- Anthropic, OpenAI, or local OpenAI-compatible servers
- Primary + fallback model support

### 7. Crypto Wallet Integration
- Secure wallet management for Polymarket trades
- Portfolio tracking and P&L reporting
- Risk limits and exposure controls

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     INTERFACE LAYER                         │
│   WhatsApp │ Telegram │ Discord │ Slack │ CLI │ WebChat    │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                     GATEWAY (Clawdbot)                      │
│          Sessions │ Routing │ Auth │ Cron │ Skills          │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                      AGENT CORE                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │   LLM       │  │  Prediction  │  │   Calibration     │   │
│  │  Reasoning  │  │   Engine     │  │   Tracker         │   │
│  └─────────────┘  └──────────────┘  └───────────────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
┌───────▼───────┐ ┌───────▼───────┐ ┌───────▼───────┐
│  INTEL LAYER  │ │ MEMORY LAYER  │ │EXECUTION LAYER│
│  ─────────────│ │ ──────────────│ │ ──────────────│
│ • News APIs   │ │ • Predictions │ │ • Polymarket  │
│ • Twitter/X   │ │ • Outcomes    │ │ • Wallet Mgmt │
│ • RSS Feeds   │ │ • Reasoning   │ │ • Portfolio   │
│ • Vector DB   │ │ • Calibration │ │ • Risk Limits │
└───────────────┘ └───────────────┘ └───────────────┘
```

## Quick Start

### Prerequisites

- Node.js >= 22
- Python >= 3.11
- Polygon wallet with USDC
- API keys: Anthropic/OpenAI, NewsAPI (optional)

## Install Guides

### Option A: Mac mini (local, quiet, always-on)

1. Install Node.js 22+ and pnpm.
2. Clone and install:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Thufir.git
   cd Thufir
   pnpm install
   ```
3. Copy config:
   ```bash
   cp config/default.yaml ~/.thufir/config.yaml
   ```
4. Set API keys:
   ```bash
   export ANTHROPIC_API_KEY="..."
   export OPENAI_API_KEY="..."   # if using openai provider
   ```
5. Start the gateway:
   ```bash
   pnpm thufir gateway
   ```

### Option B: Low-cost cloud server (public webhook + 24/7 uptime)

If you need WhatsApp Cloud API webhooks, you must run on a public server with HTTPS.
Telegram can run anywhere (polling).

**Budget-friendly options** (examples; check current pricing/regions):
- DigitalOcean Basic Droplets starting at $4–$6/month.
- Vultr Cloud Compute from $2.50–$5/month.
- Oracle Cloud Always Free includes Ampere A1 compute (3,000 OCPU hours + 18,000 GB hours/month = up to 4 OCPU + 24 GB RAM).
- Google Cloud Free Tier includes one e2-micro VM in select US regions.
- Hetzner Cloud low-cost shared plans in EU/Singapore (prices vary by plan/region).

**Cloud steps (Ubuntu example)**
1. Provision a small Ubuntu VM (1–2 GB RAM is fine to start).
2. Install Node.js 22+ and pnpm.
3. Clone and install:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Thufir.git
   cd Thufir
   pnpm install
   ```
4. Copy config and set secrets as env vars.
5. Run gateway under a process manager (systemd, pm2, or a container).
6. Point WhatsApp Cloud API webhook to `https://YOUR_DOMAIN/whatsapp/webhook`.

### Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/Thufir.git
cd Thufir

# Install dependencies
pnpm install

# Run onboarding wizard
pnpm thufir onboard

# Start the gateway
pnpm thufir gateway --port 18789
```

### Configuration

Copy `config/default.yaml` to `~/.thufir/config.yaml` and edit.

#### LLM Providers
```yaml
agent:
  provider: anthropic    # anthropic | openai | local
  model: claude-sonnet-4-5-20251101
  fallbackModel: claude-3-5-haiku-20241022
  apiBaseUrl: https://api.openai.com  # for openai/local
```

#### Execution Modes
```yaml
execution:
  mode: paper            # paper | webhook | live
  webhookUrl: ""         # required for webhook mode
```

**Mode descriptions:**
- `paper` (default): Simulates trades without real execution. Tracks positions and P&L for practice/testing.
- `webhook`: Sends trade decisions to an external URL for execution (useful for external signing services).
- `live`: Executes real trades on Polymarket via the CLOB API. Requires wallet setup and `THUFIR_WALLET_PASSWORD` environment variable.

**Live mode setup:**
```bash
# 1. Create or import a wallet
thufir wallet create
# or
thufir wallet import

# 2. Set your wallet password as environment variable
export THUFIR_WALLET_PASSWORD="your-secure-password"

# 3. Update config to use live mode
# In config.yaml:
# execution:
#   mode: live

# 4. Start the gateway
pnpm thufir gateway
```

**Security note:** Live mode connects to real markets with real funds. Always:
- Use a dedicated hot wallet with limited funds
- Set conservative spending limits
- Test thoroughly in paper mode first
- See [Wallet Security Guide](docs/WALLET_SECURITY.md) for details

#### Wallet
```yaml
wallet:
  keystorePath: ~/.thufir/keystore.json
  limits:
    daily: 100
    perTrade: 25
    confirmationThreshold: 10
```

#### Memory & Embeddings
```yaml
memory:
  sessionsPath: ~/.thufir/sessions
  maxHistoryMessages: 50
  compactAfterTokens: 12000
  keepRecentMessages: 12
  retentionDays: 90
  embeddings:
    enabled: true
    provider: openai     # openai | google
    model: text-embedding-3-small
    apiBaseUrl: https://api.openai.com
```

#### Intel & Semantic Search
```yaml
intel:
  embeddings:
    enabled: true
    provider: openai     # openai | google
    model: text-embedding-3-small
    apiBaseUrl: https://api.openai.com
  retentionDays: 30
  roaming:
    enabled: true
    allowSources: []     # optional allowlist of source names
    allowTypes: []       # optional allowlist of types: news|social|market
    minTrust: medium
    socialOptIn: false   # must be true to include social sources in proactive search
```

#### Autonomy
```yaml
autonomy:
  enabled: true
  scanIntervalSeconds: 900
  maxMarketsPerScan: 10
  watchlistOnly: true
  eventDriven: false
  eventDrivenMinItems: 1
```

#### Daily Briefing Scheduler
```yaml
notifications:
  briefing:
    enabled: true
    time: "08:00"
    channels:
      - telegram
      - whatsapp
  dailyReport:
    enabled: true
    channels:
      - telegram
  resolver:
    enabled: true
    time: "02:00"
    limit: 50
  intelFetch:
    enabled: true
    time: "06:00"
  intelAlerts:
    enabled: true
    channels:
      - telegram
    watchlistOnly: true
    maxItems: 10
    includeSources: []
    excludeSources: []
    includeKeywords: []
    excludeKeywords: []
    minKeywordOverlap: 1
    minTitleLength: 8
    minSentiment:
    maxSentiment:
    sentimentPreset: any
    includeEntities: []
    excludeEntities: []
    minEntityOverlap: 1
    useContent: true
    minScore: 0
    keywordWeight: 1
    entityWeight: 1
    sentimentWeight: 1
    positiveSentimentThreshold: 0.05
    negativeSentimentThreshold: -0.05
    showScore: false
    showReasons: false
    entityAliases: {}
```

#### Channels
```yaml
channels:
  telegram:
    enabled: true
    token: "TELEGRAM_BOT_TOKEN"
    allowedChatIds: ["123456789"]
  whatsapp:
    enabled: true
    verifyToken: "WHATSAPP_VERIFY_TOKEN"
    accessToken: "WHATSAPP_ACCESS_TOKEN"
    phoneNumberId: "WHATSAPP_PHONE_NUMBER_ID"
    allowedNumbers: ["15551234567"]
```

```bash
# Set up your wallet (NEVER share your private key)
thufir wallet setup

# Create a .env file and validate API keys
thufir env init
thufir env check

# Configure prediction markets
thufir markets connect polymarket

# Set up intel sources
thufir intel add newsapi --key YOUR_KEY
thufir intel add twitter --bearer YOUR_BEARER

# Configure channels
thufir channel add telegram --token YOUR_BOT_TOKEN
```

### Usage

```bash
# Start the gateway (Telegram polling + WhatsApp webhook)
pnpm thufir gateway

# Chat with Thufir via CLI
thufir chat "What's your take on the French election market?"

# Get daily briefing
thufir briefing

# View your calibration stats
thufir calibration show

# View portfolio
thufir portfolio
# Set or adjust cash balance
thufir portfolio --set-cash 1000
thufir portfolio --add-cash 250
thufir portfolio --withdraw-cash 100
# Reconcile ledger cash vs on-chain USDC
thufir portfolio --reconcile

# Sync market cache (improves portfolio pricing)
thufir markets sync --limit 200

# Manual trade
thufir trade buy "French Election - Le Pen" YES 0.35 --amount 50
```

### Cloud Install (Hetzner / Ubuntu)

Use the installer script to set up Node 22, install dependencies, generate config + .env,
and register a systemd service that keeps Thufir running.

```bash
bash scripts/install_hetzner.sh
```

### Wallet (CLI)
```bash
thufir wallet create
thufir wallet import
thufir wallet status
```

### User Profile (CLI)
```bash
thufir user show <id>
thufir user set <id> --domains politics,crypto --risk moderate --pref timezone=EST
```

### Intel (CLI)
```bash
thufir intel status
thufir intel recent --limit 20
thufir intel alerts --limit 50
thufir intel proactive --max-queries 8
```

### Predictions (CLI)
```bash
thufir predictions add --market-id m1 --title "Example" --outcome YES --prob 0.6
thufir predictions list
thufir predictions show <id>
thufir predictions explain <id>
thufir predictions resolve
```

### PnL (CLI)
```bash
thufir pnl
thufir pnl --date 2026-01-26
```

### Memory (CLI)
```bash
thufir memory sessions
thufir memory show <userId> -l 50
thufir memory compact <userId>
thufir memory prune --days 90
```

### Telegram/WhatsApp Commands

**Conversation (NEW):**
- Just type naturally to chat about events, markets, or predictions
- Persistent memory with auto-compaction and semantic recall
- `/ask <topic>` - Ask about a topic and find relevant markets
- `/analyze <marketId>` - Deep LLM analysis of a specific market
- `/analyze-json <marketId>` - Structured analysis (JSON)
- `/explain <predictionId>` - Explain a prediction decision
- `/markets <query>` - Search for prediction markets
- `/clear` - Clear conversation history
- `/alerts` - Start intel alert setup
- `/help` - Show all commands

**Trading:**
- `/watch <marketId>` - Add market to watchlist
- `/watchlist` - List watched markets
- `/scan` - Run immediate autonomous scan
- `/trade <marketId> <YES|NO> <amount>` - Manual trade

**Info:**
- `/intel` - Fetch RSS intel now
- `/briefing` - Show latest intel briefing
- `/resolve` - Update prediction outcomes
- `/profile` - Show stored user profile
- `/setpref key=value` - Update preference (e.g., `risk=moderate`, `domains=politics,crypto`)

## Conversation Examples

### Free-Form Chat (NEW)

**You:** "What do you think about AI causing mass unemployment?"

**Thufir:** "This is one of the most debated questions in forecasting. Let me break it down:

**My probability estimate:** 25-35% chance of >10% unemployment directly attributable to AI by 2030.

**Key factors:**
- Historical technology transitions created more jobs than they destroyed (but AI may be different)
- Current AI is narrow - good at specific tasks, not general work replacement
- Labor markets are more adaptive than pessimists expect

**Relevant markets I found:**
- "AI causes >5% US unemployment by 2028" - Trading at 18% YES
- "Major AI job displacement legislation by 2027" - Trading at 34% YES

**What would change my mind:**
- AGI breakthrough (would increase my estimate significantly)
- Evidence of rapid white-collar job losses in 2026

Want me to dig deeper into any aspect?"

---

### Market Analysis

**You:** "What markets look interesting today?"

**Thufir:** "Based on recent news and current prices, here are 3 markets where I see edge:

1. **Fed Rate Decision (Mar 2026)** - 72% YES (hold)
   - My estimate: 65% | Edge: -7%
   - Dovish Fed comments yesterday suggest more flexibility

2. **Tesla Q1 Deliveries > 500k** - 38% YES
   - My estimate: 48% | Edge: +10%
   - Shanghai at 95% capacity, strong demand signals

3. **France Election - Le Pen** - 41% YES
   - My estimate: 38% | Edge: -3%
   - Recent polling slightly weaker

Your calibration note: You're 71% accurate on Fed predictions but only 52% on politics. Consider that when sizing."

---

### Trading

**You:** "Buy $50 on Tesla deliveries"

**Thufir:** "Executing: BUY $50 on 'Tesla Q1 Deliveries > 500k' at YES 0.38

**Reasoning:**
- Q4 2025 beat by 8%
- Shanghai factory at 95% capacity
- Model refresh driving demand

**Risk check:** ✓ Under daily limit | ✓ Under per-trade limit

Trade executed (paper mode). Position recorded for calibration tracking."

## Project Structure

```
Thufir/
├── src/
│   ├── core/           # Agent logic, LLM integration
│   ├── intel/          # News aggregation, vectorization
│   ├── memory/         # Prediction storage, calibration
│   ├── execution/      # Polymarket integration, wallet
│   └── interface/      # Channel adapters, CLI
├── docs/
│   ├── ARCHITECTURE.md
│   ├── WALLET_SECURITY.md
│   ├── INTEL_SOURCES.md
│   └── CALIBRATION.md
├── scripts/
│   ├── setup.sh
│   └── migrate.sh
├── config/
│   └── default.yaml
└── tests/
```

## Security Considerations

### Wallet Security
- Private keys are encrypted at rest using AES-256
- Keys never leave the local machine
- Optional hardware wallet support (Ledger/Trezor)
- Spending limits enforced at the application layer
- **NEVER grant the bot withdrawal rights to external addresses**

### API Key Management
- All API keys stored in encrypted keychain
- Environment variable injection at runtime
- No keys in config files or logs

### Risk Controls
- Maximum position size limits
- Daily loss limits
- Portfolio concentration limits
- Cooldown periods after losses

## Roadmap

### Phase 1: Foundation (Current)
- [ ] Fork and adapt [Clawdbot](https://github.com/clawdbot/clawdbot) gateway for proactive search capabilities
- [x] Autonomous scan loop + paper/webhook execution
- [x] Build prediction memory schema
- [x] Basic CLI interface
- [x] Conversational chat (free-form discussion about events/markets)

### Phase 2: Intelligence
- [x] RSS feed integration
- [ ] News API integration (NewsAPI, Google News)
- [ ] Twitter/X sentiment analysis
- [ ] Vector DB for context retrieval (ChromaDB)
- [x] Daily briefing generation

### Phase 3: Calibration
- [x] Brier score tracking
- [x] Domain-specific accuracy
- [x] Confidence adjustment algorithms
- [ ] Historical analysis tools & visualizations

### Phase 4: Channels
- [x] Telegram integration
- [x] WhatsApp integration
- [ ] Discord bot
- [ ] Web dashboard

### Phase 5: Proactive Intelligence (PLANNED)
- [ ] **Daily Top 10 Trades**: Automatically scour Polymarket + news to find best opportunities
- [ ] **Event-Driven Alerts**: Monitor current events and alert when relevant markets have edge
- [ ] **Full Autonomous Mode**: Toggle on/off autonomous betting with daily P&L reports
- [ ] Clawdbot integration for proactive search and multi-step reasoning

### Phase 6: Advanced
- [ ] Multi-market correlation analysis
- [ ] Social graph analysis (who predicts well?)
- [ ] Custom model fine-tuning on prediction data
- [ ] Real on-chain trade execution

---

## Planned Feature: Proactive Daily Intelligence

### Daily Top 10 Trades Report
Thufir will automatically:
1. Fetch current events from news sources
2. Cross-reference with all active Polymarket markets
3. Use LLM to identify markets where news creates edge
4. Rank by expected value and confidence
5. Push daily report to configured channels

```
📊 Daily Top 10 Opportunities (Jan 26, 2026)

1. Fed Rate Decision March 2026
   Market: 72% YES (hold) | My estimate: 65% | Edge: -7%
   News: Dovish Fed comments yesterday
   Action: SHORT YES | Suggested: $25

2. Tesla Q1 Deliveries > 500k
   Market: 38% YES | My estimate: 48% | Edge: +10%
   News: Shanghai factory at 95% capacity
   Action: LONG YES | Suggested: $40

...
```

### Full Autonomous Mode (Toggle)
When enabled, Thufir will:
- Execute trades automatically based on detected edge
- Respect all spending limits and risk controls
- Send daily summary of trades executed and P&L
- Learn from outcomes to improve future decisions

```yaml
# config.yaml
autonomy:
  fullAuto: true           # Master toggle for autonomous betting
  dailyReportTime: "20:00" # Daily P&L report time
  minEdge: 0.05            # Minimum edge to trade (5%)
  requireHighConfidence: false
  pauseOnLossStreak: 3     # Pause after N consecutive losses
```

**Safety Controls:**
- Always respects daily/per-trade limits
- Whitelist-only addresses (Polymarket contracts)
- Auto-pause after configurable loss streak
- Manual override via `/pause` and `/resume` commands

## Contributing

This project is in early development. Contributions welcome!

1. Fork the repo
2. Create a feature branch
3. Submit a PR with clear description

## License

MIT License - See [LICENSE](LICENSE)

## Clawdbot Integration Plan

Thufir is designed to eventually fork [Clawdbot](https://github.com/clawdbot/clawdbot) for its:
- **Proactive search capabilities** - implemented locally, but Clawdbot offers a mature foundation
- **Multi-step reasoning** - Complex task decomposition
- **Session management** - Robust conversation state
- **Skills system** - Modular capabilities

Currently, Thufir uses a lightweight gateway with Clawdbot-style session routing plus per-agent session isolation.
The plan is to integrate more of Clawdbot's gateway core to enable:
1. Proactive news monitoring and market scanning
2. Multi-step research before making predictions
3. Learning from conversation patterns
4. More sophisticated autonomous reasoning

### Market Data Live Subscriptions
Thufir can optionally use a WebSocket feed to keep market prices fresh (watchlist-only by default). If you have a
market data WebSocket endpoint, configure:

```yaml
polymarket:
  stream:
    enabled: true
    wsUrl: "wss://your-stream-endpoint"
    watchlistOnly: true
    maxWatchlist: 50
    staleAfterSeconds: 180
    refreshIntervalSeconds: 300
```

### Proactive Search (Clawdbot-Style, Local)
Thufir now runs a Clawdbot-style proactive search loop locally. It generates queries from your watchlist
and recent intel, optionally refines them with the LLM, then runs the intel pipeline using those queries.

Config example:
```yaml
notifications:
  proactiveSearch:
    enabled: true
    time: "07:30"
    maxQueries: 8
    watchlistLimit: 20
    recentIntelLimit: 25
    useLlm: true
```

## Acknowledgments

- [Clawdbot](https://github.com/clawdbot/clawdbot) - Multi-channel AI assistant framework (planned integration)
- [Polymarket Agents](https://github.com/Polymarket/agents) - Prediction market trading framework
- The prediction market community

---

**Disclaimer:** This software is for educational and research purposes. Prediction market trading involves financial risk. Never trade more than you can afford to lose. Check local regulations before using prediction markets.
# Thufir
