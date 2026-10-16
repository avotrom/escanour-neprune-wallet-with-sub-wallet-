# Security and privacy

## What each party learns

| Party | Learns | Does not learn |
| --- | --- | --- |
| Sync server | your IP; which block ranges you fetch, and when; your approximate wallet age from the first height you fetch | your addresses, keys, balance, which coins are yours, which coins you spend |
| Broadcast server | your IP; the transaction you submit (a ProofCollection: inputs as removal records, outputs as commitments, encrypted announcements) | amounts, addresses, who you pay |
| Upgrader that raises your transaction to a SingleProof | the same public transaction data | anything secret: a ProofCollection is zero-knowledge |
| CoinGecko (if a local currency is set) | your IP; that an NPT price was requested, about every 5 minutes while the popup is open | anything about your wallet |
| Blockchain observers | that a transaction happened, its fee; with lustration, the amount of lustrated inputs | addresses, other amounts |

### How to reduce what servers learn

- **Use two different operators** for sync and broadcast (Settings).
- **Run through Tor or a VPN** if your IP matters.
- **When restoring,** give a birthday height rounded down (for example to a multiple of 10,000) so the start height does not pinpoint when the wallet was made.
- **Optional fresh receiving addresses.** Enable Fresh receiving addresses in the Private controls page to rotate after confirmed receipts. Fixed addresses remain the default. An announcement's `receiver_identifier` is fixed per key, so reusing an address links all its payments on-chain.

## Secrets and where they live

- **Seed phrase:** encrypted with AES-256-GCM. The key is derived from your password with PBKDF2-SHA256 (600,000 iterations).
- **While unlocked:** the raw key sits in `chrome.storage.session`. That storage is memory-only and cleared when the wallet locks (auto-lock, default 15 minutes) or the browser closes.
- **Wallet state, activity, prepared sends and proof jobs** are all encrypted with the same key.
- **The primitive witness** (the data that proves you may spend a coin) is never sent anywhere. Two independent guards:
  1. The send pipeline only ever submits assembled ProofCollections.
  2. neptune-rpc-api refuses to convert a witness-backed transaction into an RPC transaction.
- **Proof jobs contain lock-script witnesses** (spending secrets). They are encrypted at rest, decrypted only inside the proving worker, and deleted when the send finishes or fails.

## Threats and limits

| Threat | Status |
| --- | --- |
| Malicious server sends fake blocks | Caught by the hash-chain check and the accumulator check. A server can still lie about the chain tip (withhold blocks or serve a minority fork). Mitigation: compare tips across two servers (planned). |
| Malicious server withholds blocks | Payments can appear late; switch servers. |
| Malware on the computer | Out of scope. It can read memory while unlocked, like with any software wallet. |
| A web page attacks the extension | No content scripts, no web-accessible resources, no `externally_connectable`. Pages cannot talk to the extension. |
| Weak password | The PBKDF2 cost slows guessing, but the seed is only as safe as the password. The minimum is 10 characters. |
| Lost device | Restore from the 18 words. Without them, funds are lost. |

## Before using real money

- [ ] Build from source and read the diff in `patches/neptune-wasm.patch`.
- [ ] Complete a full cycle on Testnet with mock proofs, then Testnet with real proofs.
- [ ] Restore the same seed in neptune-core or the desktop wallet and confirm it sees the same balance.
- [ ] Get an independent review of `light-core/src/sync.rs` and `send.rs`.


## Data at rest (0.6)

| Stored | Where | Protection |
| --- | --- | --- |
| Recovery phrase | `kv/vault` | AES-256-GCM, PBKDF2-SHA256 600,000 iterations |
| Wallet state, history, notes, contacts | `snapshots`, `kv/activity:<net>`, `kv/contacts:<net>` | encrypted with the vault key |
| Send records | `sends` | recipient, amounts, fee, note and errors sealed with the vault key; only progress (status, proof count, times) is plain |
| Proof jobs, prepared transaction | `jobs`, `sends.prepared` | encrypted, deleted when the send ends |
| Finished proofs | `proofs` | plain (zero-knowledge, public once broadcast), deleted when the send ends |
| Settings | `kv/settings` | plain: servers, theme, language, currency, lock time. The wallet's start height is no longer stored there. |
| Theme and language | `localStorage` | plain, interface only |

## Remaining leaks to know about

- **Sync server:** your IP, and that you are online (the wallet checks every minute while unlocked). A restore also shows roughly when the wallet was created (the first height you fetch).
- **Broadcast server:** your IP and your transaction, at the moment you send. Use a different operator than the sync server.
- **On-chain, per spend:** the AOCL range of each coin (about 90 receipts), so roughly when it arrived; coins spent in one transaction are linked; lustrated coins publish their amount.
- **Fixed addresses:** anyone who knows one of your addresses can see when it receives a payment (receiver identifier), not the amount.
- **EC Hybrid addresses:** notification encryption is elliptic-curve; a future quantum computer could read past notices to EC Hybrid addresses (not spend).
- **Fast restore (opt-in):** the server you restore through learns the receiver identifiers of your keys (every payment to them) and the index sets of your coins (it can recognise them when spent). It cannot give you fake coins: every membership proof is checked against the block's own mutator set. Restore through your own node, or choose the private full scan, to avoid this.
- **Notifications:** amounts appear in Chrome notifications, visible on screen. Turn them off in Settings if others can see your screen.
- **Price lookup:** CoinGecko sees your IP when the popup opens. Settings > Price lookup off stops every request, or Tor hides the IP.
- **Tor:** with Connect through Tor, servers and CoinGecko see a Tor exit instead of your IP; if Tor stops, the wallet stops connecting rather than falling back. One server used for both sync and broadcast can still link them by timing, even through Tor.
- **Own node:** Settings > Servers > Use my node sends sync and broadcast to neptune-core on 127.0.0.1 (`--listen-rpc --rpc-modules Node,Chain,Wallet`). No outside server then learns your IP, online times or transactions before they reach the network.

## Experimental private app notification format

Version 0.23 provides an optional Encrypted sub-wallet with a test-network wrapper for both Generation and EC Hybrid. It keeps the stable destination identifier inside a sealed box and suppresses the ordinary destination announcement. It is not an audited recipient-anonymity protocol and is disabled on mainnet at both UI/backend and Rust layers. The EC-based outer layer is not post-quantum private, including when the inner address is Generation.

One scanning key is re-derived from the seed and network in Rust. Test-network block scanning continues even after the publishing/sending switch is disabled. Fast receiver-ID indexing cannot recover these notifications; seed restore uses a full scan. Existing ordinary viewing keys and watch-only registrations cannot discover them. A future separate private viewing-key export is not implemented.

A successful decryption is not a credit. The existing decoder checks the inner notification's ownership and type scripts, and normal sync requires its addition record in the block before creating a coin and membership proof. Valid envelopes replayed without the payment addition do not add funds. Malformed, foreign and unauthenticated envelopes are ignored.

The marker and version are public, ciphertexts are fixed-size, and IP/timing information is outside the protection. Scanning-key compromise permits historical envelope decryption; the outer layer has no receiver-compromise forward secrecy. Review the complete protocol, concrete crypto dependencies and scanning performance before production. See [PRIVATE-NOTIFICATIONS.md](PRIVATE-NOTIFICATIONS.md) for the specification and remaining validation gate.

The sub-wallet selector beside Tor creates Auto-refresh or Encrypted on request; only Standard exists by default. Privacy check is in Settings. Encrypted has a dedicated recovery page covering both address types. All sub-wallets share a recovery phrase but have separate coin selection and change. Encrypted children share a public scanning key, so complete addresses can be linked by their holders even when payment keys differ. No automatic mixing or self-sweep runs. A warning cannot undo past disclosure. The optional encrypted recovery file restores the seed, not local metadata, outgoing message copies or pending sends; its password is required unless the seed is preserved separately. See [SUB-WALLETS.md](SUB-WALLETS.md).
