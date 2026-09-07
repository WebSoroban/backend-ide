/**
 * Multi-file template BUNDLES.
 *
 * A bundle is the full source tree for a template:
 *   { manifestPath, deployTarget?, defaultTests?, files: [{ path, content }] }
 *
 * "Use template" scaffolds the whole tree into a new project (see routes/projects).
 * Single-file templates are just one-file bundles. Most bundles are compiling
 * Soroban contracts; application templates can carry their own runtime manifest
 * and verification commands.
 */

export interface BundleFile {
  path: string;
  content: string;
}

export interface TemplateBundle {
  /** Project-relative path of the driving project manifest. */
  manifestPath: string;
  /** For workspaces: the crate whose wasm is deployed by default. */
  deployTarget?: string;
  /** Paths of the test files (informational; surfaced to the UI). */
  defaultTests?: string[];
  files: BundleFile[];
}

// Shared .cargo/config.toml — the wasm32v1-none flags the Stellar CLI expects.
const CARGO_CONFIG = `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]
`;

// Cargo.toml for a single contract crate. crate-type includes "rlib" so the
// crate can also be used as a dependency by integration tests under tests/.
function singleCrateCargo(name: string): string {
  return `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib", "rlib"]

[profile.release]
opt-level = "z"
overflow-checks = true
`;
}

// ---------------------------------------------------------------------------
// 1. Multi-module counter — storage + events split across modules, with a unit
//    test (in storage.rs) and an integration test (tests/counter.rs).
// ---------------------------------------------------------------------------
const COUNTER_MF: TemplateBundle = {
  manifestPath: 'Cargo.toml',
  defaultTests: ['src/storage.rs', 'tests/counter.rs'],
  files: [
    {
      path: 'src/lib.rs',
      content: `#![no_std]
use soroban_sdk::{contract, contractimpl, Env};

mod events;
mod storage;

#[contract]
pub struct CounterContract;

#[contractimpl]
impl CounterContract {
    /// Increment the counter and return the new value.
    pub fn increment(env: Env) -> u32 {
        let next = storage::get_count(&env) + 1;
        storage::set_count(&env, next);
        events::counter_changed(&env, next);
        next
    }

    /// Decrement the counter (saturating at 0) and return the new value.
    pub fn decrement(env: Env) -> u32 {
        let current = storage::get_count(&env);
        let next = if current == 0 { 0 } else { current - 1 };
        storage::set_count(&env, next);
        events::counter_changed(&env, next);
        next
    }

    /// Read the current counter value.
    pub fn get(env: Env) -> u32 {
        storage::get_count(&env)
    }

    /// Reset the counter to zero.
    pub fn reset(env: Env) {
        storage::set_count(&env, 0);
        events::counter_changed(&env, 0);
    }
}
`
    },
    {
      path: 'src/storage.rs',
      content: `use soroban_sdk::{symbol_short, Env, Symbol};

const COUNT: Symbol = symbol_short!("COUNT");

pub fn get_count(env: &Env) -> u32 {
    env.storage().instance().get(&COUNT).unwrap_or(0)
}

pub fn set_count(env: &Env, value: u32) {
    env.storage().instance().set(&COUNT, &value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn defaults_to_zero_then_persists() {
        let env = Env::default();
        let contract = env.register_contract(None, crate::CounterContract);
        env.as_contract(&contract, || {
            assert_eq!(get_count(&env), 0);
            set_count(&env, 5);
            assert_eq!(get_count(&env), 5);
        });
    }
}
`
    },
    {
      path: 'src/events.rs',
      content: `use soroban_sdk::{symbol_short, Env};

/// Publish a "count" event whenever the counter changes.
pub fn counter_changed(env: &Env, value: u32) {
    env.events().publish((symbol_short!("count"),), value);
}
`
    },
    {
      path: 'tests/counter.rs',
      content: `use counter_mf::{CounterContract, CounterContractClient};
use soroban_sdk::Env;

#[test]
fn increments_and_decrements() {
    let env = Env::default();
    let id = env.register_contract(None, CounterContract);
    let client = CounterContractClient::new(&env, &id);

    assert_eq!(client.get(), 0);
    assert_eq!(client.increment(), 1);
    assert_eq!(client.increment(), 2);
    assert_eq!(client.decrement(), 1);
    client.reset();
    assert_eq!(client.get(), 0);
}
`
    },
    { path: 'Cargo.toml', content: singleCrateCargo('counter-mf') },
    { path: '.cargo/config.toml', content: CARGO_CONFIG }
  ]
};

// ---------------------------------------------------------------------------
// 2. Access control / admin module — an admin module gates a state-changing
//    function. Shows require_auth + module separation.
// ---------------------------------------------------------------------------
const ACCESS_CONTROL_MF: TemplateBundle = {
  manifestPath: 'Cargo.toml',
  defaultTests: ['tests/access.rs'],
  files: [
    {
      path: 'src/lib.rs',
      content: `#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};

mod admin;
mod storage;

#[contract]
pub struct AccessControlled;

#[contractimpl]
impl AccessControlled {
    /// Set the admin once, at deploy time.
    pub fn init(env: Env, admin: Address) {
        if admin::has_admin(&env) {
            panic!("already initialized");
        }
        admin::set_admin(&env, &admin);
    }

    /// Read the current admin.
    pub fn admin(env: Env) -> Address {
        admin::get_admin(&env)
    }

    /// Admin-only: set the stored value.
    pub fn set_value(env: Env, value: u32) {
        admin::require_admin(&env);
        storage::set_value(&env, value);
    }

    /// Anyone can read the value.
    pub fn value(env: Env) -> u32 {
        storage::get_value(&env)
    }

    /// Admin-only: hand the admin role to a new address.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        admin::require_admin(&env);
        admin::set_admin(&env, &new_admin);
    }
}
`
    },
    {
      path: 'src/admin.rs',
      content: `use soroban_sdk::{symbol_short, Address, Env, Symbol};

const ADMIN: Symbol = symbol_short!("ADMIN");

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&ADMIN)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&ADMIN, admin);
}

pub fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&ADMIN).expect("admin not set; call init first")
}

/// Read the admin and require its authorization for the current call.
pub fn require_admin(env: &Env) -> Address {
    let admin = get_admin(env);
    admin.require_auth();
    admin
}
`
    },
    {
      path: 'src/storage.rs',
      content: `use soroban_sdk::{symbol_short, Env, Symbol};

const VALUE: Symbol = symbol_short!("VALUE");

pub fn set_value(env: &Env, value: u32) {
    env.storage().instance().set(&VALUE, &value);
}

pub fn get_value(env: &Env) -> u32 {
    env.storage().instance().get(&VALUE).unwrap_or(0)
}
`
    },
    {
      path: 'tests/access.rs',
      content: `use access_control_mf::{AccessControlled, AccessControlledClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn admin_can_set_value() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, AccessControlled);
    let client = AccessControlledClient::new(&env, &id);

    let admin = Address::generate(&env);
    client.init(&admin);
    assert_eq!(client.admin(), admin);

    client.set_value(&42);
    assert_eq!(client.value(), 42);

    let new_admin = Address::generate(&env);
    client.transfer_admin(&new_admin);
    assert_eq!(client.admin(), new_admin);
}
`
    },
    { path: 'Cargo.toml', content: singleCrateCargo('access-control-mf') },
    { path: '.cargo/config.toml', content: CARGO_CONFIG }
  ]
};

// ---------------------------------------------------------------------------
// 3. SEP-41-style token split across storage / admin / balance / allowance /
//    metadata modules.
// ---------------------------------------------------------------------------
const TOKEN_MF: TemplateBundle = {
  manifestPath: 'Cargo.toml',
  defaultTests: ['tests/token.rs'],
  files: [
    {
      path: 'src/lib.rs',
      content: `#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String};

mod admin;
mod allowance;
mod balance;
mod metadata;
mod storage;

use crate::storage::TokenMetadata;

#[contract]
pub struct Token;

#[contractimpl]
impl Token {
    /// Initialize the token: set the admin and metadata. Callable once.
    pub fn initialize(env: Env, admin: Address, decimals: u32, name: String, symbol: String) {
        if admin::has_admin(&env) {
            panic!("already initialized");
        }
        admin::write_admin(&env, &admin);
        metadata::write_metadata(&env, TokenMetadata { decimals, name, symbol });
    }

    /// Admin-only: mint \`amount\` tokens to \`to\`.
    pub fn mint(env: Env, to: Address, amount: i128) {
        admin::require_admin(&env);
        balance::receive_balance(&env, &to, amount);
    }

    /// Balance of \`id\`.
    pub fn balance(env: Env, id: Address) -> i128 {
        balance::read_balance(&env, &id)
    }

    /// Transfer \`amount\` from \`from\` to \`to\` (requires \`from\`'s auth).
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        balance::spend_balance(&env, &from, amount);
        balance::receive_balance(&env, &to, amount);
    }

    /// Approve \`spender\` to spend \`amount\` of \`from\`'s balance until \`expiration_ledger\`.
    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32) {
        from.require_auth();
        allowance::write_allowance(&env, &from, &spender, amount, expiration_ledger);
    }

    /// Current allowance from \`from\` to \`spender\`.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        allowance::read_allowance(&env, &from, &spender).amount
    }

    /// Spend \`amount\` of \`from\`'s balance as \`spender\`, drawing down the allowance.
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        allowance::spend_allowance(&env, &from, &spender, amount);
        balance::spend_balance(&env, &from, amount);
        balance::receive_balance(&env, &to, amount);
    }

    pub fn decimals(env: Env) -> u32 {
        metadata::read_metadata(&env).decimals
    }

    pub fn name(env: Env) -> String {
        metadata::read_metadata(&env).name
    }

    pub fn symbol(env: Env) -> String {
        metadata::read_metadata(&env).symbol
    }
}
`
    },
    {
      path: 'src/storage.rs',
      content: `use soroban_sdk::{contracttype, Address, String};

/// Keys for everything the token stores.
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Balance(Address),
    Allowance(AllowanceKey),
    Metadata,
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct TokenMetadata {
    pub decimals: u32,
    pub name: String,
    pub symbol: String,
}
`
    },
    {
      path: 'src/admin.rs',
      content: `use crate::storage::DataKey;
use soroban_sdk::{Address, Env};

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn write_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).expect("not initialized")
}

/// Read the admin and require its authorization for the current call.
pub fn require_admin(env: &Env) -> Address {
    let admin = read_admin(env);
    admin.require_auth();
    admin
}
`
    },
    {
      path: 'src/balance.rs',
      content: `use crate::storage::DataKey;
use soroban_sdk::{Address, Env};

pub fn read_balance(env: &Env, addr: &Address) -> i128 {
    env.storage().persistent().get(&DataKey::Balance(addr.clone())).unwrap_or(0)
}

fn write_balance(env: &Env, addr: &Address, amount: i128) {
    env.storage().persistent().set(&DataKey::Balance(addr.clone()), &amount);
}

pub fn receive_balance(env: &Env, addr: &Address, amount: i128) {
    let balance = read_balance(env, addr);
    write_balance(env, addr, balance + amount);
}

pub fn spend_balance(env: &Env, addr: &Address, amount: i128) {
    let balance = read_balance(env, addr);
    if balance < amount {
        panic!("insufficient balance");
    }
    write_balance(env, addr, balance - amount);
}
`
    },
    {
      path: 'src/allowance.rs',
      content: `use crate::storage::{AllowanceKey, AllowanceValue, DataKey};
use soroban_sdk::{Address, Env};

pub fn read_allowance(env: &Env, from: &Address, spender: &Address) -> AllowanceValue {
    let key = DataKey::Allowance(AllowanceKey { from: from.clone(), spender: spender.clone() });
    env.storage()
        .temporary()
        .get(&key)
        .unwrap_or(AllowanceValue { amount: 0, expiration_ledger: 0 })
}

pub fn write_allowance(env: &Env, from: &Address, spender: &Address, amount: i128, expiration_ledger: u32) {
    let key = DataKey::Allowance(AllowanceKey { from: from.clone(), spender: spender.clone() });
    env.storage().temporary().set(&key, &AllowanceValue { amount, expiration_ledger });
}

pub fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
    let allowance = read_allowance(env, from, spender);
    if allowance.amount < amount {
        panic!("insufficient allowance");
    }
    write_allowance(env, from, spender, allowance.amount - amount, allowance.expiration_ledger);
}
`
    },
    {
      path: 'src/metadata.rs',
      content: `use crate::storage::{DataKey, TokenMetadata};
use soroban_sdk::Env;

pub fn write_metadata(env: &Env, metadata: TokenMetadata) {
    env.storage().instance().set(&DataKey::Metadata, &metadata);
}

pub fn read_metadata(env: &Env) -> TokenMetadata {
    env.storage().instance().get(&DataKey::Metadata).expect("not initialized")
}
`
    },
    {
      path: 'tests/token.rs',
      content: `use soroban_sdk::{testutils::Address as _, Address, Env, String};
use token_mf::{Token, TokenClient};

#[test]
fn mint_transfer_and_allowance() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, Token);
    let client = TokenClient::new(&env, &id);

    let admin = Address::generate(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(&admin, &7u32, &String::from_str(&env, "Example"), &String::from_str(&env, "EXM"));
    assert_eq!(client.decimals(), 7);

    client.mint(&a, &1000);
    assert_eq!(client.balance(&a), 1000);

    client.transfer(&a, &b, &400);
    assert_eq!(client.balance(&a), 600);
    assert_eq!(client.balance(&b), 400);

    client.approve(&a, &b, &200, &1000);
    assert_eq!(client.allowance(&a, &b), 200);

    client.transfer_from(&b, &a, &b, &150);
    assert_eq!(client.balance(&b), 550);
    assert_eq!(client.allowance(&a, &b), 50);
}
`
    },
    { path: 'Cargo.toml', content: singleCrateCargo('token-mf') },
    { path: '.cargo/config.toml', content: CARGO_CONFIG }
  ]
};

// ---------------------------------------------------------------------------
// 4. (STRETCH) Workspace: a factory contract that calls a child contract via a
//    cross-contract call. Two deployable members; deployTarget = "factory".
// ---------------------------------------------------------------------------
const WORKSPACE_FACTORY: TemplateBundle = {
  manifestPath: 'Cargo.toml',
  deployTarget: 'factory',
  defaultTests: ['contracts/factory/tests/cross.rs'],
  files: [
    {
      path: 'Cargo.toml',
      content: `[workspace]
members = ["contracts/child", "contracts/factory"]
resolver = "2"

[profile.release]
opt-level = "z"
overflow-checks = true
`
    },
    { path: '.cargo/config.toml', content: CARGO_CONFIG },
    {
      path: 'contracts/child/Cargo.toml',
      content: `[package]
name = "child"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[features]
testutils = ["soroban-sdk/testutils"]

[lib]
crate-type = ["cdylib", "rlib"]
`
    },
    {
      path: 'contracts/child/src/lib.rs',
      content: `#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol};

const COUNT: Symbol = symbol_short!("COUNT");

#[contract]
pub struct Child;

#[contractimpl]
impl Child {
    pub fn increment(env: Env) -> u32 {
        let next: u32 = env.storage().instance().get(&COUNT).unwrap_or(0) + 1;
        env.storage().instance().set(&COUNT, &next);
        next
    }

    pub fn get(env: Env) -> u32 {
        env.storage().instance().get(&COUNT).unwrap_or(0)
    }
}
`
    },
    {
      path: 'contracts/factory/Cargo.toml',
      content: `[package]
name = "factory"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"
child = { path = "../child" }

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }
child = { path = "../child", features = ["testutils"] }

[lib]
crate-type = ["cdylib", "rlib"]
`
    },
    {
      path: 'contracts/factory/src/lib.rs',
      content: `#![no_std]
use child::ChildClient;
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct Factory;

#[contractimpl]
impl Factory {
    /// Cross-contract call: increment the given child counter, returning its new value.
    pub fn bump(env: Env, child: Address) -> u32 {
        ChildClient::new(&env, &child).increment()
    }

    /// Read the child counter via a cross-contract call.
    pub fn read(env: Env, child: Address) -> u32 {
        ChildClient::new(&env, &child).get()
    }
}
`
    },
    {
      path: 'contracts/factory/tests/cross.rs',
      content: `use child::Child;
use factory::{Factory, FactoryClient};
use soroban_sdk::Env;

#[test]
fn factory_bumps_child_via_cross_contract() {
    let env = Env::default();
    let child_id = env.register_contract(None, Child);
    let factory_id = env.register_contract(None, Factory);
    let factory = FactoryClient::new(&env, &factory_id);

    assert_eq!(factory.bump(&child_id), 1);
    assert_eq!(factory.bump(&child_id), 2);
    assert_eq!(factory.read(&child_id), 2);
}
`
    }
  ]
};

// ---------------------------------------------------------------------------
// Paid API endpoint — a runnable Node/TypeScript service protected by x402 on
// Stellar testnet. The managed adapter is included in the generated tree so the
// scaffold works before @websoroban/pay is published as a public npm package.
// ---------------------------------------------------------------------------
const PAID_API_ENDPOINT: TemplateBundle = {
  manifestPath: 'package.json',
  files: [
    {
      path: 'package.json',
      content: `{
  "name": "websoroban-paid-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "dev": "tsx watch --env-file=.env src/server.ts",
    "build": "tsc",
    "start": "node --env-file=.env dist/server.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@x402/core": "^2.25.0",
    "@x402/express": "^2.25.0",
    "@x402/stellar": "^2.25.0",
    "dotenv": "^16.6.1",
    "express": "^4.21.2"
  },
  "devDependencies": {
    "@types/express": "^5.0.3",
    "@types/node": "^22.18.0",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
`
    },
    {
      path: 'tsconfig.json',
      content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
`
    },
    {
      path: '.env.example',
      content: `# Copy this file to .env. Create the endpoint in WebSoroban Payment Studio.
WEBSOROBAN_API_URL=https://backend-ide-production.up.railway.app/api
WEBSOROBAN_ENDPOINT_ID=replace_with_endpoint_id
WEBSOROBAN_PAY_KEY=replace_with_scoped_endpoint_key
STELLAR_PAY_TO=G_REPLACE_WITH_YOUR_TESTNET_RECIPIENT
PORT=8787
`
    },
    {
      path: 'src/config.ts',
      content: `function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(\`Missing \${name}. Copy .env.example to .env and fill it in.\`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  apiUrl: process.env.WEBSOROBAN_API_URL || 'https://backend-ide-production.up.railway.app/api',
  endpointId: required('WEBSOROBAN_ENDPOINT_ID'),
  apiKey: required('WEBSOROBAN_PAY_KEY'),
  payTo: required('STELLAR_PAY_TO'),
};
`
    },
    {
      path: 'src/websoroban-pay.ts',
      content: `import type { RequestHandler } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';

const STELLAR_TESTNET = 'stellar:testnet' as const;

export interface WebSorobanPayOptions {
  apiUrl: string;
  apiKey: string;
  endpointId: string;
  payTo: string;
}

export interface ProtectOptions {
  description?: string;
  maxTimeoutSeconds?: number;
}

export function createWebSorobanPay(options: WebSorobanPayOptions) {
  if (!options.apiKey) throw new Error('WEBSOROBAN_PAY_KEY is required.');
  if (!options.endpointId) throw new Error('WEBSOROBAN_ENDPOINT_ID is required.');
  if (!/^G[A-Z2-7]{55}$/.test(options.payTo)) {
    throw new Error('STELLAR_PAY_TO must be a Stellar G-address.');
  }

  const facilitator = new HTTPFacilitatorClient({
    url: options.apiUrl.replace(/\\/$/, '') + '/pay/facilitator',
    createAuthHeaders: async () => {
      const auth = { Authorization: 'Bearer ' + options.apiKey };
      return { verify: auth, settle: auth, supported: auth };
    },
  });

  const resourceServer = new x402ResourceServer(facilitator)
    .register(STELLAR_TESTNET, new ExactStellarScheme());

  return {
    protect(
      route: \`\${'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} /\${string}\`,
      price: string,
      settings: ProtectOptions = {},
    ): RequestHandler {
      return paymentMiddleware({
        [route]: {
          accepts: {
            scheme: 'exact',
            network: STELLAR_TESTNET,
            price,
            payTo: options.payTo,
            maxTimeoutSeconds: settings.maxTimeoutSeconds ?? 60,
          },
          serviceName: 'WebSoroban Pay',
          description: settings.description || 'A Stellar testnet endpoint protected by x402.',
          mimeType: 'application/json',
        },
      }, resourceServer, undefined, undefined, true);
    },
  };
}
`
    },
    {
      path: 'src/server.ts',
      content: `import 'dotenv/config';
import express from 'express';
import { config } from './config.js';
import { createWebSorobanPay } from './websoroban-pay.js';

const app = express();
app.use(express.json());

const pay = createWebSorobanPay({
  apiUrl: config.apiUrl,
  apiKey: config.apiKey,
  endpointId: config.endpointId,
  payTo: config.payTo,
});

app.get('/health', (_request, response) => {
  response.json({ ok: true, network: 'stellar:testnet' });
});

// This is the one-line paywall. The handler below runs only after settlement.
app.use(pay.protect('GET /api/research-brief', '$0.01', {
  description: 'Unlock the WebSoroban research brief.',
}));

app.get('/api/research-brief', (_request, response) => {
  response.json({
    title: 'Agentic payments on Stellar',
    summary: 'The request paid 0.01 USDC and reached the protected handler.',
    paid: true,
    network: 'stellar:testnet',
  });
});

app.listen(config.port, () => {
  console.log(\`Paid API listening on http://localhost:\${config.port}\`);
  console.log(\`Protected route: http://localhost:\${config.port}/api/research-brief\`);
});
`
    },
    {
      path: 'requests.http',
      content: `### Public health check
GET http://localhost:8787/health

### Unpaid request — should return HTTP 402 with x402 payment requirements
GET http://localhost:8787/api/research-brief
Accept: application/json
`
    },
    {
      path: 'README.md',
      content: `# Paid API endpoint

A runnable Express + TypeScript endpoint protected by **$0.01 USDC on Stellar testnet** through WebSoroban's managed x402 facilitator.

## 1. Create the payment endpoint

Open **WebSoroban → Payments → New endpoint** and create a testnet endpoint with:

- Route: \`GET /api/research-brief\`
- Price: \`$0.01\`
- Recipient: your funded Stellar testnet G-address

Copy the endpoint id and the scoped key when it is shown. The key is displayed once.

## 2. Configure and run

\`\`\`bash
cp .env.example .env
# Fill WEBSOROBAN_ENDPOINT_ID, WEBSOROBAN_PAY_KEY, and STELLAR_PAY_TO
pnpm install
pnpm dev
\`\`\`

Node 22 or newer is required by \`@x402/stellar\`.

## 3. Confirm the paywall

\`\`\`bash
curl -i http://localhost:8787/api/research-brief
\`\`\`

The first request returns **HTTP 402** and payment requirements. An x402-compatible client signs the Stellar authorization, retries with the payment header, and receives the protected JSON after settlement.

Use \`requests.http\` for the public health check and unpaid challenge. The scoped key stays on this server; never expose it in browser code or commit your \`.env\` file.
`
    },
    {
      path: '.gitignore',
      content: `node_modules/
.env
dist/
`
    }
  ]
};

export const TEMPLATE_BUNDLES: Record<string, TemplateBundle> = {
  'paid-api-endpoint': PAID_API_ENDPOINT,
  'counter-mf': COUNTER_MF,
  'access-control-mf': ACCESS_CONTROL_MF,
  'token-mf': TOKEN_MF,
  'workspace-factory': WORKSPACE_FACTORY
};

export function getBundle(id: string): TemplateBundle | null {
  return TEMPLATE_BUNDLES[id] || null;
}

export default { TEMPLATE_BUNDLES, getBundle };
