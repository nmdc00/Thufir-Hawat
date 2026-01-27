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
];
