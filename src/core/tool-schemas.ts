import type { Tool } from '@anthropic-ai/sdk/resources/messages';

export const BIJAZ_TOOLS: Tool[] = [
  {
    name: 'market_search',
    description:
      'Search for prediction markets on Polymarket by query. Use when the user asks about a topic and you want relevant markets.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "Fed rates", "Bitcoin price")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5, max: 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'market_get',
    description: 'Get detailed information about a specific prediction market by ID.',
    input_schema: {
      type: 'object',
      properties: {
        market_id: {
          type: 'string',
          description: 'Polymarket market ID',
        },
      },
      required: ['market_id'],
    },
  },
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
    name: 'calibration_stats',
    description:
      "Get the user's prediction calibration stats (accuracy, Brier score, track record).",
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Filter by domain (e.g., "politics", "crypto")',
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
          description: 'Search query for Twitter (e.g., "Polymarket", "Palantir earnings")',
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
      'Get current portfolio: positions, balances, and P&L. Use before betting to understand available capital and exposure.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_predictions',
    description:
      'Get past predictions and their outcomes. Use to review betting history, learn from mistakes, and improve calibration.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum predictions to return (default: 20)',
        },
        status: {
          type: 'string',
          enum: ['all', 'pending', 'resolved', 'won', 'lost'],
          description: 'Filter by status (default: all)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_order_book',
    description:
      'Get order book depth for a market. Shows bid/ask prices and liquidity at each level.',
    input_schema: {
      type: 'object',
      properties: {
        market_id: {
          type: 'string',
          description: 'The Polymarket market ID',
        },
        depth: {
          type: 'number',
          description: 'Number of price levels to return (default: 5)',
        },
      },
      required: ['market_id'],
    },
  },
  {
    name: 'price_history',
    description:
      'Get historical price data for a market. Shows how odds have changed over time.',
    input_schema: {
      type: 'object',
      properties: {
        market_id: {
          type: 'string',
          description: 'The Polymarket market ID',
        },
        interval: {
          type: 'string',
          enum: ['1h', '4h', '1d', '1w'],
          description: 'Time interval between data points (default: 1d)',
        },
        limit: {
          type: 'number',
          description: 'Number of data points (default: 30)',
        },
      },
      required: ['market_id'],
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
    name: 'place_bet',
    description:
      'Place a bet on a prediction market. Use after researching a market to execute a trade. System spending/exposure limits apply automatically.',
    input_schema: {
      type: 'object',
      properties: {
        market_id: {
          type: 'string',
          description: 'The Polymarket market ID to bet on',
        },
        outcome: {
          type: 'string',
          enum: ['YES', 'NO'],
          description: 'The outcome to bet on (YES or NO)',
        },
        amount: {
          type: 'number',
          description: 'Amount in USD to bet',
        },
        reasoning: {
          type: 'string',
          description: 'Your reasoning for this bet (stored for calibration tracking)',
        },
      },
      required: ['market_id', 'outcome', 'amount'],
    },
  },
];
