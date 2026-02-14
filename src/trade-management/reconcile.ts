import type { ThufirConfig } from '../core/config.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';

export async function reconcileEntryFill(params: {
  config: ThufirConfig;
  symbol: string;
  entryCloid: string;
  startTimeMs: number;
}): Promise<{ avgPx: number | null; feesUsd: number; closedPnlUsd: number | null }> {
  if (params.config.execution?.mode !== 'live') {
    return { avgPx: null, feesUsd: 0, closedPnlUsd: null };
  }
  if (params.config.execution?.provider !== 'hyperliquid') {
    return { avgPx: null, feesUsd: 0, closedPnlUsd: null };
  }
  const client = new HyperliquidClient(params.config);
  const fills = await client
    .getUserFillsByTime({
      startTimeMs: params.startTimeMs - 30_000,
      endTimeMs: Date.now() + 5_000,
      aggregateByTime: true,
    })
    .catch(() => []);

  const sym = params.symbol.trim().toUpperCase();
  const matches = Array.isArray(fills)
    ? fills
        .filter((f: any) => String(f.cloid ?? '') === params.entryCloid)
        .filter((f: any) => String(f.coin ?? '').trim().toUpperCase() === sym)
    : [];

  const totalSz = matches.reduce((sum: number, f: any) => sum + Number(f.sz ?? 0), 0);
  if (!(totalSz > 0)) return { avgPx: null, feesUsd: 0, closedPnlUsd: null };

  const pxSz = matches.reduce((sum: number, f: any) => sum + Number(f.px ?? 0) * Number(f.sz ?? 0), 0);
  const avgPx = pxSz / totalSz;
  const feesUsd = matches.reduce((sum: number, f: any) => sum + Number(f.fee ?? 0), 0);
  const closedPnlUsd = matches.reduce((sum: number, f: any) => sum + Number(f.closedPnl ?? 0), 0);

  return {
    avgPx: Number.isFinite(avgPx) && avgPx > 0 ? avgPx : null,
    feesUsd: Number.isFinite(feesUsd) ? feesUsd : 0,
    closedPnlUsd: Number.isFinite(closedPnlUsd) ? closedPnlUsd : null,
  };
}

