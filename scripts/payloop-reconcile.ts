/**
 * Reconcile the PayLoop index with the contract: every policy's terms, state,
 * and charge history must match. Exits 1 on any mismatch (for cron/CI).
 *
 *   npm run payloop:reconcile [-- testnet|mainnet]   (default: PAYLOOP_NETWORK or testnet)
 */
import 'dotenv/config';
import prisma from '../lib/prisma';
import { coerceNetwork } from '../lib/networks';
import { defaultPayLoopNetwork } from '../services/payloop/config';
import { payloopContext, reconcilePayLoop } from '../services/payloop/indexer';

reconcilePayLoop(payloopContext(process.argv[2] ? coerceNetwork(process.argv[2]) : defaultPayLoopNetwork()))
  .then((report) => {
    console.log(`PayLoop ${report.contractId}: ${report.matched}/${report.checked} policies match the chain.`);
    for (const mismatch of report.mismatches) {
      console.log(`  policy ${mismatch.policyId} ${mismatch.field}: chain=${mismatch.chain} index=${mismatch.index}`);
    }
    process.exitCode = report.mismatches.length ? 1 : 0;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
