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
  /** Mainnet only: whether an independent security review preceded this deployment. */
  audited?: boolean;
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
/** The network a single-network process (the worker) runs on. */
export function defaultPayLoopNetwork(): NetworkId {
  return coerceNetwork(process.env.PAYLOOP_NETWORK?.trim() || 'testnet');
}

function networkEnv(network: NetworkId, name: string): string {
  // PAYLOOP_CONTRACT_ID_MAINNET etc. win; the unsuffixed variable applies to
  // PAYLOOP_NETWORK only, so an older single-network setup keeps working.
  const suffixed = process.env[`${name}_${network.toUpperCase()}`]?.trim();
  if (suffixed) return suffixed;
  return network === defaultPayLoopNetwork() ? process.env[name]?.trim() || '' : '';
}

export function payloopConfig(network: NetworkId = defaultPayLoopNetwork()): PayLoopConfig {
  const net = getNetwork(network);
  const manifest = readDeployment(network);
  const contractId = networkEnv(network, 'PAYLOOP_CONTRACT_ID') || manifest?.contractId || '';
  return {
    enabled: Boolean(contractId),
    network,
    contractId,
    token: networkEnv(network, 'PAYLOOP_TOKEN') || manifest?.token || PAYLOOP_TOKENS[network],
    startLedger: Number(networkEnv(network, 'PAYLOOP_START_LEDGER')) || manifest?.ledger || 0,
    rpcUrl: net.rpcUrl,
    passphrase: net.passphrase,
    explorerBase: net.explorerBase,
  };
}

/** Demo merchant pre-filled on the PayLoop page for a network, if configured. */
export function demoMerchant(network: NetworkId): string | null {
  const value = network === 'mainnet'
    ? process.env.PAYLOOP_MAINNET_DEMO_MERCHANT?.trim()
    : process.env.PAYLOOP_DEMO_MERCHANT?.trim();
  return value || null;
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
