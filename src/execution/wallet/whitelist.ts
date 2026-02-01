/**
 * Polymarket Address Whitelist
 *
 * CRITICAL SECURITY COMPONENT
 *
 * This file contains the ONLY addresses that Thufir is allowed to interact with.
 * These addresses are HARDCODED and should NEVER be made configurable.
 *
 * Before ANY transaction is signed, the destination address MUST be checked
 * against this whitelist. If not whitelisted, the transaction MUST be rejected.
 */

/**
 * Whitelisted Polymarket contract addresses on Polygon.
 *
 * DO NOT MODIFY without thorough security review.
 * DO NOT add arbitrary addresses.
 * DO NOT make this configurable.
 */
export const POLYMARKET_WHITELIST = Object.freeze([
  // Polymarket CTF Exchange (main trading contract)
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',

  // Polymarket Neg Risk CTF Exchange
  '0xc5d563a36ae78145c45a50134d48a1215220f80a',

  // Polymarket Neg Risk Adapter
  '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296',

  // USDC on Polygon (for token approvals)
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',

  // USDC.e (bridged USDC) on Polygon
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
]);

/**
 * Check if an address is in the whitelist.
 *
 * @param address - The address to check (will be lowercased)
 * @returns true if the address is whitelisted, false otherwise
 *
 * @example
 * ```typescript
 * if (!isWhitelisted(transaction.to)) {
 *   throw new SecurityError('Destination address not whitelisted');
 * }
 * ```
 */
export function isWhitelisted(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  const normalized = address.toLowerCase().trim();

  // Must be a valid Ethereum address format
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    return false;
  }

  return POLYMARKET_WHITELIST.includes(normalized);
}

/**
 * Assert that an address is whitelisted.
 * Throws if not whitelisted.
 *
 * @param address - The address to check
 * @param context - Optional context for error message
 * @throws SecurityError if address is not whitelisted
 */
export function assertWhitelisted(address: string, context?: string): void {
  if (!isWhitelisted(address)) {
    const ctx = context ? ` (${context})` : '';
    throw new WhitelistError(
      `Address ${address} is not whitelisted${ctx}. ` +
        'Thufir can only interact with Polymarket contracts.'
    );
  }
}

/**
 * Error thrown when an address is not whitelisted.
 */
export class WhitelistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhitelistError';
  }
}

/**
 * Get all whitelisted addresses (for display purposes only).
 *
 * @returns A copy of the whitelist array
 */
export function getWhitelistedAddresses(): readonly string[] {
  return [...POLYMARKET_WHITELIST];
}

/**
 * Get human-readable descriptions of whitelisted addresses.
 */
export function getWhitelistDescriptions(): Array<{
  address: string;
  description: string;
}> {
  return [
    {
      address: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
      description: 'Polymarket CTF Exchange',
    },
    {
      address: '0xc5d563a36ae78145c45a50134d48a1215220f80a',
      description: 'Polymarket Neg Risk CTF Exchange',
    },
    {
      address: '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296',
      description: 'Polymarket Neg Risk Adapter',
    },
    {
      address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
      description: 'USDC on Polygon',
    },
    {
      address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      description: 'USDC.e (bridged) on Polygon',
    },
  ];
}
