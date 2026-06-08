/**
 * Template catalog for marketplace: id, name, description, category, files, price (XLM), documentation.
 * price 0 = free. Same PAYMENT_ADDRESS and XLM flow as subscription plans.
 */

export interface TemplateFunctionDoc {
  name: string;
  params: string[];
  returns: string;
  description: string;
}

export interface TemplateDocumentation {
  summary: string;
  usage: string;
  functions: TemplateFunctionDoc[];
  readMore: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  files: string[];
  price: number;
  documentation: TemplateDocumentation;
}

export const TEMPLATE_CATALOG: Template[] = [
  {
    id: 'hello-world',
    name: 'Hello World',
    description: 'A simple hello world contract to get started with Soroban.',
    category: 'Basic',
    files: ['lib.rs', 'Cargo.toml'],
    price: 0,
    documentation: {
      summary: 'Minimal contract that returns a greeting symbol.',
      usage: 'Call hello(to) with any symbol. Use for testing deployment and SDK setup.',
      functions: [
        { name: 'hello', params: ['to: Symbol'], returns: 'Symbol', description: 'Returns the "Hello" symbol.' }
      ],
      readMore: 'Ideal first contract for learning Soroban contract structure and deployment.'
    }
  },
  {
    id: 'counter',
    name: 'Counter Contract',
    description: 'A counter contract with increment, decrement, and get functions.',
    category: 'Basic',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 0,
    documentation: {
      summary: 'Persistent counter with increment, decrement, and get.',
      usage: 'Deploy then call increment() or decrement() to change state; get() to read.',
      functions: [
        { name: 'increment', params: ['env: Env'], returns: 'i32', description: 'Increments counter by 1, returns new value.' },
        { name: 'decrement', params: ['env: Env'], returns: 'i32', description: 'Decrements counter by 1, returns new value.' },
        { name: 'get', params: ['env: Env'], returns: 'i32', description: 'Returns current counter value.' }
      ],
      readMore: 'Demonstrates instance storage and stateful contracts.'
    }
  },
  {
    id: 'token',
    name: 'Token Contract',
    description: 'A basic token contract with mint and balance functions.',
    category: 'Token',
    files: ['lib.rs', 'Cargo.toml'],
    price: 10,
    documentation: {
      summary: 'Fungible token with mint and balance tracking.',
      usage: 'Admin mints to addresses; anyone can read balance for an address.',
      functions: [
        { name: 'mint', params: ['env: Env', 'to: Address', 'amount: i128'], returns: 'void', description: 'Mints amount to address (admin only).' },
        { name: 'balance', params: ['env: Env', 'addr: Address'], returns: 'i128', description: 'Returns token balance for address.' }
      ],
      readMore: 'Foundation for custom tokens on Stellar.'
    }
  },
  {
    id: 'voting',
    name: 'Voting Contract',
    description: 'A voting contract with proposal creation and voting functionality.',
    category: 'Governance',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 15,
    documentation: {
      summary: 'Create proposals and cast votes; results are on-chain.',
      usage: 'Create proposals, then vote; query results before deadline.',
      functions: [
        { name: 'create_proposal', params: ['env: Env', 'description: Symbol'], returns: 'u32', description: 'Creates a new proposal, returns proposal id.' },
        { name: 'vote', params: ['env: Env', 'voter: Address', 'proposal_id: u32', 'support: bool'], returns: 'void', description: 'Records a vote for a proposal.' },
        { name: 'get_result', params: ['env: Env', 'proposal_id: u32'], returns: '(u32, u32)', description: 'Returns (yes_count, no_count) for proposal.' }
      ],
      readMore: 'Suitable for DAOs and governance flows.'
    }
  },
  {
    id: 'nft',
    name: 'NFT Contract',
    description: 'A non-fungible token contract with mint and transfer functions.',
    category: 'NFT',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 20,
    documentation: {
      summary: 'ERC-721 style NFT: mint and transfer unique tokens.',
      usage: 'Mint tokens to owners; transfer updates ownership.',
      functions: [
        { name: 'mint', params: ['env: Env', 'to: Address', 'token_id: u32'], returns: 'void', description: 'Mints a new NFT to owner.' },
        { name: 'transfer', params: ['env: Env', 'from: Address', 'to: Address', 'token_id: u32'], returns: 'void', description: 'Transfers NFT to new owner.' },
        { name: 'owner_of', params: ['env: Env', 'token_id: u32'], returns: 'Address', description: 'Returns current owner of token.' }
      ],
      readMore: 'Use for collectibles and unique assets on Stellar.'
    }
  },
  {
    id: 'escrow',
    name: 'Escrow Contract',
    description: 'An escrow contract for secure payments between parties.',
    category: 'DeFi',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 25,
    documentation: {
      summary: 'Lock funds until conditions are met; release or refund.',
      usage: 'Seller creates escrow; buyer deposits; release to seller or refund to buyer.',
      functions: [
        { name: 'create', params: ['env: Env', 'seller: Address', 'amount: i128', 'asset: Address'], returns: 'u32', description: 'Creates escrow, returns escrow id.' },
        { name: 'deposit', params: ['env: Env', 'escrow_id: u32', 'buyer: Address'], returns: 'void', description: 'Buyer deposits funds into escrow.' },
        { name: 'release', params: ['env: Env', 'escrow_id: u32'], returns: 'void', description: 'Releases funds to seller.' },
        { name: 'refund', params: ['env: Env', 'escrow_id: u32'], returns: 'void', description: 'Refunds buyer if conditions allow.' }
      ],
      readMore: 'For P2P trades and conditional payments.'
    }
  },
  {
    id: 'multisig',
    name: 'Multi-Signature Wallet',
    description: 'A multi-signature wallet requiring multiple approvals for transactions.',
    category: 'Security',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 30,
    documentation: {
      summary: 'Propose and approve transactions; execute when threshold is met.',
      usage: 'Configure signers and threshold; propose tx; signers approve; execute when ready.',
      functions: [
        { name: 'propose', params: ['env: Env', 'destination: Address', 'amount: i128', 'asset: Address'], returns: 'u32', description: 'Creates a new proposal.' },
        { name: 'approve', params: ['env: Env', 'signer: Address', 'proposal_id: u32'], returns: 'void', description: 'Adds approval from signer.' },
        { name: 'execute', params: ['env: Env', 'proposal_id: u32'], returns: 'void', description: 'Executes if approval threshold met.' }
      ],
      readMore: 'For treasury and high-security wallets.'
    }
  },
  {
    id: 'auction',
    name: 'Auction Contract',
    description: 'An auction contract with bidding and settlement functionality.',
    category: 'Marketplace',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 35,
    documentation: {
      summary: 'Create auctions, place bids, and settle to highest bidder.',
      usage: 'Seller creates auction; bidders place bids; after end time, settle to winner.',
      functions: [
        { name: 'create_auction', params: ['env: Env', 'seller: Address', 'reserve: i128', 'duration: u32'], returns: 'u32', description: 'Starts a new auction.' },
        { name: 'place_bid', params: ['env: Env', 'bidder: Address', 'auction_id: u32', 'amount: i128'], returns: 'void', description: 'Places or outbids.' },
        { name: 'settle', params: ['env: Env', 'auction_id: u32'], returns: 'Address', description: 'Settles auction, returns winner address.' }
      ],
      readMore: 'For NFT or asset auctions on Stellar.'
    }
  },
  {
    id: 'data-store',
    name: 'Key-Value Store',
    description: 'A simple persistent key-value store keyed by Symbol.',
    category: 'Basic',
    files: ['lib.rs', 'Cargo.toml'],
    price: 0,
    documentation: {
      summary: 'Store, read, check, and remove i128 values by Symbol key.',
      usage: 'Call put(key, value) to write; get(key) to read; has(key) to check; remove(key) to delete.',
      functions: [
        { name: 'put', params: ['env: Env', 'key: Symbol', 'value: i128'], returns: 'void', description: 'Stores a value under the given key.' },
        { name: 'get', params: ['env: Env', 'key: Symbol'], returns: 'i128', description: 'Returns the value for a key (0 if unset).' },
        { name: 'has', params: ['env: Env', 'key: Symbol'], returns: 'bool', description: 'Returns whether a key exists.' },
        { name: 'remove', params: ['env: Env', 'key: Symbol'], returns: 'void', description: 'Removes a key.' }
      ],
      readMore: 'A minimal building block for on-chain configuration and state.'
    }
  },
  {
    id: 'name-registry',
    name: 'Name Registry',
    description: 'Register and resolve human-readable names to addresses.',
    category: 'Utility',
    files: ['lib.rs', 'Cargo.toml'],
    price: 10,
    documentation: {
      summary: 'A simple name service mapping a Symbol name to an owner Address.',
      usage: 'Register a name (must be unique), then resolve it to its owner address.',
      functions: [
        { name: 'register', params: ['env: Env', 'name: Symbol', 'owner: Address'], returns: 'void', description: 'Registers a name to an owner (fails if taken).' },
        { name: 'resolve', params: ['env: Env', 'name: Symbol'], returns: 'Address', description: 'Returns the owner address for a name.' },
        { name: 'is_registered', params: ['env: Env', 'name: Symbol'], returns: 'bool', description: 'Returns whether a name is registered.' }
      ],
      readMore: 'A foundation for naming systems and on-chain identity.'
    }
  },
  {
    id: 'tip-jar',
    name: 'Tip Jar',
    description: 'Accept tips and track totals per contributor.',
    category: 'Marketplace',
    files: ['lib.rs', 'Cargo.toml'],
    price: 10,
    documentation: {
      summary: 'Record tips per sender and a running grand total.',
      usage: 'Call tip(from, amount); read a sender total with tips_from; read the grand total with total_tips.',
      functions: [
        { name: 'tip', params: ['env: Env', 'from: Address', 'amount: i128'], returns: 'i128', description: 'Records a tip; returns the new grand total.' },
        { name: 'tips_from', params: ['env: Env', 'addr: Address'], returns: 'i128', description: 'Returns total tips from an address.' },
        { name: 'total_tips', params: ['env: Env'], returns: 'i128', description: 'Returns the grand total of all tips.' }
      ],
      readMore: 'A simple pattern for donations and creator support.'
    }
  },
  {
    id: 'pausable',
    name: 'Pausable Contract',
    description: 'An admin-controlled pause switch guarding contract actions.',
    category: 'Security',
    files: ['lib.rs', 'Cargo.toml'],
    price: 15,
    documentation: {
      summary: 'Admin can pause/unpause; guarded actions revert while paused.',
      usage: 'Initialize with an admin; admin pauses/unpauses; do_action runs only when not paused.',
      functions: [
        { name: 'init', params: ['env: Env', 'admin: Address'], returns: 'void', description: 'Sets the admin and starts unpaused.' },
        { name: 'pause', params: ['env: Env'], returns: 'void', description: 'Pauses the contract (admin only).' },
        { name: 'unpause', params: ['env: Env'], returns: 'void', description: 'Unpauses the contract (admin only).' },
        { name: 'is_paused', params: ['env: Env'], returns: 'bool', description: 'Returns the paused state.' },
        { name: 'do_action', params: ['env: Env'], returns: 'u32', description: 'Performs a guarded action; reverts if paused.' }
      ],
      readMore: 'The circuit-breaker pattern for safe upgrades and incident response.'
    }
  },
  {
    id: 'whitelist',
    name: 'Whitelist / Access List',
    description: 'An admin-managed allowlist of addresses.',
    category: 'Security',
    files: ['lib.rs', 'Cargo.toml'],
    price: 15,
    documentation: {
      summary: 'Admin adds/removes addresses; anyone can check membership.',
      usage: 'Initialize with an admin; admin adds/removes accounts; check with is_listed.',
      functions: [
        { name: 'init', params: ['env: Env', 'admin: Address'], returns: 'void', description: 'Sets the admin.' },
        { name: 'add', params: ['env: Env', 'account: Address'], returns: 'void', description: 'Adds an address to the allowlist (admin only).' },
        { name: 'remove', params: ['env: Env', 'account: Address'], returns: 'void', description: 'Removes an address (admin only).' },
        { name: 'is_listed', params: ['env: Env', 'account: Address'], returns: 'bool', description: 'Returns whether an address is allowlisted.' }
      ],
      readMore: 'Gate sensitive functions to approved addresses.'
    }
  },
  {
    id: 'crowdfund',
    name: 'Crowdfunding Contract',
    description: 'Track contributions toward a funding goal.',
    category: 'DeFi',
    files: ['lib.rs', 'Cargo.toml'],
    price: 20,
    documentation: {
      summary: 'Set a goal, accept contributions, and report progress.',
      usage: 'Initialize with a goal; contributors call contribute; query total/goal/reached.',
      functions: [
        { name: 'init', params: ['env: Env', 'goal: i128'], returns: 'void', description: 'Sets the funding goal and zeroes the total.' },
        { name: 'contribute', params: ['env: Env', 'from: Address', 'amount: i128'], returns: 'i128', description: 'Adds a contribution; returns the new total.' },
        { name: 'total', params: ['env: Env'], returns: 'i128', description: 'Returns the amount raised so far.' },
        { name: 'goal', params: ['env: Env'], returns: 'i128', description: 'Returns the funding goal.' },
        { name: 'reached', params: ['env: Env'], returns: 'bool', description: 'Returns whether the goal has been reached.' }
      ],
      readMore: 'A starting point for fundraising and presale flows.'
    }
  },
  {
    id: 'timelock',
    name: 'Timelock Vault',
    description: 'Lock a value until a future ledger timestamp.',
    category: 'DeFi',
    files: ['lib.rs', 'Cargo.toml'],
    price: 20,
    documentation: {
      summary: 'Lock an amount with an unlock time; claim only after it passes.',
      usage: 'Call lock(from, amount, unlock_time); after the time, the beneficiary calls claim.',
      functions: [
        { name: 'lock', params: ['env: Env', 'from: Address', 'amount: i128', 'unlock_time: u64'], returns: 'void', description: 'Locks an amount until unlock_time.' },
        { name: 'claim', params: ['env: Env', 'to: Address'], returns: 'i128', description: 'Claims the amount once unlocked; returns it.' },
        { name: 'unlock_at', params: ['env: Env'], returns: 'u64', description: 'Returns the unlock timestamp.' },
        { name: 'locked_amount', params: ['env: Env'], returns: 'i128', description: 'Returns the currently locked amount.' }
      ],
      readMore: 'For vesting, escrowed releases, and time-gated payouts.'
    }
  }
];

export const FREE_TEMPLATE_IDS: string[] = TEMPLATE_CATALOG.filter((t) => t.price === 0).map((t) => t.id);
export const PRICE_BY_ID: Record<string, number> = Object.fromEntries(
  TEMPLATE_CATALOG.map((t) => [t.id, t.price])
);

export function getTemplateById(id: string): Template | null {
  return TEMPLATE_CATALOG.find((t) => t.id === id) || null;
}

export function getPublicTemplateDocs() {
  return TEMPLATE_CATALOG.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    files: t.files,
    price: t.price,
    documentation: t.documentation
  }));
}

export default {
  TEMPLATE_CATALOG,
  FREE_TEMPLATE_IDS,
  PRICE_BY_ID,
  getTemplateById,
  getPublicTemplateDocs
};
