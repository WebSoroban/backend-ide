/**
 * Idea Bank submission tests — validation and the public shape, no DB/network.
 *
 * Run with: npm test  (node --import tsx --test tests/*.test.ts)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adminIdea, isIdeaStatus, publicIdea, validateIdea } from '../services/ideaSubmissions';

const valid = {
  title: '  Passkey   Smart Wallet ',
  goal: 'Sign in with a fingerprint or Face ID instead of a seed phrase.',
  description: 'A custom account contract authorizing transactions with WebAuthn passkeys.\r\n\r\n\r\n\r\nKey features: __check_auth.',
  alignment: 'Removes the biggest onboarding barrier.',
  author: 'Raph (Lumen Loop)',
  contact: 'raph@example.com',
  link: 'https://discord.com/channels/1/2',
};

test('validateIdea: accepts a full submission and cleans whitespace', () => {
  const result = validateIdea(valid);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.title, 'Passkey Smart Wallet');
  assert.equal(
    result.value.description,
    'A custom account contract authorizing transactions with WebAuthn passkeys.\n\nKey features: __check_auth.',
  );
  assert.equal(result.value.link, 'https://discord.com/channels/1/2');
});

test('validateIdea: alignment and link are optional', () => {
  const result = validateIdea({ ...valid, alignment: '', link: '' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.link, null);
});

test('validateIdea: rejects missing or short required fields', () => {
  for (const field of ['title', 'goal', 'description', 'author', 'contact'] as const) {
    const result = validateIdea({ ...valid, [field]: 'x' });
    assert.equal(result.ok, false, field);
    if (!result.ok) assert.equal(result.field, field);
  }
});

test('validateIdea: rejects over-long fields and non-http links', () => {
  const long = validateIdea({ ...valid, title: 'a'.repeat(91) });
  assert.equal(long.ok, false);
  const link = validateIdea({ ...valid, link: 'javascript:alert(1)' });
  assert.equal(link.ok, false);
  if (!link.ok) assert.equal(link.field, 'link');
});

test('validateIdea: partial mode checks only the fields given', () => {
  const result = validateIdea({ title: 'Shorter title' }, { partial: true });
  assert.deepEqual(result, { ok: true, value: { title: 'Shorter title' } });
  assert.equal(validateIdea(undefined, { partial: true }).ok, true);
});

test('publicIdea never exposes contact or review data', () => {
  const row = {
    ...(validateIdea(valid) as { ok: true; value: any }).value,
    id: 'idea_1',
    status: 'accepted',
    reviewNote: 'Great fit',
    reviewedAt: new Date('2026-10-18T00:00:00Z'),
    createdAt: new Date('2026-10-17T00:00:00Z'),
  };
  const shown = publicIdea(row);
  assert.equal('contact' in shown, false);
  assert.equal('reviewNote' in shown, false);
  assert.equal(shown.acceptedAt, '2026-10-18T00:00:00.000Z');
  assert.equal(adminIdea(row).contact, 'raph@example.com');
});

test('isIdeaStatus', () => {
  assert.equal(isIdeaStatus('accepted'), true);
  assert.equal(isIdeaStatus('all'), false);
});
