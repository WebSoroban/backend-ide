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
