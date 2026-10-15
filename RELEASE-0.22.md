# 0.22.0-alpha.1 — private notification source prototype

This source extends the supplied 0.21.0 wallet without upgrading its pinned Neptune dependency. Private notifications are opt-in and disabled on mainnet in both JavaScript and Rust. Fresh WASM modules must be built; the source ZIP is not an install-ready extension.

## Resulting behavior

- A dedicated Private controls icon sits beside Tor and Settings. It opens a compact menu of titles and status indicators. Each feature has its own Tor-style page with a centered icon, green/red status dot, main control and expandable details. It includes private Send/Receive, block progress, receiving controls, leak alerts and encrypted recovery files. Normal sending remains available in the same wallet. The watchlist appears only on Watch-only. Addresses has a fresh-address settings shortcut and, when enabled, a refresh action that checks confirmed receipts without burning unused address indices. Send/Receive show short mode indicators; advanced fields and explanations are expandable.
- `nescan1…` addresses require the custom private notification path. Compatible senders suppress the ordinary destination announcement, wrap the existing payment notification with a libsodium-compatible sealed box, and attach it before witness/proof generation. Failure does not fall back to a public notification.
- Optional messages are limited to 512 UTF-8 bytes and share the fixed 4096-byte padded plaintext. Incoming text is untrusted, rendered as text and excluded from desktop notifications. Messages and local notes are vault-encrypted at rest. Saving sensitive send fields while locked fails closed.
- Optional Fresh receiving addresses rotates normal and private payment keys after confirmed receipts; opening Receive repeatedly does not create unused gaps. Old addresses keep working. Private v2 envelopes carry the receiving-child index inside encryption, preserving recovery with one outer scanning key even beyond the normal gap.
- Private addresses share a public scanning key and are linkable to someone holding multiple complete addresses. Rotation does not isolate funds or guarantee anonymity. Standard and private receiving keys are distinct; spending and change remain shared.
- Receipts with a detected standard notice to a private key are credited and warned about, including when both notification formats accompany the same coin. Optional automatic address rotation responds to that warning without moving funds. No Automatic mixing control is included. Self-transfers cannot erase disclosure and no reviewed mixing protocol is integrated.
- An optional portable encrypted seed-only recovery JSON can be exported after password verification and imported in Restore. It uses WebCrypto PBKDF2-SHA256 (600,000 iterations), AES-256-GCM, fresh salt/IV and authenticated format metadata. It excludes labels, outgoing message copies and unfinished sends. A separately saved seed remains sufficient for confirmed funds and received messages with the same network, compatible app and chain scan.
- Test-network restores use full local scans rather than receiver-ID indexing. A known earliest wallet block can reduce the scan; a later start omits earlier coins. The node source setting is preserved.

The public notification marker is unchanged as a family marker; new writers emit experimental address/envelope version 2. Readers accept the earlier experimental version 1 at private child 0. This is not a frozen ecosystem specification.

## Validation actually completed

The results below were recorded locally. The included GitHub Actions workflow skips only the light-core Rust unit-test step, retaining JavaScript syntax checks and regression tests, native/WASM compilation, builds and artifact uploads.

| Check | Result |
| --- | --- |
| `node tests/check-syntax.mjs` | Pass: 14 JavaScript files, 420 unique DOM IDs and popup bindings |
| `node --test tests/*.test.mjs` | 26 passed |
| `cargo test -p light-core --lib` with debug overrides below | 19 passed, 1 optional benchmark ignored |
| Ignored scanning microbenchmark, run separately | Pass; sample below |
| `cargo check -p light-cli` | Pass (includes core) |
| WASM check for `light-wasm` and `prover-wasm` | Pass |
| Local browser preview with mocked backend | Private icon location, controls, fresh toggle, explicit mode/error, literal message rendering, private conceal/reveal, Arabic layout and mainnet disabled actions checked |

Native tests used Rust 1.99.0 on macOS ARM64 and Node 24.19.0. Local test execution used an isolated compiler/linker workaround because Xcode command-line tools were absent. The portable source does not include that development toolchain. Native test commands used:

```sh
cargo test -p light-core --lib \
  --config 'profile.dev.package.triton-vm.opt-level=0' \
  --config 'profile.dev.package.twenty-first.opt-level=0'

CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  cargo check -p light-wasm -p prover-wasm --target wasm32-unknown-unknown
```

The optional benchmark used the same debug overrides and `private_notification::tests::scanning_cost_sample -- --ignored --nocapture`. For 100 items: ordinary marker skips 0.010 ms total, foreign trials 42.372 ms, own opens 68.758 ms. One envelope has 594 field elements / 4752 field bytes before framing. This is a native debug microbenchmark, not browser, full-restore or proof timing.

The mock-chain test exercises actual wallet preparation, witness validation, receipt, spend tracking, envelope-only replay rejection and seed restoration. Mock blocks have no valid proof of work or block proof. Testnet-mock transaction assembly does not demonstrate full proof generation.

One pre-existing archive test fixture was corrected to stop updating already-spent membership proofs during subsequent additions, matching the live-only removal updates. Runtime archive behavior was not changed.

## Not established by these checks

No release WASM binaries were built or installed. No transaction was submitted to, relayed by or mined on a live Neptune node. Real proof generation/acceptance, reorg behavior for the new mode, end-to-end performance, hostile-load behavior and cross-wallet interoperability remain unverified. The envelope protocol, derivation, dependencies and recovery-file format have not received independent security review. Mainnet support remains blocked.

Use [docs/BUILD.md](docs/BUILD.md) or the included build workflow to create fresh WASM binaries. Preserve `Cargo.lock`. See [docs/PRIVATE-MODE-REVIEW.md](docs/PRIVATE-MODE-REVIEW.md) for the privacy, mixing and performance decisions, and [docs/PRIVATE-NOTIFICATIONS.md](docs/PRIVATE-NOTIFICATIONS.md) for the wire format.
