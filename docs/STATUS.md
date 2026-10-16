> **0.23.3 prototype:** See [../RELEASE-0.23.3.md](../RELEASE-0.23.3.md) for current validation and [SUB-WALLETS.md](SUB-WALLETS.md) for the three sub-wallets, address history and encrypted receipt recovery. The remaining table also describes features inherited from the earlier wallet source.

# Status

**Experimental source prototype.** Native core tests, JavaScript checks and native/WASM compilation have passed locally. Fresh release WASM binaries and live-node acceptance have not been established. See [../RELEASE-0.23.3.md](../RELEASE-0.23.3.md) for exact validation results and limitations.

## Deployment validation checklist

1. [x] Pinned Neptune source and the existing WASM compatibility patch prepared.
2. [x] Native compilation: light-core and CLI.
3. [x] WASM compilation: light-wasm and prover-wasm.
4. [x] Local native tests: 24 passed, one optional scanning benchmark run separately.
5. [x] JavaScript checks: 78 tests passed; syntax and popup DOM bindings checked.
6. [ ] Fresh release WASM build and installed-extension validation.
7. [ ] Unchanged-node admission, relay, mining, offline receive, spend and clean restore.
8. [ ] Real proof generation/acceptance and browser performance measurements.
9. [ ] Reorg/adversarial-load/interoperability tests for the new private mode.
10. [ ] Independent protocol and implementation security review before considering mainnet support.

## What is implemented

| Area | State |
| --- | --- |
| Recovery phrase (18 words): copy (auto-cleared), export to a file, import from a file | written |
| Start at tip / restore from birthday | written |
| Local sync: hash chain, receiver-id scan, membership proofs, spend detection, accumulator check | written |
| Reorg rollback via snapshots | written |
| Connect through Tor (proxy script, fail-closed, Tor check) and Privacy check screen | written; proxy logic tested with a simulated Chrome; not yet tried with a real Tor |
| Exact anonymity count (Hall's theorem on spend intervals, lustration-aware) with background spend index | written; algorithm checked against brute force locally |
| Low-memory proving (Automatic / On / Off) and per-proof report | written; not yet measured on real proofs |
| Node mode (own node for sync, broadcast, fast restore, fast rescan) with capability check | written; tested against a simulated server |
| Proving help from the server (proof collection without chunk data; lock-script-only on own node) | waiting for neptune-core endpoints |
| Restore: Fast, Private scan or Own node | all three choices are offered for every sub-wallet; indexed recovery discovers ordinary branches and shared encrypted format flags, with full-scan fallback |
| Address balances add up to Available (change counted for the paying address) | written |
| Address names follow neptune-core: Generation, EC Hybrid | written |
| Light idle mode: tip check without wasm or decryption, one home request, simple home screen without continuous animations | written, tested in the harness |
| Parallel block download (up to 3 batches), adaptive to a slow or refusing server, fewer snapshot saves | written, about 3x faster in a local benchmark; recovers from timeouts and HTTP 429 |
| Coin selection, change to fresh symmetric key, lustration with user consent | written |
| Anonymity number from the sender's view (coin itself and its block's other outputs left out) | written; Rust unit test |
| Wallet state version 3 (reads versions 1 and 2) | written; migration unit test |
| Watch-only addresses: generation / EC Hybrid viewing keys and viewing addresses, optional spend key (receiver preimage, checked against the address), background catch-up anchored to the wallet's tip | written; Rust unit test, JS flow in the harness |
| Export of this wallet's viewing keys and spend keys (password) | written |
| Guesser-fee coins (half time-locked) found from the block header | written; not yet seen on a real block |
| Off-chain payment notifications (`utxo…`): checked like neptune-core's `claim_utxo`, waiting list, carried through rescans | written; Rust unit test |
| Premine allocations: genesis rebuilt locally, first ten generation keys; a scan "from the beginning" starts at genesis | written; Rust unit test |
| Local archival mutator set: built from genesis, checked against every block, pages in IndexedDB, 10 blocks behind the wallet, restores proofs and adopts registered coins | written; Rust unit test against the accumulator, JS flow in the harness; size and speed not yet measured on mainnet |
| ProofCollection split into jobs; parallel proving in workers; assembly | written |
| Mock-proof networks skip proving | written |
| Wait for a fresh block before proving; rebuild with pinned inputs on "not confirmable" | written |
| Encrypted vault, state, jobs; auto-lock | written |
| Native CLI with per-proof benchmark | written |
| Two receiving address types: Post-quantum (generation) and Short (EC Hybrid) | written |
| Standard fixed addresses; Auto-refresh after confirmation with previous-address history; Encrypted app addresses for both kinds | written; six branches and seed replay checked locally |
| QR codes (upper-cased bech32m, alphanumeric mode); message when an address is too long | written |
| History with fees, pending/confirmed status, change hidden | written |
| Server status light, sync ring, "Up to date" at the latest block | written |
| Wallet state upgrade from version 1 to 2 (keeps existing wallets) | written |
| Balance per address kind (post-quantum, short, change) on the home page | written |
| Download an address as a QR picture (PNG), or as a text file when too long for a QR code | written |
| Import a recipient from a QR picture or text file (pick, drop or paste); reader in wasm (`rqrr`) with the browser's BarcodeDetector first | written |
| Local-currency value (USDT, USD, EUR, GBP) from CoinGecko, can be turned off | written |
| Interface in English, French and Arabic (right-to-left); theme Auto / Light / Dark | written |
| Broadcast from the offscreen page; interrupted sends resume (fixes "stuck at Broadcasting") | written |
| Pending payment shown with the change that comes back; expired payments marked | written |
| Recipient kind shown before sending; secret keys refused as recipients; "Pay from" one address kind | written |
| Mainnet / Testnet switch on the home page, separate data per network | written |
| Price lookup switch (no CoinGecko request when off); "Use your own node" in Servers with the exact neptune-core command | written |
| Contacts (encrypted, per network) with address-kind tags; pick from Send; save from a payment | written |
| Private notes on payments (encrypted with the history) | written |
| Chrome notifications: sent (with change), received, confirmed, failed; switch in Settings | written |
| Send records sealed with the vault key (recipient, amounts, note) | written |
| Privacy sheet: AOCL range and block span per coin, mutator set parameters, Triton VM STARK parameters | written |
| Cancel a payment until it is broadcast (waiting, building, proving); a last-moment cancel after upload is recorded as sent | written |
| Activity shows which address kind received each payment; amounts shown without trailing zeros | written |
| Privacy indicator: per-coin anonymity set from `AbsoluteIndexSet::aocl_range`, maturing coins, lustration, server separation | written |
| Self-check before broadcast: every proof verified against the claims neptune-consensus builds (`ProofCollection::*_claim`) | written |
| Restore scans from genesis by default; optional known block before the first payment; continuous chunked scan with progress | written, tested with a simulated chain; dedicated Encrypted address recovery page |
| Minimum fee raised to 0.02 NPT so proof upgraders (min 0.01 after their 60 % share) take the transaction | written |

## Known gaps

| Gap | Impact | Fix |
| --- | --- | --- |
| Mempool-unaware | Incoming payments show once mined | Optional mempool scan |
| No guesser-fee scanning | Irrelevant unless you mine | Port `scan_for_guesser_fee_utxos` |
| No independent consensus authentication | Node-supplied blocks are checked for continuity and accumulator consistency, but their proofs/PoW and canonical-chain selection are not independently validated | Trusted validating node now; authenticated consensus/header design and adversarial tests before trustless claims |
| Coin selection: largest-first, max 4 inputs | Many small coins may block a payment | Add a "consolidate" action |
| Snapshot rollback depth is 30 batches | Deeper reorgs need a re-sync from birthday | Fine in practice |
| No public Testnet server is preset | Testnet needs a server URL in Settings > Servers | Add one when a public one exists |

## Memory expectations

Unknown until step 5 is done. The removal-records-integrity proof is usually the largest and grows with the number of inputs. If one job exceeds about 3.5 GB natively, it will not fit in a wasm32 worker. In that case:

1. Lower `MAX_INPUTS` in `send.rs`.
2. Or build prover-wasm for memory64 (`wasm64`), which recent Chrome supports. Chrome caps a wasm64 memory at 16 GB.
3. Or move proving to a local native companion through Chrome native messaging. The extension design does not change: jobs in, proofs out.

Security pass: [SECURITY-REVIEW-0.23.2.md](SECURITY-REVIEW-0.23.2.md). Uncertain broadcasts retain exact prepared data/proofs, block new payments/rescans, and support resending the original. Unknown outcomes never expire automatically; stale or permanently rejected unknown transactions may need manual node investigation.

Per-sub-wallet recovery methods persist independently. Indexed asset recovery scopes flags and coin proofs to the selected sub-wallet; stale other-wallet snapshots fall back to local scanning. The shared chain/node connection is retained.

Current payment-code, archive and refresh fixes: [BUG-REVIEW-0.23.3.md](BUG-REVIEW-0.23.3.md).
