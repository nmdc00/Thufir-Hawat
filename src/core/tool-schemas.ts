import type { Tool } from '@anthropic-ai/sdk/resources/messages';

/**
 * Tool subset categories for scoping tool schemas per LLM call type.
 * Reduces input tokens by sending only relevant tools.
 */
export type ToolSubset = 'discovery' | 'execution' | 'chat' | 'trivial' | 'full';

const TOOL_SUBSETS: Record<Exclude<ToolSubset, 'full'>, Set<string>> = {
  discovery: new Set([
    'perp_market_list',
    'perp_market_get',
    'perp_positions',
    'get_positions',
    'get_portfolio',
    'signal_price_vol_regime',
    'signal_cross_asset_divergence',
    'signal_hyperliquid_funding_oi_skew',
    'signal_hyperliquid_orderflow_imbalance',
    'discovery_run',
    'discovery_select_markets',
    'discovery_report',
    'current_time',
  ]),
  execution: new Set([
    'perp_place_order',
    'perp_cancel_order',
    'perp_open_orders',
    'perp_positions',
    'perp_market_get',
    'get_portfolio',
    'get_positions',
    'get_fills',
    'get_open_orders',
    'position_analysis',
    'paper_promotion_report',
    'current_time',
    'calibration_stats',
    'perp_analyze',
  ]),
  chat: new Set([
    'intel_search',
    'intel_recent',
    'events_list',
    'event_get',
    'event_latest_thought',
    'event_forecasts',
    'event_outcomes',
    'historical_case_search',
    'web_search',
    'web_fetch',
    'qmd_query',
    'qmd_index',
    'twitter_search',
    'current_time',
    'get_portfolio',
    'get_positions',
    'get_open_orders',
    'perp_market_list',
    'perp_market_get',
    'perp_positions',
    'perp_place_order',
    'perp_cancel_order',
    'perp_open_orders',
    'perp_analyze',
    'position_analysis',
    'signal_hyperliquid_funding_oi_skew',
    'signal_hyperliquid_orderflow_imbalance',
    'signal_price_vol_regime',
    'signal_cross_asset_divergence',
    'proactive_search_run',
    'discovery_report',
    'trade_review',
    'get_fills',
    'perp_trade_journal_list',
    'paper_promotion_report',
    'calibration_stats',
    'evaluation_summary',
    'mentat_query',
    'mentat_store_assumption',
    'mentat_store_fragility',
    'mentat_store_mechanism',
    'agent_incidents_recent',
    'playbook_search',
    'playbook_get',
    'playbook_upsert',
  ]),
  trivial: new Set([
    'current_time',
    'get_portfolio',
    'get_positions',
    'perp_positions',
  ]),
};

/**
 * Get tools filtered by subset. Returns all tools for 'full' or unrecognized subsets.
 */
export function getToolsForSubset(subset: ToolSubset): Tool[] {
  if (subset === 'full') return THUFIR_TOOLS;
  const allowed = TOOL_SUBSETS[subset];
  if (!allowed) return THUFIR_TOOLS;
  return THUFIR_TOOLS.filter((tool) => allowed.has(tool.name));
}

/**
 * Get the set of tool names for a given subset (for testing/introspection).
 */
export function getToolSubsetNames(subset: Exclude<ToolSubset, 'full'>): ReadonlySet<string> {
  return TOOL_SUBSETS[subset];
}

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
    name: 'events_list',
    description: 'List normalized causal events by domain or status.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional domain filter such as energy, agri, crypto, macro.' },
        status: { type: 'string', description: 'Optional status filter such as active or superseded.' },
        limit: { type: 'number', description: 'Maximum results (default: 10)' },
      },
      required: [],
    },
  },
  {
    name: 'event_get',
    description: 'Get a normalized event by id.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'event_latest_thought',
    description: 'Get the latest thought artifact linked to an event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'event_forecasts',
    description: 'List forecast artifacts linked to an event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'event_outcomes',
    description: 'List outcome artifacts linked to an event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'historical_case_search',
    description: 'Search the seeded historical casebase by domain, mechanism text, or regime tags.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional domain filter such as energy or macro.' },
        mechanism_query: { type: 'string', description: 'Optional mechanism text query.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional regime or mechanism tags.' },
        limit: { type: 'number', description: 'Maximum results (default: 5)' },
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
    name: 'get_fills',
    description:
      'Get fill history with realized PnL. Works in both paper and live mode. Use to review closed trades, check realized PnL on a specific symbol, or look up leverage used on past trades.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Filter by symbol (e.g. "BTC", "ZEC"). Omit for all symbols.',
        },
        limit: {
          type: 'number',
          description: 'Max fills to return (default 20, max 100)',
        },
        lookback_days: {
          type: 'number',
          description: 'Live mode only: how many days back to fetch fills (default 30, max 90).',
        },
      },
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
    description: 'Place a perp order on the configured exchange. IMPORTANT: When closing a position (reduce_only=true), you MUST include exit_mode — the call will be rejected without it.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['paper', 'live'],
          description: 'Execution book mode override (default: paper unless explicitly set live).',
        },
        symbol: { type: 'string', description: 'Perp symbol' },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'Order side' },
        size: { type: 'number', description: 'Order size' },
        order_type: { type: 'string', enum: ['market', 'limit'], description: 'Order type' },
        price: { type: 'number', description: 'Limit price (required for limit orders)' },
        leverage: { type: 'number', description: 'Leverage to apply' },
        reduce_only: { type: 'boolean', description: 'Reduce-only order (closes/reduces an existing position). When true, exit_mode is required or the order will be rejected.' },
        signal_class: { type: 'string', description: 'Optional signal class for policy and journaling' },
        market_regime: {
          type: 'string',
          enum: ['trending', 'choppy', 'high_vol_expansion', 'low_vol_compression'],
          description: 'Optional market regime classification',
        },
        expected_edge: { type: 'number', description: 'Expected edge (0-1)' },
        entry_trigger: {
          type: 'string',
          enum: ['news', 'technical', 'hybrid'],
          description: 'Primary entry trigger family',
        },
        news_subtype: { type: 'string', description: 'News subtype/catalyst label' },
        novelty_score: { type: 'number', description: 'News novelty score (0-1)' },
        market_confirmation_score: { type: 'number', description: 'Market confirmation score (0-1)' },
        thesis_expires_at_ms: { type: 'number', description: 'Unix ms when this thesis expires' },
        news_sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of source refs/urls/intel ids used for a news-triggered trade',
        },
        hypothesis_id: { type: 'string', description: 'Optional hypothesis id linking entry and exit' },
        trade_archetype: {
          type: 'string',
          enum: ['scalp', 'intraday', 'swing'],
          description: 'Execution archetype required when trade-contract enforcement is enabled',
        },
        invalidation_type: {
          type: 'string',
          enum: ['price_level', 'structure_break'],
          description: 'Invalidation mode required when trade-contract enforcement is enabled',
        },
        invalidation_price: {
          type: 'number',
          description: 'Required for invalidation_type=price_level',
        },
        time_stop_at_ms: {
          type: 'number',
          description: 'Unix ms time-stop deadline for the trade contract',
        },
        take_profit_r: {
          type: 'number',
          description: 'Optional authored profit target expressed in R-multiples; not used by the default exit lifecycle',
        },
        trail_mode: {
          type: 'string',
          enum: ['none', 'atr', 'structure'],
          description: 'Trailing mode for contract-based management',
        },
        exit_contract: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional structured exit contract with deterministic hard rules and heartbeat review guidance',
        },
        emergency_override: {
          type: 'boolean',
          description: 'Allow manual/unknown reduce-only exit only when true under FSM enforcement',
        },
        emergency_reason: {
          type: 'string',
          description: 'Required rationale when emergency_override=true',
        },
        thesis_invalidation_hit: {
          type: 'boolean',
          description: 'For reduce-only exits: true if recorded invalidation condition was hit',
        },
        exit_mode: {
          type: 'string',
          enum: ['thesis_invalidation', 'dynamic_profit_protection', 'risk_reduction', 'emergency_risk', 'take_profit', 'time_exit', 'manual', 'unknown'],
          description: 'REQUIRED when reduce_only=true. Use thesis_invalidation for a thesis break, dynamic_profit_protection for extension-based de-risking, risk_reduction for non-terminal exposure cuts, or emergency_risk for liquidation-risk overrides. `take_profit` and `time_exit` remain as legacy compatibility values and should not be used by new autonomous flows.',
        },
        close_reason: {
          type: 'string',
          enum: [
            'thesis_invalidation',
            'thesis_time_stop',
            'exit_contract_rule',
            'llm_exit_consult',
            'liquidation_guard',
            'paper_liquidation',
            'equity_guard',
            'manual_command',
            'emergency_close',
            'legacy_trigger:pnl_shift',
            'legacy_trigger:volatility_spike',
            'legacy_trigger:time_ceiling',
            'unattributed',
          ],
          description: 'Canonical v2.5 close attribution for reduce_only=true. This is distinct from exit_mode, which remains the lifecycle/FSM assessment label.',
        },
        close_authority: {
          type: 'string',
          enum: ['autonomous', 'manual'],
          description: 'Authority that initiated a reduce-only close. Defaults to autonomous except manual_command closes.',
        },
        entry_price: {
          type: 'number',
          description: 'Optional entry price override for closed-trade component scoring',
        },
        price_path_high: {
          type: 'number',
          description: 'Optional highest observed trade-path price for closed-trade component scoring',
        },
        price_path_low: {
          type: 'number',
          description: 'Optional lowest observed trade-path price for closed-trade component scoring',
        },
        plan_context: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional plan snapshot metadata to persist with this trade attempt',
        },
      },
      required: ['symbol', 'side', 'size'],
    },
  },
  {
    name: 'perp_open_orders',
    description: 'List open perp orders for the configured exchange.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['paper', 'live'],
          description: 'Book mode (paper|live). Default follows paper routing policy.',
        },
      },
      required: [],
    },
  },
  {
    name: 'perp_cancel_order',
    description: 'Cancel a perp order by id.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['paper', 'live'],
          description: 'Book mode (paper|live). Default follows paper routing policy.',
        },
        order_id: { type: 'string', description: 'Order id to cancel' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'perp_positions',
    description: 'Get open perp positions for the configured exchange.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['paper', 'live'],
          description: 'Book mode (paper|live). Default follows paper routing policy.',
        },
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
    name: 'hyperliquid_usd_class_transfer',
    description:
      'Transfer USDC between Hyperliquid Spot and Perp accounts (Spot<->Perp). Side-effect tool.',
    input_schema: {
      type: 'object',
      properties: {
        amount_usdc: {
          type: 'number',
          description: 'USDC amount to transfer (e.g., 1.5)',
        },
        to: {
          type: 'string',
          enum: ['perp', 'spot'],
          description: 'Destination account: perp (spot->perp) or spot (perp->spot)',
        },
      },
      required: ['amount_usdc', 'to'],
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
    name: 'paper_promotion_report',
    description: 'Evaluate mechanical paper->live promotion gates for a symbol/signal setup.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Perp symbol (e.g., BTC)' },
        signal_class: {
          type: 'string',
          description: 'Signal class identifier used in journaling (e.g., breakout_15m)',
        },
      },
      required: ['symbol', 'signal_class'],
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
  {
    name: 'discovery_select_markets',
    description:
      'Deterministically preselect/rank markets for low-latency discovery (no LLM calls).',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of symbols to return' },
        min_open_interest_usd: {
          type: 'number',
          description: 'Minimum open interest in USD for eligibility',
        },
        min_day_volume_usd: {
          type: 'number',
          description: 'Minimum 24h notional volume in USD for eligibility',
        },
      },
      required: [],
    },
  },
];
