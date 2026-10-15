//! Light-client wallet logic for Neptune Cash.
//!
//! Everything here is pure computation on data a public node already serves
//! through its existing JSON-RPC (`wallet_getBlocks`, `chain_height`,
//! `wallet_submitTransaction`). No network code lives in this crate: the
//! caller (browser extension or CLI) fetches JSON and hands it in.
//!
//! Privacy property: during normal use, the only things a server learns from
//! a wallet built on this crate are block heights it asks for and the
//! transaction it submits. Membership proofs are maintained locally. The one
//! exception is the opt-in fast restore in [`fast`], which the user chooses
//! knowing what the server learns.
//!
//! Beyond that: [`watch`] follows other wallets' addresses with their viewing
//! keys, [`claim`] registers coins that are never announced on-chain, and
//! [`archive`] keeps the whole archival mutator set on the device so that
//! membership proofs never have to come from a server.
//!
//! The per-block algorithm in [`sync`] is adapted from neptune-core's
//! `WalletState::process_inputs_and_outputs_maintain_mps` (Apache-2.0).

pub mod anonymity;
pub mod archive;
pub mod claim;
pub mod fast;
pub mod jobs;
pub mod keys;
pub mod privacy;
pub mod private_notification;
pub mod rpc;
pub mod send;
pub mod state;
pub mod sync;
pub mod watch;
pub mod watch_fast;

pub use neptune_consensus;
pub use neptune_mutator_set;
pub use neptune_primitives;
pub use neptune_rpc_api;
pub use neptune_wallet;
pub use neptune_wallet::triton_vm;

pub use keys::Keys;
pub use state::WalletState;

use anyhow::Result;
use neptune_primitives::network::Network;

/// Parse a network name as used by neptune-core (`main`, `testnet`,
/// `testnet-mock`, `regtest`, `testnet-<n>`).
pub fn parse_network(name: &str) -> Result<Network> {
    name.parse::<Network>().map_err(|e| anyhow::anyhow!(e))
}
