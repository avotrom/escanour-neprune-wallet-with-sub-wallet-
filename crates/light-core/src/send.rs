//! Building a transaction: coin selection, outputs, primitive witness, and
//! (after proving) the broadcastable transaction.
//!
//! The primitive witness contains spending secrets. It never leaves the
//! device: neptune-rpc-api refuses to serialize a witness-backed transaction
//! (`RpcTransactionProof::try_from` errors on `TransactionProof::Witness`).

use anyhow::{Result, anyhow, ensure};
use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
use neptune_consensus::transaction::announcement::Announcement;
use neptune_consensus::transaction::primitive_witness::PrimitiveWitness;
use neptune_consensus::transaction::transparent_input::TransparentInput;
use neptune_consensus::transaction::validity::proof_collection::ProofCollection;
use neptune_consensus::transaction::{Transaction, TransactionProof};
use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
use neptune_primitives::block_height::BlockHeight;
use neptune_primitives::mast_hash::MastHash;
use neptune_primitives::timestamp::Timestamp;
use neptune_rpc_api::model::wallet::transaction::RpcTransaction;
use neptune_wallet::address::ReceivingAddress;
use neptune_wallet::transaction_details::TransactionDetails;
use neptune_wallet::transaction_output::TxOutput;
use neptune_wallet::triton_vm::proof::Proof as VmProof;
use neptune_wallet::unlocked_utxo::UnlockedUtxo;
use num_traits::{CheckedSub, Zero};
use serde::{Deserialize, Serialize};

use crate::jobs::{self, ProofJob};
use crate::keys::{AddressKind, KeyRef, Keys};
use crate::private_notification::{self, AppAddress};
use crate::state::WalletState;

/// Everything needed to finish a send after proving. Contains secrets
/// (the primitive witness): store it encrypted, delete it when done.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedSend {
    pub primitive_witness: PrimitiveWitness,
    pub claim_version: u32,
    /// AOCL indices of the inputs, to reserve them once broadcast.
    pub input_aocl_indices: Vec<u64>,
    pub built_at_height: u64,
    pub to: String,
    pub amount: String,
    pub fee: String,
    pub change: String,
    /// Symmetric key index used for change, if any.
    pub change_key_index: Option<u64>,
    pub lustrates: bool,
    /// Networks such as testnet-mock accept mock proofs; no proving needed.
    pub mock: bool,
    /// Network the transaction was built for (for the self-check's rule set).
    pub network: neptune_primitives::network::Network,
}

impl PreparedSend {
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        Ok(bincode::serialize(self)?)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(bincode::deserialize(bytes)?)
    }

    pub fn tx_id(&self) -> String {
        self.primitive_witness.kernel.mast_hash().to_hex()
    }

    pub fn jobs(&self) -> Vec<ProofJob> {
        if self.mock {
            return vec![];
        }
        jobs::proof_collection_jobs(&self.primitive_witness, self.claim_version)
    }
}

pub struct SendRequest<'a> {
    pub profile: crate::profiles::Profile,
    pub to: &'a str,
    pub amount: NativeCurrencyAmount,
    pub fee: NativeCurrencyAmount,
    /// Wall-clock time in milliseconds (from the browser; wasm has no clock).
    pub now_ms: u64,
    /// Keep the same inputs when rebuilding after a stale-tip rejection.
    pub pinned_inputs: Option<Vec<u64>>,
    /// Inputs older than the lustration threshold reveal their value. The
    /// caller must have asked the user before setting this.
    pub accept_lustration: bool,
    /// Spend only coins received on this kind of address; `None`: any coin.
    pub from_kind: Option<AddressKind>,
    /// Optional recipient message, only inside a private app envelope.
    pub private_message: Option<&'a str>,
}

/// Whether a coin may be spent under a "pay from" choice.
/// `origin` is the coin's address from `WalletState::origins` (change counts
/// for the address that paid), so "pay from" matches the per-address balances.
fn from_matches(origin: AddressKind, from: Option<AddressKind>) -> bool {
    from.map_or(true, |f| f == origin)
}

/// Which kind of address a recipient string is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientKind {
    /// Post-quantum (lattice) address: "nolga…".
    Generation,
    /// Short (elliptic-curve hybrid) address: "nech…".
    EcHybrid,
    /// Experimental app wrapper; only compatible wallets can discover it.
    PrivateApp,
}

impl RecipientKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Generation => "generation",
            Self::EcHybrid => "ec-hybrid",
            Self::PrivateApp => private_notification::KIND,
        }
    }
}

/// An app address carries its notification policy. Never fall back to a
/// standard public notification when parsing or encryption fails.
pub enum Destination {
    Standard(ReceivingAddress),
    Private(AppAddress),
}

impl Destination {
    pub fn receiving(&self) -> ReceivingAddress {
        match self {
            Self::Standard(a) => a.clone(),
            Self::Private(a) => a.receiving.clone(),
        }
    }

    pub fn kind(&self) -> Result<RecipientKind> {
        match self {
            Self::Standard(a) => recipient_kind(a),
            Self::Private(_) => Ok(RecipientKind::PrivateApp),
        }
    }
}

pub fn parse_destination(
    to: &str,
    network: neptune_primitives::network::Network,
) -> Result<Destination> {
    // Preserve case so the bech32 decoder rejects mixed-case app addresses.
    let to = to.trim();
    if to
        .to_ascii_lowercase()
        .starts_with(private_notification::ADDRESS_HRP)
    {
        Ok(Destination::Private(AppAddress::parse(to, network)?))
    } else {
        Ok(Destination::Standard(parse_recipient(to, network)?))
    }
}

/// Parse a recipient. Only the two public address kinds are accepted:
/// a symmetric key or a viewing address is a secret and must never be used as
/// a payment destination here.
pub fn parse_recipient(
    to: &str,
    network: neptune_primitives::network::Network,
) -> Result<ReceivingAddress> {
    let to = to.trim().to_lowercase();
    let address = ReceivingAddress::from_bech32m(&to, network)
        .map_err(|e| anyhow!("not a Neptune address for {network}: {e}"))?;
    recipient_kind(&address)?;
    Ok(address)
}

pub fn recipient_kind(address: &ReceivingAddress) -> Result<RecipientKind> {
    match address {
        ReceivingAddress::Generation(_) => Ok(RecipientKind::Generation),
        ReceivingAddress::EcHybrid(_) => Ok(RecipientKind::EcHybrid),
        _ => Err(anyhow!(
            "this is a private key or viewing key, not a payment address; never share it"
        )),
    }
}

pub fn parse_amount(s: &str) -> Result<NativeCurrencyAmount> {
    NativeCurrencyAmount::coins_from_str(s.trim())
}

/// Most inputs per transaction. Each input adds proving work, so fewer
/// inputs keep proving within browser memory.
pub const MAX_INPUTS: usize = 4;

/// The most that can be sent in one transaction right now: the largest
/// `MAX_INPUTS` spendable coins, minus the fee. Zero if that is not positive.
pub fn max_sendable(
    state: &WalletState,
    fee: NativeCurrencyAmount,
    now_ms: u64,
    from_kind: Option<AddressKind>,
) -> NativeCurrencyAmount {
    let now = Timestamp::millis(now_ms);
    let origins = state.origins();
    let mut amounts: Vec<NativeCurrencyAmount> = state
        .utxos
        .iter()
        .zip(&origins)
        .filter(|(u, o)| u.is_spendable(now) && from_matches(**o, from_kind))
        .map(|(u, _)| u.amount())
        .collect();
    amounts.sort_by(|a, b| b.cmp(a));
    let total: NativeCurrencyAmount = amounts.into_iter().take(MAX_INPUTS).sum();
    total
        .checked_sub(&fee)
        .unwrap_or_else(NativeCurrencyAmount::zero)
}

pub fn prepare_send(
    state: &WalletState,
    keys: &Keys,
    req: SendRequest<'_>,
) -> Result<PreparedSend> {
    let selected_state = crate::profiles::filtered(state, req.profile);
    let state = &selected_state;
    let network = state.network;
    ensure!(req.amount.is_positive(), "amount must be positive");
    ensure!(!req.fee.is_negative(), "fee cannot be negative");

    // bech32m is case-insensitive; QR codes carry it in capitals.
    let destination = parse_destination(req.to, network)?;
    ensure!(
        req.private_message.unwrap_or("").is_empty()
            || matches!(destination, Destination::Private(_)),
        "encrypted messages require a private app address"
    );
    ensure!(
        req.profile != crate::profiles::Profile::Encrypted
            || matches!(destination, Destination::Private(_)),
        "the Encrypted sub-wallet requires an encrypted receiving address"
    );
    let to_normalized = req.to.trim().to_lowercase();
    let recipient = destination.receiving();

    // The transaction is confirmed in the next block at the earliest.
    let rule_set = ConsensusRuleSet::infer_from(network, BlockHeight::from(state.height));
    let next_rule_set = ConsensusRuleSet::infer_from(network, BlockHeight::from(state.height + 1));
    ensure!(
        rule_set == next_rule_set,
        "a network upgrade activates at block {}; send after it is mined",
        state.height + 1
    );
    let mock = network.use_mock_proof();
    ensure!(
        mock || jobs::can_prove_for(rule_set),
        "this wallet build cannot prove for rule set {rule_set}; update the wallet"
    );

    let now = Timestamp::millis(req.now_ms);
    let needed = req.amount + req.fee;

    // Coin selection: pinned inputs, or largest-first until covered.
    let mut candidates: Vec<_> = state
        .utxos
        .iter()
        .zip(state.origins())
        .filter(|(u, o)| {
            u.is_spendable(now)
                && crate::profiles::profile_of(u.key) == req.profile
                && from_matches(*o, req.from_kind)
        })
        .map(|(u, _)| u)
        .collect();
    let selected: Vec<_> = if let Some(pins) = &req.pinned_inputs {
        let chosen: Vec<_> = candidates
            .into_iter()
            .filter(|u| pins.contains(&u.aocl_index()))
            .collect();
        ensure!(
            chosen.len() == pins.len(),
            "a pinned input is no longer spendable"
        );
        chosen
    } else {
        candidates.sort_by(|a, b| b.amount().cmp(&a.amount()));
        let mut total = NativeCurrencyAmount::zero();
        let mut chosen = vec![];
        for u in candidates {
            if total >= needed {
                break;
            }
            total = total + u.amount();
            chosen.push(u);
        }
        chosen
    };

    let total: NativeCurrencyAmount = selected.iter().map(|u| u.amount()).sum();
    ensure!(
        total >= needed,
        "insufficient spendable balance: have {total}, need {needed}"
    );
    ensure!(
        selected.len() <= MAX_INPUTS,
        "this payment needs {} inputs (max {MAX_INPUTS}); consolidate small coins first",
        selected.len()
    );

    let inputs: Vec<UnlockedUtxo> = selected
        .iter()
        .map(|u| {
            UnlockedUtxo::unlock(
                u.utxo.clone(),
                keys.key(u.key).lock_script_and_witness(),
                u.membership_proof.clone(),
            )
        })
        .collect();
    let input_aocl_indices: Vec<u64> = selected.iter().map(|u| u.aocl_index()).collect();

    let height = BlockHeight::from(state.height);
    let sender_randomness = match &destination {
        Destination::Standard(_) => keys
            .entropy()
            .generate_sender_randomness(height, recipient.privacy_digest()),
        Destination::Private(_) => private_notification::fresh_sender_randomness()?,
    };
    let payment = match &destination {
        Destination::Standard(_) => {
            TxOutput::onchain_native_currency(req.amount, sender_randomness, recipient, false)
        }
        Destination::Private(_) => {
            TxOutput::offchain_native_currency(req.amount, sender_randomness, recipient, false)
        }
    };
    let private_announcement = match &destination {
        Destination::Standard(_) => None,
        Destination::Private(address) => {
            let (notification, _) = payment
                .offchain_notification(network)
                .ok_or_else(|| anyhow!("off-chain notification was not created"))?;
            Some(private_notification::seal_notification_with_message(
                address,
                &notification,
                req.private_message.unwrap_or(""),
                network,
            )?)
        }
    };
    let mut outputs = vec![payment];

    let change = total
        .checked_sub(&needed)
        .ok_or_else(|| anyhow!("change underflow"))?;
    let change_key_index = if change.is_positive() {
        let index = state.next_symmetric_index;
        let change_ref = crate::profiles::change_key(req.profile, index)?;
        let change_address = keys.address(change_ref);
        outputs.push(TxOutput::onchain_native_currency_as_change(
            change,
            keys.entropy()
                .generate_sender_randomness(height, change_address.privacy_digest()),
            change_address,
        ));
        Some(match change_ref {
            KeyRef::Symmetric(i) => i,
            _ => unreachable!(),
        })
    } else {
        None
    };

    let mut details = TransactionDetails::new_without_coinbase(
        inputs.clone(),
        outputs,
        req.fee,
        now,
        state.msa.clone(),
        network,
    );

    // Attach before creating the primitive witness or any proof job.
    if let Some(announcement) = private_announcement {
        details = details.with_announcements([announcement]);
    }

    // Inputs below the lustration threshold must publish their value.
    if let Some(status) = state.lustration_status {
        let transparent: Vec<TransparentInput> =
            inputs.into_iter().map(TransparentInput::from).collect();
        let lustrations = Announcement::lustration_announcements(status, &transparent);
        if !lustrations.is_empty() {
            ensure!(
                req.accept_lustration,
                "LUSTRATION_REQUIRED: some inputs are old enough that their value becomes public"
            );
            details = details.with_announcements(lustrations);
        }
    }
    let lustrates = details.contains_lustrations();

    Ok(PreparedSend {
        primitive_witness: details.primitive_witness(),
        claim_version: jobs::claim_version(rule_set),
        input_aocl_indices,
        built_at_height: state.height,
        to: to_normalized,
        amount: req.amount.to_string(),
        fee: req.fee.to_string(),
        change: change.to_string(),
        change_key_index,
        lustrates,
        mock,
        network,
    })
}

/// Turn proofs (in job order) into a transaction the node accepts.
pub fn finish(prepared: &PreparedSend, proofs: Vec<VmProof>) -> Result<RpcTransaction> {
    let pw = &prepared.primitive_witness;
    let collection: ProofCollection = if prepared.mock {
        ProofCollection::produce_mock(pw, true)
    } else {
        let collection = jobs::assemble(pw, proofs)?;
        self_check(prepared, &collection)?;
        collection
    };
    let tx = Transaction {
        kernel: pw.kernel.clone(),
        proof: TransactionProof::ProofCollection(collection),
    };
    RpcTransaction::try_from(tx).map_err(|e| anyhow!(e))
}

/// Verify every proof the way a node will, before anything is sent.
///
/// Claims are rebuilt from the assembled collection with neptune-consensus's
/// own public claim builders (the ones `ProofCollection::verify` uses), and
/// each proof is checked with Triton VM's verifier. A node's RPC accepts a
/// transaction without checking its proofs; its peers check them later. This
/// makes sure a bad proof is caught here, with a clear message, instead of
/// leaving a payment that can never confirm.
pub fn self_check(prepared: &PreparedSend, c: &ProofCollection) -> Result<()> {
    use neptune_wallet::triton_vm::stark::Stark;
    use neptune_wallet::triton_vm::verify;

    let rule_set = ConsensusRuleSet::infer_from(
        prepared.network,
        BlockHeight::from(prepared.built_at_height + 1),
    );
    let txk = prepared.primitive_witness.kernel.mast_hash();
    ensure!(
        c.kernel_mast_hash == txk,
        "self-check failed: the proofs are for a different transaction; nothing was sent"
    );
    ensure!(
        c.lock_scripts_halt.len() == c.lock_script_hashes.len()
            && c.type_scripts_halt.len() == c.type_script_hashes.len(),
        "self-check failed: proof count does not match the scripts; nothing was sent"
    );

    let mut checks = vec![
        (
            "removal-records-integrity".to_string(),
            c.removal_records_integrity_claim(rule_set),
            &c.removal_records_integrity,
        ),
        (
            "kernel-to-outputs".to_string(),
            c.kernel_to_outputs_claim(rule_set),
            &c.kernel_to_outputs,
        ),
        (
            "collect-lock-scripts".to_string(),
            c.collect_lock_scripts_claim(rule_set),
            &c.collect_lock_scripts,
        ),
        (
            "collect-type-scripts".to_string(),
            c.collect_type_scripts_claim(rule_set),
            &c.collect_type_scripts,
        ),
    ];
    for (i, (claim, proof)) in c
        .lock_script_claims(rule_set)
        .into_iter()
        .zip(&c.lock_scripts_halt)
        .enumerate()
    {
        checks.push((format!("lock-script-{i}"), claim, proof));
    }
    for (i, (claim, proof)) in c
        .type_script_claims(rule_set)
        .into_iter()
        .zip(&c.type_scripts_halt)
        .enumerate()
    {
        checks.push((format!("type-script-{i}"), claim, proof));
    }

    for (name, claim, proof) in checks {
        let vm_proof: VmProof = proof.clone().into();
        ensure!(
            verify(Stark::default(), &claim, &vm_proof),
            "self-check failed: the {name} proof does not verify; nothing was sent"
        );
    }
    Ok(())
}

/// Record a broadcast transaction in the state.
pub fn record_broadcast(state: &mut WalletState, prepared: &PreparedSend) {
    state.reserve(&prepared.input_aocl_indices, &prepared.tx_id());
    if let Some(i) = prepared.change_key_index {
        let local = crate::profiles::local_index(KeyRef::Symmetric(i));
        if local >= state.next_symmetric_index {
            state.next_symmetric_index = local + 1;
        }
    }
}
