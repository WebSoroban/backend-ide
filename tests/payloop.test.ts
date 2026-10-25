import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUsdc } from '../services/payloop/config';
import { decodePolicy } from '../services/payloop/indexer';
import { retryDelayMs } from '../services/payloop/relayer';
import { parseContractError } from '../services/payloop/soroban';

test('decodes a contract policy into index fields', () => {
  const policy = decodePolicy({
    id: 7n,
    subscriber: 'GSUB',
    merchant: 'GMER',
    amount: 1_000_000n,
    interval: 60n,
    cap: 50_000_000n,
    spent: 3_000_000n,
    charges: 3,
    failed_attempts: 1,
    next_charge_at: 1_791_553_667n,
    created_at: 1_791_553_547n,
    status: 1,
  });
  assert.equal(policy.policyId, 7n);
  assert.equal(policy.intervalSeconds, 60);
  assert.equal(policy.status, 'paused');
  assert.equal(policy.nextChargeAt.toISOString(), new Date(1_791_553_667_000).toISOString());
  assert.equal(policy.failedAttempts, 1);
});

test('maps host errors to contract error names', () => {
  assert.equal(parseContractError('HostError: Error(Contract, #9)'), 'NotDue');
  assert.equal(parseContractError('Error(Contract, #6) in charge'), 'NotActive');
  assert.equal(parseContractError('Error(Contract, #11)'), 'InvalidAllowanceExpiry');
  assert.equal(parseContractError('Error(Contract, #99)'), 'Contract#99');
  assert.equal(parseContractError('network timeout'), null);
});

test('backs off relayer retries for uncovered charges', () => {
  assert.equal(retryDelayMs(0), 0);
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 5 * 60_000);
  assert.equal(retryDelayMs(50), 60 * 60_000);
});

test('formats USDC stroops exactly', () => {
  assert.equal(formatUsdc(1_000_000n), '0.1');
  assert.equal(formatUsdc('120000000'), '12');
  assert.equal(formatUsdc(1n), '0.0000001');
  assert.equal(formatUsdc(-15_000_000n), '-1.5');
});

test('decodes the ledger from an RPC event cursor', async () => {
  const { cursorLedger } = await import('../services/payloop/indexer');
  // toid = ledger << 32 | tx/op order, zero-padded to 19 digits.
  const endOfLedger = ((5382171n << 32n) | 0xffffffffn).toString().padStart(19, '0');
  assert.equal(cursorLedger(`${endOfLedger}-4294967295`), 5382171);
  assert.equal(cursorLedger(`${(5382110n << 32n).toString().padStart(19, '0')}-0000000002`), 5382110);
  assert.equal(cursorLedger('garbage'), Number.MAX_SAFE_INTEGER, 'unparseable cursors end the scan instead of looping');
});

test('resolves PayLoop config per network', async () => {
  const { payloopConfig, demoMerchant } = await import('../services/payloop/config');
  const saved = { ...process.env };
  try {
    delete process.env.PAYLOOP_CONTRACT_ID_MAINNET;
    delete process.env.PAYLOOP_CONTRACT_ID;
    process.env.PAYLOOP_NETWORK = 'testnet';
    // Testnet comes from the committed manifest; mainnet is off until deployed.
    assert.equal(payloopConfig('testnet').enabled, true);
    if (!require('node:fs').existsSync('contracts/payloop/deployments/mainnet.json')) {
      assert.equal(payloopConfig('mainnet').enabled, false);
    }
    process.env.PAYLOOP_CONTRACT_ID_MAINNET = 'CMAINNETCONTRACT';
    assert.equal(payloopConfig('mainnet').contractId, 'CMAINNETCONTRACT');
    // The unsuffixed variable only applies to PAYLOOP_NETWORK.
    process.env.PAYLOOP_CONTRACT_ID = 'CTESTNETOVERRIDE';
    assert.equal(payloopConfig('testnet').contractId, 'CTESTNETOVERRIDE');
    assert.equal(payloopConfig('mainnet').contractId, 'CMAINNETCONTRACT');
    process.env.PAYLOOP_MAINNET_DEMO_MERCHANT = 'GMAINNET';
    process.env.PAYLOOP_DEMO_MERCHANT = 'GTESTNET';
    assert.equal(demoMerchant('mainnet'), 'GMAINNET');
    assert.equal(demoMerchant('testnet'), 'GTESTNET');
  } finally {
    process.env = saved;
  }
});
