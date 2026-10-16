# 0.23.2-alpha.1 — security and recovery-menu fixes

Encrypted recovery-file export has been removed from Standard and Auto-refresh. It remains under Encrypted address recovery Details, and the backend enforces the same restriction. It encrypts the shared root phrase, not a separate Encrypted-only seed.

Security fixes include guarded phrase/viewing-key/recovery exports, clearing hidden secret fields on lock/navigation, suppressing late export replies, no automatic replay of mutating UI requests, redirect refusal, stricter node URLs and enforcement of saved Tor policy when session state is stale.

Lost broadcast replies now retain the exact transaction and proofs in a Payment outcome unknown state. New sends and rescans remain blocked. Resend original reuses the original transaction. A later rejection cannot erase earlier uncertainty; confirmation or a successful original-transaction reply resolves it. Unknown outcomes never expire automatically, so a permanently stale transaction may need manual investigation rather than becoming retryable with different coins.

See [docs/SECURITY-REVIEW-0.23.2.md](docs/SECURITY-REVIEW-0.23.2.md) for evidence and open risks. The security document now explicitly states that the light wallet does not independently verify block proofs, proof of work or canonical-chain selection. A trusted validating node remains necessary.

Each sub-wallet remembers its recovery method independently. Standard defaults to Fast; Auto-refresh and Encrypted default to Private scan. Each can choose any of Fast, Private scan or Own node. Indexed asset recovery now queries only the selected sub-wallet’s receiving/change branches and owned coins; it no longer exposes other sub-wallets’ lookup identifiers. Other balances are preserved at the same chain snapshot. If their proofs would be stale at a newer/different snapshot, recovery falls back to local full scanning. The shared block scan can update all balances. Whole-seed restoration still applies its explicitly chosen method to the whole root wallet; sub-wallet recovery does not run three independent chain engines. Own node changes the shared network’s block source.

Validation: 61 JavaScript tests and 23 local core tests passed (one benchmark ignored); syntax passed for 15 JS files and 459 DOM IDs. Native CLI and wasm32 light-wasm/prover-wasm compile checks passed after the final Rust changes. Core checks include isolated indexed flags/proofs, both address types, preserved other-wallet coins and rejection of merging stale snapshots. GitHub Actions continues to skip light-core Rust unit tests while retaining JavaScript checks, compile checks and builds.

Experimental source, not an install-ready extension. No new WASM binaries are bundled. Encrypted remains testnet-only, with unaudited, non-post-quantum outer encryption. Live-node relay/mining, real proof acceptance, browser performance and independent review remain uncompleted. Follow [docs/BUILD.md](docs/BUILD.md).
