// Portions adapted from neptune-core, Copyright Triton Software AG and
// contributors, Apache License 2.0. Modified by avotrom. See NOTICE.

//! Coins that are never announced on-chain, and how the wallet registers them.
//!
//! Most payments carry an encrypted notification in the block, which the
//! wallet finds by scanning. Three kinds of coins do not:
//!
//! 1. **Off-chain notifications.** A sender can hand the notification over
//!    directly instead of publishing it, as a `utxo...` text (neptune-core's
//!    `claim-utxo`). Composer rewards, half of them time-locked for three
//!    years, are delivered this way. [`decode_notification`] decrypts one with
//!    the wallet's keys and checks it exactly like neptune-core's
//!    `GlobalState::claim_utxo`: a key with that receiver identifier, valid
//!    type scripts, the key's own lock script.
//! 2. **Premine and redemption-claim allocations** in the genesis block, all
//!    time-locked at launch. neptune-core looks for them with the first ten
//!    generation keys ([`PREMINE_KEYS`]); [`genesis_state`] does the same when
//!    a wallet starts at genesis.
//! 3. **Guesser fees** (half time-locked): found in [`crate::sync`] from the
//!    block header's guesser receiver data, as neptune-core does.
//!
//! A registered coin waits in [`WalletState::expected`] until its addition
//! record shows up in a block; [`crate::archive`] can find one that already
//! did.

use std::cell::RefCell;
use std::rc::Rc;

use anyhow::{Result, anyhow, ensure};
use neptune_consensus::block::Block;
use neptune_consensus::block::mutator_set_update::MutatorSetUpdate;
use neptune_consensus::transaction::utxo::Utxo;
use neptune_mutator_set::addition_record::AdditionRecord;
use neptune_mutator_set::ms_membership_proof::MsMembershipProof;
use neptune_mutator_set::mutator_set_accumulator::MutatorSetAccumulator;
use neptune_mutator_set::removal_record::RemovalRecord;
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_primitives::network::Network;
use neptune_rpc_api::model::wallet::block::RpcWalletBlock;
use neptune_wallet::address::SpendingKey;
use neptune_wallet::address::encrypted_utxo_notification::EncryptedUtxoNotification;
use neptune_wallet::incoming_utxo::IncomingUtxo;
use neptune_wallet::tasm_lib::prelude::{Digest, Tip5};
use serde::Serialize;

use crate::keys::{KeyRef, Keys};
use crate::state::{ExpectedSource, ExpectedUtxo, OwnedUtxo, STATE_VERSION, WalletState};
use crate::sync::{Decoded, decode, msa_after};

/// Generation key indices neptune-core checks for premine allocations.
pub const PREMINE_KEYS: u64 = 10;

/// What a notification turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaimStatus {
    /// New to this wallet.
    New,
    /// Already registered, waiting for its block.
    Waiting,
    /// Already one of the wallet's coins.
    Owned,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaimView {
    pub amount: String,
    /// Time lock release (ms), if any.
    pub release_ms: Option<u64>,
    /// "generation", "ec-hybrid" or "change": the key it is locked to.
    pub key_kind: &'static str,
    pub status: ClaimStatus,
    pub addition_record: String,
}

fn key_kind(k: KeyRef) -> &'static str {
    match k {
        KeyRef::Generation(_) => "generation",
        KeyRef::EcHybrid(_) => "ec-hybrid",
        KeyRef::Symmetric(_) => "change",
    }
}

fn status_of(state: &WalletState, e: &ExpectedUtxo) -> ClaimStatus {
    if state.owns_addition_record(&e.addition_record) {
        ClaimStatus::Owned
    } else if state
        .expected
        .iter()
        .any(|x| x.addition_record == e.addition_record)
    {
        ClaimStatus::Waiting
    } else {
        ClaimStatus::New
    }
}

pub fn claim_view(state: &WalletState, e: &ExpectedUtxo) -> ClaimView {
    ClaimView {
        amount: e.utxo.get_native_currency_amount().display_lossless(),
        release_ms: e.utxo.release_date().map(|t| t.to_millis()),
        key_kind: key_kind(e.key),
        status: status_of(state, e),
        addition_record: e.addition_record.canonical_commitment.to_hex(),
    }
}

/// Decrypt and check an off-chain notification (`utxo...` text).
pub fn decode_notification(text: &str, keys: &Keys, state: &WalletState) -> Result<ExpectedUtxo> {
    let candidates = keys.scan_keys(
        state.next_generation_index.max(PREMINE_KEYS),
        state.next_symmetric_index,
        state.next_ec_hybrid_index,
    );
    decode_notification_with_candidates(text, keys, state, candidates)
}

pub(crate) fn decode_notification_for_key(
    text: &str,
    keys: &Keys,
    state: &WalletState,
    key: KeyRef,
) -> Result<ExpectedUtxo> {
    decode_notification_with_candidates(text, keys, state, vec![(key, keys.key(key))])
}

fn decode_notification_with_candidates(
    text: &str,
    keys: &Keys,
    state: &WalletState,
    candidates: Vec<(KeyRef, SpendingKey)>,
) -> Result<ExpectedUtxo> {
    let text = text.trim().to_ascii_lowercase();
    let notification = EncryptedUtxoNotification::from_bech32m(&text, keys.network())
        .map_err(|e| anyhow!("not a payment notification for this network: {e}"))?;

    // The receiver identifier names the key; scan the same keys sync scans.
    let candidates: Vec<(KeyRef, SpendingKey)> = candidates
        .into_iter()
        .filter(|(_, k)| k.receiver_identifier() == notification.receiver_identifier)
        .collect();
    ensure!(
        !candidates.is_empty(),
        "no key of this wallet matches: the payment is for another wallet"
    );

    let mut last_err = None;
    for (key_ref, key) in candidates {
        let payload = match notification.decrypt_with_spending_key(&key) {
            Ok(p) => p,
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        };
        ensure!(
            payload.utxo.all_type_script_states_are_valid(),
            "the coin's type scripts are not valid"
        );
        ensure!(
            payload.utxo.lock_script_hash() == key.lock_script_hash(),
            "the coin is locked to a different key"
        );
        let incoming =
            IncomingUtxo::from_utxo_notification_payload(payload, key.privacy_preimage());
        return Ok(ExpectedUtxo {
            addition_record: incoming.addition_record(),
            utxo: incoming.utxo,
            sender_randomness: incoming.sender_randomness,
            receiver_preimage: incoming.receiver_preimage,
            key: key_ref,
            source: ExpectedSource::Notification,
            registered_at: state.height,
        });
    }
    Err(anyhow!(
        "could not decrypt the notification: {}",
        last_err.map_or_else(|| "unknown error".into(), |e| e.to_string())
    ))
}

/// Add a coin to the waiting list. Returns its status before the call.
pub fn register(state: &mut WalletState, e: ExpectedUtxo) -> ClaimStatus {
    let status = status_of(state, &e);
    if status == ClaimStatus::New {
        state.expected.push(e);
    }
    status
}

/// Forget a waiting coin by its addition record (hex). Returns whether one
/// was removed.
pub fn unregister(state: &mut WalletState, addition_record_hex: &str) -> bool {
    let before = state.expected.len();
    state
        .expected
        .retain(|e| e.addition_record.canonical_commitment.to_hex() != addition_record_hex);
    state.expected.len() != before
}

/// What premine scanning needs from the genesis block, built once.
struct GenesisData {
    network: Network,
    outputs: Vec<AdditionRecord>,
    utxos: Vec<Utxo>,
    sender_randomness: Digest,
}

thread_local! {
    static GENESIS: RefCell<Option<Rc<GenesisData>>> = const { RefCell::new(None) };
}

fn genesis_data(network: Network) -> Result<Rc<GenesisData>> {
    if let Some(g) = GENESIS.with(|c| c.borrow().clone()) {
        if g.network == network {
            return Ok(g);
        }
    }
    let genesis = Block::genesis(network);
    let outputs = genesis.body().transaction_kernel.outputs.clone();
    let utxos = Block::premine_utxos();
    ensure!(
        outputs.len() == utxos.len(),
        "genesis outputs and premine allocations differ in number"
    );
    let g = Rc::new(GenesisData {
        network,
        outputs,
        utxos,
        sender_randomness: Block::premine_sender_randomness(network),
    });
    GENESIS.with(|c| *c.borrow_mut() = Some(g.clone()));
    Ok(g)
}

/// The premine allocations locked to generation key `index`, with their AOCL
/// leaf index (their position in the genesis block). One key at a time, so
/// the extension can show progress.
pub fn premine_for_key(keys: &Keys, index: u64) -> Result<Vec<(u64, ExpectedUtxo)>> {
    let g = genesis_data(keys.network())?;
    let key_ref = KeyRef::Generation(index);
    let key = keys.key(key_ref);
    let lock = key.lock_script_hash();
    let mut found = vec![];
    for (i, (record, utxo)) in g.outputs.iter().zip(&g.utxos).enumerate() {
        if utxo.lock_script_hash() != lock {
            continue;
        }
        let incoming = IncomingUtxo {
            utxo: utxo.clone(),
            sender_randomness: g.sender_randomness,
            receiver_preimage: key.privacy_preimage(),
            is_guesser_fee: false,
        };
        // The genesis block must really hold this coin at this position.
        if incoming.addition_record() != *record {
            continue;
        }
        found.push((
            i as u64,
            ExpectedUtxo {
                addition_record: *record,
                utxo: incoming.utxo,
                sender_randomness: g.sender_randomness,
                receiver_preimage: incoming.receiver_preimage,
                key: key_ref,
                source: ExpectedSource::Premine,
                registered_at: 0,
            },
        ));
    }
    Ok(found)
}

/// The premine allocations that belong to this wallet (keys 0 to
/// [`PREMINE_KEYS`] - 1, as neptune-core).
pub fn premine_coins(keys: &Keys) -> Result<Vec<(u64, ExpectedUtxo)>> {
    let mut all = vec![];
    for i in 0..PREMINE_KEYS {
        all.extend(premine_for_key(keys, i)?);
    }
    all.sort_by_key(|(i, _)| *i);
    Ok(all)
}

/// A wallet state at the genesis block, holding this wallet's premine coins
/// (if any) with membership proofs. Starting a full scan here also scans
/// block 1, which a start from block 1's state skips.
pub fn genesis_state(keys: &Keys) -> Result<WalletState> {
    let network: Network = keys.network();
    let genesis = Block::genesis(network);
    let hash = genesis.hash();
    let update = genesis
        .kernel
        .mutator_set_update(hash, network)
        .map_err(|e| anyhow!("genesis mutator set update: {e:?}"))?;
    ensure!(update.removals.is_empty(), "genesis spends nothing");
    let ours = premine_coins(keys)?;

    let mut msa = MutatorSetAccumulator::default();
    let mut work: Vec<(Digest, MsMembershipProof, ExpectedUtxo)> = vec![];
    for (i, addition) in update.additions.iter().enumerate() {
        {
            let items: Vec<Digest> = work.iter().map(|w| w.0).collect();
            let mut proofs: Vec<&mut MsMembershipProof> =
                work.iter_mut().map(|w| &mut w.1).collect();
            MsMembershipProof::batch_update_from_addition(&mut proofs, &items, &msa, addition)
                .map_err(|e| anyhow!("membership proof update (genesis): {e}"))?;
        }
        if let Some((_, e)) = ours.iter().find(|(idx, _)| *idx == i as u64) {
            ensure!(e.addition_record == *addition, "premine coin out of place");
            let item = Tip5::hash(&e.utxo);
            work.push((
                item,
                msa.prove(item, e.sender_randomness, e.receiver_preimage),
                e.clone(),
            ));
        }
        msa.add(addition);
    }
    let expected_msa = crate::sync::msa_after(&genesis.kernel, hash)?;
    ensure!(
        expected_msa.hash() == msa.hash(),
        "rebuilt genesis mutator set does not match the genesis block"
    );

    let n = update.additions.len() as u64;
    let block_leaves = (n > 0).then(|| (0, n - 1));
    let mut next_generation_index = 0;
    let utxos: Vec<OwnedUtxo> = work
        .into_iter()
        .map(|(item, proof, e)| {
            debug_assert!(msa.verify(item, &proof));
            if let KeyRef::Generation(i) = e.key {
                next_generation_index = next_generation_index.max(i + 1);
            }
            OwnedUtxo {
                utxo: e.utxo,
                sender_randomness: e.sender_randomness,
                receiver_preimage: e.receiver_preimage,
                key: e.key,
                membership_proof: proof,
                received_height: 0,
                block_leaves,
                spent_height: None,
                reserved_by: None,
            }
        })
        .collect();
    for u in &utxos {
        ensure!(
            msa.verify(u.item(), &u.membership_proof),
            "premine proof does not verify"
        );
    }

    Ok(WalletState {
        version: STATE_VERSION,
        network,
        height: 0,
        tip_hash: hash,
        tip_timestamp_ms: genesis.header().timestamp.to_millis(),
        msa,
        lustration_status: None,
        next_generation_index,
        next_symmetric_index: 0,
        utxos,
        next_ec_hybrid_index: 0,
        expected: vec![],
        watch: vec![],
    })
}

/// A registered coin the archive found on chain.
#[derive(Debug, Clone, Serialize)]
pub struct Adopted {
    pub aocl_index: u64,
    pub height: u64,
    pub amount: String,
    pub key_kind: &'static str,
    /// Already spent: shown in no balance, dropped from the waiting list.
    pub spent: bool,
}

/// Move registered coins that the chain already holds into the wallet.
///
/// Each coin the archive finds gets its membership proof restored at the
/// archive's block, then carried forward through `blocks` (the blocks from
/// the archive's height + 1 to the wallet's height, in order) with the same
/// updates the wallet's sync applies, spends detected on the way. The
/// accumulator carried along must end equal to the wallet's own, so the
/// proofs are valid for the wallet as it is. The archive is kept a few blocks
/// behind the wallet so that a small reorganization never reaches it.
pub fn adopt_from_archive(
    state: &mut WalletState,
    archive: &crate::archive::Archive,
    blocks: Vec<RpcWalletBlock>,
) -> Result<Vec<Adopted>> {
    ensure!(
        archive.height() <= state.height,
        "the archive is ahead of the wallet ({} > {})",
        archive.height(),
        state.height
    );

    struct Found {
        e: ExpectedUtxo,
        aocl_index: u64,
        height: u64,
        item: Digest,
        set: AbsoluteIndexSet,
        proof: MsMembershipProof,
        spent_at: Option<u64>,
    }
    let mut adopted = vec![];
    let mut keep = vec![];
    let mut found: Vec<Found> = vec![];
    for e in std::mem::take(&mut state.expected) {
        let Some((aocl_index, height)) = archive.locate(&e.addition_record) else {
            keep.push(e);
            continue;
        };
        if state.utxos.iter().any(|u| u.aocl_index() == aocl_index) {
            continue; // already owned
        }
        let item = e.item();
        let set =
            AbsoluteIndexSet::compute(item, e.sender_randomness, e.receiver_preimage, aocl_index);
        if archive.was_spent(&set) {
            adopted.push(Adopted {
                aocl_index,
                height,
                amount: e.utxo.get_native_currency_amount().display_lossless(),
                key_kind: key_kind(e.key),
                spent: true,
            });
            continue;
        }
        let proof = archive.restore(item, e.sender_randomness, e.receiver_preimage, aocl_index)?;
        found.push(Found {
            e,
            aocl_index,
            height,
            item,
            set,
            proof,
            spent_at: None,
        });
    }

    if found.is_empty() {
        state.expected = keep;
        return Ok(adopted);
    }

    // Carry the proofs from the archive's block to the wallet's.
    let network = state.network;
    let mut msa = archive.msa().clone();
    let mut tip = archive.tip_hash();
    let mut at = archive.height();
    for block in blocks {
        let Decoded {
            hash,
            height,
            kernel,
        } = decode(block);
        if height <= at {
            continue;
        }
        if height > state.height {
            break;
        }
        ensure!(
            height == at + 1 && kernel.header.prev_block_digest == tip,
            "block {height} does not follow the archive's block {at}"
        );
        let MutatorSetUpdate {
            additions,
            removals,
        } = kernel
            .mutator_set_update(hash, network)
            .map_err(|e| anyhow!("mutator set update: {e:?}"))?;
        let mut removals = removals;
        removals.reverse();
        let mut refs: Vec<&mut RemovalRecord> = removals.iter_mut().collect();
        for addition in &additions {
            {
                let items: Vec<Digest> = found.iter().map(|f| f.item).collect();
                let mut proofs: Vec<&mut MsMembershipProof> =
                    found.iter_mut().map(|f| &mut f.proof).collect();
                MsMembershipProof::batch_update_from_addition(&mut proofs, &items, &msa, addition)
                    .map_err(|e| anyhow!("membership proof update (addition): {e}"))?;
            }
            RemovalRecord::batch_update_from_addition(&mut refs, &msa);
            msa.add(addition);
        }
        while let Some(removal) = refs.pop() {
            {
                let mut proofs: Vec<&mut MsMembershipProof> =
                    found.iter_mut().map(|f| &mut f.proof).collect();
                MsMembershipProof::batch_update_from_remove(&mut proofs, removal)
                    .map_err(|e| anyhow!("membership proof update (removal): {e}"))?;
            }
            RemovalRecord::batch_update_from_remove(&mut refs, removal);
            for f in found.iter_mut().filter(|f| f.spent_at.is_none()) {
                if f.set == removal.absolute_indices {
                    f.spent_at = Some(height);
                }
            }
            msa.remove(removal);
        }
        ensure!(
            msa_after(&kernel, hash)?.hash() == msa.hash(),
            "block {height} does not rebuild its own mutator set"
        );
        at = height;
        tip = hash;
    }
    ensure!(
        at == state.height && tip == state.tip_hash && msa.hash() == state.msa.hash(),
        "the blocks given do not lead from the archive (block {}) to the wallet (block {})",
        archive.height(),
        state.height
    );

    for f in found {
        let amount = f.e.utxo.get_native_currency_amount().display_lossless();
        let kind = key_kind(f.e.key);
        if f.spent_at.is_some() {
            adopted.push(Adopted {
                aocl_index: f.aocl_index,
                height: f.height,
                amount,
                key_kind: kind,
                spent: true,
            });
            continue;
        }
        ensure!(
            state.msa.verify(f.item, &f.proof),
            "a restored proof does not verify for the wallet"
        );
        if let KeyRef::Generation(i) = f.e.key {
            state.next_generation_index = state.next_generation_index.max(i + 1);
        }
        state.utxos.push(OwnedUtxo {
            utxo: f.e.utxo,
            sender_randomness: f.e.sender_randomness,
            receiver_preimage: f.e.receiver_preimage,
            key: f.e.key,
            membership_proof: f.proof,
            received_height: f.height,
            block_leaves: archive.block_leaves(f.height),
            spent_height: None,
            reserved_by: None,
        });
        adopted.push(Adopted {
            aocl_index: f.aocl_index,
            height: f.height,
            amount,
            key_kind: kind,
            spent: false,
        });
    }
    state.expected = keep;
    Ok(adopted)
}

/// Register this wallet's premine allocations as waiting coins: those of
/// the given generation key indices, or of all premine keys. Returns how
/// many were new.
pub fn register_premine(
    state: &mut WalletState,
    keys: &Keys,
    indices: Option<&[u64]>,
) -> Result<usize> {
    let all: Vec<u64> = (0..PREMINE_KEYS).collect();
    let mut n = 0;
    for &i in indices.unwrap_or(&all) {
        ensure!(
            i < PREMINE_KEYS,
            "premine keys go up to {}",
            PREMINE_KEYS - 1
        );
        for (_, e) in premine_for_key(keys, i)? {
            if register(state, e) == ClaimStatus::New {
                n += 1;
            }
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use neptune_consensus::transaction::utxo::Utxo;
    use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
    use neptune_mutator_set::commit;
    use neptune_primitives::timestamp::Timestamp;
    use neptune_wallet::twenty_first::math::b_field_element::BFieldElement;
    use neptune_wallet::utxo_notification::UtxoNotificationPayload;

    use super::*;

    fn keys(seed: u8) -> Keys {
        let phrase = Keys::phrase_from_entropy(&[seed; 24]).unwrap();
        Keys::from_phrase(&phrase, Network::Main).unwrap()
    }

    #[test]
    fn genesis_state_is_consistent() {
        let k = keys(5);
        let st = genesis_state(&k).unwrap();
        assert_eq!(st.height, 0);
        assert_eq!(st.tip_hash, Block::genesis(Network::Main).hash());
        // A random wallet owns no premine.
        assert!(st.utxos.is_empty());
        assert!(premine_coins(&k).unwrap().is_empty());
        // And survives a round trip through bytes.
        let again = WalletState::from_bytes(&st.to_bytes().unwrap()).unwrap();
        assert_eq!(again.msa.hash(), st.msa.hash());
    }

    #[test]
    fn off_chain_notification_round_trip() {
        let k = keys(7);
        let mut st = genesis_state(&k).unwrap();
        for key_ref in [KeyRef::EcHybrid(0), KeyRef::Generation(0)] {
            let address = k.address(key_ref);
            let release = Timestamp::millis(4_102_444_800_000); // year 2100
            let utxo = Utxo::new_native_currency(
                address.lock_script_hash(),
                NativeCurrencyAmount::coins(12),
            )
            .with_time_lock(release);
            let sr = Tip5::hash(&BFieldElement::new(99));
            let text = address.private_notification(
                UtxoNotificationPayload::new(utxo.clone(), sr),
                Network::Main,
            );

            let e = decode_notification(&text, &k, &st).unwrap();
            assert_eq!(e.key, key_ref);
            assert_eq!(Tip5::hash(&e.utxo), Tip5::hash(&utxo));
            assert_eq!(
                e.addition_record,
                commit(Tip5::hash(&utxo), sr, address.privacy_digest())
            );
            let v = claim_view(&st, &e);
            assert_eq!(v.release_ms, Some(release.to_millis()));
            assert_eq!(v.status, ClaimStatus::New);
            assert_eq!(register(&mut st, e.clone()), ClaimStatus::New);
            assert_eq!(register(&mut st, e.clone()), ClaimStatus::Waiting);

            // Another wallet cannot read it.
            let other = keys(8);
            assert!(decode_notification(&text, &other, &genesis_state(&other).unwrap()).is_err());
            // Nor can another network's decoder.
            assert!(decode_notification(&text, &keys_on(7, Network::Testnet(0)), &st).is_err());

            assert!(unregister(
                &mut st,
                &e.addition_record.canonical_commitment.to_hex()
            ));
        }
        assert!(st.expected.is_empty());
    }

    fn keys_on(seed: u8, network: Network) -> Keys {
        let phrase = Keys::phrase_from_entropy(&[seed; 24]).unwrap();
        Keys::from_phrase(&phrase, network).unwrap()
    }
}
