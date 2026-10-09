import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_TEMPLATE_IDS, getTemplateById } from '../data/templateCatalog';
import { getBundle } from '../data/templateBundles';

test('Paid API endpoint is a free, complete scaffold', () => {
  const template = getTemplateById('paid-api-endpoint');
  const bundle = getBundle('paid-api-endpoint');

  assert.ok(template);
  assert.ok(bundle);
  assert.equal(template.name, 'Paid API endpoint');
  assert.equal(template.category, 'Payments');
  assert.ok(FREE_TEMPLATE_IDS.includes(template.id));
  assert.equal(bundle.manifestPath, 'package.json');

  const files = new Map(bundle.files.map((file) => [file.path, file.content]));
  for (const path of template.files) assert.ok(files.has(path), `missing scaffold file: ${path}`);

  const packageJson = JSON.parse(files.get('package.json')!);
  assert.equal(packageJson.engines.node, '>=22.0.0');
  assert.equal(packageJson.dependencies['@x402/stellar'], '^2.25.0');

  const server = files.get('src/server.ts')!;
  assert.match(server, /pay\.protect\('GET \/api\/research-brief', '\$0\.01'/);
  assert.match(server, /app\.get\('\/api\/research-brief'/);

  const adapter = files.get('src/websoroban-pay.ts')!;
  assert.match(adapter, /\/pay\/facilitator/);
  assert.match(adapter, /wsp_test_/);
  assert.match(adapter, /wsp_live_/);
  assert.match(adapter, /preflight/);

  assert.match(files.get('scripts/pay.ts')!, /wrapFetchWithPayment/);
  assert.equal(packageJson.scripts.pay, 'tsx --env-file=.env scripts/pay.ts');
  assert.ok(!files.get('README.md')!.includes('\\`'), 'README must not contain escaped backticks');
  assert.doesNotMatch(files.get('.env.example')!, /28076b0b-57cd-42b1-9cbc-b386e762c1dc/);
});

test('PayLoop merchant is a free, complete scaffold', () => {
  const template = getTemplateById('payloop-merchant');
  const bundle = getBundle('payloop-merchant');
  assert.ok(template);
  assert.ok(bundle);
  assert.equal(template.category, 'Payments');
  assert.ok(FREE_TEMPLATE_IDS.includes(template.id));
  const files = new Map(bundle.files.map((file) => [file.path, file.content]));
  for (const path of template.files) assert.ok(files.has(path), `missing scaffold file: ${path}`);
  assert.match(files.get('src/wallet-auth.ts')!, /Stellar Signed Message:\\n/);
  assert.match(files.get('src/payloop.ts')!, /policy\.merchant === config\.merchant/);
  assert.match(files.get('src/server.ts')!, /status\(402\)/);
  assert.ok(!files.get('README.md')!.includes('\\`'), 'README must not contain escaped backticks');
});
