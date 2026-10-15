//! Proving worker module: bytes in (one `ProofJob`), bytes out (one proof).
//!
//! Each Web Worker instantiates its own copy of this module, so each job gets
//! its own wasm linear memory. That is what lets a ProofCollection run in
//! parallel without SharedArrayBuffer or cross-origin isolation, and what puts
//! the 4 GB wasm32 limit per subproof instead of per transaction.

use light_core::jobs::{self, ProofJob};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

thread_local! {
    static LAST_REPORT: std::cell::RefCell<Option<jobs::ProveReport>> = const { std::cell::RefCell::new(None) };
}

/// Prove one job. `low_memory` is "auto", "on" or "off" (see
/// `light_core::jobs::LowMemory`). Returns the bincode-encoded Triton VM
/// proof; `lastReport` then describes how it was made.
#[wasm_bindgen(js_name = proveJob)]
pub fn prove_job(job: &[u8], low_memory: Option<String>) -> Result<Vec<u8>, JsError> {
    let job = ProofJob::from_bytes(job).map_err(|e| JsError::new(&format!("{e:#}")))?;
    let mode = jobs::LowMemory::parse(low_memory.as_deref().unwrap_or("auto"));
    let (proof, report) =
        jobs::prove_with(&job, mode).map_err(|e| JsError::new(&format!("{}: {e:#}", job.label)))?;
    LAST_REPORT.with_borrow_mut(|r| *r = Some(report));
    bincode::serialize(&proof).map_err(|e| JsError::new(&e.to_string()))
}

/// JSON of the report of the last proved job, or an empty string.
#[wasm_bindgen(js_name = lastReport)]
pub fn last_report() -> String {
    LAST_REPORT.with_borrow(|r| {
        r.as_ref()
            .and_then(|r| serde_json::to_string(r).ok())
            .unwrap_or_default()
    })
}

/// The job's label, for progress display.
#[wasm_bindgen(js_name = jobLabel)]
pub fn job_label(job: &[u8]) -> Result<String, JsError> {
    ProofJob::from_bytes(job)
        .map(|j| j.label)
        .map_err(|e| JsError::new(&format!("{e:#}")))
}
