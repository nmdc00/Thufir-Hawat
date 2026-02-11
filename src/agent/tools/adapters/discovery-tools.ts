import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { executeToolCall, type ToolExecutorContext } from '../../../core/tool-executor.js';

function toExecutorContext(ctx: ToolContext): ToolExecutorContext {
  return ctx as unknown as ToolExecutorContext;
}

const READ_TOOL_META = {
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 10_000,
} as const;

export const perpMarketListTool: ToolDefinition = {
  name: 'perp_market_list',
  description: 'List perp markets for the configured exchange.',
  category: 'markets',
  schema: z.object({
    limit: z.number().optional(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('perp_market_list', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const perpMarketGetTool: ToolDefinition = {
  name: 'perp_market_get',
  description: 'Get a perp market by symbol.',
  category: 'markets',
  schema: z.object({
    symbol: z.string(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('perp_market_get', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const perpPlaceOrderTool: ToolDefinition = {
  name: 'perp_place_order',
  description: 'Place a perp order on the configured exchange.',
  category: 'trading',
  schema: z.object({
    symbol: z.string(),
    side: z.enum(['buy', 'sell']),
    size: z.number().positive(),
    order_type: z.enum(['market', 'limit']).optional(),
    price: z.number().optional(),
    leverage: z.number().optional(),
    reduce_only: z.boolean().optional(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('perp_place_order', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: true,
  cacheTtlMs: 0,
};

export const perpOpenOrdersTool: ToolDefinition = {
  name: 'perp_open_orders',
  description: 'List open perp orders.',
  category: 'trading',
  schema: z.object({}),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('perp_open_orders', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 10_000,
};

export const perpCancelOrderTool: ToolDefinition = {
  name: 'perp_cancel_order',
  description: 'Cancel a perp order by id.',
  category: 'trading',
  schema: z.object({
    order_id: z.string(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('perp_cancel_order', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: true,
  cacheTtlMs: 0,
};

export const perpPositionsTool: ToolDefinition = {
  name: 'perp_positions',
  description: 'Get open perp positions.',
  category: 'trading',
  schema: z.object({}),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('perp_positions', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 10_000,
};

export const signalPriceVolRegimeTool: ToolDefinition = {
  name: 'signal_price_vol_regime',
  description: 'Compute price/vol regime signals for a symbol.',
  category: 'intel',
  schema: z.object({
    symbol: z.string(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('signal_price_vol_regime', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const signalCrossAssetDivergenceTool: ToolDefinition = {
  name: 'signal_cross_asset_divergence',
  description: 'Compute cross-asset divergence signals.',
  category: 'intel',
  schema: z.object({
    symbols: z.array(z.string()),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('signal_cross_asset_divergence', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const signalHyperliquidFundingOISkewTool: ToolDefinition = {
  name: 'signal_hyperliquid_funding_oi_skew',
  description: 'Compute Hyperliquid funding/open-interest skew signals.',
  category: 'intel',
  schema: z.object({
    symbol: z.string(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall(
      'signal_hyperliquid_funding_oi_skew',
      input as Record<string, unknown>,
      toExecutorContext(ctx)
    );
  },
  ...READ_TOOL_META,
};

export const signalHyperliquidOrderflowImbalanceTool: ToolDefinition = {
  name: 'signal_hyperliquid_orderflow_imbalance',
  description: 'Compute Hyperliquid orderflow imbalance signals.',
  category: 'intel',
  schema: z.object({
    symbol: z.string(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall(
      'signal_hyperliquid_orderflow_imbalance',
      input as Record<string, unknown>,
      toExecutorContext(ctx)
    );
  },
  ...READ_TOOL_META,
};

export const discoveryRunTool: ToolDefinition = {
  name: 'discovery_run',
  description: 'Run the autonomous discovery loop.',
  category: 'intel',
  schema: z.object({
    limit: z.number().optional(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('discovery_run', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const perpAnalyzeTool: ToolDefinition = {
  name: 'perp_analyze',
  description: 'Analyze a perp market and return directional probabilities, key risks, and signals.',
  category: 'intel',
  schema: z.object({
    symbol: z.string(),
    horizon: z.string().optional(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('perp_analyze', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const positionAnalysisTool: ToolDefinition = {
  name: 'position_analysis',
  description: 'Analyze current perp positions for exposure, leverage, and liquidation risk.',
  category: 'intel',
  schema: z.object({
    min_liq_buffer_pct: z.number().optional(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('position_analysis', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const discoveryReportTool: ToolDefinition = {
  name: 'discovery_report',
  description: 'Summarize discovery signals, hypotheses, and trade expressions.',
  category: 'intel',
  schema: z.object({
    limit: z.number().optional(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('discovery_report', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const tradeReviewTool: ToolDefinition = {
  name: 'trade_review',
  description: 'Review recent perp trades and summarize execution quality.',
  category: 'intel',
  schema: z.object({
    symbol: z.string().optional(),
    limit: z.number().optional(),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('trade_review', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  ...READ_TOOL_META,
};

export const discoveryTools: ToolDefinition[] = [
  perpMarketListTool,
  perpMarketGetTool,
  perpPlaceOrderTool,
  perpOpenOrdersTool,
  perpCancelOrderTool,
  perpPositionsTool,
  perpAnalyzeTool,
  positionAnalysisTool,
  discoveryReportTool,
  tradeReviewTool,
  signalPriceVolRegimeTool,
  signalCrossAssetDivergenceTool,
  signalHyperliquidFundingOISkewTool,
  signalHyperliquidOrderflowImbalanceTool,
  discoveryRunTool,
];
