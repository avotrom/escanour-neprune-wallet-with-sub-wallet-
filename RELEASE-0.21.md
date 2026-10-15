# Escanour Neptune Wallet 0.21.0

This is an updated **source package**. It is not an install-ready Chrome extension: the original ZIP did not contain `extension/pkg/`, and the Rust/WebAssembly build has not been completed in this environment. Build both WASM modules before loading the extension. Do not combine these files with old WASM modules: this version adds new bindings.

## Changes

- Watch-only block reading stays visible on the main page, even after the spending wallet reaches the tip. Each address shows its own block cursor and progress.
- Returning to the main page and reopening Watch preserves the unfinished form. Locking clears its viewing/spend keys.
- Generation and EC Hybrid watches remain separate entries, as requested. An optional saved-contact link names a watch without merging it with another address.
- Add watches using a private full scan, Fast Track through the current server’s index, or your own node’s index. Fast Track checkpoints are encrypted and resumable. Unsupported index requests fall back to a private scan with a visible explanation.
- Pause/Resume keeps an address’s scan cursor. Stop following removes the registration. Hide asset only hides the card; Show hidden restores access. Hide amounts masks home balances and watch amounts.
- Saved contacts can contain one Generation and one EC Hybrid receiving address. The send-contact picker lists each address separately. Existing single-address contacts are retained.
- The main-page watchlist has individual cards, progress bars, search, a hidden-assets filter, and quick access to Contacts and Add.
- Background sync requests are coalesced. User actions interrupt background block fetches, and watch progress is saved after each returned batch. Empty block responses produce an error instead of an endless retry loop.
- Watch registrations and preferences are encrypted independently of rollback snapshots, so rollback cannot silently delete a newly added watch or resurrect a removed one. IDs are not reused after removal.
- Chrome’s `proxy` permission is now required in the manifest. The invalid optional-permission request is removed. Tor reports missing permissions, managed policy, another proxy extension, and connection failures separately. Remote RPC and price requests are blocked when Tor is required but disconnected. Local nodes can connect directly.
- New interface text is available in English, French, and Arabic.

Fast Track sends address identifiers and coin index sets to the selected node. Viewing keys remain on the device. A node’s index can omit history, so a full private scan remains available. Generation and EC Hybrid receiving addresses alone cannot reveal balances; the corresponding viewing key is still required.

## Validation

Passed locally:

- 14 JavaScript regression checks covering persistent registrations across rollback, independent IDs, pause/resume/hiding, paired contacts, concurrent status updates, interrupted scan checkpoints, resumable indexed scans, empty-block errors, coalescing, and Tor fail-closed routing.
- JavaScript syntax checks, popup DOM bindings, unique element IDs, and proxy manifest validation.
- Interactive browser checks with simulated data: main-page watch progress; draft retention across navigation; pause/resume; hide/show; balance masking; and a contact retaining both address types. English and Arabic layouts were visually inspected at a narrow side-panel width.
- Cargo workspace manifest resolution against the pinned Neptune source.

Not completed:

- Rust compilation, Rust unit tests, and WASM generation. The local build attempt failed because `rustc` was unavailable; this host also lacks Xcode command-line tools. Partial toolchain downloads were stopped.
- A live Neptune-node scan, real Tor connection, actual Chrome extension installation, or transaction broadcast. Browser previews and JavaScript backend tests use mocked wallet/node data; they do not validate cryptographic behavior.

## Build on GitHub

The ZIP includes `.github/workflows/build.yml`; keep this hidden directory when uploading the project to your repository. Push the project, then open **Actions → build**. The workflow runs JavaScript checks, native/WASM checks and Rust tests, builds both modules, and uploads **neptune-light-extension**. Failing tests prevent the extension build from being published by the workflow.

Download that artifact, extract it, then use **chrome://extensions → Developer mode → Load unpacked** and select the extracted extension folder. For an existing unpacked installation, replace files in its existing folder and reload it so its extension ID and stored data are retained. Chrome may require acceptance of the proxy permission after the update.

For local builds, follow `docs/BUILD.md` and run:

```sh
node tests/check-syntax.mjs
node --test tests/*.test.mjs
scripts/vendor-neptune.sh
scripts/check-wasm.sh
cargo test -p light-core --lib
scripts/build.sh
```

An own node needs `--utxo-index` and the `utxoindex` RPC module for indexed scans.

## Tor references

- [Chrome permissions: proxy cannot be optional](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome proxy API](https://developer.chrome.com/docs/extensions/reference/api/proxy)
- [Tor Project: using Tor with other browsers](https://support.torproject.org/tor-browser/security/using-tor-with-other-browsers/)

The wallet’s SOCKS routing does not provide Tor Browser’s browser-level protections.
