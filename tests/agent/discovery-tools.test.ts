import { describe, it, expect } from 'vitest';

import { discoveryTools } from '../../src/agent/tools/adapters/discovery-tools.js';

describe('discovery tools', () => {
  it('includes perp and signal tools', () => {
    const names = discoveryTools.map((t) => t.name);
    expect(names).toContain('perp_place_order');
    expect(names).toContain('perp_open_orders');
    expect(names).toContain('perp_cancel_order');
    expect(names).toContain('perp_positions');
    expect(names).toContain('signal_price_vol_regime');
    expect(names).toContain('signal_cross_asset_divergence');
    expect(names).toContain('signal_hyperliquid_funding_oi_skew');
    expect(names).toContain('signal_hyperliquid_orderflow_imbalance');
    expect(names).toContain('discovery_run');
  });
});
