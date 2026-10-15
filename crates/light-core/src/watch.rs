//! Watch-only addresses: follow another wallet's address with its viewing key.
//!
//! A viewing key decrypts the payment notifications sent to one address, so
//! the wallet sees every coin that address receives, without being able to
//! spend any of them. It comes in three forms (neptune-wallet's own types):
//!
//! - `nolgavk...`: [`GenerationViewingKey`], for a post-quantum (generation)
//!   address;
//! - `nechvk...`: [`EcHybridViewingKey`], for a short (EC Hybrid) address;
//! - `nview...`: a [`ViewingAddress`], whose address is its own viewing key.
//!
//! None of them holds the address's *receiver preimage*, so on their own they
//! show what was received but not what was spent: a spend publishes the
//! coin's absolute index set, and computing it needs that preimage. With the
//! preimage added (it must hash to the address's receiver digest, which is
//! checked), spends are seen too, by matching every block's removal records,
//! exactly as the wallet does for its own coins.
//!
//! Watch accounts live in the wallet state, so a reorg rollback restores them
//! together with everything else.

use anyhow::{anyhow, ensure, Result};
use neptune_consensus::transaction::announcement::Announcement;
use neptune_consensus::transaction::utxo::Utxo;
use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
use neptune_mutator_set::addition_record::AdditionRecord;
use neptune_mutator_set::commit;
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_primitives::network::Network;
use neptune_primitives::timestamp::Timestamp;
use neptune_wallet::address::elliptic_curve_hybrid::EcHybridViewingKey;
use neptune_wallet::address::generation_address::GenerationViewingKey;
use neptune_wallet::address::viewing_address::ViewingAddress;
use neptune_wallet::address::{KeyType, ReceivingAddress};
use neptune_wallet::tasm_lib::prelude::{Digest, Tip5};
use serde::{Deserialize, Serialize};

/// Most watch-only addresses a wallet follows.
pub const MAX_WATCH: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WatchKind {
    Generation,
    EcHybrid,
    Viewing,
}

impl WatchKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Generation => "generation",
            Self::EcHybrid => "ec-hybrid",
            Self::Viewing => "viewing",
        }
    }
}

/// A parsed viewing key.
pub enum WatchKey {
    Generation(Box<GenerationViewingKey>),
    EcHybrid(Box<EcHybridViewingKey>),
    Viewing(ViewingAddress),
}

impl WatchKey {
    /// Parse any of the three forms for `network`.
    pub fn parse(text: &str, network: Network) -> Result<Self> {
        let t = text.trim().to_ascii_lowercase();
        // Longest prefixes first: "nechvk" and "nolgavk" also start like
        // ordinary addresses, which are not viewing keys.
        if t.starts_with("nolgavk") {
            GenerationViewingKey::from_bech32m(&t, network)
                .map(|k| Self::Generation(Box::new(k)))
                .map_err(|e| anyhow!("not a valid generation viewing key: {e}"))
        } else if t.starts_with("nechvk") {
            EcHybridViewingKey::from_bech32m(&t, network)
                .map(|k| Self::EcHybrid(Box::new(k)))
                .map_err(|e| anyhow!("not a valid EC Hybrid viewing key: {e}"))
        } else if t.starts_with("nview") {
            ViewingAddress::from_bech32m(&t, network)
                .map(Self::Viewing)
                .map_err(|e| anyhow!("not a valid viewing address: {e}"))
        } else if t.starts_with("nolga") || t.starts_with("nech") {
            Err(anyhow!(
                "this is a receiving address, not a viewing key: an address cannot show what it received"
            ))
        } else {
            Err(anyhow!("not a viewing key (nolgavk…, nechvk… or nview…)"))
        }
    }

    pub fn kind(&self) -> WatchKind {
        match self {
            Self::Generation(_) => WatchKind::Generation,
            Self::EcHybrid(_) => WatchKind::EcHybrid,
            Self::Viewing(_) => WatchKind::Viewing,
        }
    }

    /// The receiving address this key watches.
    pub fn address(&self) -> ReceivingAddress {
        match self {
            Self::Generation(k) => ReceivingAddress::from(k.to_address()),
            Self::EcHybrid(k) => ReceivingAddress::EcHybrid(k.to_address()),
            Self::Viewing(a) => ReceivingAddress::ViewingAddress(*a),
        }
    }

    fn decrypt(&self, ciphertext: &[neptune_wallet::twenty_first::math::b_field_element::BFieldElement]) -> Result<(Utxo, Digest)> {
        match self {
            Self::Generation(k) => k.decrypt(ciphertext),
            Self::EcHybrid(k) => k.decrypt(ciphertext),
            Self::Viewing(a) => a.decrypt(ciphertext),
        }
    }
}

/// What one watch-only address has received (and, with the preimage, spent).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchAccount {
    pub id: u64,
    pub label: String,
    pub kind: WatchKind,
    /// The viewing key as entered (lower case). Private: whoever holds it
    /// sees this address's payments.
    pub viewing_key: String,
    /// Optional: lets the wallet see spends too.
    pub receiver_preimage: Option<Digest>,
    /// First block scanned for this address.
    pub from_height: u64,
    /// Last block scanned; `from_height - 1` before the first.
    pub scanned_to: u64,
    /// Hash of block `scanned_to`, so the next block must extend it.
    pub cursor_hash: Option<Digest>,
    pub coins: Vec<WatchCoin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchCoin {
    pub utxo: Utxo,
    pub sender_randomness: Digest,
    pub aocl_index: u64,
    pub received_height: u64,
    pub received_ms: u64,
    /// Known only with the receiver preimage.
    pub spent_height: Option<u64>,
}

impl WatchCoin {
    pub fn amount(&self) -> NativeCurrencyAmount {
        self.utxo.get_native_currency_amount()
    }
}

impl WatchAccount {
    /// A new account. Checks the key, and that the preimage (if any) belongs
    /// to its address: hashing it must give the address's receiver digest.
    pub fn new(
        id: u64,
        label: &str,
        viewing_key: &str,
        receiver_preimage: Option<&str>,
        from_height: u64,
        network: Network,
    ) -> Result<Self> {
        let key = WatchKey::parse(viewing_key, network)?;
        let receiver_preimage = match receiver_preimage.map(str::trim).filter(|s| !s.is_empty()) {
            None => None,
            Some(hex) => {
                let d = Digest::try_from_hex(hex)
                    .map_err(|e| anyhow!("the spend key is not valid hex (80 characters): {e:?}"))?;
                ensure!(
                    d.hash() == key.address().privacy_digest(),
                    "this spend key does not belong to this viewing key"
                );
                Some(d)
            }
        };
        let from_height = from_height.max(1);
        Ok(Self {
            id,
            label: label.trim().chars().take(40).collect(),
            kind: key.kind(),
            viewing_key: viewing_key.trim().to_ascii_lowercase(),
            receiver_preimage,
            from_height,
            scanned_to: from_height - 1,
            cursor_hash: None,
            coins: vec![],
        })
    }

    pub fn key(&self, network: Network) -> Result<WatchKey> {
        WatchKey::parse(&self.viewing_key, network)
    }

    pub fn received(&self) -> NativeCurrencyAmount {
        self.coins
            .iter()
            .fold(NativeCurrencyAmount::default(), |a, c| a + c.amount())
    }

    /// Unspent total, or `None` without the preimage (spends are invisible).
    pub fn unspent(&self) -> Option<NativeCurrencyAmount> {
        self.receiver_preimage.map(|_| {
            self.coins
                .iter()
                .filter(|c| c.spent_height.is_none())
                .fold(NativeCurrencyAmount::default(), |a, c| a + c.amount())
        })
    }

    pub(crate) fn index_set(&self, coin: &WatchCoin) -> Option<AbsoluteIndexSet> {
        self.receiver_preimage.map(|rp| {
            AbsoluteIndexSet::compute(
                Tip5::hash(&coin.utxo),
                coin.sender_randomness,
                rp,
                coin.aocl_index,
            )
        })
    }
}

/// What a block holds that watch-only scanning needs.
pub struct WatchBlock<'a> {
    pub height: u64,
    pub hash: Digest,
    pub prev: Digest,
    pub timestamp_ms: u64,
    pub announcements: &'a [Announcement],
    /// All of the block's addition records, guesser fees included, in order.
    pub additions: &'a [AdditionRecord],
    /// AOCL size before the block.
    pub first_leaf: u64,
    pub spent_sets: &'a [AbsoluteIndexSet],
}

/// Coins found or spent in one block for one account.
#[derive(Debug, Default, Clone, Copy)]
pub struct WatchDelta {
    pub received: usize,
    pub spent: usize,
}

/// Scan `block` for `account`, which must have scanned up to the block
/// before it. Updates the account's cursor.
pub fn scan_block(account: &mut WatchAccount, key: &WatchKey, block: &WatchBlock) -> Result<WatchDelta> {
    ensure!(
        block.height == account.scanned_to + 1,
        "watch-only scan out of order: block {} after {}",
        block.height,
        account.scanned_to
    );
    if let Some(prev) = account.cursor_hash {
        ensure!(
            prev == block.prev,
            "block {} does not extend the watch-only cursor",
            block.height
        );
    }
    let delta = scan_indexed_block(account, key, block)?;
    account.scanned_to = block.height;
    account.cursor_hash = Some(block.hash);
    Ok(delta)
}

/// Scan an index-selected block. The caller pins the final cursor separately.
pub fn scan_indexed_block(account: &mut WatchAccount, key: &WatchKey, block: &WatchBlock) -> Result<WatchDelta> {
    let mut delta = WatchDelta::default();

    // Spends first: a coin is never spent in the block that creates it.
    if account.receiver_preimage.is_some() {
        let sets: Vec<(usize, AbsoluteIndexSet)> = account
            .coins
            .iter()
            .enumerate()
            .filter(|(_, c)| c.spent_height.is_none())
            .filter_map(|(i, c)| account.index_set(c).map(|s| (i, s)))
            .collect();
        for (i, set) in sets {
            if block.spent_sets.contains(&set) {
                account.coins[i].spent_height = Some(block.height);
                delta.spent += 1;
            }
        }
    }

    let address = key.address();
    let rid = address.receiver_identifier();
    let kt = KeyType::from(&address);
    let lock = address.lock_script_hash();
    let receiver_digest = address.privacy_digest();
    for a in block.announcements {
        if a.message.get(1) != Some(&rid) || a.message.len() <= 2 {
            continue;
        }
        if !matches!(KeyType::try_from(a), Ok(t) if t == kt) {
            continue;
        }
        let Ok((utxo, sender_randomness)) = key.decrypt(&a.message[2..]) else {
            continue;
        };
        if utxo.lock_script_hash() != lock || !utxo.all_type_script_states_are_valid() {
            continue;
        }
        // Only coins the block really added count, at their real position.
        let record = commit(Tip5::hash(&utxo), sender_randomness, receiver_digest);
        let Some(pos) = block.additions.iter().position(|r| *r == record) else {
            continue;
        };
        let aocl_index = block.first_leaf + pos as u64;
        if account.coins.iter().any(|c| c.aocl_index == aocl_index) {
            continue;
        }
        account.coins.push(WatchCoin {
            utxo,
            sender_randomness,
            aocl_index,
            received_height: block.height,
            received_ms: block.timestamp_ms,
            spent_height: None,
        });
        delta.received += 1;
    }

    Ok(delta)
}

/// Read-only view for the extension.
#[derive(Debug, Clone, Serialize)]
pub struct WatchView {
    pub id: u64,
    pub label: String,
    pub kind: &'static str,
    /// Start and end of the key, for display.
    pub key_short: String,
    pub sees_spends: bool,
    pub from_height: u64,
    pub scanned_to: u64,
    pub received: String,
    /// `None` without the spend key.
    pub unspent: Option<String>,
    pub coins: Vec<WatchCoinView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchCoinView {
    pub amount: String,
    pub received_height: u64,
    pub received_ms: u64,
    pub spent_height: Option<u64>,
    /// Release date (ms) of a time lock, if the coin has one.
    pub release_ms: Option<u64>,
    pub timelocked_now: bool,
}

pub fn view(account: &WatchAccount, now_ms: u64) -> WatchView {
    let k = &account.viewing_key;
    let key_short = if k.len() > 24 {
        format!("{}…{}", &k[..14], &k[k.len() - 6..])
    } else {
        k.clone()
    };
    let now = Timestamp::millis(now_ms);
    let mut coins: Vec<WatchCoinView> = account
        .coins
        .iter()
        .map(|c| WatchCoinView {
            amount: c.amount().display_lossless(),
            received_height: c.received_height,
            received_ms: c.received_ms,
            spent_height: c.spent_height,
            release_ms: c.utxo.release_date().map(|t| t.to_millis()),
            timelocked_now: !c.utxo.can_spend_at(now),
        })
        .collect();
    coins.sort_by(|a, b| b.received_height.cmp(&a.received_height));
    WatchView {
        id: account.id,
        label: account.label.clone(),
        kind: account.kind.name(),
        key_short,
        sees_spends: account.receiver_preimage.is_some(),
        from_height: account.from_height,
        scanned_to: account.scanned_to,
        received: account.received().display_lossless(),
        unspent: account.unspent().map(|a| a.display_lossless()),
        coins,
    }
}

#[cfg(test)]
mod tests {
    use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
    use neptune_wallet::twenty_first::math::b_field_element::BFieldElement;
    use neptune_wallet::utxo_notification::UtxoNotificationPayload;

    use super::*;
    use crate::keys::{KeyRef, Keys};

    fn d(n: u64) -> Digest {
        Tip5::hash(&BFieldElement::new(n))
    }

    #[test]
    fn watch_sees_receipts_and_with_the_spend_key_spends() {
        let phrase = Keys::phrase_from_entropy(&[3; 24]).unwrap();
        let keys = Keys::from_phrase(&phrase, Network::Main).unwrap();
        for key_ref in [KeyRef::Generation(0), KeyRef::EcHybrid(0)] {
            let sk = keys.key(key_ref);
            let vk = sk.to_viewing_key_bech32m(Network::Main).unwrap();
            let rp = sk.privacy_preimage();

            // A spend key from elsewhere is refused; an address is not a key.
            assert!(WatchAccount::new(1, "x", &vk, Some(d(1).to_hex().as_str()), 5, Network::Main).is_err());
            let addr_text = keys.address(key_ref).to_bech32m(Network::Main).unwrap();
            assert!(WatchKey::parse(&addr_text, Network::Main).is_err());

            let mut with = WatchAccount::new(1, "with", &vk, Some(rp.to_hex().as_str()), 5, Network::Main).unwrap();
            let mut without = WatchAccount::new(2, "without", &vk, None, 5, Network::Main).unwrap();
            let key = with.key(Network::Main).unwrap();
            assert_eq!(key.address().privacy_digest(), rp.hash());

            let address = sk.to_address();
            let utxo = Utxo::new_native_currency(address.lock_script_hash(), NativeCurrencyAmount::coins(3));
            let sr = d(7);
            let anns = vec![address.generate_announcement(UtxoNotificationPayload::new(utxo.clone(), sr))];
            let record = commit(Tip5::hash(&utxo), sr, address.privacy_digest());
            let additions = vec![AdditionRecord::new(d(2)), record];
            let b5 = WatchBlock {
                height: 5,
                hash: d(50),
                prev: d(49),
                timestamp_ms: 1,
                announcements: &anns,
                additions: &additions,
                first_leaf: 100,
                spent_sets: &[],
            };
            for acc in [&mut with, &mut without] {
                let delta = scan_block(acc, &key, &b5).unwrap();
                assert_eq!(delta.received, 1);
                assert_eq!(acc.coins[0].aocl_index, 101);
            }

            // Block 6 spends it: only the account with the spend key sees that.
            let set = AbsoluteIndexSet::compute(Tip5::hash(&utxo), sr, rp, 101);
            let spent = [set];
            let b6 = WatchBlock {
                height: 6,
                hash: d(60),
                prev: d(50),
                timestamp_ms: 2,
                announcements: &[],
                additions: &[],
                first_leaf: 102,
                spent_sets: &spent,
            };
            assert_eq!(scan_block(&mut with, &key, &b6).unwrap().spent, 1);
            assert_eq!(scan_block(&mut without, &key, &b6).unwrap().spent, 0);
            assert_eq!(with.coins[0].spent_height, Some(6));
            assert_eq!(with.unspent(), Some(NativeCurrencyAmount::default()));
            assert_eq!(without.unspent(), None);
            assert_eq!(without.received(), NativeCurrencyAmount::coins(3));

            // The index can select nonconsecutive blocks without claiming
            // that the intervening chain has already been read. Repeated
            // blocks must not double-count receipts or spends.
            let mut indexed = WatchAccount::new(3, "indexed", &vk, Some(rp.to_hex().as_str()), 5, Network::Main).unwrap();
            assert_eq!(scan_indexed_block(&mut indexed, &key, &b5).unwrap().received, 1);
            assert_eq!(scan_indexed_block(&mut indexed, &key, &b5).unwrap().received, 0);
            assert_eq!(scan_indexed_block(&mut indexed, &key, &b6).unwrap().spent, 1);
            assert_eq!(scan_indexed_block(&mut indexed, &key, &b6).unwrap().spent, 0);
            assert_eq!(indexed.scanned_to, 4);
            assert_eq!(indexed.cursor_hash, None);
            assert_eq!(indexed.unspent(), Some(NativeCurrencyAmount::default()));

            // A block that does not extend the cursor is refused.
            let b7 = WatchBlock {
                height: 7,
                hash: d(70),
                prev: d(1),
                timestamp_ms: 3,
                announcements: &[],
                additions: &[],
                first_leaf: 102,
                spent_sets: &[],
            };
            assert!(scan_block(&mut with, &key, &b7).is_err());
        }
    }
}
