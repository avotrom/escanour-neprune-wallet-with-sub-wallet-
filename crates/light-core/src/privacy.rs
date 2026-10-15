//! How private the wallet's coins are, measured from the mutator set itself.
//!
//! When a coin is spent, its removal record publishes an absolute index set
//! (45 Bloom-filter indices). Those indices narrow down which AOCL leaf, which
//! receipt, the spent coin came from to a range of leaves, computed by
//! neptune-mutator-set's own `AbsoluteIndexSet::aocl_range`. Any leaf in that
//! range could be the one spent; nothing on-chain says which. The size of the
//! range is the coin's anonymity set.
//!
//! The range is fixed when the coin is received, but leaves at its upper end
//! may not exist yet: a coin received a moment ago hides among fewer coins
//! than it will once the chain has added the rest of its range. This module
//! reports both numbers, and how many more coins the chain must add.
//!
//! The number shown is the sender's: whoever paid a coin knows where it sits
//! in the AOCL, and when it is spent sees only the public range. Anyone else
//! knows less (a notification says which block, not which leaf), so the
//! sender's number is the worst case of the two. The owner knows everything.
//!
//! It also reports which coins would publish their amount when spent
//! (lustration), using the same rule as `Announcement::lustration_announcements`.

use neptune_mutator_set::shared::{BATCH_SIZE, CHUNK_SIZE, NUM_TRIALS, WINDOW_SIZE};
use neptune_primitives::timestamp::Timestamp;
use neptune_wallet::triton_vm::stark::Stark;
use neptune_wallet::twenty_first::util_types::mmr::mmr_trait::Mmr;
use serde::Serialize;

use crate::keys::KeyRef;
use crate::state::WalletState;

#[derive(Debug, Clone, Serialize)]
pub struct CoinPrivacy {
    pub aocl_index: u64,
    pub amount: String,
    /// "generation", "ec-hybrid" or "change".
    pub kind: &'static str,
    pub spendable: bool,
    /// Coins a spend of this one could be confused with, today.
    pub hidden_among_now: u64,
    /// The same once the chain has added the rest of the coin's range.
    pub hidden_among_full: u64,
    /// More coins (AOCL leaves) the chain must add before `full` is reached.
    pub leaves_until_full: u64,
    /// Spending it publishes its amount (lustration rule). A lustrated
    /// spend also publishes its exact leaf: it hides among no one.
    pub reveals_amount: bool,
    /// Exact number of leaves a spend of this coin made now could be, given
    /// every spend on chain (see [`crate::anonymity`]). `None` when the
    /// wallet does not hold every block's spends since block 1.
    pub exact_possible: Option<u64>,
    /// Other coins whoever paid you this one cannot tell its spend apart
    /// from, in the worst case: `exact_possible` (or the range size) minus
    /// the coin itself and minus every other output of the block it came in,
    /// since the sender may own them all (their change is always there).
    pub sender_sees: u64,
    /// Whether the block's outputs were known; if not, only the coin itself
    /// was taken out and `sender_sees` may be a little high.
    pub sender_block_known: bool,
    /// The AOCL leaf range a spend points to (inclusive), from `aocl_range`.
    pub aocl_lo: u64,
    pub aocl_hi: u64,
    /// The coin's own AOCL leaf and the block it was received in.
    pub received_height: u64,
    /// Blocks the range corresponds to, estimated with the average leaves
    /// per block: a spend shows the coin was received roughly in this span.
    pub est_block_lo: u64,
    pub est_block_hi: u64,
}

/// The mutator set's public parameters, for the explanation in the wallet.
#[derive(Debug, Clone, Serialize)]
pub struct MutatorSetParams {
    pub window_size: u32,
    pub chunk_size: u32,
    pub batch_size: u32,
    pub num_trials: u32,
}

/// The zk-STARK parameters this wallet proves with (Triton VM defaults,
/// the same the network verifies with).
#[derive(Debug, Clone, Serialize)]
pub struct StarkParams {
    pub security_level: usize,
    pub fri_expansion_factor: usize,
    pub num_trace_randomizers: usize,
    pub num_collinearity_checks: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExactStatus {
    pub computed: bool,
    /// Leaves every consistent explanation of the chain's spends uses.
    pub provably_spent_leaves: u64,
    pub spends_considered: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrivacyReport {
    pub coins: Vec<CoinPrivacy>,
    /// Whether `exact_possible` was computed, and why not if it was not.
    pub exact: ExactStatus,
    /// Coins (AOCL leaves) the chain holds now.
    pub aocl_leaves: u64,
    /// Average coins added per block since genesis, to turn leaves into blocks.
    pub leaves_per_block: f64,
    pub mutator_set: MutatorSetParams,
    pub stark: StarkParams,
}

fn kind_of(k: KeyRef) -> &'static str {
    match k {
        KeyRef::Generation(_) => "generation",
        KeyRef::EcHybrid(_) => "ec-hybrid",
        KeyRef::Symmetric(_) => "change",
    }
}

/// Other coins the sender cannot tell this coin's spend apart from.
///
/// `possible` counts the leaves of the range `[lo, hi]` a spend of the coin
/// could be (the coin's own leaf included). The sender knows which outputs of
/// the coin's block are theirs; the chain does not say which, so all of the
/// block's outputs in the range that are still possible are taken out, the
/// coin's own leaf among them. With `spent` given, leaves it proves spent
/// were already left out of `possible` and are not taken out twice.
fn sender_view(
    possible: u64,
    spent: Option<&[(u64, u64)]>,
    (lo, hi): (u64, u64),
    block: Option<(u64, u64)>,
    reveals: bool,
) -> u64 {
    if reveals {
        return 0;
    }
    let same_block = match block {
        None => 1,
        Some((b0, b1)) => {
            let (a, b) = (lo.max(b0), hi.min(b1));
            if a > b {
                1
            } else {
                let proven = spent.map_or(0, |t| crate::anonymity::overlap(t, a, b));
                (b - a + 1 - proven).max(1)
            }
        }
    };
    possible.saturating_sub(same_block)
}

pub fn report(state: &WalletState, now_ms: u64) -> PrivacyReport {
    report_exact(state, now_ms, None)
}

/// The report, with exact anonymity counts when `spends` holds the spend
/// intervals of every block from 1 to the wallet's height.
pub fn report_exact(
    state: &WalletState,
    now_ms: u64,
    spends: Option<&[(u64, u64)]>,
) -> PrivacyReport {
    let saturated = spends.map(crate::anonymity::provably_spent);
    let mut exact = ExactStatus {
        computed: false,
        provably_spent_leaves: 0,
        spends_considered: spends.map_or(0, |s| s.len() as u64),
        error: None,
    };
    let saturated: Option<Vec<(u64, u64)>> = match saturated {
        None => None,
        Some(Ok(t)) => {
            exact.computed = true;
            exact.provably_spent_leaves = t.iter().map(|(a, b)| b - a + 1).sum();
            Some(t)
        }
        Some(Err(e)) => {
            exact.error = Some(format!("{e:#}"));
            None
        }
    };
    let now = Timestamp::millis(now_ms);
    let leaves = state.msa.aocl.num_leafs();
    let max_lustrating = state
        .lustration_status
        .as_ref()
        .map(|s| s.max_lustrating_aocl_leaf_index);

    let rate = if state.height > 0 {
        leaves as f64 / state.height as f64
    } else {
        0.0
    };
    let to_blocks = |n: u64| {
        if rate > 0.0 {
            (n as f64 / rate).round() as u64
        } else {
            0
        }
    };

    let coins: Vec<CoinPrivacy> = state
        .utxos
        .iter()
        .filter(|u| u.is_unspent())
        .map(|u| {
            let range = u.absolute_index_set().aocl_range().ok();
            let (lo, hi) = range.unwrap_or((u.aocl_index(), u.aocl_index()));
            let full = hi.saturating_sub(lo) + 1;
            let last_existing = leaves.saturating_sub(1);
            let now_hi = hi.min(last_existing);
            let hidden_now = if now_hi >= lo { now_hi - lo + 1 } else { 1 };
            let reveals = max_lustrating.is_some_and(|m| lo <= m);
            let hi_now = now_hi.max(lo);
            let exact_possible = saturated.as_ref().and_then(|t| {
                // Our own unspent leaf can never be provably spent; if it
                // were, the data would be wrong, and no number is given.
                if crate::anonymity::contains(t, u.aocl_index()) {
                    return None;
                }
                if reveals {
                    return Some(1);
                }
                Some((hi_now - lo + 1) - crate::anonymity::overlap(t, lo, hi_now))
            });
            let sender_sees = sender_view(
                exact_possible.unwrap_or(hidden_now),
                saturated
                    .as_deref()
                    .filter(|_| exact_possible.is_some()),
                (lo, hi_now),
                u.block_leaves,
                reveals,
            );
            CoinPrivacy {
                exact_possible,
                sender_sees,
                sender_block_known: u.block_leaves.is_some(),
                aocl_index: u.aocl_index(),
                amount: u.amount().to_string(),
                kind: kind_of(u.key),
                spendable: u.is_spendable(now),
                hidden_among_now: hidden_now,
                hidden_among_full: full,
                leaves_until_full: (hi + 1).saturating_sub(leaves),
                reveals_amount: reveals,
                aocl_lo: lo,
                aocl_hi: hi,
                received_height: u.received_height,
                est_block_lo: u
                    .received_height
                    .saturating_sub(to_blocks(u.aocl_index().saturating_sub(lo))),
                est_block_hi: u.received_height + to_blocks(hi.saturating_sub(u.aocl_index())),
            }
        })
        .collect();

    // A bad coin (own leaf provably spent) means the spend data is wrong.
    if exact.computed
        && coins
            .iter()
            .any(|c: &CoinPrivacy| c.exact_possible.is_none())
    {
        exact.computed = false;
        exact.error = Some("the spend data contradicts the wallet's own coins".into());
    }
    let coins = if exact.computed {
        coins
    } else {
        coins
            .into_iter()
            .map(|mut c| {
                if c.exact_possible.take().is_some() {
                    // Back to the range size: the number can only grow.
                    let u = state.utxos.iter().find(|u| u.aocl_index() == c.aocl_index);
                    c.sender_sees = sender_view(
                        c.hidden_among_now,
                        None,
                        (c.aocl_lo, c.aocl_hi.min(leaves.saturating_sub(1)).max(c.aocl_lo)),
                        u.and_then(|u| u.block_leaves),
                        c.reveals_amount,
                    );
                }
                c
            })
            .collect()
    };

    PrivacyReport {
        exact,
        coins,
        aocl_leaves: leaves,
        leaves_per_block: rate,
        mutator_set: MutatorSetParams {
            window_size: WINDOW_SIZE,
            chunk_size: CHUNK_SIZE,
            batch_size: BATCH_SIZE,
            num_trials: NUM_TRIALS,
        },
        stark: {
            let s = Stark::default();
            StarkParams {
                security_level: s.security_level,
                fri_expansion_factor: s.fri_expansion_factor,
                num_trace_randomizers: s.num_trace_randomizers,
                num_collinearity_checks: s.num_collinearity_checks,
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::sender_view;

    #[test]
    fn sender_takes_out_its_whole_block() {
        // Range 10..=29, the coin's block added leaves 15..=18.
        assert_eq!(sender_view(20, None, (10, 29), Some((15, 18)), false), 16);
        // Leaf 16 provably spent: not counted in `possible`, not taken twice.
        let spent = vec![(16, 16)];
        assert_eq!(sender_view(19, Some(&spent[..]), (10, 29), Some((15, 18)), false), 16);
        // Block unknown: only the coin itself comes out.
        assert_eq!(sender_view(20, None, (10, 29), None, false), 19);
        // Block partly past the range's existing leaves.
        assert_eq!(sender_view(12, None, (10, 21), Some((20, 25)), false), 10);
        // A lustrated spend shows its leaf: no one to hide among.
        assert_eq!(sender_view(20, None, (10, 29), Some((15, 18)), true), 0);
        // A coin alone in its range.
        assert_eq!(sender_view(1, None, (7, 7), Some((7, 7)), false), 0);
    }
}
