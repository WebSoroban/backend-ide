import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { coerceNetwork, getNetwork, type NetworkId } from '../../lib/networks';

/** USDC Stellar Asset Contract per network: the token every policy is priced in. */
export const PAYLOOP_TOKENS: Record<NetworkId, string> = {
  testnet: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  mainnet: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
};

export const USDC_DECIMALS = 7;
export const MIN_INTERVAL_SECONDS = 60;

export interface PayLoopDeployment {
  network: NetworkId;
  contractId: string;
  wasmHash: string;
  token: string;
  /** Ledger the contract was created in; the indexer starts here. */
  ledger: number;
  deployer: string;
  deployedAt: string;
}

export function deploymentFile(network: NetworkId): string {
  return path.join(process.cwd(), 'contracts', 'payloop', 'deployments', `${network}.json`);
}

export function readDeployment(network: NetworkId): PayLoopDeployment | null {
  const file = deploymentFile(network);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as PayLoopDeployment;
}

export interface PayLoopConfig {
  enabled: boolean;
  network: NetworkId;
  contractId: string;
  token: string;
  startLedger: number;
  rpcUrl: string;
  passphrase: string;
  explorerBase: string;
}

/**
 * PAYLOOP_CONTRACT_ID wins over the committed deployment manifest, so an
 * operator can point a server at a new deployment without a code change.
 */
export function payloopConfig(): PayLoopConfig {
  const network = coerceNetwork(process.env.PAYLOOP_NETWORK?.trim() || 'testnet');
  const net = getNetwork(network);
  const manifest = readDeployment(network);
  const contractId = process.env.PAYLOOP_CONTRACT_ID?.trim() || manifest?.contractId || '';
  return {
    enabled: Boolean(contractId),
    network,
    contractId,
    token: process.env.PAYLOOP_TOKEN?.trim() || manifest?.token || PAYLOOP_TOKENS[network],
    startLedger: Number(process.env.PAYLOOP_START_LEDGER) || manifest?.ledger || 0,
    rpcUrl: net.rpcUrl,
    passphrase: net.passphrase,
    explorerBase: net.explorerBase,
  };
}

/** The account that submits charges and pays their fees. It holds no customer funds. */
export function relayerKeypair(): Keypair | null {
  const secret = process.env.PAYLOOP_RELAYER_SECRET?.trim();
  return secret ? Keypair.fromSecret(secret) : null;
}

export function formatUsdc(stroops: bigint | string): string {
  const value = BigInt(stroops);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const fraction = (absolute % scale).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  const text = fraction ? `${absolute / scale}.${fraction}` : `${absolute / scale}`;
  return negative ? `-${text}` : text;
}
