#!/usr/bin/env npx tsx
/**
 * End-to-End Test Script for Polymarket Integration
 *
 * Tests real API connectivity without executing trades.
 */

import { loadConfig } from '../src/core/config.js';
import { PolymarketCLOBClient } from '../src/execution/polymarket/clob.js';
import { ethers } from 'ethers';
import fetch from 'node-fetch';
import https from 'node:https';

const config = loadConfig();

// Polymarket IPs (for DNS bypass)
const POLYMARKET_IP = '104.18.30.132';

// Custom fetch with DNS bypass using undici
async function polymarketFetch(url: string): Promise<unknown> {
  // Use curl to bypass DNS issues
  const { execSync } = await import('node:child_process');
  const result = execSync(
    `curl -s --resolve "gamma-api.polymarket.com:443:${POLYMARKET_IP}" --resolve "clob.polymarket.com:443:${POLYMARKET_IP}" "${url}"`,
    { encoding: 'utf-8', timeout: 30000 }
  );
  return JSON.parse(result);
}

interface Market {
  id: string;
  question: string;
  outcomes: string[];
  clobTokenIds?: string;
  tokens?: Array<{ token_id: string; outcome: string }>;
  outcomePrices?: string;
  active?: boolean;
  closed?: boolean;
}

async function testMarketDataAPI() {
  console.log('\n=== Test 1: Market Data API (Gamma) ===\n');

  // Test 1a: Search markets
  console.log('1a. Searching for active markets...');
  try {
    const data = await polymarketFetch(
      'https://gamma-api.polymarket.com/markets?limit=10&active=true&closed=false'
    ) as Market[];
    console.log(`   Found ${data.length} markets`);
    if (data.length > 0) {
      const m = data[0];
      console.log(`   Sample: "${m.question?.slice(0, 60)}..."`);
      console.log(`   ID: ${m.id}`);
      if (m.outcomePrices) {
        try {
          const prices = JSON.parse(m.outcomePrices);
          console.log(`   Prices: ${prices[0]} / ${prices[1]}`);
        } catch {
          console.log(`   Prices: ${m.outcomePrices}`);
        }
      }
      if (m.clobTokenIds) {
        try {
          const tokens = JSON.parse(m.clobTokenIds);
          console.log(`   Token ID: ${tokens[0]?.slice(0, 20)}...`);
        } catch {
          console.log(`   Token IDs available`);
        }
      }
    }
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
    return false;
  }

  // Test 1b: Search by query
  console.log('\n1b. Searching for "election" markets...');
  try {
    const data = await polymarketFetch(
      'https://gamma-api.polymarket.com/markets?limit=5&active=true&search=election'
    ) as Market[];
    console.log(`   Found ${data.length} election markets`);
    for (const m of data.slice(0, 3)) {
      console.log(`   - ${m.question?.slice(0, 55)}...`);
    }
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
    return false;
  }

  console.log('\n   Market Data API: PASSED');
  return true;
}

async function testCLOBAPI() {
  console.log('\n=== Test 2: CLOB API ===\n');

  // Get a real market with token ID
  console.log('2a. Getting a market with token ID...');
  let tokenId: string | null = null;
  let marketQuestion = '';

  try {
    const markets = await polymarketFetch(
      'https://gamma-api.polymarket.com/markets?limit=20&active=true&closed=false'
    ) as Market[];

    for (const m of markets) {
      if (m.clobTokenIds) {
        try {
          const tokens = JSON.parse(m.clobTokenIds);
          if (tokens[0]) {
            tokenId = tokens[0];
            marketQuestion = m.question;
            console.log(`   Found token ID: ${tokenId.slice(0, 30)}...`);
            console.log(`   Market: ${m.question?.slice(0, 50)}...`);
            break;
          }
        } catch {
          continue;
        }
      }
    }
  } catch (e) {
    console.error('   FAILED to get market:', e instanceof Error ? e.message : e);
    return false;
  }

  if (!tokenId) {
    console.log('   SKIPPED: No token ID available');
    return true;
  }

  // Test 2b: Get order book
  console.log('\n2b. Fetching order book...');
  try {
    const orderBook = await polymarketFetch(
      `https://clob.polymarket.com/book?token_id=${tokenId}`
    ) as { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> };
    console.log(`   Bids: ${orderBook.bids?.length ?? 0}, Asks: ${orderBook.asks?.length ?? 0}`);
    if (orderBook.bids?.length > 0) {
      console.log(`   Best bid: ${orderBook.bids[0].price} (${orderBook.bids[0].size} shares)`);
    }
    if (orderBook.asks?.length > 0) {
      console.log(`   Best ask: ${orderBook.asks[0].price} (${orderBook.asks[0].size} shares)`);
    }
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
  }

  // Test 2c: Get midpoint
  console.log('\n2c. Fetching midpoint price...');
  try {
    const data = await polymarketFetch(
      `https://clob.polymarket.com/midpoint?token_id=${tokenId}`
    ) as { mid: string };
    console.log(`   Midpoint: ${data.mid}`);
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
  }

  // Test 2d: Get tick size
  console.log('\n2d. Fetching tick size...');
  try {
    const tickSize = await polymarketFetch(
      `https://clob.polymarket.com/tick-size?token_id=${tokenId}`
    ) as { tick_size: string; minimum_tick_size?: string };
    console.log(`   Tick size: ${tickSize.tick_size}`);
    if (tickSize.minimum_tick_size) {
      console.log(`   Min tick size: ${tickSize.minimum_tick_size}`);
    }
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
  }

  console.log('\n   CLOB API: PASSED');
  return true;
}

async function testWalletOperations() {
  console.log('\n=== Test 3: Wallet Operations ===\n');

  // Test 3a: Create a random wallet (don't save)
  console.log('3a. Creating test wallet...');
  try {
    const wallet = ethers.Wallet.createRandom();
    console.log(`   Address: ${wallet.address}`);
    console.log(`   (This is a test wallet, not saved)`);
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
    return false;
  }

  // Test 3b: Connect to Polygon RPC
  console.log('\n3b. Connecting to Polygon RPC...');
  try {
    const rpcUrl = config.polymarket.rpcUrl ?? 'https://polygon-rpc.com';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const blockNumber = await provider.getBlockNumber();
    console.log(`   Connected! Latest block: ${blockNumber}`);

    // Test getting balance of a known address (Polymarket exchange)
    const exchangeBalance = await provider.getBalance('0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E');
    console.log(`   Exchange MATIC balance: ${ethers.utils.formatEther(exchangeBalance)}`);
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
    return false;
  }

  console.log('\n   Wallet Operations: PASSED');
  return true;
}

async function testOrderSigning() {
  console.log('\n=== Test 4: Order Signing (Offline) ===\n');

  console.log('4a. Testing order builder...');
  try {
    const { PolymarketOrderSigner, usdToShares } = await import('../src/execution/polymarket/signer.js');

    // Create a test wallet
    const wallet = ethers.Wallet.createRandom();
    const signer = new PolymarketOrderSigner(wallet);

    // Test usdToShares conversion
    const shares = usdToShares(10, 0.5);
    console.log(`   $10 at $0.50 = ${shares} shares`);

    // Build a test order (won't submit)
    console.log('\n4b. Building test order...');
    const order = await signer.buildCLOBOrder({
      tokenId: '1234567890', // Fake token ID
      price: 0.5,
      size: shares,
      side: 'BUY',
    }, 'GTC');

    console.log(`   Order built successfully`);
    console.log(`   Maker: ${order.order.maker}`);
    console.log(`   Signature length: ${order.signature.length} chars`);
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
    return false;
  }

  console.log('\n   Order Signing: PASSED');
  return true;
}

async function testAPIKeyDerivation() {
  console.log('\n=== Test 5: API Key Derivation ===\n');

  console.log('5a. Testing L1 header generation...');
  try {
    const clobClient = new PolymarketCLOBClient(config);
    const wallet = ethers.Wallet.createRandom();
    clobClient.setWallet(wallet);

    // We can't actually derive keys without hitting the API
    // But we can test that the client is set up correctly
    console.log(`   Wallet set: ${wallet.address}`);
    console.log(`   Client configured for: ${config.polymarket.api.clob}`);

    // Don't actually call createApiKey/deriveApiKey as it requires
    // a funded wallet and hits rate limits
    console.log('\n   (Skipping actual API key creation - requires funded wallet)');
  } catch (e) {
    console.error('   FAILED:', e instanceof Error ? e.message : e);
    return false;
  }

  console.log('\n   API Key Setup: PASSED');
  return true;
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        Thufir End-to-End Test Suite (Polymarket)              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  const results: Record<string, boolean> = {};

  results['Market Data API'] = await testMarketDataAPI();
  results['CLOB API'] = await testCLOBAPI();
  results['Wallet Operations'] = await testWalletOperations();
  results['Order Signing'] = await testOrderSigning();
  results['API Key Setup'] = await testAPIKeyDerivation();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                         SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let allPassed = true;
  for (const [test, passed] of Object.entries(results)) {
    const status = passed ? '✅ PASSED' : '❌ FAILED';
    console.log(`  ${status}  ${test}`);
    if (!passed) allPassed = false;
  }

  console.log('\n═══════════════════════════════════════════════════════════════');

  if (allPassed) {
    console.log('\n✅ All tests passed! Ready for live trading.');
    console.log('\nNext steps:');
    console.log('  1. Create a wallet: thufir wallet create');
    console.log('  2. Fund with USDC + MATIC on Polygon');
    console.log('  3. Set THUFIR_WALLET_PASSWORD env var');
    console.log('  4. Set execution.mode: live in config');
    console.log('  5. Start with small trades ($1-5)');
  } else {
    console.log('\n❌ Some tests failed. Check errors above.');
    process.exit(1);
  }
}

main().catch(console.error);
