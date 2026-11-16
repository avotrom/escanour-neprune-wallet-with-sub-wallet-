# Escanour Neptune Wallet 0.25.0: Full node mode, cleaner Settings

One build again. Load `escanour-wallet.zip` unpacked in Chrome.

## Full node mode (Settings > Full node)

One switch for both halves of a node the browser can run:

- **Chain proof.** Checks the recursive zk-STARK proof of each new tip
  (Neptune v0.20.1+), so a server cannot show you an invented chain. This was
  0.24's separate "succinct node" build.
- **Archival mutator set** on this device: membership proofs and spend checks
  without asking a server.
- **Snapshots.** Load the archival mutator set from one file instead of
  downloading every block, from a file or an https address. Make one on the
  Mac that runs your neptune-core with the new command-line tool:
  `neptune-light --server http://127.0.0.1:9797 archive-export`
  (`neptune-light-macos.zip` in this release). Every snapshot is checked in
  full and must match your server's chain; who made it does not matter.

## Node on this Mac (Settings > Network)

A page that starts and stops a node on your Mac, so the wallet syncs with no
public RPC server:

- **Light node**: `neptune-light peer-node`. Talks only to Neptune peers over
  their own peer protocol, stores no chain; the wallet checks the recursive
  proof. Needs no change on Neptune's side.
- **Full node**: `neptune-core`, the official archival node.

One-time setup: `./neptune-light install-host --extension-id <ID>`. See
[docs/NODE.md](docs/NODE.md).

## Settings, reorganised

- **Wallet:** Recovery phrase, Contacts, Watch-only addresses, Recover assets
- **Network:** Full node, Node on this Mac, Servers, Tor
- **Security:** Auto-lock, Price lookup
- **Preferences:** Theme, Local currency, Language, Notifications
- **More:** Advanced, Restore another wallet, Create a new wallet, Remove wallet
- **Support:** Help center, About

**Servers** is one choice: *a public server* or *my own node*. Node B, random
fallback and a separate broadcast server are under "More options".

**Removed:** Privacy check page, "Exact privacy count" switch (now always
on), "Wait for a fresh block" (sends start from the current tip), "Last
proofs" list, the two-build split.

## Kept from 0.24

neptune-core v0.20.1; Tor fails closed in the offscreen page; size-capped
node responses; servers and Tor locked while the wallet is locked; sender
check on messages.

## Validation

- 140 JavaScript tests pass.
- Rust: `light-core`, `light-cli`, `light-wasm`, `node-wasm` compile natively.
  New unit test for the snapshot format (run locally: `cargo test -p light-core snapshot`).
- Settings, Full node, Servers and Advanced screens rendered and checked in
  headless Chrome (English and Arabic).
- **Not yet tested:** the light node against main-net peers, a real snapshot,
  and the extension in a real Chrome. Test on testnet first.
