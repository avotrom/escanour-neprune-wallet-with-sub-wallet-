// Portions adapted from neptune-core, Copyright Triton Software AG and
// contributors, Apache License 2.0. Modified by avotrom. See NOTICE.

//! Applying blocks to the wallet state, entirely locally.
//!
//! For each block the wallet:
//! 1. checks the hash chain (`prev_block_digest` must equal its tip hash);
//! 2. finds incoming UTXOs by matching each announcement's receiver
//!    identifier against its own keys, decrypting only matches;
//! 3. walks the block's mutator set update (guesser-fee outputs included),
//!    updating its own membership proofs on every addition and removal;
//! 4. marks its UTXOs spent when their index set appears among the inputs;
//! 5. checks that its rebuilt accumulator equals the one the block commits to.
//!
//! Adapted from neptune-core `WalletState::process_inputs_and_outputs_maintain_mps`.

use std::collections::HashMap;

use anyhow::{Result, anyhow, ensure};
use neptune_consensus::block::block_kernel::BlockKernel;
use neptune_consensus::block::mutator_set_update::MutatorSetUpdate;
use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
use neptune_mutator_set::addition_record::AdditionRecord;
use neptune_mutator_set::ms_membership_proof::MsMembershipProof;
use neptune_mutator_set::removal_record::RemovalRecord;
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_primitives::network::Network;
use neptune_rpc_api::model::wallet::block::RpcWalletBlock;
use neptune_wallet::address::SpendingKey;
use neptune_wallet::incoming_utxo::IncomingUtxo;
use neptune_wallet::tasm_lib::prelude::{Digest, Tip5};
use neptune_wallet::twenty_first::util_types::mmr::mmr_trait::Mmr;
use serde::{Deserialize, Serialize};

use crate::keys::{KeyRef, Keys};
use crate::state::{OwnedUtxo, STATE_VERSION, WalletState};
use crate::watch::{WatchBlock, scan_block};

/// What happened in one block, for the activity list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockEvents {
    pub height: u64,
    pub hash: String,
    /// Block timestamp, milliseconds since the epoch.
    pub timestamp_ms: u64,
    pub received: Vec<UtxoEvent>,
    pub spent: Vec<UtxoEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UtxoEvent {
    pub aocl_index: u64,
    pub wallet_mode: String,
    /// Display string, e.g. "12.5".
    pub amount: String,
    /// Received on a change (symmetric) key: our own money coming back, not a
    /// payment. Hidden from the history.
    pub is_change: bool,
    /// For spends: the id of our transaction that spent it, if it was ours.
    pub tx_id: Option<String>,
    /// For receipts: the address kind it arrived on.
    pub address_kind: Option<String>,
    /// Some (even empty) marks a private receipt; contents are untrusted text.
    pub private_message: Option<String>,
}

/// The spends of one block as an observer sees them (see [`crate::anonymity`]):
/// for each removal record, the inclusive interval of AOCL leaves it may have
/// come from, flattened as `[lo, hi, lo, hi, ...]`. `None` when they could not
/// be computed, which makes the exact anonymity count unavailable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockSpends {
    pub height: u64,
    pub ranges: Option<Vec<u64>>,
}

pub enum ApplyOutcome {
    Applied(BlockEvents, BlockSpends),
    /// The block does not extend our tip: a reorg happened, or the server
    /// sent the wrong block. The caller rolls back to an older saved state.
    Reorg {
        tip_hash: Digest,
        block_prev: Digest,
    },
}

pub(crate) struct Decoded {
    pub(crate) hash: Digest,
    pub(crate) height: u64,
    pub(crate) kernel: BlockKernel,
}

pub(crate) fn decode(block: RpcWalletBlock) -> Decoded {
    // RpcWalletBlock::hash() recomputes the real block hash from the kernel
    // MAST hash and the proof leaf, so the proof itself is never downloaded.
    let hash = block.hash();
    let kernel: BlockKernel = block.kernel.into();
    let height: u64 = kernel.header.height.into();
    Decoded {
        hash,
        height,
        kernel,
    }
}

fn lustration_of(
    kernel: &BlockKernel,
    network: Network,
    height: u64,
) -> Option<neptune_consensus::block::pow::LustrationStatus> {
    let first: u64 = ConsensusRuleSet::first_lustration_block(network).into();
    if height < first {
        return None;
    }
    kernel.header.pow.lustration_status().ok()
}

pub(crate) fn msa_after(
    kernel: &BlockKernel,
    hash: Digest,
) -> Result<neptune_mutator_set::mutator_set_accumulator::MutatorSetAccumulator> {
    let guesser = kernel
        .guesser_fee_addition_records(hash)
        .map_err(|e| anyhow!("guesser fee records: {e:?}"))?;
    Ok(kernel.body.mutator_set_accumulator_after(guesser))
}

/// Spend intervals of a block on its own, without wallet state: for filling
/// in the history behind a wallet that did not scan from block 1.
pub fn block_spends(block: RpcWalletBlock, network: Network) -> BlockSpends {
    let d = decode(block);
    let ranges = (|| -> Result<Vec<u64>> {
        let update = d
            .kernel
            .mutator_set_update(d.hash, network)
            .map_err(|e| anyhow!("mutator set update: {e:?}"))?;
        let after = msa_after(&d.kernel, d.hash)?;
        let before = after
            .aocl
            .num_leafs()
            .checked_sub(update.additions.len() as u64)
            .ok_or_else(|| anyhow!("block adds more leaves than it holds"))?;
        let r = crate::anonymity::spend_ranges(
            &update.removals,
            &d.kernel.body.transaction_kernel.announcements,
            before,
        )?;
        Ok(r.into_iter().flat_map(|(a, b)| [a, b]).collect())
    })()
    .ok();
    BlockSpends {
        height: d.height,
        ranges,
    }
}

/// Height and timestamp (milliseconds) of a block, without applying it.
/// Used to turn a date into a block height when restoring.
pub fn block_info(block: RpcWalletBlock) -> (u64, u64) {
    let d = decode(block);
    (d.height, d.kernel.header.timestamp.to_millis())
}

/// Start a wallet at a given block: no history needed. Use the current tip
/// for a brand-new wallet, or the block at the wallet's birthday when
/// restoring from a seed.
pub fn state_from_block(block: RpcWalletBlock, network: Network) -> Result<WalletState> {
    let d = decode(block);
    Ok(WalletState {
        version: STATE_VERSION,
        network,
        height: d.height,
        tip_hash: d.hash,
        tip_timestamp_ms: d.kernel.header.timestamp.to_millis(),
        msa: msa_after(&d.kernel, d.hash)?,
        lustration_status: lustration_of(&d.kernel, network, d.height),
        next_generation_index: 0,
        next_symmetric_index: 0,
        utxos: vec![],
        next_ec_hybrid_index: 0,
        expected: vec![],
        watch: vec![],
    })
}

/// Apply one block. On `Reorg` the state is left untouched.
pub fn apply_block(
    state: &mut WalletState,
    keys: &Keys,
    block: RpcWalletBlock,
) -> Result<ApplyOutcome> {
    let Decoded {
        hash,
        height,
        kernel,
    } = decode(block);

    if kernel.header.prev_block_digest != state.tip_hash {
        return Ok(ApplyOutcome::Reorg {
            tip_hash: state.tip_hash,
            block_prev: kernel.header.prev_block_digest,
        });
    }
    ensure!(
        height == state.height + 1,
        "expected block {}, got {}",
        state.height + 1,
        height
    );

    let network = state.network;
    let MutatorSetUpdate {
        additions,
        removals,
    } = kernel
        .mutator_set_update(hash, network)
        .map_err(|e| anyhow!("mutator set update: {e:?}"))?;

    // Incoming: receiver-id lookup first, decryption only on a match.
    let mut scan_keys = keys.scan_keys(
        state.next_generation_index,
        state.next_symmetric_index,
        state.next_ec_hybrid_index,
    );
    for candidate in keys.private_notice_keys(state) {
        if candidate.0 != crate::keys::PRIVATE_KEY {
            scan_keys.push(candidate);
        }
    }
    for candidate in keys.profile_scan_keys(state) {
        if !scan_keys.iter().any(|(r, _)| *r == candidate.0) {
            scan_keys.push(candidate);
        }
    }
    let spending_keys: Vec<SpendingKey> = scan_keys.iter().map(|(_, k)| k.clone()).collect();
    // Coin -> the key it belongs to (None: look it up by lock script).
    let mut incoming: HashMap<AdditionRecord, (IncomingUtxo, Option<KeyRef>)> =
        SpendingKey::scan_announcements_for_keys(
            &kernel.body.transaction_kernel.announcements,
            spending_keys,
        )
        .into_iter()
        .filter(|iu| iu.utxo.all_type_script_states_are_valid())
        .map(|iu| (iu.addition_record(), (iu, None)))
        .collect();

    // Decrypt custom envelopes locally, then use the existing addition-record
    // and membership-proof path. Decryption alone never creates a balance.
    // A sender may publish BOTH forms. A private envelope must not hide
    // the fact that the same coin also had a normal receiver-ID notice.
    let mut exposed_private: std::collections::HashSet<AdditionRecord> = if network != Network::Main
    {
        let private_locks: std::collections::HashSet<Digest> = scan_keys
            .iter()
            .filter(|(r, _)| crate::keys::private_index(*r).is_some())
            .map(|(_, k)| k.lock_script_hash())
            .collect();
        incoming
            .iter()
            .filter(|(_, (iu, _))| private_locks.contains(&iu.utxo.lock_script_hash()))
            .map(|(record, _)| *record)
            .collect()
    } else {
        Default::default()
    };
    let mut private_messages = HashMap::new();
    for receipt in crate::private_notification::scan_receipts(
        &kernel.body.transaction_kernel.announcements,
        keys,
        state,
    ) {
        let record = receipt.incoming.addition_record();
        // The encrypted index can recover a child beyond the ordinary gap.
        // Check its normal notice too before claiming the protection is valid.
        if !scan_keys.iter().any(|(r, _)| *r == receipt.key) {
            let notices = SpendingKey::scan_announcements_for_keys(
                &kernel.body.transaction_kernel.announcements,
                vec![keys.key(receipt.key)],
            );
            if notices.iter().any(|iu| iu.addition_record() == record) {
                exposed_private.insert(record);
            }
        }
        private_messages.insert(record, receipt.message);
        incoming.insert(record, (receipt.incoming, Some(receipt.key)));
    }

    // Guesser fees are never announced: the header names the guesser's
    // receiver data, and the two coins (one of them time-locked) follow from
    // the block (neptune-core's `scan_for_guesser_fee_utxos`).
    if let Some((key_ref, key)) = scan_keys
        .iter()
        .find(|(_, k)| kernel.header.was_guessed_by(&k.guesser_receiver_data()))
    {
        let utxos = kernel
            .guesser_fee_utxos()
            .map_err(|e| anyhow!("guesser fee coins: {e:?}"))?;
        for utxo in utxos {
            let iu = IncomingUtxo {
                utxo,
                sender_randomness: hash,
                receiver_preimage: key.privacy_preimage(),
                is_guesser_fee: true,
            };
            incoming.insert(iu.addition_record(), (iu, Some(*key_ref)));
        }
    }

    // Coins registered by hand (off-chain notifications, premine).
    for e in &state.expected {
        incoming.entry(e.addition_record).or_insert_with(|| {
            (
                IncomingUtxo {
                    utxo: e.utxo.clone(),
                    sender_randomness: e.sender_randomness,
                    receiver_preimage: e.receiver_preimage,
                    is_guesser_fee: false,
                },
                Some(e.key),
            )
        });
    }

    // Our unspent UTXOs, by the index set they will reveal when spent.
    let own_sets: HashMap<AbsoluteIndexSet, usize> = state
        .utxos
        .iter()
        .enumerate()
        .filter(|(_, u)| u.is_unspent())
        .map(|(i, u)| (u.absolute_index_set(), i))
        .collect();

    // Working set of membership proofs: (index into state.utxos or None for
    // new, item, proof). New UTXOs are staged in `new_utxos` in parallel.
    let mut work: Vec<(Option<usize>, Digest, MsMembershipProof)> = state
        .utxos
        .iter()
        .enumerate()
        .filter(|(_, u)| u.is_unspent())
        .map(|(i, u)| (Some(i), u.item(), u.membership_proof.clone()))
        .collect();
    let mut new_utxos: Vec<OwnedUtxo> = vec![];

    // What an observer learns from this block's spends, for exact anonymity
    // sets. Never fatal: without it only the exact count is unavailable.
    let spends = BlockSpends {
        height,
        ranges: crate::anonymity::spend_ranges(
            &removals,
            &kernel.body.transaction_kernel.announcements,
            state.msa.aocl.num_leafs(),
        )
        .ok()
        .map(|r| r.into_iter().flat_map(|(a, b)| [a, b]).collect()),
    };

    let mut msa = state.msa.clone();
    let first_leaf = msa.aocl.num_leafs();
    let block_leaves =
        (!additions.is_empty()).then(|| (first_leaf, first_leaf + additions.len() as u64 - 1));
    // Index sets of this block's spends: fixed, unlike their chunk data.
    let removals_sets: Vec<AbsoluteIndexSet> =
        removals.iter().map(|r| r.absolute_indices).collect();
    let mut removals = removals;
    removals.reverse();
    let mut removal_refs: Vec<&mut RemovalRecord> = removals.iter_mut().collect();

    let mut events = BlockEvents {
        height,
        hash: hash.to_hex(),
        timestamp_ms: kernel.header.timestamp.to_millis(),
        received: vec![],
        spent: vec![],
    };

    for addition in &additions {
        {
            let items: Vec<Digest> = work.iter().map(|w| w.1).collect();
            let mut proofs: Vec<&mut MsMembershipProof> =
                work.iter_mut().map(|w| &mut w.2).collect();
            MsMembershipProof::batch_update_from_addition(&mut proofs, &items, &msa, addition)
                .map_err(|e| anyhow!("membership proof update (addition): {e}"))?;
        }
        RemovalRecord::batch_update_from_addition(&mut removal_refs, &msa);

        if let Some((iu, known_key)) = incoming.get(addition) {
            let item = Tip5::hash(&iu.utxo);
            let proof = msa.prove(item, iu.sender_randomness, iu.receiver_preimage);
            let key = match known_key {
                Some(k) => *k,
                None => Keys::find_owner(&scan_keys, iu.utxo.lock_script_hash())
                    .ok_or_else(|| anyhow!("decrypted a UTXO no scanned key can unlock"))?,
            };
            events.received.push(UtxoEvent {
                wallet_mode: crate::profiles::profile_of(key).name().into(),
                aocl_index: proof.aocl_leaf_index,
                amount: iu.utxo.get_native_currency_amount().to_string(),
                is_change: key.is_change(),
                tx_id: None,
                private_message: private_messages.get(addition).cloned(),
                address_kind: match key {
                    _ if exposed_private.contains(addition) => Some("private-unprotected".into()),

                    KeyRef::Generation(_) => Some("generation".into()),
                    KeyRef::EcHybrid(_) => Some("ec-hybrid".into()),
                    KeyRef::Symmetric(_) => None,
                },
            });
            new_utxos.push(OwnedUtxo {
                utxo: iu.utxo.clone(),
                sender_randomness: iu.sender_randomness,
                receiver_preimage: iu.receiver_preimage,
                key,
                membership_proof: proof.clone(),
                received_height: height,
                block_leaves,
                spent_height: None,
                reserved_by: None,
            });
            work.push((None, item, proof));
        }

        msa.add(addition);
    }

    let mut spent_now: Vec<usize> = vec![];
    while let Some(removal) = removal_refs.pop() {
        {
            let mut proofs: Vec<&mut MsMembershipProof> =
                work.iter_mut().map(|w| &mut w.2).collect();
            MsMembershipProof::batch_update_from_remove(&mut proofs, removal)
                .map_err(|e| anyhow!("membership proof update (removal): {e}"))?;
        }
        RemovalRecord::batch_update_from_remove(&mut removal_refs, removal);

        if let Some(&i) = own_sets.get(&removal.absolute_indices) {
            spent_now.push(i);
        }
        msa.remove(removal);
    }

    // The accumulator we rebuilt must equal the one the block commits to.
    let expected = msa_after(&kernel, hash)?;
    ensure!(
        expected.hash() == msa.hash(),
        "rebuilt mutator set does not match block {height}; refusing the block"
    );

    // Commit: write proofs back, append new UTXOs, mark spends.
    let mut new_iter = new_utxos.into_iter();
    for (idx, _item, proof) in work {
        match idx {
            Some(i) => state.utxos[i].membership_proof = proof,
            None => {
                let mut u = new_iter.next().expect("one staged UTXO per new work entry");
                u.membership_proof = proof;
                bump_indices(state, u.key);
                state.utxos.push(u);
            }
        }
    }
    for i in spent_now {
        let u = &mut state.utxos[i];
        let tx_id = u.reserved_by.take().map(|r| r.tx_id);
        u.spent_height = Some(height);
        events.spent.push(UtxoEvent {
            wallet_mode: crate::profiles::profile_of(u.key).name().into(),
            aocl_index: u.aocl_index(),
            amount: u.amount().to_string(),
            is_change: u.key.is_change(),
            tx_id,
            address_kind: None,
            private_message: None,
        });
    }

    // Registered coins that arrived are owned now.
    if !state.expected.is_empty() {
        let added: std::collections::HashSet<AdditionRecord> = additions.iter().copied().collect();
        state
            .expected
            .retain(|e| !added.contains(&e.addition_record));
    }

    // Watch-only addresses that are caught up follow along. One that fails
    // (a key that no longer parses) is left behind, never the whole block.
    if !state.watch.is_empty() {
        let spent_sets: Vec<AbsoluteIndexSet> = removals_sets;
        let wb = WatchBlock {
            height,
            hash,
            prev: kernel.header.prev_block_digest,
            timestamp_ms: kernel.header.timestamp.to_millis(),
            announcements: &kernel.body.transaction_kernel.announcements,
            additions: &additions,
            first_leaf,
            spent_sets: &spent_sets,
        };
        for account in state
            .watch
            .iter_mut()
            .filter(|a| a.scanned_to + 1 == height)
        {
            if let Ok(key) = account.key(network) {
                let _ = scan_block(account, &key, &wb);
            }
        }
    }

    state.height = height;
    state.tip_hash = hash;
    state.tip_timestamp_ms = kernel.header.timestamp.to_millis();
    state.msa = msa;
    state.lustration_status = lustration_of(&kernel, network, height);

    Ok(ApplyOutcome::Applied(events, spends))
}

pub(crate) fn bump_indices(state: &mut WalletState, key: KeyRef) {
    match key {
        KeyRef::Generation(i)
            if crate::profiles::profile_of(key) == crate::profiles::Profile::Standard
                && i >= state.next_generation_index =>
        {
            state.next_generation_index = i + 1;
        }
        KeyRef::Symmetric(raw)
            if crate::profiles::local_index(key) >= state.next_symmetric_index =>
        {
            state.next_symmetric_index = crate::profiles::local_index(KeyRef::Symmetric(raw)) + 1;
        }
        KeyRef::EcHybrid(i)
            if crate::keys::private_index(key).is_none()
                && crate::profiles::profile_of(key) == crate::profiles::Profile::Standard
                && i >= state.next_ec_hybrid_index =>
        {
            state.next_ec_hybrid_index = i + 1;
        }
        _ => {}
    }
}

/// Result of applying a batch of blocks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchResult {
    pub height: u64,
    pub applied: usize,
    /// True when a block did not extend the tip. Blocks after it were not
    /// applied; the caller should roll back and retry.
    pub reorg: bool,
    pub events: Vec<BlockEvents>,
    /// Spend intervals of every applied block (see [`BlockSpends`]).
    pub spends: Vec<BlockSpends>,
}

/// Apply blocks in order, stopping at the first one that does not connect.
pub fn apply_blocks(
    state: &mut WalletState,
    keys: &Keys,
    blocks: Vec<RpcWalletBlock>,
) -> Result<BatchResult> {
    let mut out = BatchResult {
        height: state.height,
        applied: 0,
        reorg: false,
        events: vec![],
        spends: vec![],
    };
    for block in blocks {
        match apply_block(state, keys, block)? {
            ApplyOutcome::Applied(ev, spends) => {
                out.applied += 1;
                out.spends.push(spends);
                if !ev.received.is_empty() || !ev.spent.is_empty() {
                    out.events.push(ev);
                }
            }
            ApplyOutcome::Reorg { .. } => {
                out.reorg = true;
                break;
            }
        }
    }
    out.height = state.height;
    Ok(out)
}

/// What a watch-only catch-up pass did.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchCatchUp {
    /// Blocks scanned for at least one address.
    pub scanned: usize,
    /// Coins found.
    pub received: usize,
    /// Addresses whose scan had to start over (their blocks did not lead to
    /// the wallet's tip, e.g. after a reorg).
    pub restarted: usize,
}

/// The block range watch-only addresses still need, up to the wallet's
/// height: `(from, to)` inclusive, or `None` when all are caught up.
pub fn watch_needs(state: &WalletState) -> Option<(u64, u64)> {
    let from = state
        .watch
        .iter()
        .filter(|a| a.scanned_to < state.height)
        .map(|a| a.scanned_to + 1)
        .min()?;
    Some((from, state.height))
}

/// Scan consecutive blocks for the watch-only addresses that lag behind the
/// wallet. The wallet itself does not change. Blocks past the wallet's
/// height are ignored. Each address's blocks must chain to each other, and
/// the last one to the wallet's tip; an address whose blocks do not is reset
/// and scanned again from its first block.
pub fn watch_catch_up(
    state: &mut WalletState,
    blocks: Vec<RpcWalletBlock>,
) -> Result<WatchCatchUp> {
    let network = state.network;
    let mut out = WatchCatchUp {
        scanned: 0,
        received: 0,
        restarted: 0,
    };
    for block in blocks {
        let Decoded {
            hash,
            height,
            kernel,
        } = decode(block);
        if height > state.height {
            break;
        }
        if !state.watch.iter().any(|a| a.scanned_to + 1 == height) {
            continue;
        }
        let MutatorSetUpdate {
            additions,
            removals,
        } = kernel
            .mutator_set_update(hash, network)
            .map_err(|e| anyhow!("mutator set update: {e:?}"))?;
        let after = msa_after(&kernel, hash)?;
        let first_leaf = after
            .aocl
            .num_leafs()
            .checked_sub(additions.len() as u64)
            .ok_or_else(|| anyhow!("block {height} adds more leaves than it holds"))?;
        let spent_sets: Vec<AbsoluteIndexSet> =
            removals.iter().map(|r| r.absolute_indices).collect();
        let wb = WatchBlock {
            height,
            hash,
            prev: kernel.header.prev_block_digest,
            timestamp_ms: kernel.header.timestamp.to_millis(),
            announcements: &kernel.body.transaction_kernel.announcements,
            additions: &additions,
            first_leaf,
            spent_sets: &spent_sets,
        };
        out.scanned += 1;
        let tip_hash = state.tip_hash;
        let tip_height = state.height;
        for account in state
            .watch
            .iter_mut()
            .filter(|a| a.scanned_to + 1 == height)
        {
            let key = account.key(network)?;
            let ok = match scan_block(account, &key, &wb) {
                Ok(d) => {
                    out.received += d.received;
                    height != tip_height || hash == tip_hash
                }
                Err(_) => false,
            };
            if !ok {
                account.coins.clear();
                account.scanned_to = account.from_height - 1;
                account.cursor_hash = None;
                out.restarted += 1;
            }
        }
    }
    Ok(out)
}
