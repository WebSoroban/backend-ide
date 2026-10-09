/**
 * x402 kit adoption report (KRs: ≥10 external projects; scaffold to first paid
 * request in under 30 minutes).
 *
 *   npx tsx scripts/x402-adoption.ts [--json]
 *
 * Team accounts (ADMIN_EMAILS, X402_INTERNAL_EMAILS, X402_INTERNAL_DOMAINS)
 * and self-payments are excluded.
 */
import 'dotenv/config';
import prisma from '../lib/prisma';
import { adoptionReport } from '../services/x402Adoption';

adoptionReport()
  .then((report) => {
    if (process.argv.includes('--json')) return console.log(JSON.stringify(report, null, 2));
    const time = report.timeToFirstPaidRequest;
    console.log(`External projects with a real paid request: ${report.externalAdopters} / ${report.target}`);
    console.log(`Funnel: ${report.funnel.accountsWithEndpoint} created an endpoint → ${report.funnel.accountsWithChallenge} served a 402 → ${report.funnel.accountsWithPaidRequest} were paid (${report.funnel.accountsViaSdk} via the SDK)`);
    console.log(`Endpoint → first paid request: median ${time.medianMinutes?.toFixed(1) ?? '—'} min, p75 ${time.p75Minutes?.toFixed(1) ?? '—'} min, ${time.within30Minutes}/${time.samples} within 30 min`);
    console.log(`Team accounts excluded: ${report.internalAccountsExcluded}`);
    for (const week of report.weeklyNewAdopters) console.log(`  ${week.week}: +${week.count}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
