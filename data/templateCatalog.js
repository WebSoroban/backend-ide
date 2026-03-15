/**
 * Template catalog for marketplace: id, name, description, category, files, price (XLM), documentation.
 * price 0 = free. Same PAYMENT_ADDRESS and XLM flow as subscription plans.
 */
const TEMPLATE_CATALOG = [
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
  }
];

const FREE_TEMPLATE_IDS = TEMPLATE_CATALOG.filter(t => t.price === 0).map(t => t.id);
const PRICE_BY_ID = Object.fromEntries(TEMPLATE_CATALOG.map(t => [t.id, t.price]));

function getTemplateById(id) {
  return TEMPLATE_CATALOG.find(t => t.id === id) || null;
}

function getPublicTemplateDocs() {
  return TEMPLATE_CATALOG.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    files: t.files,
    price: t.price,
    documentation: t.documentation
  }));
}

module.exports = {
  TEMPLATE_CATALOG,
  FREE_TEMPLATE_IDS,
  PRICE_BY_ID,
  getTemplateById,
  getPublicTemplateDocs
};
