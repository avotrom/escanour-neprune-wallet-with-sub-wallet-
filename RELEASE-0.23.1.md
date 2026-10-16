# 0.23.1-alpha.1 — recovery fixes

Recover assets now offers Fast, Private scan and Own node for Standard, Auto-refresh and Encrypted. The separate Encrypted address recovery page is available only inside Encrypted. It starts a local full scan for encrypted receipts; it does not replace the shared asset-recovery choices. Recovery updates the shared chain state while balances, spending and change stay separate.

Fast and Own node are no longer silently forced into Private scan. Indexed recovery discovers Auto-refresh branches and both encrypted receipt types, using shared public format/version flags for encrypted envelopes and local decryption. It does not upload the scanning key. Proof requests still disclose owned coin index sets to the selected node; Private scan avoids those lookups.

Additional fixes include serialized Send creation, pending-payment recovery guards, correct Tor routing for a changed recovery node, safer scan start heights, block-zero seed restores being recognized as restores, indexed recovery running even when already at the tip, preserving known receipts during fallback/rescan, selected-sub-wallet payment-code recovery and correct Auto-refresh viewing-key exports. Ordinary viewing keys cannot discover encrypted envelopes; Encrypted viewing-key export is explicitly unavailable. See [docs/BUG-REVIEW-0.23.1.md](docs/BUG-REVIEW-0.23.1.md).

Validation: 22 local core tests passed, one benchmark ignored; 40 JavaScript tests passed; 15 JS files and 459 unique DOM IDs checked; 315 static translation keys checked in English, French and Arabic; native CLI and WASM compile checks passed. Core mock-chain checks compare indexed and full recovery before/after spending for all six receiving branches, messages, change and seeded known coins. Browser checks use labelled mock data.

The GitHub workflow still skips light-core unit tests and retains JavaScript tests, syntax, compilation and builds. Fresh WASM build/installation, unchanged-node relay/mining, real proof acceptance and independent review remain uncompleted. This is source, not an install-ready extension. Encrypted remains testnet-only. Follow [docs/BUILD.md](docs/BUILD.md).
