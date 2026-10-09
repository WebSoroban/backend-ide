#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, Events as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal,
};

const USDC: i128 = 10_000_000; // 7 decimals
const MONTH: u64 = 30 * 24 * 60 * 60;
const START: u64 = 1_800_000_000;

struct Setup<'a> {
    env: Env,
    client: PayLoopClient<'a>,
    token: TokenClient<'a>,
    contract: Address,
    subscriber: Address,
    merchant: Address,
}

/// Ledger the allowance stays valid until: ~100 days, well under the network maximum.
fn live_until(env: &Env) -> u32 {
    env.ledger().sequence() + 100 * 17_280
}

fn setup(balance: i128) -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);
    env.ledger().set_sequence_number(1_000);
    env.ledger().set_max_entry_ttl(3_110_400);
    let admin = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(admin);
    let subscriber = Address::generate(&env);
    let merchant = Address::generate(&env);
    if balance > 0 {
        StellarAssetClient::new(&env, &asset.address()).mint(&subscriber, &balance);
    }
    let contract = env.register(PayLoop, (asset.address(),));
    let client = PayLoopClient::new(&env, &contract);
    let token = TokenClient::new(&env, &asset.address());
    Setup { env, client, token, contract, subscriber, merchant }
}

fn advance(env: &Env, seconds: u64) {
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + seconds);
}

// --- create ------------------------------------------------------------------

#[test]
fn create_charges_first_period_and_commits_the_rest() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));

    assert_eq!(id, 1);
    assert_eq!(s.client.policy_count(), 1);
    assert_eq!(s.token.balance(&s.merchant), 10 * USDC);
    assert_eq!(s.token.balance(&s.subscriber), 90 * USDC);

    let policy = s.client.get_policy(&id);
    assert_eq!(policy.status, Status::Active);
    assert_eq!(policy.spent, 10 * USDC);
    assert_eq!(policy.charges, 1);
    assert_eq!(policy.next_charge_at, START + MONTH);

    // Allowance equals exactly what the policy may still charge.
    assert_eq!(s.client.committed(&s.subscriber), 110 * USDC);
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 110 * USDC);
}

#[test]
fn create_is_signed_once_by_the_subscriber_including_the_allowance() {
    let s = setup(100 * USDC);
    s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    let (signer, invocation) = &auths[0];
    assert_eq!(signer, &s.subscriber);
    assert_eq!(
        invocation.function,
        AuthorizedFunction::Contract((
            s.contract.clone(),
            soroban_sdk::Symbol::new(&s.env, "create_policy"),
            (s.subscriber.clone(), s.merchant.clone(), 10 * USDC, MONTH, 120 * USDC, live_until(&s.env)).into_val(&s.env),
        ))
    );
    // The token approval is a sub-invocation of that one signature.
    assert_eq!(invocation.sub_invocations.len(), 1);
}

#[test]
fn failed_first_charge_leaves_no_policy_and_no_allowance() {
    let s = setup(5 * USDC);
    let result = s.client.try_create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    assert!(result.is_err());
    assert_eq!(s.client.policy_count(), 0);
    assert!(s.client.try_get_policy(&1).is_err());
    assert_eq!(s.client.committed(&s.subscriber), 0);
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 0);
    assert_eq!(s.token.balance(&s.subscriber), 5 * USDC);
    assert_eq!(s.token.balance(&s.merchant), 0);
}

#[test]
fn create_rejects_invalid_terms() {
    let s = setup(100 * USDC);
    let c = &s.client;
    let e = live_until(&s.env);
    assert_eq!(c.try_create_policy(&s.subscriber, &s.merchant, &0, &MONTH, &USDC, &e), Err(Ok(Error::InvalidAmount)));
    assert_eq!(c.try_create_policy(&s.subscriber, &s.merchant, &-1, &MONTH, &USDC, &e), Err(Ok(Error::InvalidAmount)));
    assert_eq!(c.try_create_policy(&s.subscriber, &s.merchant, &USDC, &59, &(2 * USDC), &e), Err(Ok(Error::InvalidInterval)));
    assert_eq!(
        c.try_create_policy(&s.subscriber, &s.merchant, &USDC, &(MAX_INTERVAL_SECONDS + 1), &(2 * USDC), &e),
        Err(Ok(Error::InvalidInterval))
    );
    assert_eq!(c.try_create_policy(&s.subscriber, &s.merchant, &(2 * USDC), &MONTH, &USDC, &e), Err(Ok(Error::InvalidCap)));
    assert_eq!(c.try_create_policy(&s.subscriber, &s.subscriber, &USDC, &MONTH, &(2 * USDC), &e), Err(Ok(Error::InvalidParty)));
    assert_eq!(c.try_create_policy(&s.subscriber, &s.contract, &USDC, &MONTH, &(2 * USDC), &e), Err(Ok(Error::InvalidParty)));
    assert_eq!(c.policy_count(), 0);
}

#[test]
fn a_cap_of_one_charge_completes_at_creation() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(15 * USDC), &live_until(&s.env));
    assert_eq!(s.client.get_policy(&id).status, Status::Completed);
    assert_eq!(s.client.committed(&s.subscriber), 0);
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 0);
}

// --- charge ------------------------------------------------------------------

#[test]
fn charge_is_permissionless_but_only_when_due() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));

    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotDue)));
    advance(&s.env, MONTH - 1);
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotDue)));
    advance(&s.env, 1);

    // No one signs a charge: drop all mocked auths to prove it.
    s.env.set_auths(&[]);
    assert_eq!(s.client.charge(&id), ChargeOutcome::Charged);
    assert!(s.env.auths().is_empty());

    let policy = s.client.get_policy(&id);
    assert_eq!(policy.charges, 2);
    assert_eq!(policy.spent, 20 * USDC);
    assert_eq!(policy.next_charge_at, START + 2 * MONTH);
    assert_eq!(s.token.balance(&s.merchant), 20 * USDC);
    assert_eq!(s.client.committed(&s.subscriber), 100 * USDC);
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 100 * USDC);

    // Charging twice in the same period is impossible.
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotDue)));
}

#[test]
fn late_charges_keep_the_schedule_and_never_back_bill() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));

    // Charged an hour late: the next date stays anchored to the original schedule.
    advance(&s.env, MONTH + 3600);
    s.client.charge(&id);
    assert_eq!(s.client.get_policy(&id).next_charge_at, START + 2 * MONTH);

    // Relayer down for three periods: one charge, then a fresh period from now.
    advance(&s.env, 3 * MONTH);
    s.client.charge(&id);
    let now = s.env.ledger().timestamp();
    let policy = s.client.get_policy(&id);
    assert_eq!(policy.charges, 3);
    assert_eq!(policy.next_charge_at, now + MONTH - MAX_GRACE_SECONDS);
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotDue)));
}

#[test]
fn uncovered_charge_is_recorded_without_moving_funds() {
    let s = setup(15 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    advance(&s.env, MONTH);

    assert_eq!(s.client.charge(&id), ChargeOutcome::InsufficientBalance);
    // Anyone can call charge again, but a failure counts once per window.
    for _ in 0..20 {
        assert_eq!(s.client.charge(&id), ChargeOutcome::InsufficientBalance);
    }
    assert_eq!(s.client.get_policy(&id).failed_attempts, 1);
    advance(&s.env, FAILURE_WINDOW_SECONDS);
    assert_eq!(s.client.charge(&id), ChargeOutcome::InsufficientBalance);
    let policy = s.client.get_policy(&id);
    assert_eq!(policy.failed_attempts, 2);
    assert_eq!(policy.charges, 1);
    assert_eq!(policy.next_charge_at, START + MONTH, "schedule waits for a successful charge");
    assert_eq!(s.token.balance(&s.merchant), 10 * USDC);

    // Topped up: the retry succeeds and the failure counter resets.
    StellarAssetClient::new(&s.env, &s.token.address).mint(&s.subscriber, &(10 * USDC));
    assert_eq!(s.client.charge(&id), ChargeOutcome::Charged);
    assert_eq!(s.client.get_policy(&id).failed_attempts, 0);
}

#[test]
fn reduced_allowance_is_reported_not_overdrawn() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    // The subscriber shrinks the allowance directly in the token contract.
    s.token.approve(&s.subscriber, &s.contract, &(5 * USDC), &s.env.ledger().max_live_until_ledger());
    advance(&s.env, MONTH);
    assert_eq!(s.client.charge(&id), ChargeOutcome::InsufficientAllowance);
    assert_eq!(s.token.balance(&s.merchant), 10 * USDC);

    // refresh_allowance restores exactly the committed amount.
    s.client.refresh_allowance(&s.subscriber, &live_until(&s.env));
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 110 * USDC);
    assert_eq!(s.client.charge(&id), ChargeOutcome::Charged);
}

#[test]
fn the_cap_is_never_exceeded_and_completion_releases_the_remainder() {
    let s = setup(100 * USDC);
    // 10 per period, cap 35: charges at 10, 20, 30; 5 left is less than one charge.
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(35 * USDC), &live_until(&s.env));
    advance(&s.env, MONTH);
    s.client.charge(&id);
    advance(&s.env, MONTH);
    s.client.charge(&id);

    let policy = s.client.get_policy(&id);
    assert_eq!(policy.spent, 30 * USDC);
    assert_eq!(policy.status, Status::Completed);
    assert_eq!(s.client.committed(&s.subscriber), 0);
    advance(&s.env, MONTH);
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotActive)));
    assert_eq!(s.token.balance(&s.merchant), 30 * USDC);
}

// --- pause / resume -------------------------------------------------------------

#[test]
fn pause_blocks_charges_and_resume_starts_a_fresh_period() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));

    s.client.pause(&id);
    assert_eq!(s.client.get_policy(&id).status, Status::Paused);
    assert_eq!(s.client.try_pause(&id), Err(Ok(Error::NotActive)));
    advance(&s.env, 3 * MONTH);
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotActive)));
    assert_eq!(s.client.committed(&s.subscriber), 110 * USDC, "pausing keeps the commitment");

    s.client.resume(&id);
    let now = s.env.ledger().timestamp();
    let policy = s.client.get_policy(&id);
    assert_eq!(policy.status, Status::Active);
    assert_eq!(policy.next_charge_at, now);
    assert_eq!(s.client.try_resume(&id), Err(Ok(Error::NotPaused)));

    // One charge for the new period, none for the three paused months.
    assert_eq!(s.client.charge(&id), ChargeOutcome::Charged);
    assert_eq!(s.client.get_policy(&id).charges, 2);
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotDue)));
}

#[test]
fn resuming_early_keeps_the_paid_period() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    s.client.pause(&id);
    advance(&s.env, 3600);
    s.client.resume(&id);
    assert_eq!(s.client.get_policy(&id).next_charge_at, START + MONTH);
}

// --- revoke / cancel ------------------------------------------------------------

#[test]
fn revoke_is_final_and_refresh_trims_the_allowance_to_other_policies() {
    let s = setup(200 * USDC);
    let first = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    let other_merchant = Address::generate(&s.env);
    let second = s.client.create_policy(&s.subscriber, &other_merchant, &(5 * USDC), &MONTH, &(50 * USDC), &live_until(&s.env));

    // One shared token allowance covers both policies' remaining commitments.
    assert_eq!(s.client.committed(&s.subscriber), 110 * USDC + 45 * USDC);
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 155 * USDC);

    s.client.revoke(&first);
    assert_eq!(s.client.get_policy(&first).status, Status::Revoked);
    assert_eq!(s.client.committed(&s.subscriber), 45 * USDC);
    // Revoke does not touch the allowance; trimming is a separate, optional step.
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 155 * USDC);
    s.client.refresh_allowance(&s.subscriber, &live_until(&s.env));
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 45 * USDC);
    assert_eq!(s.client.try_revoke(&first), Err(Ok(Error::AlreadyFinal)));
    assert_eq!(s.client.try_resume(&first), Err(Ok(Error::NotPaused)));

    advance(&s.env, MONTH);
    assert_eq!(s.client.try_charge(&first), Err(Ok(Error::NotActive)));
    // The other policy is unaffected.
    assert_eq!(s.client.charge(&second), ChargeOutcome::Charged);
    assert_eq!(s.token.balance(&other_merchant), 10 * USDC);
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 40 * USDC);
}

#[test]
fn a_paused_policy_can_be_revoked() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    s.client.pause(&id);
    s.client.revoke(&id);
    assert_eq!(s.client.get_policy(&id).status, Status::Revoked);
    assert_eq!(s.client.committed(&s.subscriber), 0);
    s.client.refresh_allowance(&s.subscriber, &live_until(&s.env));
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 0);
}

#[test]
fn merchant_can_cancel_and_subscriber_can_trim_the_leftover() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    s.client.cancel(&id);
    assert_eq!(s.client.get_policy(&id).status, Status::Revoked);
    assert_eq!(s.client.committed(&s.subscriber), 0);
    advance(&s.env, MONTH);
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotActive)));

    s.client.refresh_allowance(&s.subscriber, &live_until(&s.env));
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 0);
}

// --- authorization --------------------------------------------------------------

#[test]
fn only_the_subscriber_can_pause_resume_or_revoke() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    let stranger = Address::generate(&s.env);

    for (name, actor) in [("pause", &s.merchant), ("pause", &stranger), ("revoke", &s.merchant), ("revoke", &stranger)] {
        let auth = MockAuth {
            address: actor,
            invoke: &MockAuthInvoke {
                contract: &s.contract,
                fn_name: name,
                args: (id,).into_val(&s.env),
                sub_invokes: &[],
            },
        };
        let auths = [auth];
        let client = s.client.mock_auths(&auths);
        let result = if name == "pause" { client.try_pause(&id).map(|_| ()) } else { client.try_revoke(&id).map(|_| ()) };
        assert!(result.is_err(), "{name} by a non-subscriber must fail");
    }

    s.client.pause(&id);
    let auths = s.env.auths();
    assert_eq!(auths[0].0, s.subscriber);
}

#[test]
fn only_the_merchant_can_cancel() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    let auth = MockAuth {
        address: &s.subscriber,
        invoke: &MockAuthInvoke { contract: &s.contract, fn_name: "cancel", args: (id,).into_val(&s.env), sub_invokes: &[] },
    };
    assert!(s.client.mock_auths(&[auth]).try_cancel(&id).is_err());
    s.client.cancel(&id);
    assert_eq!(s.env.auths()[0].0, s.merchant);
}

#[test]
fn unknown_policies_are_rejected() {
    let s = setup(0);
    assert_eq!(s.client.try_get_policy(&42), Err(Ok(Error::PolicyNotFound)));
    assert!(s.client.try_charge(&42).is_err());
    assert!(s.client.try_pause(&42).is_err());
}

// --- events ------------------------------------------------------------------

#[test]
fn every_state_change_emits_an_event_for_the_indexer() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    let created = s.env.events().all().filter_by_contract(&s.contract);
    // PolicyCreated + Charged (the token's own approve/transfer events are filtered out).
    assert_eq!(created.events().len(), 2);

    s.client.pause(&id);
    assert_eq!(s.env.events().all().filter_by_contract(&s.contract).events().len(), 1);
    s.client.resume(&id);
    assert_eq!(s.env.events().all().filter_by_contract(&s.contract).events().len(), 1);
    advance(&s.env, MONTH);
    s.client.charge(&id);
    assert_eq!(s.env.events().all().filter_by_contract(&s.contract).events().len(), 1);
    s.client.revoke(&id);
    assert_eq!(s.env.events().all().filter_by_contract(&s.contract).events().len(), 1);
}

#[test]
fn allowance_expiry_is_explicit_and_bounded() {
    let s = setup(100 * USDC);
    let too_soon = s.env.ledger().sequence() + 100;
    let too_late = s.env.ledger().max_live_until_ledger() + 1;
    for expiry in [too_soon, too_late] {
        assert_eq!(
            s.client.try_create_policy(&s.subscriber, &s.merchant, &USDC, &MONTH, &(10 * USDC), &expiry),
            Err(Ok(Error::InvalidAllowanceExpiry))
        );
    }
    s.client.create_policy(&s.subscriber, &s.merchant, &USDC, &MONTH, &(10 * USDC), &live_until(&s.env));
    assert_eq!(s.client.try_refresh_allowance(&s.subscriber, &too_late), Err(Ok(Error::InvalidAllowanceExpiry)));
}

#[test]
fn signed_approval_carries_the_exact_expiry() {
    // The subscriber's signature covers approve(..., allowance_live_until). The value
    // must come from the arguments, not the ledger, or execution would not match it.
    let s = setup(100 * USDC);
    let expiry = live_until(&s.env);
    s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &expiry);
    let auths = s.env.auths();
    let approve = &auths[0].1.sub_invocations[0];
    assert_eq!(
        approve.function,
        AuthorizedFunction::Contract((
            s.token.address.clone(),
            soroban_sdk::Symbol::new(&s.env, "approve"),
            (s.subscriber.clone(), s.contract.clone(), 120 * USDC, expiry).into_val(&s.env),
        ))
    );
}

// --- security review fixes -----------------------------------------------------

#[test]
fn late_charges_are_never_followed_by_a_second_charge_moments_later() {
    let s = setup(100 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    // Charged one second before the next period would be due.
    advance(&s.env, 2 * MONTH - 1);
    s.client.charge(&id);
    let now = s.env.ledger().timestamp();
    let next = s.client.get_policy(&id).next_charge_at;
    assert!(next >= now + MONTH - MAX_GRACE_SECONDS, "consecutive charges stay at least interval - grace apart");
    advance(&s.env, 1);
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotDue)));
}

#[test]
fn a_late_top_up_does_not_back_bill_the_missed_period() {
    let s = setup(12 * USDC);
    let id = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    advance(&s.env, MONTH);
    assert_eq!(s.client.charge(&id), ChargeOutcome::InsufficientBalance);
    // Topped up near the end of the period: one charge now, the next a full period later.
    advance(&s.env, MONTH - 60);
    StellarAssetClient::new(&s.env, &s.token.address).mint(&s.subscriber, &(50 * USDC));
    assert_eq!(s.client.charge(&id), ChargeOutcome::Charged);
    advance(&s.env, 120);
    assert_eq!(s.client.try_charge(&id), Err(Ok(Error::NotDue)));
    assert_eq!(s.token.balance(&s.merchant), 20 * USDC);
}

#[test]
fn merchant_cannot_be_the_token_and_caps_and_intervals_are_bounded() {
    let s = setup(100 * USDC);
    let e = live_until(&s.env);
    assert_eq!(s.client.try_create_policy(&s.subscriber, &s.token.address, &USDC, &MONTH, &(2 * USDC), &e), Err(Ok(Error::InvalidParty)));
    assert_eq!(s.client.try_create_policy(&s.subscriber, &s.merchant, &USDC, &MONTH, &(MAX_CAP + 1), &e), Err(Ok(Error::InvalidCap)));
    assert_eq!(s.client.try_create_policy(&s.subscriber, &s.merchant, &USDC, &(91 * 24 * 3600), &(2 * USDC), &e), Err(Ok(Error::InvalidInterval)));
}

#[test]
fn a_shorter_expiry_never_shortens_an_existing_allowance() {
    let s = setup(100 * USDC);
    let long = s.env.ledger().sequence() + 150 * 17_280;
    let short = s.env.ledger().sequence() + 2 * 17_280;
    s.client.create_policy(&s.subscriber, &s.merchant, &USDC, &MONTH, &(10 * USDC), &long);
    let other = Address::generate(&s.env);
    let second = s.client.create_policy(&s.subscriber, &other, &USDC, &MONTH, &(10 * USDC), &short);
    // Well past the short expiry, the first policy's allowance is still live.
    s.env.ledger().set_sequence_number(s.env.ledger().sequence() + 10 * 17_280);
    advance(&s.env, MONTH);
    assert_eq!(s.client.charge(&1), ChargeOutcome::Charged);
    assert_eq!(s.client.charge(&second), ChargeOutcome::Charged);
}

#[test]
fn revocation_cannot_be_blocked_by_charges_on_other_policies() {
    let s = setup(200 * USDC);
    let target = s.client.create_policy(&s.subscriber, &s.merchant, &(10 * USDC), &MONTH, &(120 * USDC), &live_until(&s.env));
    let other = s.client.create_policy(&s.subscriber, &Address::generate(&s.env), &(5 * USDC), &MONTH, &(50 * USDC), &live_until(&s.env));
    advance(&s.env, MONTH);
    // A charge lands on the other policy (changing committed) right before the revoke.
    s.client.charge(&other);
    s.client.revoke(&target);
    assert_eq!(s.client.get_policy(&target).status, Status::Revoked);
    assert_eq!(s.client.committed(&s.subscriber), 40 * USDC);
}
