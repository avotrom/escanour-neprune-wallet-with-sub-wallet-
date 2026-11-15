//! Succinct node module: one tip in, one verdict out.
//!
//! Holds no keys and reads no wallet data except, optionally, the public
//! mutator set accumulator the wallet has reached. Runs in its own Web Worker
//! so that verifying a proof never blocks the wallet, and so that the light
//! build of the extension can simply leave this module out.

use light_core::neptune_mutator_set::mutator_set_accumulator::MutatorSetAccumulator;
use light_core::succinct::{self, TipReport};
use light_core::{parse_network, rpc};
use wasm_bindgen::prelude::*;

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// JSON-RPC body for `chain_tip` (the tip block with its proof).
#[wasm_bindgen(js_name = tipRequest)]
pub fn tip_request(id: f64) -> String {
    rpc::request_body(id as u64, succinct::METHOD_TIP, succinct::tip_params())
}

/// First height whose blocks prove their predecessor, on `network`.
#[wasm_bindgen(js_name = activationHeight)]
pub fn activation_height(network: &str) -> Result<f64, JsError> {
    Ok(succinct::activation_height(parse_network(network).map_err(js_err)?) as f64)
}

/// Verify a `chain_tip` response. Returns the JSON of a
/// `light_core::succinct::TipReport`, with one extra field
/// `wallet_mutator_set_rejected` (see below). Throws when the tip is not
/// trustworthy.
///
/// `mutator_set` + `mutator_set_height`: the bincode-encoded mutator set
/// accumulator the wallet holds and the height it belongs to. Used only when
/// the tip is exactly one block above it, to validate the tip's own update as
/// well. If the tip fails *with* it but passes without, the tip is reported
/// as proven and `wallet_mutator_set_rejected` is true: the wallet's data,
/// not the node's tip, is what does not fit, and the hash comparison that
/// follows will say so.
#[wasm_bindgen(js_name = verifyTip)]
pub fn verify_tip(
    body: &str,
    network: &str,
    now_ms: f64,
    mutator_set: Option<Vec<u8>>,
    mutator_set_height: Option<f64>,
    anchor_hex: Option<String>,
) -> Result<String, JsError> {
    let network = parse_network(network).map_err(js_err)?;
    let block = succinct::parse_tip(body).map_err(|e| js_err(format!("{e:#}")))?;
    let anchor = match anchor_hex.as_deref().filter(|s| !s.is_empty()) {
        Some(hex) => Some(
            light_core::neptune_wallet::tasm_lib::prelude::Digest::try_from_hex(hex)
                .map_err(|e| js_err(format!("invalid trust anchor: {e}")))?,
        ),
        None => None,
    };
    let height: u64 = block.header().height.into();
    let msa: Option<MutatorSetAccumulator> = match (mutator_set, mutator_set_height) {
        (Some(bytes), Some(h)) if h >= 0.0 && (h as u64).checked_add(1) == Some(height) => {
            bincode::deserialize(&bytes).ok()
        }
        _ => None,
    };
    let now = now_ms as u64;

    let mut rejected = false;
    let report: TipReport = match &msa {
        Some(m) => match succinct::verify_tip(&block, network, now, Some(m), anchor) {
            Ok(r) => r,
            Err(_) => {
                let r = succinct::verify_tip(&block, network, now, None, anchor)
                    .map_err(|e| js_err(format!("{e:#}")))?;
                rejected = true;
                r
            }
        },
        None => succinct::verify_tip(&block, network, now, None, anchor)
            .map_err(|e| js_err(format!("{e:#}")))?,
    };

    let mut v = serde_json::to_value(&report).map_err(js_err)?;
    v["wallet_mutator_set_rejected"] = serde_json::Value::Bool(rejected);
    Ok(v.to_string())
}

/// Index of the tip to follow among JSON-encoded reports (an array), by
/// proven work since activation; -1 for an empty list.
#[wasm_bindgen(js_name = bestTip)]
pub fn best_tip(reports_json: &str) -> Result<f64, JsError> {
    let reports: Vec<TipReport> = serde_json::from_str(reports_json).map_err(js_err)?;
    Ok(succinct::best(&reports)
        .and_then(|b| reports.iter().position(|r| std::ptr::eq(r, b)))
        .map_or(-1.0, |i| i as f64))
}
