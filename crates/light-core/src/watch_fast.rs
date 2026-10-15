//! Opt-in indexed watch scan. An index may omit history; it cannot invent a
//! receipt or spend: those are checked against the downloaded blocks locally.
use std::collections::BTreeSet;

use anyhow::{anyhow, ensure, Result};
use neptune_mutator_set::removal_record::absolute_index_set::AbsoluteIndexSet;
use neptune_primitives::{announcement_flag::AnnouncementFlag, network::Network};
use neptune_rpc_api::model::message::{
    BlockHeightsByAbsoluteIndexSetsRequest, BlockHeightsByAbsoluteIndexSetsResponse,
    BlockHeightsByFlagsRequest, BlockHeightsByFlagsResponse,
};
use neptune_wallet::tasm_lib::prelude::Digest;
use neptune_wallet::twenty_first::util_types::mmr::mmr_trait::Mmr;
use serde::{Deserialize, Serialize};

use crate::{fast, rpc, state::WalletState, sync, watch::{self, WatchAccount, WatchBlock}};

#[derive(Serialize, Deserialize)]
pub struct IndexedWatch {
    account: WatchAccount,
    network: Network,
    target: u64,
    tip: Digest,
}

impl IndexedWatch {
    pub fn new(state: &WalletState, id: u64) -> Result<Self> {
        let mut account = state.watch.iter().find(|a| a.id == id)
            .ok_or_else(|| anyhow!("Watch address no longer exists"))?.clone();
        account.coins.clear();
        account.scanned_to = account.from_height - 1;
        account.cursor_hash = None;
        Ok(Self { account, network: state.network, target: state.height, tip: state.tip_hash })
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>> { Ok(bincode::serialize(self)?) }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> { Ok(bincode::deserialize(bytes)?) }
    pub fn height(&self) -> u64 { self.target }
    pub fn found(&self) -> usize { self.account.coins.len() }

    pub fn flags_request(&self, id: u64) -> Result<String> {
        let address = self.account.key(self.network)?.address();
        let params = serde_json::to_value(BlockHeightsByFlagsRequest {
            announcement_flags: vec![AnnouncementFlag::from(&address)],
        })?;
        Ok(rpc::request_body(id, fast::METHOD_HEIGHTS_BY_FLAGS, params))
    }

    pub fn heights(&self, body: &str, spends: bool) -> Result<Vec<u64>> {
        let heights = if spends {
            rpc::result_from_envelope::<BlockHeightsByAbsoluteIndexSetsResponse>(body)?.block_heights
        } else {
            rpc::result_from_envelope::<BlockHeightsByFlagsResponse>(body)?.block_heights
        };
        Ok(heights.into_iter().map(u64::from)
            .filter(|h| *h >= self.account.from_height && *h <= self.target)
            .collect::<BTreeSet<_>>().into_iter().collect())
    }

    /// Chunk the request so a long-lived address stays below the node limit.
    pub fn spent_request(&self, id: u64, offset: usize) -> Result<Option<String>> {
        let absolute_index_sets: Vec<AbsoluteIndexSet> = self.account.coins.iter()
            .skip(offset).take(fast::MAX_INDEX_SETS_PER_CALL)
            .filter_map(|c| self.account.index_set(c)).collect();
        if absolute_index_sets.is_empty() { return Ok(None); }
        let params = serde_json::to_value(BlockHeightsByAbsoluteIndexSetsRequest { absolute_index_sets })?;
        Ok(Some(rpc::request_body(id, fast::METHOD_HEIGHTS_BY_INDEX_SETS, params)))
    }

    pub fn scan(&mut self, body: &str) -> Result<()> {
        let key = self.account.key(self.network)?;
        for block in rpc::parse_blocks(body)? {
            let d = sync::decode(block);
            if d.height < self.account.from_height || d.height > self.target { continue; }
            let update = d.kernel.mutator_set_update(d.hash, self.network)
                .map_err(|e| anyhow!("mutator set update: {e:?}"))?;
            let after = sync::msa_after(&d.kernel, d.hash)?;
            let first_leaf = after.aocl.num_leafs().checked_sub(update.additions.len() as u64)
                .ok_or_else(|| anyhow!("invalid block additions"))?;
            let spent_sets: Vec<_> = update.removals.iter().map(|r| r.absolute_indices).collect();
            let wb = WatchBlock {
                height: d.height, hash: d.hash, prev: d.kernel.header.prev_block_digest,
                timestamp_ms: d.kernel.header.timestamp.to_millis(),
                announcements: &d.kernel.body.transaction_kernel.announcements,
                additions: &update.additions, first_leaf, spent_sets: &spent_sets,
            };
            watch::scan_indexed_block(&mut self.account, &key, &wb)?;
        }
        Ok(())
    }

    /// The original anchor must still be on the server's chain. The wallet
    /// may have advanced in between chunks; normal catch-up fills that gap.
    pub fn finish(mut self, state: &mut WalletState, anchor: &str) -> Result<()> {
        ensure!(state.network == self.network && state.height >= self.target, "WATCH_TIP_MOVED");
        let anchor = rpc::parse_blocks(anchor)?.into_iter().map(sync::decode)
            .find(|b| b.height == self.target).ok_or_else(|| anyhow!("WATCH_TIP_MOVED"))?;
        ensure!(anchor.hash == self.tip, "WATCH_TIP_MOVED");
        if state.height == self.target { ensure!(state.tip_hash == self.tip, "WATCH_TIP_MOVED"); }
        let account = state.watch.iter_mut().find(|a| a.id == self.account.id
            && a.viewing_key == self.account.viewing_key)
            .ok_or_else(|| anyhow!("Watch address no longer exists"))?;
        self.account.label = account.label.clone();
        self.account.scanned_to = self.target;
        self.account.cursor_hash = Some(self.tip);
        *account = self.account;
        Ok(())
    }
}
