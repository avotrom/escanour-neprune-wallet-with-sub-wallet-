# Private payments: address policy, privacy, speed and recovery

Review date: 15 October 2026. Scope: supplied `neptune-light-0.21.0-source.zip`, pinned Neptune commit `cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04`, and the accompanying 0.22 experimental source prototype. This is source analysis and local testing, not an independent security audit or live-node certification.

## Decision

The wallet-only architecture is plausible in this source. Ordinary Neptune transactions carry a custom announcement, attached before proving. Nodes need no new notification logic. This light wallet handles keys, decoding and membership proofs locally, so it does not call a full node's `claim_utxo` endpoint. Actual node acceptance, mining and the real proof path still require testing.

Keep normal and private receiving options in one wallet, with explicit mode controls and distinct receiving keys. The prototype implements this. It also adds an optional recipient-readable message, private activity, scanning progress and recovery controls. Mainnet remains disabled.

The feature targets the fixed recipient identifier in notifications. It does not make the entire transaction, sender, network connection or spending behavior anonymous.

## Does a private address only need private mode?

The address is a protocol instruction plus public key material. A button or address label alone provides no protection. The following capabilities are necessary:

| Capability | Why it is needed | Prototype status |
| --- | --- | --- |
| Version, checksum and network-bound address parsing | Avoid incompatible or wrong-network destinations | Implemented; malformed and unsupported destinations fail |
| Public payment address plus anonymous-envelope scanning key | Construct the normal output and encrypt discovery data | Implemented in the `nescan1…` address |
| Mandatory private construction for this address | Stop accidental standard-mode downgrade | Implemented in UI, backend and Rust destination handling |
| Suppress the standard destination announcement | Avoid publishing its fixed receiver identifier | Implemented using an off-chain output policy |
| Fresh envelope and output randomness | Avoid deterministic repeats | Implemented |
| Attach the envelope before witness/proof creation | Keep announcements inside the proved kernel | Implemented; witness validation tested |
| Local discovery, ownership and addition-record checks | Recover real payments and reject irrelevant/replayed notices | Implemented and mock-chain tested |
| Stable seed derivation and complete historical scan | Recover after losing the app | Implemented for test networks |
| Protection details and downgrade warning | Show what the app observed for a receipt | Implemented for known standard notices to the private receiving key |
| Cross-wallet specification, test vectors and independent audit | Establish interoperable, reviewed behavior | Still required before production |

The complete private address always selects private sending in compatible software. An ordinary address does not contain the extra scanning key, so switching on Private mode cannot magically upgrade it. Ask for the recipient's complete private address. A memo is optional; encrypted payment recovery data is mandatory.

No capability negotiation server is needed for this v2 prototype: its address version identifies the supported format. Future versions should define feature and size negotiation explicitly, with rejection rather than silent fallback. Do not freeze this experimental wire format as a public standard yet.

## How the recipient controls private receiving

1. Enable the experimental feature on a test network.
2. Open **Receive → Private** and share only the complete private address. It uses a dedicated receiving key, distinct from the wallet's ordinary EC Hybrid address. Keep standard and private addresses in distinct contact entries and public profiles when separation matters.
3. A compatible sender must use the private envelope. The app refuses a standard send to that address and refuses private mode with a normal address.
4. After confirmation, the payment details show a valid private envelope or a detected exposed identifier. If a sender published both notification forms, the wallet credits the coin once and warns about the standard one.

These are wallet controls. The underlying Neptune output does not enforce this address policy. A sender knows the public inner receiving address and can deliberately publish a normal notification or disclose it elsewhere. Unchanged consensus cannot prohibit that. Warnings detect known standard notifications in scanned blocks; they cannot detect every arbitrary leak, every disclosure on another service, or a server omitting data. A valid private envelope proves successful opening and association with a payment, not that no other disclosure exists.

Do not reject or discard ownership of a real coin merely because its notification was public: that would not erase the leak and could hide the user's funds. The prototype credits it and reports the observed loss of protection.

## Normal and private addresses in the same wallet

Normal notifications already encrypt payment recovery data. Their public fixed receiver identifier enables fast lookup and can link receipts to a known address. The private wrapper hides that identifier inside fresh ciphertext and removes the normal destination announcement.

Using the exact same receiving key for normal and private activity would create an avoidable connection. This prototype instead reserves EC Hybrid index `0x4553434e505631` for private receipts, plus a separately derived scanning key. The two receiving branches differ while retaining one seed. Private child i uses reserved index `0x4553434e505631 + i`. Private indices are never sent to the ordinary receiver-ID restoration index and do not advance normal address counters.

Separate receiving keys are useful, but this remains one funding wallet. Coin selection, change outputs, AOCL ranges, lustration disclosures, co-spends and transaction timing may connect activity. There is no separate private balance or spending policy. Stronger operational separation would require separately managed funds, coin control and an explicit change policy, or a separate seed/wallet. Even that would not by itself guarantee anonymity.

No extra mixing transaction is inherently required to deliver the encrypted notification. Adding a server or a second transfer is not automatically a privacy improvement.

## Fresh addresses: what changes and what does not

The Private controls icon beside Tor and Settings opens a compact menu; **Fresh addresses**, off by default, opens its own page. The page uses the same centered icon/status/control pattern as Tor. On/Off includes both text and a green/red dot, so status does not rely on color alone. When enabled, Generation, EC Hybrid and private payment keys rotate after a confirmed receipt. Reopening Receive leaves an unpaid address unchanged; there is no manual button that can accidentally generate hundreds of unused gaps. The Receive sheet updates after a confirming sync, and all previous addresses keep working. The setting cannot stop someone paying a saved old address or using one address for several unconfirmed payments.

Normal rotation uses existing deterministic key indices and the normal 20-key lookahead during restoration. Private v2 adds the receiving-child index inside the encrypted envelope: the receiver opens it with one scanning key and derives the specific payment key directly. This supports restoration even for a child beyond the normal gap without trying thousands of notification keys. Standard-notice downgrade detection uses cached known children plus lookahead, with an extra check for every opened child's public duplicate notice.

There is an explicit compromise: private addresses retain the same public scanning key. Holders of multiple complete addresses can link those addresses. No fixed scanning key or child index is published in the transaction's outer envelope, but this is not a fully unlinkable private-subaddress scheme. Independent per-address scanning keys would increase trials and complicate restoration. A reviewed subaddress construction supporting one scanning key and unlinkable public addresses would be a separate protocol project; it is not introduced through custom cryptography here.

## Automatic mixing, self-transfers and leak detection

The proposed automatic repair has three separate goals: detect exposure, avoid future reuse, and improve the anonymity of spending. Only the first two are implemented. Calling all three “auto mix” would mislead the user.

| Proposed action | What it can achieve | What it cannot establish |
| --- | --- | --- |
| Detect a standard notice for a private receiving key | Report the fixed identifier observed in scanned chain data | Detect arbitrary external disclosures, every recognizable message, or a sender's private logs |
| Inspect a contact label or local-only note | Keep it encrypted on this device | Infer that the chain is exposed merely from the existence of a local label |
| Rotate the address shown after a leak | Reduce future reuse when the new address is shared | Revoke an old address or erase a confirmed notification |
| Send the coin to yourself through an encrypted envelope | Move funds to another key; conceal the new notification identifier | Create a proven anonymity set or erase origin information |
| Move to a fresh seed/new wallet | Establish a separate key set for future use | Make the migration transfer unlinkable or make the old seed unnecessary before reconciliation |
| Use an actual mixing protocol | May offer specific anonymity properties if correctly designed and deployed | Guarantee privacy merely because a transfer was delayed, split or renamed |

Neptune spending exposes constraints such as coin ranges; co-spends, lustration, counterparties, timing and amount knowledge may narrow them. Automatic self-sweeps can combine coins, incur fees, trigger disclosure rules, compete with pending sends and complicate restoration or reorg reconciliation. An encrypted intra-wallet message does not remove those constraints. This conclusion follows from the inspected wallet's notification and spending paths; no mixing implementation was present to validate.

The implemented parameter is **Rotate private address after a detected leak**, on by default. It preserves ownership and balance, shows an alert and changes future address selection. Turning it off preserves the warning but stops the forced rotation unless Fresh addresses is enabled. It performs no automatic transfer. Automatic mixing is omitted from the interface; this analysis explains why no mixing action was implemented. There is no claim that a local label is public; contact names and local notes stay vault-encrypted. Recipient-message contents are deliberate disclosures to the recipient and cannot be reliably classified as safe by an automatic detector.

A production auto-mixing feature would need a defined protocol and privacy target, independent analysis of actual Neptune input/output leakage, fee and amount limits, explicit spend authorization, coin separation and change rules, cancellation, reorg/pending-transaction handling and new-wallet backup verification. Those gates are unmet. The prototype exposes the reviewed address response, not a fake mixing switch.

## Optional encrypted message

The payment notification and optional UTF-8 message share one 4096-byte padded plaintext. The message is limited to 512 UTF-8 bytes, not 512 characters. Empty and nonempty messages produce the same 4144-byte sealed box and 594-field-element announcement. The memo therefore adds no extra public message-length signal within this format; the private format itself remains recognizable.

Sealed boxes provide ciphertext integrity and confidentiality as a building block. They do not authenticate the sender's identity. The app shows incoming text as untrusted content, uses text rendering rather than HTML, and keeps it out of desktop notifications. Local storage encrypts messages under the existing wallet vault. A sender's local-only note remains a separate field and is never put into the envelope.

The scan key can decrypt historical envelopes; this design has no forward secrecy after its compromise. The outer X25519 construction is not post-quantum private. A recipient may copy or reveal any message received, and its wording may identify its author. [Libsodium's sealed-box documentation](https://doc.libsodium.org/public-key_cryptography/sealed_boxes) describes the underlying construction; it does not certify this complete protocol's recipient anonymity.

## Performance: what was measured

The main additional costs are on-chain data, downloading it, trial decryption of every matching custom envelope, and any proof/hash work induced by the larger kernel. Checking the public common marker avoids asymmetric decryption for ordinary announcements. One dedicated scanning key avoids multiplying trials across a normal address gap.

A small native debug sample on this development machine, with 100 announcements of each kind, reported:

| Operation | Total for 100 | Approximate time per item |
| --- | ---: | ---: |
| Skip ordinary announcements by marker | 0.010 ms | 0.107 µs |
| Try a foreign private envelope | 42.372 ms | 424 µs |
| Open an own envelope | 68.758 ms | 688 µs |

This was an unoptimized native microbenchmark. It does not measure browser/WASM performance, ownership checks for every item, block verification, full restore, download volume, fees or proving. Do not use it as a production throughput claim. CPU cost grows approximately with matching envelopes × scanning keys. Linear extrapolation from this sample would put one million foreign trials around 7.1 minutes of native debug decryption alone; actual restoration could differ substantially.

Each envelope contains 4752 bytes of field-element data before announcement framing, transaction containers and RPC serialization. One million envelopes would therefore contribute about 4.75 GB of field data alone. The optional message does not change that size. There is no measured claim that private sends have equal fees or proof time to standard sends.

Strict size checks and one key bound an individual trial. They do not bound the total work an attacker can induce with many well-formed foreign envelopes. Browser responsiveness, cancellation during a large block, mobile memory and adversarial-load behavior need dedicated testing.

## Can blocks or a server make recovery faster?

| Method | Benefit | Privacy/completeness tradeoff | Status |
| --- | --- | --- | --- |
| Full local scan from genesis | Seed-only discovery without recipient queries | Slowest initial download; server still sees IP and requested heights | Implemented default for test-network restores |
| Known earliest wallet payment block | Skips earlier history | Wrong/later start omits older normal and private coins; start height may reveal approximate wallet age | Implemented; input `h` starts at `max(0,h−1)` so block `h` is included |
| Faster or local full node | Improves block delivery and avoids trusting a remote operator with recipient searches | Does not remove local trial-decryption cost; local node still participates in normal network propagation | Existing server settings preserved |
| Public index of all shared-format announcements | Could download only relevant-format data, without a recipient tag | Needs completeness/authentication and correct accumulator updates; an untrusted index can omit payments | Future work; no new server built |
| Recipient-specific index or server-held scan key | Potentially much faster recipient lookup | Exposes linking information or historical messages to the service | Not used |
| Block-targeted private addresses | Could constrain when scanning is needed | A permanent address must accept payments outside any particular target window; dropping other blocks breaks recovery | Not used |

A block hint should be a local optional optimization, never a condition that makes later payments undiscoverable. Restore from genesis if the earliest wallet receipt is unknown. The rescan control rebuilds the entire wallet; it is not a private-only additive history search.

An anonymous-envelope index alone is not a full light-wallet restore solution: membership proofs, additions/removals, reorg handling and authenticated completeness still matter. Ordinary receiver-ID index queries cannot find this wrapper, which is why test-network restoration bypasses that index.

## Seed phrase or encrypted backup file?

| Item | Same seed + network + compatible app + full chain scan | Local backup needed for exact restoration? |
| --- | --- | --- |
| Private receiving address and scanning key | Re-derived deterministically | No |
| Confirmed private coins and their spend tracking | Reconstructed by scanning and updating membership proofs | No, if required chain data is available |
| Received encrypted messages | Decrypted again from confirmed envelopes | No |
| Sender's copies of messages sent to other people | Recipient's key is needed to open those envelopes | Yes, preserve local copies if wanted |
| Local labels, contacts, local-only notes and preferences | Not encoded by the seed | Yes, for exact restoration |
| Unconfirmed or unfinished send jobs | May never reach the chain | Yes, local state is required; handle reconciliation carefully |
| Optional scan start block | Can always be replaced by genesis | No; useful speed hint only |

The seed alone is the secret material required for confirmed recovery, but it is not a self-contained copy of the blockchain or of the format specification. A compatible application must retain the derivation and wire-format rules. Preserve those rules and test vectors across future versions. The prototype uses the existing 18-word phrase. It does not add a second secret phrase or require an extra encrypted file for confirmed private funds. It includes an optional encrypted seed-only recovery JSON, exported after checking the current wallet password. Restore → Import file decrypts it locally using its original password; then the user chooses the network, scan start and a new local wallet password through the existing restoration flow. This is not a complete metadata or pending-send backup. Losing the file password does not prevent recovery with a separately preserved seed phrase.

The encrypted file uses WebCrypto AES-256-GCM, PBKDF2-HMAC-SHA256 with 600,000 iterations, fresh salt and IV, and authenticated format metadata. Import rejects unsupported KDF parameters before doing expensive work. This follows the API mechanisms specified in the [W3C Web Cryptography specification](https://www.w3.org/TR/webcrypto/#aes-gcm); it is not a claim that this particular recovery format has been audited. Export is optional and uses the existing wallet password, so a strong password still matters. No plaintext seed is returned to the UI during export. Import necessarily makes the seed available locally for wallet restoration.

## Validation and remaining work

Local checks passed: native core tests (19 passed, 1 optional benchmark ignored), the benchmark separately, 26 JavaScript regression tests, JavaScript syntax/DOM bindings, native CLI compilation, and WASM compilation for both browser modules. Tests cover seed restoration, optional messages, tampering, wrong recipients/networks, suppression of normal notifications, witness validation, mock-chain receipt/spending/replay and duplicate standard/private notification detection.

Browser UI checks used a local mocked backend with fake addresses and balances. At 360px extension width, the compact menu, Tor-style fresh-address page, main-address shortcut, refresh feedback, simplified Send and Receive, private-mode error and plain-text message review were checked. Watchlist visibility is restricted to Watch-only. The basic Send flow leaves advanced fields under Options and optional recipient messages expandable; Receive shows an address number and hides full addresses until requested. They validate layout, mode selection, no-downgrade errors, message text rendering, conceal/reveal controls and translated interface behavior. They do not demonstrate an installed, built extension sending funds.

Before enabling production: run unchanged-node admission, relay, mining, offline receive, spend, clean restore, reorg and real-proof tests; measure browser recovery/proving under normal and adversarial load; review recipient anonymity/key privacy, active attacks, dependency versions, derivation and metadata; and define cross-wallet interoperability vectors. Source compatibility is encouraging, but it is not evidence that those deployment gates have passed.

Implementation details: [PRIVATE-NOTIFICATIONS.md](PRIVATE-NOTIFICATIONS.md). Actual release validation: [RELEASE-0.22.md](../RELEASE-0.22.md).
