//! PayLoop: non-custodial USDC subscriptions on Soroban.
//!
//! A subscriber signs one policy: pay `merchant` a fixed `amount` of the
//! contract's token every `interval` seconds, never more than `cap` in total.
//! Funds never leave the subscriber's wallet until a charge is due.
//!
//! Custody model
//! -------------
//! The contract holds a token *allowance*, not a balance. Its invariant is
//! that the allowance a subscriber grants this contract equals the sum of what
//! their live policies may still charge (`committed`). Creating a policy grows
//! the allowance, every charge consumes exactly `amount` of it, and revoking a
//! policy shrinks it again. Because one token allowance is shared by all of a
//! subscriber's policies, the contract keeps the per-policy accounting and
//! never lets a policy charge past its own cap.
//!
//! Actions
//! -------
//! - `create_policy` (subscriber): validates the terms, grants the allowance,
//!   and executes the first charge in the same invocation. If the first charge
//!   fails, the whole call reverts and no policy or allowance exists.
//!
//! Allowance expiry is an explicit argument (`allowance_live_until`). It is
//! part of the token `approve` call the subscriber signs, so it must be the
//! same value at simulation and at execution; deriving it from the current
//! ledger inside the contract would change between the two and fail auth.
//! - `charge` (anyone, typically the relayer): charges a due, active policy.
//!   It can only pay the policy's merchant its amount, on its schedule, under
//!   its cap. Missed periods are never back-billed. A charge the subscriber
//!   cannot cover is recorded on-chain instead of reverting.
//! - `pause`, `resume`, `revoke` (subscriber), `cancel` (merchant).
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token, Address, Env,
};

#[cfg(test)]
mod test;

/// Shortest allowed billing interval. One minute keeps live demos practical
/// while still ruling out per-ledger drains.
pub const MIN_INTERVAL_SECONDS: u64 = 60;
/// Longest allowed billing interval (one leap year).
pub const MAX_INTERVAL_SECONDS: u64 = 366 * 24 * 60 * 60;

const DAY_IN_LEDGERS: u32 = 17_280;
/// Live entries are topped up to ~120 days whenever they drop below ~30 days.
const TTL_EXTEND_TO: u32 = 120 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
/// An allowance must stay valid for at least a day after it is granted.
pub const MIN_ALLOWANCE_LEDGERS: u32 = DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Token,
    NextId,
    Policy(u64),
    Committed(Address),
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Status {
    Active = 0,
    Paused = 1,
    /// Ended by the subscriber or the merchant. Final.
    Revoked = 2,
    /// The cap leaves less than one more charge. Final.
    Completed = 3,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ChargeOutcome {
    Charged = 0,
    InsufficientBalance = 1,
    InsufficientAllowance = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Policy {
    pub id: u64,
    pub subscriber: Address,
    pub merchant: Address,
    pub amount: i128,
    pub interval: u64,
    pub cap: i128,
    pub spent: i128,
    pub charges: u32,
    /// Consecutive charges the subscriber could not cover. Reset on success.
    pub failed_attempts: u32,
    pub next_charge_at: u64,
    pub created_at: u64,
    pub status: Status,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    PolicyNotFound = 1,
    InvalidAmount = 2,
    InvalidInterval = 3,
    InvalidCap = 4,
    InvalidParty = 5,
    NotActive = 6,
    NotPaused = 7,
    AlreadyFinal = 8,
    NotDue = 9,
    Overflow = 10,
    /// `allowance_live_until` is under a day away or past the network maximum.
    InvalidAllowanceExpiry = 11,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyCreated {
    #[topic]
    pub policy_id: u64,
    #[topic]
    pub subscriber: Address,
    #[topic]
    pub merchant: Address,
    pub amount: i128,
    pub interval: u64,
    pub cap: i128,
    pub next_charge_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Charged {
    #[topic]
    pub policy_id: u64,
    /// When this charge was scheduled; the ledger close time minus this is its lateness.
    pub due_at: u64,
    pub amount: i128,
    pub spent: i128,
    pub charges: u32,
    pub next_charge_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChargeFailed {
    #[topic]
    pub policy_id: u64,
    pub due_at: u64,
    pub reason: ChargeOutcome,
    pub failed_attempts: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusChanged {
    #[topic]
    pub policy_id: u64,
    pub status: Status,
    pub next_charge_at: u64,
}

#[contract]
pub struct PayLoop;

fn token_client(env: &Env) -> token::Client<'_> {
    let address: Address = env.storage().instance().get(&DataKey::Token).unwrap();
    token::Client::new(env, &address)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO.min(env.storage().max_ttl()));
}

fn load_policy(env: &Env, id: u64) -> Policy {
    match env.storage().persistent().get(&DataKey::Policy(id)) {
        Some(policy) => policy,
        None => panic_with_error!(env, Error::PolicyNotFound),
    }
}

fn save_policy(env: &Env, policy: &Policy) {
    let key = DataKey::Policy(policy.id);
    env.storage().persistent().set(&key, policy);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO.min(env.storage().max_ttl()));
}

fn committed(env: &Env, subscriber: &Address) -> i128 {
    env.storage().persistent().get(&DataKey::Committed(subscriber.clone())).unwrap_or(0)
}

fn set_committed(env: &Env, subscriber: &Address, value: i128) {
    let key = DataKey::Committed(subscriber.clone());
    if value <= 0 {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, &value);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO.min(env.storage().max_ttl()));
}

fn checked_add(env: &Env, left: i128, right: i128) -> i128 {
    left.checked_add(right).unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

/// What a live policy may still charge. Final policies commit nothing.
fn remaining(policy: &Policy) -> i128 {
    match policy.status {
        Status::Active | Status::Paused => policy.cap - policy.spent,
        Status::Revoked | Status::Completed => 0,
    }
}

fn check_allowance_expiry(env: &Env, live_until: u32) -> Result<(), Error> {
    let earliest = env.ledger().sequence().saturating_add(MIN_ALLOWANCE_LEDGERS);
    if live_until < earliest || live_until > env.ledger().max_live_until_ledger() {
        return Err(Error::InvalidAllowanceExpiry);
    }
    Ok(())
}

/// Set the allowance to exactly what the subscriber's live policies may still charge.
fn approve_committed(env: &Env, subscriber: &Address, extra: i128, live_until: u32) {
    let amount = checked_add(env, committed(env, subscriber), extra);
    token_client(env).approve(subscriber, &env.current_contract_address(), &amount, &live_until);
}

/// Move a policy to a final state and release what it still had committed.
fn finalize(env: &Env, policy: &mut Policy, status: Status) {
    let released = remaining(policy);
    policy.status = status;
    set_committed(env, &policy.subscriber, committed(env, &policy.subscriber) - released);
}

fn publish_status(env: &Env, policy: &Policy) {
    StatusChanged { policy_id: policy.id, status: policy.status, next_charge_at: policy.next_charge_at }.publish(env);
}

#[contractimpl]
impl PayLoop {
    /// `token` is the asset every policy is denominated in (the USDC SAC).
    pub fn __constructor(env: Env, token: Address) {
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        bump_instance(&env);
    }

    pub fn token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token).unwrap()
    }

    /// Create a policy and execute its first charge atomically.
    /// `allowance_live_until` is the ledger the subscriber's allowance expires at.
    pub fn create_policy(
        env: Env,
        subscriber: Address,
        merchant: Address,
        amount: i128,
        interval: u64,
        cap: i128,
        allowance_live_until: u32,
    ) -> Result<u64, Error> {
        subscriber.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !(MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(&interval) {
            return Err(Error::InvalidInterval);
        }
        if cap < amount {
            return Err(Error::InvalidCap);
        }
        let contract = env.current_contract_address();
        if merchant == subscriber || merchant == contract || subscriber == contract {
            return Err(Error::InvalidParty);
        }
        check_allowance_expiry(&env, allowance_live_until)?;

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        bump_instance(&env);

        let now = env.ledger().timestamp();
        let mut policy = Policy {
            id,
            subscriber: subscriber.clone(),
            merchant: merchant.clone(),
            amount,
            interval,
            cap,
            spent: amount,
            charges: 1,
            failed_attempts: 0,
            next_charge_at: now + interval,
            created_at: now,
            status: Status::Active,
        };
        if cap - amount < amount {
            policy.status = Status::Completed;
        }

        // Grant exactly what stays committed after this first charge, plus the
        // charge itself, then take the charge. A failure here reverts everything.
        let still_committed = remaining(&policy);
        let committed_after = checked_add(&env, committed(&env, &subscriber), still_committed);
        approve_committed(&env, &subscriber, checked_add(&env, still_committed, amount), allowance_live_until);
        token_client(&env).transfer_from(&contract, &subscriber, &merchant, &amount);
        set_committed(&env, &subscriber, committed_after);
        save_policy(&env, &policy);

        PolicyCreated {
            policy_id: id,
            subscriber,
            merchant,
            amount,
            interval,
            cap,
            next_charge_at: policy.next_charge_at,
        }
        .publish(&env);
        Charged { policy_id: id, due_at: now, amount, spent: policy.spent, charges: 1, next_charge_at: policy.next_charge_at }.publish(&env);
        if policy.status == Status::Completed {
            publish_status(&env, &policy);
        }
        Ok(id)
    }

    /// Charge a due policy. Permissionless: the terms fix who is paid and how much.
    pub fn charge(env: Env, policy_id: u64) -> Result<ChargeOutcome, Error> {
        let mut policy = load_policy(&env, policy_id);
        if policy.status != Status::Active {
            return Err(Error::NotActive);
        }
        let now = env.ledger().timestamp();
        if now < policy.next_charge_at {
            return Err(Error::NotDue);
        }

        let token = token_client(&env);
        let contract = env.current_contract_address();
        let shortfall = if token.allowance(&policy.subscriber, &contract) < policy.amount {
            Some(ChargeOutcome::InsufficientAllowance)
        } else if token.balance(&policy.subscriber) < policy.amount {
            Some(ChargeOutcome::InsufficientBalance)
        } else {
            None
        };
        if let Some(reason) = shortfall {
            policy.failed_attempts += 1;
            save_policy(&env, &policy);
            ChargeFailed { policy_id, due_at: policy.next_charge_at, reason, failed_attempts: policy.failed_attempts }.publish(&env);
            return Ok(reason);
        }

        let due_at = policy.next_charge_at;
        token.transfer_from(&contract, &policy.subscriber, &policy.merchant, &policy.amount);
        policy.spent = checked_add(&env, policy.spent, policy.amount);
        policy.charges += 1;
        policy.failed_attempts = 0;
        // Stay on the original schedule, but never back-bill missed periods.
        let anchored = policy.next_charge_at + policy.interval;
        policy.next_charge_at = if anchored > now { anchored } else { now + policy.interval };
        set_committed(&env, &policy.subscriber, committed(&env, &policy.subscriber) - policy.amount);

        let completed = policy.cap - policy.spent < policy.amount;
        if completed {
            finalize(&env, &mut policy, Status::Completed);
        }
        save_policy(&env, &policy);
        Charged {
            policy_id,
            due_at,
            amount: policy.amount,
            spent: policy.spent,
            charges: policy.charges,
            next_charge_at: policy.next_charge_at,
        }
        .publish(&env);
        if completed {
            publish_status(&env, &policy);
        }
        Ok(ChargeOutcome::Charged)
    }

    /// Stop charges until resumed. The commitment and allowance are kept.
    pub fn pause(env: Env, policy_id: u64) -> Result<(), Error> {
        let mut policy = load_policy(&env, policy_id);
        policy.subscriber.require_auth();
        if policy.status != Status::Active {
            return Err(Error::NotActive);
        }
        policy.status = Status::Paused;
        save_policy(&env, &policy);
        publish_status(&env, &policy);
        Ok(())
    }

    /// Restart a paused policy. If its next charge passed while paused, a new
    /// period starts now; missed periods are not billed.
    pub fn resume(env: Env, policy_id: u64) -> Result<(), Error> {
        let mut policy = load_policy(&env, policy_id);
        policy.subscriber.require_auth();
        if policy.status != Status::Paused {
            return Err(Error::NotPaused);
        }
        let now = env.ledger().timestamp();
        if policy.next_charge_at < now {
            policy.next_charge_at = now;
        }
        policy.status = Status::Active;
        save_policy(&env, &policy);
        publish_status(&env, &policy);
        Ok(())
    }

    /// End a policy for good and shrink the allowance by what it had left.
    /// The remaining allowance (for other live policies) gets `allowance_live_until`.
    pub fn revoke(env: Env, policy_id: u64, allowance_live_until: u32) -> Result<(), Error> {
        let mut policy = load_policy(&env, policy_id);
        policy.subscriber.require_auth();
        if matches!(policy.status, Status::Revoked | Status::Completed) {
            return Err(Error::AlreadyFinal);
        }
        check_allowance_expiry(&env, allowance_live_until)?;
        finalize(&env, &mut policy, Status::Revoked);
        approve_committed(&env, &policy.subscriber, 0, allowance_live_until);
        save_policy(&env, &policy);
        publish_status(&env, &policy);
        Ok(())
    }

    /// End a policy from the merchant side. The subscriber's leftover allowance
    /// can no longer be charged by this policy; `refresh_allowance` trims it.
    pub fn cancel(env: Env, policy_id: u64) -> Result<(), Error> {
        let mut policy = load_policy(&env, policy_id);
        policy.merchant.require_auth();
        if matches!(policy.status, Status::Revoked | Status::Completed) {
            return Err(Error::AlreadyFinal);
        }
        finalize(&env, &mut policy, Status::Revoked);
        save_policy(&env, &policy);
        publish_status(&env, &policy);
        Ok(())
    }

    /// Re-grant exactly the committed allowance with a fresh expiry. Use it to
    /// renew before the allowance expires or to trim excess after a merchant
    /// cancellation or completion.
    pub fn refresh_allowance(env: Env, subscriber: Address, allowance_live_until: u32) -> Result<(), Error> {
        subscriber.require_auth();
        check_allowance_expiry(&env, allowance_live_until)?;
        approve_committed(&env, &subscriber, 0, allowance_live_until);
        Ok(())
    }

    pub fn get_policy(env: Env, policy_id: u64) -> Result<Policy, Error> {
        env.storage().persistent().get(&DataKey::Policy(policy_id)).ok_or(Error::PolicyNotFound)
    }

    /// Total the subscriber's live policies may still charge.
    pub fn committed(env: Env, subscriber: Address) -> i128 {
        committed(&env, &subscriber)
    }

    pub fn policy_count(env: Env) -> u64 {
        env.storage().instance().get::<_, u64>(&DataKey::NextId).unwrap_or(1) - 1
    }
}
