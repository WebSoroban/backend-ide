/**
 * Central Stellar network configuration — the single source of truth for
 * testnet vs mainnet. Every deploy/invoke/balance call resolves its rpc,
 * passphrase, horizon, and explorer from here, keyed by NetworkId.
 *
 * A Stellar keypair is the SAME address on both networks; only funding and the
 * rpc/passphrase differ. Compile is network-agnostic (same wasm).
 *
 * NOTE: SDF runs NO public mainnet Soroban RPC. MAINNET_SOROBAN_RPC_URL must
 * point at a provider endpoint (the default below is a community gateway).
 */
import { Networks } from '@stellar/stellar-sdk';

export type NetworkId = 'testnet' | 'mainnet';

export const NETWORK_IDS: NetworkId[] = ['testnet', 'mainnet'];

export interface NetworkConfig {
  id: NetworkId;
  label: string;
  passphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  /** stellar.expert explorer base (…/explorer/testnet | …/explorer/public) */
  explorerBase: string;
  /** 'friendbot' on testnet, null on mainnet (no faucet — real XLM). */
  faucet: 'friendbot' | null;
  friendbotUrl?: string;
}

const TESTNET: NetworkConfig = {
  id: 'testnet',
  label: 'Testnet',
  passphrase: Networks.TESTNET,
  rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  explorerBase: 'https://stellar.expert/explorer/testnet',
  faucet: 'friendbot',
  friendbotUrl: 'https://friendbot.stellar.org',
};

const MAINNET: NetworkConfig = {
  id: 'mainnet',
  label: 'Mainnet',
  passphrase: Networks.PUBLIC,
  // SDF runs no public mainnet RPC — this must be a configurable provider.
  rpcUrl: process.env.MAINNET_SOROBAN_RPC_URL || 'https://mainnet.sorobanrpc.com',
  horizonUrl: process.env.MAINNET_HORIZON_URL || 'https://horizon.stellar.org',
  explorerBase: 'https://stellar.expert/explorer/public',
  faucet: null,
};

const NETWORKS: Record<NetworkId, NetworkConfig> = { testnet: TESTNET, mainnet: MAINNET };

export function isNetworkId(x: any): x is NetworkId {
  return x === 'testnet' || x === 'mainnet';
}

/** Resolve a network config, defaulting to testnet for anything unrecognized. */
export function getNetwork(id: any): NetworkConfig {
  return isNetworkId(id) ? NETWORKS[id] : TESTNET;
}

/** Coerce arbitrary input to a valid NetworkId (defaults to testnet). */
export function coerceNetwork(id: any): NetworkId {
  return isNetworkId(id) ? id : 'testnet';
}

export const explorerTx = (id: NetworkId, hash: string) => `${getNetwork(id).explorerBase}/tx/${hash}`;
export const explorerContract = (id: NetworkId, c: string) => `${getNetwork(id).explorerBase}/contract/${c}`;
export const explorerAccount = (id: NetworkId, a: string) => `${getNetwork(id).explorerBase}/account/${a}`;

export default { getNetwork, coerceNetwork, isNetworkId, explorerTx, explorerContract, explorerAccount, NETWORK_IDS };
