# Succinct node (0.24)

Since soft fork epsilon (neptune-core v0.20.1; main net block 62,500, testnet-0
block 7,144) the proof of every block also establishes that its predecessor is
valid, recursively down to the last block below the activation height. One
proof therefore covers the whole chain above that block.

The wallet uses this to stop trusting its sync server for chain validity.

## Two builds

| | `escanour-light` | `escanour-node` |
| --- | --- | --- |
| Needs a node of your own | no | no |
| Chain validity | trusted from the sync server | proven in the browser |
| Node module (`pkg/node`) | not shipped | shipped, loaded only when on |
| Switch | none | Settings > Servers > Succinct node (off by default) |

`scripts/package.sh` cuts both from the same source; `lib/flavor.js` is the
only line that differs. With the switch off the node build behaves exactly
like the light build.

## What is checked

For the tip block served by `chain_tip` on Node A (and Node B when set):

1. the block's proof verifies for its claims;
2. the claims include transaction validity and *predecessor is valid*;
3. the header continues the parent that claim describes: digest, minimum block
   time, difficulty, cumulative proof-of-work;
4. every rule that reads the block alone (size, coinbase, fee, timestamp, …);
5. the block meets its proof-of-work target;
6. the chain's activation parent equals the trust anchor.

Rules 1 to 4 are neptune-core's own (`Block::validate_tip`), called through
two synchronous entry points added by `patches/neptune-wasm.patch`
(`validate_tip_sync`, `validate_tip_header_sync`); no rule is re-implemented.

The wallet's own scan is then tied to the verdict: at the proven height the
wallet's block hash must be the proven hash, and one block below the tip its
mutator set must hash to the proven mutator set. A mismatch stops sending and
is shown as an error.

**Fork choice.** Between two nodes, the tip with more proven work since
activation is followed; Node A wins a tie.

## What is not checked

- **Below the activation height.** Nothing can prove it. The hash of the last
  block before activation is the trust anchor. `KNOWN_ANCHORS` in
  `extension/lib/succinct.js` is empty in this release, so the wallet records
  the anchor from the first proven tip and refuses any later chain built on a
  different one. Compare the value shown in Settings > Servers with a block
  explorer or your own node, or paste a hash you trust. If two nodes report
  different anchors before one is set, nothing is pinned.
- **The tip's own mutator set update**, unless the wallet stood exactly one
  block below it (then it is validated in full). Otherwise the next block
  proves it; the status line says "proven through block N-1".
- **Withheld blocks.** A server can still hide newer blocks. Two independent
  nodes reduce this; the proofs cannot.
- **Privacy.** Unchanged: the server still sees your IP (unless Tor is on) and
  which block ranges you fetch.

## Living in Chrome

Chrome stops an extension service worker after about 30 idle seconds, so a
node cannot live there. The node loop runs in the extension's offscreen
document, which Chrome does not stop: its timers keep firing and its worker
keeps the verifier loaded. It needs no keys, so it follows the chain while the
wallet is locked, and wakes the service worker only when a new verdict is
stored. The one-minute alarm re-creates the page if Chrome discarded it.
"Keep following the chain when all windows are closed" asks for Chrome's
optional `background` permission.

A browser cannot open raw TCP or QUIC connections, which is all neptune-core
peers speak. This is therefore a *validating* node over RPC, not a peer: it
does not relay blocks or transactions and does not mine. For that, run
neptune-core and use Own node.

## Files

- `crates/light-core/src/succinct.rs`: the verdict (`TipReport`), fork choice.
- `crates/node-wasm`: browser bindings, built to `extension/pkg/node`.
- `extension/node-worker.js`: verification in its own Web Worker.
- `extension/node-runner.js`: the loop in the offscreen document.
- `extension/lib/succinct.js`: anchors, decisions, status (shared, tested).
