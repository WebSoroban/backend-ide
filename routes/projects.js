const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { serializeProject } = require('../lib/serialize');
const { authenticate } = require('../middleware/auth');
const { FREE_TEMPLATE_IDS } = require('../data/templateCatalog');

// GET /api/projects - List all projects for current user
router.get('/', authenticate, async (req, res) => {
  try {
    const user = req.user;
    // Get all projects for this user (exclude local projects from list view)
    const projects = await prisma.project.findMany({
      where: { userId: user.id, isLocal: false },
      orderBy: { updatedAt: 'desc' },
      include: { files: true, deployments: { orderBy: { createdAt: 'desc' } } }
    });
    res.json(projects.map(serializeProject));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// POST /api/projects - Create new project
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, files, template, isLocal } = req.body;
    const user = req.user;
    
    let defaultFiles;
    const projectName = name || 'Untitled Project';
    // Convert project name to a valid crate name (lowercase, replace spaces with hyphens, remove special chars)
    const crateName = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'contract';
    
    // Premium template access: user must have purchased the template
    if (template && template !== 'blank' && template !== 'empty' && !FREE_TEMPLATE_IDS.includes(template)) {
      const purchased = user.purchasedTemplates || [];
      if (!purchased.includes(template)) {
        return res.status(403).json({
          error: 'Template not purchased',
          code: 'TEMPLATE_PURCHASE_REQUIRED',
          message: 'Purchase this template from the marketplace to use it.'
        });
      }
    }

    if (template === 'blank' || template === 'empty') {
      // Create blank project with empty lib.rs, Cargo.toml with project name, and .cargo/config.toml
      defaultFiles = [
        {
          name: 'lib.rs',
          type: 'file',
          content: ''
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "${crateName}"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        }
      ];
    } else if (template === 'counter') {
      defaultFiles = [
        {
          name: 'lib.rs',
          type: 'file',
          content: `#![no_std]
use core::clone::Clone;
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol, Vec};

#[contract]
pub struct CounterContract;

#[contractimpl]
impl CounterContract {
    pub fn increment(env: Env) -> i32 {
        let key = symbol_short!("counter");
        let current: i32 = env.storage().instance().get(&key).unwrap_or(0);
        let new_value = current + 1;
        env.storage().instance().set(&key, &new_value);
        new_value
    }

    pub fn decrement(env: Env) -> i32 {
        let key = symbol_short!("counter");
        let current: i32 = env.storage().instance().get(&key).unwrap_or(0);
        let new_value = current - 1;
        env.storage().instance().set(&key, &new_value);
        new_value
    }

    pub fn get(env: Env) -> i32 {
        let key = symbol_short!("counter");
        env.storage().instance().get(&key).unwrap_or(0)
    }
}`
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "counter-contract"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        },
        {
          name: 'test.rs',
          type: 'file',
          content: `#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_increment() {
        let env = Env::default();
        let contract_id = env.register_contract(None, CounterContract);
        let client = CounterContractClient::new(&env, &contract_id);

        assert_eq!(client.get(), 0);
        assert_eq!(client.increment(), 1);
        assert_eq!(client.get(), 1);
    }

    #[test]
    fn test_decrement() {
        let env = Env::default();
        let contract_id = env.register_contract(None, CounterContract);
        let client = CounterContractClient::new(&env, &contract_id);

        assert_eq!(client.get(), 0);
        assert_eq!(client.decrement(), -1);
        assert_eq!(client.get(), -1);
    }
}`
        }
      ];
    } else if (template === 'token') {
      defaultFiles = [
        {
          name: 'lib.rs',
          type: 'file',
          content: `#![no_std]
use core::clone::Clone;
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol, Address, Vec};

#[contract]
pub struct TokenContract;

#[contractimpl]
impl TokenContract {
    pub fn initialize(env: Env, admin: Address, decimals: u32, name: Symbol, symbol: Symbol) {
        env.storage().instance().set(&symbol_short!("admin"), &admin);
        env.storage().instance().set(&symbol_short!("decimals"), &decimals);
        env.storage().instance().set(&symbol_short!("name"), &name);
        env.storage().instance().set(&symbol_short!("symbol"), &symbol);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&symbol_short!("admin")).unwrap();
        admin.require_auth();
        
        let key = symbol_short!("balance");
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(current + amount));
    }

    pub fn balance(env: Env, owner: Address) -> i128 {
        let key = symbol_short!("balance");
        env.storage().instance().get(&key).unwrap_or(0)
    }
}`
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "token-contract"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        }
      ];
    } else if (template === 'voting') {
      defaultFiles = [
        {
          name: 'lib.rs',
          type: 'file',
          content: `#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol, Address, Vec};

#[contract]
pub struct VotingContract;

#[contractimpl]
impl VotingContract {
    pub fn create_proposal(env: Env, proposer: Address, description: Symbol) -> u32 {
        proposer.require_auth();
        
        let proposal_count_key = symbol_short!("prop_cnt");
        let proposal_count: u32 = env.storage().instance().get(&proposal_count_key).unwrap_or(0);
        let new_proposal_id = proposal_count + 1;
        
        env.storage().instance().set(&proposal_count_key, &new_proposal_id);
        
        // Store proposal data
        let proposal_key = symbol_short!("proposal");
        let mut proposal_data = Vec::new(&env);
        proposal_data.push_back(description);
        env.storage().instance().set(&proposal_key, &proposal_data);
        
        // Initialize votes
        let votes_key = symbol_short!("votes");
        env.storage().instance().set(&votes_key, &0i128);
        
        new_proposal_id
    }
    
    pub fn vote(env: Env, voter: Address, _proposal_id: u32, vote: bool) {
        voter.require_auth();
        
        // Check if already voted
        let voted_key = symbol_short!("voted");
        let has_voted: bool = env.storage().instance().get(&voted_key).unwrap_or(false);
        if has_voted {
            panic!("Already voted");
        }
        
        env.storage().instance().set(&voted_key, &true);
        
        // Update vote count
        let votes_key = symbol_short!("votes");
        let current_votes: i128 = env.storage().instance().get(&votes_key).unwrap_or(0);
        let new_votes = if vote { current_votes + 1 } else { current_votes - 1 };
        env.storage().instance().set(&votes_key, &new_votes);
    }
    
    pub fn get_votes(env: Env, _proposal_id: u32) -> i128 {
        let votes_key = symbol_short!("votes");
        env.storage().instance().get(&votes_key).unwrap_or(0)
    }
}`
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "voting-contract"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        },
        {
          name: 'test.rs',
          type: 'file',
          content: `#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Address, symbol_short};

    #[test]
    fn test_create_proposal() {
        let env = Env::default();
        let contract_id = env.register_contract(None, VotingContract);
        let client = VotingContractClient::new(&env, &contract_id);
        
        let proposer = Address::random(&env);
        let description = symbol_short!("Test Proposal");
        
        let proposal_id = client.create_proposal(&proposer, &description);
        assert_eq!(proposal_id, 1);
    }
}`
        }
      ];
    } else if (template === 'nft') {
      defaultFiles = [
        {
          name: 'lib.rs',
          type: 'file',
          content: `#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol, Address, Vec};

#[contract]
pub struct NFTContract;

#[contractimpl]
impl NFTContract {
    pub fn mint(env: Env, to: Address, token_id: u32) {
        let minter: Address = env.storage().instance().get(&symbol_short!("minter")).unwrap();
        minter.require_auth();
        
        // Check if token already exists
        let owner_key = symbol_short!("owner");
        let existing_owner: Option<Address> = env.storage().instance().get(&owner_key);
        if existing_owner.is_some() {
            panic!("Token already exists");
        }
        
        // Set owner
        env.storage().instance().set(&owner_key, &to);
        
        // Increment total supply
        let supply_key = symbol_short!("supply");
        let current_supply: u32 = env.storage().instance().get(&supply_key).unwrap_or(0);
        env.storage().instance().set(&supply_key, &(current_supply + 1));
    }
    
    pub fn transfer(env: Env, from: Address, to: Address, token_id: u32) {
        from.require_auth();
        
        let owner_key = symbol_short!("owner");
        let current_owner: Address = env.storage().instance().get(&owner_key).unwrap();
        
        if current_owner != from {
            panic!("Not the owner");
        }
        
        env.storage().instance().set(&owner_key, &to);
    }
    
    pub fn owner_of(env: Env, token_id: u32) -> Address {
        let owner_key = symbol_short!("owner");
        env.storage().instance().get(&owner_key).unwrap()
    }
    
    pub fn total_supply(env: Env) -> u32 {
        let supply_key = symbol_short!("supply");
        env.storage().instance().get(&supply_key).unwrap_or(0)
    }
}`
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "nft-contract"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        },
        {
          name: 'test.rs',
          type: 'file',
          content: `#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Address};

    #[test]
    fn test_mint() {
        let env = Env::default();
        let contract_id = env.register_contract(None, NFTContract);
        let client = NFTContractClient::new(&env, &contract_id);
        
        let minter = Address::random(&env);
        let to = Address::random(&env);
        
        client.mint(&to, &1);
        assert_eq!(client.owner_of(&1), to);
    }
}`
        }
      ];
    } else if (template === 'escrow') {
      defaultFiles = [
        {
          name: 'lib.rs',
          type: 'file',
          content: `#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol, Address};

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn create_escrow(env: Env, buyer: Address, seller: Address, amount: i128) -> u32 {
        buyer.require_auth();
        
        let escrow_count_key = symbol_short!("escrow_count");
        let escrow_count: u32 = env.storage().instance().get(&escrow_count_key).unwrap_or(0);
        let escrow_id = escrow_count + 1;
        
        env.storage().instance().set(&escrow_count_key, &escrow_id);
        
        // Store escrow data
        let buyer_key = symbol_short!("buyer");
        env.storage().instance().set(&buyer_key, &buyer);
        
        let seller_key = symbol_short!("seller");
        env.storage().instance().set(&seller_key, &seller);
        
        let amount_key = symbol_short!("amount");
        env.storage().instance().set(&amount_key, &amount);
        
        let status_key = symbol_short!("status");
        env.storage().instance().set(&status_key, &symbol_short!("pending"));
        
        escrow_id
    }
    
    pub fn release(env: Env, escrow_id: u32) {
        let seller_key = symbol_short!("seller");
        let seller: Address = env.storage().instance().get(&seller_key).unwrap();
        seller.require_auth();
        
        let status_key = symbol_short!("status");
        env.storage().instance().set(&status_key, &symbol_short!("released"));
    }
    
    pub fn refund(env: Env, escrow_id: u32) {
        let buyer_key = symbol_short!("buyer");
        let buyer: Address = env.storage().instance().get(&buyer_key).unwrap();
        buyer.require_auth();
        
        let status_key = symbol_short!("status");
        env.storage().instance().set(&status_key, &symbol_short!("refunded"));
    }
    
    pub fn get_status(env: Env, escrow_id: u32) -> Symbol {
        let status_key = symbol_short!("status");
        env.storage().instance().get(&status_key).unwrap()
    }
}`
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "escrow-contract"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        },
        {
          name: 'test.rs',
          type: 'file',
          content: `#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Address, symbol_short};

    #[test]
    fn test_create_escrow() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        
        let buyer = Address::random(&env);
        let seller = Address::random(&env);
        
        let escrow_id = client.create_escrow(&buyer, &seller, &1000);
        assert_eq!(escrow_id, 1);
    }
}`
        }
      ];
    } else if (template === 'multisig') {
      defaultFiles = [
        {
          name: 'lib.rs',
          type: 'file',
          content: `#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol, Address, Vec};

#[contract]
pub struct MultiSigContract;

#[contractimpl]
impl MultiSigContract {
    pub fn initialize(env: Env, owners: Vec<Address>, threshold: u32) {
        let owners_key = symbol_short!("owners");
        env.storage().instance().set(&owners_key, &owners);
        
        let threshold_key = symbol_short!("threshold");
        env.storage().instance().set(&threshold_key, &threshold);
    }
    
    pub fn submit_transaction(env: Env, proposer: Address, to: Address, amount: i128) -> u32 {
        proposer.require_auth();
        
        // Verify proposer is an owner
        let owners_key = symbol_short!("owners");
        let owners: Vec<Address> = env.storage().instance().get(&owners_key).unwrap();
        let mut is_owner = false;
        for owner in owners.iter() {
            if *owner == proposer {
                is_owner = true;
                break;
            }
        }
        if !is_owner {
            panic!("Not an owner");
        }
        
        let tx_count_key = symbol_short!("tx_count");
        let tx_count: u32 = env.storage().instance().get(&tx_count_key).unwrap_or(0);
        let tx_id = tx_count + 1;
        
        env.storage().instance().set(&tx_count_key, &tx_id);
        
        // Store transaction
        let tx_to_key = symbol_short!("tx_to");
        env.storage().instance().set(&tx_to_key, &to);
        
        let tx_amount_key = symbol_short!("tx_amount");
        env.storage().instance().set(&tx_amount_key, &amount);
        
        // Initialize approvals
        let approvals_key = symbol_short!("approvals");
        env.storage().instance().set(&approvals_key, &0u32);
        
        tx_id
    }
    
    pub fn approve(env: Env, approver: Address, tx_id: u32) {
        approver.require_auth();
        
        // Verify approver is an owner
        let owners_key = symbol_short!("owners");
        let owners: Vec<Address> = env.storage().instance().get(&owners_key).unwrap();
        let mut is_owner = false;
        for owner in owners.iter() {
            if *owner == approver {
                is_owner = true;
                break;
            }
        }
        if !is_owner {
            panic!("Not an owner");
        }
        
        let approvals_key = symbol_short!("approvals");
        let current_approvals: u32 = env.storage().instance().get(&approvals_key).unwrap_or(0);
        env.storage().instance().set(&approvals_key, &(current_approvals + 1));
    }
    
    pub fn execute(env: Env, tx_id: u32) {
        let threshold_key = symbol_short!("threshold");
        let threshold: u32 = env.storage().instance().get(&threshold_key).unwrap();
        
        let approvals_key = symbol_short!("approvals");
        let approvals: u32 = env.storage().instance().get(&approvals_key).unwrap_or(0);
        
        if approvals < threshold {
            panic!("Insufficient approvals");
        }
        
        // Transaction executed
        let executed_key = symbol_short!("executed");
        env.storage().instance().set(&executed_key, &true);
    }
}`
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "multisig-contract"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        },
        {
          name: 'test.rs',
          type: 'file',
          content: `#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Address, Vec};

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MultiSigContract);
        let client = MultiSigContractClient::new(&env, &contract_id);
        
        let owners = Vec::new(&env);
        let owner1 = Address::random(&env);
        let owner2 = Address::random(&env);
        owners.push_back(owner1.clone());
        owners.push_back(owner2.clone());
        
        client.initialize(&owners, &2);
    }
}`
        }
      ];
    } else if (template === 'auction') {
      defaultFiles = [
        {
          name: 'lib.rs',
          type: 'file',
          content: `#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol, Address};

#[contract]
pub struct AuctionContract;

#[contractimpl]
impl AuctionContract {
    pub fn create_auction(env: Env, seller: Address, starting_bid: i128, duration: u64) -> u32 {
        seller.require_auth();
        
        let auction_count_key = symbol_short!("auction_count");
        let auction_count: u32 = env.storage().instance().get(&auction_count_key).unwrap_or(0);
        let auction_id = auction_count + 1;
        
        env.storage().instance().set(&auction_count_key, &auction_id);
        
        // Store auction data
        let seller_key = symbol_short!("seller");
        env.storage().instance().set(&seller_key, &seller);
        
        let highest_bid_key = symbol_short!("highest_bid");
        env.storage().instance().set(&highest_bid_key, &starting_bid);
        
        let highest_bidder_key = symbol_short!("highest_bidder");
        env.storage().instance().set(&highest_bidder_key, &seller);
        
        let end_time_key = symbol_short!("end_time");
        let current_time = env.ledger().timestamp();
        env.storage().instance().set(&end_time_key, &(current_time + duration));
        
        auction_id
    }
    
    pub fn bid(env: Env, auction_id: u32, bidder: Address, amount: i128) {
        bidder.require_auth();
        
        let end_time_key = symbol_short!("end_time");
        let end_time: u64 = env.storage().instance().get(&end_time_key).unwrap();
        let current_time = env.ledger().timestamp();
        
        if current_time >= end_time {
            panic!("Auction ended");
        }
        
        let highest_bid_key = symbol_short!("highest_bid");
        let highest_bid: i128 = env.storage().instance().get(&highest_bid_key).unwrap();
        
        if amount <= highest_bid {
            panic!("Bid too low");
        }
        
        // Update highest bid
        env.storage().instance().set(&highest_bid_key, &amount);
        
        let highest_bidder_key = symbol_short!("highest_bidder");
        env.storage().instance().set(&highest_bidder_key, &bidder);
    }
    
    pub fn settle(env: Env, auction_id: u32) {
        let end_time_key = symbol_short!("end_time");
        let end_time: u64 = env.storage().instance().get(&end_time_key).unwrap();
        let current_time = env.ledger().timestamp();
        
        if current_time < end_time {
            panic!("Auction not ended");
        }
        
        let settled_key = symbol_short!("settled");
        env.storage().instance().set(&settled_key, &true);
    }
    
    pub fn get_highest_bid(env: Env, auction_id: u32) -> i128 {
        let highest_bid_key = symbol_short!("highest_bid");
        env.storage().instance().get(&highest_bid_key).unwrap()
    }
}`
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "auction-contract"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        },
        {
          name: 'test.rs',
          type: 'file',
          content: `#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Address};

    #[test]
    fn test_create_auction() {
        let env = Env::default();
        let contract_id = env.register_contract(None, AuctionContract);
        let client = AuctionContractClient::new(&env, &contract_id);
        
        let seller = Address::random(&env);
        let auction_id = client.create_auction(&seller, &1000, &86400);
        assert_eq!(auction_id, 1);
    }
}`
        }
      ];
    } else {
      // Default hello world template
      defaultFiles = files || [
        {
          name: 'lib.rs',
          type: 'file',
          content: `#![no_std]
// Soroban smart contract
use core::clone::Clone;
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol};

#[contract]
pub struct HelloContract;

#[contractimpl]
impl HelloContract {
    pub fn hello(_env: Env, _to: Symbol) -> Symbol {
        symbol_short!("Hello")
    }
}`
        },
        {
          name: 'Cargo.toml',
          type: 'file',
          content: `[package]
name = "hello-world"
version = "0.1.0"
edition = "2021"

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
overflow-checks = true`
        },
        {
          name: '.cargo/config.toml',
          type: 'file',
          content: `[target.wasm32v1-none]
rustflags = [
    "-C", "target-feature=-crt-static",
    "-C", "link-arg=--no-entry"
]`
        }
      ];
    }

    const project = await prisma.project.create({
      data: {
        name: projectName,
        userId: user.id,
        isLocal: isLocal === true || isLocal === 'true',
        files: {
          create: defaultFiles.map((f) => ({
            name: f.name,
            type: f.type || 'file',
            content: f.content || ''
          }))
        }
      },
      include: { files: true, deployments: true }
    });
    res.status(201).json(serializeProject(project));
  } catch (error) {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// GET /api/projects/:id - Get single project
router.get('/:id', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { files: true, deployments: { orderBy: { createdAt: 'desc' } } }
    });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Verify project belongs to user
    if (project.userId !== user.id) {
      return res.status(403).json({ error: 'You do not have permission to access this project' });
    }

    res.json(serializeProject(project));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// PUT /api/projects/:id - Update project
router.put('/:id', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const { name, files } = req.body;

    // Verify project belongs to user
    const existingProject = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true }
    });
    if (!existingProject) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (existingProject.userId !== user.id) {
      return res.status(403).json({ error: 'You do not have permission to update this project' });
    }

    // Update name and (if provided) replace the file set atomically.
    await prisma.$transaction(async (tx) => {
      if (name !== undefined) {
        await tx.project.update({ where: { id: req.params.id }, data: { name } });
      }
      if (files !== undefined) {
        await tx.file.deleteMany({ where: { projectId: req.params.id } });
        if (Array.isArray(files) && files.length > 0) {
          await tx.file.createMany({
            data: files.map((f) => ({
              projectId: req.params.id,
              name: f.name,
              type: f.type || 'file',
              content: f.content || ''
            }))
          });
        }
        // Touch updatedAt even if name wasn't changed.
        await tx.project.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } });
      }
    });

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { files: true, deployments: { orderBy: { createdAt: 'desc' } } }
    });

    res.json(serializeProject(project));
  } catch (error) {
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// DELETE /api/projects/:id - Delete project
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const user = req.user;

    // Verify project belongs to user
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true }
    });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.userId !== user.id) {
      return res.status(403).json({ error: 'You do not have permission to delete this project' });
    }

    // Cascades to files and deployments.
    await prisma.project.delete({ where: { id: req.params.id } });
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

module.exports = router; 