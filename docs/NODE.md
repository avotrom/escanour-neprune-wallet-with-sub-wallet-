# Node on this Mac (0.25)

Settings > Network > **Node on this Mac** opens a page that starts, stops and
watches a node on your Mac. The wallet then syncs from it at
`http://127.0.0.1:9797/`: no public RPC server.

## Two nodes

| | Light node | Full node |
| --- | --- | --- |
| Program | `neptune-light peer-node` (this repo) | `neptune-core` (official) |
| Talks to | Neptune peers only, over their peer protocol | Neptune peers |
| Stores | nothing but a log | the whole chain (many GB) |
| First sync | minutes | hours |
| Chain validity | checked by the wallet: recursive proof (soft fork epsilon) | checked by neptune-core |
| Mining | no | yes |

**Light node.** A browser cannot open TCP, so this small program does it for
the wallet. It connects to Neptune nodes on their legacy peer port (9798,
still accepted by v0.20.1), completes Neptune's handshake, fetches blocks on
demand (`BlockRequestByHeight`) and serves the wallet the RPC methods it
reads: `chain_height`, `wallet_getBlocks`, `chain_tip`, `node_network`,
`wallet_submitTransaction` (sent to peers as a `Transaction` message). It
verifies nothing itself: with Full node mode on, the wallet checks the tip's
recursive zk-STARK proof, so a lying peer is caught, and the wallet's sync
checks that every block extends the previous one. It needs no change on
Neptune's side.

Peers: v0.20.1 has no built-in peer list. Give one or two Neptune node
addresses on the Node page (`host:9798`); the light node asks them for more.

## Setup, once

1. Download `neptune-light-macos.zip` from the release, unzip it.
2. In Terminal, in that folder:
   `./neptune-light install-host --extension-id <ID shown on the Node page>`

This registers a Chrome native messaging host (`com.escanour.node`) for
Chrome, Chrome Beta, Brave and Chromium. The page can then start and stop
nodes; they run detached, so they keep running when the page is closed. Logs
and process ids are in `~/Library/Application Support/Escanour/`.

## Limits

- Sending through peers: peers relay a proof-collection transaction only
  above their fee floor; a single-proof transaction is always relayed.
- The light node announces the genesis block as its tip and serves nothing
  to other peers: it is a client of the network, not a full peer.
- Blocks are fetched one height at a time, within each peer's serving budget
  (1,000 blocks per minute by default). Catching up a wallet that was offline
  for weeks takes a while; a new wallet starts at the tip.
