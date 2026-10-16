# Node endpoints used

All requests are JSON-RPC 2.0, sent as `POST /` to a neptune-core node (default port 9797). The node must serve the `chain` and `wallet` modules.

Method names are `<namespace>_<method>` in camelCase. Params are positional arrays. Request bodies are built in wasm from neptune-rpc-api's own request types, so the encoding always matches the node.

| Method | Params | Used for | What the server learns |
| --- | --- | --- | --- |
| `chain_height` | `[]` | find the tip | nothing |
| `wallet_getBlocks` | `[from, to]` | download blocks as kernel + `proof_leaf` (no proof); at most 100 per call unless the node runs `--unsafe-rpc` | the height range |
| `wallet_submitTransaction` | `[transaction]` | broadcast a ProofCollection-backed transaction | the transaction |

## Used only by fast restore (the user chooses it)

On the restore screen the user picks how to find their coins: **Fast**, **Fast with my own node**, or **Private full scan**. The two fast modes use these methods once, during the restore; afterwards the wallet syncs privately as usual.

| Method | Params | Used for | What the server learns |
| --- | --- | --- | --- |
| `utxoindex_blockHeightsByFlags` | `[[{flag, receiver_id}, ...]]` | which blocks hold announcements for the wallet's keys | the receiver identifiers of the wallet's keys, so every payment to them |
| `wallet_restoreMembershipProof` | `[[index sets]]`, at most 256 per call | membership proofs of the coins found, relative to the node's tip | the coins' index sets, so it can recognise them when spent |
| `utxoindex_blockHeightsByAbsoluteIndexSets` | `[[index sets]]` | where spent coins were spent, for the history | nothing more than the call above |

Every proof is checked locally against the mutator set of the block it is relative to, and that block's hash and mutator set are checked against the block itself. A server can hide coins, but cannot invent them. With the user's own node (`--utxo-index`), nobody else learns anything. A server without the UTXO index answers the first call with an error, and the wallet falls back to the private full scan.

## Never used in normal operation

| Method | Why not |
| --- | --- |
| `wallet_restoreMembershipProof` (outside fast restore) | It sends the index sets of the coins you hold. When you spend, the same index set appears on-chain, so the server can link you to the transaction. This wallet maintains membership proofs itself. |
| `archival_areBloomIndicesSet`, `archival_batchAreBloomIndicesSet` | Same leak. Spends are detected by matching block inputs locally. |
| `personal_*` | These manage the node's own wallet, not yours. |

## Running your own server

Any neptune-core node works:

```bash
neptune-core --listen-rpc=0.0.0.0:9797 --rpc-modules "node,chain,wallet"
# for fast restore, also: --utxo-index and the "utxoindex" module
```

Put it behind HTTPS (for example with Caddy), then enter its URL in Settings. Do not expose `--unsafe-rpc` or the `personal` module publicly.

## Response handling

- **JSON-RPC errors** arrive with HTTP 200 and an `error` object. The extension surfaces them as `node: {...}`.
- **"Not confirmable"** (`SubmitTransactionError::NotConfirmable`) means the transaction was built against a mutator set the node no longer accepts. The wallet syncs, rebuilds with the same inputs and proves again.

## Experimental encrypted app notifications (0.23.1 prototype)

The wrapper uses the same block-download and transaction-submission endpoints above. It adds no RPC endpoint and never forwards decrypted notifications to a public node. This light wallet checks notifications and maintains membership proofs locally. See [PRIVATE-NOTIFICATIONS.md](PRIVATE-NOTIFICATIONS.md).

Indexed recovery queries ordinary sub-wallet receiving/change flags plus shared encrypted format/version flags, then decrypts locally and requests membership proofs. It never uploads the scanning key. The user can select Fast, Private scan or Own node on every sub-wallet. If indexed discovery fails, the wallet falls back to full scanning. A malicious index can still omit payments. If the user selects their own node, that node is still used as the block source. Encrypted app notifications are disabled on mainnet.
