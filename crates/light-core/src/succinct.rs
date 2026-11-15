//! Succinct validation: authenticate the chain from one block.
//!
//! Since soft fork epsilon (Neptune block 62,500 on main net) every block's
//! proof also establishes that its predecessor is valid, recursively down to
//! the last block before activation. Verifying the proof of the tip therefore
//! verifies the whole chain above that activation parent, and the proven
//! claim hands back the parent's hash, mutator set hash and the proof-of-work
//! accumulated since activation.
//!
//! This module turns a node's `chain_tip` answer into such a verdict. It is
//! what lets the wallet run as a *succinct node*: the server is still the
//! transport, but it can no longer invent a chain. The wallet's own block
//! scan (hash chain + mutator set accumulator, [`crate::sync`]) is then tied
//! to the proven block by comparing hashes ([`TipReport::matches`]).
//!
//! What a verdict covers, precisely:
//! - **the parent of the tip** is a valid block on a valid chain above the
//!   activation parent (proven recursively inside the tip's proof);
//! - **the tip** carries a valid proof for its own claims, continues that
//!   parent (digest, block time, difficulty, cumulative proof-of-work) and
//!   meets its proof-of-work target. Its own mutator set update is checked
//!   too when the caller supplies the mutator set after the parent
//!   ([`TipReport::tip_fully_validated`]); otherwise the next block proves it;
//! - **nothing below the activation parent**. That block's hash is the trust
//!   anchor ([`TipReport::activation_parent_hash`]) and must be compared
//!   against a value obtained out of band, or pinned on first use.
//!
//! No networking and no secrets: everything here is public chain data.

use anyhow::{Context, Result, anyhow, bail, ensure};
use neptune_consensus::block::Block;
use neptune_consensus::block::block_validation_error::BlockValidationError;
use neptune_consensus::consensus_rule_set::ConsensusRuleSet;
use neptune_mutator_set::mutator_set_accumulator::MutatorSetAccumulator;
use neptune_primitives::block_height::BlockHeight;
use neptune_primitives::difficulty_control::ProofOfWork;
use neptune_primitives::network::Network;
use neptune_primitives::timestamp::Timestamp;
use neptune_rpc_api::model::message::TipResponse;
use neptune_wallet::tasm_lib::prelude::Digest;
use neptune_wallet::twenty_first::math::b_field_element::BFieldElement;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rpc::result_from_envelope;
use crate::state::WalletState;

/// Returns the node's tip *with its proof*. Served by the `chain` module,
/// which every wallet server already exposes.
pub const METHOD_TIP: &str = "chain_tip";

pub fn tip_params() -> Value {
    Value::Array(vec![])
}

/// The first block whose proof covers its predecessor.
pub fn activation_height(network: Network) -> u64 {
    ConsensusRuleSet::epsilon_activation_block_height(network).into()
}

/// Whether blocks at `height` prove their predecessor.
pub fn is_active(network: Network, height: u64) -> bool {
    ConsensusRuleSet::infer_from(network, BlockHeight::from(height)).requires_predecessor_claim()
}

pub fn parse_tip(body: &str) -> Result<Block> {
    let r: TipResponse = result_from_envelope(body)?;
    Ok(Block::from(r.block))
}

/// The outcome of checking one tip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TipReport {
    pub network: String,
    /// `true`: everything below holds. `false`: the tip is below the
    /// activation height, nothing was (or can be) proven, and only
    /// `height`, `hash` and `activation_height` are meaningful.
    pub proven: bool,
    pub activation_height: u64,

    pub height: u64,
    pub hash: String,
    pub timestamp_ms: u64,
    pub difficulty: String,
    /// As the header states it; equal to the parent's proven value plus this
    /// block's difficulty.
    pub cumulative_proof_of_work: String,

    pub parent_hash: String,
    /// Hash of the mutator set after the parent, guesser fees included: what
    /// a wallet synchronised to the parent must hold.
    pub parent_mutator_set_hash: String,

    /// Proof-of-work accumulated from the activation height up to and
    /// including this tip. Fixed-width big-endian hex, so plain string
    /// comparison orders it. This, not the header's cumulative value, is what
    /// a succinct client compares chains by.
    pub work_since_activation_hex: String,
    pub work_since_activation: String,
    /// Hash of the last block below the activation height: the trust anchor.
    pub activation_parent_hash: String,

    /// The tip's own mutator set update was validated here as well (the
    /// caller supplied the mutator set after the parent).
    pub tip_fully_validated: bool,
}

/// How a wallet state relates to a proven tip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Match {
    /// The wallet is at the tip or at its parent, on the proven chain.
    OnProvenChain,
    /// The wallet is at one of those heights with a different block: the
    /// server that fed the wallet is not on the proven chain.
    Diverged,
    /// Heights are too far apart to compare; sync and check again.
    NotComparable,
}

impl TipReport {
    /// Compare a wallet state against this verdict.
    ///
    /// At the parent's height both the block hash and the wallet's mutator
    /// set must agree with the proven values; at the tip's height the hash
    /// must.
    pub fn matches(&self, state: &WalletState) -> Match {
        if !self.proven {
            return Match::NotComparable;
        }
        let tip_hash = state.tip_hash.to_hex();
        if state.height == self.height {
            return if tip_hash == self.hash {
                Match::OnProvenChain
            } else {
                Match::Diverged
            };
        }
        if state.height + 1 == self.height {
            return if tip_hash == self.parent_hash
                && state.msa.hash().to_hex() == self.parent_mutator_set_hash
            {
                Match::OnProvenChain
            } else {
                Match::Diverged
            };
        }
        Match::NotComparable
    }
}

/// Fixed-width big-endian hex of a proof-of-work number.
fn work_hex(work: ProofOfWork) -> String {
    let limbs: Vec<u32> = work.into_iter().collect();
    limbs.iter().rev().map(|l| format!("{l:08x}")).collect()
}

fn explain(e: BlockValidationError) -> anyhow::Error {
    match e {
        BlockValidationError::FutureDating => anyhow!(
            "the tip is dated more than a minute ahead of this computer's clock; check the clock"
        ),
        BlockValidationError::AppendixMissingClaim => anyhow!(
            "the tip does not carry the predecessor-is-valid claim; the node is not on the succinct chain"
        ),
        BlockValidationError::ProofValidity | BlockValidationError::ProofQuality => {
            anyhow!("the tip's proof does not verify")
        }
        other => anyhow!("the tip breaks a consensus rule: {other}"),
    }
}

/// Check a tip block as served by `chain_tip`.
///
/// - `now_ms`: wall-clock time (the browser's; wasm has no clock).
/// - `parent_mutator_set`: the mutator set after the tip's parent, when the
///   caller has it (a wallet synchronised to exactly that block). With it the
///   tip's own update is validated too.
/// - `expected_anchor`: the activation parent hash the caller trusts. A
///   mismatch is an error: the chain is built on a different history.
///
/// Errors mean: do not trust this node's view.
pub fn verify_tip(
    block: &Block,
    network: Network,
    now_ms: u64,
    parent_mutator_set: Option<&MutatorSetAccumulator>,
    expected_anchor: Option<Digest>,
) -> Result<TipReport> {
    let header = block.header();
    let height: u64 = header.height.into();
    let activation = activation_height(network);

    if !is_active(network, height) {
        return Ok(TipReport {
            network: network.to_string(),
            proven: false,
            activation_height: activation,
            height,
            hash: block.hash().to_hex(),
            timestamp_ms: header.timestamp.to_millis(),
            difficulty: header.difficulty.to_string(),
            cumulative_proof_of_work: header.cumulative_proof_of_work.to_string(),
            parent_hash: header.prev_block_digest.to_hex(),
            parent_mutator_set_hash: String::new(),
            work_since_activation_hex: String::new(),
            work_since_activation: String::new(),
            activation_parent_hash: String::new(),
            tip_fully_validated: false,
        });
    }

    let now = Timestamp(BFieldElement::new(now_ms));
    let (parent, full) = match parent_mutator_set {
        Some(msa) => (
            block
                .validate_tip_sync(msa, now, network)
                .map_err(explain)?,
            true,
        ),
        None => (
            block
                .validate_tip_header_sync(now, network)
                .map_err(explain)?,
            false,
        ),
    };

    // Not part of block validity upstream either: the caller checks it.
    ensure!(
        block.has_proof_of_work_against(network, parent.timestamp, parent.difficulty),
        "the tip does not meet its proof-of-work target"
    );

    if let Some(anchor) = expected_anchor {
        if parent.activation_parent_hash != anchor {
            bail!(
                "the node's chain is built on a different block {} than the one this wallet trusts (got {}, expected {})",
                activation.saturating_sub(1),
                parent.activation_parent_hash.to_hex(),
                anchor.to_hex()
            );
        }
    }

    // The claim describes the parent; this tip adds its own difficulty.
    let work = parent.work_since_activation + header.difficulty;

    Ok(TipReport {
        network: network.to_string(),
        proven: true,
        activation_height: activation,
        height,
        hash: block.hash().to_hex(),
        timestamp_ms: header.timestamp.to_millis(),
        difficulty: header.difficulty.to_string(),
        cumulative_proof_of_work: header.cumulative_proof_of_work.to_string(),
        parent_hash: parent.hash.to_hex(),
        parent_mutator_set_hash: parent.mutator_set_hash.to_hex(),
        work_since_activation_hex: work_hex(work),
        work_since_activation: work.to_string(),
        activation_parent_hash: parent.activation_parent_hash.to_hex(),
        tip_fully_validated: full,
    })
}

/// Parse and check a `chain_tip` response body. See [`verify_tip`].
pub fn verify_tip_response(
    body: &str,
    network: Network,
    now_ms: u64,
    parent_mutator_set: Option<&MutatorSetAccumulator>,
    expected_anchor_hex: Option<&str>,
) -> Result<TipReport> {
    let block = parse_tip(body).context("the node's tip could not be read")?;
    let anchor = match expected_anchor_hex.filter(|s| !s.is_empty()) {
        Some(hex) => Some(
            Digest::try_from_hex(hex).map_err(|e| anyhow!("invalid trust anchor: {e}"))?,
        ),
        None => None,
    };
    verify_tip(&block, network, now_ms, parent_mutator_set, anchor)
}

/// Fork choice between proven tips: more work since activation wins; the
/// earlier-listed one wins a tie (so a caller's preferred node goes first).
/// Unproven reports never win against proven ones.
pub fn best<'a>(reports: &'a [TipReport]) -> Option<&'a TipReport> {
    let mut best: Option<&TipReport> = None;
    for r in reports {
        best = match best {
            None => Some(r),
            Some(b) if (r.proven, &r.work_since_activation_hex)
                > (b.proven, &b.work_since_activation_hex) =>
            {
                Some(r)
            }
            keep => keep,
        };
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(proven: bool, work: u64, hash: &str) -> TipReport {
        TipReport {
            network: "main".into(),
            proven,
            activation_height: 10,
            height: 12,
            hash: hash.into(),
            timestamp_ms: 0,
            difficulty: String::new(),
            cumulative_proof_of_work: String::new(),
            parent_hash: "p".into(),
            parent_mutator_set_hash: "m".into(),
            work_since_activation_hex: if proven {
                work_hex(ProofOfWork::try_from(work as f64).unwrap())
            } else {
                String::new()
            },
            work_since_activation: String::new(),
            activation_parent_hash: "a".into(),
            tip_fully_validated: false,
        }
    }

    #[test]
    fn work_hex_orders_like_the_number() {
        let small = ProofOfWork::try_from(1_000f64).unwrap();
        let large = ProofOfWork::try_from(1e30).unwrap();
        assert!(small < large);
        let (a, b) = (work_hex(small), work_hex(large));
        assert_eq!(a.len(), b.len());
        assert!(a < b);
    }

    #[test]
    fn fork_choice_prefers_proven_work_then_first() {
        let weak = report(true, 1_000, "weak");
        let strong = report(true, 2_000_000, "strong");
        let unproven = report(false, 0, "unproven");
        assert_eq!(best(&[weak.clone(), strong.clone()]).unwrap().hash, "strong");
        assert_eq!(best(&[strong.clone(), weak.clone()]).unwrap().hash, "strong");
        assert_eq!(best(&[unproven.clone(), weak.clone()]).unwrap().hash, "weak");
        let twin = report(true, 1_000, "twin");
        assert_eq!(best(&[weak, twin]).unwrap().hash, "weak");
        assert!(best(&[]).is_none());
    }

    #[test]
    fn a_tip_below_activation_is_reported_unproven() {
        let network = Network::Main;
        let genesis = Block::genesis(network);
        let r = verify_tip(&genesis, network, 0, None, None).unwrap();
        assert!(!r.proven);
        assert_eq!(r.height, 0);
        assert_eq!(r.activation_height, 62_500);
        assert_eq!(r.hash, genesis.hash().to_hex());
    }

    #[test]
    fn activation_heights_follow_the_consensus_crate() {
        assert_eq!(activation_height(Network::Main), 62_500);
        assert_eq!(activation_height(Network::Testnet(0)), 7_144);
        assert!(!is_active(Network::Main, 62_499));
        assert!(is_active(Network::Main, 62_500));
    }

    #[test]
    fn a_block_without_the_claim_is_rejected_above_activation() {
        // The genesis block relabelled is not available without test helpers;
        // an unparsable anchor and an empty tip body are the cheap negatives.
        assert!(verify_tip_response("{}", Network::Main, 0, None, None).is_err());
        let err = verify_tip_response(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#,
            Network::Main,
            0,
            None,
            None,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("Method not found"));
    }
}
