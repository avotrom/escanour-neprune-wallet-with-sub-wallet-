//! Helpers for neptune-core's existing JSON-RPC (POST `/`, JSON-RPC 2.0).
//!
//! Method names are `<namespace>_<method>` in camelCase, and request params
//! are positional arrays. Parameters are produced here with neptune-rpc-api's
//! own request types, so their encoding always matches the node's.
//!
//! Methods used by the light wallet (all public, none needs secrets):
//! - `chain_height`              current tip height
//! - `wallet_getBlocks`          blocks without proofs (kernel + proof leaf)
//! - `wallet_submitTransaction`  broadcast a ProofCollection-backed transaction

use anyhow::{anyhow, Context, Result};
use neptune_rpc_api::model::message::{
    GetBlocksRequest, GetBlocksResponse, HeightResponse, SubmitTransactionRequest,
    SubmitTransactionResponse,
};
use neptune_rpc_api::model::wallet::block::RpcWalletBlock;
use neptune_rpc_api::model::wallet::transaction::RpcTransaction;
use serde::de::DeserializeOwned;
use serde_json::Value;

pub const METHOD_HEIGHT: &str = "chain_height";
pub const METHOD_GET_BLOCKS: &str = "wallet_getBlocks";
pub const METHOD_SUBMIT_TRANSACTION: &str = "wallet_submitTransaction";

/// Most blocks a node returns per `wallet_getBlocks` call unless it runs with
/// `--unsafe-rpc`.
pub const MAX_BLOCKS_PER_CALL: u64 = 100;

/// Extract `result` from a JSON-RPC response body, or turn `error` into an
/// error that keeps the node's message.
pub fn result_from_envelope<T: DeserializeOwned>(body: &str) -> Result<T> {
    let mut v: Value = serde_json::from_str(body).context("response is not JSON")?;
    if let Some(err) = v.get("error") {
        return Err(anyhow!("node returned an error: {err}"));
    }
    let result = v
        .get_mut("result")
        .map(Value::take)
        .ok_or_else(|| anyhow!("response has neither result nor error"))?;
    Ok(serde_json::from_value(result)?)
}

/// Build a full JSON-RPC request body.
pub fn request_body(id: u64, method: &str, params: Value) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
        .to_string()
}

pub fn height_params() -> Value {
    Value::Array(vec![])
}

pub fn parse_height(body: &str) -> Result<u64> {
    let r: HeightResponse = result_from_envelope(body)?;
    Ok(r.height.into())
}

pub fn get_blocks_params(from: u64, to: u64) -> Result<Value> {
    if from == 0 {
        return Err(anyhow!("wallet_getBlocks never returns the genesis block"));
    }
    let req = GetBlocksRequest {
        from_height: from.into(),
        to_height: to.into(),
    };
    Ok(serde_json::to_value(req)?)
}

pub fn parse_blocks(body: &str) -> Result<Vec<RpcWalletBlock>> {
    let r: GetBlocksResponse = result_from_envelope(body)?;
    Ok(r.blocks)
}

pub fn submit_params(tx: RpcTransaction) -> Result<Value> {
    Ok(serde_json::to_value(SubmitTransactionRequest {
        transaction: tx,
    })?)
}

/// `Ok(true)` when the node accepted the transaction into its mempool.
pub fn parse_submit(body: &str) -> Result<bool> {
    let r: SubmitTransactionResponse = result_from_envelope(body)?;
    Ok(r.success)
}

/// True when a submit error means "built against an old tip": the fix is to
/// rebuild against the new tip and prove again.
pub fn is_not_confirmable(error_text: &str) -> bool {
    let t = error_text.to_ascii_lowercase();
    t.contains("confirmable") || t.contains("mutator set") || t.contains("too old")
}
