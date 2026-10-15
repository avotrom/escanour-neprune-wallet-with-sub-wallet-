# Escanour Neptune Wallet 0.22.0 — experimental private notifications

Source prototype based on the supplied 0.21.0 ZIP. See [docs/PRIVATE-NOTIFICATIONS.md](docs/PRIVATE-NOTIFICATIONS.md) for the feasibility review, protocol, usage and limitations, and [RELEASE-0.22.md](RELEASE-0.22.md) for actual validation results. Private notifications are opt-in and disabled on mainnet. Fresh WASM builds are required.

The Private controls icon beside Tor and Settings opens a compact menu with a separate Tor-style page for each feature. It groups private sending/receiving, optional fresh receiving addresses, detected-leak warnings, encrypted seed-only recovery files and scanning details. Read [docs/PRIVATE-MODE-REVIEW.md](docs/PRIVATE-MODE-REVIEW.md) for the address-linking, mixing, performance and seed-recovery analysis. No Automatic mixing control is included; address rotation does not erase past disclosure.

## Wallet overview

See [RELEASE-0.22.md](RELEASE-0.22.md) for this prototype’s validation results and build requirements. The earlier watch-only changes are documented in [RELEASE-0.21.md](RELEASE-0.21.md).

A private light wallet for [Neptune Cash](https://neptune.cash) as a Chrome extension, with no node to run and no change to Neptune.

- **Private sync.** The wallet downloads blocks by height from any public neptune-core node, scans them locally, and keeps its own membership proofs. The server learns only which heights you asked for. It never sees an address, a key, or which coins are yours.
- **Fast start.** A new wallet starts at the current tip: no history to download.
- **Proving on your device, in parallel.** A transaction's ProofCollection is split into independent jobs that run in separate Web Workers, each with its own wasm memory.
- **Uses Neptune as it is.** Only existing JSON-RPC endpoints (`chain_height`, `wallet_getBlocks`, `wallet_submitTransaction`). The only patch is a small wasm-compatibility diff applied to a vendored copy of neptune-core inside this repo.

> **Status: experimental source prototype.** Targets Neptune commit `cc3fca9`, crates 0.19. Read [RELEASE-0.22.md](RELEASE-0.22.md) for checks actually completed. The private notification mode is test-network-only and needs independent review and live-node validation. Build fresh WASM modules before installation.

## How it works

```
                 heights only                          ProofCollection
 Public node  <---------------->  Service worker  ---------------------->  Public node
 (neptune-core)  wallet_getBlocks  (light wasm)      wallet_submitTransaction  (another one)
                                       |
                        jobs (encrypted, IndexedDB)
                                       v
                              Offscreen document
                         +-----------+-----------+
                         | Worker 1  | Worker 2  | ...  each: own prover wasm, own memory
                         +-----------+-----------+
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
scripts/vendor-neptune.sh   # pinned neptune-core + wasm patch -> vendor/
scripts/check-wasm.sh       # step 0: does it compile for the browser?
scripts/build.sh            # wasm modules -> extension/pkg/
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension/` folder.

Test the same logic without a browser:

```bash
cargo run --release -p light-cli -- new-phrase
export NEPTUNE_PHRASE="..."            # 18 words
cargo run --release -p light-cli -- --network testnet init
cargo run --release -p light-cli -- --network testnet sync
cargo run --release -p light-cli -- --network testnet send <address> 1.5 0.05 --workers 4
```

The CLI prints per-proof timings, which tell you how many browser workers a machine can handle.

Full instructions: [docs/BUILD.md](docs/BUILD.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `crates/light-core` | All wallet logic: keys, sync, membership proofs, coin selection, proof jobs |
| `crates/light-wasm` | Browser bindings for light-core (no prover inside, so it loads fast) |
| `crates/prover-wasm` | One proof job per call; loaded only in proving workers |
| `crates/light-cli` | Native test harness and benchmark for light-core |
| `extension/` | Chrome MV3 extension: service worker, offscreen prover, popup |
| `patches/neptune-wasm.patch` | The wasm32 compatibility diff for neptune-core |
| `docs/` | Architecture, build, security, RPC, status |

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): design and the reasoning behind each choice
- [BUILD.md](docs/BUILD.md): toolchain, build, load, troubleshoot
- [SECURITY.md](docs/SECURITY.md): threat model and what each party learns
- [RPC.md](docs/RPC.md): the node endpoints used, exactly
- [STATUS.md](docs/STATUS.md): what is done, what is unverified, what is missing

## License

Proprietary, all rights reserved: nobody may use, copy, modify or distribute this code without written permission. See [LICENSE](LICENSE).

The sync algorithm in `light-core/src/sync.rs` and the claim construction in `light-core/src/jobs.rs` are adapted from [neptune-core](https://github.com/Neptune-Crypto/neptune-core), which stays under Apache-2.0. See [NOTICE](NOTICE).

## Build on GitHub (nothing to install)

1. Commit this project to your private GitHub repository, including `.github/workflows/build.yml`.
2. Open **Actions → build** and run the workflow if it did not start on push.
3. After all checks and the WASM build pass, download **neptune-light-extension** and load it unpacked in Chrome.

The GitHub workflow runs JavaScript syntax checks and regression tests, compilation and builds. It skips the light-core Rust unit-test step; those test sources remain available for local runs.
