import type { ThufirConfig } from '../core/config.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import type { TradeEnvelope } from './types.js';

function formatDecimal(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.?0+$/, '');
}

function computeStopPx(envelope: TradeEnvelope): { slPx: number; tpPx: number } {
  const stop = envelope.stopLossPct / 100;
  const tp = envelope.takeProfitPct / 100;
  const entry = envelope.entryPrice;
  if (envelope.side === 'buy') {
    return { slPx: entry * (1 - stop), tpPx: entry * (1 + tp) };
  }
  return { slPx: entry * (1 + stop), tpPx: entry * (1 - tp) };
}

export async function placeExchangeSideTpsl(params: {
  config: ThufirConfig;
  envelope: TradeEnvelope;
  sizeDecimals?: number;
}): Promise<{ tpOid: string | null; slOid: string | null; error?: string }> {
  if (params.config.execution?.mode !== 'live') {
    return { tpOid: null, slOid: null };
  }
  if (params.config.execution?.provider !== 'hyperliquid') {
    return { tpOid: null, slOid: null };
  }
  if (params.config.tradeManagement?.useExchangeStops !== true) {
    return { tpOid: null, slOid: null };
  }

  const client = new HyperliquidClient(params.config);
  const exchange = client.getExchangeClient();
  const markets = await client.listPerpMarkets();
  const marketMeta = markets.find((m) => m.symbol === params.envelope.symbol);
  if (!marketMeta) {
    return { tpOid: null, slOid: null, error: `Unknown Hyperliquid symbol: ${params.envelope.symbol}` };
  }

  const { slPx, tpPx } = computeStopPx(params.envelope);
  const closeIsBuy = params.envelope.side === 'sell';
  const sizeStr = formatDecimal(params.envelope.size, marketMeta.szDecimals ?? 6);
  if (!Number.isFinite(Number(sizeStr)) || Number(sizeStr) <= 0) {
    return { tpOid: null, slOid: null, error: 'Invalid size: rounds to zero.' };
  }

  const slPxStr = formatDecimal(slPx, 8);
  const tpPxStr = formatDecimal(tpPx, 8);

  try {
    const payload: any = {
      orders: [
        {
          a: marketMeta.assetId,
          b: closeIsBuy,
          p: slPxStr,
          s: sizeStr,
          r: true,
          t: { trigger: { isMarket: true, triggerPx: slPxStr, tpsl: 'sl' } },
        },
        {
          a: marketMeta.assetId,
          b: closeIsBuy,
          p: tpPxStr,
          s: sizeStr,
          r: true,
          t: { trigger: { isMarket: true, triggerPx: tpPxStr, tpsl: 'tp' } },
        },
      ],
      grouping: 'positionTpsl',
    };

    const result = await exchange.order(payload);
    const statuses: any[] = (result as any)?.response?.data?.statuses ?? [];
    const sl = statuses[0] ?? null;
    const tp = statuses[1] ?? null;
    const slOid =
      sl?.resting?.oid != null
        ? String(sl.resting.oid)
        : sl?.filled?.oid != null
          ? String(sl.filled.oid)
          : null;
    const tpOid =
      tp?.resting?.oid != null
        ? String(tp.resting.oid)
        : tp?.filled?.oid != null
          ? String(tp.filled.oid)
          : null;

    const slError = typeof sl?.error === 'string' ? sl.error : '';
    const tpError = typeof tp?.error === 'string' ? tp.error : '';
    if (slError || tpError) {
      return { tpOid: tpOid, slOid: slOid, error: [slError, tpError].filter(Boolean).join(' | ') };
    }
    return { tpOid, slOid };
  } catch (error) {
    return {
      tpOid: null,
      slOid: null,
      error: error instanceof Error ? error.message : 'Unknown error placing exchange-side TP/SL',
    };
  }
}

export async function cancelExchangeOrderOids(params: {
  config: ThufirConfig;
  symbol: string;
  oids: string[];
}): Promise<void> {
  if (params.config.execution?.mode !== 'live') return;
  if (params.config.execution?.provider !== 'hyperliquid') return;
  const oids = params.oids.map((oid) => Number(oid)).filter((n) => Number.isFinite(n) && n > 0);
  if (!oids.length) return;

  const client = new HyperliquidClient(params.config);
  const exchange = client.getExchangeClient();
  const markets = await client.listPerpMarkets();
  const marketMeta = markets.find((m) => m.symbol === params.symbol);
  if (!marketMeta) return;

  await exchange.cancel({
    cancels: oids.map((oid) => ({ a: marketMeta.assetId, o: oid })),
  });
}

