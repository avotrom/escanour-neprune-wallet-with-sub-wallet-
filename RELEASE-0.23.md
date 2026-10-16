# 0.23.0-alpha.1 — three sub-wallet source prototype

Only Standard is created by default. Auto-refresh and Encrypted are created on request. Each has its own Generation and EC Hybrid receiving addresses, spendable balance, change branch and activity. The current sub-wallet controls the home and Send/Receive interface. Standard keeps fixed addresses; Auto-refresh changes a paid address after confirmation; Encrypted uses dedicated app addresses and optional encrypted messages. No address URL/service or Automatic mixing is included.

The main screen follows the supplied design reference with charcoal surfaces, simple actions and two address cards. Standard uses violet, Auto-refresh teal and Encrypted plum. The selector sits beside Tor. Privacy check is available in Settings only; the old Private controls menu is removed. Expanded explanations are behind Details.

Auto-refresh has a Previous addresses page for both address types, with current/previous labels, confirmed payment counts, Copy and QR. Confirmed address history survives spending and is reconstructed during seed recovery. Earlier receiving keys remain scanned when a later address has been paid first. Encrypted has its own Encrypted address recovery page, covering both encrypted receipt address types, a scan action with progress, recovery by phrase, and optional seed-only encrypted backup.

The included GitHub Actions workflow skips light-core Rust unit tests, as requested. JavaScript tests and syntax checks, native/WASM compilation and artifact builds remain. Node 24 is explicitly selected. Local tests are retained for validation.

See [docs/SUB-WALLETS.md](docs/SUB-WALLETS.md) for key separation, restoration, privacy and performance. The pinned Neptune dependency remains `cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04` (0.19 crates). Version 3 encrypted envelopes support both address types; readers retain v1/v2 compatibility. State layout remains version 3.

## Validation

- JavaScript: 29 regression tests passed; syntax and bindings checked for 15 extension JavaScript files and 445 unique DOM IDs.
- Rust core: 21 local library tests passed; one optional benchmark ignored in the normal run and passed separately. Tests cover all six receiving branches, seed replay, address advancement, isolated balances, rejected cross-wallet funding, same-wallet change and spending, and late payments to earlier refresh addresses. Mock blocks are not live node acceptance evidence.
- Native CLI and WASM compile checks are recorded in the delivered VALIDATION.txt.
- Browser preview uses mock addresses and balances, never real funds. The release source does not include the mock server.

The native debug scan sample measured 100 ordinary marker skips in 0.006 ms, 100 foreign envelope trials in 70.939 ms, and 100 own envelope openings in 153.635 ms. A v3 envelope has 1180 field elements (9440 field bytes before framing). This is not a browser, full-wallet restore or transaction-proving benchmark.

## Important build limits

This is source, not an install-ready extension. Build fresh WASM modules before installation; see [docs/BUILD.md](docs/BUILD.md). Live-node relay/mining and real proof acceptance, release installation and independent cryptographic review remain uncompleted. Encrypted notifications are testnet-only. Generation does not make the outer sealed-box recipient privacy or optional message post-quantum.
