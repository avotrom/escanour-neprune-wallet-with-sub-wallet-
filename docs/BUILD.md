# Build

## Prerequisites

- **Current stable Rust (tested with 1.99.0).** neptune-core uses edition 2024; locked dependencies may require a newer compiler than the edition's minimum 1.85. Preserve the included `Cargo.lock`.

  ```bash
  rustup update stable
  rustup target add wasm32-unknown-unknown
  ```

- **wasm-pack.**

  ```bash
  cargo install wasm-pack
  ```

- **Chrome or Chromium 116 or newer.**
- **About 10 GB of free disk** for the Neptune dependency tree.

## 1. Vendor Neptune

```bash
scripts/vendor-neptune.sh
```

This clones neptune-core at commit `cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04` into `vendor/neptune-core` and applies `patches/neptune-wasm.patch`.

### What the patch changes

All changes are inside `#[cfg(target_arch = "wasm32")]` / `cfg(not(...))`, so native builds are identical to upstream.

| File | Change | Why |
| --- | --- | --- |
| `neptune-consensus/Cargo.toml` | tokio `process` and `rt-multi-thread` become native-only | tokio refuses those features on wasm32 |
| `neptune-consensus/src/lib.rs` | `ScopeDurationLogger` becomes a no-op on wasm | `Instant::now()` panics on wasm32-unknown-unknown; `Utxo::can_spend_at` uses this logger |
| `.../tasm/prover_job.rs` | on wasm, "out-of-process" proving runs in-process; process helpers are native-only | browsers have no child processes |
| `.../triton_vm_job_queue.rs` | current-thread runtime on wasm | no threads; this queue is never used by the wallet but must compile |
| `neptune-primitives/Cargo.toml`, `src/lib.rs` | `data_directory` (tokio `fs`, `directories`) is native-only | no filesystem; nothing the wallet uses depends on it |

### Updating to a new Neptune release

1. Change `NEPTUNE_COMMIT` in `scripts/vendor-neptune.sh`.
2. Run it. If the patch no longer applies, re-make each change listed above by hand.
3. Regenerate the patch:

   ```bash
   git -C vendor/neptune-core diff > patches/neptune-wasm.patch
   ```

## 2. Check it compiles (step 0)

```bash
scripts/check-wasm.sh
```

This runs a native check, then a wasm32 check, then lists the getrandom versions in the browser build. Each getrandom version needs its browser backend:

| Version | How it's enabled |
| --- | --- |
| 0.2 | feature `js` (set in `light-wasm` and `prover-wasm` Cargo.toml) |
| 0.3 | feature `wasm_js` plus `--cfg getrandom_backend="wasm_js"` (set via `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS`, wasm only, in `scripts/build.sh` and `scripts/check-wasm.sh`) |
| 0.4, if present | the same `wasm_js` feature: add it to both wasm crates' Cargo.toml |

If the wasm check fails, the first error names the crate. Typical causes and fixes are in STATUS.md.

## 3. Build the extension

```bash
scripts/build.sh          # release: slow to build, fast to prove
scripts/build.sh --dev    # quicker build for UI work; proving will be very slow
```

Output goes to `extension/pkg/light/` and `extension/pkg/prover/`.

## 4. Load it

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `extension/`.
3. Open the extension, create a wallet on **Testnet (mock proofs)** first. Mock-proof networks skip proving, so you can test sync and sending end to end in seconds.
4. Then validate **Testnet** with real proofs and an unchanged node. Encrypted remains disabled on mainnet. This source prototype has not completed live-node acceptance or a security review.

Debugging:

- **Service worker:** `chrome://extensions` → the extension → **service worker** → Inspect.
- **Offscreen prover:** `chrome://inspect/#other`, while proving.

## 5. Native harness (no browser)

`light-cli` runs the same light-core code natively. Use it to test sync and to benchmark proving.

```bash
cargo build --release -p light-cli
B=target/release/neptune-light

$B new-phrase
export NEPTUNE_PHRASE="word1 word2 ... word18"
$B --network testnet --server https://YOUR-TESTNET-NODE init
$B --network testnet --server https://YOUR-TESTNET-NODE sync
$B --network testnet balance
$B --network testnet address
$B --network testnet --server https://YOUR-TESTNET-NODE send <address> 1.5 0.05 --workers 4
```

`send` prints one timing line per proof and the total for the chosen worker count. Run it with `--workers 1`, `2` and `4` to see how proving time scales on your machine. Measure browser performance separately; the recorded native scan sample does not establish browser or proving times.

The CLI state file is not encrypted. Use it for testing only.
