# @web-soroban/payloop

Non-custodial USDC subscriptions on Stellar. A subscriber signs one PayLoop
policy (merchant, amount, interval, safety cap) from their own wallet. The
first charge settles in the same transaction, and WebSoroban's relayer submits
every later charge on schedule. Funds move straight from the subscriber to the
merchant. No one holds them in between, and the subscriber can pause, resume,
or revoke at any time.

This package builds the contract calls for any Stellar wallet to sign, submits
them, and reads policies and charges, on **testnet** or **mainnet**.

```bash
npm install @web-soroban/payloop @stellar/stellar-sdk
```

## Networks

| | Testnet | Mainnet |
| --- | --- | --- |
| USDC | Circle test USDC (`CBIELTK6…`) | Circle USDC (`CCW67TSZ…`) |
| RPC | `https://soroban-testnet.stellar.org` (default) | Your provider's URL (pass `rpcUrl`) |
| Contract | Read from the WebSoroban API | Read from the WebSoroban API |

Mainnet moves real USDC. The PayLoop contract has had an internal security
review, and `GET /api/payloop/config` reports `audited` for the mainnet
deployment. Check it before you take customer funds.

Both the subscriber and the merchant need a USDC trustline on the network you
use.

## Subscribe a customer (browser)

```ts
import { NETWORKS, createPayLoopClient } from '@web-soroban/payloop';
import { signTransaction } from '@stellar/freighter-api';

const payloop = createPayLoopClient({ network: 'mainnet', rpcUrl: 'https://your-mainnet-rpc' });

const { hash, explorerUrl } = await payloop.send(
  () => payloop.buildCreatePolicy({
    subscriber,                  // the customer's G… address
    merchant: 'G…YOUR_PAYOUT',
    amount: '9.99',              // USDC per charge
    intervalSeconds: 30 * 86_400,
    cap: '119.88',               // total the policy may ever charge
  }),
  async (xdr) => (await signTransaction(xdr, { networkPassphrase: NETWORKS.mainnet.passphrase, address: subscriber })).signedTxXdr,
);
```

`send` builds, asks the wallet to sign, and submits. It rebuilds and asks again
only when the network confirms the transaction failed, so nothing was applied.
A common cause is another subscriber creating a policy in the same ledger. A
transaction that was never confirmed is not retried; check `explorerUrl`
first.

The same pattern works for `buildPause`, `buildResume`, `buildRevoke`
(subscriber), `buildCancel` (merchant), `buildRefreshAllowance` (subscriber,
renews the token allowance before its ~100-day expiry), and `buildCharge`
(anyone; the relayer does this for you).

## Gate access (server)

```ts
import { createPayLoopClient, verifyWalletSignature } from '@web-soroban/payloop';

const payloop = createPayLoopClient({ network: 'mainnet' });

app.post('/login', async (req, res) => {
  const { wallet, message, signature } = req.body;          // from Freighter signMessage
  if (!verifyWalletSignature(wallet, message, signature)) return res.status(401).end();
  const plan = await payloop.activeSubscription({
    subscriber: wallet, merchant: process.env.PAYOUT!, amount: '9.99', intervalSeconds: 30 * 86_400,
  });
  res.json({ pro: Boolean(plan), nextChargeAt: plan?.nextChargeAt });
});
```

Include a nonce and an expiry in `message` and check them yourself, so a
signature cannot be replayed.

## Read

| Method | Source |
| --- | --- |
| `getPolicy(id)` | The contract (authoritative) |
| `policies({ subscriber \| merchant, status? })` | WebSoroban index, newest first |
| `policyWithCharges(id)` | WebSoroban index: policy plus its last 50 charges |
| `activeSubscription({...})` | WebSoroban index |

Amounts are strings in stroops (1 USDC = 10,000,000). Use `toStroops` and
`formatUsdc` to convert.

## Errors

Every failure is a `PayLoopError`. Contract rejections set `code`:
`InvalidAmount`, `InvalidInterval` (1 minute to 90 days), `InvalidCap`,
`InvalidParty` (merchant must differ from the subscriber and the token),
`NotActive`, `NotPaused`, `AlreadyFinal`, `NotDue`, `PolicyNotFound`.

Docs: https://websoroban.in/docs/payloop
