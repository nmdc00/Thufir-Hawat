import type { ThufirConfig } from './config.js';
import type { MarketClient } from '../execution/market-client.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import {
  getPaperPerpBookSummary,
  listPaperPerpFills,
  listPaperPerpPositions,
} from '../memory/paper_perps.js';

type PaperPerpPosition = {
  symbol: string;
  side: 'long' | 'short';
  size: number;
};

function resolveMidForSymbol(symbol: string, mids: Record<string, number>): number | undefined {
  if (mids[symbol] != null) return mids[symbol];
  if (symbol.includes(':')) {
    const afterColon = symbol.split(':').at(-1);
    if (afterColon && mids[afterColon] != null) return mids[afterColon];
  }
  const beforeSlash = symbol.split('/')[0];
  if (beforeSlash && beforeSlash !== symbol && mids[beforeSlash] != null) return mids[beforeSlash];
  return undefined;
}

export async function resolvePaperMids(
  marketClient: MarketClient,
  config?: ThufirConfig
): Promise<Record<string, number>> {
  try {
    if (marketClient.isAvailable()) {
      const markets = await marketClient.listMarkets(500);
      const mids: Record<string, number> = {};
      for (const market of markets) {
        if (
          market.symbol &&
          !market.symbol.includes(':') &&
          typeof market.markPrice === 'number' &&
          Number.isFinite(market.markPrice)
        ) {
          mids[market.symbol] = market.markPrice;
          if (market.symbol.includes('/')) {
            const base = market.symbol.split('/')[0];
            if (base && base !== market.symbol) mids[base] = market.markPrice;
          }
        }
      }
      for (const market of markets) {
        if (
          market.symbol &&
          market.symbol.includes(':') &&
          typeof market.markPrice === 'number' &&
          Number.isFinite(market.markPrice)
        ) {
          mids[market.symbol] = market.markPrice;
          const afterColon = market.symbol.split(':').at(-1);
          if (afterColon && afterColon !== market.symbol && mids[afterColon] == null) {
            mids[afterColon] = market.markPrice;
          }
        }
      }
      return mids;
    }
    if (config?.hyperliquid?.enabled !== false) {
      const raw = await new HyperliquidClient(config!).getAllMids();
      return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toUpperCase(), value]));
    }
    return {};
  } catch {
    return {};
  }
}

export function buildPaperPerpSnapshot(
  initialCashUsdc: number,
  mids: Record<string, number> = {}
): {
  cashBalanceUsdc: number;
  totalNotionalUsdc: number;
  accountValueUsdc: number;
  positions: Array<{
    symbol: string;
    side: 'long' | 'short';
    size: number;
    entry_price: number;
    leverage: number | null;
    position_value: number;
    unrealized_pnl: number | null;
    return_on_equity: number | null;
    liquidation_price: number | null;
    margin_used: number | null;
    leverage_type: string | null;
    max_leverage: number | null;
  }>;
} {
  const book = getPaperPerpBookSummary(initialCashUsdc);
  const positions = listPaperPerpPositions(initialCashUsdc).map((position) => {
    const markPrice = resolveMidForSymbol(position.symbol, mids);
    const effectivePrice = markPrice ?? position.entryPrice;
    const direction = position.side === 'long' ? 1 : -1;
    let leverage = position.leverage;
    if (leverage == null) {
      const openFill = listPaperPerpFills({ symbol: position.symbol, limit: 20 }, initialCashUsdc).find(
        (fill) => !fill.reduceOnly && fill.leverage != null
      );
      leverage = openFill?.leverage ?? null;
    }
    return {
      symbol: position.symbol,
      side: position.side,
      size: position.size,
      entry_price: position.entryPrice,
      leverage,
      position_value: effectivePrice * position.size,
      unrealized_pnl:
        markPrice != null ? (markPrice - position.entryPrice) * position.size * direction : null,
      return_on_equity:
        markPrice != null && position.entryPrice > 0
          ? ((markPrice - position.entryPrice) * direction / position.entryPrice) * 100
          : null,
      liquidation_price:
        leverage != null && leverage > 1
          ? position.side === 'long'
            ? position.entryPrice * (1 - 1 / leverage)
            : position.entryPrice * (1 + 1 / leverage)
          : null,
      margin_used: null,
      leverage_type: null,
      max_leverage: null,
    };
  });
  const totalNotionalUsdc = positions.reduce((sum, position) => sum + Number(position.position_value ?? 0), 0);
  const totalUnrealizedPnlUsdc = positions.reduce((sum, position) => sum + (position.unrealized_pnl ?? 0), 0);
  return {
    cashBalanceUsdc: book.cashBalanceUsdc,
    totalNotionalUsdc,
    accountValueUsdc: book.cashBalanceUsdc + totalUnrealizedPnlUsdc,
    positions,
  };
}

export function getPaperPositionSnapshot(
  symbol: string,
  initialCashUsdc: number
): PaperPerpPosition | null {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return null;
  const position = listPaperPerpPositions(initialCashUsdc).find(
    (entry) => entry.symbol.trim().toUpperCase() === normalized
  );
  if (!position) return null;
  return {
    symbol: position.symbol,
    side: position.side,
    size: position.size,
  };
}

export function evaluatePaperReduceOnlyPostcondition(params: {
  symbol: string;
  before: PaperPerpPosition | null;
  after: PaperPerpPosition | null;
}) {
  const beforeSize = params.before?.size ?? 0;
  const afterSize = params.after?.size ?? 0;
  const sideFlipped =
    params.before != null &&
    params.after != null &&
    params.before.side !== params.after.side &&
    afterSize > 0;
  const reduced = afterSize < beforeSize;
  const closeComplete = beforeSize > 0 && afterSize === 0;
  const verified = reduced && !sideFlipped;
  const reason = verified
    ? closeComplete
      ? 'position_flat'
      : 'position_reduced'
    : sideFlipped
      ? 'side_flip_detected'
      : beforeSize <= 0
        ? 'no_position_before'
        : 'size_not_reduced';

  return {
    verified,
    reason,
    close_complete: closeComplete,
    reduced,
    before_size: beforeSize,
    after_size: afterSize,
    before_side: params.before?.side ?? null,
    after_side: params.after?.side ?? null,
    symbol: params.symbol,
  };
}
