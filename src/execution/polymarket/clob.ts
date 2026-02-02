/**
 * Polymarket CLOB (Central Limit Order Book) Client
 *
 * Handles all interactions with the Polymarket CLOB API for order submission,
 * order book queries, and order management.
 */

import fetch from 'node-fetch';
import { ethers } from 'ethers';

import type { ThufirConfig } from '../../core/config.js';

// ============================================================================
// Types
// ============================================================================

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBookResponse {
  market: string;
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  hash: string;
  timestamp: string;
}

export interface OpenOrder {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  original_size: string;
  size_matched: string;
  price: string;
  status: 'LIVE' | 'MATCHED' | 'CANCELLED';
  created_at: number;
  expiration: number;
  order_type: string;
}

export interface Trade {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  fee_rate_bps: string;
  status: string;
  created_at: number;
  match_time: number;
  transaction_hash?: string;
}

export interface CLOBOrderPayload {
  order: {
    salt: string;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    expiration: string;
    nonce: string;
    feeRateBps: string;
    side: number;
    signatureType: number;
  };
  signature: string;
  owner: string;
  orderType: 'GTC' | 'GTD' | 'FOK';
}

export interface CLOBOrderResponse {
  success: boolean;
  orderID?: string;
  errorMsg?: string;
  transactionsHashes?: string[];
  status?: string;
}

export interface ApiKeyCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface TickSize {
  tickSize: string;
  minOrderSize: string;
}

export interface CLOBMarketToken {
  token_id: string;
  outcome: string;
  price?: string;
  winner?: boolean;
}

export interface CLOBMarket {
  condition_id: string;
  question_id?: string;
  tokens: CLOBMarketToken[];
  neg_risk?: boolean;
  min_tick_size?: string;
  min_order_size?: string;
  rewards?: {
    rates: Array<{ asset_address: string; rewards_daily_rate: number }>;
    min_size: string;
    max_spread: string;
  };
}

// ============================================================================
// CLOB Client
// ============================================================================

export class PolymarketCLOBClient {
  private clobUrl: string;
  private credentials?: ApiKeyCredentials;
  private wallet?: ethers.Wallet;

  constructor(config: ThufirConfig) {
    this.clobUrl = config.polymarket.api.clob.replace(/\/$/, '');
  }

  /**
   * Set API credentials for authenticated endpoints.
   */
  setCredentials(credentials: ApiKeyCredentials): void {
    this.credentials = credentials;
  }

  /**
   * Set wallet for signing API requests.
   */
  setWallet(wallet: ethers.Wallet): void {
    this.wallet = wallet;
  }

  /**
   * Get the address of the connected wallet.
   */
  getAddress(): string | undefined {
    return this.wallet?.address;
  }

  // ==========================================================================
  // Public Endpoints (no auth required)
  // ==========================================================================

  /**
   * Get the order book for a specific token.
   */
  async getOrderBook(tokenId: string): Promise<OrderBookResponse> {
    const url = `${this.clobUrl}/book`;
    const response = await fetch(`${url}?token_id=${tokenId}`);

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch order book: ${response.status}`, response.status);
    }

    return (await response.json()) as OrderBookResponse;
  }

  /**
   * Get the midpoint price for a token.
   */
  async getMidpoint(tokenId: string): Promise<string> {
    const url = `${this.clobUrl}/midpoint`;
    const response = await fetch(`${url}?token_id=${tokenId}`);

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch midpoint: ${response.status}`, response.status);
    }

    const data = (await response.json()) as { mid: string };
    return data.mid;
  }

  /**
   * Get the spread for a token.
   */
  async getSpread(tokenId: string): Promise<{ bid: string; ask: string; spread: string }> {
    const url = `${this.clobUrl}/spread`;
    const response = await fetch(`${url}?token_id=${tokenId}`);

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch spread: ${response.status}`, response.status);
    }

    return (await response.json()) as { bid: string; ask: string; spread: string };
  }

  /**
   * Get tick size for a token.
   */
  async getTickSize(tokenId: string): Promise<TickSize> {
    const url = `${this.clobUrl}/tick-size`;
    const response = await fetch(`${url}?token_id=${tokenId}`);

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch tick size: ${response.status}`, response.status);
    }

    return (await response.json()) as TickSize;
  }

  /**
   * Get the best bid/ask prices.
   */
  async getPrice(tokenId: string): Promise<{ bid: string; ask: string }> {
    const url = `${this.clobUrl}/price`;
    const response = await fetch(`${url}?token_id=${tokenId}`);

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch price: ${response.status}`, response.status);
    }

    return (await response.json()) as { bid: string; ask: string };
  }

  /**
   * Get market details from CLOB API including token IDs.
   * This is the authoritative source for token IDs needed for order placement.
   */
  async getMarket(conditionId: string): Promise<CLOBMarket> {
    const url = `${this.clobUrl}/markets/${conditionId}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch market: ${response.status}`, response.status);
    }

    return (await response.json()) as CLOBMarket;
  }

  /**
   * List markets from CLOB API.
   * Returns markets with full token information.
   */
  async listMarkets(next_cursor?: string): Promise<{ data: CLOBMarket[]; next_cursor?: string }> {
    const url = new URL(`${this.clobUrl}/markets`);
    if (next_cursor) {
      url.searchParams.set('next_cursor', next_cursor);
    }
    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new CLOBError(`Failed to list markets: ${response.status}`, response.status);
    }

    return (await response.json()) as { data: CLOBMarket[]; next_cursor?: string };
  }

  /**
   * Get token IDs for a market condition.
   * Convenience method that extracts just the token IDs from market data.
   * Returns [yesTokenId, noTokenId] or null if not found.
   */
  async getTokenIds(conditionId: string): Promise<[string, string] | null> {
    try {
      const market = await this.getMarket(conditionId);
      if (!market.tokens || market.tokens.length < 2) {
        return null;
      }

      // Find Yes and No tokens
      const yesToken = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
      const noToken = market.tokens.find(t => t.outcome.toLowerCase() === 'no');

      if (yesToken && noToken) {
        return [yesToken.token_id, noToken.token_id];
      }

      // Fallback: assume first two tokens are Yes/No in order
      const tokens = market.tokens;
      if (tokens[0] && tokens[1]) {
        return [tokens[0].token_id, tokens[1].token_id];
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a market is negative risk.
   */
  async isNegRiskMarket(conditionId: string): Promise<boolean> {
    try {
      const market = await this.getMarket(conditionId);
      return market.neg_risk === true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Authenticated Endpoints
  // ==========================================================================

  /**
   * Generate L1 authentication headers (EIP-712 wallet signature).
   * Used for API key creation.
   */
  private async generateL1Headers(nonce?: number): Promise<Record<string, string>> {
    if (!this.wallet) {
      throw new CLOBError('Wallet not set', 0);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const actualNonce = nonce ?? 0;

    // EIP-712 domain for Polymarket CLOB auth
    const domain = {
      name: 'ClobAuthDomain',
      version: '1',
      chainId: 137, // Polygon
    };

    // EIP-712 types
    const types = {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    };

    // Message to sign
    const value = {
      address: this.wallet.address,
      timestamp: String(timestamp),
      nonce: actualNonce,
      message: 'This message attests that I control the given wallet',
    };

    // Sign with EIP-712 typed data
    const signature = await this.wallet._signTypedData(domain, types, value);

    return {
      'POLY_ADDRESS': this.wallet.address,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': String(timestamp),
      'POLY_NONCE': String(actualNonce),
    };
  }

  /**
   * Generate L2 authentication headers (API key HMAC).
   * Used for trading endpoints.
   */
  private generateL2Headers(
    method: string,
    path: string,
    body?: string
  ): Record<string, string> {
    if (!this.credentials) {
      throw new CLOBError('API credentials not set', 0);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    // Body needs single quotes replaced with double quotes for cross-language compatibility
    const normalizedBody = body?.replace(/'/g, '"') ?? '';
    const message = `${timestamp}${method}${path}${normalizedBody}`;

    console.log('[CLOB L2] Message to sign:', message);
    console.log('[CLOB L2] Secret (first 10 chars):', this.credentials.secret.slice(0, 10));

    // Decode base64url secret before using as HMAC key
    const secretBytes = Buffer.from(this.credentials.secret, 'base64url');

    // HMAC signature using decoded secret
    const hmac = ethers.utils.computeHmac(
      ethers.utils.SupportedAlgorithm.sha256,
      secretBytes,
      ethers.utils.toUtf8Bytes(message)
    );
    // Convert to base64url encoding
    const signature = Buffer.from(hmac.slice(2), 'hex').toString('base64url');

    console.log('[CLOB L2] Signature:', signature);

    const headers = {
      'POLY_ADDRESS': this.wallet?.address ?? '',
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': String(timestamp),
      'POLY_API_KEY': this.credentials.apiKey,
      'POLY_PASSPHRASE': this.credentials.passphrase,
    };
    console.log('[CLOB L2] Headers:', JSON.stringify(headers, null, 2));
    return headers;
  }

  /**
   * Create or derive API key credentials.
   */
  async createApiKey(nonce?: number): Promise<ApiKeyCredentials> {
    if (!this.wallet) {
      throw new CLOBError('Wallet not set', 0);
    }

    const headers = await this.generateL1Headers(nonce);
    const url = `${this.clobUrl}/auth/api-key`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new CLOBError(`Failed to create API key: ${response.status} - ${text}`, response.status);
    }

    const data = await response.json();
    console.log('[CLOB] Create API key response:', JSON.stringify(data, null, 2));
    this.credentials = data as ApiKeyCredentials;
    return data as ApiKeyCredentials;
  }

  /**
   * Derive API key (deterministic based on wallet).
   */
  async deriveApiKey(nonce?: number): Promise<ApiKeyCredentials> {
    if (!this.wallet) {
      throw new CLOBError('Wallet not set', 0);
    }

    const headers = await this.generateL1Headers(nonce);
    const url = `${this.clobUrl}/auth/derive-api-key`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new CLOBError(`Failed to derive API key: ${response.status} - ${text}`, response.status);
    }

    const data = await response.json();
    console.log('[CLOB] Derive API key response:', JSON.stringify(data, null, 2));
    this.credentials = data as ApiKeyCredentials;
    return data as ApiKeyCredentials;
  }

  /**
   * Submit a signed order to the CLOB.
   */
  async postOrder(payload: CLOBOrderPayload): Promise<CLOBOrderResponse> {
    const path = '/order';
    const body = JSON.stringify(payload);
    const headers = this.generateL2Headers('POST', path, body);

    const response = await fetch(`${this.clobUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    });

    const text = await response.text();
    let data: CLOBOrderResponse;
    try {
      data = JSON.parse(text) as CLOBOrderResponse;
    } catch {
      throw new CLOBError(`Order submission failed: ${response.status} - ${text}`, response.status);
    }

    if (!response.ok || !data.success) {
      throw new CLOBError(
        data.errorMsg ?? `Order submission failed: ${response.status} - ${text}`,
        response.status
      );
    }

    return data;
  }

  /**
   * Cancel an order by ID.
   */
  async cancelOrder(orderId: string): Promise<{ success: boolean }> {
    const path = '/order';
    const body = JSON.stringify({ orderID: orderId });
    const headers = this.generateL2Headers('DELETE', path, body);

    const response = await fetch(`${this.clobUrl}${path}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    });

    if (!response.ok) {
      throw new CLOBError(`Failed to cancel order: ${response.status}`, response.status);
    }

    return (await response.json()) as { success: boolean };
  }

  /**
   * Cancel all open orders.
   */
  async cancelAllOrders(): Promise<{ success: boolean }> {
    const path = '/cancel-all';
    const headers = this.generateL2Headers('DELETE', path);

    const response = await fetch(`${this.clobUrl}${path}`, {
      method: 'DELETE',
      headers: {
        ...headers,
      },
    });

    if (!response.ok) {
      throw new CLOBError(`Failed to cancel all orders: ${response.status}`, response.status);
    }

    return (await response.json()) as { success: boolean };
  }

  /**
   * Get open orders for the connected wallet.
   */
  async getOpenOrders(market?: string): Promise<OpenOrder[]> {
    const path = '/orders';
    const queryParams = market ? `?market=${market}` : '';
    const headers = this.generateL2Headers('GET', path + queryParams);

    const response = await fetch(`${this.clobUrl}${path}${queryParams}`, {
      method: 'GET',
      headers: {
        ...headers,
      },
    });

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch open orders: ${response.status}`, response.status);
    }

    return (await response.json()) as OpenOrder[];
  }

  /**
   * Get a specific order by ID.
   */
  async getOrder(orderId: string): Promise<OpenOrder> {
    const path = `/order/${orderId}`;
    const headers = this.generateL2Headers('GET', path);

    const response = await fetch(`${this.clobUrl}${path}`, {
      method: 'GET',
      headers: {
        ...headers,
      },
    });

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch order: ${response.status}`, response.status);
    }

    return (await response.json()) as OpenOrder;
  }

  /**
   * Get trade history for the connected wallet.
   */
  async getTrades(options?: {
    market?: string;
    limit?: number;
    before?: string;
    after?: string;
  }): Promise<Trade[]> {
    const path = '/trades';
    const params = new URLSearchParams();
    if (options?.market) params.set('market', options.market);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before) params.set('before', options.before);
    if (options?.after) params.set('after', options.after);

    const queryString = params.toString();
    const fullPath = queryString ? `${path}?${queryString}` : path;
    const headers = this.generateL2Headers('GET', fullPath);

    const response = await fetch(`${this.clobUrl}${fullPath}`, {
      method: 'GET',
      headers: {
        ...headers,
      },
    });

    if (!response.ok) {
      throw new CLOBError(`Failed to fetch trades: ${response.status}`, response.status);
    }

    return (await response.json()) as Trade[];
  }

  /**
   * Check if the client is authenticated.
   */
  isAuthenticated(): boolean {
    return !!this.credentials && !!this.wallet;
  }
}

// ============================================================================
// Errors
// ============================================================================

export class CLOBError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'CLOBError';
  }
}
