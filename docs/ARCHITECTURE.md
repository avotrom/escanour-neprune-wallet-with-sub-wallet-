# Architecture

Escanour Neptune Wallet is a browser-extension wallet that needs no node of its own, leaves Neptune unchanged, and tells servers as little as possible. This document explains each part and why it is built that way.

## Constraints that shaped the design

| Constraint | Consequence |
| --- | --- |
| Neptune transactions are private: nodes cannot check balances or signatures themselves. | The sender must produce STARK proofs. Proving is the expensive part of every send. |
| A transaction's primitive witness contains spending secrets. | The witness never leaves the device. Only ProofCollection-backed transactions are sent. `RpcTransactionProof::try_from` in neptune-rpc-api already refuses to serialize a witness. |
| Browsers cannot open raw TCP connections to Neptune peers. | The wallet talks to public nodes over their existing JSON-RPC (HTTP POST). |
| Extensions with host permission can call a server even without CORS headers. | No change to neptune-core is needed for browser access. |
| wasm32 has one 4 GB linear memory per instance. | Proof jobs run in separate workers, each with its own instance. |
| MV3 service workers can be stopped at any time. | All state lives in IndexedDB; every step can resume from there. |

## Components

```
popup.html/js          UI only. Holds no secrets; every action is a message.
     |
     v  chrome.runtime messages (small JSON only)
background.js          Service worker. Vault, sync loop, send pipeline.
  + light wasm         All Neptune logic: scan, membership proofs, build tx.
     |
     |  encrypted jobs and plain proofs in IndexedDB; indices in messages
     v
offscreen.js           Schedules proof jobs across workers, then broadcasts.
  + prover-worker.js   One per worker: own prover wasm instance, one job at a time.
```

Two wasm modules keep start-up cheap:

- **light-wasm** has everything except the prover. It loads when the service worker wakes.
- **prover-wasm** contains the Triton VM prover. It loads only inside proving workers, after you press Send.

## Sync: private and local

The wallet asks the server for blocks by height and does everything else itself. Per block (`light-core/src/sync.rs`):

1. **Check the hash chain.** `RpcWalletBlock::hash()` recomputes the real block hash from the kernel and the `proof_leaf` digest, so the proof itself is never downloaded. The block's `prev_block_digest` must equal the wallet's tip hash; otherwise it is a reorg.
2. **Find incoming coins.** Each announcement carries a `receiver_identifier` in slot 1. `SpendingKey::scan_announcements_for_keys` looks it up in a table of the wallet's keys and decrypts only matches.
3. **Update membership proofs.** For every addition and removal in `BlockKernel::mutator_set_update` (guesser-fee outputs included), the wallet updates the membership proof of each coin it owns. This is neptune-core's own full-node algorithm (`process_inputs_and_outputs_maintain_mps`), run on the wallet's few coins.
4. **Detect spends.** A removal record is the spent coin's absolute index set. Matching it against the wallet's own index sets marks coins spent without asking anyone.
5. **Check the accumulator.** The rebuilt mutator set accumulator must equal the one the block commits to (`body.mutator_set_accumulator_after(guesser fees)`). A mismatch rejects the block.

**The point of step 3:** because the wallet keeps its own proofs, it never calls `restore_membership_proof`. That call sends the index sets of coins you are about to spend, so a server could link the request to your transaction. Today's desktop light wallet uses it before every send; this wallet does not need it at all.

### Address types

| Kind | Used for | Notes |
| --- | --- | --- |
| Generation ("Post-quantum") | receiving | lattice-KEM notification encryption; very long address |
| EC Hybrid ("Short address") | receiving | 97-byte address, small notifications; notification privacy relies on elliptic curves |
| Symmetric | change only | smallest announcements; its bech32m form contains the secret key, so it is never shown |

Spending is hash-based for every kind. Fixed receiving addresses use index 0 by default. The Private controls page can enable rotation after confirmed receipts for normal and private payment keys. Normal addresses use the existing deterministic counters and key lookahead. Private app children use a reserved EC Hybrid range plus one seed-derived scanning key; the child index is encrypted in the v2 envelope for direct recovery. Old addresses stay valid. See PRIVATE-NOTIFICATIONS.md for the experimental protocol and limits.

A payment can be limited to coins received on one kind of address ("Pay from"). The recipient's kind is shown before sending; symmetric keys and viewing keys are refused as recipients because they are secrets.

### Networks

Snapshots (`<network>:<height>`), history (`kv/activity:<network>`), sends and sync status are kept per network, so one seed can be used on Mainnet and Testnet side by side. Each network has its own server pair in Settings > Servers.

### Starting points

- **New wallet:** start at the tip. The tip block's body contains the full accumulator, so nothing older is needed.
- **Restore from seed:** scan the whole chain from block 1, so every coin of the seed is found without asking when the wallet was created. The scan runs in chunks of 500 blocks, one right after the other, releasing the lock between chunks; the home page shows its progress, and addresses are derived from the seed alone, so they appear at once.

### Restoring: three ways

- **Private full scan:** replay every block from block 1 (see Sync). The server learns nothing; it takes as long as downloading the chain.
- **Fast:** `light_core::fast`. Ask the server's UTXO index which blocks hold announcements for the wallet's keys, scan only those, get membership proofs for the coins found with `wallet_restoreMembershipProof`, and check them locally against the snapshot block. Spent coins are recognised from the same check (in the AOCL, but every Bloom filter bit set). Rounds repeat until no key beyond the look-ahead window turns up. The server learns which coins are the wallet's; the privacy panel says so afterwards.
- **Fast with my own node:** the same against the user's node, which also becomes the wallet's server for that network.

If the server has no UTXO index, the wallet falls back to the private full scan.

### Balances per address

Each coin belongs to an address: the one it was received on, or for change (symmetric keys), the address that paid, found from our coins spent in the same block. `WalletState::origins` computes this from the state alone, so it also holds after a restore. The two address balances count spendable coins only, so Generation + EC Hybrid always equals Available. Amounts cross the wasm boundary losslessly (34 decimals) and are shown cut to 8.

### Tor

Tor has its own screen (onion button on the home header, the Tor banner, or Settings > Privacy > Tor). Connect through Tor routes the wallet's servers, the price service and the Tor check through the Tor SOCKS port on the same computer (Tor Browser 9150, the tor service 9050). It uses `chrome.proxy` (an optional permission, asked for when the switch is turned on) with a proxy script that names only those hosts; the rest of the browser is untouched. The script has no direct fallback and is mandatory, so when Tor is down requests fail instead of revealing the IP. The wallet asks `check.torproject.org/api/ip` whether requests arrive through Tor, rechecks every 10 minutes and at browser start, and reports another extension or a VPN holding the proxy. A local node is never proxied. While Tor is on, the home page shows a banner: purple "Tor active" when connected, red "Tor not connected" when the wallet is paused; while connected, the interface turns Tor purple.

### Privacy check

Settings > Privacy > Privacy check lists every privacy fact the wallet knows, each with a light (green protected, blue worth knowing, amber to improve, red not working as set) and a link to the setting: IP exposure (Tor, Node mode), one server for sync and broadcast, price lookups, the coins' anonymity sets (exact or upper bound), amounts published by lustration, the exact count's status, fast restore, the default address kind, notifications, auto-lock, and local keys and proofs.

### Exact anonymity sets

`light_core::anonymity` answers, for each unspent coin: which AOCL leaves could a spend of it made now come from, given every spend on chain?

- **What an observer sees.** Each removal record's absolute index set gives an interval of leaves, `AbsoluteIndexSet::aocl_range` (the function the lustration rule uses), capped below the AOCL size before its block. A lustrated input publishes its `TransparentInput`, whose index set matches exactly one removal record, so that spend is a single leaf. Each leaf is spent at most once.
- **Theorem.** Spends are intervals over ordered leaves. By Hall's theorem for interval families, leaf `L` of the coin's range is a possible origin iff no window `[x, y]` containing `L` holds exactly `y − x + 1` observed spends (a tight window). Leaves in tight windows are used by every consistent explanation: provably spent. A window holding more spends than leaves cannot happen on a real chain; finding one means wrong or missing data, and no number is given.
- **Algorithm.** Tight windows start at a spend's left end and stop at a spend's right end. Sweeping right ends in order with a segment tree over left ends holding `C(x, y) + x − 1` finds, for each `y`, the leftmost `x` with a tight `[x, y]`: `O(m log m)` for `m` spends (about 75 ms for 200,000 spends natively). Tested against brute-force enumeration of all assignments on 4,000 random small cases.
- **Data.** Sync records every block's spend intervals (public data) in pages of 1,000 blocks keyed by height. Blocks the wallet did not scan (a new wallet, a fast restore, block 1) are filled in afterwards in the background. The exact count is shown only when blocks 1 to the wallet's height are all present; until then the panel shows range sizes as upper bounds ("up to").
- **Scope.** The result is exact for what the chain shows. It is not a probability, and it knows nothing of off-chain information such as network or timing.

### Proving memory

Triton VM can keep the low-degree extended trace in memory or recompute it; the proof is the same. It decides by reading free memory, which it can only do on Linux and Android, so in wasm it always tries to keep it. The prover module decides instead (`light_core::jobs::prove_with`): it runs the program, computes the size of the extended trace for the padded height (rows of the larger of the FRI and quotient domains, times 379 base-field and 91 extension-field columns), and keeps it only below 1 GiB in Automatic mode, below 2.5 GiB when low-memory proving is off, never when it is on. Each job reports its padded height, that size, the choice made, the proof size, its time and the worker's wasm memory; the last payment's report is shown in Advanced.

### Node mode

Settings > Servers > Node mode points sync and broadcast at the user's own neptune-core and checks what it offers (`serverInfo`): reachable height, network, and the UTXO index for fast restore. A rescan from block 1 in node mode uses fast restore through that node. neptune-core has no endpoint yet for proving help (a proof collection without chunk data, or lock-script-only proving); payments are proved in the browser.

### Staying light while idle

The minute check asks the server for the tip height as plain JSON. When nothing new has arrived, it only updates the status: the wallet is not opened, nothing is decrypted and no wasm is loaded. While the wallet is unlocked, the newest decrypted state stays in the worker's memory (dropped on lock), and the popup loads everything on the home screen with one `home` request.

### Snapshots and reorgs

Blocks are fetched in batches (up to 100 blocks, the node's default cap), with up to 3 batches downloading in parallel and applied strictly in order. Each request gives up after 25 seconds (Chrome may stop a worker whose fetch waits about 30 seconds). When a request fails or is slow, the wallet keeps what it scanned, then asks for half as many blocks, one request at a time, and speeds up again after several quick answers. The encrypted state is saved under its height when a batch touches the wallet's coins, every 1000 blocks or 15 seconds, and at the end of each run (at most 2000 blocks; the next run starts right after). The last 30 snapshots are kept. When a block does not connect:

- **If the batch already applied some blocks,** the chain changed during the request: refetch from the same snapshot.
- **If the first block did not connect,** the wallet's own tip was orphaned: drop that snapshot and step back to an older one.

## Sending: parallel proving

### Building (`light-core/src/send.rs`)

1. **Coin selection:** largest coins first until the amount plus fee is covered, at most 4 inputs. Each input adds proving work, so fewer inputs keep proving within browser memory.
2. **Outputs:** the recipient's output, plus change to a fresh symmetric key. Symmetric announcements are smaller, and a new key per transaction avoids linking change outputs.
3. **Lustration:** if the network's lustration rule applies to an input, the transaction must publish that input's amount. The wallet stops and asks the user first.
4. **Witness:** `TransactionDetails::primitive_witness()` from neptune-wallet.

### Splitting into jobs (`light-core/src/jobs.rs`)

A ProofCollection is 4 fixed subproofs plus one per lock script and one per type script. Each needs only its own program, claim and nondeterminism, so each becomes an independent `ProofJob`. Claims are built exactly as in `ProofCollection::produce`, including the claim version for the current rule set.

### Proving

- **The service worker** encrypts each job with the vault key and stores it in IndexedDB.
- **The offscreen document** starts N module workers. Each loads its own prover-wasm and pulls jobs from a queue, largest job first.
- **The worker count** defaults to about one per 2 GB of device memory, at most 4, leaving one core free. It can be overridden in Settings.

Why separate instances instead of threads:

- **No SharedArrayBuffer or cross-origin isolation.** Those are awkward to set up in extensions.
- **The 4 GB wasm32 limit applies per subproof**, not per transaction.
- **A crash in one worker (usually out of memory) is caught** and reported, with advice to use fewer workers or fewer inputs.

### Timing

Every subproof commits to the mutator set hash at build time. If blocks arrive while proving, the node may reject the transaction as not confirmable. Two measures reduce that:

1. **Start right after a block.** With the default setting, a send waits until a new block has just arrived (checked by the 1-minute sync alarm), then builds and proves immediately. That gives the whole interval between blocks, about 9.8 minutes on average, for proving.
2. **Rebuild with the same inputs.** If the node still answers "not confirmable", the wallet syncs, rebuilds with the same coins (`pinned_inputs`), and proves again, up to 3 attempts.

### Broadcast

Before anything is sent, the wallet verifies every proof against the claims that neptune-consensus's own public builders produce for the assembled collection (`send::self_check`). This matters because a node's `wallet_submitTransaction` checks only the kernel (fee, mutator set, timestamps), not the proofs: it answers `success: true` and its peers verify the proofs later. Without the self-check, a faulty proof would show as "waiting for confirmation" forever.

Proofs are assembled into a ProofCollection and sent with `wallet_submitTransaction` to the broadcast server. This happens in the offscreen page, not the service worker: Chrome stops an idle service worker after about 30 seconds, and building plus uploading several megabytes of proofs can take longer (this is what left 0.2 stuck at "Broadcasting"). The offscreen page writes the result to `kv/submit:<id>` before telling the service worker, which then records the broadcast. `resumeSends` (on every alarm, unlock and popup sync) picks up any send whose step was interrupted: it re-submits when all proofs exist, re-proves the missing ones when the jobs exist, and otherwise rebuilds. Use a different operator from the sync server if possible. The inputs are then marked reserved. If the transaction is not mined within 30 blocks, the reservation is released.

A ProofCollection is not yet mineable. Upgraders on the network raise it to a SingleProof and take part of the fee for doing so. Set a fee high enough to attract them.

## Privacy indicator (`light-core/src/privacy.rs`)

Spending a coin publishes its absolute index set: 45 positions in the mutator set's sliding-window Bloom filter. Each position is the coin's batch offset (`batch_index * CHUNK_SIZE`, with `BATCH_SIZE = 8` AOCL leaves per batch) plus a pseudo-random value below `WINDOW_SIZE = 2^20`. From the smallest and largest position, anyone can bound the batch, and so the AOCL leaf the coin came from, to a range. neptune-mutator-set computes that range as `AbsoluteIndexSet::aocl_range`, and the lustration rule uses the same function. With 45 uniform samples the range spans about `2 * 2^20 / 46 / 2^12 ≈ 11` batches, roughly 90 leaves.

For every unspent coin the wallet reports:

- **hidden among now:** the range clipped to the leaves that exist today;
- **hidden among full:** the whole range;
- **leaves until full:** how many more coins the chain must add, turned into blocks with the chain's average leaves per block;
- **reveals amount:** whether the lustration rule would publish its amount.

The home page shows the smallest "hidden among now" over spendable coins, and a level: strong (≥ 64), good (≥ 24), fair (below), lowered one step when an amount would be published or one operator runs both servers. The sheet also states the costs of one fixed address per kind and what never leaks (which coins are yours, scanning, membership proofs). The number is an upper bound on what the chain alone allows; timing and amounts known to a counterparty can narrow it further.

## Optional price lookup

The home page can show the balance in USDT, USD, EUR or GBP. The service worker asks CoinGecko (`api/v3/simple/price`, ids `neptune-cash` and `tether`) at most every 5 minutes. The request carries no address or amount; the multiplication happens in the popup. Setting the currency to Off stops these requests.

## Storage

| Store | Contents | Protection |
| --- | --- | --- |
| `kv/vault` | seed phrase | AES-256-GCM, key from PBKDF2-SHA256 (600,000 iterations) |
| `snapshots` | wallet state by height | encrypted with the vault key |
| `kv/activity` | received / sent list | encrypted |
| `sends` | send records; the prepared send (contains the witness) | prepared send encrypted, deleted when done |
| `jobs` | proof jobs (contain lock-script secrets) | encrypted, deleted when done |
| `proofs` | finished proofs | plain: zero-knowledge proofs reveal nothing secret |
| `chrome.storage.session` | the vault key while unlocked | memory only, cleared on lock or browser close |

## What is deliberately left out (for now)

- **Guesser-fee scanning.** Light-wallet users do not mine.
- **Off-chain UTXO notifications.** Everything uses on-chain announcements.
- **Mempool awareness.** Incoming payments show once mined.
- **Block-proof verification in the browser.** Today a block proof certifies only that block's transaction, not the whole chain (`PredecessorIsValid` is `todo!()` in neptune-consensus). The hash chain plus the accumulator check is what this wallet relies on. Comparing tips across two servers is the next step.
