//! Fast restore through a node's UTXO index. Opt-in: the user picks it on the
//! restore screen, after being told what the server learns.
//!
//! Instead of replaying every block since genesis, the wallet:
//! 1. asks `utxoindex_blockHeightsByFlags` which blocks hold announcements
//!    for its keys (announcement flag + receiver identifier per key);
//! 2. downloads only those blocks and decrypts the matching announcements
//!    locally, exactly as a full scan would;
//! 3. asks `wallet_restoreMembershipProof` for membership proofs of the coins
//!    it found, all relative to one block (the node's tip), and checks every
//!    proof against that block's mutator set. This checks internal consistency,
//!    not consensus authenticity of the server-supplied snapshot;
//! 4. learns from the same check which coins are already spent, and asks
//!    `utxoindex_blockHeightsByAbsoluteIndexSets` where, for the history.
//!
//! What the server learns: the receiver identifiers of the wallet's keys (so
//! every payment to them) and the index sets of its coins (so later spends).
//! With the user's own node, nobody else learns anything.
//!
//! Needs a node started with `--utxo-index` and the `utxoindex` RPC module.
//! Without it the first request fails and the caller falls back to the
//! private full scan.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{Result, anyhow, ensure};
use neptune_consensus::transaction::utxo::Utxo;
use neptune_mutator_set::ms_membership_proof::MsMembershipProof;
use neptune_mutator_set::mutator_set_accumulator::MutatorSetAccumulator;
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_primitives::announcement_flag::AnnouncementFlag;
use neptune_primitives::network::Network;
use neptune_rpc_api::model::message::{
    BlockHeightsByAbsoluteIndexSetsRequest, BlockHeightsByAbsoluteIndexSetsResponse,
    BlockHeightsByFlagsRequest, BlockHeightsByFlagsResponse, RestoreMembershipProofRequest,
    RestoreMembershipProofResponse,
};
use neptune_wallet::address::SpendingKey;
use neptune_wallet::tasm_lib::prelude::{Digest, Tip5};
use neptune_wallet::twenty_first::math::b_field_element::BFieldElement;
use neptune_wallet::twenty_first::util_types::mmr::mmr_trait::Mmr;
use num_traits::Zero;
use serde::Serialize;

use crate::keys::{KeyRef, Keys};
use crate::rpc::{self, request_body, result_from_envelope};
use crate::state::{OwnedUtxo, WalletState};
use crate::sync::{self, BlockEvents, UtxoEvent};

pub const METHOD_HEIGHTS_BY_FLAGS: &str = "utxoindex_blockHeightsByFlags";
pub const METHOD_HEIGHTS_BY_INDEX_SETS: &str = "utxoindex_blockHeightsByAbsoluteIndexSets";
pub const METHOD_RESTORE_MEMBERSHIP_PROOF: &str = "wallet_restoreMembershipProof";

/// Most index sets a node answers in one `wallet_restoreMembershipProof` call
/// without `--unsafe-rpc` (neptune-rpc-api
/// `MAX_RESTRICTED_RESTORE_MEMBERSHIP_PROOF_INDEX_SETS`).
pub const MAX_INDEX_SETS_PER_CALL: usize = 256;

/// Rounds of "ask for heights, scan the new blocks": each round can reveal
/// keys beyond the look-ahead window, which the next round asks about.
pub const MAX_ROUNDS: u32 = 64;

/// Pinned node's `MAX_NUM_BLOCKS_IN_LOOKUP_LIST`. Shared envelope flags hit
/// this cap across ALL recipients; a capped result cannot establish recovery.
pub const INDEX_LOOKUP_LIMIT: usize = 10_000;

#[derive(Debug, Clone)]
struct Found {
    utxo: Utxo,
    sender_randomness: Digest,
    receiver_preimage: Digest,
    key: KeyRef,
    aocl_index: u64,
    /// The AOCL leaves the block added (inclusive).
    block_leaves: (u64, u64),
    height: u64,
    hash: String,
    timestamp_ms: u64,
    private_message: Option<String>,
    exposed_private: bool,
}

impl Found {
    fn item(&self) -> Digest {
        Tip5::hash(&self.utxo)
    }

    fn index_set(&self) -> AbsoluteIndexSet {
        AbsoluteIndexSet::compute(
            self.item(),
            self.sender_randomness,
            self.receiver_preimage,
            self.aocl_index,
        )
    }
}

#[derive(Debug, Clone)]
struct Snapshot {
    height: u64,
    hash: Digest,
    msa: MutatorSetAccumulator,
}

/// Progress, for the status line.
#[derive(Debug, Clone, Serialize)]
pub struct FastProgress {
    pub blocks_scanned: usize,
    pub coins_found: usize,
    pub coins_spent: usize,
    pub snapshot_height: Option<u64>,
}

/// One fast restore, driven step by step by the caller, which does the
/// network requests.
#[derive(Debug, Default)]
pub struct FastRestore {
    /// None for an explicit whole-seed restore; Some for sub-wallet recovery.
    profile: Option<crate::profiles::Profile>,
    /// Next unused (generation, symmetric, ec-hybrid) indices seen so far.
    counts: (u64, u64, u64),
    /// Discovery revision (known coin count) at the last flags request.
    asked: Option<usize>,
    /// Blocks scanned, with the discovery revision they were scanned with.
    scanned: BTreeMap<u64, usize>,
    /// Coins found, by AOCL leaf index.
    found: BTreeMap<u64, Found>,
    /// Proofs relative to `snapshot`, by AOCL leaf index.
    proofs: BTreeMap<u64, MsMembershipProof>,
    /// Coins already spent at the snapshot, with the spending block once known.
    spent: BTreeMap<u64, Option<u64>>,
    snapshot: Option<Snapshot>,
    /// Hash and time of the blocks where coins were spent.
    spend_blocks: BTreeMap<u64, (String, u64)>,
}

fn bump(counts: &mut (u64, u64, u64), key: KeyRef) {
    match key {
        KeyRef::Generation(i)
            if crate::profiles::profile_of(key) == crate::profiles::Profile::Standard =>
        {
            counts.0 = counts.0.max(i + 1)
        }
        KeyRef::Symmetric(_) => counts.1 = counts.1.max(crate::profiles::local_index(key) + 1),
        KeyRef::EcHybrid(i)
            if crate::keys::private_index(key).is_none()
                && crate::profiles::profile_of(key) == crate::profiles::Profile::Standard =>
        {
            counts.2 = counts.2.max(i + 1)
        }
        _ => {}
    }
}

fn event_at<'a>(
    events: &'a mut BTreeMap<u64, BlockEvents>,
    height: u64,
    hash: &str,
    timestamp_ms: u64,
) -> &'a mut BlockEvents {
    events.entry(height).or_insert_with(|| BlockEvents {
        height,
        hash: hash.to_string(),
        timestamp_ms,
        received: vec![],
        spent: vec![],
    })
}

/// Whether the commitment to `item` sits in the AOCL. Same computation as the
/// first half of `MutatorSetAccumulator::verify`; the second half (the Bloom
/// filter) is what tells a spent coin from an unspent one.
fn in_aocl(msa: &MutatorSetAccumulator, item: Digest, proof: &MsMembershipProof) -> bool {
    let count = msa.aocl.num_leafs();
    if proof.aocl_leaf_index >= count {
        return false;
    }
    let leaf = Tip5::hash_pair(
        Tip5::hash_pair(item, proof.sender_randomness),
        Tip5::hash_pair(
            proof.receiver_preimage,
            Digest::new([BFieldElement::zero(); Digest::LEN]),
        ),
    );
    proof
        .auth_path_aocl
        .verify(proof.aocl_leaf_index, leaf, &msa.aocl.peaks(), count)
}

impl FastRestore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn for_profile(profile: crate::profiles::Profile) -> Self {
        Self {
            profile: Some(profile),
            ..Self::default()
        }
    }

    fn includes(&self, key: KeyRef) -> bool {
        self.profile
            .is_none_or(|p| crate::profiles::profile_of(key) == p)
    }

    /// Keep coins already known locally, including payments without any
    /// public announcement. Their proofs are requested and verified again.
    pub fn seed_state(&mut self, state: &WalletState) {
        self.counts.0 = self.counts.0.max(state.next_generation_index);
        self.counts.1 = self.counts.1.max(state.next_symmetric_index);
        self.counts.2 = self.counts.2.max(state.next_ec_hybrid_index);
        for u in &state.utxos {
            if !self.includes(u.key) {
                continue;
            }
            let i = u.membership_proof.aocl_leaf_index;
            bump(&mut self.counts, u.key);
            self.found.entry(i).or_insert_with(|| Found {
                utxo: u.utxo.clone(),
                sender_randomness: u.sender_randomness,
                receiver_preimage: u.receiver_preimage,
                key: u.key,
                aocl_index: i,
                block_leaves: u.block_leaves.unwrap_or((i, i)),
                height: u.received_height,
                hash: String::new(),
                timestamp_ms: state.tip_timestamp_ms,
                private_message: None,
                exposed_private: false,
            });
        }
    }

    pub fn progress(&self) -> FastProgress {
        FastProgress {
            blocks_scanned: self.scanned.len(),
            coins_found: self.found.len(),
            coins_spent: self.spent.len(),
            snapshot_height: self.snapshot.as_ref().map(|s| s.height),
        }
    }

    fn scan_keys(&self, keys: &Keys) -> Vec<(KeyRef, SpendingKey)> {
        let mut all = keys.scan_keys(self.counts.0, self.counts.1, self.counts.2);
        let known = self.found.values().map(|f| f.key).collect::<Vec<_>>();
        for candidate in keys.profile_scan_keys_for(&known, self.counts.1) {
            if !all.iter().any(|(r, _)| *r == candidate.0) {
                all.push(candidate);
            }
        }
        all.retain(|(key, _)| self.includes(*key));
        all
    }

    /// The next `utxoindex_blockHeightsByFlags` request, or `None` when the
    /// last one already covered every key in the look-ahead window.
    pub fn flags_request(&mut self, keys: &Keys, id: u64) -> Result<Option<String>> {
        if self.asked == Some(self.found.len()) {
            return Ok(None);
        }
        let mut announcement_flags: Vec<AnnouncementFlag> = self
            .scan_keys(keys)
            .iter()
            .map(|(_, k)| AnnouncementFlag::from(&k.to_address()))
            .collect();
        // Query public format/version flags shared by EVERY encrypted payer.
        // No scanning key is sent to the node. Fast mode also queries normal
        // notices to encrypted receiving keys, so downgraded receipts are found;
        // these receiver-ID lookups are part of its explicit privacy tradeoff.
        if keys.network() != Network::Main
            && self
                .profile
                .is_none_or(|p| p == crate::profiles::Profile::Encrypted)
        {
            for version in 1..=3 {
                announcement_flags.push(AnnouncementFlag {
                    flag: BFieldElement::new(crate::private_notification::MARKER),
                    receiver_id: BFieldElement::new(version),
                });
            }
        }
        self.asked = Some(self.found.len());
        let params = serde_json::to_value(BlockHeightsByFlagsRequest { announcement_flags })?;
        Ok(Some(request_body(id, METHOD_HEIGHTS_BY_FLAGS, params)))
    }

    /// Heights from a flags response that still need scanning with the
    /// current keys, ascending.
    pub fn heights_to_fetch(&self, body: &str) -> Result<Vec<u64>> {
        let r: BlockHeightsByFlagsResponse = result_from_envelope(body)?;
        ensure!(
            r.block_heights.len() < INDEX_LOOKUP_LIMIT,
            "FAST_INDEX_LIMIT: node lookup may be capped; a full scan is required"
        );
        let wanted: BTreeSet<u64> = r
            .block_heights
            .into_iter()
            .map(u64::from)
            .filter(|h| *h > 0 && self.scanned.get(h) != Some(&self.found.len()))
            .collect();
        Ok(wanted.into_iter().collect())
    }

    /// Scan a `wallet_getBlocks` response for incoming coins. Returns how many
    /// new coins it found.
    pub fn scan_blocks(&mut self, keys: &Keys, body: &str) -> Result<usize> {
        let mut new = 0;
        for block in rpc::parse_blocks(body)? {
            let scan_state = sync::state_from_block(block.clone(), keys.network())?;
            let d = sync::decode(block);
            if self.scanned.get(&d.height) == Some(&self.found.len()) {
                continue;
            }
            let update = d
                .kernel
                .mutator_set_update(d.hash, keys.network())
                .map_err(|e| anyhow!("mutator set update: {e:?}"))?;
            let after = sync::msa_after(&d.kernel, d.hash)?;
            let additions = update.additions;
            let first_leaf = after
                .aocl
                .num_leafs()
                .checked_sub(additions.len() as u64)
                .ok_or_else(|| anyhow!("block {} adds more leaves than it holds", d.height))?;

            let used = self.found.len();
            let scan_keys = self.scan_keys(keys);
            let ordinary = SpendingKey::scan_announcements_for_keys(
                &d.kernel.body.transaction_kernel.announcements,
                scan_keys.iter().map(|(_, k)| k.clone()),
            );
            let mut incoming = ordinary
                .into_iter()
                .filter(|iu| iu.utxo.all_type_script_states_are_valid())
                .map(|iu| {
                    let key = Keys::find_owner(&scan_keys, iu.utxo.lock_script_hash())
                        .ok_or_else(|| anyhow!("decrypted a UTXO no scanned key can unlock"))?;
                    Ok((iu.addition_record(), (iu, key, None)))
                })
                .collect::<Result<HashMap<_, _>>>()?;
            let mut exposed = incoming
                .iter()
                .filter(|(_, (_, key, _))| {
                    crate::profiles::profile_of(*key) == crate::profiles::Profile::Encrypted
                })
                .map(|(r, _)| *r)
                .collect::<HashSet<_>>();
            for receipt in crate::private_notification::scan_receipts(
                &d.kernel.body.transaction_kernel.announcements,
                keys,
                &scan_state,
            ) {
                if !self.includes(receipt.key) {
                    continue;
                }
                let record = receipt.incoming.addition_record();
                if SpendingKey::scan_announcements_for_keys(
                    &d.kernel.body.transaction_kernel.announcements,
                    vec![keys.key(receipt.key)],
                )
                .iter()
                .any(|iu| iu.addition_record() == record)
                {
                    exposed.insert(record);
                }
                incoming.insert(
                    record,
                    (receipt.incoming, receipt.key, Some(receipt.message)),
                );
            }
            for (record, (iu, key, private_message)) in incoming {
                let Some(pos) = additions.iter().position(|a| *a == record) else {
                    continue; // announced but not an output of this block
                };
                let aocl_index = first_leaf + pos as u64;
                if self.found.contains_key(&aocl_index) {
                    continue;
                }
                bump(&mut self.counts, key);
                self.found.insert(
                    aocl_index,
                    Found {
                        utxo: iu.utxo.clone(),
                        sender_randomness: iu.sender_randomness,
                        receiver_preimage: iu.receiver_preimage,
                        key,
                        aocl_index,
                        block_leaves: (first_leaf, first_leaf + additions.len() as u64 - 1),
                        height: d.height,
                        hash: d.hash.to_hex(),
                        timestamp_ms: d.kernel.header.timestamp.to_millis(),
                        private_message,
                        exposed_private: exposed.contains(&record),
                    },
                );
                new += 1;
            }
            self.scanned.insert(d.height, used);
        }
        Ok(new)
    }

    /// Number of `wallet_restoreMembershipProof` calls needed.
    pub fn restore_chunks(&self) -> usize {
        self.found.len().div_ceil(MAX_INDEX_SETS_PER_CALL)
    }

    /// Forget proofs from an earlier attempt (the node's tip moved between
    /// chunks, so they are not relative to one block).
    pub fn reset_proofs(&mut self) {
        self.proofs.clear();
        self.spent.clear();
        self.snapshot = None;
    }

    fn chunk(&self, chunk: usize) -> Vec<&Found> {
        self.found
            .values()
            .skip(chunk * MAX_INDEX_SETS_PER_CALL)
            .take(MAX_INDEX_SETS_PER_CALL)
            .collect()
    }

    pub fn restore_request(&self, id: u64, chunk: usize) -> Result<String> {
        let absolute_index_sets: Vec<AbsoluteIndexSet> =
            self.chunk(chunk).iter().map(|f| f.index_set()).collect();
        ensure!(!absolute_index_sets.is_empty(), "no coins in chunk {chunk}");
        let params = serde_json::to_value(RestoreMembershipProofRequest {
            absolute_index_sets,
        })?;
        Ok(request_body(id, METHOD_RESTORE_MEMBERSHIP_PROOF, params))
    }

    /// Check one restore response. Errors with `TIP_MOVED` when it is relative
    /// to a different block than an earlier chunk: call `reset_proofs` and
    /// start over.
    pub fn apply_restore(&mut self, chunk: usize, body: &str) -> Result<()> {
        let r: RestoreMembershipProofResponse = result_from_envelope(body)?;
        let snap = r.snapshot;
        let height: u64 = snap.synced_height.value();
        let msa: MutatorSetAccumulator = snap.synced_mutator_set.into();
        match &self.snapshot {
            Some(s) if s.hash != snap.synced_hash => return Err(anyhow!("TIP_MOVED")),
            Some(_) => {}
            None => {
                self.snapshot = Some(Snapshot {
                    height,
                    hash: snap.synced_hash,
                    msa: msa.clone(),
                })
            }
        }
        let coins: Vec<Found> = self.chunk(chunk).into_iter().cloned().collect();
        ensure!(
            snap.membership_proofs.len() == coins.len(),
            "the server returned {} proofs for {} coins",
            snap.membership_proofs.len(),
            coins.len()
        );
        for (coin, pp) in coins.iter().zip(snap.membership_proofs) {
            let proof = pp
                .extract_ms_membership_proof(
                    coin.aocl_index,
                    coin.sender_randomness,
                    coin.receiver_preimage,
                )
                .ok_or_else(|| anyhow!("the server's proof misses coin {}", coin.aocl_index))?;
            let item = coin.item();
            if msa.verify(item, &proof) {
                self.spent.remove(&coin.aocl_index);
            } else if in_aocl(&msa, item, &proof) {
                // In the set, but its Bloom filter bits are all set: spent.
                self.spent.entry(coin.aocl_index).or_insert(None);
            } else {
                return Err(anyhow!(
                    "the server's proof for coin {} does not match its own mutator set",
                    coin.aocl_index
                ));
            }
            self.proofs.insert(coin.aocl_index, proof);
        }
        Ok(())
    }

    /// `utxoindex_blockHeightsByAbsoluteIndexSets` for the spent coins, to put
    /// their spends in the history. `None` when nothing is spent.
    pub fn spent_request(&self, id: u64) -> Result<Option<String>> {
        let absolute_index_sets: Vec<AbsoluteIndexSet> = self
            .spent
            .keys()
            .filter_map(|i| self.found.get(i))
            .map(Found::index_set)
            .collect();
        if absolute_index_sets.is_empty() {
            return Ok(None);
        }
        let params = serde_json::to_value(BlockHeightsByAbsoluteIndexSetsRequest {
            absolute_index_sets,
        })?;
        Ok(Some(request_body(id, METHOD_HEIGHTS_BY_INDEX_SETS, params)))
    }

    pub fn parse_spent_heights(&self, body: &str) -> Result<Vec<u64>> {
        let r: BlockHeightsByAbsoluteIndexSetsResponse = result_from_envelope(body)?;
        let set: BTreeSet<u64> = r.block_heights.into_iter().map(u64::from).collect();
        Ok(set.into_iter().collect())
    }

    /// Find where spent coins were spent, from the blocks the spent request
    /// pointed at: a coin is spent where its index set appears as an input.
    pub fn scan_spends(&mut self, network: Network, body: &str) -> Result<()> {
        let sets: HashMap<AbsoluteIndexSet, u64> = self
            .spent
            .keys()
            .filter_map(|i| self.found.get(i))
            .map(|f| (f.index_set(), f.aocl_index))
            .collect();
        for block in rpc::parse_blocks(body)? {
            let d = sync::decode(block);
            let update = d
                .kernel
                .mutator_set_update(d.hash, network)
                .map_err(|e| anyhow!("mutator set update: {e:?}"))?;
            for removal in &update.removals {
                if let Some(i) = sets.get(&removal.absolute_indices) {
                    self.spent.insert(*i, Some(d.height));
                    self.spend_blocks.insert(
                        d.height,
                        (d.hash.to_hex(), d.kernel.header.timestamp.to_millis()),
                    );
                }
            }
        }
        Ok(())
    }

    pub fn snapshot_height(&self) -> Option<u64> {
        self.snapshot.as_ref().map(|s| s.height)
    }

    /// The wallet state at the snapshot block, and the history to record.
    /// `block_body` is `wallet_getBlocks` for exactly the snapshot height; it
    /// must be the block the proofs are relative to. With no coins found, any
    /// recent block works and the state simply starts there.
    pub fn finish(
        &self,
        network: Network,
        block_body: &str,
    ) -> Result<(WalletState, Vec<BlockEvents>)> {
        let block = rpc::parse_blocks(block_body)?
            .pop()
            .ok_or_else(|| anyhow!("response contains no block"))?;
        let mut state = sync::state_from_block(block, network)?;
        if let Some(s) = &self.snapshot {
            ensure!(
                state.height == s.height && state.tip_hash == s.hash,
                "block {} is not the one the proofs are relative to",
                state.height
            );
            ensure!(
                state.msa.hash() == s.msa.hash(),
                "the server's mutator set does not match block {}",
                s.height
            );
        } else {
            ensure!(self.found.is_empty(), "coins found but no proofs restored");
        }

        let mut events: BTreeMap<u64, BlockEvents> = BTreeMap::new();
        let mut counts = (0, 0, 0);
        for f in self.found.values() {
            let proof = self
                .proofs
                .get(&f.aocl_index)
                .cloned()
                .ok_or_else(|| anyhow!("no proof for coin {}", f.aocl_index))?;
            bump(&mut counts, f.key);
            let spent_height = match self.spent.get(&f.aocl_index) {
                None => None,
                // Spent, block unknown (no index for it): count it spent at
                // the snapshot, which is all the balance needs.
                Some(h) => Some(h.unwrap_or(state.height)),
            };
            if !f.hash.is_empty() {
                event_at(&mut events, f.height, &f.hash, f.timestamp_ms)
                    .received
                    .push(UtxoEvent {
                        wallet_mode: crate::profiles::profile_of(f.key).name().into(),
                        aocl_index: f.aocl_index,
                        amount: f.utxo.get_native_currency_amount().to_string(),
                        is_change: f.key.is_change(),
                        tx_id: None,
                        private_message: f.private_message.clone(),
                        address_kind: if f.exposed_private {
                            Some("private-unprotected".into())
                        } else {
                            match f.key {
                                KeyRef::Generation(_) => Some("generation".into()),
                                KeyRef::EcHybrid(_) => Some("ec-hybrid".into()),
                                KeyRef::Symmetric(_) => None,
                            }
                        },
                    });
            }
            if let Some(Some(h)) = self.spent.get(&f.aocl_index) {
                let (hash, ts) = self
                    .spend_blocks
                    .get(h)
                    .cloned()
                    .unwrap_or_else(|| (String::new(), f.timestamp_ms));
                event_at(&mut events, *h, &hash, ts).spent.push(UtxoEvent {
                    wallet_mode: crate::profiles::profile_of(f.key).name().into(),
                    aocl_index: f.aocl_index,
                    amount: f.utxo.get_native_currency_amount().to_string(),
                    is_change: f.key.is_change(),
                    tx_id: None,
                    private_message: None,
                    address_kind: None,
                });
            }
            state.utxos.push(OwnedUtxo {
                utxo: f.utxo.clone(),
                sender_randomness: f.sender_randomness,
                receiver_preimage: f.receiver_preimage,
                key: f.key,
                membership_proof: proof,
                received_height: f.height,
                block_leaves: Some(f.block_leaves),
                spent_height,
                reserved_by: None,
            });
        }
        state.next_generation_index = counts.0;
        state.next_symmetric_index = counts.1;
        state.next_ec_hybrid_index = counts.2;
        Ok((state, events.into_values().collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_flags_never_include_another_subwallet_key() {
        use crate::profiles::{Profile, profile_of};
        let phrase = Keys::phrase_from_entropy(&[91; 24]).unwrap();
        let keys = Keys::from_phrase(&phrase, Network::TestnetMock).unwrap();
        for profile in [Profile::Standard, Profile::Refresh, Profile::Encrypted] {
            let mut scoped = FastRestore::for_profile(profile);
            assert!(
                scoped
                    .scan_keys(&keys)
                    .iter()
                    .all(|(key, _)| profile_of(*key) == profile)
            );
            let value: serde_json::Value =
                serde_json::from_str(&scoped.flags_request(&keys, 1).unwrap().unwrap()).unwrap();
            let params: BlockHeightsByFlagsRequest =
                serde_json::from_value(value["params"].clone()).unwrap();
            let expected = scoped
                .scan_keys(&keys)
                .iter()
                .map(|(_, key)| AnnouncementFlag::from(&key.to_address()))
                .collect::<Vec<_>>();
            for flag in params.announcement_flags {
                assert!(
                    expected
                        .iter()
                        .any(|f| f.flag == flag.flag && f.receiver_id == flag.receiver_id)
                        || (profile == Profile::Encrypted
                            && flag.flag.value() == crate::private_notification::MARKER)
                );
            }
        }
    }

    #[test]
    fn capped_index_results_require_full_scanning() {
        let response=serde_json::json!({"result":BlockHeightsByFlagsResponse{block_heights:(1..=INDEX_LOOKUP_LIMIT as u64).map(Into::into).collect()}}).to_string();
        assert!(
            FastRestore::new()
                .heights_to_fetch(&response)
                .unwrap_err()
                .to_string()
                .contains("FAST_INDEX_LIMIT")
        );
    }
}
