//! Persistent wallet state: everything the wallet must remember between
//! syncs. Serialized with bincode and stored encrypted by the caller.

use anyhow::{Result, anyhow};
use neptune_consensus::block::pow::LustrationStatus;
use neptune_consensus::transaction::utxo::Utxo;
use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
use neptune_mutator_set::addition_record::AdditionRecord;
use neptune_mutator_set::commit;
use neptune_mutator_set::ms_membership_proof::MsMembershipProof;
use neptune_mutator_set::mutator_set_accumulator::MutatorSetAccumulator;
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_primitives::network::Network;
use neptune_primitives::timestamp::Timestamp;
use neptune_wallet::tasm_lib::prelude::{Digest, Tip5};
use num_traits::Zero;
use serde::{Deserialize, Serialize};

use crate::keys::{AddressKind, KeyRef};
use crate::watch::WatchAccount;

/// Bumped whenever the serialized layout changes. bincode is not
/// self-describing: a new field anywhere means a new version and a decoder
/// for the old layout below (`#[serde(default)]` does nothing in bincode).
///
/// - 1: first layout
/// - 2: `next_ec_hybrid_index`
/// - 3: `OwnedUtxo::block_leaves`, `expected`, `watch`
pub const STATE_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletState {
    pub version: u32,
    pub network: Network,
    /// Height of the last applied block.
    pub height: u64,
    /// Hash of the last applied block.
    pub tip_hash: Digest,
    /// Timestamp of the last applied block, in milliseconds.
    pub tip_timestamp_ms: u64,
    /// Mutator set accumulator *after* the last applied block, guesser fees
    /// included. Needed to build transactions.
    pub msa: MutatorSetAccumulator,
    /// Lustration status read from the last applied block header, once
    /// lustration rules are active.
    pub lustration_status: Option<LustrationStatus>,
    /// Next generation (receiving) key index never handed out.
    pub next_generation_index: u64,
    /// Next symmetric (change) key index never used.
    pub next_symmetric_index: u64,
    pub utxos: Vec<OwnedUtxo>,
    /// Next EC Hybrid (short receiving address) key index never handed out.
    pub next_ec_hybrid_index: u64,
    /// Coins registered by hand (a payment notification sent off-chain, a
    /// premine allocation) that the chain has not shown yet. Each becomes an
    /// owned coin the moment its addition record appears in a block.
    pub expected: Vec<ExpectedUtxo>,
    /// Watch-only addresses: viewing keys of other wallets.
    pub watch: Vec<WatchAccount>,
}

/// Where a registered coin came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpectedSource {
    /// A payment notification handed over off-chain (`utxo...` text).
    Notification,
    /// A genesis-block allocation (premine or redemption claim).
    Premine,
}

/// A coin the wallet knows about before (or without) seeing it announced.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedUtxo {
    pub utxo: Utxo,
    pub sender_randomness: Digest,
    pub receiver_preimage: Digest,
    pub key: KeyRef,
    pub addition_record: AdditionRecord,
    pub source: ExpectedSource,
    /// Wallet height when it was registered.
    pub registered_at: u64,
}

impl ExpectedUtxo {
    pub fn item(&self) -> Digest {
        Tip5::hash(&self.utxo)
    }
}

/// Version-2 coin layout (no `block_leaves`).
#[derive(Deserialize)]
struct OwnedUtxoV2 {
    utxo: Utxo,
    sender_randomness: Digest,
    receiver_preimage: Digest,
    key: KeyRef,
    membership_proof: MsMembershipProof,
    received_height: u64,
    spent_height: Option<u64>,
    reserved_by: Option<Reservation>,
}

impl From<OwnedUtxoV2> for OwnedUtxo {
    fn from(u: OwnedUtxoV2) -> Self {
        Self {
            utxo: u.utxo,
            sender_randomness: u.sender_randomness,
            receiver_preimage: u.receiver_preimage,
            key: u.key,
            membership_proof: u.membership_proof,
            received_height: u.received_height,
            block_leaves: None,
            spent_height: u.spent_height,
            reserved_by: u.reserved_by,
        }
    }
}

/// Version-1 layout.
#[derive(Deserialize)]
struct WalletStateV1 {
    version: u32,
    network: Network,
    height: u64,
    tip_hash: Digest,
    tip_timestamp_ms: u64,
    msa: MutatorSetAccumulator,
    lustration_status: Option<LustrationStatus>,
    next_generation_index: u64,
    next_symmetric_index: u64,
    utxos: Vec<OwnedUtxoV2>,
}

/// Version-2 layout.
#[derive(Deserialize)]
struct WalletStateV2 {
    version: u32,
    network: Network,
    height: u64,
    tip_hash: Digest,
    tip_timestamp_ms: u64,
    msa: MutatorSetAccumulator,
    lustration_status: Option<LustrationStatus>,
    next_generation_index: u64,
    next_symmetric_index: u64,
    utxos: Vec<OwnedUtxoV2>,
    next_ec_hybrid_index: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnedUtxo {
    pub utxo: Utxo,
    pub sender_randomness: Digest,
    pub receiver_preimage: Digest,
    pub key: KeyRef,
    /// Kept up to date every block while the UTXO is unspent.
    pub membership_proof: MsMembershipProof,
    pub received_height: u64,
    /// The AOCL leaves its block added (inclusive). The sender's own outputs
    /// (their change) are among them. `None` for coins found before state
    /// version 3, or registered without knowing their block.
    pub block_leaves: Option<(u64, u64)>,
    pub spent_height: Option<u64>,
    /// Set while a transaction of ours that spends this UTXO is in flight.
    pub reserved_by: Option<Reservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reservation {
    /// Hex of the transaction kernel MAST hash.
    pub tx_id: String,
    pub at_height: u64,
}

impl OwnedUtxo {
    pub fn item(&self) -> Digest {
        Tip5::hash(&self.utxo)
    }

    pub fn aocl_index(&self) -> u64 {
        self.membership_proof.aocl_leaf_index
    }

    /// The removal record's index set: what appears on-chain when this UTXO is
    /// spent. Matching it against block inputs detects spends locally.
    pub fn absolute_index_set(&self) -> AbsoluteIndexSet {
        self.membership_proof.compute_indices(self.item())
    }

    pub fn amount(&self) -> NativeCurrencyAmount {
        self.utxo.get_native_currency_amount()
    }

    pub fn is_unspent(&self) -> bool {
        self.spent_height.is_none()
    }

    pub fn is_spendable(&self, now: Timestamp) -> bool {
        self.is_unspent() && self.reserved_by.is_none() && self.utxo.can_spend_at(now)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Balance {
    /// Spendable now.
    pub available: NativeCurrencyAmount,
    /// Unspent but time-locked.
    pub timelocked: NativeCurrencyAmount,
    /// Reserved by our own in-flight transactions.
    pub pending_out: NativeCurrencyAmount,
}

impl WalletState {
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        Ok(bincode::serialize(self)?)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let version = bytes
            .get(0..4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .ok_or_else(|| anyhow!("wallet state is empty"))?;
        match version {
            STATE_VERSION => Ok(bincode::deserialize(bytes)?),
            2 => {
                let v: WalletStateV2 = bincode::deserialize(bytes)?;
                let _ = v.version;
                Ok(Self {
                    version: STATE_VERSION,
                    network: v.network,
                    height: v.height,
                    tip_hash: v.tip_hash,
                    tip_timestamp_ms: v.tip_timestamp_ms,
                    msa: v.msa,
                    lustration_status: v.lustration_status,
                    next_generation_index: v.next_generation_index,
                    next_symmetric_index: v.next_symmetric_index,
                    utxos: v.utxos.into_iter().map(OwnedUtxo::from).collect(),
                    next_ec_hybrid_index: v.next_ec_hybrid_index,
                    expected: vec![],
                    watch: vec![],
                })
            }
            1 => {
                let v: WalletStateV1 = bincode::deserialize(bytes)?;
                let _ = v.version;
                Ok(Self {
                    version: STATE_VERSION,
                    network: v.network,
                    height: v.height,
                    tip_hash: v.tip_hash,
                    tip_timestamp_ms: v.tip_timestamp_ms,
                    msa: v.msa,
                    lustration_status: v.lustration_status,
                    next_generation_index: v.next_generation_index,
                    next_symmetric_index: v.next_symmetric_index,
                    utxos: v.utxos.into_iter().map(OwnedUtxo::from).collect(),
                    next_ec_hybrid_index: 0,
                    expected: vec![],
                    watch: vec![],
                })
            }
            v => Err(anyhow!(
                "wallet state version {v} not supported (expected {STATE_VERSION})"
            )),
        }
    }

    /// The addition record of an owned coin: what its block added.
    pub fn owns_addition_record(&self, record: &AdditionRecord) -> bool {
        self.utxos
            .iter()
            .any(|u| commit(u.item(), u.sender_randomness, u.receiver_preimage.hash()) == *record)
    }

    pub fn balance(&self, now: Timestamp) -> Balance {
        let mut b = Balance::default();
        for u in self.utxos.iter().filter(|u| u.is_unspent()) {
            if u.reserved_by.is_some() {
                b.pending_out = b.pending_out + u.amount();
            } else if u.utxo.can_spend_at(now) {
                b.available = b.available + u.amount();
            } else {
                b.timelocked = b.timelocked + u.amount();
            }
        }
        b
    }

    /// Reserve inputs for an in-flight transaction.
    pub fn reserve(&mut self, aocl_indices: &[u64], tx_id: &str) {
        for u in self.utxos.iter_mut() {
            if u.is_unspent() && aocl_indices.contains(&u.aocl_index()) {
                u.reserved_by = Some(Reservation {
                    tx_id: tx_id.to_string(),
                    at_height: self.height,
                });
            }
        }
    }

    /// Release reservations older than `max_age` blocks, for transactions that
    /// never got mined. Returns how many UTXOs were released.
    pub fn release_stale_reservations(&mut self, max_age: u64) -> usize {
        let height = self.height;
        let mut released = 0;
        for u in self.utxos.iter_mut().filter(|u| u.is_unspent()) {
            if let Some(r) = &u.reserved_by {
                if height.saturating_sub(r.at_height) >= max_age {
                    u.reserved_by = None;
                    released += 1;
                }
            }
        }
        released
    }

    /// The address each coin belongs to, by index into `utxos`.
    ///
    /// Coins received on an address belong to it. Change (symmetric keys) has
    /// no address of its own: it belongs to the address that paid, found from
    /// the coins of ours spent in the same block (the larger side by amount;
    /// change spent again inherits through the chain). This needs no extra
    /// state, so it also holds right after a restore.
    pub fn origins(&self) -> Vec<AddressKind> {
        let mut order: Vec<usize> = (0..self.utxos.len()).collect();
        order.sort_by_key(|&i| (self.utxos[i].received_height, self.utxos[i].aocl_index()));
        let mut origin: Vec<Option<AddressKind>> = vec![None; self.utxos.len()];
        for &i in &order {
            let u = &self.utxos[i];
            origin[i] = Some(match u.key {
                KeyRef::Generation(_) => AddressKind::Generation,
                KeyRef::EcHybrid(_) => AddressKind::EcHybrid,
                KeyRef::Symmetric(_) => {
                    let (mut g, mut e) =
                        (NativeCurrencyAmount::zero(), NativeCurrencyAmount::zero());
                    for (j, v) in self.utxos.iter().enumerate() {
                        if j != i && v.spent_height == Some(u.received_height) {
                            match origin[j] {
                                Some(AddressKind::EcHybrid) => e = e + v.amount(),
                                Some(AddressKind::Generation) => g = g + v.amount(),
                                None => {}
                            }
                        }
                    }
                    if e > g {
                        AddressKind::EcHybrid
                    } else {
                        AddressKind::Generation
                    }
                }
            });
        }
        origin
            .into_iter()
            .map(|o| o.unwrap_or(AddressKind::Generation))
            .collect()
    }

    /// Next unused receiving key after confirmed receipts.
    pub fn take_receiving_index(&mut self) -> u64 {
        self.receive_index(AddressKind::Generation, true)
    }

    fn next_index_mut(&mut self, kind: AddressKind) -> &mut u64 {
        match kind {
            AddressKind::Generation => &mut self.next_generation_index,
            AddressKind::EcHybrid => &mut self.next_ec_hybrid_index,
        }
    }

    /// Whether any UTXO was ever received on this key.
    pub fn key_was_used(&self, key: KeyRef) -> bool {
        self.utxos.iter().any(|u| u.key == key)
    }

    /// Optional rotation advances only after a confirmed receipt. Reopening
    /// Receive never creates unused gaps; old keys remain in the scan set.
    pub fn receive_index(&mut self, kind: AddressKind, rotate: bool) -> u64 {
        if !rotate {
            return 0;
        }
        *self.next_index_mut(kind)
    }

    pub fn private_receive_index(&self) -> u64 {
        self.utxos
            .iter()
            .filter_map(|u| crate::keys::private_index(u.key))
            .max()
            .map_or(0, |i| i + 1)
    }
}

#[cfg(test)]
mod tests {
    use neptune_wallet::twenty_first::math::b_field_element::BFieldElement;

    use super::*;

    /// What version 2 wrote, field for field.
    #[derive(Serialize)]
    struct V2Coin {
        utxo: Utxo,
        sender_randomness: Digest,
        receiver_preimage: Digest,
        key: KeyRef,
        membership_proof: MsMembershipProof,
        received_height: u64,
        spent_height: Option<u64>,
        reserved_by: Option<Reservation>,
    }

    #[derive(Serialize)]
    struct V2 {
        version: u32,
        network: Network,
        height: u64,
        tip_hash: Digest,
        tip_timestamp_ms: u64,
        msa: MutatorSetAccumulator,
        lustration_status: Option<LustrationStatus>,
        next_generation_index: u64,
        next_symmetric_index: u64,
        utxos: Vec<V2Coin>,
        next_ec_hybrid_index: u64,
    }

    #[test]
    fn version_2_state_is_read_and_upgraded() {
        let d = |n: u64| Tip5::hash(&BFieldElement::new(n));
        let msa = MutatorSetAccumulator::default();
        let utxo = Utxo::new_native_currency(d(1), NativeCurrencyAmount::coins(5));
        let proof = msa.prove(Tip5::hash(&utxo), d(2), d(3));
        let old = V2 {
            version: 2,
            network: Network::Main,
            height: 42,
            tip_hash: d(4),
            tip_timestamp_ms: 7,
            msa: msa.clone(),
            lustration_status: None,
            next_generation_index: 3,
            next_symmetric_index: 4,
            utxos: vec![V2Coin {
                utxo,
                sender_randomness: d(2),
                receiver_preimage: d(3),
                key: KeyRef::EcHybrid(1),
                membership_proof: proof,
                received_height: 40,
                spent_height: None,
                reserved_by: None,
            }],
            next_ec_hybrid_index: 2,
        };
        let bytes = bincode::serialize(&old).unwrap();
        let st = WalletState::from_bytes(&bytes).unwrap();
        assert_eq!(st.version, STATE_VERSION);
        assert_eq!(
            (st.height, st.tip_hash, st.next_ec_hybrid_index),
            (42, d(4), 2)
        );
        assert_eq!(st.utxos.len(), 1);
        assert_eq!(st.utxos[0].key, KeyRef::EcHybrid(1));
        assert_eq!(st.utxos[0].received_height, 40);
        assert_eq!(st.utxos[0].block_leaves, None);
        assert!(st.expected.is_empty() && st.watch.is_empty());

        // And the new layout reads back as itself.
        let again = WalletState::from_bytes(&st.to_bytes().unwrap()).unwrap();
        assert_eq!(again.utxos[0].received_height, 40);
        assert_eq!(again.next_symmetric_index, 4);
    }
}
