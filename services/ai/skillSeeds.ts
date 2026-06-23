/**
 * Official seed skills — vetted, in-domain Soroban/Stellar knowledge packs the
 * Copilot ships with (ownerId null, official=true). Each is accurate against the
 * pinned toolchain (soroban-sdk 22.x, see prompts.ts SDK_PIN) and compile-oriented
 * where it shows code. Users can toggle, duplicate, and edit copies of these.
 *
 * Seeded idempotently by scripts/seed-skills.ts (upsert by official+slug).
 * They default to scope="auto": present in the cheap index every run, with the
 * full body pulled via load_skill only when the task matches whenToUse.
 */
import prisma from '../../lib/prisma';
import type { SkillScope } from './skills';

export interface OfficialSkillSeed {
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  scope: SkillScope;
  body: string;
}

export const OFFICIAL_SKILLS: OfficialSkillSeed[] = [
  {
    slug: 'sep-41-fungible-token',
    name: 'SEP-41 Fungible Token',
    description: 'The standard SEP-41 fungible token interface and a correct soroban-sdk 22.x implementation skeleton.',
    whenToUse: 'Building or reviewing a fungible token, balances/allowances, transfer/approve/mint/burn.',
    scope: 'auto',
    body: `# SEP-41 Fungible Token

SEP-41 is the standard Soroban token interface. Implement **every** function with these exact signatures (clients and wallets depend on them). Amounts are \`i128\`. Prefer the OpenZeppelin \`stellar-tokens\` \`FungibleToken\` for a vetted base; hand-roll only when you must (see \`@skill:openzeppelin-access-control\`).

## The interface (SEP-41)
\`\`\`rust
// allowance(from, spender) -> i128
// approve(from, spender, amount: i128, expiration_ledger: u32)
// balance(id) -> i128
// transfer(from, to, amount: i128)
// transfer_from(spender, from, to, amount: i128)
// burn(from, amount: i128)
// burn_from(spender, from, amount: i128)
// decimals() -> u32
// name() -> String
// symbol() -> String
\`\`\`

## Rules that make it correct
- **Auth:** \`transfer\`/\`approve\`/\`burn\` call \`from.require_auth()\`; \`transfer_from\`/\`burn_from\` call \`spender.require_auth()\`. \`mint\` (admin extension) loads the stored admin and calls \`admin.require_auth()\`.
- **Arithmetic:** use \`checked_add\`/\`checked_sub\` on balances and return a \`#[contracterror]\` on overflow/underflow — never wrap an \`i128\` amount. Reject \`amount < 0\`.
- **Allowances expire:** store \`(amount, expiration_ledger)\`; treat as 0 once \`env.ledger().sequence() > expiration_ledger\`.
- **Storage + TTL:** balances/allowances are \`persistent()\`; extend their TTL on every write (see \`@skill:storage-tiers-and-ttl\`).
- **Events:** emit \`transfer\`, \`approve\`, \`mint\`, \`burn\` (see \`@skill:soroban-events\`).

## Skeleton
\`\`\`rust
#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String};

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error { InsufficientBalance = 1, InsufficientAllowance = 2, NegativeAmount = 3, Overflow = 4 }

#[contracttype]
pub enum DataKey { Admin, Balance(Address), Allowance(AllowanceKey) }

#[contracttype]
#[derive(Clone)]
pub struct AllowanceKey { pub from: Address, pub spender: Address }

#[contract]
pub struct Token;

#[contractimpl]
impl Token {
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount < 0 { return Err(Error::NegativeAmount); }
        let from_bal = Self::balance(env.clone(), from.clone());
        if from_bal < amount { return Err(Error::InsufficientBalance); }
        let to_bal = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&DataKey::Balance(from.clone()), &(from_bal - amount));
        env.storage().persistent().set(&DataKey::Balance(to.clone()),
            &to_bal.checked_add(amount).ok_or(Error::Overflow)?);
        env.events().publish((soroban_sdk::symbol_short!("transfer"), from, to), amount);
        Ok(())
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(id)).unwrap_or(0)
    }
}
\`\`\`
Fill in \`approve\`/\`allowance\`/\`transfer_from\`/\`burn\`/\`burn_from\`/\`decimals\`/\`name\`/\`symbol\` the same way. Add a \`__constructor\` (or \`initialize\`) that sets the admin and metadata.`,
  },
  {
    slug: 'openzeppelin-access-control',
    name: 'OpenZeppelin Access Control',
    description: 'Use OpenZeppelin stellar-contracts for ownable / role-based access instead of hand-rolling admin checks.',
    whenToUse: 'Adding admin/owner gating, roles, or pausable/upgradeable behavior to a contract.',
    scope: 'auto',
    body: `# OpenZeppelin Access Control (stellar-contracts)

Prefer the audited OpenZeppelin Soroban library over hand-rolled admin checks. Pin a release compatible with **soroban-sdk 22.x**.

\`\`\`toml
[dependencies]
soroban-sdk = "22"
stellar-access = "<22.x-compatible release>"          # Ownable, AccessControl (roles)
stellar-macros = "<same release>"                      # #[only_owner], #[only_role]
stellar-contract-utils = "<same release>"              # Pausable, Upgradeable (optional)
\`\`\`

## Ownable (single owner)
Set the owner once (usually in the constructor), then gate privileged functions with the macro — it injects the owner load + \`require_auth\` for you.
\`\`\`rust
use soroban_sdk::{contract, contractimpl, Address, Env};
use stellar_access::ownable::{self, Ownable};
use stellar_macros::only_owner;

#[contract]
pub struct MyContract;

#[contractimpl]
impl MyContract {
    pub fn __constructor(e: &Env, owner: Address) {
        ownable::set_owner(e, &owner);
    }

    #[only_owner]                       // owner must require_auth() — enforced before the body
    pub fn set_config(e: &Env, value: u32) {
        e.storage().instance().set(&"config", &value);
    }
}
\`\`\`

## Roles (multiple privileges)
Use \`AccessControl\` + \`#[only_role]\` when you need more than one privileged party (minter, pauser, …):
\`\`\`rust
use stellar_macros::only_role;

#[only_role(caller, "minter")]
pub fn mint(e: &Env, caller: Address, to: Address, amount: i128) { /* ... */ }
\`\`\`
The admin grants/revokes roles via the AccessControl admin functions. This composes with \`stellar-tokens\` (\`FungibleToken\`) and \`stellar-contract-utils\` \`Pausable\`/\`Upgradeable\`.

## Why
Hand-rolled \`admin.require_auth()\` checks are easy to forget or mis-place (a missing check is a critical bug — see \`@skill:soroban-auth\`). The macros make the gate declarative and consistent. Never store the owner/roles in plain mutable globals; use the library's storage.`,
  },
  {
    slug: 'storage-tiers-and-ttl',
    name: 'Storage Tiers & TTL',
    description: 'Choose instance/persistent/temporary correctly and always extend TTL so state is not archived.',
    whenToUse: 'Reading/writing contract state, deciding a storage tier, or fixing entry-expired / archived errors.',
    scope: 'auto',
    body: `# Storage Tiers & TTL

Soroban storage entries have a **Time To Live**. If the TTL lapses, the entry is archived and reads fail until it is restored. Pick the right tier and **extend the TTL after writes**.

## Tiers
- \`env.storage().instance()\` — small, contract-global config (admin, paused flag, token metadata). Shares ONE TTL with the contract instance.
- \`env.storage().persistent()\` — per-entity durable state (balances, ownership, allowances). Each entry has its own TTL; **you must extend it** or it gets archived.
- \`env.storage().temporary()\` — short-lived data (nonces, ephemeral locks). Cheapest; fine to let it expire.

## Extend TTL after every write
\`\`\`rust
// Pick thresholds from ledgers (~5s each). Example values:
const DAY: u32 = 17280;          // ~1 day in ledgers
const PERSIST_THRESHOLD: u32 = DAY;          // extend when remaining TTL drops below this
const PERSIST_EXTEND_TO: u32 = 30 * DAY;     // bump remaining TTL up to this

// persistent + temporary: keyed extend
let key = DataKey::Balance(addr.clone());
env.storage().persistent().set(&key, &new_balance);
env.storage().persistent().extend_ttl(&key, PERSIST_THRESHOLD, PERSIST_EXTEND_TO);

// instance: no key (one shared TTL)
env.storage().instance().set(&DataKey::Admin, &admin);
env.storage().instance().extend_ttl(DAY, 30 * DAY);
\`\`\`

## Rules
- Never leave \`persistent()\` data without an \`extend_ttl\` strategy — that is the #1 cause of "entry expired/archived" failures in production.
- Put config in \`instance()\` so one extend keeps it all alive; put per-user state in \`persistent()\`.
- Use a typed \`#[contracttype] enum DataKey { ... }\` for keys; \`symbol_short!\` only for keys ≤ 9 chars.`,
  },
  {
    slug: 'soroban-auth',
    name: 'Soroban Auth (require_auth)',
    description: 'require_auth / require_auth_for_args conventions and authorized sub-invocations (CPI).',
    whenToUse: 'Any state change on behalf of a user, admin gating, or calling another contract that needs auth.',
    scope: 'auto',
    body: `# Soroban Auth (require_auth)

Authorization is explicit. Any function that mutates state **on behalf of an address** must prove that address authorized the call.

## The rules
- Call \`addr.require_auth()\` at the TOP of any function that acts for \`addr\` (transfer, withdraw, set-profile, …), before reading/writing state.
- For **admin/owner** actions: load the stored admin Address and call \`admin.require_auth()\` before the privileged write. (Or use \`@skill:openzeppelin-access-control\`.)
- \`require_auth()\` authorizes the call with the function's actual arguments. Use \`require_auth_for_args\` only when you must authorize a *different* argument set than what's passed (advanced):
\`\`\`rust
use soroban_sdk::IntoVal;
from.require_auth_for_args((&to, amount).into_val(&env));
\`\`\`
- **Guard initialization** so an attacker can't re-init and seize admin: \`if env.storage().instance().has(&DataKey::Admin) { return Err(Error::AlreadyInit); }\` before setting the admin (or use a \`__constructor\`, which runs exactly once).

\`\`\`rust
pub fn withdraw(env: Env, user: Address, amount: i128) -> Result<(), Error> {
    user.require_auth();                       // user must sign for this exact call
    // ... checked arithmetic + persistent writes ...
    Ok(())
}

pub fn set_fee(env: Env, new_fee: u32) {
    let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
    admin.require_auth();                       // gate before mutating
    env.storage().instance().set(&DataKey::Fee, &new_fee);
}
\`\`\`

## Sub-invocations (calling another contract)
When your contract calls another contract that itself calls \`require_auth\` (e.g. moving a token on the user's behalf), the user's authorization must cover that sub-invocation. With the generated client this is handled by the auth tree; in tests, \`env.mock_all_auths()\` authorizes the whole tree. In production the wallet builds the matching \`SorobanAuthorizationEntry\`. Keep the contract you call and the args deterministic so the authorized tree matches.

## Anti-patterns (these are bugs)
- A state-mutating or admin function with **no** \`require_auth\` → anyone can call it. (The security audit flags \`missing-require-auth\`.)
- Reading state, then calling \`require_auth\` after the effect.
- Trusting an \`Address\` passed in without \`require_auth\` ("the caller said they're the admin").`,
  },
  {
    slug: 'soroban-events',
    name: 'Soroban Events',
    description: 'Event publishing conventions: topics vs data, naming, and what to emit for state changes.',
    whenToUse: 'Emitting events for mints/transfers/admin changes, or making a contract indexable.',
    scope: 'auto',
    body: `# Soroban Events

Emit an event for every meaningful **state change** so off-chain indexers, UIs, and tests can observe it.

\`\`\`rust
use soroban_sdk::{symbol_short, Symbol};

// publish((topics...), data)
env.events().publish(
    (symbol_short!("transfer"), from.clone(), to.clone()), // topics: indexed, filterable
    amount,                                                  // data: the payload
);
\`\`\`

> On soroban-sdk 22.x (this IDE's pinned toolchain) use \`env.events().publish((topics), data)\`. Newer SDKs add a typed \`#[contractevent(topics = ["transfer"])]\` struct with \`.publish(&env)\` — same wire format; prefer \`env.events().publish\` here so it compiles against the pinned SDK.

## Conventions
- **Topics** are for filtering/indexing: put the event name first (a \`Symbol\`), then the indexed parties (e.g. \`from\`, \`to\`, or the admin). Keep topics small.
- **Data** is the payload (the amount, the new value). It can be a struct/tuple.
- Use \`symbol_short!("...")\` for event names ≤ 9 chars (\`transfer\`, \`approve\`, \`mint\`, \`burn\`, \`set_admin\`). For longer names use \`Symbol::new(&env, "long_name")\`.
- Match the standard token events where applicable: \`transfer(from, to, amount)\`, \`approve(from, spender, amount, expiration_ledger)\`, \`mint(admin, to, amount)\`, \`burn(from, amount)\`.

## What to emit
- Token: transfer, approve, mint, burn.
- Admin/ownership: set_admin / ownership_transferred.
- Lifecycle: paused/unpaused, upgraded.

## Testing events
\`\`\`rust
let events = env.events().all();
assert_eq!(events.len(), 1);
// inspect (contract_id, topics, data) of the last event
\`\`\`
Don't emit secrets or full account state in events — emit the minimal delta. Events are public.`,
  },
  {
    slug: 'soroban-testing',
    name: 'Soroban Testing Patterns',
    description: 'Unit + integration tests with soroban_sdk::testutils: Env, register, generated Client, auth/ledger mocks.',
    whenToUse: 'Writing or fixing tests, covering auth failures and arithmetic edges, or setting up testutils.',
    scope: 'auto',
    body: `# Soroban Testing Patterns

Test against a real \`Env\` with the generated client. Cover happy paths, **auth failures**, and **arithmetic edges**.

## Setup
\`\`\`rust
#![cfg(test)]
use soroban_sdk::{testutils::Address as _, Address, Env};
use super::{Token, TokenClient};   // generated <Contract>Client

fn setup() -> (Env, TokenClient<'static>, Address) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(Token, ());          // soroban-sdk 22.x: register(contract, constructor_args)
    let client = TokenClient::new(&env, &contract_id);
    (env, client, admin)
}
\`\`\`

## Auth in tests
\`\`\`rust
#[test]
fn transfer_moves_balance() {
    let (env, client, admin) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    env.mock_all_auths();                  // authorize the whole call tree

    client.mint(&admin, &a, &100);
    client.transfer(&a, &b, &40);
    assert_eq!(client.balance(&a), 60);
    assert_eq!(client.balance(&b), 40);
}
\`\`\`

## Assert auth was actually required
\`\`\`rust
// after a call, inspect what auth was demanded:
let auths = env.auths();
assert_eq!(auths.first().unwrap().0, a);   // 'a' had to authorize the transfer
\`\`\`

## Expected failures (don't panic-test happy paths)
\`\`\`rust
#[test]
fn transfer_over_balance_errors() {
    let (env, client, admin) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    env.mock_all_auths();
    client.mint(&admin, &a, &10);
    // try_* returns Result so you can assert the contract error
    let res = client.try_transfer(&a, &b, &50);
    assert!(res.is_err());
}
\`\`\`

## Ledger / TTL
Use \`env.ledger().set(...)\` / \`env.ledger().with_mut(...)\` to advance the sequence and test allowance expiry and TTL behavior.

## Coverage checklist
- happy path per public function;
- auth failure (call without the right signer → rejected);
- arithmetic edges (zero, max, overflow/underflow → contract error, not panic);
- allowance expiry; storage/TTL where relevant.

Beyond unit tests, the ecosystem uses fuzz (\`cargo-fuzz\`), property-based (\`proptest\`), and mutation (\`cargo-mutants\`) testing. Reference: Stellar's official dev skills — https://github.com/stellar/stellar-dev-skill (skills/soroban).`,
  },
];

/**
 * Idempotently upsert the official skills. Matches on (official=true, slug)
 * because Postgres treats NULL ownerId as distinct, so a plain unique upsert on
 * (ownerId, slug) can't be used for the null-owner rows.
 */
export async function seedOfficialSkills(): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const s of OFFICIAL_SKILLS) {
    const existing = await prisma.skill.findFirst({ where: { official: true, slug: s.slug } });
    const data = {
      ownerId: null,
      official: true,
      name: s.name,
      slug: s.slug,
      description: s.description,
      whenToUse: s.whenToUse,
      body: s.body,
      scope: s.scope,
      enabled: true,
      visibility: 'public',
    };
    if (existing) {
      await prisma.skill.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.skill.create({ data });
      created++;
    }
  }
  return { created, updated };
}

export default { OFFICIAL_SKILLS, seedOfficialSkills };
