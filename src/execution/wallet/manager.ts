import { ethers } from 'ethers';

import type { ThufirConfig } from '../../core/config.js';
import { decryptPrivateKey, loadKeystore } from './keystore.js';

export function loadWallet(config: ThufirConfig, password: string): ethers.Wallet {
  const path =
    config.wallet?.keystorePath ??
    process.env.THUFIR_KEYSTORE_PATH ??
    `${process.env.HOME ?? ''}/.thufir/keystore.json`;
  const store = loadKeystore(path);
  const privateKey = decryptPrivateKey(store, password);
  const provider = config.polymarket?.rpcUrl
    ? new ethers.providers.JsonRpcProvider(config.polymarket.rpcUrl)
    : undefined;
  return new ethers.Wallet(privateKey, provider);
}
