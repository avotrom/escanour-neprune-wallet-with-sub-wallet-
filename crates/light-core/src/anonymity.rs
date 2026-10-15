//! Exact anonymity sets of the wallet's coins.
//!
//! # What an observer sees
//!
//! Every spend on chain publishes a removal record whose absolute index set
//! bounds the AOCL leaf it came from to an interval: `AbsoluteIndexSet::
//! aocl_range` (the function the lustration rule itself uses), further capped
//! by the number of leaves that existed before the block, since an input must
//! already be in the mutator set. A lustrated input publishes its
//! `TransparentInput`, whose index set provably matches one removal record, so
//! that spend's interval is a single leaf.
//!
//! An observer also knows that each leaf is spent at most once. So the
//! explanations consistent with the chain are exactly the assignments of the
//! observed spends to *distinct* leaves inside their intervals.
//!
//! # The question answered
//!
//! For an unspent coin `c` with interval `R_c`: which leaves `L ∈ R_c` are
//! possible origins of a spend of `c` made now? That is: for which `L` does a
//! consistent assignment exist for all observed spends plus `c ↦ L`?
//!
//! # The theorem used
//!
//! Spends are intervals over the ordered leaves (a convex bipartite graph).
//! By Hall's theorem, specialised to intervals, a family of intervals has a
//! system of distinct representatives in a set of points iff every window
//! `[x, y]` contains at least as many available points as there are intervals
//! inside it. Removing `L` (taken by `c`) keeps the graph convex, so:
//!
//! > `L` is a possible origin ⟺ no window `[x, y] ∋ L` is *tight*, i.e. holds
//! > exactly `y − x + 1` observed intervals.
//!
//! (Real spends always admit an assignment, so no window holds more intervals
//! than leaves; finding one means the data is wrong or incomplete, and the
//! computation refuses to give a number.) The leaves in some tight window are
//! the leaves every consistent explanation uses: provably spent.
//!
//! # The algorithm
//!
//! A tight window can always be shrunk to start at some interval's left end
//! and stop at some interval's right end, so only those are tried. Sweeping
//! `y` over right ends in increasing order, a segment tree over the distinct
//! left ends `x` holds `G(x) = C(x, y) + x − 1`, where `C(x, y)` counts
//! intervals inside `[x, y]`; `[x, y]` is tight iff `G(x) = y`. Adding an
//! interval `[a, y]` adds 1 to every `x ≤ a`. Each step asks for the maximum
//! of `G` over `x ≤ y` and its leftmost position: the union of tight windows
//! ending at `y` is `[leftmost x, y]`. Total time `O(m log m)` for `m` spends.
//!
//! The result is exact for the chain data given. It is not a probability:
//! it says which leaves are possible, not how likely each one is, and it
//! knows nothing of information off the chain (network, timing).

use std::collections::HashMap;

use anyhow::{anyhow, ensure, Result};
use neptune_consensus::transaction::announcement::Announcement;
use neptune_consensus::transaction::transparent_input::TransparentInput;
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_mutator_set::removal_record::RemovalRecord;
use neptune_wallet::twenty_first::math::bfield_codec::BFieldCodec;

/// The leaves each removal record of a block may have come from, as inclusive
/// intervals, in record order. `leaves_before` is the AOCL size before the
/// block: no input can point at or above it.
pub fn spend_ranges(
    removals: &[RemovalRecord],
    announcements: &[Announcement],
    leaves_before: u64,
) -> Result<Vec<(u64, u64)>> {
    // Lustrated inputs: the published input fixes the exact leaf.
    let mut pinned: HashMap<AbsoluteIndexSet, u64> = HashMap::new();
    for a in announcements.iter().filter(|a| a.looks_like_lustration()) {
        if let Ok(input) = TransparentInput::decode(&a.message[1..]) {
            pinned.insert(input.absolute_index_set(), input.aocl_leaf_index);
        }
    }

    let mut out = Vec::with_capacity(removals.len());
    for r in removals {
        let (lo, hi) = r
            .absolute_indices
            .aocl_range()
            .map_err(|e| anyhow!("AOCL range of a removal record: {e:?}"))?;
        ensure!(leaves_before > 0, "a spend before any leaf existed");
        let hi = hi.min(leaves_before - 1);
        ensure!(
            lo <= hi,
            "a spend points only at leaves that did not exist yet"
        );
        match pinned.get(&r.absolute_indices) {
            Some(&leaf) => {
                ensure!(
                    lo <= leaf && leaf <= hi,
                    "a lustration names a leaf outside its own range"
                );
                out.push((leaf, leaf));
            }
            None => out.push((lo, hi)),
        }
    }
    Ok(out)
}

/// Max with lazy range addition, and the leftmost position of the maximum.
struct SegTree {
    n: usize,
    max: Vec<i64>,
    lazy: Vec<i64>,
}

impl SegTree {
    fn new(init: &[i64]) -> Self {
        let n = init.len();
        let mut t = Self {
            n,
            max: vec![i64::MIN; 4 * n.max(1)],
            lazy: vec![0; 4 * n.max(1)],
        };
        if n > 0 {
            t.build(1, 0, n - 1, init);
        }
        t
    }

    fn build(&mut self, node: usize, l: usize, r: usize, init: &[i64]) {
        if l == r {
            self.max[node] = init[l];
            return;
        }
        let m = (l + r) / 2;
        self.build(2 * node, l, m, init);
        self.build(2 * node + 1, m + 1, r, init);
        self.max[node] = self.max[2 * node].max(self.max[2 * node + 1]);
    }

    fn push(&mut self, node: usize) {
        let z = self.lazy[node];
        if z != 0 {
            for c in [2 * node, 2 * node + 1] {
                self.max[c] += z;
                self.lazy[c] += z;
            }
            self.lazy[node] = 0;
        }
    }

    /// Add `v` to positions `[0, k)`.
    fn add_prefix(&mut self, k: usize, v: i64) {
        if k > 0 && self.n > 0 {
            self.add(1, 0, self.n - 1, 0, k - 1, v);
        }
    }

    fn add(&mut self, node: usize, l: usize, r: usize, ql: usize, qr: usize, v: i64) {
        if qr < l || r < ql {
            return;
        }
        if ql <= l && r <= qr {
            self.max[node] += v;
            self.lazy[node] += v;
            return;
        }
        self.push(node);
        let m = (l + r) / 2;
        self.add(2 * node, l, m, ql, qr, v);
        self.add(2 * node + 1, m + 1, r, ql, qr, v);
        self.max[node] = self.max[2 * node].max(self.max[2 * node + 1]);
    }

    /// Maximum over positions `[0, k)` and the leftmost position holding it.
    fn max_prefix(&mut self, k: usize) -> Option<(i64, usize)> {
        if k == 0 || self.n == 0 {
            return None;
        }
        Some(self.query(1, 0, self.n - 1, 0, k - 1))
    }

    fn query(&mut self, node: usize, l: usize, r: usize, ql: usize, qr: usize) -> (i64, usize) {
        if ql <= l && r <= qr {
            return (self.max[node], self.leftmost(node, l, r, self.max[node]));
        }
        self.push(node);
        let m = (l + r) / 2;
        if qr <= m {
            return self.query(2 * node, l, m, ql, qr);
        }
        if ql > m {
            return self.query(2 * node + 1, m + 1, r, ql, qr);
        }
        let a = self.query(2 * node, l, m, ql, qr);
        let b = self.query(2 * node + 1, m + 1, r, ql, qr);
        // Ties go left: the leftmost x gives the widest window.
        if a.0 >= b.0 {
            a
        } else {
            b
        }
    }

    /// Leftmost position in this node's segment whose value equals `v`
    /// (which is this node's maximum).
    fn leftmost(&mut self, node: usize, l: usize, r: usize, v: i64) -> usize {
        if l == r {
            return l;
        }
        self.push(node);
        let m = (l + r) / 2;
        if self.max[2 * node] == v {
            self.leftmost(2 * node, l, m, v)
        } else {
            self.leftmost(2 * node + 1, m + 1, r, v)
        }
    }
}

/// Leaves used by every consistent explanation of the observed spends: the
/// union of tight windows, as sorted, disjoint, inclusive intervals. Errors
/// when the spends cannot all be distinct leaves (wrong or incomplete data).
pub fn provably_spent(spends: &[(u64, u64)]) -> Result<Vec<(u64, u64)>> {
    if spends.is_empty() {
        return Ok(vec![]);
    }
    for &(a, b) in spends {
        ensure!(a <= b, "an empty spend interval");
    }
    let mut xs: Vec<u64> = spends.iter().map(|s| s.0).collect();
    xs.sort_unstable();
    xs.dedup();
    // G(x) starts at x − 1 (no interval inside any window yet).
    let init: Vec<i64> = xs.iter().map(|&x| x as i64 - 1).collect();
    let mut tree = SegTree::new(&init);

    let mut by_right = spends.to_vec();
    by_right.sort_unstable_by_key(|s| s.1);

    let mut windows: Vec<(u64, u64)> = vec![];
    let mut i = 0;
    while i < by_right.len() {
        let y = by_right[i].1;
        while i < by_right.len() && by_right[i].1 == y {
            let a = by_right[i].0;
            tree.add_prefix(xs.partition_point(|&x| x <= a), 1);
            i += 1;
        }
        let k = xs.partition_point(|&x| x <= y);
        let (max, pos) = tree
            .max_prefix(k)
            .ok_or_else(|| anyhow!("no window can end at leaf {y}"))?;
        let y_i = y as i64;
        ensure!(
            max <= y_i,
            "more spends than leaves around leaf {y}: the spend data is wrong or incomplete"
        );
        if max == y_i {
            windows.push((xs[pos], y));
        }
    }

    windows.sort_unstable();
    let mut merged: Vec<(u64, u64)> = vec![];
    for (s, e) in windows {
        match merged.last_mut() {
            Some(last) if s <= last.1.saturating_add(1) => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    Ok(merged)
}

/// How many leaves of `[lo, hi]` are in the sorted disjoint intervals `set`.
pub fn overlap(set: &[(u64, u64)], lo: u64, hi: u64) -> u64 {
    if lo > hi {
        return 0;
    }
    let start = set.partition_point(|&(_, e)| e < lo);
    let mut n = 0;
    for &(s, e) in &set[start..] {
        if s > hi {
            break;
        }
        n += e.min(hi) - s.max(lo) + 1;
    }
    n
}

/// Whether `leaf` is in the sorted disjoint intervals `set`.
pub fn contains(set: &[(u64, u64)], leaf: u64) -> bool {
    overlap(set, leaf, leaf) == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Brute force: which leaves of `range` can `c` take, given `spends`,
    /// by trying every assignment (tiny inputs only).
    fn brute(spends: &[(u64, u64)], range: (u64, u64)) -> Vec<u64> {
        fn assign(spends: &[(u64, u64)], used: &mut Vec<u64>) -> bool {
            let Some((&(a, b), rest)) = spends.split_first() else {
                return true;
            };
            for l in a..=b {
                if !used.contains(&l) {
                    used.push(l);
                    if assign(rest, used) {
                        used.pop();
                        return true;
                    }
                    used.pop();
                }
            }
            false
        }
        (range.0..=range.1)
            .filter(|&l| assign(spends, &mut vec![l]))
            .collect()
    }

    fn fast(spends: &[(u64, u64)], range: (u64, u64)) -> Vec<u64> {
        let t = provably_spent(spends).unwrap();
        (range.0..=range.1).filter(|&l| !contains(&t, l)).collect()
    }

    #[test]
    fn tight_pair_excludes_both_leaves() {
        // Two spends that can only be leaves 3 and 4: both provably spent.
        let spends = [(3, 4), (3, 4), (0, 9)];
        assert_eq!(fast(&spends, (0, 9)), brute(&spends, (0, 9)));
        assert_eq!(fast(&spends, (0, 9)), vec![0, 1, 2, 5, 6, 7, 8, 9]);
    }

    #[test]
    fn lustration_pins_one_leaf() {
        let spends = [(5, 5), (0, 7)];
        assert_eq!(fast(&spends, (0, 7)), brute(&spends, (0, 7)));
    }

    #[test]
    fn no_spends_means_whole_range() {
        assert_eq!(fast(&[], (10, 17)).len(), 8);
    }

    #[test]
    fn inconsistent_data_is_refused() {
        // Three spends inside two leaves cannot be real.
        assert!(provably_spent(&[(1, 2), (1, 2), (2, 2)]).is_err());
    }

    #[test]
    fn matches_brute_force_on_many_small_cases() {
        // Deterministic pseudo-random cases; only consistent ones count.
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut checked = 0;
        for _ in 0..4000 {
            let n_leaves = 2 + next() % 10;
            let n_spends = next() % 7;
            let spends: Vec<(u64, u64)> = (0..n_spends)
                .map(|_| {
                    let a = next() % n_leaves;
                    let b = a + next() % (n_leaves - a);
                    (a, b)
                })
                .collect();
            let range = {
                let a = next() % n_leaves;
                (a, a + next() % (n_leaves - a))
            };
            // Only data a real chain could produce: all spends assignable.
            let feasible = !brute(&spends, (n_leaves + 100, n_leaves + 100)).is_empty();
            if !feasible {
                // Hall's condition fails somewhere: the data must be refused.
                assert!(provably_spent(&spends).is_err(), "{spends:?}");
                continue;
            }
            assert_eq!(
                fast(&spends, range),
                brute(&spends, range),
                "{spends:?} {range:?}"
            );
            checked += 1;
        }
        assert!(checked > 1000);
    }
}
