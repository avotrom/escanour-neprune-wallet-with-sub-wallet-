# Three sub-wallets in one app

Current design, 16 October 2026. This replaces the earlier shared-balance mode and payment-link proposals. The source prototype is 0.23.3-alpha.1, based on the supplied 0.21 ZIP and pinned Neptune commit `cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04`.

| Sub-wallet | Created by default | Receiving addresses | Behavior |
| --- | --- | --- | --- |
| Standard | Yes | Generation + EC Hybrid | One fixed address of each type |
| Auto-refresh | No; Create sub-wallet | Generation + EC Hybrid | The paid address advances after a confirmed receipt |
| Encrypted | No; Create sub-wallet, testnet only | Encrypted app address for Generation + encrypted app address for EC Hybrid | Dedicated keys, hidden recipient notification, optional recipient message |

These are application sub-wallets, not a new consensus account or username system. Generation and EC Hybrid are Neptune address types. See upstream [address implementations](https://github.com/Neptune-Crypto/neptune-core/tree/cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04/neptune-wallet/src/address) and [release terminology](https://github.com/Neptune-Crypto/neptune-core/releases).

## Minimal interface

The sub-wallet selector sits beside Tor. Only Standard exists on a fresh installation. The optional rows open a symmetric, Tor-style page with one Create action and expandable Details. Creating a sub-wallet opens its own home. Switching to an existing other sub-wallet changes the title, balance, two address cards, receiving addresses, payment history and payment source. Selecting the current wallet's row opens its details.

The charcoal background, translucent action buttons and soft address cards follow the supplied visual reference. Standard uses a violet balance card, Auto-refresh teal and Encrypted plum. The screen has one balance and two address cards. Auto-refresh shows its status and address numbers; Encrypted shows encrypted receipt status and its optional message field. Color indicators also have text. Watch entries remain in Watch-only. Privacy check is in Settings only. The old Private controls menu and automatic mixing are absent.

Auto-refresh's Previous addresses action opens its own page, with Generation and EC Hybrid tabs. The current address and prior paid addresses show their address number, current/previous label and confirmed payment count. Copy works directly from the list; opening a row shows that exact address and its QR, labelled Previous address · still valid when appropriate. History includes addresses whose coins have already been spent and is rebuilt from confirmed receipts during seed restoration. The list loads 20 addresses at a time.

Every sub-wallet offers Recover assets with Fast, Private scan and Own node. Encrypted's home also opens a dedicated Encrypted address recovery page; this separate page is available only in Encrypted. It explicitly covers both Generation and EC Hybrid encrypted receipt addresses, confirmed funds and received messages. It offers Scan for encrypted receipts with progress, Restore with recovery phrase, and an optional encrypted seed-only file under Details. A block starting point is optional and must precede the first receipt across all three sub-wallets. Restoration replaces the local root wallet; it does not create a second independent seed.

No permanent payment URL, address-distribution service, hosted address pool or extra HTTP endpoint is part of this implementation. Auto-refresh is local, after confirmation. Two people paying before confirmation can receive the same displayed address. Previously shared addresses continue to receive funds; a wallet cannot force a payer to forget them. Opening Receive repeatedly does not advance unused indices.

## Separate funds, one seed

All three sub-wallets are deterministically derived from the same Neptune seed. There are no extra phrases to lose. This is similar to multiple accounts beneath one recovery phrase, not three independently compromised security boundaries.

Standard keeps the existing ordinary Generation, EC Hybrid and symmetric change ranges. Encrypted uses reserved base `0x4553434e505631`; Auto-refresh uses disjoint base `0x4653434e524600`. Each optional receiving range is bounded to 2³² children. Key type distinguishes Generation, EC Hybrid and symmetric change. These ranges do not overlap. Symmetric change keys contain secrets and are never displayed as receiving addresses.

Coin selection enforces the selected sub-wallet in Rust. It cannot silently fill a shortfall with another sub-wallet's coins. Change remains in that same sub-wallet's symmetric branch. The shared chain accumulator is synchronized once and maintains proofs for every account; it does not pool spendable balances. A shared local change counter avoids reusing change indices while keeping raw reserved indices out of ordinary key-count expansion. Address-type balances and history use only the selected sub-wallet.

Transfers between sub-wallets are explicit payments and can create public timing or spending relationships. A shared seed, device, node and network connection can also correlate activity. Separate balances do not guarantee independent on-chain identities.

## Creation and recovery

Create only publishes an optional sub-wallet when the user requests it. The seed can already derive its keys mathematically. Background scanning checks compatible branches so seed restoration can rediscover previously funded optional sub-wallets, even without a settings file. Once funds are found, the optional wallet reappears. An unused, empty optional wallet can simply be created again and derives the same addresses.

Use this compatible app, the same seed and network, and scan from genesis or before the first wallet payment. Each sub-wallet remembers its own asset-recovery method. Standard defaults to Fast; Auto-refresh and Encrypted default to Private scan. All three can choose Fast, Private scan or Own node. Indexed sub-wallet recovery scopes address flags and owned-coin proofs to that wallet. Other coins survive the merge only at an identical snapshot; otherwise a local full scan refreshes them. The local block scan and network node connection remain shared; a whole-seed restore uses its explicitly selected root recovery method. Fast and Own node use receiver-ID lookups for ordinary branches plus shared format/version flags for encrypted envelopes, which are decrypted locally. Private scan reads all relevant blocks instead. An unsupported index, potentially capped response (10,000 heights), or incomplete key-discovery round falls back to full scanning. The node can omit indexed results; Fast is not a completeness guarantee. Choosing an owned node still sets that node as the block source. Starting later than the first receipt can omit funds.

The seed and sufficient chain data restore confirmed coins, receiving keys and received encrypted messages that are on-chain. Off-chain-only payment codes must be supplied again on a fresh installation. Existing known receipts survive rescans; premine allocations are rebuilt from genesis, and newly discovered miner rewards need a full scan. It does not restore local contact names, local notes, outgoing recipient-message copies, unfinished sends or preferences. The optional password-encrypted recovery file is a seed-only alternative; it is not required for confirmed funds. It does not back up all local metadata.

Auto-refresh starts at child zero in each address type and advances only after observing a confirmed receipt. Scanning retains the receiving range from child zero through the next address plus a 20-key lookahead, including earlier unused children. This keeps late payments discoverable when a later child was paid first. It does not create arbitrary unused gaps. Encrypted v3 carries the receiving kind and child index inside its authenticated envelope and derives the exact key after opening it, with one outer scanning key.

## Encrypted receipt protocol and limitations

A complete `nescan1…` app address contains the network, scanning public key, receiving index and either a Generation or EC Hybrid receiving address. Compatible senders suppress the standard destination announcement and attach the encrypted wrapper before generating the transaction witness/proofs. Failure never falls back to a standard notice. The receiver checks the existing Neptune notification, ownership, type scripts and matching block addition before crediting a coin. Spending uses ordinary Neptune transaction rules. No node notification-format upgrade is implemented or needed by the proposed wrapper.

Version 3 uses an 8192-byte padded plaintext for both address types, including a message of up to 512 UTF-8 bytes. The larger fixed envelope accommodates Generation's larger upstream encrypted notification. With or without a message, it produces 1180 field elements: 9440 field bytes before transaction framing. Version 1 and 2 reading remains supported at their previous 4096-byte plaintext size. Full Generation app addresses can exceed QR capacity; Copy and text-file download remain available.

Anyone holding two complete Encrypted app addresses can link them through their shared public scanning key. Publishing multiple sub-wallet addresses under one public identity or transferring funds between them can also link them.

The outer sealed box uses X25519 and XSalsa20-Poly1305. Generation's inner lattice notification encryption does **not** make the outer recipient privacy or optional message post-quantum. Padding conceals message length within the fixed limit; the content can still identify its author to the recipient. Integrity checks do not authenticate sender identity. There is no receiver-compromise forward secrecy, formal key-privacy proof or independent audit. Private mode stays disabled on mainnet in both JavaScript and Rust.

A malicious payer can deliberately publish the inner ordinary notification, both forms, or arbitrary identifying data elsewhere. The wallet credits a valid coin and flags detected ordinary notifications to encrypted receiving keys, including duplicate forms. It cannot enforce another party's privacy or detect every possible disclosure. It cannot erase an identifier already published. No automatic self-transfer or mixing claims to repair such a leak.

## Performance choices

Standard and Auto-refresh use Neptune's receiver-ID lookup before decryption. Upstream indexes keys and scans notifications in O(keys + announcements). Auto-refresh adds derivation/cache work as new receiving keys become used. Optional account scans add initial Generation key derivation and cached key work even when their UI is absent; this favors seed recovery completeness in the prototype.

Encrypted envelopes share a format marker but have no fixed external receiver ID. Every matching foreign envelope needs a local decryption trial. A longer message does not change envelope size, but the fixed v3 envelope costs more bandwidth and cryptographic work than v2. See the recorded native debug microbenchmark in the release notes; it is not a browser, full-restore or transaction-proving benchmark.

A block-height/date starting point reduces work only if it includes all earlier payments. An owned Neptune node improves control over network metadata but does not remove local trial decryption. A server can mirror all shared-marker announcements, but trusting a filtered result can miss payments unless completeness is authenticated. Uploading a scanning key would let that server discover receipts and messages. Recipient-specific stable public tags would restore fast lookup while reintroducing linking. Those tradeoffs are not silently enabled.

See [BUG-REVIEW-0.23.1.md](BUG-REVIEW-0.23.1.md) for the recovery fixes and broader bug review.

Production work remains: live-node relay/mining and real proof verification; release WASM installation; independent cryptographic review; reorg/restore stress tests for all accounts; browser/WASM and adversarial-envelope load measurements; durable work scheduling for large scans. No real funds were used during these checks.

### Security fixes (0.23.2)

Encrypted recovery-file export is available only in Encrypted → Encrypted address recovery → Details. Standard and Auto-refresh retain the common Recover assets choices without that export. The optional file backs up the root phrase shared by all three wallets. See [SECURITY-REVIEW-0.23.2.md](SECURITY-REVIEW-0.23.2.md) for lock/export guards, broadcast uncertainty and remaining node-trust limitations.

### Payment recovery (0.23.3)

Available → Refresh assets checks for recent chain updates. It does not rotate the address or reset recovery. Recover assets → Payment codes checks and adds a sender’s code, with a separate counted waiting list. More options contains an optional known-block Private scan; this does not change the wallet’s saved recovery method. Premine search belongs only to Standard. See [BUG-REVIEW-0.23.3.md](BUG-REVIEW-0.23.3.md).
