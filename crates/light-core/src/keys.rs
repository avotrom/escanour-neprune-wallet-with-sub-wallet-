//! Key derivation and lookup.
//!
//! Receiving addresses come in two kinds the user picks between:
//! - **Generation**: post-quantum (lattice KEM) encryption of the payment
//!   notification; very long address.
//! - **EC Hybrid**: short address (97 bytes raw) and small notifications; the
//!   notification's confidentiality relies on elliptic curves.
//! Spending is hash-based for both. Change always goes to fresh symmetric keys,
//! which make the smallest announcements; their bech32m form contains the
//! secret key, so it is never displayed.

use std::cell::RefCell;

use anyhow::{Context, Result, anyhow};
use neptune_primitives::network::Network;
use neptune_wallet::address::{KeyType, ReceivingAddress, SpendingKey};
use neptune_wallet::secret_key_material::SecretKeyMaterial;
use neptune_wallet::tasm_lib::prelude::Digest;
use neptune_wallet::twenty_first::math::b_field_element::BFieldElement;
use neptune_wallet::twenty_first::math::x_field_element::XFieldElement;
use neptune_wallet::wallet_entropy::WalletEntropy;
use serde::{Deserialize, Serialize};

/// How many unused keys of each kind are scanned beyond the next unused
/// index. Covers addresses handed out but not yet paid, and restores from a
/// seed on another device (the "gap limit").
pub const KEY_LOOKAHEAD: u64 = 20;
/// Reserved private derivation range, outside the ordinary address counter.
/// Never extend the normal gap scan to this value; derive children directly.
pub const PRIVATE_KEY_INDEX: u64 = 0x4553434e505631;
pub const PRIVATE_KEY: KeyRef = KeyRef::EcHybrid(PRIVATE_KEY_INDEX);
pub const MAX_PRIVATE_INDEX: u64 = u32::MAX as u64;

pub fn private_key(index: u64) -> Result<KeyRef> {
    anyhow::ensure!(
        index <= MAX_PRIVATE_INDEX,
        "private address index exhausted"
    );
    Ok(KeyRef::EcHybrid(PRIVATE_KEY_INDEX + index))
}

pub fn private_index(key: KeyRef) -> Option<u64> {
    match key {
        KeyRef::EcHybrid(i) | KeyRef::Generation(i)
            if (PRIVATE_KEY_INDEX..=PRIVATE_KEY_INDEX + MAX_PRIVATE_INDEX).contains(&i) =>
        {
            Some(i - PRIVATE_KEY_INDEX)
        }
        _ => None,
    }
}

/// Which key a UTXO belongs to. Stored instead of the key itself so that the
/// wallet state holds no secrets beyond what the seed re-derives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum KeyRef {
    Generation(u64),
    Symmetric(u64),
    EcHybrid(u64),
}

impl KeyRef {
    pub fn is_change(&self) -> bool {
        matches!(self, KeyRef::Symmetric(_))
    }
}

/// The receiving address kinds a user can choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AddressKind {
    Generation,
    EcHybrid,
}

impl AddressKind {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "generation" => Ok(Self::Generation),
            "ec-hybrid" | "echybrid" | "hybrid" => Ok(Self::EcHybrid),
            other => Err(anyhow!("unknown address kind {other}")),
        }
    }

    pub fn key_ref(self, index: u64) -> KeyRef {
        match self {
            Self::Generation => KeyRef::Generation(index),
            Self::EcHybrid => KeyRef::EcHybrid(index),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Generation => "generation",
            Self::EcHybrid => "ec-hybrid",
        }
    }
}

type ScanCache = ((u64, u64, u64), Vec<(KeyRef, SpendingKey)>);

pub struct Keys {
    entropy: WalletEntropy,
    network: Network,
    notification_secret: crypto_box::SecretKey,
    /// Generation keys are expensive to derive (lattice key generation), so
    /// the scan set is derived once per change in key counts, not per block.
    scan_cache: RefCell<Option<ScanCache>>,
    private_cache: RefCell<Option<(Vec<u64>, Vec<(KeyRef, SpendingKey)>)>>,
    profile_cache: RefCell<Option<(Vec<KeyRef>, Vec<(KeyRef, SpendingKey)>)>>,
}

impl Keys {
    /// From an 18-word BIP-39 phrase, the format neptune-core uses.
    pub fn from_phrase(phrase: &str, network: Network) -> Result<Self> {
        let words: Vec<&str> = phrase.split_whitespace().collect();
        if words.len() != 18 {
            return Err(anyhow!(
                "a Neptune seed phrase has 18 words, got {}",
                words.len()
            ));
        }
        let entropy = WalletEntropy::from_phrase(words).context("invalid seed phrase")?;
        let notification_secret =
            crate::private_notification::derive_scanning_key(&entropy, network);
        Ok(Self {
            entropy,
            network,
            notification_secret,
            scan_cache: RefCell::new(None),
            private_cache: RefCell::new(None),
            profile_cache: RefCell::new(None),
        })
    }

    /// Build a new 18-word phrase from 24 bytes of caller-supplied randomness
    /// (the extension passes `crypto.getRandomValues`).
    pub fn phrase_from_entropy(bytes: &[u8]) -> Result<String> {
        if bytes.len() != 24 {
            return Err(anyhow!("need exactly 24 random bytes, got {}", bytes.len()));
        }
        let coefficients: [BFieldElement; 3] = [
            BFieldElement::new(u64::from_le_bytes(bytes[0..8].try_into()?)),
            BFieldElement::new(u64::from_le_bytes(bytes[8..16].try_into()?)),
            BFieldElement::new(u64::from_le_bytes(bytes[16..24].try_into()?)),
        ];
        let material = SecretKeyMaterial(XFieldElement::new(coefficients));
        Ok(material.to_phrase().join(" "))
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub(crate) fn notification_secret(&self) -> &crypto_box::SecretKey {
        &self.notification_secret
    }

    pub fn entropy(&self) -> &WalletEntropy {
        &self.entropy
    }

    /// Ordinary notices to private child keys are scanned only to detect and
    /// credit downgrades. Outer-envelope trial decryption still uses one key.
    pub fn private_notice_keys(
        &self,
        state: &crate::state::WalletState,
    ) -> Vec<(KeyRef, SpendingKey)> {
        if self.network == Network::Main {
            return vec![];
        }
        let next = state.private_receive_index();
        let mut indices = state
            .utxos
            .iter()
            .filter_map(|u| private_index(u.key))
            .chain(next..=next.saturating_add(KEY_LOOKAHEAD).min(MAX_PRIVATE_INDEX))
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        indices.sort_unstable();
        indices.dedup();
        if let Some((cached, keys)) = self.private_cache.borrow().as_ref() {
            if *cached == indices {
                return keys.clone();
            }
        }
        let keys = indices
            .iter()
            .copied()
            .map(|i| {
                let r = private_key(i).unwrap();
                (r, self.key(r))
            })
            .collect::<Vec<_>>();
        *self.private_cache.borrow_mut() = Some((indices, keys.clone()));
        keys
    }

    /// Additional sub-wallet keys. Cached across blocks and rebuilt only when
    /// a confirmed receipt advances the Auto-refresh range or change counter.
    pub fn profile_scan_keys(
        &self,
        state: &crate::state::WalletState,
    ) -> Vec<(KeyRef, SpendingKey)> {
        self.profile_scan_keys_for(
            &state.utxos.iter().map(|u| u.key).collect::<Vec<_>>(),
            state.next_symmetric_index,
        )
    }

    /// Same branches for indexed recovery, before membership proofs exist.
    pub(crate) fn profile_scan_keys_for(
        &self,
        known: &[KeyRef],
        next_symmetric_index: u64,
    ) -> Vec<(KeyRef, SpendingKey)> {
        use crate::profiles::{Profile, change_key, key_for, profile_of};
        let mut refs = known
            .iter()
            .copied()
            .filter(|key| profile_of(*key) != Profile::Standard)
            .collect::<Vec<_>>();
        for kind in [AddressKind::Generation, AddressKind::EcHybrid] {
            let next = known
                .iter()
                .copied()
                .filter(|key| {
                    profile_of(*key) == Profile::Refresh
                        && matches!(
                            (key, kind),
                            (KeyRef::Generation(_), AddressKind::Generation)
                                | (KeyRef::EcHybrid(_), AddressKind::EcHybrid)
                        )
                })
                .map(crate::profiles::local_index)
                .max()
                .map_or(0, |i| i + 1);
            for i in 0..=next.saturating_add(KEY_LOOKAHEAD).min(MAX_PRIVATE_INDEX) {
                refs.push(key_for(Profile::Refresh, kind, i).unwrap());
            }
        }
        for profile in [Profile::Refresh, Profile::Encrypted] {
            if profile == Profile::Encrypted && self.network == Network::Main {
                continue;
            }
            for i in 0..next_symmetric_index
                .saturating_add(KEY_LOOKAHEAD)
                .min(MAX_PRIVATE_INDEX)
            {
                refs.push(change_key(profile, i).unwrap());
            }
        }
        if self.network != Network::Main {
            refs.push(key_for(Profile::Encrypted, AddressKind::Generation, 0).unwrap());
        }
        refs.sort_by_key(|k| match *k {
            KeyRef::Generation(i) => (0, i),
            KeyRef::EcHybrid(i) => (1, i),
            KeyRef::Symmetric(i) => (2, i),
        });
        refs.dedup();
        if let Some((cached, keys)) = self.profile_cache.borrow().as_ref() {
            if *cached == refs {
                return keys.clone();
            }
        }
        let keys = refs
            .iter()
            .copied()
            .map(|r| (r, self.key(r)))
            .collect::<Vec<_>>();
        *self.profile_cache.borrow_mut() = Some((refs, keys.clone()));
        keys
    }

    fn key_type(key_ref: KeyRef) -> (KeyType, u64) {
        match key_ref {
            KeyRef::Generation(i) => (KeyType::Generation, i),
            KeyRef::Symmetric(i) => (KeyType::Symmetric, i),
            KeyRef::EcHybrid(i) => (KeyType::EcHybrid, i),
        }
    }

    pub fn key(&self, key_ref: KeyRef) -> SpendingKey {
        let (t, i) = Self::key_type(key_ref);
        self.entropy.nth_spending_key(t, i)
    }

    pub fn address(&self, key_ref: KeyRef) -> ReceivingAddress {
        let (t, i) = Self::key_type(key_ref);
        self.entropy.nth_receiving_address(i, t)
    }

    /// bech32m string of a receiving address. Never call this for symmetric
    /// keys: their bech32m form contains the secret key.
    pub fn address_string(&self, kind: AddressKind, index: u64) -> Result<String> {
        self.address(kind.key_ref(index)).to_bech32m(self.network)
    }

    /// bech32m string of the n-th generation address.
    pub fn receiving_address_string(&self, index: u64) -> Result<String> {
        self.address_string(AddressKind::Generation, index)
    }

    /// Every key the wallet scans for, given the next unused indices.
    pub fn scan_keys(
        &self,
        next_generation: u64,
        next_symmetric: u64,
        next_ec_hybrid: u64,
    ) -> Vec<(KeyRef, SpendingKey)> {
        let counts = (next_generation, next_symmetric, next_ec_hybrid);
        if let Some((cached_counts, keys)) = self.scan_cache.borrow().as_ref() {
            if *cached_counts == counts {
                return keys.clone();
            }
        }
        let generation = (0..next_generation + KEY_LOOKAHEAD).map(KeyRef::Generation);
        let symmetric = (0..next_symmetric + KEY_LOOKAHEAD).map(KeyRef::Symmetric);
        let ec_hybrid = (0..next_ec_hybrid + KEY_LOOKAHEAD).map(KeyRef::EcHybrid);
        let keys: Vec<(KeyRef, SpendingKey)> = generation
            .chain(symmetric)
            .chain(ec_hybrid)
            .chain((self.network != Network::Main).then_some(PRIVATE_KEY))
            .map(|r| (r, self.key(r)))
            .collect();
        *self.scan_cache.borrow_mut() = Some((counts, keys.clone()));
        keys
    }

    /// Find which of the scanned keys owns a UTXO with this lock script.
    pub fn find_owner(
        scan_keys: &[(KeyRef, SpendingKey)],
        lock_script_hash: Digest,
    ) -> Option<KeyRef> {
        scan_keys
            .iter()
            .find(|(_, k)| k.lock_script_hash() == lock_script_hash)
            .map(|(r, _)| *r)
    }
}
