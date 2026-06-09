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
    id: 'counter-mf',
    name: 'Counter (multi-file)',
    description: 'A persistent counter split across modules — the contract entrypoint in src/lib.rs, instance storage in src/storage.rs, and event publishing in src/events.rs — with a unit test and an integration test. A clean starting point for a real multi-file project.',
    category: 'Multi-file',
    files: ['src/lib.rs', 'src/storage.rs', 'src/events.rs', 'tests/counter.rs', 'Cargo.toml', '.cargo/config.toml'],
    price: 0,
    documentation: {
      summary: 'increment/decrement/reset mutate a u32 in instance storage and publish a "count" event; get reads it. Storage access is isolated in src/storage.rs and event publishing in src/events.rs, so the entrypoint stays small. Shows how a Soroban crate spans modules while still compiling to a single contract wasm.',
      usage: 'Deploy, then call increment()/decrement()/reset(); read with get().',
      functions: [
        { name: 'increment', params: ['env: Env'], returns: 'u32', description: 'Increments and returns the new value.' },
        { name: 'decrement', params: ['env: Env'], returns: 'u32', description: 'Decrements (saturating at 0) and returns the new value.' },
        { name: 'get', params: ['env: Env'], returns: 'u32', description: 'Returns the current value.' },
        { name: 'reset', params: ['env: Env'], returns: 'void', description: 'Resets the counter to zero.' }
      ],
      readMore: 'Use this to learn the module layout of a Soroban contract: src/lib.rs declares `mod storage;` and `mod events;`, and the build picks them up automatically. The unit test lives inside src/storage.rs; the integration test in tests/counter.rs drives the generated client.'
    }
  },
  {
    id: 'access-control-mf',
    name: 'Access Control (multi-file)',
    description: 'An admin-gated contract: an admin module enforces authorization on state-changing functions, kept separate from the storage module. The access-control pattern most contracts need.',
    category: 'Multi-file',
    files: ['src/lib.rs', 'src/admin.rs', 'src/storage.rs', 'tests/access.rs', 'Cargo.toml', '.cargo/config.toml'],
    price: 0,
    documentation: {
      summary: 'init sets the admin once. set_value and transfer_admin call admin::require_admin (which loads the stored admin and calls require_auth), so only the admin can change state or hand off the role; value is public. The admin logic lives in src/admin.rs and is reusable across your own functions.',
      usage: 'init(admin); admin calls set_value/transfer_admin; anyone reads value().',
      functions: [
        { name: 'init', params: ['env: Env', 'admin: Address'], returns: 'void', description: 'Sets the admin once.' },
        { name: 'admin', params: ['env: Env'], returns: 'Address', description: 'Returns the current admin.' },
        { name: 'set_value', params: ['env: Env', 'value: u32'], returns: 'void', description: 'Admin-only: set the stored value.' },
        { name: 'value', params: ['env: Env'], returns: 'u32', description: 'Reads the stored value.' },
        { name: 'transfer_admin', params: ['env: Env', 'new_admin: Address'], returns: 'void', description: 'Admin-only: transfer the admin role.' }
      ],
      readMore: 'Drop src/admin.rs into your own contract and call require_admin at the top of any privileged function. The integration test in tests/access.rs shows mock_all_auths + Address::generate for testing authorized calls.'
    }
  },
  {
    id: 'token-mf',
    name: 'Token / SEP-41 (multi-file)',
    description: 'A fungible token split into storage, admin, balance, allowance, and metadata modules — the SEP-41 shape (initialize, mint, transfer, approve, transfer_from, allowance, metadata). The realistic layout for a production token.',
    category: 'Multi-file',
    files: ['src/lib.rs', 'src/storage.rs', 'src/admin.rs', 'src/balance.rs', 'src/allowance.rs', 'src/metadata.rs', 'tests/token.rs', 'Cargo.toml', '.cargo/config.toml'],
    price: 0,
    documentation: {
      summary: 'initialize sets admin + metadata. mint is admin-only; transfer moves balance with the sender\'s auth; approve/allowance/transfer_from implement the spender allowance flow. Each concern is its own module: balances in src/balance.rs (persistent storage), allowances in src/allowance.rs (temporary storage with expiration), the DataKey enum and types in src/storage.rs, admin checks in src/admin.rs, and name/symbol/decimals in src/metadata.rs.',
      usage: 'initialize(admin, decimals, name, symbol); admin mints; holders transfer/approve; spenders transfer_from.',
      functions: [
        { name: 'initialize', params: ['env: Env', 'admin: Address', 'decimals: u32', 'name: String', 'symbol: String'], returns: 'void', description: 'Sets admin and metadata (once).' },
        { name: 'mint', params: ['env: Env', 'to: Address', 'amount: i128'], returns: 'void', description: 'Admin-only: mint tokens.' },
        { name: 'balance', params: ['env: Env', 'id: Address'], returns: 'i128', description: 'Balance of an address.' },
        { name: 'transfer', params: ['env: Env', 'from: Address', 'to: Address', 'amount: i128'], returns: 'void', description: 'Transfer with sender auth.' },
        { name: 'approve', params: ['env: Env', 'from: Address', 'spender: Address', 'amount: i128', 'expiration_ledger: u32'], returns: 'void', description: 'Set a spender allowance.' },
        { name: 'transfer_from', params: ['env: Env', 'spender: Address', 'from: Address', 'to: Address', 'amount: i128'], returns: 'void', description: 'Spend an allowance.' }
      ],
      readMore: 'This mirrors how the reference SEP-41 token is organized. Extend it with burn, total supply tracking, and full allowance expiration enforcement, then follow the SEP-41 interface so wallets and other contracts can interact with it.'
    }
  },
  {
    id: 'workspace-factory',
    name: 'Workspace: Factory + Child (cross-contract)',
    description: 'A Cargo workspace with two deployable contracts — a child counter and a factory that calls it via a cross-contract call. Shows the workspace layout, per-member crates, and how one contract invokes another. Deploy target defaults to the factory.',
    category: 'Multi-file',
    files: ['Cargo.toml', '.cargo/config.toml', 'contracts/child/Cargo.toml', 'contracts/child/src/lib.rs', 'contracts/factory/Cargo.toml', 'contracts/factory/src/lib.rs', 'contracts/factory/tests/cross.rs'],
    price: 0,
    documentation: {
      summary: 'The root Cargo.toml declares a [workspace] with two members. contracts/child is a simple counter; contracts/factory holds an Address of a deployed child and calls child.increment()/get() through the generated ChildClient — a real cross-contract call. Because there are two deployable crates, deploying prompts for a target (defaulted here to "factory").',
      usage: 'Deploy the child first, then the factory; call factory.bump(child_address) to increment the child across contracts.',
      functions: [
        { name: 'bump', params: ['env: Env', 'child: Address'], returns: 'u32', description: 'Factory: cross-contract increment of the child counter.' },
        { name: 'read', params: ['env: Env', 'child: Address'], returns: 'u32', description: 'Factory: cross-contract read of the child counter.' },
        { name: 'increment', params: ['env: Env'], returns: 'u32', description: 'Child: increment its own counter.' }
      ],
      readMore: 'This is the starting point for factory/registry patterns and any design where contracts compose. The integration test in contracts/factory/tests/cross.rs registers both contracts in one test env and drives the cross-contract call with the soroban testutils.'
    }
  },
  {
    id: 'hello-world',
    name: 'Hello World',
    description: 'A minimal Soroban contract that returns a greeting. The smallest complete example — use it to verify your toolchain, deploy, and invoke flow end to end before building anything real.',
    category: 'Basic',
    files: ['lib.rs', 'Cargo.toml'],
    price: 0,
    documentation: {
      summary: 'A single-function contract that takes a Symbol and returns a fixed "Hello" Symbol. It holds no state and needs no authorization, so it compiles fast and deploys in one step. Its job is to confirm that compiling to WASM, deploying to testnet, and invoking a function all work before you write your own logic.',
      usage: 'Call hello(to) with any symbol. Use for testing deployment and SDK setup.',
      functions: [
        { name: 'hello', params: ['to: Symbol'], returns: 'Symbol', description: 'Returns the "Hello" symbol.' }
      ],
      readMore: 'Start here if Soroban is new to you. The contract shows the basic anatomy of a program: the #[contract] type, the #[contractimpl] block, and a function that takes the Env. Once it deploys and invokes cleanly, swap in your own code.'
    }
  },
  {
    id: 'counter',
    name: 'Counter Contract',
    description: 'A persistent counter you can increment, decrement, and read. Demonstrates how a Soroban contract stores and mutates state across separate calls.',
    category: 'Basic',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 0,
    documentation: {
      summary: 'The contract keeps a single i32 in instance storage. increment and decrement read the current value, adjust it by one, write it back, and return the new value; get reads it without changing it. Because the value lives in instance storage, it persists between invocations and is shared across callers.',
      usage: 'Deploy then call increment() or decrement() to change state; get() to read.',
      functions: [
        { name: 'increment', params: ['env: Env'], returns: 'i32', description: 'Increments counter by 1, returns new value.' },
        { name: 'decrement', params: ['env: Env'], returns: 'i32', description: 'Decrements counter by 1, returns new value.' },
        { name: 'get', params: ['env: Env'], returns: 'i32', description: 'Returns current counter value.' }
      ],
      readMore: 'A clear introduction to stateful contracts and the read-modify-write pattern. Use it to understand how instance storage works before moving on to maps, balances, or per-address state.'
    }
  },
  {
    id: 'token',
    name: 'Token Contract',
    description: 'A minimal fungible token with admin minting and balance lookups. A starting point for issuing your own asset on Soroban.',
    category: 'Token',
    files: ['lib.rs', 'Cargo.toml'],
    price: 10,
    documentation: {
      summary: 'Balances are stored per Address. mint creates new tokens and assigns them to an address and is restricted to the admin; balance returns the amount held by any address. This is a stripped-down token meant to show the core storage and authorization pattern, not a full SEP-41 implementation with transfer, allowance, and burn.',
      usage: 'Admin mints to addresses; anyone can read balance for an address.',
      functions: [
        { name: 'mint', params: ['env: Env', 'to: Address', 'amount: i128'], returns: 'void', description: 'Mints amount to address (admin only).' },
        { name: 'balance', params: ['env: Env', 'addr: Address'], returns: 'i128', description: 'Returns token balance for address.' }
      ],
      readMore: 'Use this as the foundation for a custom token. Common next steps are adding transfer and allowance, tracking total supply, and following the SEP-41 token interface so wallets and other contracts can interact with it.'
    }
  },
  {
    id: 'voting',
    name: 'Voting Contract',
    description: 'On-chain proposals with yes/no voting and live tallies. A foundation for governance and DAO decisions.',
    category: 'Governance',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 15,
    documentation: {
      summary: 'create_proposal stores a new proposal and returns its id. vote records a voter\'s yes/no choice against a proposal id, and get_result returns the running (yes, no) tally. Proposals and counts live in contract storage, so results are transparent and verifiable on chain.',
      usage: 'Create proposals, then vote; query results before deadline.',
      functions: [
        { name: 'create_proposal', params: ['env: Env', 'description: Symbol'], returns: 'u32', description: 'Creates a new proposal, returns proposal id.' },
        { name: 'vote', params: ['env: Env', 'voter: Address', 'proposal_id: u32', 'support: bool'], returns: 'void', description: 'Records a vote for a proposal.' },
        { name: 'get_result', params: ['env: Env', 'proposal_id: u32'], returns: '(u32, u32)', description: 'Returns (yes_count, no_count) for proposal.' }
      ],
      readMore: 'A base for governance flows. Realistic extensions include one-vote-per-address enforcement, voting deadlines, weighting votes by token balance, and recording the final outcome once voting closes.'
    }
  },
  {
    id: 'nft',
    name: 'NFT Contract',
    description: 'A non-fungible token: mint unique token ids and transfer ownership. The basis for collectibles and unique on-chain assets.',
    category: 'NFT',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 20,
    documentation: {
      summary: 'Each token id maps to an owner Address. mint assigns a new id to an owner, transfer moves an id from its current owner to a new one, and owner_of returns who holds a given id. It models the core ownership ledger of an NFT, without metadata or approval logic.',
      usage: 'Mint tokens to owners; transfer updates ownership.',
      functions: [
        { name: 'mint', params: ['env: Env', 'to: Address', 'token_id: u32'], returns: 'void', description: 'Mints a new NFT to owner.' },
        { name: 'transfer', params: ['env: Env', 'from: Address', 'to: Address', 'token_id: u32'], returns: 'void', description: 'Transfers NFT to new owner.' },
        { name: 'owner_of', params: ['env: Env', 'token_id: u32'], returns: 'Address', description: 'Returns current owner of token.' }
      ],
      readMore: 'Use it to learn how unique-asset ownership is tracked on Soroban. To make it production-shaped, add metadata or token URIs, approval/operator support, and a check that only the current owner can transfer.'
    }
  },
  {
    id: 'escrow',
    name: 'Escrow Contract',
    description: 'Holds funds for a trade until they are released to the seller or refunded to the buyer. A pattern for conditional, two-party payments.',
    category: 'DeFi',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 25,
    documentation: {
      summary: 'create opens an escrow for a seller, amount, and asset and returns its id; deposit records the buyer\'s funds against that escrow; release sends the funds to the seller and refund returns them to the buyer. The contract tracks each escrow\'s parties and state so funds only move along the intended path.',
      usage: 'Seller creates escrow; buyer deposits; release to seller or refund to buyer.',
      functions: [
        { name: 'create', params: ['env: Env', 'seller: Address', 'amount: i128', 'asset: Address'], returns: 'u32', description: 'Creates escrow, returns escrow id.' },
        { name: 'deposit', params: ['env: Env', 'escrow_id: u32', 'buyer: Address'], returns: 'void', description: 'Buyer deposits funds into escrow.' },
        { name: 'release', params: ['env: Env', 'escrow_id: u32'], returns: 'void', description: 'Releases funds to seller.' },
        { name: 'refund', params: ['env: Env', 'escrow_id: u32'], returns: 'void', description: 'Refunds buyer if conditions allow.' }
      ],
      readMore: 'A starting point for P2P trades and milestone payments. A real deployment would move actual token balances through the asset contract, add authorization on who can release or refund, and define the conditions or arbiter that decide the outcome.'
    }
  },
  {
    id: 'multisig',
    name: 'Multi-Signature Wallet',
    description: 'A wallet that requires several approvals before a transaction executes. For shared treasuries and higher-security accounts.',
    category: 'Security',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 30,
    documentation: {
      summary: 'propose records a pending transaction (destination, amount, asset) and returns its id; approve adds a signer\'s approval; execute runs the transaction once the number of approvals meets the configured threshold. Approvals are tracked per proposal so no single signer can move funds alone.',
      usage: 'Configure signers and threshold; propose tx; signers approve; execute when ready.',
      functions: [
        { name: 'propose', params: ['env: Env', 'destination: Address', 'amount: i128', 'asset: Address'], returns: 'u32', description: 'Creates a new proposal.' },
        { name: 'approve', params: ['env: Env', 'signer: Address', 'proposal_id: u32'], returns: 'void', description: 'Adds approval from signer.' },
        { name: 'execute', params: ['env: Env', 'proposal_id: u32'], returns: 'void', description: 'Executes if approval threshold met.' }
      ],
      readMore: 'The M-of-N approval pattern. To harden it, validate that approvers belong to the signer set, prevent double-approval, let signers revoke, and perform the actual asset transfer on execute.'
    }
  },
  {
    id: 'auction',
    name: 'Auction Contract',
    description: 'An auction with timed bidding and settlement to the highest bidder. For selling assets or NFTs to the market.',
    category: 'Marketplace',
    files: ['lib.rs', 'Cargo.toml', 'test.rs'],
    price: 35,
    documentation: {
      summary: 'create_auction opens an auction with a reserve price and a duration; place_bid records a bid that must beat the current high bid; settle closes the auction after its end time and returns the winning bidder. The contract keeps the current high bid and bidder so settlement is deterministic.',
      usage: 'Seller creates auction; bidders place bids; after end time, settle to winner.',
      functions: [
        { name: 'create_auction', params: ['env: Env', 'seller: Address', 'reserve: i128', 'duration: u32'], returns: 'u32', description: 'Starts a new auction.' },
        { name: 'place_bid', params: ['env: Env', 'bidder: Address', 'auction_id: u32', 'amount: i128'], returns: 'void', description: 'Places or outbids.' },
        { name: 'settle', params: ['env: Env', 'auction_id: u32'], returns: 'Address', description: 'Settles auction, returns winner address.' }
      ],
      readMore: 'A base for NFT and asset auctions. Production versions escrow each bid, refund losing bidders, enforce the reserve and end time on chain, and transfer the asset to the winner at settlement.'
    }
  },
  {
    id: 'data-store',
    name: 'Key-Value Store',
    description: 'A persistent key-value store mapping Symbol keys to i128 values. A building block for on-chain configuration and small datasets.',
    category: 'Basic',
    files: ['lib.rs', 'Cargo.toml'],
    price: 0,
    documentation: {
      summary: 'put writes a value under a Symbol key, get reads it back (returning 0 when unset), has reports whether a key exists, and remove deletes one. Each key is stored independently, so the contract behaves as a simple on-chain map you read and write per entry.',
      usage: 'Call put(key, value) to write; get(key) to read; has(key) to check; remove(key) to delete.',
      functions: [
        { name: 'put', params: ['env: Env', 'key: Symbol', 'value: i128'], returns: 'void', description: 'Stores a value under the given key.' },
        { name: 'get', params: ['env: Env', 'key: Symbol'], returns: 'i128', description: 'Returns the value for a key (0 if unset).' },
        { name: 'has', params: ['env: Env', 'key: Symbol'], returns: 'bool', description: 'Returns whether a key exists.' },
        { name: 'remove', params: ['env: Env', 'key: Symbol'], returns: 'void', description: 'Removes a key.' }
      ],
      readMore: 'Useful as a reusable storage layer or to learn Soroban\'s key-based storage. Swap i128 for your own value type, or add per-key authorization if writes should be restricted.'
    }
  },
  {
    id: 'name-registry',
    name: 'Name Registry',
    description: 'Register unique human-readable names and resolve them to addresses. A foundation for naming and on-chain identity.',
    category: 'Utility',
    files: ['lib.rs', 'Cargo.toml'],
    price: 10,
    documentation: {
      summary: 'register claims a Symbol name for an owner Address and fails if the name is already taken; resolve returns the owner of a name; is_registered reports whether a name exists. Names map one-to-one to owners, giving you a basic name service.',
      usage: 'Register a name (must be unique), then resolve it to its owner address.',
      functions: [
        { name: 'register', params: ['env: Env', 'name: Symbol', 'owner: Address'], returns: 'void', description: 'Registers a name to an owner (fails if taken).' },
        { name: 'resolve', params: ['env: Env', 'name: Symbol'], returns: 'Address', description: 'Returns the owner address for a name.' },
        { name: 'is_registered', params: ['env: Env', 'name: Symbol'], returns: 'bool', description: 'Returns whether a name is registered.' }
      ],
      readMore: 'A base for naming systems and identity. Common additions are transferring or releasing a name, expiry and renewal, reverse lookup (address to name), and a registration fee.'
    }
  },
  {
    id: 'tip-jar',
    name: 'Tip Jar',
    description: 'Records tips per contributor and a running total. A simple pattern for donations and creator support.',
    category: 'Marketplace',
    files: ['lib.rs', 'Cargo.toml'],
    price: 10,
    documentation: {
      summary: 'tip adds an amount for a sender and returns the new grand total; tips_from returns how much a given address has tipped; total_tips returns the sum of all tips. Per-sender totals and the grand total are kept in storage so contributions are auditable.',
      usage: 'Call tip(from, amount); read a sender total with tips_from; read the grand total with total_tips.',
      functions: [
        { name: 'tip', params: ['env: Env', 'from: Address', 'amount: i128'], returns: 'i128', description: 'Records a tip; returns the new grand total.' },
        { name: 'tips_from', params: ['env: Env', 'addr: Address'], returns: 'i128', description: 'Returns total tips from an address.' },
        { name: 'total_tips', params: ['env: Env'], returns: 'i128', description: 'Returns the grand total of all tips.' }
      ],
      readMore: 'A starting point for donations or pay-what-you-want flows. A live version would transfer the tipped asset into the contract or a payout address and let the owner withdraw collected funds.'
    }
  },
  {
    id: 'pausable',
    name: 'Pausable Contract',
    description: 'An admin-controlled pause switch that blocks guarded actions while paused. The circuit-breaker pattern for incident response.',
    category: 'Security',
    files: ['lib.rs', 'Cargo.toml'],
    price: 15,
    documentation: {
      summary: 'init sets the admin and starts unpaused. pause and unpause flip the state and are restricted to the admin; is_paused reports it; do_action runs only when not paused and reverts otherwise. It shows how to gate contract behavior behind a single on/off flag.',
      usage: 'Initialize with an admin; admin pauses/unpauses; do_action runs only when not paused.',
      functions: [
        { name: 'init', params: ['env: Env', 'admin: Address'], returns: 'void', description: 'Sets the admin and starts unpaused.' },
        { name: 'pause', params: ['env: Env'], returns: 'void', description: 'Pauses the contract (admin only).' },
        { name: 'unpause', params: ['env: Env'], returns: 'void', description: 'Unpauses the contract (admin only).' },
        { name: 'is_paused', params: ['env: Env'], returns: 'bool', description: 'Returns the paused state.' },
        { name: 'do_action', params: ['env: Env'], returns: 'u32', description: 'Performs a guarded action; reverts if paused.' }
      ],
      readMore: 'A reusable safety pattern. Combine it with your own functions by checking the paused flag before sensitive logic, so you can halt activity during an upgrade or after a problem is found.'
    }
  },
  {
    id: 'whitelist',
    name: 'Whitelist / Access List',
    description: 'An admin-managed allowlist of addresses with membership checks. Gate sensitive functions to approved accounts.',
    category: 'Security',
    files: ['lib.rs', 'Cargo.toml'],
    price: 15,
    documentation: {
      summary: 'init sets the admin. add and remove change the allowlist and are restricted to the admin; is_listed reports whether an address is allowed. Membership is stored per address, giving you a simple access-control list other functions can check.',
      usage: 'Initialize with an admin; admin adds/removes accounts; check with is_listed.',
      functions: [
        { name: 'init', params: ['env: Env', 'admin: Address'], returns: 'void', description: 'Sets the admin.' },
        { name: 'add', params: ['env: Env', 'account: Address'], returns: 'void', description: 'Adds an address to the allowlist (admin only).' },
        { name: 'remove', params: ['env: Env', 'account: Address'], returns: 'void', description: 'Removes an address (admin only).' },
        { name: 'is_listed', params: ['env: Env', 'account: Address'], returns: 'bool', description: 'Returns whether an address is allowlisted.' }
      ],
      readMore: 'Use it to restrict who can call privileged functions. Extend it with multiple roles, batch updates, or by pairing the membership check with require_auth on the caller.'
    }
  },
  {
    id: 'crowdfund',
    name: 'Crowdfunding Contract',
    description: 'Tracks contributions toward a funding goal and reports progress. A starting point for fundraising and presales.',
    category: 'DeFi',
    files: ['lib.rs', 'Cargo.toml'],
    price: 20,
    documentation: {
      summary: 'init sets a goal and zeroes the total. contribute adds an amount from a backer and returns the new total; total, goal, and reached expose the amount raised, the target, and whether the target has been met. Progress is kept in storage so anyone can verify it.',
      usage: 'Initialize with a goal; contributors call contribute; query total/goal/reached.',
      functions: [
        { name: 'init', params: ['env: Env', 'goal: i128'], returns: 'void', description: 'Sets the funding goal and zeroes the total.' },
        { name: 'contribute', params: ['env: Env', 'from: Address', 'amount: i128'], returns: 'i128', description: 'Adds a contribution; returns the new total.' },
        { name: 'total', params: ['env: Env'], returns: 'i128', description: 'Returns the amount raised so far.' },
        { name: 'goal', params: ['env: Env'], returns: 'i128', description: 'Returns the funding goal.' },
        { name: 'reached', params: ['env: Env'], returns: 'bool', description: 'Returns whether the goal has been reached.' }
      ],
      readMore: 'A base for fundraising flows. Production versions move the contributed asset into the contract, record per-backer amounts, and add a deadline, withdrawal on success, and refunds on failure.'
    }
  },
  {
    id: 'timelock',
    name: 'Timelock Vault',
    description: 'Locks a value until a future ledger timestamp, then lets the beneficiary claim it. For vesting and time-gated payouts.',
    category: 'DeFi',
    files: ['lib.rs', 'Cargo.toml'],
    price: 20,
    documentation: {
      summary: 'lock stores an amount and an unlock_time. claim releases the amount to the beneficiary only after the ledger timestamp passes the unlock time and returns it; unlock_at and locked_amount expose the schedule and the held amount. Time is read from the ledger, so the lock cannot be bypassed by the caller.',
      usage: 'Call lock(from, amount, unlock_time); after the time, the beneficiary calls claim.',
      functions: [
        { name: 'lock', params: ['env: Env', 'from: Address', 'amount: i128', 'unlock_time: u64'], returns: 'void', description: 'Locks an amount until unlock_time.' },
        { name: 'claim', params: ['env: Env', 'to: Address'], returns: 'i128', description: 'Claims the amount once unlocked; returns it.' },
        { name: 'unlock_at', params: ['env: Env'], returns: 'u64', description: 'Returns the unlock timestamp.' },
        { name: 'locked_amount', params: ['env: Env'], returns: 'i128', description: 'Returns the currently locked amount.' }
      ],
      readMore: 'A base for vesting and delayed releases. A real deployment would custody the locked asset in the contract, support multiple independent locks, and restrict claim to the intended beneficiary.'
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
