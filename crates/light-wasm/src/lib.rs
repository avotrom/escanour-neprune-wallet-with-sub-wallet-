//! Browser bindings for `light-core`.
//!
//! JavaScript does all networking and storage; this module only computes.
//! State and prepared sends cross the boundary as opaque bytes (bincode),
//! which JavaScript encrypts before storing. Numbers cross as `f64` (heights
//! and millisecond timestamps fit exactly) so JavaScript never sees BigInt.

use light_core::keys::{AddressKind, KeyRef, Keys};
use light_core::neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
use light_core::send::{self, PreparedSend, SendRequest};
use light_core::state::WalletState;
use light_core::{archive, claim, jobs, parse_network, rpc, sync, watch};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

fn js_err(e: anyhow::Error) -> JsError {
    JsError::new(&format!("{e:#}"))
}

/// "generation" / "ec-hybrid" limit a payment to coins of that address kind;
/// empty, "any" or absent: any coin.
fn parse_from(from: Option<String>) -> Result<Option<AddressKind>, JsError> {
    match from.as_deref() {
        None | Some("") | Some("any") => Ok(None),
        Some(k) => AddressKind::parse(k).map(Some).map_err(js_err),
    }
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsError::new(&e.to_string()))
}

/// `{ state: Uint8Array, [field]: value }`.
fn state_and(st: &WalletState, field: &str, value: &JsValue) -> Result<JsValue, JsError> {
    let out = js_sys::Object::new();
    let bytes = st.to_bytes().map_err(js_err)?;
    js_sys::Reflect::set(
        &out,
        &"state".into(),
        &js_sys::Uint8Array::from(bytes.as_slice()),
    )
    .map_err(|_| JsError::new("set state"))?;
    js_sys::Reflect::set(&out, &field.into(), value).map_err(|_| JsError::new("set field"))?;
    Ok(out.into())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchRegistration {
    id: u64,
    label: String,
    viewing_key: String,
    spend_key: Option<String>,
    from_height: u64,
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// A new 18-word seed phrase from 24 bytes of `crypto.getRandomValues`.
#[wasm_bindgen(js_name = phraseFromEntropy)]
pub fn phrase_from_entropy(bytes: &[u8]) -> Result<String, JsError> {
    Keys::phrase_from_entropy(bytes).map_err(js_err)
}

// ---------- JSON-RPC helpers: encodings come from neptune-rpc-api ----------

#[wasm_bindgen(js_name = rpcBody)]
pub fn rpc_body(id: f64, method: &str, params_json: &str) -> Result<String, JsError> {
    let params = serde_json::from_str(params_json).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(rpc::request_body(id as u64, method, params))
}

#[wasm_bindgen(js_name = heightRequest)]
pub fn height_request(id: f64) -> String {
    rpc::request_body(id as u64, rpc::METHOD_HEIGHT, rpc::height_params())
}

#[wasm_bindgen(js_name = parseHeight)]
pub fn parse_height(body: &str) -> Result<f64, JsError> {
    rpc::parse_height(body).map(|h| h as f64).map_err(js_err)
}

#[wasm_bindgen(js_name = getBlocksRequest)]
pub fn get_blocks_request(id: f64, from: f64, to: f64) -> Result<String, JsError> {
    let params = rpc::get_blocks_params(from as u64, to as u64).map_err(js_err)?;
    Ok(rpc::request_body(id as u64, rpc::METHOD_GET_BLOCKS, params))
}

#[wasm_bindgen(js_name = parseSubmit)]
pub fn parse_submit(body: &str) -> Result<bool, JsError> {
    rpc::parse_submit(body).map_err(js_err)
}

#[wasm_bindgen(js_name = isNotConfirmable)]
pub fn is_not_confirmable(error_text: &str) -> bool {
    rpc::is_not_confirmable(error_text)
}

#[wasm_bindgen(js_name = maxBlocksPerCall)]
pub fn max_blocks_per_call() -> f64 {
    rpc::MAX_BLOCKS_PER_CALL as f64
}

// ------------------------------- wallet -------------------------------------

#[wasm_bindgen]
pub struct LightWallet {
    keys: Keys,
}

#[derive(Serialize)]
struct Summary {
    network: String,
    height: u64,
    tip_hash: String,
    available: String,
    timelocked: String,
    pending_out: String,
    next_receiving_index: u64,
    /// Unspent coins per address kind: what each kind of address holds.
    by_kind: KindBalances,
    utxos: Vec<UtxoView>,
}

#[derive(Serialize)]
struct KindBalances {
    /// Post-quantum (generation) addresses.
    generation: String,
    /// Short (EC Hybrid) addresses.
    ec_hybrid: String,
    /// Kept for older popups; change now counts for the address that paid.
    change: String,
}

#[derive(Serialize)]
struct UtxoView {
    aocl_index: u64,
    amount: String,
    received_height: u64,
    spent_height: Option<u64>,
    reserved: bool,
    timelocked: bool,
    /// "generation", "ec-hybrid" or "change".
    kind: &'static str,
}

fn kind_name(k: KeyRef) -> &'static str {
    match k {
        KeyRef::Generation(_) => "generation",
        KeyRef::EcHybrid(_) => "ec-hybrid",
        KeyRef::Symmetric(_) => "change",
    }
}

#[derive(Serialize)]
struct PreparedView {
    tx_id: String,
    to: String,
    amount: String,
    fee: String,
    change: String,
    inputs: usize,
    /// Pass back as `pinned_inputs` when rebuilding after a stale tip.
    input_aocl_indices: Vec<u64>,
    lustrates: bool,
    mock: bool,
    job_labels: Vec<String>,
}

#[wasm_bindgen]
impl LightWallet {
    #[wasm_bindgen(constructor)]
    pub fn new(phrase: &str, network: &str) -> Result<LightWallet, JsError> {
        let network = parse_network(network).map_err(js_err)?;
        Ok(Self {
            keys: Keys::from_phrase(phrase, network).map_err(js_err)?,
        })
    }

    /// bech32m generation address at `index`.
    pub fn address(&self, index: f64) -> Result<String, JsError> {
        self.keys
            .receiving_address_string(index as u64)
            .map_err(js_err)
    }

    /// Permanent test-network app address; contains no private keys.
    #[wasm_bindgen(js_name = privateAppAddress)]
    pub fn private_app_address(&self) -> Result<String, JsError> {
        light_core::private_notification::AppAddress::for_keys(&self.keys).map_err(js_err)
    }

    /// Rotate payment keys after confirmed receipts, using one scanning key.
    #[wasm_bindgen(js_name = privateReceiveAddress)]
    pub fn private_receive_address(&self, state: &[u8], rotate: bool) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let index = if rotate {
            st.private_receive_index()
        } else {
            0
        };
        let address = light_core::private_notification::AppAddress::for_index(&self.keys, index)
            .map_err(js_err)?;
        to_js(&serde_json::json!({"index": index, "address": address, "kind": "private-app"}))
    }

    /// New wallet state starting after `block_body` (a `wallet_getBlocks`
    /// response holding exactly one block): the tip for a new wallet, or the
    /// birthday block for a restore.
    #[wasm_bindgen(js_name = stateFromBlock)]
    pub fn state_from_block(&self, block_body: &str) -> Result<Vec<u8>, JsError> {
        let mut blocks = rpc::parse_blocks(block_body).map_err(js_err)?;
        let block = blocks
            .pop()
            .ok_or_else(|| JsError::new("response contains no block"))?;
        let state = sync::state_from_block(block, self.keys.network()).map_err(js_err)?;
        state.to_bytes().map_err(js_err)
    }

    /// Apply a `wallet_getBlocks` response. Returns `{ state, result }` where
    /// `result` is `{ height, applied, reorg, events }`.
    #[wasm_bindgen(js_name = applyBlocks)]
    pub fn apply_blocks(&self, state: &[u8], blocks_body: &str) -> Result<JsValue, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let blocks = rpc::parse_blocks(blocks_body).map_err(js_err)?;
        let result = sync::apply_blocks(&mut st, &self.keys, blocks).map_err(js_err)?;
        let out = js_sys::Object::new();
        let bytes = st.to_bytes().map_err(js_err)?;
        js_sys::Reflect::set(
            &out,
            &"state".into(),
            &js_sys::Uint8Array::from(bytes.as_slice()),
        )
        .map_err(|_| JsError::new("set state"))?;
        js_sys::Reflect::set(&out, &"result".into(), &to_js(&result)?)
            .map_err(|_| JsError::new("set result"))?;
        Ok(out.into())
    }

    #[wasm_bindgen(js_name = profileState)]
    pub fn profile_state(&self, state: &[u8], profile: &str) -> Result<Vec<u8>, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let profile = light_core::profiles::Profile::parse(profile).map_err(js_err)?;
        light_core::profiles::filtered(&st, profile)
            .to_bytes()
            .map_err(js_err)
    }
    #[wasm_bindgen(js_name = profileReceiveAddress)]
    pub fn profile_receive_address(
        &self,
        state: &[u8],
        profile: &str,
        kind: &str,
    ) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let profile = light_core::profiles::Profile::parse(profile).map_err(js_err)?;
        let kind = AddressKind::parse(kind).map_err(js_err)?;
        let index = light_core::profiles::receive_index(&st, profile, kind);
        let address = if profile == light_core::profiles::Profile::Encrypted {
            light_core::private_notification::AppAddress::for_kind_index(&self.keys, kind, index)
                .map_err(js_err)?
        } else {
            self.keys
                .address(light_core::profiles::key_for(profile, kind, index).map_err(js_err)?)
                .to_bech32m(self.keys.network())
                .map_err(js_err)?
        };
        to_js(
            &serde_json::json!({"index":index,"address":address,"kind":kind.name(),"profile":profile.name()}),
        )
    }

    #[wasm_bindgen(js_name = profileAddressHistory)]
    pub fn profile_address_history(
        &self,
        state: &[u8],
        profile: &str,
        kind: &str,
        offset: u32,
    ) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let profile = light_core::profiles::Profile::parse(profile).map_err(js_err)?;
        let kind = AddressKind::parse(kind).map_err(js_err)?;
        let current = light_core::profiles::receive_index(&st, profile, kind);
        let mut history = light_core::profiles::address_history(&st, profile, kind);
        if !history.iter().any(|r| r.index == current) {
            history.insert(
                0,
                light_core::profiles::AddressHistoryEntry {
                    index: current,
                    receipts: 0,
                    first_height: 0,
                    last_height: 0,
                },
            );
        }
        let total = history.len();
        let mut rows = vec![];
        for row in history.into_iter().skip(offset as usize).take(20) {
            let address = self.profile_address_at(profile.name(), kind.name(), row.index as f64)?;
            rows.push(serde_json::json!({"index":row.index,"address":address,"current":row.index==current,"receipts":row.receipts,"firstHeight":row.first_height,"lastHeight":row.last_height}));
        }
        to_js(
            &serde_json::json!({"profile":profile.name(),"kind":kind.name(),"rows":rows,"total":total,"next":(offset as usize+20).min(total)}),
        )
    }
    #[wasm_bindgen(js_name = profileAddressAt)]
    pub fn profile_address_at(
        &self,
        profile: &str,
        kind: &str,
        index: f64,
    ) -> Result<String, JsError> {
        if !index.is_finite() || index < 0. || index.fract() != 0. || index > u32::MAX as f64 {
            return Err(JsError::new("invalid receiving index"));
        }
        let profile = light_core::profiles::Profile::parse(profile).map_err(js_err)?;
        let kind = AddressKind::parse(kind).map_err(js_err)?;
        if profile == light_core::profiles::Profile::Encrypted {
            light_core::private_notification::AppAddress::for_kind_index(
                &self.keys,
                kind,
                index as u64,
            )
            .map_err(js_err)
        } else {
            self.keys
                .address(
                    light_core::profiles::key_for(profile, kind, index as u64).map_err(js_err)?,
                )
                .to_bech32m(self.keys.network())
                .map_err(js_err)
        }
    }

    pub fn summary(&self, state: &[u8], now_ms: f64) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let now = light_core::neptune_primitives::timestamp::Timestamp::millis(now_ms as u64);
        let b = st.balance(now);
        let mut utxos: Vec<UtxoView> = st
            .utxos
            .iter()
            .map(|u| UtxoView {
                aocl_index: u.aocl_index(),
                amount: u.amount().display_lossless(),
                received_height: u.received_height,
                spent_height: u.spent_height,
                reserved: u.reserved_by.is_some(),
                timelocked: !u.utxo.can_spend_at(now),
                kind: kind_name(u.key),
            })
            .collect();
        // Per address, counted exactly like `available` (spendable now), with
        // change counted for the address that paid. So the two always add up
        // to the total.
        let origins = st.origins();
        let kind_total = |kind: AddressKind| {
            st.utxos
                .iter()
                .zip(&origins)
                .filter(|(u, o)| **o == kind && u.is_spendable(now))
                .fold(NativeCurrencyAmount::default(), |acc, (u, _)| {
                    acc + u.amount()
                })
                .display_lossless()
        };
        let by_kind = KindBalances {
            generation: kind_total(AddressKind::Generation),
            ec_hybrid: kind_total(AddressKind::EcHybrid),
            change: "0".into(),
        };
        utxos.sort_by(|a, b| b.received_height.cmp(&a.received_height));
        to_js(&Summary {
            network: st.network.to_string(),
            height: st.height,
            tip_hash: st.tip_hash.to_hex(),
            available: b.available.display_lossless(),
            timelocked: b.timelocked.display_lossless(),
            pending_out: b.pending_out.display_lossless(),
            next_receiving_index: st.next_generation_index,
            by_kind,
            utxos,
        })
    }

    /// Return `{ state, index, address }` for normal receiving.
    /// `fresh` enables rotation after confirmed receipts; opening Receive
    /// repeatedly never creates unused address gaps. False selects index 0.
    /// Returns `{ state, index, address, kind, used }`.
    #[wasm_bindgen(js_name = receiveAddress)]
    pub fn receive_address(
        &self,
        state: &[u8],
        kind: &str,
        fresh: bool,
    ) -> Result<JsValue, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let kind = AddressKind::parse(kind).map_err(js_err)?;
        let index = st.receive_index(kind, fresh);
        let address = self.keys.address_string(kind, index).map_err(js_err)?;
        let out = js_sys::Object::new();
        let bytes = st.to_bytes().map_err(js_err)?;
        let set = |k: &str, v: &JsValue| {
            js_sys::Reflect::set(&out, &k.into(), v).map_err(|_| JsError::new("set field"))
        };
        set("state", &js_sys::Uint8Array::from(bytes.as_slice()).into())?;
        set("index", &JsValue::from_f64(index as f64))?;
        set("address", &JsValue::from_str(&address))?;
        set("kind", &JsValue::from_str(kind.name()))?;
        Ok(out.into())
    }

    /// bech32m address of `kind` ("generation" or "ec-hybrid") at `index`.
    /// Needs no wallet state, so it never waits for a sync.
    #[wasm_bindgen(js_name = addressAt)]
    pub fn address_at(&self, kind: &str, index: f64) -> Result<String, JsError> {
        let kind = AddressKind::parse(kind).map_err(js_err)?;
        self.keys.address_string(kind, index as u64).map_err(js_err)
    }

    /// Largest amount sendable now with this fee (max 4 inputs).
    #[wasm_bindgen(js_name = maxSendable)]
    pub fn max_sendable(
        &self,
        state: &[u8],
        fee: &str,
        now_ms: f64,
        from_kind: Option<String>,
    ) -> Result<String, JsError> {
        let from_kind = parse_from(from_kind)?;
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let fee = send::parse_amount(fee).map_err(js_err)?;
        Ok(send::max_sendable(&st, fee, now_ms as u64, from_kind).display_lossless())
    }

    /// Build a transaction and its proof jobs. Returns
    /// `{ prepared: Uint8Array, view, jobs: Uint8Array[] }`.
    #[wasm_bindgen(js_name = prepareSend)]
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_send(
        &self,
        state: &[u8],
        to: &str,
        amount: &str,
        fee: &str,
        now_ms: f64,
        pinned_inputs: Option<Vec<f64>>,
        accept_lustration: bool,
        from_kind: Option<String>,
        private_message: Option<String>,
        profile: Option<String>,
    ) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let from_kind = parse_from(from_kind)?;
        let req = SendRequest {
            profile: light_core::profiles::Profile::parse(profile.as_deref().unwrap_or("standard"))
                .map_err(js_err)?,
            to,
            amount: send::parse_amount(amount).map_err(js_err)?,
            fee: send::parse_amount(fee).map_err(js_err)?,
            now_ms: now_ms as u64,
            pinned_inputs: pinned_inputs.map(|v| v.into_iter().map(|x| x as u64).collect()),
            accept_lustration,
            from_kind,
            private_message: private_message.as_deref(),
        };
        let prepared = send::prepare_send(&st, &self.keys, req).map_err(js_err)?;
        let jobs = prepared.jobs();
        let view = PreparedView {
            tx_id: prepared.tx_id(),
            to: prepared.to.clone(),
            amount: prepared.amount.clone(),
            fee: prepared.fee.clone(),
            change: prepared.change.clone(),
            inputs: prepared.input_aocl_indices.len(),
            input_aocl_indices: prepared.input_aocl_indices.clone(),
            lustrates: prepared.lustrates,
            mock: prepared.mock,
            job_labels: jobs.iter().map(|j| j.label.clone()).collect(),
        };

        let job_array = js_sys::Array::new();
        for j in &jobs {
            let bytes = j.to_bytes().map_err(js_err)?;
            job_array.push(&js_sys::Uint8Array::from(bytes.as_slice()));
        }
        let out = js_sys::Object::new();
        let bytes = prepared.to_bytes().map_err(js_err)?;
        js_sys::Reflect::set(
            &out,
            &"prepared".into(),
            &js_sys::Uint8Array::from(bytes.as_slice()),
        )
        .map_err(|_| JsError::new("set prepared"))?;
        js_sys::Reflect::set(&out, &"view".into(), &to_js(&view)?)
            .map_err(|_| JsError::new("set view"))?;
        js_sys::Reflect::set(&out, &"jobs".into(), &job_array)
            .map_err(|_| JsError::new("set jobs"))?;
        Ok(out.into())
    }

    /// Mark a broadcast transaction's inputs as reserved. Returns new state.
    #[wasm_bindgen(js_name = recordBroadcast)]
    pub fn record_broadcast(&self, state: &[u8], prepared: &[u8]) -> Result<Vec<u8>, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let p = PreparedSend::from_bytes(prepared).map_err(js_err)?;
        send::record_broadcast(&mut st, &p);
        st.to_bytes().map_err(js_err)
    }

    /// A new wallet state at the genesis block, holding this wallet's premine
    /// allocations (if any). A full scan starts here, so block 1 is scanned too.
    #[wasm_bindgen(js_name = genesisState)]
    pub fn genesis_state(&self) -> Result<Vec<u8>, JsError> {
        claim::genesis_state(&self.keys)
            .and_then(|s| s.to_bytes())
            .map_err(js_err)
    }

    /// Copy registrations (waiting coins, watch-only addresses) from an old
    /// state into a new one, for a rescan that starts over.
    #[wasm_bindgen(js_name = carryOver)]
    pub fn carry_over(&self, old_state: &[u8], new_state: &[u8]) -> Result<Vec<u8>, JsError> {
        let old = WalletState::from_bytes(old_state).map_err(js_err)?;
        let mut new = WalletState::from_bytes(new_state).map_err(js_err)?;
        for e in old.expected {
            claim::register(&mut new, e);
        }
        for mut w in old.watch {
            if w.scanned_to > new.height && w.scanned_to >= w.from_height {
                w.coins.clear();
                w.scanned_to = w.from_height - 1;
                w.cursor_hash = None;
            }
            if !new.watch.iter().any(|x| x.viewing_key == w.viewing_key) {
                new.watch.push(w);
            }
        }
        new.to_bytes().map_err(js_err)
    }

    /// Viewing keys of this wallet's two addresses (index 0), to follow them
    /// from another device. `spend_key` (the receiver preimage, hex) lets the
    /// other side also see spends: `{ generation: { viewing_key, spend_key },
    /// ec_hybrid: { ... } }`.
    #[wasm_bindgen(js_name = viewingKeys)]
    pub fn viewing_keys(&self) -> Result<JsValue, JsError> {
        #[derive(Serialize)]
        struct One {
            viewing_key: String,
            spend_key: String,
        }
        #[derive(Serialize)]
        struct Both {
            generation: One,
            ec_hybrid: One,
        }
        let one = |r: KeyRef| -> Result<One, JsError> {
            let k = self.keys.key(r);
            Ok(One {
                viewing_key: k
                    .to_viewing_key_bech32m(self.keys.network())
                    .map_err(js_err)?,
                spend_key: k.privacy_preimage().to_hex(),
            })
        };
        to_js(&Both {
            generation: one(KeyRef::Generation(0))?,
            ec_hybrid: one(KeyRef::EcHybrid(0))?,
        })
    }

    /// Follow another wallet's address. Returns the new state.
    #[wasm_bindgen(js_name = watchAdd)]
    pub fn watch_add(
        &self,
        state: &[u8],
        label: &str,
        viewing_key: &str,
        spend_key: Option<String>,
        from_height: f64,
    ) -> Result<Vec<u8>, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        if st.watch.len() >= watch::MAX_WATCH {
            return Err(JsError::new("too many watch-only addresses"));
        }
        let id = st.watch.iter().map(|w| w.id).max().map_or(1, |m| m + 1);
        let acc = watch::WatchAccount::new(
            id,
            label,
            viewing_key,
            spend_key.as_deref(),
            from_height as u64,
            self.keys.network(),
        )
        .map_err(js_err)?;
        if st.watch.iter().any(|w| w.viewing_key == acc.viewing_key) {
            return Err(JsError::new("this address is already watched"));
        }
        st.watch.push(acc);
        st.to_bytes().map_err(js_err)
    }

    #[wasm_bindgen(js_name = watchRemove)]
    pub fn watch_remove(&self, state: &[u8], id: f64) -> Result<Vec<u8>, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        st.watch.retain(|w| w.id != id as u64);
        st.to_bytes().map_err(js_err)
    }

    /// `[WatchView]`, see `light_core::watch::view`.
    #[wasm_bindgen(js_name = watchList)]
    pub fn watch_list(&self, state: &[u8], now_ms: f64) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let views: Vec<watch::WatchView> = st
            .watch
            .iter()
            .map(|w| watch::view(w, now_ms as u64))
            .collect();
        to_js(&views)
    }

    /// `[from, to]` blocks watch-only addresses still need, or `undefined`.
    #[wasm_bindgen(js_name = watchNeeds)]
    pub fn watch_needs(&self, state: &[u8]) -> Result<Option<Vec<f64>>, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        Ok(sync::watch_needs(&st).map(|(a, b)| vec![a as f64, b as f64]))
    }

    /// Scan a `wallet_getBlocks` response for lagging watch-only addresses.
    /// Returns `{ state, result }`.
    #[wasm_bindgen(js_name = watchCatchUp)]
    pub fn watch_catch_up(&self, state: &[u8], blocks_body: &str) -> Result<JsValue, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let blocks = rpc::parse_blocks(blocks_body).map_err(js_err)?;
        let result = sync::watch_catch_up(&mut st, blocks).map_err(js_err)?;
        state_and(&st, "result", &to_js(&result)?)
    }

    /// Durable registrations are encrypted separately from rollback snapshots.
    #[wasm_bindgen(js_name = watchRegistry)]
    pub fn watch_registry(&self, state: &[u8]) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let registrations: Vec<_> = st
            .watch
            .iter()
            .map(|a| WatchRegistration {
                id: a.id,
                label: a.label.clone(),
                viewing_key: a.viewing_key.clone(),
                spend_key: a.receiver_preimage.map(|d| d.to_hex()),
                from_height: a.from_height,
            })
            .collect();
        to_js(&registrations)
    }

    #[wasm_bindgen(js_name = watchReconcile)]
    pub fn watch_reconcile(&self, state: &[u8], registrations: &str) -> Result<Vec<u8>, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let regs: Vec<WatchRegistration> =
            serde_json::from_str(registrations).map_err(|e| JsError::new(&e.to_string()))?;
        if regs.len() > watch::MAX_WATCH {
            return Err(JsError::new("too many watch-only addresses"));
        }
        let mut accounts = Vec::with_capacity(regs.len());
        for r in regs {
            let fresh = watch::WatchAccount::new(
                r.id,
                &r.label,
                &r.viewing_key,
                r.spend_key.as_deref(),
                r.from_height,
                self.keys.network(),
            )
            .map_err(js_err)?;
            if accounts.iter().any(|a: &watch::WatchAccount| {
                a.id == fresh.id || a.viewing_key == fresh.viewing_key
            }) {
                return Err(JsError::new("this address is already watched"));
            }
            let previous = st.watch.iter().find(|a| {
                a.id == fresh.id
                    && a.viewing_key == fresh.viewing_key
                    && a.from_height == fresh.from_height
                    && a.receiver_preimage == fresh.receiver_preimage
            });
            let mut account = previous.cloned().unwrap_or_else(|| fresh.clone());
            account.label = fresh.label;
            if account.scanned_to > st.height && account.scanned_to >= account.from_height {
                account.coins.clear();
                account.scanned_to = account.from_height - 1;
                account.cursor_hash = None;
            }
            accounts.push(account);
        }
        st.watch = accounts;
        st.to_bytes().map_err(js_err)
    }

    /// Paused accounts retain their cursor even when the main wallet advances.
    #[wasm_bindgen(js_name = applyBlocksWatching)]
    pub fn apply_blocks_watching(
        &self,
        state: &[u8],
        body: &str,
        ids: &str,
    ) -> Result<JsValue, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let ids: Vec<u64> = serde_json::from_str(ids).map_err(|e| JsError::new(&e.to_string()))?;
        let all = st.watch.clone();
        st.watch.retain(|a| ids.contains(&a.id));
        let result = sync::apply_blocks(
            &mut st,
            &self.keys,
            rpc::parse_blocks(body).map_err(js_err)?,
        )
        .map_err(js_err)?;
        let scanned = std::mem::take(&mut st.watch);
        st.watch = all
            .into_iter()
            .map(|a| scanned.iter().find(|b| a.id == b.id).cloned().unwrap_or(a))
            .collect();
        state_and(&st, "result", &to_js(&result)?)
    }

    #[wasm_bindgen(js_name = watchCatchUpFor)]
    pub fn watch_catch_up_for(
        &self,
        state: &[u8],
        body: &str,
        ids: &str,
    ) -> Result<JsValue, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let ids: Vec<u64> = serde_json::from_str(ids).map_err(|e| JsError::new(&e.to_string()))?;
        let all = st.watch.clone();
        st.watch.retain(|a| ids.contains(&a.id));
        let result = sync::watch_catch_up(&mut st, rpc::parse_blocks(body).map_err(js_err)?)
            .map_err(js_err)?;
        let scanned = std::mem::take(&mut st.watch);
        st.watch = all
            .into_iter()
            .map(|a| scanned.iter().find(|b| a.id == b.id).cloned().unwrap_or(a))
            .collect();
        state_and(&st, "result", &to_js(&result)?)
    }

    /// Read a payment notification (`utxo...`) without registering it.
    #[wasm_bindgen(js_name = claimDecode)]
    pub fn claim_decode(&self, state: &[u8], text: &str) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let e = claim::decode_notification(text, &self.keys, &st).map_err(js_err)?;
        to_js(&claim::claim_view(&st, &e))
    }

    /// Register a payment notification. Returns `{ state, claim }`; the
    /// claim's `status` is what it was before (`new`, `waiting`, `owned`).
    #[wasm_bindgen(js_name = claimRegister)]
    pub fn claim_register(&self, state: &[u8], text: &str) -> Result<JsValue, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let e = claim::decode_notification(text, &self.keys, &st).map_err(js_err)?;
        let view = claim::claim_view(&st, &e);
        claim::register(&mut st, e);
        state_and(&st, "claim", &to_js(&view)?)
    }

    /// Forget a waiting coin. Returns the new state.
    #[wasm_bindgen(js_name = claimRemove)]
    pub fn claim_remove(&self, state: &[u8], addition_record: &str) -> Result<Vec<u8>, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        claim::unregister(&mut st, addition_record);
        st.to_bytes().map_err(js_err)
    }

    /// Coins registered and still waiting for their block: `[ClaimView]`.
    #[wasm_bindgen(js_name = expectedList)]
    pub fn expected_list(&self, state: &[u8]) -> Result<JsValue, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        let views: Vec<claim::ClaimView> = st
            .expected
            .iter()
            .map(|e| claim::claim_view(&st, e))
            .collect();
        to_js(&views)
    }

    /// How many premine allocations are locked to generation key `index`
    /// (0 to 9). One key per call, for a progress bar.
    #[wasm_bindgen(js_name = premineForKey)]
    pub fn premine_for_key(&self, index: f64) -> Result<f64, JsError> {
        let found = claim::premine_for_key(&self.keys, index as u64).map_err(js_err)?;
        Ok(found.len() as f64)
    }

    /// Register this wallet's premine allocations as waiting coins: those of
    /// the generation keys `indices`, or of all ten when absent. Returns
    /// `{ state, found }` (`found`: how many were new).
    #[wasm_bindgen(js_name = registerPremine)]
    pub fn register_premine(
        &self,
        state: &[u8],
        indices: Option<Vec<f64>>,
    ) -> Result<JsValue, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let idx: Option<Vec<u64>> = indices.map(|v| v.into_iter().map(|x| x as u64).collect());
        let n = claim::register_premine(&mut st, &self.keys, idx.as_deref()).map_err(js_err)?;
        state_and(&st, "found", &JsValue::from_f64(n as f64))
    }

    /// Sizes of the chain as the wallet's accumulator sees them, for the
    /// archive's size estimate: `{ height, aocl_leaves, chunks, active }`.
    #[wasm_bindgen(js_name = chainCounts)]
    pub fn chain_counts(&self, state: &[u8]) -> Result<JsValue, JsError> {
        use light_core::neptune_wallet::twenty_first::util_types::mmr::mmr_trait::Mmr;
        #[derive(Serialize)]
        struct Counts {
            height: u64,
            aocl_leaves: u64,
            chunks: u64,
            active: u64,
        }
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        to_js(&Counts {
            height: st.height,
            aocl_leaves: st.msa.aocl.num_leafs(),
            chunks: st.msa.swbf_inactive.num_leafs(),
            active: st.msa.swbf_active.sbf.len() as u64,
        })
    }

    /// Waiting coins the chain already holds become owned, with proofs
    /// restored from the local archive and carried to the wallet's block
    /// through `blocks_body` (`wallet_getBlocks` for the archive's height + 1
    /// up to the wallet's height; `undefined` when they are equal). Returns
    /// `{ state, adopted }`.
    #[wasm_bindgen(js_name = adoptFromArchive)]
    pub fn adopt_from_archive(
        &self,
        state: &[u8],
        archive: &ArchiveJs,
        blocks_body: Option<String>,
    ) -> Result<JsValue, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        let blocks = match blocks_body {
            Some(b) => rpc::parse_blocks(&b).map_err(js_err)?,
            None => vec![],
        };
        let adopted = claim::adopt_from_archive(&mut st, &archive.inner, blocks).map_err(js_err)?;
        state_and(&st, "adopted", &to_js(&adopted)?)
    }

    /// Free inputs of transactions not mined after `max_age` blocks.
    #[wasm_bindgen(js_name = releaseStale)]
    pub fn release_stale(&self, state: &[u8], max_age: f64) -> Result<Vec<u8>, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        st.release_stale_reservations(max_age as u64);
        st.to_bytes().map_err(js_err)
    }
}

/// Assemble proofs (bincode, job order) into the `wallet_submitTransaction`
/// request body.
#[wasm_bindgen(js_name = submitRequest)]
pub fn submit_request(id: f64, prepared: &[u8], proofs: js_sys::Array) -> Result<String, JsError> {
    let p = PreparedSend::from_bytes(prepared).map_err(js_err)?;
    let mut decoded = Vec::with_capacity(proofs.length() as usize);
    for v in proofs.iter() {
        let bytes = js_sys::Uint8Array::new(&v).to_vec();
        let proof = bincode::deserialize(&bytes).map_err(|e| JsError::new(&e.to_string()))?;
        decoded.push(proof);
    }
    let tx = send::finish(&p, decoded).map_err(js_err)?;
    let params = rpc::submit_params(tx).map_err(js_err)?;
    Ok(rpc::request_body(
        id as u64,
        rpc::METHOD_SUBMIT_TRANSACTION,
        params,
    ))
}

/// Number of proof jobs a prepared send needs (0 on mock-proof networks).
#[wasm_bindgen(js_name = jobCount)]
pub fn job_count(prepared: &[u8]) -> Result<usize, JsError> {
    let p = PreparedSend::from_bytes(prepared).map_err(js_err)?;
    Ok(p.jobs().len())
}

/// Re-derive one job's bytes from a prepared send (used after a service
/// worker restart, so jobs never need to be kept around).
#[wasm_bindgen(js_name = jobBytes)]
pub fn job_bytes(prepared: &[u8], index: usize) -> Result<Vec<u8>, JsError> {
    let p = PreparedSend::from_bytes(prepared).map_err(js_err)?;
    let jobs = p.jobs();
    let j = jobs
        .get(index)
        .ok_or_else(|| JsError::new("job index out of range"))?;
    jobs::ProofJob::to_bytes(j).map_err(js_err)
}

/// QR code as an SVG string. bech32m addresses are upper-cased first so the
/// QR uses alphanumeric mode, which holds about 45% more characters; wallets
/// read bech32m case-insensitively. Errors if the data is too long for one QR.
#[wasm_bindgen(js_name = qrSvg)]
pub fn qr_svg(text: &str, dark: &str, light: &str) -> Result<String, JsError> {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};
    let upper = text.trim().to_uppercase();
    let code = QrCode::with_error_correction_level(upper.as_bytes(), EcLevel::L).map_err(|e| {
        JsError::new(&format!(
            "too long for one QR code ({} characters): {e}",
            upper.len()
        ))
    })?;
    Ok(code
        .render::<svg::Color>()
        .quiet_zone(true)
        .dark_color(svg::Color(dark))
        .light_color(svg::Color(light))
        .build())
}

/// Read a QR code from a greyscale picture (`luma`: one byte per pixel, row by
/// row). Returns the text of the first code found.
#[wasm_bindgen(js_name = qrDecode)]
pub fn qr_decode(width: u32, height: u32, luma: &[u8]) -> Result<String, JsError> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || luma.len() < w * h {
        return Err(JsError::new("picture is empty"));
    }
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| luma[y * w + x]);
    for grid in img.detect_grids() {
        if let Ok((_meta, content)) = grid.decode() {
            return Ok(content);
        }
    }
    Err(JsError::new("no QR code found in this picture"))
}

/// What kind of address `text` is, for the recipient field.
/// Returns `{ valid, kind, error }`; `kind` is "generation" or "ec-hybrid".
#[wasm_bindgen(js_name = addressInfo)]
pub fn address_info(text: &str, network: &str) -> Result<JsValue, JsError> {
    #[derive(Serialize)]
    struct Info {
        valid: bool,
        kind: Option<&'static str>,
        error: Option<String>,
    }
    let network = parse_network(network).map_err(js_err)?;
    let info = match send::parse_destination(text, network).and_then(|a| a.kind()) {
        Ok(k) => Info {
            valid: true,
            kind: Some(k.name()),
            error: None,
        },
        Err(e) => Info {
            valid: false,
            kind: None,
            error: Some(e.to_string()),
        },
    };
    to_js(&info)
}

/// Height and timestamp of the single block in a `wallet_getBlocks`
/// response: `{ height, timestamp_ms }`. Used to find the block at a date.
#[wasm_bindgen(js_name = blockInfo)]
pub fn block_info(body: &str) -> Result<JsValue, JsError> {
    #[derive(Serialize)]
    struct Info {
        height: u64,
        timestamp_ms: u64,
    }
    let block = rpc::parse_blocks(body)
        .map_err(js_err)?
        .pop()
        .ok_or_else(|| JsError::new("response contains no block"))?;
    let (height, timestamp_ms) = sync::block_info(block);
    to_js(&Info {
        height,
        timestamp_ms,
    })
}

/// Anonymity of each unspent coin, measured from the mutator set: how many
/// coins a spend of it could be confused with now and once its range is
/// complete, and whether spending it would publish its amount.
///
/// `spends`, when given, holds the spend intervals `[lo, hi, lo, hi, ...]` of
/// every block from 1 to the state's height; each coin then also gets its
/// exact anonymity count (`light_core::anonymity`).
#[wasm_bindgen(js_name = privacyReport)]
pub fn privacy_report(
    state: &[u8],
    now_ms: f64,
    spends: Option<Vec<f64>>,
) -> Result<JsValue, JsError> {
    let st = WalletState::from_bytes(state).map_err(js_err)?;
    let pairs: Option<Vec<(u64, u64)>> = spends.map(|flat| {
        flat.chunks_exact(2)
            .map(|p| (p[0] as u64, p[1] as u64))
            .collect()
    });
    to_js(&light_core::privacy::report_exact(
        &st,
        now_ms as u64,
        pairs.as_deref(),
    ))
}

/// Spend intervals of the blocks in a `wallet_getBlocks` response, without
/// wallet state: `[{ height, ranges }]`, `ranges` null when a block's could
/// not be computed. Used to fill in blocks the wallet did not scan.
#[wasm_bindgen(js_name = spendRanges)]
pub fn spend_ranges(body: &str, network: &str) -> Result<JsValue, JsError> {
    let network = parse_network(network).map_err(js_err)?;
    let blocks = rpc::parse_blocks(body).map_err(js_err)?;
    let out: Vec<sync::BlockSpends> = blocks
        .into_iter()
        .map(|b| sync::block_spends(b, network))
        .collect();
    to_js(&out)
}

/// Fast restore through a node's UTXO index (see `light_core::fast`). The
/// extension drives it step by step and does the network requests.
#[wasm_bindgen(js_name = FastRestore)]
pub struct FastRestoreJs {
    inner: light_core::fast::FastRestore,
}

#[wasm_bindgen(js_class = FastRestore)]
impl FastRestoreJs {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FastRestoreJs {
        FastRestoreJs {
            inner: light_core::fast::FastRestore::new(),
        }
    }

    /// The next heights-by-flags request, or `undefined` when done.
    #[wasm_bindgen(js_name = flagsRequest)]
    pub fn flags_request(
        &mut self,
        wallet: &LightWallet,
        id: f64,
    ) -> Result<Option<String>, JsError> {
        self.inner
            .flags_request(&wallet.keys, id as u64)
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = heightsToFetch)]
    pub fn heights_to_fetch(&self, body: &str) -> Result<Vec<f64>, JsError> {
        Ok(self
            .inner
            .heights_to_fetch(body)
            .map_err(js_err)?
            .into_iter()
            .map(|h| h as f64)
            .collect())
    }

    /// Scan a `wallet_getBlocks` response; returns how many new coins it held.
    #[wasm_bindgen(js_name = scanBlocks)]
    pub fn scan_blocks(&mut self, wallet: &LightWallet, body: &str) -> Result<u32, JsError> {
        Ok(self.inner.scan_blocks(&wallet.keys, body).map_err(js_err)? as u32)
    }

    #[wasm_bindgen(js_name = restoreChunks)]
    pub fn restore_chunks(&self) -> u32 {
        self.inner.restore_chunks() as u32
    }

    #[wasm_bindgen(js_name = resetProofs)]
    pub fn reset_proofs(&mut self) {
        self.inner.reset_proofs();
    }

    #[wasm_bindgen(js_name = restoreRequest)]
    pub fn restore_request(&self, id: f64, chunk: u32) -> Result<String, JsError> {
        self.inner
            .restore_request(id as u64, chunk as usize)
            .map_err(js_err)
    }

    /// Errors with a message containing `TIP_MOVED` when the node's tip moved
    /// between chunks: call `resetProofs` and request every chunk again.
    #[wasm_bindgen(js_name = applyRestore)]
    pub fn apply_restore(&mut self, chunk: u32, body: &str) -> Result<(), JsError> {
        self.inner
            .apply_restore(chunk as usize, body)
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = spentRequest)]
    pub fn spent_request(&self, id: f64) -> Result<Option<String>, JsError> {
        self.inner.spent_request(id as u64).map_err(js_err)
    }

    #[wasm_bindgen(js_name = parseSpentHeights)]
    pub fn parse_spent_heights(&self, body: &str) -> Result<Vec<f64>, JsError> {
        Ok(self
            .inner
            .parse_spent_heights(body)
            .map_err(js_err)?
            .into_iter()
            .map(|h| h as f64)
            .collect())
    }

    #[wasm_bindgen(js_name = scanSpends)]
    pub fn scan_spends(&mut self, wallet: &LightWallet, body: &str) -> Result<(), JsError> {
        self.inner
            .scan_spends(wallet.keys.network(), body)
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = snapshotHeight)]
    pub fn snapshot_height(&self) -> Option<f64> {
        self.inner.snapshot_height().map(|h| h as f64)
    }

    pub fn progress(&self) -> Result<JsValue, JsError> {
        to_js(&self.inner.progress())
    }

    /// `{ state, height, events }` from the snapshot block (`wallet_getBlocks`
    /// for exactly `snapshotHeight()`, or for the tip when no coin was found).
    pub fn finish(&self, wallet: &LightWallet, block_body: &str) -> Result<JsValue, JsError> {
        let (state, events) = self
            .inner
            .finish(wallet.keys.network(), block_body)
            .map_err(js_err)?;
        let out = js_sys::Object::new();
        let bytes = state.to_bytes().map_err(js_err)?;
        js_sys::Reflect::set(
            &out,
            &"state".into(),
            &js_sys::Uint8Array::from(bytes.as_slice()),
        )
        .map_err(|_| JsError::new("set state"))?;
        js_sys::Reflect::set(
            &out,
            &"height".into(),
            &JsValue::from_f64(state.height as f64),
        )
        .map_err(|_| JsError::new("set height"))?;
        js_sys::Reflect::set(&out, &"events".into(), &to_js(&events)?)
            .map_err(|_| JsError::new("set events"))?;
        Ok(out.into())
    }
}

impl Default for FastRestoreJs {
    fn default() -> Self {
        Self::new()
    }
}

/// The local archival mutator set (see `light_core::archive`). The extension
/// stores its pages and feeds it blocks in order.
#[wasm_bindgen(js_name = Archive)]
pub struct ArchiveJs {
    inner: archive::Archive,
}

#[derive(Serialize)]
struct Pages {
    leaves: Vec<u64>,
    chunks: Vec<u64>,
}

#[wasm_bindgen(js_class = Archive)]
impl ArchiveJs {
    /// A new archive holding the genesis block.
    #[wasm_bindgen(constructor)]
    pub fn new(network: &str) -> Result<ArchiveJs, JsError> {
        let network = parse_network(network).map_err(js_err)?;
        Ok(Self {
            inner: archive::Archive::new(network).map_err(js_err)?,
        })
    }

    /// Start loading a stored archive; then `loadLeafPage` / `loadChunkPage`
    /// for every page in order, then `finishLoad`.
    #[wasm_bindgen(js_name = fromMeta)]
    pub fn from_meta(meta: &[u8], network: &str) -> Result<ArchiveJs, JsError> {
        let network = parse_network(network).map_err(js_err)?;
        Ok(Self {
            inner: archive::Archive::from_meta(meta, network).map_err(js_err)?,
        })
    }

    #[wasm_bindgen(js_name = loadLeafPage)]
    pub fn load_leaf_page(&mut self, page: f64, bytes: &[u8]) -> Result<(), JsError> {
        self.inner
            .load_leaf_page(page as u64, bytes)
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = loadChunkPage)]
    pub fn load_chunk_page(&mut self, page: f64, bytes: &[u8]) -> Result<(), JsError> {
        self.inner
            .load_chunk_page(page as u64, bytes)
            .map_err(js_err)
    }

    #[wasm_bindgen(js_name = finishLoad)]
    pub fn finish_load(&mut self) -> Result<(), JsError> {
        self.inner.finish_load().map_err(js_err)
    }

    /// Apply a `wallet_getBlocks` response, blocks in order from the next
    /// height. Returns their spend intervals `[{ height, ranges }]`. After an
    /// error, discard this object and load the archive again.
    #[wasm_bindgen(js_name = applyBlocks)]
    pub fn apply_blocks(&mut self, blocks_body: &str) -> Result<JsValue, JsError> {
        let blocks = rpc::parse_blocks(blocks_body).map_err(js_err)?;
        let mut spends = Vec::with_capacity(blocks.len());
        for b in blocks {
            spends.push(self.inner.apply_block(b).map_err(js_err)?);
        }
        to_js(&spends)
    }

    pub fn height(&self) -> f64 {
        self.inner.height() as f64
    }

    #[wasm_bindgen(js_name = tipHash)]
    pub fn tip_hash(&self) -> String {
        self.inner.tip_hash().to_hex()
    }

    #[wasm_bindgen(js_name = sizeBytes)]
    pub fn size_bytes(&self) -> f64 {
        self.inner.size_bytes() as f64
    }

    #[wasm_bindgen(js_name = numLeaves)]
    pub fn num_leaves(&self) -> f64 {
        self.inner.num_leaves() as f64
    }

    #[wasm_bindgen(js_name = leafPages)]
    pub fn leaf_pages(&self) -> f64 {
        self.inner.leaf_pages() as f64
    }

    #[wasm_bindgen(js_name = chunkPages)]
    pub fn chunk_pages(&self) -> f64 {
        self.inner.chunk_pages() as f64
    }

    #[wasm_bindgen(js_name = metaBytes)]
    pub fn meta_bytes(&self) -> Result<Vec<u8>, JsError> {
        self.inner.meta_bytes().map_err(js_err)
    }

    #[wasm_bindgen(js_name = leafPage)]
    pub fn leaf_page(&self, page: f64) -> Vec<u8> {
        self.inner.leaf_page(page as u64)
    }

    #[wasm_bindgen(js_name = chunkPage)]
    pub fn chunk_page(&self, page: f64) -> Result<Vec<u8>, JsError> {
        self.inner.chunk_page(page as u64).map_err(js_err)
    }

    /// Pages changed since the last `clearDirty`: `{ leaves, chunks }`.
    #[wasm_bindgen(js_name = dirtyPages)]
    pub fn dirty_pages(&self) -> Result<JsValue, JsError> {
        let (leaves, chunks) = self.inner.dirty_pages();
        to_js(&Pages { leaves, chunks })
    }

    #[wasm_bindgen(js_name = clearDirty)]
    pub fn clear_dirty(&mut self) {
        self.inner.clear_dirty();
    }

    /// Full integrity check (every chunk and leaf rebuilt into the
    /// accumulator's commitments).
    pub fn check(&self) -> Result<(), JsError> {
        self.inner.check().map_err(js_err)
    }
}

/// Opt-in watch-only index scan; checkpoint bytes never leave encrypted storage.
#[wasm_bindgen(js_name = WatchFastScan)]
pub struct WatchFastScanJs {
    inner: light_core::watch_fast::IndexedWatch,
}

#[wasm_bindgen(js_class = WatchFastScan)]
impl WatchFastScanJs {
    #[wasm_bindgen(constructor)]
    pub fn new(state: &[u8], id: f64) -> Result<WatchFastScanJs, JsError> {
        let st = WalletState::from_bytes(state).map_err(js_err)?;
        Ok(Self {
            inner: light_core::watch_fast::IndexedWatch::new(&st, id as u64).map_err(js_err)?,
        })
    }
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<WatchFastScanJs, JsError> {
        Ok(Self {
            inner: light_core::watch_fast::IndexedWatch::from_bytes(bytes).map_err(js_err)?,
        })
    }
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Result<Vec<u8>, JsError> {
        self.inner.to_bytes().map_err(js_err)
    }
    pub fn height(&self) -> f64 {
        self.inner.height() as f64
    }
    pub fn found(&self) -> f64 {
        self.inner.found() as f64
    }
    #[wasm_bindgen(js_name = flagsRequest)]
    pub fn flags_request(&self, id: f64) -> Result<String, JsError> {
        self.inner.flags_request(id as u64).map_err(js_err)
    }
    pub fn heights(&self, body: &str, spends: bool) -> Result<Vec<f64>, JsError> {
        Ok(self
            .inner
            .heights(body, spends)
            .map_err(js_err)?
            .into_iter()
            .map(|h| h as f64)
            .collect())
    }
    #[wasm_bindgen(js_name = spentRequest)]
    pub fn spent_request(&self, id: f64, offset: f64) -> Result<Option<String>, JsError> {
        self.inner
            .spent_request(id as u64, offset as usize)
            .map_err(js_err)
    }
    pub fn scan(&mut self, body: &str) -> Result<(), JsError> {
        self.inner.scan(body).map_err(js_err)
    }
    pub fn finish(self, state: &[u8], anchor: &str) -> Result<Vec<u8>, JsError> {
        let mut st = WalletState::from_bytes(state).map_err(js_err)?;
        self.inner.finish(&mut st, anchor).map_err(js_err)?;
        st.to_bytes().map_err(js_err)
    }
}
