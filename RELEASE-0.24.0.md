# Escanour Neptune Wallet 0.24.0: succinct node, two builds

## New

- **Succinct node.** The wallet can verify the chain's recursive proof itself
  instead of trusting its sync server. Switch in Settings > Servers. Details
  and limits: [docs/SUCCINCT.md](docs/SUCCINCT.md).
- **Two builds from one source.** `escanour-light` (no node, as before) and
  `escanour-node` (with the succinct node). CI uploads both; a pushed `v*` tag
  attaches both zips to a GitHub release.
- **neptune-core v0.20.1** (was the 0.19.x pin), Triton VM 9.0.1. Required to
  read epsilon blocks at all.

## Security fixes

1. **Tor check skipped in the offscreen page (broadcast path).** Offscreen
   documents only get `chrome.runtime`, so the route check that reads the Tor
   state from `chrome.storage.session` returned without checking. With Tor
   requested but not active, the broadcast could leave directly. The page now
   asks the service worker and fails closed.
2. **Unbounded node responses.** A server could answer with an endless body
   and exhaust memory. Responses are now read as a stream with a ceiling
   (128 MiB default, 64 MiB for a tip, 64 KiB for a height). This closes the
   "unbounded RPC response" item of earlier reviews.
3. **Settings changeable while locked.** `saveSettings` accepted any change on
   a locked wallet (servers, Tor off). Now only theme, language, currency and
   hide-assets can change while locked.
4. **Message sender check.** The service worker now ignores messages that do
   not come from this extension's own pages (defence in depth; nothing could
   reach it before either).
5. The earlier "consensus authentication" item is closed **in node mode
   only**, and only above the activation block. Light mode is unchanged.

## Validation

- JavaScript: syntax check and 140 regression tests pass (21 new).
- Rust: `light-core`, `light-cli`, `light-wasm`, `node-wasm` compile natively
  against v0.20.1 with the regenerated patch.
- **Not validated here:** the wasm32 build (no wasm toolchain was available
  where this was prepared), the extension in a real Chrome, and verification
  of a real main-net tip. The first GitHub Actions run is the first real
  build. Test on testnet before relying on it.

## Notes for the build

- rustc needs `RUST_MIN_STACK=33554432` for neptune-consensus (set by the
  scripts) and a stable toolchain that has `Option::map_or_default`.
- `KNOWN_ANCHORS` is empty: fill in the hash of main-net block 62,499 once you
  have confirmed it from independent sources.
