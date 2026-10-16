//! Three sub-wallets share one seed and chain accumulator, never coin selection.
use crate::keys::{AddressKind, KeyRef, MAX_PRIVATE_INDEX, PRIVATE_KEY_INDEX};
use crate::state::WalletState;
use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
pub const REFRESH_KEY_INDEX: u64 = 0x4653434e524600;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Profile {
    Standard,
    Refresh,
    Encrypted,
}
impl Profile {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "standard" | "generation" => Ok(Self::Standard),
            "refresh" => Ok(Self::Refresh),
            "encrypted" => Ok(Self::Encrypted),
            _ => Err(anyhow!("unknown sub-wallet")),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Refresh => "refresh",
            Self::Encrypted => "encrypted",
        }
    }
    pub fn base(self) -> u64 {
        match self {
            Self::Standard => 0,
            Self::Refresh => REFRESH_KEY_INDEX,
            Self::Encrypted => PRIVATE_KEY_INDEX,
        }
    }
}
fn raw_index(key: KeyRef) -> u64 {
    match key {
        KeyRef::Generation(i) | KeyRef::EcHybrid(i) | KeyRef::Symmetric(i) => i,
    }
}
pub fn profile_of(key: KeyRef) -> Profile {
    let i = raw_index(key);
    if (PRIVATE_KEY_INDEX..=PRIVATE_KEY_INDEX + MAX_PRIVATE_INDEX).contains(&i) {
        Profile::Encrypted
    } else if (REFRESH_KEY_INDEX..=REFRESH_KEY_INDEX + MAX_PRIVATE_INDEX).contains(&i) {
        Profile::Refresh
    } else {
        Profile::Standard
    }
}
pub fn local_index(key: KeyRef) -> u64 {
    raw_index(key) - profile_of(key).base()
}
pub fn key_for(profile: Profile, kind: AddressKind, index: u64) -> Result<KeyRef> {
    ensure!(
        index <= MAX_PRIVATE_INDEX,
        "sub-wallet address limit reached"
    );
    Ok(kind.key_ref(profile.base() + index))
}
pub fn change_key(profile: Profile, index: u64) -> Result<KeyRef> {
    ensure!(
        index <= MAX_PRIVATE_INDEX,
        "sub-wallet change limit reached"
    );
    Ok(KeyRef::Symmetric(profile.base() + index))
}
pub fn receive_index(state: &WalletState, profile: Profile, kind: AddressKind) -> u64 {
    if profile != Profile::Refresh {
        return 0;
    }
    state
        .utxos
        .iter()
        .filter(|u| {
            profile_of(u.key) == profile
                && matches!(
                    (u.key, kind),
                    (KeyRef::Generation(_), AddressKind::Generation)
                        | (KeyRef::EcHybrid(_), AddressKind::EcHybrid)
                )
        })
        .map(|u| local_index(u.key))
        .max()
        .map_or(0, |i| i + 1)
}
pub fn filtered(state: &WalletState, profile: Profile) -> WalletState {
    let mut st = state.clone();
    st.utxos.retain(|u| profile_of(u.key) == profile);
    st.expected.retain(|u| profile_of(u.key) == profile);
    st
}

/// Preserve other sub-wallets without requesting their owned-coin proofs.
/// Their proofs are valid only at the same chain snapshot; otherwise the
/// caller must replay blocks locally instead of carrying stale proofs forward.
pub fn merge_recovered(
    old: &WalletState,
    recovered: &mut WalletState,
    profile: Profile,
) -> Result<()> {
    ensure!(old.network == recovered.network, "recovery network changed");
    let other = old
        .utxos
        .iter()
        .filter(|u| profile_of(u.key) != profile)
        .collect::<Vec<_>>();
    if !other.is_empty() {
        ensure!(
            old.height == recovered.height
                && old.tip_hash == recovered.tip_hash
                && old.msa.hash() == recovered.msa.hash(),
            "Other sub-wallet proofs need a local full scan to the new snapshot"
        );
    }
    recovered.utxos.retain(|u| profile_of(u.key) == profile);
    recovered.utxos.extend(other.into_iter().cloned());
    recovered.next_generation_index = recovered
        .next_generation_index
        .max(old.next_generation_index);
    recovered.next_symmetric_index = recovered.next_symmetric_index.max(old.next_symmetric_index);
    recovered.next_ec_hybrid_index = recovered.next_ec_hybrid_index.max(old.next_ec_hybrid_index);
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AddressHistoryEntry {
    pub index: u64,
    pub receipts: usize,
    pub first_height: u64,
    pub last_height: u64,
}
/// Reconstruct used receiving addresses from confirmed coins, including spent
/// coins. No local address-allocation file or extra backup is required.
pub fn address_history(
    state: &WalletState,
    profile: Profile,
    kind: AddressKind,
) -> Vec<AddressHistoryEntry> {
    let mut rows = std::collections::BTreeMap::<u64, AddressHistoryEntry>::new();
    for u in &state.utxos {
        if profile_of(u.key) != profile
            || !matches!(
                (u.key, kind),
                (KeyRef::Generation(_), AddressKind::Generation)
                    | (KeyRef::EcHybrid(_), AddressKind::EcHybrid)
            )
        {
            continue;
        }
        let index = local_index(u.key);
        let row = rows.entry(index).or_insert(AddressHistoryEntry {
            index,
            receipts: 0,
            first_height: u.received_height,
            last_height: u.received_height,
        });
        row.receipts += 1;
        row.first_height = row.first_height.min(u.received_height);
        row.last_height = row.last_height.max(u.received_height);
    }
    rows.into_values().rev().collect()
}
