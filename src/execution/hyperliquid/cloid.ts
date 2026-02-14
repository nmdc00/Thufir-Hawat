import { randomBytes } from 'node:crypto';

/**
 * Hyperliquid client order id ("cloid") must be a 16-byte hex string: `0x` + 32 hex chars.
 */
export function createHyperliquidCloid(): string {
  return `0x${randomBytes(16).toString('hex')}`;
}

