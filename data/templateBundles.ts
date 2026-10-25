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
// scaffold works before @web-soroban/pay is published as a public npm package.
// ---------------------------------------------------------------------------
const PAID_API_ENDPOINT: TemplateBundle = {
  manifestPath: 'package.json',
  files: [
    {
      path: 'package.json',
      content: `{
  "name": "websoroban-paid-api",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "dev": "tsx watch --env-file=.env src/server.ts",
    "pay": "tsx --env-file=.env scripts/pay.ts",
    "build": "tsc",
    "start": "node --env-file=.env dist/server.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@x402/core": "^2.25.0",
    "@x402/express": "^2.25.0",
    "@x402/fetch": "^2.25.0",
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
WEBSOROBAN_API_URL=https://backend-ide-production-003a.up.railway.app/api
WEBSOROBAN_ENDPOINT_ID=replace_with_endpoint_id
# wsp_test_… settles on Stellar testnet, wsp_live_… on mainnet.
WEBSOROBAN_PAY_KEY=replace_with_scoped_endpoint_key
STELLAR_PAY_TO=G_REPLACE_WITH_THE_ENDPOINT_PAYOUT_ADDRESS
PORT=8787

# Optional, testnet only: a payer secret used by \`pnpm pay\` to make a real
# paid request from the terminal. The account needs testnet USDC.
PAYER_SECRET=
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
  apiUrl: process.env.WEBSOROBAN_API_URL || 'https://backend-ide-production-003a.up.railway.app/api',
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

export type StellarNetwork = 'stellar:testnet' | 'stellar:pubnet';

const HORIZON: Record<StellarNetwork, string> = {
  'stellar:testnet': 'https://horizon-testnet.stellar.org',
  'stellar:pubnet': 'https://horizon.stellar.org',
};
const USDC_ISSUER: Record<StellarNetwork, string> = {
  'stellar:testnet': 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  'stellar:pubnet': 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

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

/** The key prefix decides the network, so a testnet key never guards a mainnet route. */
export function networkFromKey(apiKey: string): StellarNetwork {
  if (apiKey.startsWith('wsp_live_')) return 'stellar:pubnet';
  if (apiKey.startsWith('wsp_test_')) return 'stellar:testnet';
  throw new Error('WEBSOROBAN_PAY_KEY must start with wsp_test_ or wsp_live_.');
}

export function createWebSorobanPay(options: WebSorobanPayOptions) {
  if (!options.apiKey) throw new Error('WEBSOROBAN_PAY_KEY is required.');
  if (!options.endpointId) throw new Error('WEBSOROBAN_ENDPOINT_ID is required.');
  if (!/^[GC][A-Z2-7]{55}$/.test(options.payTo)) {
    throw new Error('STELLAR_PAY_TO must be the endpoint payout address (G… or C…).');
  }
  const network = networkFromKey(options.apiKey);
  const facilitatorUrl = options.apiUrl.replace(/\\/$/, '') + '/pay/facilitator';
  const auth = { Authorization: 'Bearer ' + options.apiKey };

  const facilitator = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  });
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactStellarScheme());

  return {
    network,

    protect(
      route: \`\${'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} /\${string}\`,
      price: string,
      settings: ProtectOptions = {},
    ): RequestHandler {
      return paymentMiddleware({
        [route]: {
          accepts: {
            scheme: 'exact',
            network,
            price,
            payTo: options.payTo,
            maxTimeoutSeconds: settings.maxTimeoutSeconds ?? 60,
          },
          serviceName: 'WebSoroban Pay',
          description: settings.description || 'A Stellar endpoint protected by x402.',
          mimeType: 'application/json',
        },
      }, resourceServer, undefined, undefined, true);
    },

    /** Startup check: the key reaches WebSoroban and the payout account can receive USDC. */
    async preflight(): Promise<string[]> {
      const problems: string[] = [];
      try {
        const response = await fetch(facilitatorUrl + '/supported', { headers: auth, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          problems.push('Endpoint key rejected: ' + (body.message || 'HTTP ' + response.status) + '. Copy the key again from Payment Studio.');
        }
      } catch {
        problems.push('Could not reach ' + facilitatorUrl + '. Check WEBSOROBAN_API_URL.');
      }
      if (options.payTo.startsWith('G')) {
        try {
          const response = await fetch(HORIZON[network] + '/accounts/' + options.payTo, { signal: AbortSignal.timeout(5_000) });
          if (response.status === 404) {
            problems.push('STELLAR_PAY_TO does not exist on ' + network + '. Fund it with XLM first.');
          } else if (response.ok) {
            const account = (await response.json()) as { balances?: Array<{ asset_code?: string; asset_issuer?: string }> };
            const hasUsdc = (account.balances || []).some((line) => line.asset_code === 'USDC' && line.asset_issuer === USDC_ISSUER[network]);
            if (!hasUsdc) problems.push('STELLAR_PAY_TO has no USDC trustline, so settlements to it will fail. Add USDC in its wallet.');
          }
        } catch {
          // Horizon being unreachable is not a configuration problem.
        }
      }
      return problems;
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
  response.json({ ok: true, network: pay.network });
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
    network: pay.network,
  });
});

app.listen(config.port, async () => {
  console.log(\`Paid API listening on http://localhost:\${config.port} (\${pay.network})\`);
  console.log(\`Protected route: http://localhost:\${config.port}/api/research-brief\`);
  const problems = await pay.preflight();
  if (problems.length) {
    console.warn('\\nSetup needs attention before payments can settle:');
    for (const problem of problems) console.warn('  • ' + problem);
  } else {
    console.log('Preflight passed: key accepted and payout account can receive USDC.');
  }
});
`
    },
    {
      path: 'scripts/pay.ts',
      content: `// Make one real paid request from the terminal (testnet only).
// The payer signs a single USDC authorization; WebSoroban's facilitator
// submits it and sponsors the network fee.
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';

const secret = process.env.PAYER_SECRET?.trim();
const port = Number(process.env.PORT || 8787);
const url = process.argv[2] || \`http://localhost:\${port}/api/research-brief\`;

if (!secret) {
  console.error('Set PAYER_SECRET in .env to a testnet account that holds testnet USDC.');
  process.exit(1);
}
if (process.env.WEBSOROBAN_PAY_KEY?.startsWith('wsp_live_')) {
  console.error('pnpm pay is testnet only. Pay mainnet endpoints from a wallet.');
  process.exit(1);
}

const signer = createEd25519Signer(secret, 'stellar:testnet');
const client = new x402Client().register('stellar:*', new ExactStellarScheme(signer, { url: 'https://soroban-testnet.stellar.org' }));
const paidFetch = wrapFetchWithPayment(fetch, client);

const httpClient = new x402HTTPClient(client);
const rejection = (res: Response) => {
  try { return String(httpClient.getPaymentRequiredResponse((name) => res.headers.get(name)).error || ''); } catch { return ''; }
};
let response = await paidFetch(url, { headers: { Accept: 'application/json' } });
// The facilitator re-simulates at verification. If network fees moved in the
// seconds since signing it rejects with fee_below_minimum and charges nothing,
// so sign once more (never more than once).
if (response.status === 402 && /fee[ _]below[ _]minimum/i.test(rejection(response))) {
  console.log('Network fees moved while signing; nothing was charged. Retrying once…');
  response = await paidFetch(url, { headers: { Accept: 'application/json' } });
}
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(\`Payment failed with HTTP \${response.status}:\`, body);
  process.exit(1);
}
const settlement = httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
console.log('Paid response:', body);
if (settlement?.transaction) {
  console.log(\`Receipt: https://stellar.expert/explorer/testnet/tx/\${settlement.transaction}\`);
}
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

A runnable Express + TypeScript endpoint protected by **$0.01 USDC on Stellar** through WebSoroban's managed x402 facilitator. Testnet by default; a \`wsp_live_\` key switches it to mainnet.

## 1. Create the payment endpoint

Open **WebSoroban → Pay** and create a testnet endpoint:

- Price: \`0.01\`
- Payout address: a funded Stellar testnet G-address **with a USDC trustline** (the studio checks this for you)

Copy the endpoint id and the scoped key when they are shown. The key is displayed once.

## 2. Configure and run

\`\`\`bash
cp .env.example .env
# Fill WEBSOROBAN_ENDPOINT_ID, WEBSOROBAN_PAY_KEY, and STELLAR_PAY_TO
pnpm install
pnpm dev
\`\`\`

On start the server runs a preflight: it confirms the key reaches WebSoroban and that the payout account can receive USDC, and prints exactly what to fix if not. Node 22 or newer is required by \`@x402/stellar\`.

## 3. Confirm the paywall

\`\`\`bash
curl -i http://localhost:8787/api/research-brief
\`\`\`

The first request returns **HTTP 402** with payment requirements.

## 4. Make a paid request

Put a testnet account secret with testnet USDC in \`PAYER_SECRET\` (get USDC from https://faucet.circle.com, Stellar Testnet), then:

\`\`\`bash
pnpm pay
\`\`\`

The script signs one USDC authorization, the facilitator settles it, and you get the protected JSON plus a Stellar Expert receipt link. The payment appears in Payment Studio's activity feed. Browser users can pay the same endpoint from the hosted checkout.

The scoped key stays on this server; never expose it in browser code or commit your \`.env\` file.
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

// ---------------------------------------------------------------------------
// PayLoop merchant — gate content behind an active PayLoop subscription.
// ---------------------------------------------------------------------------
const PAYLOOP_MERCHANT: TemplateBundle = {
  manifestPath: 'package.json',
  files: [
    {
      path: 'package.json',
      content: `{
  "name": "payloop-merchant",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "dev": "tsx watch --env-file=.env src/server.ts",
    "watch-charges": "tsx --env-file=.env scripts/watch-charges.ts",
    "build": "tsc",
    "start": "node --env-file=.env dist/server.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@stellar/stellar-sdk": "^14.6.1",
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
      content: `# WebSoroban API that indexes PayLoop policies and charges.
PAYLOOP_API_URL=https://backend-ide-production-003a.up.railway.app/api
# The Stellar address your subscribers pay. It needs a USDC trustline.
MERCHANT_ADDRESS=G_REPLACE_WITH_YOUR_MERCHANT_ADDRESS
# The plan a subscriber must hold: amount per charge and billing interval.
PLAN_AMOUNT_USDC=0.1
PLAN_INTERVAL_SECONDS=60
# Where customers subscribe (the WebSoroban PayLoop page or your own checkout).
SUBSCRIBE_URL=https://websoroban.in/payloop
PORT=8788
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
  port: Number(process.env.PORT || 8788),
  apiUrl: (process.env.PAYLOOP_API_URL || 'https://backend-ide-production-003a.up.railway.app/api').replace(/\\/$/, ''),
  merchant: required('MERCHANT_ADDRESS'),
  planAmountUsdc: required('PLAN_AMOUNT_USDC'),
  planIntervalSeconds: Number(required('PLAN_INTERVAL_SECONDS')),
  subscribeUrl: process.env.SUBSCRIBE_URL || 'https://websoroban.in/payloop',
};
`
    },
    {
      path: 'src/payloop.ts',
      content: `import { config } from './config.js';

export interface Policy {
  policyId: string;
  subscriber: string;
  merchant: string;
  amount: string;
  amountUsdc: string;
  intervalSeconds: number;
  spentUsdc: string;
  capUsdc: string;
  charges: number;
  failedAttempts: number;
  nextChargeAt: string;
  status: 'active' | 'paused' | 'revoked' | 'completed';
}

/** USDC has 7 decimals on Stellar; compare plan amounts in stroops, never floats. */
export function toStroops(usdc: string): bigint {
  const [whole, fraction = ''] = usdc.trim().split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0').slice(0, 7));
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(\`\${config.apiUrl}\${path}\`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || \`PayLoop API returned HTTP \${response.status}.\`);
  return body as T;
}

export async function merchantPolicies(status?: Policy['status']): Promise<Policy[]> {
  const query = new URLSearchParams({ merchant: config.merchant, ...(status ? { status } : {}) });
  return (await get<{ policies: Policy[] }>(\`/payloop/policies?\${query}\`)).policies;
}

/**
 * The subscriber's active policy for this merchant's plan, or null.
 * A policy counts only if it pays this merchant the plan amount on the plan interval.
 */
export async function activeSubscription(subscriber: string): Promise<Policy | null> {
  const query = new URLSearchParams({ subscriber, status: 'active' });
  const { policies } = await get<{ policies: Policy[] }>(\`/payloop/policies?\${query}\`);
  const amount = toStroops(config.planAmountUsdc);
  return policies.find((policy) =>
    policy.merchant === config.merchant &&
    BigInt(policy.amount) === amount &&
    policy.intervalSeconds === config.planIntervalSeconds,
  ) || null;
}
`
    },
    {
      path: 'src/wallet-auth.ts',
      content: `import { Keypair, StrKey, hash } from '@stellar/stellar-sdk';

/**
 * Proof that a customer controls a Stellar wallet: they sign a short,
 * timestamped message with SEP-53 \`signMessage\` (supported by Freighter).
 */
const PREFIX = 'Stellar Signed Message:\\n';
const MAX_AGE_SECONDS = 300;
const seen = new Map<string, number>();

export function challengeFor(wallet: string, now = Date.now()): string {
  return \`Sign in to PayLoop merchant as \${wallet} at \${Math.floor(now / 1000)}\`;
}

export function verifyWalletSignature(wallet: string, message: string, signatureBase64: string, now = Date.now()): string | null {
  if (!StrKey.isValidEd25519PublicKey(wallet)) return 'Use a Stellar G-address.';
  const match = message.match(/^Sign in to PayLoop merchant as (G[A-Z2-7]{55}) at (\\d+)$/);
  if (!match || match[1] !== wallet) return 'The message does not match this wallet.';
  const age = now / 1000 - Number(match[2]);
  if (age < -30 || age > MAX_AGE_SECONDS) return 'The sign-in message expired. Request a new one.';
  const signature = Buffer.from(signatureBase64, 'base64');
  const digest = hash(Buffer.from(PREFIX + message, 'utf8'));
  if (signature.length !== 64 || !Keypair.fromPublicKey(wallet).verify(digest, signature)) return 'The signature is not valid for this wallet.';
  // Each signed message works once inside its validity window.
  const key = \`\${wallet}:\${signatureBase64}\`;
  if (seen.has(key)) return 'This signature was already used.';
  seen.set(key, now);
  for (const [entry, at] of seen) if (now - at > MAX_AGE_SECONDS * 1000) seen.delete(entry);
  return null;
}
`
    },
    {
      path: 'src/server.ts',
      content: `import express from 'express';
import { config } from './config.js';
import { activeSubscription, merchantPolicies } from './payloop.js';
import { challengeFor, verifyWalletSignature } from './wallet-auth.js';

const app = express();
app.use(express.json());

app.get('/health', (_request, response) => {
  response.json({ ok: true, merchant: config.merchant });
});

// 1. The customer asks for a message to sign with their wallet.
app.get('/api/challenge', (request, response) => {
  const wallet = String(request.query.wallet || '');
  response.json({ message: challengeFor(wallet) });
});

// 2. They send it back signed; access depends on an active PayLoop policy.
app.post('/api/premium', async (request, response) => {
  const { wallet, message, signature } = request.body as { wallet?: string; message?: string; signature?: string };
  const problem = verifyWalletSignature(String(wallet || ''), String(message || ''), String(signature || ''));
  if (problem) return response.status(401).json({ error: 'wallet_not_verified', message: problem });

  try {
    const policy = await activeSubscription(String(wallet));
    if (!policy) {
      return response.status(402).json({
        error: 'subscription_required',
        message: \`Subscribe for \${config.planAmountUsdc} USDC every \${config.planIntervalSeconds}s to unlock this content.\`,
        subscribe: config.subscribeUrl,
        merchant: config.merchant,
      });
    }
    response.json({
      content: 'Premium content for active subscribers.',
      subscription: { policyId: policy.policyId, nextChargeAt: policy.nextChargeAt, charges: policy.charges },
    });
  } catch (error) {
    response.status(503).json({ error: 'payloop_unavailable', message: error instanceof Error ? error.message : 'PayLoop API unavailable.' });
  }
});

// Merchant dashboard data: every active subscription paying this address.
app.get('/api/subscribers', async (_request, response) => {
  try {
    const policies = await merchantPolicies('active');
    response.json({ count: policies.length, policies });
  } catch (error) {
    response.status(503).json({ error: error instanceof Error ? error.message : 'PayLoop API unavailable.' });
  }
});

app.listen(config.port, () => {
  console.log(\`PayLoop merchant listening on http://localhost:\${config.port}\`);
  console.log(\`Plan: \${config.planAmountUsdc} USDC every \${config.planIntervalSeconds}s to \${config.merchant}\`);
});
`
    },
    {
      path: 'scripts/watch-charges.ts',
      content: `// Print every new PayLoop charge to this merchant as the relayer settles it.
import { merchantPolicies, type Policy } from '../src/payloop.js';

const seen = new Map<string, number>();
const POLL_MS = 15_000;

async function poll(first: boolean) {
  const policies: Policy[] = await merchantPolicies();
  for (const policy of policies) {
    const previous = seen.get(policy.policyId);
    if (!first && previous !== undefined && policy.charges > previous) {
      console.log(\`\${new Date().toISOString()} policy #\${policy.policyId} paid \${policy.amountUsdc} USDC (charge \${policy.charges}, total \${policy.spentUsdc}/\${policy.capUsdc})\`);
    } else if (!first && previous === undefined) {
      console.log(\`\${new Date().toISOString()} new subscriber \${policy.subscriber} on policy #\${policy.policyId} (\${policy.status})\`);
    }
    if (!first && policy.failedAttempts > 0 && previous === policy.charges) {
      console.log(\`\${new Date().toISOString()} policy #\${policy.policyId} could not be charged (\${policy.failedAttempts} attempts); the relayer retries\`);
    }
    seen.set(policy.policyId, policy.charges);
  }
  if (first) console.log(\`Watching \${policies.length} policies…\`);
}

await poll(true);
setInterval(() => poll(false).catch((error) => console.error(error instanceof Error ? error.message : error)), POLL_MS);
`
    },
    {
      path: 'README.md',
      content: `# PayLoop merchant

Gate content behind a non-custodial USDC subscription. Customers subscribe with
PayLoop: one signed policy pays you a fixed USDC amount on a fixed interval
from their own wallet. This server checks for an active policy before it
serves premium content. You run no chain infrastructure: WebSoroban's relayer
submits the charges and its indexer serves the policies.

## 1. Configure

\`\`\`bash
cp .env.example .env
\`\`\`

- \`MERCHANT_ADDRESS\`: the Stellar address you get paid at. It needs a USDC trustline.
- \`PLAN_AMOUNT_USDC\` and \`PLAN_INTERVAL_SECONDS\`: the plan a customer must hold.
  \`0.1\` every \`60\` seconds is a good testnet demo; production plans are usually
  monthly (\`2592000\`).

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

## 2. Subscribe as a customer

Open the WebSoroban **PayLoop** page on testnet, connect a wallet, fund it with
test USDC, and sign a policy to your \`MERCHANT_ADDRESS\` with the plan amount
and interval. The first charge settles immediately.

## 3. Unlock premium content

The customer proves wallet ownership by signing a short message (SEP-53
\`signMessage\`, supported by Freighter):

\`\`\`bash
curl "http://localhost:8788/api/challenge?wallet=G…CUSTOMER"
# sign the returned message in the wallet, then:
curl -X POST http://localhost:8788/api/premium \\
  -H 'Content-Type: application/json' \\
  -d '{"wallet":"G…CUSTOMER","message":"…","signature":"<base64>"}'
\`\`\`

- \`200\`: the wallet holds an active policy for your plan.
- \`402 subscription_required\`: no matching active policy. The response links to the subscribe page.
- \`401 wallet_not_verified\`: the signature is missing, wrong, reused, or older than five minutes.

## 4. Watch payments arrive

\`\`\`bash
pnpm watch-charges
\`\`\`

This prints each charge as the relayer settles it, new subscribers, and any
charge a subscriber could not cover. The relayer retries those automatically
with backoff. \`GET /api/subscribers\` lists every active subscription paying you.

## How access stays correct

- A policy counts only if it pays **your** address the **plan amount** on the
  **plan interval**. Amounts are compared in stroops, never floats.
- Customers can pause or revoke at any time from their wallet. A paused or
  revoked policy stops granting access on the next request.
- The contract enforces the amount, schedule, and safety cap on-chain. Nobody,
  including WebSoroban, can charge a customer more than they signed for.
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
  'payloop-merchant': PAYLOOP_MERCHANT,
  'counter-mf': COUNTER_MF,
  'access-control-mf': ACCESS_CONTROL_MF,
  'token-mf': TOKEN_MF,
  'workspace-factory': WORKSPACE_FACTORY
};

export function getBundle(id: string): TemplateBundle | null {
  return TEMPLATE_BUNDLES[id] || null;
}

export default { TEMPLATE_BUNDLES, getBundle };
