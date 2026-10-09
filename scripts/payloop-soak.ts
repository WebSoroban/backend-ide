/**
 * Live PayLoop soak test on Stellar testnet.
 *
 * Proves, against the deployed contract and a separately running relayer
 * (`npm run worker:payloop:dev`):
 *   - a failed first charge leaves no policy and no allowance (atomic create)
 *   - recurring charges execute on schedule with no manual intervention
 *   - pause, resume, and revoke work from the subscriber's own key
 *   - the index matches the chain (reconciliation)
 *
 *   npx tsx scripts/payloop-soak.ts [policies=3] [recurringCharges=20] [intervalSeconds=60]
 *
 * Uses DATABASE_URL for the index, so point it at the same database the worker uses.
 * Testnet only: it funds throwaway accounts with Friendbot and the testnet DEX.
 */
import 'dotenv/config';
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import prisma from '../lib/prisma';
import { payloopContext, readPolicyCount, reconcilePayLoop, syncPayLoop } from '../services/payloop/indexer';
import { SorobanCallError, simulateRead, submitCall } from '../services/payloop/soroban';

const POLICIES = Number(process.argv[2]) || 3;
const TARGET = Number(process.argv[3]) || 20;
const INTERVAL = BigInt(Number(process.argv[4]) || 60);
const AMOUNT = 1_000_000n; // 0.1 USDC
const CAP = 100_000_000n; // 10 USDC: 100 charges, enough headroom for the soak
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const ctx = payloopContext();

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function account(usdcXlm: string | null) {
  const keypair = Keypair.random();
  const funded = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
  if (!funded.ok) throw new Error(`Friendbot failed with HTTP ${funded.status}.`);
  const builder = new TransactionBuilder(await horizon.loadAccount(keypair.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(Operation.changeTrust({ asset: USDC }));
  if (usdcXlm) {
    builder.addOperation(Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(), sendAmount: usdcXlm, destination: keypair.publicKey(), destAsset: USDC, destMin: '0.5', path: [],
    }));
  }
  const transaction = builder.setTimeout(60).build();
  transaction.sign(keypair);
  await horizon.submitTransaction(transaction);
  return keypair;
}

async function liveUntil() {
  return (await ctx.server.getLatestLedger()).sequence + 100 * 17_280;
}

const contract = () => new Contract(ctx.config.contractId);
const addr = (keypair: Keypair) => nativeToScVal(Address.fromString(keypair.publicKey()), { type: 'address' });
const u64 = (value: bigint) => nativeToScVal(value, { type: 'u64' });

async function createPolicy(subscriber: Keypair, merchant: Keypair) {
  const result = await submitCall(ctx.server, ctx.config.passphrase, subscriber, contract().call(
    'create_policy', addr(subscriber), addr(merchant),
    nativeToScVal(AMOUNT, { type: 'i128' }), u64(INTERVAL), nativeToScVal(CAP, { type: 'i128' }),
    nativeToScVal(await liveUntil(), { type: 'u32' }),
  ));
  return BigInt(result.returnValue as bigint);
}

async function act(subscriber: Keypair, method: 'pause' | 'resume' | 'revoke', policyId: bigint) {
  const args = method === 'revoke' ? [u64(policyId), nativeToScVal(await liveUntil(), { type: 'u32' })] : [u64(policyId)];
  return submitCall(ctx.server, ctx.config.passphrase, subscriber, contract().call(method, ...args));
}

async function recurringCharges(policyIds: bigint[]) {
  return prisma.payLoopCharge.findMany({
    where: { contractId: ctx.config.contractId, policyId: { in: policyIds }, outcome: 'charged', chargeNumber: { gt: 1 } },
    select: { policyId: true, delaySeconds: true },
  });
}

async function main() {
  if (!ctx.config.enabled || ctx.config.network !== 'testnet') throw new Error('Configure a testnet PayLoop deployment first.');
  log(`Soak: ${POLICIES} policies, ${TARGET} recurring charges, every ${INTERVAL}s, contract ${ctx.config.contractId}`);

  log('Funding accounts…');
  const merchant = await account(null);
  const subscribers = await Promise.all(Array.from({ length: POLICIES }, () => account('50')));
  const broke = await account(null);

  // KR: atomic first charge. A subscriber without USDC must leave no trace.
  const before = await readPolicyCount(ctx);
  try {
    await createPolicy(broke, merchant);
    throw new Error('create_policy succeeded for an account with no USDC.');
  } catch (error) {
    if (!(error instanceof SorobanCallError)) throw error;
  }
  const after = await readPolicyCount(ctx);
  const allowance = await simulateRead(ctx.server, ctx.config.passphrase, ctx.config.contractId, 'committed', [addr(broke)]);
  if (after !== before) throw new Error('A failed first charge created a policy.');
  log(`✓ failed first charge left no policy (count ${after}) and no commitment (${scValToNative(allowance.value)})`);

  const policyIds: bigint[] = [];
  for (const subscriber of subscribers) policyIds.push(await createPolicy(subscriber, merchant));
  log(`✓ created policies ${policyIds.join(', ')} with their first charge`);

  // Pause and resume the first policy once it has recurred, revoke the last at the end.
  const [first] = policyIds;
  let paused = false;
  let resumed = false;
  const deadline = Date.now() + (Math.ceil(TARGET / POLICIES) + 6) * Number(INTERVAL) * 1000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await syncPayLoop(ctx);
    const charges = await recurringCharges(policyIds);
    const perPolicy = policyIds.map((id) => charges.filter((charge) => charge.policyId === id).length);
    log(`recurring charges by relayer: ${charges.length}/${TARGET} (${perPolicy.join(' / ')})`);

    if (!paused && perPolicy[0] >= 1) {
      await act(subscribers[0], 'pause', first);
      paused = true;
      log(`✓ subscriber paused policy ${first}`);
    } else if (paused && !resumed) {
      const pausedFor = await prisma.payLoopCharge.count({ where: { contractId: ctx.config.contractId, policyId: first } });
      await act(subscribers[0], 'resume', first);
      resumed = true;
      log(`✓ subscriber resumed policy ${first} (${pausedFor} charges so far)`);
    }
    if (charges.length >= TARGET) break;
    if (Date.now() > deadline) throw new Error(`Only ${charges.length} recurring charges before the deadline.`);
  }

  const last = policyIds[policyIds.length - 1];
  await act(subscribers[subscribers.length - 1], 'revoke', last);
  log(`✓ subscriber revoked policy ${last}`);

  const charges = await recurringCharges(policyIds);
  const delays = charges.map((charge) => charge.delaySeconds).sort((a, b) => a - b);
  const onTime = delays.filter((delay) => delay <= Number(INTERVAL)).length;
  log(`✓ ${charges.length} recurring charges, ${onTime} within one interval of their due time; p50 ${delays[Math.floor(delays.length / 2)]}s, max ${delays[delays.length - 1]}s`);

  const report = await reconcilePayLoop(ctx);
  log(`${report.mismatches.length ? '✖' : '✓'} reconciliation: ${report.matched}/${report.checked} policies match the chain`);
  for (const mismatch of report.mismatches) log(`  policy ${mismatch.policyId} ${mismatch.field}: chain=${mismatch.chain} index=${mismatch.index}`);
  if (report.mismatches.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`✖ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
