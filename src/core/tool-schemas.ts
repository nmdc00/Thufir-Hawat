import type { Tool } from '@anthropic-ai/sdk/resources/messages';

export const THUFIR_TOOLS: Tool[] = [
  {
    name: 'intel_search',
    description:
      'Search the intel/news database for recent information about a topic.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for intel',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 5)',
        },
        from_days: {
          type: 'number',
          description: 'Only search within last N days (default: 14)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'intel_recent',
    description:
      'Get the most recent intel/news items. Use when user asks for updates.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of items (default: 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'proactive_search_run',
    description:
      'Run the iterative proactive web research loop now and store findings. Use when user asks for proactive scouting.',
    input_schema: {
      type: 'object',
      properties: {
        max_queries: {
          type: 'number',
          description: 'Maximum number of queries to run (default: 8)',
        },
        iterations: {
          type: 'number',
          description: 'Research rounds (default: 2, max: 3)',
        },
        watchlist_limit: {
          type: 'number',
          description: 'Watchlist seed limit (default: 20)',
        },
        use_llm: {
          type: 'boolean',
          description: 'Use LLM for query refinement/follow-up generation (default: true)',
        },
        recent_intel_limit: {
          type: 'number',
          description: 'Recent intel seed limit (default: 25)',
        },
        extra_queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional seed queries',
        },
        include_learned_queries: {
          type: 'boolean',
          description: 'Include learned high-signal query seeds (default: true)',
        },
        learned_query_limit: {
          type: 'number',
          description: 'Max learned query seeds to include (default: 8)',
        },
        web_limit_per_query: {
          type: 'number',
          description: 'Web results per query (default: 5)',
        },
        fetch_per_query: {
          type: 'number',
          description: 'Fetched pages per query (default: 1)',
        },
        fetch_max_chars: {
          type: 'number',
          description: 'Max chars kept per fetched page (default: 4000)',
        },
      },
      required: [],
    },
  },
  {
    name: 'calibration_stats',
    description:
      "Get the user's historical trade calibration stats (accuracy, track record).",
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Filter by domain (e.g., "macro", "crypto")',
        },
      },
      required: [],
    },
  },
  {
    name: 'current_time',
    description:
      'Get the current date and time. Use to understand temporal context for markets and news.',
    input_schema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'Timezone (default: UTC). Examples: "America/New_York", "Europe/London"',
        },
      },
      required: [],
    },
  },
  {
    name: 'system_exec',
    description:
      'Execute an allowed local command with explicit arguments. Controlled by agent.systemTools config.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command name (must be in allowlist, e.g., "node", "pnpm", "qmd")',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command arguments as a string array',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'system_install',
    description:
      'Install packages with an allowed package manager. Controlled by agent.systemTools config.',
    input_schema: {
      type: 'object',
      properties: {
        manager: {
          type: 'string',
          enum: ['pnpm', 'npm', 'bun'],
          description: 'Package manager to use',
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Package specs to install',
        },
        global: {
          type: 'boolean',
          description: 'Whether to install globally (must be allowed in config)',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory',
        },
      },
      required: ['manager', 'packages'],
    },
  },
  {
    name: 'get_wallet_info',
    description:
      'Get wallet address, chain, and token for funding. Use when asking where to deposit funds.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'twitter_search',
    description:
      'Search recent tweets via Twitter API. Use to find real-time discussion on a topic.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for Twitter (e.g., "Bitcoin price")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10, max: 50)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_portfolio',
    description:
      'Get current portfolio: positions, balances, P&L, and (if configured) perp positions. Use before trading to understand available capital and exposure.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_positions',
    description:
      'Get current Hyperliquid positions and account summary.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_open_orders',
    description:
      'Get currently open orders.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for information. Use for research, news, facts, or context not available in other tools.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "Fed interest rate decision January 2026")',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 5, max: 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch and extract content from a web page URL. Returns readable text/markdown.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch (must be http or https)',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default: 10000, max: 50000)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'evaluation_summary',
    description:
      'Get evaluation summary metrics (PnL, calibration, edge, domain performance).',
    input_schema: {
      type: 'object',
      properties: {
        window_days: {
          type: 'number',
          description: 'Window length in days for the report (omit for all-time).',
        },
        domain: {
          type: 'string',
          description: 'Optional domain filter (e.g., politics, crypto).',
        },
      },
      required: [],
    },
  },
  {
    name: 'qmd_query',
    description:
      'Search the local knowledge base using QMD hybrid search (BM25 + vector + LLM reranking). Use to recall past research, articles, and notes.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query or question to find in knowledge base',
        },
        mode: {
          type: 'string',
          enum: ['query', 'search', 'vsearch'],
          description: 'Search mode: query=hybrid (best quality), search=BM25 keyword, vsearch=semantic vector',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 10, max: 50)',
        },
        collection: {
          type: 'string',
          description: 'Specific collection to search (e.g., thufir-research, thufir-intel, thufir-markets)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'qmd_index',
    description:
      'Index content into the local knowledge base for future recall. Use to save important research, articles, or notes.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to index (markdown supported)',
        },
        title: {
          type: 'string',
          description: 'Title for the indexed content',
        },
        collection: {
          type: 'string',
          enum: ['thufir-research', 'thufir-intel', 'thufir-markets'],
          description: 'Collection to store in (default: thufir-research)',
        },
        source: {
          type: 'string',
          description: 'Source URL or reference for the content',
        },
      },
      required: ['content', 'title'],
    },
  },
  {
    name: 'mentat_store_assumption',
    description:
      'Store an assumption for the mentat fragility analysis system. Assumptions are beliefs that underpin positions and can be stress-tested.',
    input_schema: {
      type: 'object',
      properties: {
        statement: {
          type: 'string',
          description: 'The assumption statement (e.g., "Fed will not cut rates before March")',
        },
        system: {
          type: 'string',
          description: 'The system or domain this assumption relates to (e.g., "fed_policy", "crypto_markets")',
        },
        evidence_for: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evidence supporting this assumption',
        },
        evidence_against: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evidence contradicting this assumption',
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'Dependencies that this assumption relies on',
        },
        stress_score: {
          type: 'number',
          description: 'Stress score 0-1 (higher = more fragile)',
        },
        last_tested: {
          type: 'string',
          description: 'Last time this assumption was tested (ISO timestamp)',
        },
        criticality: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'How critical this assumption is to current positions',
        },
      },
      required: ['statement', 'system'],
    },
  },
  {
    name: 'mentat_store_fragility',
    description:
      'Store a fragility card identifying tail-risk exposure. Fragility cards track structural vulnerabilities, not event forecasts.',
    input_schema: {
      type: 'object',
      properties: {
        system: {
          type: 'string',
          description: 'The system being analyzed (e.g., "crypto_lending", "treasury_markets")',
        },
        mechanism: {
          type: 'string',
          description: 'The causal mechanism that could trigger fragility',
        },
        exposure_surface: {
          type: 'string',
          description: 'What is exposed to this fragility',
        },
        early_signals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Observable signals that would indicate increasing fragility',
        },
        falsifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Conditions that would invalidate this fragility assessment',
        },
        downside: {
          type: 'string',
          description: 'Potential downside if fragility materializes',
        },
        convexity: {
          type: 'string',
          description: 'Convexity profile (how nonlinear the downside is)',
        },
        recovery_capacity: {
          type: 'string',
          description: 'Ability of the system to recover once fragility is triggered',
        },
        score: {
          type: 'number',
          description: 'Fragility score 0-1 (leverage * coupling * illiquidity * consensus * irreversibility)',
        },
      },
      required: ['system', 'mechanism', 'exposure_surface'],
    },
  },
  {
    name: 'mentat_store_mechanism',
    description:
      'Store a causal mechanism for the mentat fragility analysis system.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Mechanism name (e.g., "stablecoin liquidity spiral")',
        },
        system: {
          type: 'string',
          description: 'System or domain this mechanism relates to',
        },
        causal_chain: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered causal chain describing how the mechanism unfolds',
        },
        trigger_class: {
          type: 'string',
          description: 'Trigger class (e.g., "liquidity shock", "policy shift")',
        },
        propagation_path: {
          type: 'array',
          items: { type: 'string' },
          description: 'Propagation path or affected subsystems',
        },
      },
      required: ['name', 'system'],
    },
  },
  {
    name: 'mentat_query',
    description:
      'Query the mentat knowledge base for assumptions, fragility cards, or mechanisms. Use to recall past analysis.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for mentat knowledge',
        },
        type: {
          type: 'string',
          enum: ['assumption', 'fragility', 'mechanism', 'all'],
          description: 'Type of mentat knowledge to search (default: all)',
        },
        system: {
          type: 'string',
          description: 'Filter by system/domain',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'perp_market_list',
    description: 'List perp markets for the configured exchange.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of markets (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'perp_market_get',
    description: 'Get details for a perp market by symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Perp symbol (e.g., BTC)',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'perp_place_order',
    description: 'Place a perp order on the configured exchange.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Perp symbol' },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'Order side' },
        size: { type: 'number', description: 'Order size' },
        order_type: { type: 'string', enum: ['market', 'limit'], description: 'Order type' },
        price: { type: 'number', description: 'Limit price (required for limit orders)' },
        leverage: { type: 'number', description: 'Leverage to apply' },
        reduce_only: { type: 'boolean', description: 'Reduce-only order' },
        reasoning: {
          type: 'string',
          description:
            'Optional trade rationale to store in the local journal (used for learning/audit).',
        },
      },
      required: ['symbol', 'side', 'size'],
    },
  },
  {
    name: 'perp_open_orders',
    description: 'List open perp orders for the configured exchange.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'perp_cancel_order',
    description: 'Cancel a perp order by id.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order id to cancel' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'perp_positions',
    description: 'Get open perp positions for the configured exchange.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'trade_management_open_envelopes',
    description: 'List open trade envelopes (perp trade management).',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum rows (default: 50)' },
      },
      required: [],
    },
  },
  {
    name: 'trade_management_recent_closes',
    description: 'List recent closed trades from the trade-management close records.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum rows (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'trade_management_summary',
    description: 'Return a trade journal summary (last N closed trades) for learning/context.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum closed trades to summarize (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'perp_analyze',
    description: 'Analyze a perp market and return directional probabilities, key risks, and signals.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Perp symbol (e.g., BTC, ETH)' },
        horizon: { type: 'string', description: 'Time horizon (e.g., "hours", "days", "weeks")' },
        probability_mode: {
          type: 'string',
          enum: ['conservative', 'balanced', 'aggressive'],
          description: 'Probability calibration mode (default: balanced)',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'agent_incidents_recent',
    description:
      'List recent agent incidents (tool failures + detected blockers). Use to debug what is missing and what failed recently.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum rows (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'playbook_search',
    description: 'Search operator playbooks by keyword to find procedures for fixing blockers.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum results (default: 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'playbook_get',
    description: 'Get a specific operator playbook by key.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Playbook key (e.g., hyperliquid/funding)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'playbook_upsert',
    description:
      'Create or update an operator playbook. Use to persist durable procedures after validating them.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Playbook key' },
        title: { type: 'string', description: 'Playbook title' },
        content: { type: 'string', description: 'Playbook content (markdown/plaintext)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['key', 'title', 'content'],
    },
  },
  {
    name: 'hyperliquid_verify_live',
    description:
      'Run Hyperliquid live verification checks (markets/mids/account/open orders/signer). Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Perp symbol to check (default: BTC)' },
      },
      required: [],
    },
  },
  {
    name: 'hyperliquid_order_roundtrip',
    description:
      'Place a tiny far-off limit order and cancel it to verify authenticated trading works. Side-effect tool.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Perp symbol (default: BTC)' },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'Side (default: buy)' },
        size: { type: 'number', description: 'Order size in base units (keep tiny)' },
        price_offset_bps: { type: 'number', description: 'How far from mid in bps (default: 5000)' },
      },
      required: ['size'],
    },
  },
  {
    name: 'evm_erc20_balance',
    description: 'Get ERC20 token balance on an EVM chain (polygon|arbitrum). Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['polygon', 'arbitrum'], description: 'Chain' },
        address: { type: 'string', description: 'Owner address' },
        token_address: { type: 'string', description: 'Token address (defaults to USDC for chain)' },
        rpc_url: { type: 'string', description: 'Optional RPC URL override' },
      },
      required: ['chain', 'address'],
    },
  },
  {
    name: 'evm_usdc_balances',
    description: 'Get native + USDC balances for polygon and arbitrum. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Owner address (default: keystore address)' },
      },
      required: [],
    },
  },
  {
    name: 'cctp_bridge_usdc',
    description: 'Bridge native USDC across supported chains via Circle CCTP v1 (polygon <-> arbitrum). Side-effect tool.',
    input_schema: {
      type: 'object',
      properties: {
        from_chain: { type: 'string', enum: ['polygon', 'arbitrum'], description: 'Source chain (default: polygon)' },
        to_chain: { type: 'string', enum: ['polygon', 'arbitrum'], description: 'Destination chain (default: arbitrum)' },
        amount_usdc: { type: 'number', description: 'USDC amount to bridge' },
        recipient: { type: 'string', description: 'Recipient on destination (default: same wallet)' },
        poll_seconds: { type: 'number', description: 'Attestation poll interval (default: 5)' },
        max_wait_seconds: { type: 'number', description: 'Max wait for attestation (default: 300)' },
      },
      required: ['amount_usdc'],
    },
  },
  {
    name: 'hyperliquid_deposit_usdc',
    description: 'Deposit USDC to Hyperliquid by transferring Arbitrum USDC to the configured Hyperliquid bridge deposit address. Side-effect tool.',
    input_schema: {
      type: 'object',
      properties: {
        amount_usdc: { type: 'number', description: 'USDC amount to deposit (min 5)' },
        deposit_address: { type: 'string', description: 'Optional override deposit address' },
      },
      required: ['amount_usdc'],
    },
  },
  {
    name: 'position_analysis',
    description: 'Analyze current perp positions for exposure, leverage, and liquidation risk.',
    input_schema: {
      type: 'object',
      properties: {
        min_liq_buffer_pct: {
          type: 'number',
          description: 'Warn if liquidation buffer is below this percent (default: 12)',
        },
        max_concentration_pct: {
          type: 'number',
          description: 'Warn if a single symbol exceeds this share of notional (default: 40)',
        },
        leverage_warning: {
          type: 'number',
          description: 'Warn if leverage exceeds this value (default: 5)',
        },
      },
      required: [],
    },
  },
  {
    name: 'discovery_report',
    description: 'Summarize discovery signals, hypotheses, and trade expressions.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum expressions to include (default: 5)' },
      },
      required: [],
    },
  },
  {
    name: 'trade_review',
    description: 'Review recent perp trades and summarize execution quality.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional symbol filter (e.g., BTC)' },
        limit: { type: 'number', description: 'Number of trades to include (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'perp_trade_journal_list',
    description: 'List recent perp trade journal entries (post-trade notes + metadata).',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional symbol filter (e.g., ETH)' },
        limit: { type: 'number', description: 'Number of entries to include (default: 50)' },
      },
      required: [],
    },
  },
  {
    name: 'signal_price_vol_regime',
    description: 'Compute price/vol regime signals for a symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol in exchange format (e.g., BTC/USDT)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'signal_cross_asset_divergence',
    description: 'Compute cross-asset divergence signals for a set of symbols.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Symbols in exchange format (e.g., BTC/USDT)',
        },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'signal_hyperliquid_funding_oi_skew',
    description: 'Compute funding/open-interest skew signal from Hyperliquid.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol in exchange format (e.g., BTC/USDT)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'signal_hyperliquid_orderflow_imbalance',
    description: 'Compute orderflow imbalance signal from Hyperliquid.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol in exchange format (e.g., BTC/USDT)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'discovery_run',
    description: 'Run the autonomous discovery loop and return clusters, hypotheses, and expressions.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of clusters to return' },
      },
      required: [],
    },
  },
];
