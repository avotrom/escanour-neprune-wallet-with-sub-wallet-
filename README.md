# Escanour Neptune Wallet 0.23.4 — three sub-wallets

Standard is created by default. Create Auto-refresh or Encrypted only when wanted. Each sub-wallet has its own balance, Generation and EC Hybrid addresses, activity and change. Auto-refresh advances after confirmed payments locally; Encrypted adds a hidden receiver notification and optional message on test networks.

See [docs/SUB-WALLETS.md](docs/SUB-WALLETS.md) for the current design, privacy, performance and seed recovery, [docs/PRIVATE-NOTIFICATIONS.md](docs/PRIVATE-NOTIFICATIONS.md) for wire v3, and [RELEASE-0.23.4.md](RELEASE-0.23.4.md) for validation. No address URL/service, old Private controls menu or automatic mixing is included. Privacy check is in Settings. The supplied image guides the charcoal/violet interface.

This is an experimental source prototype based on the supplied 0.21 ZIP and unchanged Neptune pin. Fresh WASM modules must be built. Encrypted mode is disabled on mainnet and needs independent review and live-node validation. GitHub Actions skips light-core unit tests; JavaScript checks, compile checks and builds remain. Local Rust tests are retained.

Recover assets offers Fast, Private scan and Own node for all three sub-wallets, with an independent remembered choice for each. Indexed sub-wallet recovery sends only that wallet’s lookups; local block scans and the node connection are shared. Encrypted receipt scanning/recovery is available only inside Encrypted. See [docs/BUG-REVIEW-0.23.1.md](docs/BUG-REVIEW-0.23.1.md) for the recovery fixes and wider bug review.

Current security fixes and remaining risks: [docs/SECURITY-REVIEW-0.23.2.md](docs/SECURITY-REVIEW-0.23.2.md). Encrypted recovery-file export is shown only inside Encrypted. Lost broadcast replies preserve the original transaction; an uncertain payment blocks new sends and recovery until resolved. The light wallet does not independently validate block proofs, proof of work or canonical-chain selection; use a trusted node.

Servers optionally chooses Node A or B for the browser session and fails over on read failure. Both URLs must be configured; transaction uploads retain uncertainty protection. Available includes Refresh assets. Recover assets has separate Payment codes and More options pages. See [docs/BUG-REVIEW-0.23.4.md](docs/BUG-REVIEW-0.23.4.md) for verified payment-code rules and remaining concerns.

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
