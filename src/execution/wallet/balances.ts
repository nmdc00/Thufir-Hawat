import { ethers } from 'ethers';

import type { Balance } from '../../types/index.js';

const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'; // USDC.e (legacy)
const USDC_NATIVE_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // USDC (native)

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export async function getWalletBalances(wallet: ethers.Wallet): Promise<Balance | null> {
  if (!wallet.provider) {
    return null;
  }

  const [matic, usdcLegacy, usdcNative] = await Promise.all([
    wallet.provider.getBalance(wallet.address),
    getTokenBalance(wallet, USDC_ADDRESS),
    getTokenBalance(wallet, USDC_NATIVE_ADDRESS),
  ]);
  const totalUsdc = (usdcLegacy ?? 0) + (usdcNative ?? 0);
  const primaryUsdcAddress =
    usdcNative && usdcNative > 0
      ? USDC_NATIVE_ADDRESS
      : usdcLegacy && usdcLegacy > 0
        ? USDC_ADDRESS
        : USDC_NATIVE_ADDRESS;

  return {
    matic: Number(ethers.utils.formatEther(matic)),
    usdc: totalUsdc,
    usdcAddress: primaryUsdcAddress,
  };
}

async function getTokenBalance(wallet: ethers.Wallet, token: string): Promise<number | null> {
  if (!wallet.provider) return null;

  const contract = new ethers.Contract(token, ERC20_ABI, wallet.provider);
  const [raw, decimals] = await Promise.all([contract.balanceOf(wallet.address), contract.decimals()]);
  return Number(ethers.utils.formatUnits(raw, decimals));
}
