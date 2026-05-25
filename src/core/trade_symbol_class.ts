export function inferTradeSymbolClass(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'BTC' || normalized.endsWith('BTC')) return 'major';
  if (
    normalized === 'ETH' ||
    normalized.endsWith('ETH') ||
    normalized === 'SOL' ||
    normalized.endsWith('SOL')
  ) {
    return 'liquid_alt';
  }
  if (normalized.startsWith('XYZ:')) {
    return normalized.endsWith('COIN') || normalized.endsWith('MSTR') ? 'equity_proxy' : 'macro_contract';
  }
  if (normalized.startsWith('FLX:')) return 'alt_perp';
  if (normalized.includes('/')) return 'spot_pair';
  return 'alt';
}
