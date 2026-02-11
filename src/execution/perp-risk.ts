import type { ThufirConfig } from '../core/config.js';
import { HyperliquidClient } from './hyperliquid/client.js';

export type PerpCorrelationCap = {
  name: string;
  symbols: string[];
  maxNotionalUsd: number;
};

type PerpRiskLimits = NonNullable<ThufirConfig['wallet']>['perps'];

type PerpRiskCheckInput = {
  config: ThufirConfig;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  leverage?: number;
  reduceOnly?: boolean;
  markPrice?: number | null;
  notionalUsd?: number;
  marketMaxLeverage?: number | null;
};

type PositionSnapshot = {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  notionalUsd: number;
  liquidationPrice?: number | null;
};

type PerpRiskCheckResult = {
  allowed: boolean;
  reason?: string;
};

const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();

const toFiniteNumber = (value: unknown): number | null => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const resolveMid = (mids: Record<string, number>, symbol: string): number | null => {
  const normalized = normalizeSymbol(symbol);
  const direct = mids[normalized];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const raw = mids[symbol];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

async function fetchPositions(
  client: HyperliquidClient,
  mids: Record<string, number>
): Promise<PositionSnapshot[]> {
  const state = (await client.getClearinghouseState()) as {
    assetPositions?: Array<{ position?: Record<string, unknown> }>;
  };
  const positions = (state.assetPositions ?? [])
    .map((entry) => entry?.position ?? {})
    .map((position) => {
      const size = toFiniteNumber((position as { szi?: unknown }).szi);
      if (size == null || size === 0) return null;
      const symbol = String((position as { coin?: unknown }).coin ?? '');
      if (!symbol) return null;
      const side: PositionSnapshot['side'] = size > 0 ? 'long' : 'short';
      const notionalRaw = toFiniteNumber((position as { positionValue?: unknown }).positionValue);
      const liquidationPrice = toFiniteNumber((position as { liquidationPx?: unknown }).liquidationPx);
      const mid = resolveMid(mids, symbol);
      const notionalUsd = Math.abs(
        notionalRaw != null ? notionalRaw : Math.abs(size) * (mid ?? 0)
      );
      if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
      return {
        symbol,
        side,
        size: Math.abs(size),
        notionalUsd,
        liquidationPrice,
      };
    })
    .filter((position): position is NonNullable<typeof position> => Boolean(position));

  return positions;
}

function computeDeltaNotional(params: {
  orderNotional: number;
  orderSide: 'buy' | 'sell';
  existing?: PositionSnapshot;
}): number {
  const { orderNotional, orderSide, existing } = params;
  if (!existing) {
    return orderNotional;
  }
  const existingSide = existing.side === 'long' ? 'buy' : 'sell';
  if (existingSide === orderSide) {
    return orderNotional;
  }
  if (orderNotional <= existing.notionalUsd) {
    return -orderNotional;
  }
  return orderNotional - 2 * existing.notionalUsd;
}

function shouldCheckLiqDistance(params: {
  reduceOnly?: boolean;
  orderSide: 'buy' | 'sell';
  orderNotional: number;
  existing?: PositionSnapshot;
}): boolean {
  if (params.reduceOnly) return false;
  if (!params.existing) return false;
  const existingSide = params.existing.side === 'long' ? 'buy' : 'sell';
  if (existingSide === params.orderSide) return true;
  return params.orderNotional > params.existing.notionalUsd;
}

export async function checkPerpRiskLimits(
  input: PerpRiskCheckInput
): Promise<PerpRiskCheckResult> {
  const limits = input.config.wallet?.perps as PerpRiskLimits | undefined;
  if (!limits) {
    return { allowed: true };
  }

  const maxLeverage = toFiniteNumber(limits.maxLeverage);
  const leverage = toFiniteNumber(input.leverage);
  if (!input.reduceOnly && maxLeverage != null && leverage != null && leverage > maxLeverage) {
    return {
      allowed: false,
      reason: `Leverage ${leverage.toFixed(2)} exceeds max ${maxLeverage.toFixed(2)}`,
    };
  }

  const marketMaxLeverage = toFiniteNumber(input.marketMaxLeverage);
  if (
    !input.reduceOnly &&
    marketMaxLeverage != null &&
    leverage != null &&
    leverage > marketMaxLeverage
  ) {
    return {
      allowed: false,
      reason: `Leverage ${leverage.toFixed(2)} exceeds market max ${marketMaxLeverage.toFixed(2)}`,
    };
  }

  if (input.reduceOnly) {
    return { allowed: true };
  }

  const maxOrderNotional = toFiniteNumber(limits.maxOrderNotionalUsd);
  const maxTotalNotional = toFiniteNumber(limits.maxTotalNotionalUsd);
  const minLiqDistanceBps = toFiniteNumber(limits.minLiquidationDistanceBps);
  const correlationCaps = Array.isArray(limits.correlationCaps)
    ? (limits.correlationCaps as PerpCorrelationCap[])
    : [];

  const needsPrice =
    maxOrderNotional != null ||
    maxTotalNotional != null ||
    minLiqDistanceBps != null ||
    correlationCaps.length > 0;

  let mids: Record<string, number> = {};
  let price = toFiniteNumber(input.markPrice);

  if (needsPrice && (price == null || price <= 0)) {
    try {
      const client = new HyperliquidClient(input.config);
      mids = await client.getAllMids();
      price = resolveMid(mids, input.symbol);
    } catch {
      price = price ?? null;
    }
  }

  const orderNotional =
    toFiniteNumber(input.notionalUsd) ??
    (price != null && price > 0 ? Math.abs(input.size) * price : null);

  if (maxOrderNotional != null && orderNotional != null && orderNotional > maxOrderNotional) {
    return {
      allowed: false,
      reason: `Order notional $${orderNotional.toFixed(2)} exceeds max $${maxOrderNotional.toFixed(2)}`,
    };
  }

  const needsPositions =
    maxTotalNotional != null || minLiqDistanceBps != null || correlationCaps.length > 0;

  if (!needsPositions) {
    return { allowed: true };
  }

  let positions: PositionSnapshot[] = [];
  if (needsPositions) {
    try {
      const client = new HyperliquidClient(input.config);
      if (Object.keys(mids).length === 0) {
        mids = await client.getAllMids();
      }
      positions = await fetchPositions(client, mids);
    } catch {
      return { allowed: true };
    }
  }

  const normalizedSymbol = normalizeSymbol(input.symbol);
  const existing = positions.find((pos) => normalizeSymbol(pos.symbol) === normalizedSymbol);
  const orderNotionalResolved = orderNotional ?? 0;
  const deltaNotional = computeDeltaNotional({
    orderNotional: orderNotionalResolved,
    orderSide: input.side,
    existing,
  });

  if (maxTotalNotional != null) {
    const totalNotional = positions.reduce((sum, pos) => sum + pos.notionalUsd, 0);
    const nextTotal = totalNotional + deltaNotional;
    if (nextTotal > maxTotalNotional) {
      return {
        allowed: false,
        reason: `Total perp notional $${nextTotal.toFixed(2)} exceeds max $${maxTotalNotional.toFixed(2)}`,
      };
    }
  }

  if (correlationCaps.length > 0 && orderNotional != null) {
    for (const cap of correlationCaps) {
      const symbols = (cap.symbols ?? []).map(normalizeSymbol);
      if (!symbols.includes(normalizedSymbol)) {
        continue;
      }
      const capLimit = toFiniteNumber(cap.maxNotionalUsd);
      if (capLimit == null) {
        continue;
      }
      const groupNotional = positions
        .filter((pos) => symbols.includes(normalizeSymbol(pos.symbol)))
        .reduce((sum, pos) => sum + pos.notionalUsd, 0);
      const nextGroupNotional = groupNotional + deltaNotional;
      if (nextGroupNotional > capLimit) {
        return {
          allowed: false,
          reason: `Correlation cap ${cap.name} notional $${nextGroupNotional.toFixed(2)} exceeds max $${capLimit.toFixed(2)}`,
        };
      }
    }
  }

  if (minLiqDistanceBps != null && existing && price != null && price > 0) {
    if (
      shouldCheckLiqDistance({
        reduceOnly: input.reduceOnly,
        orderSide: input.side,
        orderNotional: orderNotionalResolved,
        existing,
      }) &&
      existing.liquidationPrice != null
    ) {
      const liq = existing.liquidationPrice;
      const distance =
        existing.side === 'long'
          ? (price - liq) / price
          : (liq - price) / price;
      const distanceBps = distance * 10000;
      if (!Number.isFinite(distanceBps) || distanceBps <= 0) {
        return { allowed: false, reason: 'Liquidation price is too close to mark price' };
      }
      if (distanceBps < minLiqDistanceBps) {
        return {
          allowed: false,
          reason: `Liquidation distance ${distanceBps.toFixed(0)} bps below minimum ${minLiqDistanceBps.toFixed(0)} bps`,
        };
      }
    }
  }

  return { allowed: true };
}
