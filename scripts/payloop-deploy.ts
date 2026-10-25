/**
 * Deploy the PayLoop contract and record it in
 * contracts/payloop/deployments/<network>.json.
 *
 *   stellar contract build   (in contracts/payloop, stellar-cli 25.2+)
 *   npx tsx scripts/payloop-deploy.ts testnet
 *
 * PAYLOOP_DEPLOYER_SECRET signs the upload and deploy. On testnet a throwaway
 * deployer is created and funded with Friendbot when it is not set.
 *
 * Mainnet is refused unless the contract has passed an independent review
 * (PAYLOOP_MAINNET_AUDITED=yes) or the operator explicitly accepts launching
 * without one (PAYLOOP_ACCEPT_UNAUDITED_MAINNET=yes). The choice is recorded in
 * the deployment manifest as `audited`.
 */
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Address, Keypair, Operation, nativeToScVal } from '@stellar/stellar-sdk';
import { coerceNetwork, getNetwork } from '../lib/networks';
import { PAYLOOP_TOKENS, deploymentFile, type PayLoopDeployment } from '../services/payloop/config';
import { rpcServer, simulateRead, submitCall } from '../services/payloop/soroban';

const WASM = path.join(process.cwd(), 'contracts', 'payloop', 'target', 'wasm32v1-none', 'release', 'payloop.wasm');

async function deployerKeypair(network: 'testnet' | 'mainnet') {
  const secret = process.env.PAYLOOP_DEPLOYER_SECRET?.trim();
  if (secret) return Keypair.fromSecret(secret);
  if (network === 'mainnet') throw new Error('Set PAYLOOP_DEPLOYER_SECRET to a funded mainnet account.');
  const keypair = Keypair.random();
  const response = await fetch(`${getNetwork('testnet').friendbotUrl}/?addr=${keypair.publicKey()}`);
  if (!response.ok) throw new Error(`Friendbot failed with HTTP ${response.status}.`);
  console.log(`Funded throwaway testnet deployer ${keypair.publicKey()}`);
  return keypair;
}

async function main() {
  const network = coerceNetwork(process.argv[2] || 'testnet');
  const audited = process.env.PAYLOOP_MAINNET_AUDITED === 'yes';
  if (network === 'mainnet' && !audited) {
    if (process.env.PAYLOOP_ACCEPT_UNAUDITED_MAINNET !== 'yes') {
      throw new Error('Refusing to deploy PayLoop to mainnet without a completed independent review. Set PAYLOOP_MAINNET_AUDITED=yes once it is done, or PAYLOOP_ACCEPT_UNAUDITED_MAINNET=yes to launch knowingly without one.');
    }
    console.warn('WARNING: deploying PayLoop to mainnet WITHOUT an independent security review. Recording audited=false in the manifest.');
  }
  const config = getNetwork(network);
  const server = rpcServer(config.rpcUrl);
  const wasm = readFileSync(WASM);
  const wasmHash = createHash('sha256').update(wasm).digest();
  const token = PAYLOOP_TOKENS[network];
  const deployer = await deployerKeypair(network);

  console.log(`Uploading ${wasm.length} byte wasm (${wasmHash.toString('hex')}) to ${config.label}…`);
  await submitCall(server, config.passphrase, deployer, Operation.uploadContractWasm({ wasm }));

  console.log('Creating contract instance…');
  const created = await submitCall(server, config.passphrase, deployer, Operation.createCustomContract({
    address: new Address(deployer.publicKey()),
    wasmHash,
    salt: randomBytes(32),
    constructorArgs: [nativeToScVal(Address.fromString(token), { type: 'address' })],
  }));
  const contractId = String(created.returnValue);

  // Read back through the deployed instance before recording it.
  const check = await simulateRead(server, config.passphrase, contractId, 'token');
  const recordedToken = Address.fromScVal(check.value).toString();
  if (recordedToken !== token) throw new Error(`Deployed contract reports token ${recordedToken}, expected ${token}.`);

  const deployment: PayLoopDeployment = {
    network,
    contractId,
    wasmHash: wasmHash.toString('hex'),
    token,
    ledger: created.ledger,
    deployer: deployer.publicKey(),
    deployedAt: new Date().toISOString(),
    ...(network === 'mainnet' ? { audited } : {}),
  };
  mkdirSync(path.dirname(deploymentFile(network)), { recursive: true });
  writeFileSync(deploymentFile(network), `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`PayLoop deployed: ${contractId}`);
  console.log(`${config.explorerBase}/contract/${contractId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
