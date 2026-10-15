# Private app notifications: feasibility and prototype

This design is feasible at the wallet layer in the supplied 0.21.0 source. The prototype keeps the existing Neptune consensus and RPC protocol. It is opt-in, test-network-only, and has not received a cryptographic audit. It must not be described as proven recipient anonymity or used with mainnet funds.

## How this app differs from the proposed full-node wrapper

This is a light wallet. It already derives keys, constructs the primitive witness, makes proof jobs and maintains UTXO membership proofs on the device. It does not use a local full node's wallet. After opening an envelope it therefore calls its existing local notification decoder, checks ownership and type scripts, matches the addition record in the block and maintains the membership proof through its existing sync path. It does not send the recovered notification to a public node or call a remote personal/claim endpoint.

For a separate app that owns a local Neptune full-node wallet, forwarding the recovered standard notification to that local node remains a possible alternative architecture. This prototype implements the light-wallet path only.

## What was added

- A `nescan1…` Bech32m app address containing version, network ID, one public scanning key, a receiving child index and a dedicated EC Hybrid receiving address. Private child `i` uses reserved index `0x4553434e505631 + i` (0 ≤ i ≤ 2³²−1), distinct from the normal EC Hybrid branch. The ordinary key gap never expands to that reserved index. A fixed private address remains available by default; optional rotation selects the next child after confirmed receipts. No secret is in an app address. Existing addresses remain usable.
- A single scanning key derived from the wallet entropy with SHA-256, a format-specific domain and network ID. Restoring the same 18-word seed derives the same app address and scanning key. There is no extra scanning secret to back up.
- The normal payment output uses `TxOutput::offchain_native_currency`, so its ordinary on-chain receiver-identifier announcement is absent.
- The standard `utxo…` notification is padded and wrapped using the `crypto_box` crate's libsodium-compatible sealed-box format (X25519 + XSalsa20-Poly1305), with fresh ephemeral randomness. The permanent scanning public key is not a cleartext field in the announcement.
- Private payments use fresh sender randomness for the output commitment as well. Two equal payments prepared at the same height do not reuse the payment output commitment.
- The envelope is attached with `with_announcements` before `primitive_witness()` and proof-job construction. Proof assembly and normal transaction submission then proceed through the existing code.
- Full block scans try the one scanning key on matching custom announcements. Malformed, foreign, oversized, unauthenticated or unowned notifications are ignored. An envelope alone never credits funds: its addition record must be present in that block.
- An optional recipient-readable message of up to 512 UTF-8 bytes shares the fixed-size encrypted envelope. Empty and nonempty messages have the same public envelope length. This is separate from the sender's local transaction note. Received messages and outgoing local copies are encrypted at rest with the wallet vault; message text is rendered as text and is never put in desktop notifications.
- A dedicated Private controls icon beside Tor and Settings, explicit send mode, a private Receive tab, hidden-by-default private address/QR, progress, receipt protection details and English/French/Arabic labels. Mainnet is blocked in both the service worker and Rust. Turning off the switch stops address publication and new private sends; test-network scanning continues so an already published address keeps working.
- Compatible senders reject a private address in Standard mode and reject a normal address in Private mode. Malformed app addresses, wrong networks, encryption errors and oversized messages fail instead of falling back. Contacts can store a private address as a separate contact entry; it is not paired with a standard fallback address.
- Receipt warnings detect a standard on-chain notification to the reserved receiving key, including when a valid private envelope accompanies the same coin. This does not detect arbitrary disclosures by a sender or a disclosure on another service or chain.
- All test-network seed restores use a full scan in this build. Existing mainnet restore modes are unchanged. Public receiver-ID indexes cannot discover this format.

## Try the prototype

Build both WASM modules using `docs/BUILD.md` or the included GitHub Actions workflow. Old WASM binaries cannot be reused because this version adds a binding. This ZIP is source, not an install-ready extension.

1. Configure a testnet or testnet-mock node in Settings → Servers.
2. Select that network, then open the Private controls icon beside Tor and Settings and enable **Private payments** on its own feature page.
3. Open **Private controls → Private payments → Receive privately**, or **Receive → Private**, and share the complete `nescan1…` address with another instance of this build. Address and QR are concealed until explicitly revealed; Copy still copies the complete address.
4. Select **Private controls → Private payments → Send privately** and use that address. You may add an encrypted message, or leave it empty. Pasting a private address into Send selects the private mode. Both instances need the experimental option for publishing/sending. Standard wallets do not understand this address or notification.
5. Let the receiving wallet scan the confirming block. It uses the recovered coin through the existing spending path.
6. Restore the receiver's seed in a fresh compatible installation on the same network and scan from before the earliest wallet payment. Test-network restore uses a full scan automatically. A new wallet started at the current tip intentionally does not discover older payments. The Private details panel can restart a scan from genesis (empty field) or just before a known earliest wallet payment block. This replaces the entire wallet scan state: selecting a later block omits earlier normal and private coins until an earlier rescan.

The seed recreates both keys. Confirmed private funds and received messages are recoverable from the chain without an encrypted backup file. Local contact names, local notes, outgoing message copies, unfinished sends and preferences are not all on-chain and cannot be recreated from the seed. In particular, the sender cannot decrypt a recipient-only message after losing its local copy. The Private controls page can export an optional password-encrypted seed-only recovery file. Restore → Import file opens it with its original password; then use the normal restoration flow, select the same network and scan. The file does not back up local metadata or pending sends. See [PRIVATE-MODE-REVIEW.md](PRIVATE-MODE-REVIEW.md) for the recovery comparison.

The CLI also exposes `private-address` (requires only the seed and a test network, not a state file). `send` accepts the app address and `sync` performs the full scan:

```sh
cargo run --release -p light-cli -- --network testnet-mock private-address
cargo run --release -p light-cli -- --network testnet-mock send <nescan-address> 1.0 0.05
```

The CLI is a test harness and stores its state unencrypted as before. Keep test wallets separate. See the node validation checklist below before treating the prototype as working end to end.

## Wire format v2 (experimental; do not freeze as an ecosystem standard)

App address payload, Bech32m HRP `nescan`: version byte `02`, four little-endian bytes of `Network::id()`, 32 bytes of X25519 scanning public key, eight little-endian receiving-child-index bytes, then the ASCII EC Hybrid address. The checksum covers everything. The inner address is parsed for the same network; child indices above 2³²−1 and low-order scanning public keys are rejected. This format is EC-based, not post-quantum private.

Announcement message: field element `0x4553434e505631` (the shared family marker retains its original value), field element `2`, then sealed-box bytes packed seven bytes per field element in little-endian order. Every packed field has a zero eighth byte; noncanonical words and incorrect lengths are rejected. There is no cleartext destination key, receiver ID, address hash, child index or recipient lookup tag in the announcement. The marker and version are common to all recipients.

Plaintext: 8-byte ASCII context `ESCNPV02`, four little-endian network-ID bytes, two little-endian notification-length bytes, two little-endian message-length bytes, eight little-endian receiving-child-index bytes, the standard notification string, the UTF-8 message, then zero padding to exactly 4096 bytes. Notification plus message must fit in 4072 bytes; the message itself is limited to 512 bytes. The sealed box is 4144 bytes; the announcement is exactly 594 field elements (4752 bytes for the elements before container framing). Oversized payloads fail instead of reverting to a public notification. Network, context, lengths, child range, UTF-8 and zero padding are checked after authenticated decryption.

The encrypted child index lets a restored wallet derive exactly one receiving key, even beyond the normal lookahead. The existing ownership/type-script decoder checks that key, followed by sync's addition-record check. All private children share one scanning key, so outer trial decryption does not multiply with the number of private addresses. Standard-notice downgrade detection also scans cached known private children and a 20-key lookahead; a child opened from an envelope gets an explicit duplicate-standard-notice check even beyond that gap. A standalone standard notice beyond this gap without a private envelope may require the preceding history to be scanned first.

The reader continues to accept the earlier experimental v1 address (no child index, child 0) and envelope (version 1, context `ESCNPV01`, 16-byte header). New writers emit v2. These pre-release formats are not ecosystem standards.

Scanning-key derivation: SHA-256 of ASCII `escanour/private-notification/scanning-key/v1` followed by a zero byte, four little-endian network-ID bytes, and each BFieldCodec field element of the wallet's secret XFieldElement seed encoded as its canonical u64 value in little-endian order. The 32-byte digest is the sealed-box secret key input, clamped by the library. It is kept inside Rust, never exposed as a browser message or written as an extra state field. The key derivation and wire format require independent review before production.

## Fresh addresses, leak response and optional recovery file

The private menu contains separate feature pages. Each follows the Tor page layout: a centered icon/status, main control and expandable details. A green/red dot accompanies On/Off. The watchlist stays on Watch-only. The Addresses tab includes a fresh-address shortcut; its refresh button checks for confirmed payments and does not manually advance unused keys. Send and Receive keep mode indicators visible while optional messages, advanced send fields and technical information are expandable. Full receive addresses are shortened by default, with explicit reveal and full-address copy/download.

The Fresh addresses page has an opt-in **Fresh addresses** switch applying to Generation, EC Hybrid and private receipts. It shows the next unused receiving payment key after a confirmed receipt. Reopening Receive does not burn unused indices, and an open Receive sheet refreshes after a confirming sync. Old addresses stay valid; a sender cannot be forced to stop reusing one. Normal address restoration uses the existing gap scan. Private v2 restoration reads the encrypted child index directly.

The private scanning public key remains shared across private addresses. Anyone holding two complete app addresses can therefore link them; rotation is not unlinkable address generation. It reduces reuse of payment receiving keys while retaining one outer scanning key. Funds, change and spending are still shared.

**Rotate private address after a detected leak** is on by default. It warns about observed standard notices and selects the next private payment key for future address publication. It never transfers funds. Automatic mixing is omitted from the interface: this source has no reviewed mixing protocol, and a self-transfer is not a reliable remedy for disclosure. See the separate review for the deeper analysis.

The optional encrypted recovery JSON is seed-only. Export requires the current wallet password. WebCrypto PBKDF2-HMAC-SHA256 with 600,000 iterations and a fresh 16-byte salt derives an AES-256-GCM key; each export has a fresh 12-byte IV and a fixed format/version/algorithm header bound as authenticated additional data. Import strictly checks version, algorithms, sizes and iteration count before deriving a key, preventing file-supplied unbounded KDF work. Its security depends on the password and device. The file plus its password can restore the seed on a new compatible installation; it is not a new seed or a separate wallet. The same seed written offline remains sufficient for confirmed recovery.

## Privacy limits and review still required

The code omits the stable recipient identifier from the public wrapper. Sealed-box encryption is a standard building block, but that fact does not establish recipient anonymity for this entire protocol. Review key privacy, active attacks, adversarial addresses, key derivation, implementation side channels, the concrete crate version and cross-wallet interoperability. Tests demonstrate behavior, not a security proof.

Observers can identify this format and its small user population. The sender knows the recipient and can extract the public inner receiving address. The address policy is enforced by compatible wallet software, not by Neptune consensus: it cannot prevent a malicious sender from publishing an extra ordinary notification or other data. A receipt warning cannot undo a confirmed disclosure. Network IP addresses, timing, address publication and other wallet behavior can still reveal information. Normal and private receiving keys are separate, but funding, change and spending remain one wallet; this is not coin-selection isolation. Compromising the scanning key reveals historical messages and recovery metadata; the outer layer has no forward secrecy against receiver-key compromise. Knowledge of a scanning key alone does not disclose the inner spending secret, but compromises notification privacy.

Padding hides notification and optional-message length within v2, at a substantial on-chain overhead. Trial decryption adds work per custom envelope, including hostile envelopes. One scanning key, a fixed envelope size and strict parsing bound the per-envelope cost. A small native debug sample measured approximately 424 microseconds per foreign envelope and 688 microseconds per own envelope; this is not a browser or end-to-end benchmark. Full scan, proving, relay, mobile responsiveness and denial-of-service performance remain unmeasured. Details and proposed improvements are in [PRIVATE-MODE-REVIEW.md](PRIVATE-MODE-REVIEW.md).

Sealed boxes authenticate ciphertext integrity for the recipient; they do not authenticate the sender's identity. Messages are untrusted text. Neither the UI nor protocol calls a decrypted message proof of who wrote it. A message can also reveal its author through its contents to the recipient.

Ordinary Generation/EC Hybrid viewing keys and the existing watch-only/indexed-scan features do not include the new scanning key. They cannot discover private app payments. Prototype recovery uses the full seed in a compatible app and a full block scan. A separate private viewing-key format is future work.

## Verification and live-node acceptance gate

The release notes record checks actually run and their results. Unit tests include encryption/tampering, network and mainnet guards, deterministic seed recovery, proof-witness construction, suppression of the standard destination announcement, and a mock chain with receipt, spending and replay. Mock blocks deliberately have invalid block proofs and no valid proof of work. They are not evidence that a node mined or accepted a transaction.

Before production, use unchanged Neptune nodes on a local test network to demonstrate: sender funding; transaction admission and relay; mining; recipient discovery while previously offline; spending the recovered output; a clean seed restore; replay/tampering rejection; a short reorg; and the real proof path on a network requiring valid proofs. Record node versions and transaction/block IDs. Independently audit the protocol and implementation before considering mainnet support.

## Source basis

The supplied ZIP pins Neptune commit `cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04`, crates 0.19.0. The request's links point to a different commit, `0a759c3…`. This implementation targets the ZIP's pin; it does not silently upgrade Neptune.

- [Pinned Announcement definition](https://github.com/Neptune-Crypto/neptune-core/blob/cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04/neptune-consensus/src/transaction/announcement.rs)
- [Pinned output notification policy](https://github.com/Neptune-Crypto/neptune-core/blob/cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04/neptune-wallet/src/transaction_output.rs)
- [Pinned transaction construction](https://github.com/Neptune-Crypto/neptune-core/blob/cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04/neptune-wallet/src/transaction_details.rs)
- [Sealed-box construction](https://doc.libsodium.org/public-key_cryptography/sealed_boxes)
