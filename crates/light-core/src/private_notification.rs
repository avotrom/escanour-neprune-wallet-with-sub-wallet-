//! Experimental, test-network-only notification wrapper. The wire format is
//! deliberately separate from Neptune's public receiver-identifier format.
//! This is a prototype, not an audited recipient-anonymity protocol.

use anyhow::{Result, anyhow, ensure};
use bech32::{FromBase32, ToBase32, Variant};
use crypto_box::{PublicKey, SEALBYTES, SecretKey};
use neptune_consensus::transaction::announcement::Announcement;
use neptune_primitives::network::Network;
use neptune_wallet::address::ReceivingAddress;
use neptune_wallet::incoming_utxo::IncomingUtxo;
use neptune_wallet::secret_key_material::SecretKeyMaterial;
use neptune_wallet::twenty_first::math::b_field_element::BFieldElement;
use neptune_wallet::twenty_first::math::bfield_codec::BFieldCodec;
use neptune_wallet::wallet_entropy::WalletEntropy;
use rand_core::{OsRng, RngCore};
use sha2::{Digest as _, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::claim;
use crate::keys::{AddressKind, KeyRef, Keys};
use crate::state::WalletState;

pub const KIND: &str = "private-app";
pub const ADDRESS_HRP: &str = "nescan";
// Seven ASCII bytes, below the field modulus and distinct from Neptune flags.
pub const MARKER: u64 = 0x4553434e505631;
pub const VERSION: u64 = 3;
pub const PLAINTEXT_BYTES: usize = 8192;
const LEGACY_PLAINTEXT_BYTES: usize = 4096;
pub const SEALED_BYTES: usize = PLAINTEXT_BYTES + SEALBYTES;
pub const WIRE_FIELDS: usize = 2 + SEALED_BYTES.div_ceil(7);
const CONTEXT: &[u8; 8] = b"ESCNPV03";
const PAYLOAD_START: usize = 25;
pub const MAX_MESSAGE_BYTES: usize = 512;
const MAX_ADDRESS_CHARS: usize = 8192;

pub fn ensure_supported(network: Network) -> Result<()> {
    ensure!(
        network != Network::Main,
        "private app notifications are experimental and disabled on mainnet"
    );
    Ok(())
}

/// Also randomize the output commitment when sending twice to a permanent
/// address in the same block interval with the same amount.
pub fn fresh_sender_randomness() -> Result<neptune_wallet::tasm_lib::prelude::Digest> {
    let mut bytes = Zeroizing::new(vec![0u8; 32]);
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| anyhow!("secure randomness failed: {e}"))?;
    Ok(neptune_wallet::tasm_lib::prelude::Tip5::hash(&*bytes))
}

pub(crate) fn derive_scanning_key(entropy: &WalletEntropy, network: Network) -> SecretKey {
    let mut material = SecretKeyMaterial::from(entropy.clone());
    let mut hash = Sha256::new();
    hash.update(b"escanour/private-notification/scanning-key/v1\0");
    hash.update(network.id().to_le_bytes());
    let mut encoded = material.0.encode();
    for element in &encoded {
        hash.update(element.value().to_le_bytes());
    }
    encoded.fill(BFieldElement::new(0));
    material.zeroize();
    let mut seed: [u8; 32] = hash.finalize().into();
    let secret = SecretKey::from(seed);
    seed.zeroize();
    secret
}

#[derive(Clone)]
pub struct AppAddress {
    pub receiving: ReceivingAddress,
    pub scanning_public_key: PublicKey,
    pub receiving_index: u64,
}

impl AppAddress {
    pub fn for_keys(keys: &Keys) -> Result<String> {
        Self::for_index(keys, 0)
    }

    pub fn for_index(keys: &Keys, index: u64) -> Result<String> {
        Self::for_kind_index(keys, AddressKind::EcHybrid, index)
    }
    pub fn for_kind_index(keys: &Keys, kind: AddressKind, index: u64) -> Result<String> {
        ensure_supported(keys.network())?;
        Self {
            receiving: keys.address(crate::profiles::key_for(
                crate::profiles::Profile::Encrypted,
                kind,
                index,
            )?),
            scanning_public_key: keys.notification_secret().public_key(),
            receiving_index: index,
        }
        .encode(keys.network())
    }

    pub fn encode(&self, network: Network) -> Result<String> {
        ensure_supported(network)?;
        crate::keys::private_key(self.receiving_index)?;
        ensure!(
            matches!(
                self.receiving,
                ReceivingAddress::EcHybrid(_) | ReceivingAddress::Generation(_)
            ),
            "encrypted receipts require a Generation or EC Hybrid address"
        );
        let receiving = self.receiving.to_bech32m(network)?;
        let mut data = vec![VERSION as u8];
        data.extend_from_slice(&network.id().to_le_bytes());
        data.extend_from_slice(self.scanning_public_key.as_bytes());
        data.extend_from_slice(&self.receiving_index.to_le_bytes());
        data.extend_from_slice(receiving.as_bytes());
        Ok(bech32::encode(
            ADDRESS_HRP,
            data.to_base32(),
            Variant::Bech32m,
        )?)
    }

    pub fn parse(text: &str, network: Network) -> Result<Self> {
        ensure_supported(network)?;
        ensure!(
            text.len() <= MAX_ADDRESS_CHARS,
            "private app address is too long"
        );
        let (hrp, words, variant) = bech32::decode(text.trim())?;
        ensure!(
            hrp == ADDRESS_HRP && variant == Variant::Bech32m,
            "not a private app address"
        );
        let data = Vec::<u8>::from_base32(&words)?;
        ensure!(
            data.len() > 37 && matches!(data[0], 1 | 2 | 3),
            "unsupported private app address version"
        );
        ensure!(
            data[1..5] == network.id().to_le_bytes(),
            "private app address is for another network"
        );
        let public: [u8; 32] = data[5..37].try_into()?;
        // Reject low-order points before a sender can create an unclaimable
        // payment. This is the standard X25519 all-zero shared-secret check.
        let probe = x25519_dalek::x25519([0x42; 32], public);
        ensure!(probe != [0; 32], "invalid scanning public key");
        let (receiving_index, offset) = if data[0] == 1 {
            (0, 37)
        } else {
            ensure!(data.len() > 45, "truncated private app address");
            (u64::from_le_bytes(data[37..45].try_into()?), 45)
        };
        crate::keys::private_key(receiving_index)?;
        let receiving =
            ReceivingAddress::from_bech32m(std::str::from_utf8(&data[offset..])?, network)
                .map_err(|e| anyhow!("invalid inner receiving address: {e}"))?;
        ensure!(
            matches!(receiving, ReceivingAddress::EcHybrid(_))
                || (data[0] == 3 && matches!(receiving, ReceivingAddress::Generation(_))),
            "unsupported inner receiving address"
        );
        Ok(Self {
            receiving,
            scanning_public_key: PublicKey::from(public),
            receiving_index,
        })
    }
}

/// Create the custom announcement BEFORE the primitive witness and proofs.
pub fn seal_notification(
    address: &AppAddress,
    notification: &str,
    network: Network,
) -> Result<Announcement> {
    seal_notification_with_message(address, notification, "", network)
}

pub fn seal_notification_with_message(
    address: &AppAddress,
    notification: &str,
    message: &str,
    network: Network,
) -> Result<Announcement> {
    ensure_supported(network)?;
    crate::keys::private_key(address.receiving_index)?;
    ensure!(
        message.len() <= MAX_MESSAGE_BYTES,
        "encrypted message exceeds 512 UTF-8 bytes"
    );
    ensure!(
        notification.len() + message.len() <= PLAINTEXT_BYTES - PAYLOAD_START,
        "notification is too large for encrypted envelope v3"
    );
    let mut plain = Zeroizing::new(vec![0; PLAINTEXT_BYTES]);
    plain[..8].copy_from_slice(CONTEXT);
    plain[8..12].copy_from_slice(&network.id().to_le_bytes());
    plain[12..14].copy_from_slice(&(notification.len() as u16).to_le_bytes());
    plain[14..16].copy_from_slice(&(message.len() as u16).to_le_bytes());
    plain[16..24].copy_from_slice(&address.receiving_index.to_le_bytes());
    plain[24] = match address.receiving {
        ReceivingAddress::Generation(_) => 0,
        ReceivingAddress::EcHybrid(_) => 1,
        _ => return Err(anyhow!("invalid inner address kind")),
    };
    let message_start = PAYLOAD_START + notification.len();
    plain[PAYLOAD_START..message_start].copy_from_slice(notification.as_bytes());
    plain[message_start..message_start + message.len()].copy_from_slice(message.as_bytes());
    let sealed = address
        .scanning_public_key
        .seal(&mut OsRng, &plain)
        .map_err(|_| anyhow!("private notification encryption failed"))?;
    Ok(pack(&sealed))
}

fn pack(sealed: &[u8]) -> Announcement {
    let mut message = vec![BFieldElement::new(MARKER), BFieldElement::new(VERSION)];
    for chunk in sealed.chunks(7) {
        let mut word = [0; 8];
        word[..chunk.len()].copy_from_slice(chunk);
        message.push(BFieldElement::new(u64::from_le_bytes(word)));
    }
    Announcement::new(message)
}

fn unpack(announcement: &Announcement) -> Option<Vec<u8>> {
    let m = &announcement.message;
    if m.len() < 2 || m[0].value() != MARKER || !matches!(m[1].value(), 1 | 2 | 3) {
        return None;
    }
    let sealed_bytes = if m[1].value() == 3 {
        SEALED_BYTES
    } else {
        LEGACY_PLAINTEXT_BYTES + SEALBYTES
    };
    if m.len() != 2 + sealed_bytes.div_ceil(7) {
        return None;
    }
    let mut bytes = Vec::with_capacity((WIRE_FIELDS - 2) * 7);
    for value in &m[2..] {
        let word = value.value().to_le_bytes();
        if word[7] != 0 {
            return None;
        }
        bytes.extend_from_slice(&word[..7]);
    }
    if bytes[sealed_bytes..].iter().any(|b| *b != 0) {
        return None;
    }
    bytes.truncate(sealed_bytes);
    Some(bytes)
}

pub struct OpenedNotification {
    pub notification: String,
    pub message: String,
    pub receiving_index: u64,
    pub receiving_kind: AddressKind,
}

pub fn open_notification(announcement: &Announcement, keys: &Keys) -> Option<String> {
    open_envelope(announcement, keys).map(|opened| opened.notification)
}

pub fn open_envelope(announcement: &Announcement, keys: &Keys) -> Option<OpenedNotification> {
    if ensure_supported(keys.network()).is_err() {
        return None;
    }
    let sealed = unpack(announcement)?;
    let plain = Zeroizing::new(keys.notification_secret().unseal(&sealed).ok()?);
    let legacy = announcement.message[1].value() == 1;
    let v3 = announcement.message[1].value() == 3;
    let context = if legacy {
        b"ESCNPV01"
    } else if v3 {
        CONTEXT
    } else {
        b"ESCNPV02"
    };
    let payload_start = if legacy {
        16
    } else if v3 {
        PAYLOAD_START
    } else {
        24
    };
    let plain_bytes = if v3 {
        PLAINTEXT_BYTES
    } else {
        LEGACY_PLAINTEXT_BYTES
    };
    let receiving_kind = if v3 {
        match plain.get(24)? {
            0 => AddressKind::Generation,
            1 => AddressKind::EcHybrid,
            _ => return None,
        }
    } else {
        AddressKind::EcHybrid
    };
    if plain.len() != plain_bytes
        || &plain[..8] != context
        || plain[8..12] != keys.network().id().to_le_bytes()
    {
        return None;
    }
    let len = u16::from_le_bytes(plain[12..14].try_into().ok()?) as usize;
    let message_len = u16::from_le_bytes(plain[14..16].try_into().ok()?) as usize;
    let receiving_index = if legacy {
        0
    } else {
        u64::from_le_bytes(plain[16..24].try_into().ok()?)
    };
    crate::keys::private_key(receiving_index).ok()?;
    let end = payload_start + len + message_len;
    if len == 0
        || message_len > MAX_MESSAGE_BYTES
        || end > plain_bytes
        || plain[end..].iter().any(|b| *b != 0)
    {
        return None;
    }
    Some(OpenedNotification {
        notification: std::str::from_utf8(&plain[payload_start..payload_start + len])
            .ok()?
            .to_owned(),
        message: std::str::from_utf8(&plain[payload_start + len..end])
            .ok()?
            .to_owned(),
        receiving_index,
        receiving_kind,
    })
}

/// Invalid, foreign and corrupted envelopes are skipped. A decrypted payload
/// still passes the existing ownership/type-script checks; sync then matches
/// its addition record against this block before registering any money.
pub struct PrivateReceipt {
    pub incoming: IncomingUtxo,
    pub key: KeyRef,
    pub message: String,
}

pub fn scan(
    announcements: &[Announcement],
    keys: &Keys,
    state: &WalletState,
) -> Vec<(IncomingUtxo, KeyRef)> {
    scan_receipts(announcements, keys, state)
        .into_iter()
        .map(|r| (r.incoming, r.key))
        .collect()
}

pub fn scan_receipts(
    announcements: &[Announcement],
    keys: &Keys,
    state: &WalletState,
) -> Vec<PrivateReceipt> {
    if ensure_supported(keys.network()).is_err() {
        return vec![];
    }
    announcements
        .iter()
        .filter_map(|a| {
            let opened = open_envelope(a, keys)?;
            let text = Zeroizing::new(opened.notification);
            let key = crate::profiles::key_for(
                crate::profiles::Profile::Encrypted,
                opened.receiving_kind,
                opened.receiving_index,
            )
            .ok()?;
            let expected = claim::decode_notification_for_key(&text, keys, state, key).ok()?;
            Some(PrivateReceipt {
                incoming: IncomingUtxo {
                    utxo: expected.utxo,
                    sender_randomness: expected.sender_randomness,
                    receiver_preimage: expected.receiver_preimage,
                    is_guesser_fee: false,
                },
                key: expected.key,
                message: opened.message,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::PRIVATE_KEY;
    use crate::{send, sync};
    use neptune_consensus::block::Block;
    use neptune_consensus::transaction::transaction_kernel::TransactionKernelModifier;
    use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount as Amount;
    use neptune_rpc_api::model::wallet::block::RpcWalletBlock;
    use neptune_wallet::mock_block::block_with_puts;
    use neptune_wallet::tasm_lib::prelude::{Digest, Tip5};
    use neptune_wallet::transaction_output::TxOutput;

    fn keys(seed: u8, network: Network) -> Keys {
        let phrase = Keys::phrase_from_entropy(&[seed; 24]).unwrap();
        Keys::from_phrase(&phrase, network).unwrap()
    }

    fn address(keys: &Keys) -> AppAddress {
        AppAddress::parse(&AppAddress::for_keys(keys).unwrap(), keys.network()).unwrap()
    }

    fn payment(keys: &Keys, amount: u32) -> TxOutput {
        TxOutput::offchain_native_currency(
            Amount::coins(amount.into()),
            Tip5::hash(&BFieldElement::new(amount.into())),
            keys.address(PRIVATE_KEY),
            false,
        )
    }

    fn envelope(keys: &Keys, amount: u32) -> Announcement {
        let text = payment(keys, amount)
            .offchain_notification(keys.network())
            .unwrap()
            .0;
        seal_notification(&address(keys), &text, keys.network()).unwrap()
    }

    #[tokio::test]
    async fn three_subwallets_recover_both_address_types_and_keep_change_and_spending_separate() {
        use crate::keys::AddressKind;
        use crate::profiles::{Profile, filtered, key_for, profile_of, receive_index};
        use neptune_primitives::timestamp::Timestamp;
        let net = Network::TestnetMock;
        let receiver = keys(80, net);
        let restored = keys(80, net);
        let other = keys(81, net);
        let genesis = Block::genesis(net);
        let mut state = claim::genesis_state(&receiver).unwrap();
        let mut recovered = claim::genesis_state(&restored).unwrap();
        let mut outputs = vec![];
        let mut notices = vec![];
        let mut addresses = std::collections::HashSet::new();
        for (profile, amounts) in [
            (Profile::Standard, [2, 2]),
            (Profile::Refresh, [3, 4]),
            (Profile::Encrypted, [5, 6]),
        ] {
            for (kind, amount) in [AddressKind::Generation, AddressKind::EcHybrid]
                .into_iter()
                .zip(amounts)
            {
                let key = key_for(profile, kind, 0).unwrap();
                assert_eq!(profile_of(key), profile);
                assert!(addresses.insert(receiver.address(key).to_bech32m(net).unwrap()));
                let out = if profile == Profile::Encrypted {
                    TxOutput::offchain_native_currency(
                        Amount::coins(amount),
                        Digest::default(),
                        receiver.address(key),
                        false,
                    )
                } else {
                    TxOutput::onchain_native_currency(
                        Amount::coins(amount),
                        Digest::default(),
                        receiver.address(key),
                        false,
                    )
                };
                if profile == Profile::Encrypted {
                    let text = AppAddress::for_kind_index(&receiver, kind, 0).unwrap();
                    assert_eq!(
                        text,
                        AppAddress::for_kind_index(&restored, kind, 0).unwrap()
                    );
                    let app = AppAddress::parse(&text, net).unwrap();
                    let notification = out.offchain_notification(net).unwrap().0;
                    let message = "x".repeat(512);
                    let envelope =
                        seal_notification_with_message(&app, &notification, &message, net).unwrap();
                    let opened = open_envelope(&envelope, &receiver).unwrap();
                    assert_eq!(opened.receiving_kind, kind);
                    assert_eq!(opened.message, message);
                    notices.push(envelope);
                } else {
                    notices.push(out.announcement().unwrap());
                }
                outputs.push(out);
            }
        }
        assert_eq!(addresses.len(), 6);
        let mut block = block_with_puts(
            net,
            &genesis,
            outputs.iter().map(|o| o.addition_record()).collect(),
            vec![],
        );
        attach(&mut block, notices);
        let events = apply(&mut state, &receiver, &block);
        apply(&mut recovered, &restored, &block);
        assert_eq!(events.received.len(), 6);
        for profile in [Profile::Standard, Profile::Refresh, Profile::Encrypted] {
            for kind in [AddressKind::Generation, AddressKind::EcHybrid] {
                let history = crate::profiles::address_history(&recovered, profile, kind);
                assert_eq!(history.len(), 1);
                assert_eq!(history[0].index, 0);
                assert_eq!(history[0].receipts, 1);
            }
        }
        assert_eq!(state.next_generation_index, 1);
        assert_eq!(state.next_ec_hybrid_index, 1);
        for kind in [AddressKind::Generation, AddressKind::EcHybrid] {
            assert_eq!(receive_index(&state, Profile::Standard, kind), 0);
            assert_eq!(receive_index(&state, Profile::Refresh, kind), 1);
            assert_eq!(receive_index(&state, Profile::Refresh, kind), 1);
            assert_eq!(receive_index(&state, Profile::Encrypted, kind), 0);
        }
        let now = block.kernel.header.timestamp.to_millis() + 1000;
        let balance =
            |st: &WalletState, p| filtered(st, p).balance(Timestamp::millis(now)).available;
        assert_eq!(balance(&recovered, Profile::Standard), Amount::coins(4));
        assert_eq!(balance(&recovered, Profile::Refresh), Amount::coins(7));
        assert_eq!(balance(&recovered, Profile::Encrypted), Amount::coins(11));
        let ordinary = other.address_string(AddressKind::EcHybrid, 0).unwrap();
        fn request(profile: Profile, to: &str, amount: u32, now: u64) -> send::SendRequest<'_> {
            send::SendRequest {
                profile,
                to,
                amount: Amount::coins(amount),
                fee: Amount::coins(1),
                now_ms: now,
                pinned_inputs: None,
                accept_lustration: true,
                from_kind: None,
                private_message: None,
            }
        }
        assert!(
            send::prepare_send(
                &state,
                &receiver,
                request(Profile::Standard, &ordinary, 5, now)
            )
            .is_err(),
            "another sub-wallet must not fund this payment"
        );
        assert!(
            send::prepare_send(
                &state,
                &receiver,
                request(Profile::Encrypted, &ordinary, 1, now)
            )
            .is_err(),
            "encrypted wallet must refuse ordinary recipients"
        );
        for profile in [Profile::Refresh, Profile::Encrypted] {
            let target = if profile == Profile::Encrypted {
                AppAddress::for_keys(&other).unwrap()
            } else {
                ordinary.clone()
            };
            let prepared =
                send::prepare_send(&state, &receiver, request(profile, &target, 1, now)).unwrap();
            for index in &prepared.input_aocl_indices {
                assert_eq!(
                    profile_of(
                        state
                            .utxos
                            .iter()
                            .find(|u| u.aocl_index() == *index)
                            .unwrap()
                            .key
                    ),
                    profile
                );
            }
            let change = prepared.change_key_index.unwrap();
            assert_eq!(profile_of(KeyRef::Symmetric(change)), profile);
            prepared.primitive_witness.validate().await.unwrap();
            let kernel = &prepared.primitive_witness.kernel;
            let mut next = block_with_puts(net, &block, kernel.outputs.clone(), vec![]);
            next.set_transaction_kernel(
                TransactionKernelModifier::default()
                    .inputs(kernel.inputs.clone())
                    .modify(next.kernel.body.transaction_kernel.clone()),
            );
            attach(&mut next, kernel.announcements.clone());
            next.fix_mutator_set_fields(&block);
            apply(&mut state, &receiver, &next);
            apply(&mut recovered, &restored, &next);
            block = next;
        }
        let final_now = Timestamp::millis(block.kernel.header.timestamp.to_millis() + 1000);
        for (profile, amount) in [
            (Profile::Standard, 4),
            (Profile::Refresh, 5),
            (Profile::Encrypted, 9),
        ] {
            assert_eq!(
                filtered(&recovered, profile).balance(final_now).available,
                Amount::coins(amount)
            );
        }
        for kind in [AddressKind::Generation, AddressKind::EcHybrid] {
            let history = crate::profiles::address_history(&recovered, Profile::Refresh, kind);
            assert_eq!(history.len(), 1);
            assert_eq!(history[0].index, 0);
            assert_eq!(history[0].receipts, 1);
        }
        assert!(
            recovered.next_symmetric_index < 10,
            "reserved change keys must not expand ordinary counters"
        );
    }

    #[test]
    fn older_unused_refresh_addresses_keep_receiving_after_a_later_child_is_paid() {
        use crate::keys::AddressKind;
        use crate::profiles::{Profile, address_history, key_for, receive_index};
        let net = Network::TestnetMock;
        let receiver = keys(83, net);
        let restored = keys(83, net);
        let mut state = claim::genesis_state(&receiver).unwrap();
        let mut recovered = claim::genesis_state(&restored).unwrap();
        let mut previous = Block::genesis(net);
        for child in [1, 0] {
            let outputs = [AddressKind::Generation, AddressKind::EcHybrid].map(|kind| {
                TxOutput::onchain_native_currency(
                    Amount::coins(1),
                    Digest::default(),
                    receiver.address(key_for(Profile::Refresh, kind, child).unwrap()),
                    false,
                )
            });
            let mut block = block_with_puts(
                net,
                &previous,
                outputs.iter().map(|o| o.addition_record()).collect(),
                vec![],
            );
            attach(
                &mut block,
                outputs.iter().map(|o| o.announcement().unwrap()).collect(),
            );
            assert_eq!(apply(&mut state, &receiver, &block).received.len(), 2);
            assert_eq!(apply(&mut recovered, &restored, &block).received.len(), 2);
            previous = block;
        }
        for kind in [AddressKind::Generation, AddressKind::EcHybrid] {
            assert_eq!(receive_index(&recovered, Profile::Refresh, kind), 2);
            let history = address_history(&recovered, Profile::Refresh, kind);
            assert_eq!(
                history.iter().map(|r| r.index).collect::<Vec<_>>(),
                vec![1, 0]
            );
        }
        assert_eq!(recovered.utxos.len(), 4);
    }

    #[test]
    fn address_is_seed_recoverable_network_bound_and_public_only() {
        let a = keys(21, Network::TestnetMock);
        let restored = keys(21, Network::TestnetMock);
        let text = AppAddress::for_keys(&a).unwrap();
        assert_eq!(text, AppAddress::for_keys(&restored).unwrap());
        assert_ne!(
            a.address(PRIVATE_KEY).privacy_digest(),
            a.address(KeyRef::EcHybrid(0)).privacy_digest()
        );
        assert!(a.scan_keys(0, 0, 0).len() < 100);
        assert_ne!(
            text,
            AppAddress::for_keys(&keys(22, Network::TestnetMock)).unwrap()
        );
        assert!(AppAddress::parse(&text, Network::Testnet(0)).is_err());
        assert!(AppAddress::for_keys(&keys(21, Network::Main)).is_err());
        let decoded = AppAddress::parse(&text.to_uppercase(), a.network()).unwrap();
        assert_eq!(
            decoded.scanning_public_key,
            a.notification_secret().public_key()
        );
        let mut invalid = address(&a);
        invalid.scanning_public_key = PublicKey::from([0; 32]);
        assert!(AppAddress::parse(&invalid.encode(a.network()).unwrap(), a.network()).is_err());
        let destination = send::parse_destination(&text, a.network()).unwrap();
        assert_eq!(destination.kind().unwrap(), send::RecipientKind::PrivateApp);
        assert!(send::parse_destination(&text, Network::Main).is_err());
        assert!(send::parse_destination("nescan1broken", a.network()).is_err());
        let mixed = text.replacen('n', "N", 1);
        assert!(send::parse_destination(&mixed, a.network()).is_err());
    }

    #[test]
    fn fresh_fixed_size_ciphertexts_decrypt_only_for_the_recipient() {
        let k = keys(23, Network::TestnetMock);
        let text = payment(&k, 4).offchain_notification(k.network()).unwrap().0;
        let first = seal_notification(&address(&k), &text, k.network()).unwrap();
        let second = seal_notification(&address(&k), &text, k.network()).unwrap();
        assert_eq!(first.message.len(), WIRE_FIELDS);
        assert_eq!(second.message.len(), WIRE_FIELDS);
        assert_ne!(first, second);
        assert_eq!(open_notification(&first, &k).unwrap(), text);
        assert!(open_notification(&first, &keys(24, k.network())).is_none());
        assert!(open_notification(&first, &keys(23, Network::Testnet(0))).is_none());
        let sealed = unpack(&first).unwrap();
        assert!(
            !sealed
                .windows(32)
                .any(|w| w == k.notification_secret().public_key().as_bytes())
        );
    }

    #[test]
    fn optional_utf8_message_is_authenticated_padded_and_restorable() {
        let k = keys(27, Network::TestnetMock);
        let text = payment(&k, 6).offchain_notification(k.network()).unwrap().0;
        let message = "é".repeat(256); // exactly 512 UTF-8 bytes
        let empty = seal_notification(&address(&k), &text, k.network()).unwrap();
        let with_message =
            seal_notification_with_message(&address(&k), &text, &message, k.network()).unwrap();
        assert_eq!(empty.message.len(), with_message.message.len());
        assert_eq!(with_message.message.len(), WIRE_FIELDS);
        assert!(open_envelope(&empty, &k).unwrap().message.is_empty());
        let restored_keys = keys(27, k.network());
        let opened = open_envelope(&with_message, &restored_keys).unwrap();
        assert_eq!(opened.message, message);
        assert_eq!(opened.notification, text);
        let state = claim::genesis_state(&restored_keys).unwrap();
        assert_eq!(
            scan_receipts(&[with_message.clone()], &restored_keys, &state)[0].message,
            message
        );
        let mut corrupted = with_message;
        corrupted.message[WIRE_FIELDS - 1] = BFieldElement::new(0);
        assert!(open_envelope(&corrupted, &k).is_none());
        assert!(
            seal_notification_with_message(&address(&k), &text, &"é".repeat(257), k.network())
                .is_err()
        );
    }

    /// A local debug-build sample, deliberately ignored in normal correctness
    /// tests. It measures envelope work, not browser speed or whole-chain sync.
    #[test]
    #[ignore]
    fn scanning_cost_sample() {
        use std::hint::black_box;
        use std::time::Instant;
        let recipient = keys(28, Network::TestnetMock);
        let observer = keys(29, recipient.network());
        let announced = envelope(&recipient, 1);
        let ordinary = Announcement::new(vec![BFieldElement::new(81), BFieldElement::new(42)]);
        let n = 100;
        for (label, announcement, scanner) in [
            ("ordinary-marker-skip", &ordinary, &observer),
            ("foreign-envelope-trial", &announced, &observer),
            ("own-envelope-open", &announced, &recipient),
        ] {
            let started = Instant::now();
            for _ in 0..n {
                black_box(open_envelope(black_box(announcement), scanner));
            }
            println!(
                "BENCH {label}: {n} items, {:.3} ms total, {:.3} us/item",
                started.elapsed().as_secs_f64() * 1000.,
                started.elapsed().as_secs_f64() * 1_000_000. / n as f64
            );
        }
        println!(
            "BENCH wire: {} field elements, {} field bytes, one scanning key",
            WIRE_FIELDS,
            WIRE_FIELDS * 8
        );
    }

    #[test]
    fn corrupt_foreign_and_unowned_notifications_are_skipped() {
        let k = keys(25, Network::TestnetMock);
        let st = claim::genesis_state(&k).unwrap();
        let original = envelope(&k, 8);
        assert_eq!(scan(&[original.clone()], &k, &st).len(), 1);
        for index in [0, 1, 2, 15, WIRE_FIELDS - 1] {
            let mut bad = original.clone();
            bad.message[index] = BFieldElement::new(bad.message[index].value() ^ 1);
            assert!(scan(&[bad], &k, &st).is_empty());
        }
        let mut oversized_word = original.clone();
        oversized_word.message[2] = BFieldElement::new(1 << 56);
        assert!(open_notification(&oversized_word, &k).is_none());
        let mut short = original.clone();
        short.message.pop();
        assert!(open_notification(&short, &k).is_none());
        let foreign = keys(26, k.network());
        let foreign_text = payment(&foreign, 5)
            .offchain_notification(k.network())
            .unwrap()
            .0;
        let wrapped_foreign = seal_notification(&address(&k), &foreign_text, k.network()).unwrap();
        assert!(scan(&[wrapped_foreign], &k, &st).is_empty());
        let junk =
            seal_notification(&address(&k), "not a Neptune notification", k.network()).unwrap();
        assert!(scan(&[junk], &k, &st).is_empty());
        assert!(
            seal_notification(&address(&k), &"x".repeat(PLAINTEXT_BYTES), k.network()).is_err()
        );
    }

    fn attach(block: &mut Block, announcements: Vec<Announcement>) {
        let kernel = TransactionKernelModifier::default()
            .announcements(announcements)
            .modify(block.kernel.body.transaction_kernel.clone());
        block.set_transaction_kernel(kernel);
    }

    fn apply(st: &mut WalletState, k: &Keys, block: &Block) -> sync::BlockEvents {
        match sync::apply_block(st, k, RpcWalletBlock::from(block)).unwrap() {
            sync::ApplyOutcome::Applied(events, _) => events,
            _ => panic!("mock block must extend the wallet tip"),
        }
    }

    fn prepare(st: &WalletState, k: &Keys, to: &str, amount: u32) -> send::PreparedSend {
        send::prepare_send(
            st,
            k,
            send::SendRequest {
                to,
                amount: Amount::coins(amount.into()),
                fee: Amount::coins(1),
                now_ms: st.tip_timestamp_ms + 1,
                pinned_inputs: None,
                accept_lustration: true,
                profile: st
                    .utxos
                    .iter()
                    .find(|u| u.is_unspent())
                    .map(|u| crate::profiles::profile_of(u.key))
                    .unwrap_or(crate::profiles::Profile::Standard),
                from_kind: None,
                private_message: to.starts_with("nescan").then_some("Private hello — مرحبا"),
            },
        )
        .unwrap()
    }

    /// Mock blocks deliberately have no valid PoW or block proof. This tests
    /// the real wallet paths, not live node acceptance or mining.
    #[tokio::test]
    async fn mock_chain_prepare_receive_spend_replay_and_seed_recovery() {
        let net = Network::TestnetMock;
        let sender = keys(31, net);
        let receiver = keys(32, net);
        let third = keys(33, net);
        let genesis = Block::genesis(net);
        let mut sender_st = claim::genesis_state(&sender).unwrap();
        let mut receiver_st = claim::genesis_state(&receiver).unwrap();
        let funding = TxOutput::onchain_native_currency(
            Amount::coins(20),
            Digest::default(),
            sender.address(KeyRef::EcHybrid(0)),
            false,
        );
        let mut fund_block =
            block_with_puts(net, &genesis, vec![funding.addition_record()], vec![]);
        attach(&mut fund_block, vec![funding.announcement().unwrap()]);
        apply(&mut sender_st, &sender, &fund_block);
        apply(&mut receiver_st, &receiver, &fund_block);
        let destination = AppAddress::for_keys(&receiver).unwrap();
        let prepared = prepare(&sender_st, &sender, &destination, 7);
        let second = prepare(&sender_st, &sender, &destination, 7);
        assert_ne!(
            prepared.primitive_witness.kernel.outputs[0],
            second.primitive_witness.kernel.outputs[0]
        );
        assert_eq!(
            prepared
                .primitive_witness
                .kernel
                .announcements
                .iter()
                .filter(|a| !a.looks_like_lustration())
                .count(),
            2
        ); // envelope + change, plus required lustrations
        let announcements = &prepared.primitive_witness.kernel.announcements;
        let hidden = announcements
            .iter()
            .find(|a| a.message.first().is_some_and(|v| v.value() == MARKER))
            .unwrap()
            .clone();
        let standard = neptune_wallet::address::SpendingKey::scan_announcements_for_keys(
            announcements,
            vec![receiver.key(PRIVATE_KEY)],
        );
        assert!(
            standard.is_empty(),
            "the standard receiver notification must be absent"
        );
        assert_eq!(scan(announcements, &receiver, &receiver_st).len(), 1);
        assert!(send::finish(&prepared, vec![]).is_ok());
        // The final kernel includes the envelope before proving/assembly.
        prepared.primitive_witness.validate().await.unwrap();
        let kernel = &prepared.primitive_witness.kernel;
        let mut pay_block = block_with_puts(net, &fund_block, kernel.outputs.clone(), vec![]);
        let modified = TransactionKernelModifier::default()
            .inputs(kernel.inputs.clone())
            .modify(pay_block.kernel.body.transaction_kernel.clone());
        pay_block.set_transaction_kernel(modified);
        attach(&mut pay_block, kernel.announcements.clone());
        pay_block.fix_mutator_set_fields(&fund_block);
        apply(&mut sender_st, &sender, &pay_block);
        let receipt = apply(&mut receiver_st, &receiver, &pay_block);
        assert_eq!(
            receipt.received[0].private_message.as_deref(),
            Some("Private hello — مرحبا")
        );
        assert_eq!(receiver_st.utxos.len(), 1);
        assert_eq!(receiver_st.utxos[0].amount(), Amount::coins(7));
        let restored_message = open_envelope(&hidden, &receiver).unwrap().message;
        assert_eq!(restored_message, "Private hello — مرحبا");
        let spend = prepare(
            &receiver_st,
            &receiver,
            &AppAddress::for_keys(&third).unwrap(),
            5,
        );
        assert!(send::finish(&spend, vec![]).is_ok());
        let spend_kernel = &spend.primitive_witness.kernel;
        let mut spend_block =
            block_with_puts(net, &pay_block, spend_kernel.outputs.clone(), vec![]);
        let modified = TransactionKernelModifier::default()
            .inputs(spend_kernel.inputs.clone())
            .modify(spend_block.kernel.body.transaction_kernel.clone());
        spend_block.set_transaction_kernel(modified);
        attach(&mut spend_block, spend_kernel.announcements.clone());
        spend_block.fix_mutator_set_fields(&pay_block);
        apply(&mut receiver_st, &receiver, &spend_block);
        assert!(receiver_st.utxos[0].spent_height.is_some());
        // A valid envelope replayed without its addition must create no coin.
        let before = receiver_st.utxos.len();
        let mut replay_block = block_with_puts(net, &spend_block, vec![], vec![]);
        attach(&mut replay_block, vec![hidden]);
        apply(&mut receiver_st, &receiver, &replay_block);
        assert_eq!(receiver_st.utxos.len(), before);
        let restored_keys = keys(32, net);
        let mut restored = claim::genesis_state(&restored_keys).unwrap();
        for block in [&fund_block, &pay_block, &spend_block, &replay_block] {
            let events = apply(&mut restored, &restored_keys, block);
            if events.height == receipt.height {
                assert_eq!(
                    events.received[0].private_message,
                    receipt.received[0].private_message
                );
            }
        }
        assert_eq!(
            restored.to_bytes().unwrap(),
            receiver_st.to_bytes().unwrap()
        );
    }

    #[test]
    fn standard_notice_at_private_key_is_flagged_even_with_private_envelope() {
        let net = Network::TestnetMock;
        let receiver = keys(41, net);
        let output = TxOutput::onchain_native_currency(
            Amount::coins(7),
            Digest::default(),
            receiver.address(PRIVATE_KEY),
            false,
        );
        let text = TxOutput::offchain_native_currency(
            Amount::coins(7),
            Digest::default(),
            receiver.address(PRIVATE_KEY),
            false,
        )
        .offchain_notification(net)
        .unwrap()
        .0;
        let private = seal_notification(&address(&receiver), &text, net).unwrap();
        for both in [false, true] {
            let mut st = claim::genesis_state(&receiver).unwrap();
            let mut block = block_with_puts(
                net,
                &Block::genesis(net),
                vec![output.addition_record()],
                vec![],
            );
            let mut notices = vec![output.announcement().unwrap()];
            if both {
                notices.push(private.clone());
            }
            attach(&mut block, notices);
            let events = apply(&mut st, &receiver, &block);
            assert_eq!(
                events.received.len(),
                1,
                "a duplicate notice must not double credit"
            );
            assert_eq!(
                events.received[0].address_kind.as_deref(),
                Some("private-unprotected")
            );
            assert_eq!(events.received[0].private_message.is_some(), both);
            assert_eq!(st.utxos.len(), 1);
        }
    }

    #[test]
    fn rotation_is_seed_recoverable_without_extra_envelope_scan_keys() {
        let net = Network::TestnetMock;
        let k = keys(45, net);
        // Continue reading the earlier experimental v1 address/envelope.
        let mut legacy_data = vec![1];
        legacy_data.extend_from_slice(&net.id().to_le_bytes());
        legacy_data.extend_from_slice(k.notification_secret().public_key().as_bytes());
        legacy_data.extend_from_slice(k.address(PRIVATE_KEY).to_bech32m(net).unwrap().as_bytes());
        let legacy_address =
            bech32::encode(ADDRESS_HRP, legacy_data.to_base32(), Variant::Bech32m).unwrap();
        assert_eq!(
            AppAddress::parse(&legacy_address, net)
                .unwrap()
                .receiving_index,
            0
        );
        let notification = payment(&k, 1).offchain_notification(net).unwrap().0;
        let mut legacy_plain = vec![0; LEGACY_PLAINTEXT_BYTES];
        legacy_plain[..8].copy_from_slice(b"ESCNPV01");
        legacy_plain[8..12].copy_from_slice(&net.id().to_le_bytes());
        legacy_plain[12..14].copy_from_slice(&(notification.len() as u16).to_le_bytes());
        legacy_plain[16..16 + notification.len()].copy_from_slice(notification.as_bytes());
        let mut legacy_notice = pack(
            &k.notification_secret()
                .public_key()
                .seal(&mut OsRng, &legacy_plain)
                .unwrap(),
        );
        legacy_notice.message[1] = BFieldElement::new(1);
        assert_eq!(open_notification(&legacy_notice, &k).unwrap(), notification);
        let mut v2 = vec![0; LEGACY_PLAINTEXT_BYTES];
        v2[..8].copy_from_slice(b"ESCNPV02");
        v2[8..12].copy_from_slice(&net.id().to_le_bytes());
        v2[12..14].copy_from_slice(&(notification.len() as u16).to_le_bytes());
        v2[24..24 + notification.len()].copy_from_slice(notification.as_bytes());
        let mut v2_notice = pack(
            &k.notification_secret()
                .public_key()
                .seal(&mut OsRng, &v2)
                .unwrap(),
        );
        v2_notice.message[1] = BFieldElement::new(2);
        assert_eq!(open_notification(&v2_notice, &k).unwrap(), notification);

        let mut st = claim::genesis_state(&k).unwrap();
        assert_eq!(
            st.receive_index(crate::keys::AddressKind::Generation, true),
            0
        );
        let child = 1000; // Beyond any ordinary key lookahead.
        let app_text = AppAddress::for_index(&k, child).unwrap();
        let app = AppAddress::parse(&app_text, net).unwrap();
        assert_eq!(app.receiving_index, child);
        assert_eq!(app.scanning_public_key, address(&k).scanning_public_key);
        assert_ne!(app_text, AppAddress::for_keys(&k).unwrap());
        let output = TxOutput::onchain_native_currency(
            Amount::coins(3),
            Digest::default(),
            app.receiving.clone(),
            false,
        );
        let offchain = TxOutput::offchain_native_currency(
            Amount::coins(3),
            Digest::default(),
            app.receiving.clone(),
            false,
        );
        let wrapped = seal_notification_with_message(
            &app,
            &offchain.offchain_notification(net).unwrap().0,
            "restored child",
            net,
        )
        .unwrap();
        let fresh_keys = keys(45, net);
        assert_eq!(
            scan_receipts(&[wrapped.clone()], &fresh_keys, &st)[0].key,
            crate::keys::private_key(child).unwrap()
        );
        let normal = TxOutput::onchain_native_currency(
            Amount::coins(2),
            Digest::default(),
            k.address(KeyRef::Generation(0)),
            false,
        );
        let mut block = block_with_puts(
            net,
            &Block::genesis(net),
            vec![output.addition_record(), normal.addition_record()],
            vec![],
        );
        attach(
            &mut block,
            vec![
                wrapped,
                output.announcement().unwrap(),
                normal.announcement().unwrap(),
            ],
        );
        let events = apply(&mut st, &k, &block);
        let private = events
            .received
            .iter()
            .find(|e| e.private_message.is_some())
            .unwrap();
        assert_eq!(private.address_kind.as_deref(), Some("private-unprotected"));
        assert_eq!(private.private_message.as_deref(), Some("restored child"));
        assert_eq!(st.private_receive_index(), child + 1);
        assert_eq!(st.next_ec_hybrid_index, 0);
        assert!(
            k.private_notice_keys(&st).len() < 25,
            "a high encrypted index must not expand the whole derivation range"
        );
        assert_eq!(
            st.receive_index(crate::keys::AddressKind::Generation, false),
            0
        );
        assert_eq!(
            st.receive_index(crate::keys::AddressKind::Generation, true),
            1
        );
        assert_eq!(
            st.receive_index(crate::keys::AddressKind::Generation, true),
            1,
            "reopening Receive must not create a gap"
        );
        assert_eq!(
            scan_receipts(&[envelope(&k, 4)], &fresh_keys, &st).len(),
            1,
            "old private addresses still work"
        );
    }
}
