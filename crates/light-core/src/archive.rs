//! A local archival mutator set: the whole AOCL and every inactive chunk of
//! the sliding-window Bloom filter, kept on this device (tens of MB).
//!
//! With it the wallet needs no server to
//! - restore the membership proof of any coin it can name (a registered
//!   notification, a premine allocation): [`Archive::restore`] builds what
//!   neptune-core's `ArchivalMutatorSet::restore_membership_proof` builds;
//! - tell whether a coin was spent: [`Archive::was_spent`];
//! - find where a coin landed from its addition record: [`Archive::locate`].
//!
//! # How it is built
//!
//! Block by block from genesis, with the mutator set accumulator's own
//! operations, in the same order the wallet's sync uses: every addition goes
//! through `MutatorSetAccumulator::add_helper`, which returns the chunk that
//! slides out of the active window; every removal through `remove_helper`,
//! which returns the chunks it changed. Before a removal, the chunks it reads
//! must equal the archive's own copies. After each block the accumulator must
//! hash to the one the block commits to, or the block is refused. So the
//! archive holds exactly the data the chain commits to, and every proof it
//! restores is checked against the wallet's accumulator before use.
//!
//! The genesis block is never served by `wallet_getBlocks`; it is rebuilt
//! locally with `Block::genesis`, and block 1 must extend its hash.
//!
//! # Storage
//!
//! The extension keeps the archive in pages: leaves in pages of
//! [`LEAF_PAGE`] digests, chunks in pages of [`CHUNK_PAGE`], plus one meta
//! record. Only pages changed since the last save are written again. If a
//! block fails to apply, the in-memory archive is discarded and reloaded.

use std::collections::BTreeSet;

use anyhow::{anyhow, ensure, Result};
use neptune_consensus::block::mutator_set_update::MutatorSetUpdate;
use neptune_consensus::block::Block;
use neptune_mutator_set::addition_record::AdditionRecord;
use neptune_mutator_set::ms_membership_proof::MsMembershipProof;
use neptune_mutator_set::mutator_set_accumulator::MutatorSetAccumulator;
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_mutator_set::removal_record::chunk::Chunk;
use neptune_mutator_set::removal_record::chunk_dictionary::ChunkDictionary;
use neptune_mutator_set::removal_record::RemovalRecord;
use neptune_mutator_set::shared::{CHUNK_SIZE, WINDOW_SIZE};
use neptune_primitives::network::Network;
use neptune_rpc_api::model::wallet::block::RpcWalletBlock;
use neptune_wallet::tasm_lib::prelude::{Digest, Tip5};
use neptune_wallet::twenty_first::util_types::mmr::mmr_accumulator::MmrAccumulator;
use neptune_wallet::twenty_first::util_types::mmr::mmr_membership_proof::MmrMembershipProof;
use neptune_wallet::twenty_first::util_types::mmr::mmr_trait::Mmr;
use serde::{Deserialize, Serialize};

use crate::sync::{decode, msa_after, BlockSpends, Decoded};

pub const LEAF_PAGE: usize = 4096;
pub const CHUNK_PAGE: usize = 256;
const ARCHIVE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Meta {
    version: u32,
    network: Network,
    height: u64,
    tip_hash: Digest,
    msa: MutatorSetAccumulator,
    num_leaves: u64,
    num_chunks: u64,
    /// AOCL size after each block, genesis first.
    block_ends: Vec<u64>,
    chunk_hashes: Vec<Digest>,
}

pub struct Archive {
    network: Network,
    height: u64,
    tip_hash: Digest,
    msa: MutatorSetAccumulator,
    leaves: Vec<Digest>,
    chunks: Vec<Chunk>,
    chunk_hashes: Vec<Digest>,
    block_ends: Vec<u64>,
    /// Counts promised by the meta record, while pages are being loaded.
    expect: Option<(u64, u64)>,
    dirty_leaf_pages: BTreeSet<u64>,
    dirty_chunk_pages: BTreeSet<u64>,
}

/// Root of a perfect binary Merkle tree over `leaves` (length a power of 2),
/// with the MMR's node rule `hash_pair(left, right)`.
fn merkle_root(leaves: &[Digest]) -> Digest {
    debug_assert!(leaves.len().is_power_of_two());
    let mut level: Vec<Digest> = leaves.to_vec();
    while level.len() > 1 {
        level = level
            .chunks_exact(2)
            .map(|p| Tip5::hash_pair(p[0], p[1]))
            .collect();
    }
    level[0]
}

/// The MMR authentication path of leaf `index` among `leaves`, checked
/// against `peaks` before it is returned.
fn mmr_path(leaves: &[Digest], index: u64, peaks: &[Digest]) -> Result<MmrMembershipProof> {
    let n = leaves.len() as u64;
    ensure!(index < n, "leaf {index} is not in the archive ({n} leaves)");
    // The peak trees, largest first, cover [0, n): find the one with `index`.
    let mut start = 0u64;
    let mut height = None;
    for bit in (0..64u32).rev() {
        let size = 1u64 << bit;
        if n & size == 0 {
            continue;
        }
        if index < start + size {
            height = Some(bit);
            break;
        }
        start += size;
    }
    let height = height.ok_or_else(|| anyhow!("no peak holds leaf {index}"))?;
    let local = index - start;
    let mut path = Vec::with_capacity(height as usize);
    for level in 0..height {
        let sibling = (local >> level) ^ 1;
        let from = (start + (sibling << level)) as usize;
        let to = from + (1usize << level);
        path.push(merkle_root(&leaves[from..to]));
    }
    let proof = MmrMembershipProof::new(path);
    ensure!(
        proof.verify(index, leaves[index as usize], peaks, n),
        "authentication path for leaf {index} does not verify"
    );
    Ok(proof)
}

impl Archive {
    /// A new archive holding the genesis block.
    pub fn new(network: Network) -> Result<Self> {
        let genesis = Block::genesis(network);
        let hash = genesis.hash();
        let MutatorSetUpdate {
            additions,
            removals,
        } = genesis
            .kernel
            .mutator_set_update(hash, network)
            .map_err(|e| anyhow!("genesis mutator set update: {e:?}"))?;
        ensure!(removals.is_empty(), "genesis spends nothing");
        let mut a = Self {
            network,
            height: 0,
            tip_hash: hash,
            msa: MutatorSetAccumulator::default(),
            leaves: vec![],
            chunks: vec![],
            chunk_hashes: vec![],
            block_ends: vec![],
            expect: None,
            dirty_leaf_pages: BTreeSet::new(),
            dirty_chunk_pages: BTreeSet::new(),
        };
        for addition in &additions {
            a.add(addition)?;
        }
        ensure!(
            msa_after(&genesis.kernel, hash)?.hash() == a.msa.hash(),
            "rebuilt genesis mutator set does not match"
        );
        a.block_ends.push(a.leaves.len() as u64);
        Ok(a)
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn height(&self) -> u64 {
        self.height
    }

    pub fn tip_hash(&self) -> Digest {
        self.tip_hash
    }

    pub fn msa(&self) -> &MutatorSetAccumulator {
        &self.msa
    }

    pub fn num_leaves(&self) -> u64 {
        self.leaves.len() as u64
    }

    pub fn num_chunks(&self) -> u64 {
        self.chunks.len() as u64
    }

    /// Bytes the archive takes in storage, roughly.
    pub fn size_bytes(&self) -> u64 {
        let chunk_bytes: usize = self
            .chunks
            .iter()
            .map(|c| 8 + 4 * c.relative_indices.len())
            .sum();
        (self.leaves.len() * Digest::BYTES
            + chunk_bytes
            + self.chunk_hashes.len() * Digest::BYTES
            + self.block_ends.len() * 8) as u64
    }

    fn mark_leaf(&mut self, i: usize) {
        self.dirty_leaf_pages.insert((i / LEAF_PAGE) as u64);
    }

    fn mark_chunk(&mut self, i: usize) {
        self.dirty_chunk_pages.insert((i / CHUNK_PAGE) as u64);
    }

    fn add(&mut self, addition: &AdditionRecord) -> Result<()> {
        let slid = self.msa.add_helper(addition);
        self.leaves.push(addition.canonical_commitment);
        self.mark_leaf(self.leaves.len() - 1);
        if let Some((index, chunk)) = slid {
            ensure!(
                index == self.chunks.len() as u64,
                "chunk {index} slid out of the window, expected {}",
                self.chunks.len()
            );
            self.chunk_hashes.push(Tip5::hash(&chunk));
            self.chunks.push(chunk);
            self.mark_chunk(self.chunks.len() - 1);
        }
        Ok(())
    }

    fn remove(&mut self, removal: &RemovalRecord) -> Result<()> {
        // The record carries the chunks it changes; they must be ours.
        for (index, (_, chunk)) in removal.target_chunks.iter() {
            let ours = self
                .chunks
                .get(*index as usize)
                .ok_or_else(|| anyhow!("a spend reads chunk {index}, which the archive lacks"))?;
            ensure!(ours == chunk, "chunk {index} differs from the spend's copy");
        }
        let changed = self.msa.remove_helper(removal);
        for (index, chunk) in changed {
            let i = index as usize;
            ensure!(i < self.chunks.len(), "a spend changed unknown chunk {index}");
            self.chunk_hashes[i] = Tip5::hash(&chunk);
            self.chunks[i] = chunk;
            self.mark_chunk(i);
        }
        Ok(())
    }

    /// Apply the next block. On error the archive must be discarded: a block
    /// may have been applied in part.
    pub fn apply_block(&mut self, block: RpcWalletBlock) -> Result<BlockSpends> {
        ensure!(self.expect.is_none(), "archive is still loading");
        let Decoded {
            hash,
            height,
            kernel,
        } = decode(block);
        ensure!(
            height == self.height + 1,
            "archive expected block {}, got {height}",
            self.height + 1
        );
        ensure!(
            kernel.header.prev_block_digest == self.tip_hash,
            "block {height} does not extend the archive's chain"
        );
        let MutatorSetUpdate {
            additions,
            removals,
        } = kernel
            .mutator_set_update(hash, self.network)
            .map_err(|e| anyhow!("mutator set update: {e:?}"))?;

        let spends = BlockSpends {
            height,
            ranges: crate::anonymity::spend_ranges(
                &removals,
                &kernel.body.transaction_kernel.announcements,
                self.msa.aocl.num_leafs(),
            )
            .ok()
            .map(|r| r.into_iter().flat_map(|(a, b)| [a, b]).collect()),
        };

        // The same order as the wallet's sync (and neptune-core): additions,
        // keeping the removal records current, then removals one by one.
        let mut removals = removals;
        removals.reverse();
        let mut refs: Vec<&mut RemovalRecord> = removals.iter_mut().collect();
        for addition in &additions {
            RemovalRecord::batch_update_from_addition(&mut refs, &self.msa);
            self.add(addition)?;
        }
        while let Some(removal) = refs.pop() {
            RemovalRecord::batch_update_from_remove(&mut refs, removal);
            self.remove(removal)?;
        }

        ensure!(
            msa_after(&kernel, hash)?.hash() == self.msa.hash(),
            "archive's mutator set does not match block {height}; refusing it"
        );
        self.height = height;
        self.tip_hash = hash;
        self.block_ends.push(self.leaves.len() as u64);
        Ok(spends)
    }

    /// Restore the membership proof of a coin, relative to the archive's
    /// accumulator: valid for a wallet at the same height and tip. Errors if
    /// the coin is spent (no membership proof exists for a spent coin) or is
    /// not where the caller says.
    pub fn restore(
        &self,
        item: Digest,
        sender_randomness: Digest,
        receiver_preimage: Digest,
        aocl_index: u64,
    ) -> Result<MsMembershipProof> {
        ensure!(self.expect.is_none(), "archive is still loading");
        let auth_path_aocl = mmr_path(&self.leaves, aocl_index, &self.msa.aocl.peaks())?;
        let set = AbsoluteIndexSet::compute(item, sender_randomness, receiver_preimage, aocl_index);
        let window_start = u128::from(self.msa.get_batch_index()) * u128::from(CHUNK_SIZE);
        let chunk_peaks = self.msa.swbf_inactive.peaks();
        let mut target_chunks = ChunkDictionary::default();
        for index in set.to_array() {
            if index >= window_start {
                continue;
            }
            let chunk_index = (index / u128::from(CHUNK_SIZE)) as u64;
            if target_chunks.contains_key(&chunk_index) {
                continue;
            }
            let path = mmr_path(&self.chunk_hashes, chunk_index, &chunk_peaks)?;
            let chunk = self.chunks[chunk_index as usize].clone();
            target_chunks.insert(chunk_index, (path, chunk));
        }
        let proof = MsMembershipProof {
            sender_randomness,
            receiver_preimage,
            auth_path_aocl,
            aocl_leaf_index: aocl_index,
            target_chunks,
        };
        ensure!(
            self.msa.verify(item, &proof),
            "the restored proof does not verify: the coin is spent, or not at leaf {aocl_index}"
        );
        Ok(proof)
    }

    /// Whether every index of `set` is in the Bloom filter: the coin with
    /// this index set has been spent.
    pub fn was_spent(&self, set: &AbsoluteIndexSet) -> bool {
        let window_start = u128::from(self.msa.get_batch_index()) * u128::from(CHUNK_SIZE);
        set.to_array().iter().all(|&index| {
            if index >= window_start {
                let rel = index - window_start;
                rel < u128::from(WINDOW_SIZE) && self.msa.swbf_active.contains(rel as u32)
            } else {
                let chunk_index = (index / u128::from(CHUNK_SIZE)) as usize;
                let rel = (index % u128::from(CHUNK_SIZE)) as u32;
                self.chunks
                    .get(chunk_index)
                    .is_some_and(|c| c.contains(rel))
            }
        })
    }

    /// AOCL index and block height of an addition record, if the chain has it.
    pub fn locate(&self, record: &AdditionRecord) -> Option<(u64, u64)> {
        let index = self
            .leaves
            .iter()
            .position(|l| *l == record.canonical_commitment)? as u64;
        // block_ends[h] = leaves after block h: the first block whose end is
        // past the index holds it.
        let height = self.block_ends.partition_point(|&end| end <= index) as u64;
        Some((index, height))
    }

    /// The AOCL leaves block `height` added (inclusive), if it added any.
    pub fn block_leaves(&self, height: u64) -> Option<(u64, u64)> {
        let h = height as usize;
        let end = *self.block_ends.get(h)?;
        let start = if h == 0 { 0 } else { self.block_ends[h - 1] };
        (end > start).then(|| (start, end - 1))
    }

    /// Full integrity check: the stored leaves, chunks and chunk hashes
    /// rebuild the accumulator's peaks. Takes a moment (every leaf is hashed
    /// into its tree).
    pub fn check(&self) -> Result<()> {
        ensure!(self.expect.is_none(), "archive is still loading");
        ensure!(
            self.msa.aocl.num_leafs() == self.leaves.len() as u64
                && self.msa.swbf_inactive.num_leafs() == self.chunks.len() as u64
                && self.chunk_hashes.len() == self.chunks.len()
                && self.block_ends.len() as u64 == self.height + 1
                && self.block_ends.last() == Some(&(self.leaves.len() as u64)),
            "archive counts do not add up"
        );
        for (i, (c, h)) in self.chunks.iter().zip(&self.chunk_hashes).enumerate() {
            ensure!(Tip5::hash(c) == *h, "chunk {i} does not match its hash");
        }
        ensure!(
            MmrAccumulator::new_from_leafs(self.chunk_hashes.clone()).peaks()
                == self.msa.swbf_inactive.peaks(),
            "chunks do not rebuild the Bloom filter's commitment"
        );
        ensure!(
            MmrAccumulator::new_from_leafs(self.leaves.clone()).peaks() == self.msa.aocl.peaks(),
            "leaves do not rebuild the AOCL's commitment"
        );
        Ok(())
    }

    // ------------------------------------------------------------ storage --

    pub fn dirty_pages(&self) -> (Vec<u64>, Vec<u64>) {
        (
            self.dirty_leaf_pages.iter().copied().collect(),
            self.dirty_chunk_pages.iter().copied().collect(),
        )
    }

    pub fn clear_dirty(&mut self) {
        self.dirty_leaf_pages.clear();
        self.dirty_chunk_pages.clear();
    }

    pub fn leaf_pages(&self) -> u64 {
        self.leaves.len().div_ceil(LEAF_PAGE) as u64
    }

    pub fn chunk_pages(&self) -> u64 {
        self.chunks.len().div_ceil(CHUNK_PAGE) as u64
    }

    pub fn meta_bytes(&self) -> Result<Vec<u8>> {
        Ok(bincode::serialize(&Meta {
            version: ARCHIVE_VERSION,
            network: self.network,
            height: self.height,
            tip_hash: self.tip_hash,
            msa: self.msa.clone(),
            num_leaves: self.leaves.len() as u64,
            num_chunks: self.chunks.len() as u64,
            block_ends: self.block_ends.clone(),
            chunk_hashes: self.chunk_hashes.clone(),
        })?)
    }

    pub fn leaf_page(&self, page: u64) -> Vec<u8> {
        let from = (page as usize * LEAF_PAGE).min(self.leaves.len());
        let to = (from + LEAF_PAGE).min(self.leaves.len());
        let mut out = Vec::with_capacity((to - from) * Digest::BYTES);
        for d in &self.leaves[from..to] {
            let bytes: [u8; Digest::BYTES] = (*d).into();
            out.extend_from_slice(&bytes);
        }
        out
    }

    pub fn chunk_page(&self, page: u64) -> Result<Vec<u8>> {
        let from = (page as usize * CHUNK_PAGE).min(self.chunks.len());
        let to = (from + CHUNK_PAGE).min(self.chunks.len());
        Ok(bincode::serialize(&self.chunks[from..to].to_vec())?)
    }

    /// Start loading from storage: the meta record. Then every leaf page and
    /// every chunk page in order, then [`Self::finish_load`].
    pub fn from_meta(bytes: &[u8], network: Network) -> Result<Self> {
        let m: Meta = bincode::deserialize(bytes)?;
        ensure!(m.version == ARCHIVE_VERSION, "archive version {} not supported", m.version);
        ensure!(m.network == network, "archive is for another network");
        Ok(Self {
            network,
            height: m.height,
            tip_hash: m.tip_hash,
            msa: m.msa,
            leaves: Vec::with_capacity(m.num_leaves as usize),
            chunks: Vec::with_capacity(m.num_chunks as usize),
            chunk_hashes: m.chunk_hashes,
            block_ends: m.block_ends,
            expect: Some((m.num_leaves, m.num_chunks)),
            dirty_leaf_pages: BTreeSet::new(),
            dirty_chunk_pages: BTreeSet::new(),
        })
    }

    pub fn load_leaf_page(&mut self, page: u64, bytes: &[u8]) -> Result<()> {
        ensure!(
            page as usize * LEAF_PAGE == self.leaves.len(),
            "leaf page {page} loaded out of order"
        );
        ensure!(bytes.len() % Digest::BYTES == 0, "leaf page {page} is cut");
        for b in bytes.chunks_exact(Digest::BYTES) {
            let arr: [u8; Digest::BYTES] = b.try_into().expect("exact chunk");
            self.leaves.push(
                Digest::try_from(arr).map_err(|e| anyhow!("leaf page {page}: {e:?}"))?,
            );
        }
        Ok(())
    }

    pub fn load_chunk_page(&mut self, page: u64, bytes: &[u8]) -> Result<()> {
        ensure!(
            page as usize * CHUNK_PAGE == self.chunks.len(),
            "chunk page {page} loaded out of order"
        );
        let chunks: Vec<Chunk> = bincode::deserialize(bytes)?;
        self.chunks.extend(chunks);
        Ok(())
    }

    /// Check the loaded pages against the meta record. Cheap checks only;
    /// [`Self::check`] does the full one.
    pub fn finish_load(&mut self) -> Result<()> {
        let (num_leaves, num_chunks) = self
            .expect
            .ok_or_else(|| anyhow!("archive is not loading"))?;
        ensure!(
            self.leaves.len() as u64 == num_leaves && self.chunks.len() as u64 == num_chunks,
            "archive pages are missing"
        );
        ensure!(
            self.chunk_hashes.len() as u64 == num_chunks
                && self.msa.aocl.num_leafs() == num_leaves
                && self.msa.swbf_inactive.num_leafs() == num_chunks
                && self.block_ends.len() as u64 == self.height + 1
                && self.block_ends.last() == Some(&num_leaves),
            "archive meta record is inconsistent"
        );
        ensure!(
            MmrAccumulator::new_from_leafs(self.chunk_hashes.clone()).peaks()
                == self.msa.swbf_inactive.peaks(),
            "stored chunk hashes do not match the archive's commitment"
        );
        self.expect = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use neptune_mutator_set::commit;

    use super::*;

    fn digest(n: u64) -> Digest {
        Tip5::hash(&neptune_wallet::twenty_first::math::b_field_element::BFieldElement::new(n))
    }

    /// An archive driven by random-looking additions and removals, checked
    /// against the plain accumulator and against proofs kept up to date the
    /// way the wallet keeps its own.
    #[test]
    fn archive_matches_accumulator_and_restores_proofs() {
        let mut a = Archive {
            network: Network::Main,
            height: 0,
            tip_hash: Digest::default(),
            msa: MutatorSetAccumulator::default(),
            leaves: vec![],
            chunks: vec![],
            chunk_hashes: vec![],
            block_ends: vec![0],
            expect: None,
            dirty_leaf_pages: BTreeSet::new(),
            dirty_chunk_pages: BTreeSet::new(),
        };
        let mut msa = MutatorSetAccumulator::default();
        // (item, sender randomness, receiver preimage, proof, spent)
        let mut coins: Vec<(Digest, Digest, Digest, MsMembershipProof, bool)> = vec![];

        // Enough additions for the window to slide many times (batch = 8).
        for n in 0..600u64 {
            let (item, sr, rp) = (digest(3 * n), digest(3 * n + 1), digest(3 * n + 2));
            let record = commit(item, sr, rp.hash());
            {
                // Spent proofs were intentionally no longer updated on
                // removal, so only the live proofs are valid against `msa`.
                let items: Vec<Digest> = coins.iter().filter(|c| !c.4).map(|c| c.0).collect();
                let mut proofs: Vec<&mut MsMembershipProof> =
                    coins.iter_mut().filter(|c| !c.4).map(|c| &mut c.3).collect();
                MsMembershipProof::batch_update_from_addition(&mut proofs, &items, &msa, &record)
                    .unwrap();
            }
            coins.push((item, sr, rp, msa.prove(item, sr, rp), false));
            msa.add(&record);
            a.add(&record).unwrap();

            // Every 3rd step, spend an old coin.
            if n % 3 == 2 {
                let victim = (n as usize * 7) % coins.len();
                if !coins[victim].4 {
                    let removal = msa.drop(coins[victim].0, &coins[victim].3);
                    coins[victim].4 = true;
                    {
                        let mut proofs: Vec<&mut MsMembershipProof> = coins
                            .iter_mut()
                            .filter(|c| !c.4)
                            .map(|c| &mut c.3)
                            .collect();
                        MsMembershipProof::batch_update_from_remove(&mut proofs, &removal).unwrap();
                    }
                    a.remove(&removal).unwrap();
                    msa.remove(&removal);
                }
            }
            assert_eq!(a.msa.hash(), msa.hash(), "after step {n}");
        }
        a.block_ends = vec![a.leaves.len() as u64];
        a.check().unwrap();

        for (i, (item, sr, rp, proof, spent)) in coins.iter().enumerate() {
            let set = AbsoluteIndexSet::compute(*item, *sr, *rp, i as u64);
            assert_eq!(a.was_spent(&set), *spent, "spent flag of coin {i}");
            match a.restore(*item, *sr, *rp, i as u64) {
                Ok(restored) => {
                    assert!(!spent, "a spent coin got a proof");
                    assert!(msa.verify(*item, &restored));
                    // An MMR path is unique: it must equal the one kept up to date.
                    assert_eq!(restored.auth_path_aocl, proof.auth_path_aocl, "coin {i}");
                }
                Err(_) => assert!(spent, "coin {i} could not be restored"),
            }
            let record = commit(*item, *sr, rp.hash());
            assert_eq!(a.locate(&record).map(|x| x.0), Some(i as u64));
        }

        // Round trip through storage.
        let meta = a.meta_bytes().unwrap();
        let mut b = Archive::from_meta(&meta, Network::Main).unwrap();
        for p in 0..a.leaf_pages() {
            b.load_leaf_page(p, &a.leaf_page(p)).unwrap();
        }
        for p in 0..a.chunk_pages() {
            b.load_chunk_page(p, &a.chunk_page(p).unwrap()).unwrap();
        }
        b.finish_load().unwrap();
        b.check().unwrap();
        assert_eq!(b.msa.hash(), msa.hash());
    }

    #[test]
    fn genesis_archive_matches_genesis_block() {
        let a = Archive::new(Network::Main).unwrap();
        assert_eq!(a.height(), 0);
        assert_eq!(a.tip_hash(), Block::genesis(Network::Main).hash());
        a.check().unwrap();
        assert_eq!(a.block_leaves(0), Some((0, a.num_leaves() - 1)));
    }
}
