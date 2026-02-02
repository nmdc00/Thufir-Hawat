/**
 * Polymarket Order Signer
 *
 * Uses @polymarket/order-utils ExchangeOrderBuilder to create and sign orders
 * for the Polymarket CLOB.
 */

import { ethers } from 'ethers';
import { ExchangeOrderBuilder, Side, SignatureType } from '@polymarket/order-utils';

import type { SignedOrder, OrderData } from '@polymarket/order-utils';
import type { CLOBOrderPayload } from './clob.js';

// ============================================================================
// Constants
// ============================================================================

// Polymarket contract addresses on Polygon
export const EXCHANGE_ADDRESSES = {
  CTF_EXCHANGE: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
  NEG_RISK_CTF_EXCHANGE: '0xc5d563a36ae78145c45a50134d48a1215220f80a',
  NEG_RISK_ADAPTER: '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296',
} as const;

// Polygon chain ID
export const POLYGON_CHAIN_ID = 137;

// Default fee rate (0 bps)
export const DEFAULT_FEE_RATE_BPS = '0';

// Zero address for public orders
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ============================================================================
// Types
// ============================================================================

export interface OrderParams {
  /** Token ID of the CTF asset */
  tokenId: string;
  /** Price per share (0-1) */
  price: number;
  /** Size in shares (not USD) */
  size: number;
  /** Buy or sell */
  side: 'BUY' | 'SELL';
  /** Use negative risk exchange (for markets with neg risk) */
  negRisk?: boolean;
  /** Order expiration timestamp (seconds). 0 = no expiration */
  expiration?: number;
  /** Fee rate in basis points */
  feeRateBps?: string;
}

export interface BuilderContext {
  wallet: ethers.Wallet;
  negRisk?: boolean;
}

// ============================================================================
// Order Signer
// ============================================================================

export class PolymarketOrderSigner {
  private wallet: ethers.Wallet;
  private ctfBuilder: ExchangeOrderBuilder;
  private negRiskBuilder: ExchangeOrderBuilder;

  constructor(wallet: ethers.Wallet) {
    this.wallet = wallet;

    // Create builders for both exchange types
    this.ctfBuilder = new ExchangeOrderBuilder(
      EXCHANGE_ADDRESSES.CTF_EXCHANGE,
      POLYGON_CHAIN_ID,
      wallet
    );

    this.negRiskBuilder = new ExchangeOrderBuilder(
      EXCHANGE_ADDRESSES.NEG_RISK_CTF_EXCHANGE,
      POLYGON_CHAIN_ID,
      wallet
    );
  }

  /**
   * Get the wallet address.
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Build and sign an order.
   */
  async buildSignedOrder(params: OrderParams): Promise<SignedOrder> {
    const builder = params.negRisk ? this.negRiskBuilder : this.ctfBuilder;

    // Convert price and size to maker/taker amounts
    // For BUY: maker pays USDC, receives shares
    // For SELL: maker pays shares, receives USDC
    const { makerAmount, takerAmount } = this.calculateAmounts(
      params.price,
      params.size,
      params.side
    );

    const orderData: OrderData = {
      maker: this.wallet.address,
      taker: ZERO_ADDRESS, // Public order
      tokenId: params.tokenId,
      makerAmount,
      takerAmount,
      side: params.side === 'BUY' ? Side.BUY : Side.SELL,
      feeRateBps: params.feeRateBps ?? DEFAULT_FEE_RATE_BPS,
      nonce: '0', // Using salt for uniqueness
      expiration: params.expiration ? String(params.expiration) : '0',
      signatureType: SignatureType.EOA,
    };

    return builder.buildSignedOrder(orderData);
  }

  /**
   * Build a signed order and format it for CLOB submission.
   */
  async buildCLOBOrder(
    params: OrderParams,
    orderType: 'GTC' | 'GTD' | 'FOK' = 'GTC'
  ): Promise<CLOBOrderPayload> {
    const signedOrder = await this.buildSignedOrder(params);

    return {
      order: {
        salt: signedOrder.salt,
        maker: signedOrder.maker,
        signer: signedOrder.signer,
        taker: signedOrder.taker,
        tokenId: signedOrder.tokenId,
        makerAmount: signedOrder.makerAmount,
        takerAmount: signedOrder.takerAmount,
        expiration: signedOrder.expiration,
        nonce: signedOrder.nonce,
        feeRateBps: signedOrder.feeRateBps,
        side: signedOrder.side,
        signatureType: signedOrder.signatureType,
        signature: signedOrder.signature,
      },
      signature: signedOrder.signature,
      orderType,
    };
  }

  /**
   * Calculate maker and taker amounts from price and size.
   *
   * Polymarket uses 6 decimal USDC and integer shares.
   * Price is expressed as a decimal between 0 and 1.
   *
   * For a BUY order at price P for S shares:
   *   - makerAmount = P * S (USDC to pay, in wei = * 1e6)
   *   - takerAmount = S (shares to receive)
   *
   * For a SELL order at price P for S shares:
   *   - makerAmount = S (shares to sell)
   *   - takerAmount = P * S (USDC to receive, in wei = * 1e6)
   */
  private calculateAmounts(
    price: number,
    size: number,
    side: 'BUY' | 'SELL'
  ): { makerAmount: string; takerAmount: string } {
    // USDC has 6 decimals
    const USDC_DECIMALS = 6;
    const usdcMultiplier = 10 ** USDC_DECIMALS;

    // Price is 0-1, size is in shares
    const usdcAmount = Math.floor(price * size * usdcMultiplier);
    const sharesAmount = Math.floor(size * usdcMultiplier); // Shares also use 6 decimals

    if (side === 'BUY') {
      return {
        makerAmount: String(usdcAmount),
        takerAmount: String(sharesAmount),
      };
    } else {
      return {
        makerAmount: String(sharesAmount),
        takerAmount: String(usdcAmount),
      };
    }
  }

  /**
   * Calculate the price from an order's maker/taker amounts.
   */
  static priceFromAmounts(
    makerAmount: string,
    takerAmount: string,
    side: 'BUY' | 'SELL'
  ): number {
    const maker = BigInt(makerAmount);
    const taker = BigInt(takerAmount);

    if (side === 'BUY') {
      // BUY: makerAmount is USDC, takerAmount is shares
      return Number(maker) / Number(taker);
    } else {
      // SELL: makerAmount is shares, takerAmount is USDC
      return Number(taker) / Number(maker);
    }
  }

  /**
   * Calculate size from an order's amounts.
   */
  static sizeFromAmounts(
    makerAmount: string,
    takerAmount: string,
    side: 'BUY' | 'SELL'
  ): number {
    const USDC_DECIMALS = 6;

    if (side === 'BUY') {
      // takerAmount is shares
      return Number(takerAmount) / 10 ** USDC_DECIMALS;
    } else {
      // makerAmount is shares
      return Number(makerAmount) / 10 ** USDC_DECIMALS;
    }
  }

  /**
   * Validate order parameters.
   */
  static validateParams(params: OrderParams): { valid: boolean; error?: string } {
    if (!params.tokenId || params.tokenId.length === 0) {
      return { valid: false, error: 'Token ID is required' };
    }

    if (params.price <= 0 || params.price >= 1) {
      return { valid: false, error: 'Price must be between 0 and 1 (exclusive)' };
    }

    if (params.size <= 0) {
      return { valid: false, error: 'Size must be positive' };
    }

    if (params.side !== 'BUY' && params.side !== 'SELL') {
      return { valid: false, error: 'Side must be BUY or SELL' };
    }

    return { valid: true };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert USD amount to shares at a given price.
 */
export function usdToShares(usdAmount: number, price: number): number {
  if (price <= 0 || price >= 1) {
    throw new Error('Price must be between 0 and 1');
  }
  return usdAmount / price;
}

/**
 * Convert shares to USD at a given price.
 */
export function sharesToUsd(shares: number, price: number): number {
  return shares * price;
}

/**
 * Calculate potential payout for a position.
 */
export function calculatePayout(shares: number, outcome: 'YES' | 'NO', resolved: 'YES' | 'NO'): number {
  if (outcome === resolved) {
    // Winner: each share pays $1
    return shares;
  } else {
    // Loser: shares are worthless
    return 0;
  }
}

/**
 * Calculate profit/loss for a trade.
 */
export function calculatePnL(
  shares: number,
  entryPrice: number,
  exitPrice: number,
  side: 'BUY' | 'SELL'
): number {
  const priceDiff = exitPrice - entryPrice;
  return side === 'BUY' ? shares * priceDiff : -shares * priceDiff;
}
