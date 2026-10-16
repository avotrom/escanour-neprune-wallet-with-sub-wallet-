# Refresh, send and recovery review — 0.23.4

The previous refresh review missed indefinite RPC waits and long background runs. This correction tests those failures explicitly and extends the review to the user's reported send/recovery scenarios. It does not establish that every feature or interleaving is bug-free.

## Corrections and evidence

| Finding | Correction | Verification |
| --- | --- | --- |
| Refresh awaited the whole scanner and had no deadline | Acknowledges requestSync before network/lock work; eight-second unanswered-reply deadline | Hung worker, blocked wallet lock, duplicate clicks, timeout/retry, late acknowledgement, malformed reply, rejection, network/navigation/lock cases |
| A cancelled or stale refresh could leave a disabled control | Request ownership, cancellation and bounded cleanup | Executed UI handlers with controlled timers and delayed replies |
| Preview recovery never advanced and Home always returned block 4 | Finite simulated progress, runtime events, copied message snapshots and consistent Home heights | All nine wallet/method combinations; browser reaches block 40 of 40 |
| Send forced waiting for a fresh block | Advanced checkbox, default/migration off; backend uses the saved choice | Forced caller flag ignored, explicit toggle and migration tests; browser checkbox off |
| Building waited for archive/watch/index work | Separate foreground wallet-only tip check; priority aborts background fetches at safe boundaries | Node checking and preparation stages; archive-enabled test only requests chain_height before preparation |
| Old sending card survived switching wallets | Home returns scoped send record, clears old card/click handler; proof events require send ID | Deferred/source handler tests and preview scope fixture |
| Other-wallet payment controls accepted IDs | Check selected network/profile for cancel, dismiss and disclosure approval | Backend foreign-ID rejection |
| A late error replaced Cancelled with Failed | Keep terminal cancellation when tip checking fails | Cancel-during-check test; no build/upload |
| Running recovery prevented choosing Fast | Stop/resume controls and enabled method switching | Running Private → choose Fast, stop/resume, timeout and browser stop → Fast → finished |
| Recovery progress appeared common to all wallets | Separate per-wallet session records and immediate saved method selection; serialized settings writes | Independent methods/progress, foreign cancellation rejection, concurrent setting writes |
| Private rewind converted known receipts into waiting codes, forcing Fast fallback | Keep encrypted base checkpoint; seed indexed recovery from known coins | Private rewind → Fast restores known receipt at the indexed snapshot |
| Other-profile proofs could not merge at a newer indexed snapshot | Advance their retained state through public blocks locally before checked merge | Tail replay preserves the other wallet without uploading its identifiers |
| Interrupted scan errors could overwrite a replacement scan | Error/status handling remains inside the state lock; replacement run scheduled after release | Cancelled scan → new Fast status remains intact |
| Index fallback hid progress behind a static message | Names Private scan and includes current block progress | Source/UI logic and existing unsupported-index tests |

## Server option

Servers → Random node with fallback is optional and requires two distinct Node A/Node B addresses for the selected network. Crypto RNG chooses the first node once per browser session; storage and serialized initialization prevent parallel reads from making different choices. A failed read tries the alternate once and keeps it for later requests. Concurrent failures of the old peer cannot flip a healthy fallback back. Browser session storage preserves the choice through service-worker restarts. Config changes reset the choice; a single configured node keeps the existing behavior.

Fallback applies to known read-only Neptune RPC methods. Transport failures, timeouts, HTTP 5xx and malformed JSON are eligible. Cancellations, Tor routing failures, HTTP 4xx and valid node rejections do not trigger replay. Explicit Test connection always tests its exact URL. Both nodes failing results in an error after two attempts, without an unbounded loop. Changing/removing the fallback while a request is in flight prevents contact with the old peer.

The default broadcaster follows the selected session node. A distinct explicit broadcast URL remains an override. Broadcast uploads still use direct POST and the pre-upload uncertainty marker; a missing acknowledgement does not trigger automatic resubmission. A manual original-transaction retry retains the existing safeguards.

Saving new hosts while Tor is enabled marks routing as connecting before publishing the settings, installs PAC routes for A, B and any broadcaster, and rechecks Tor. This closes a window where a previously connected Tor state could have allowed a new fallback host to use an old PAC script. Own node mode disables public fallback. Privacy checks conservatively account for either configured operator seeing lookup metadata; a fallback pair is not labelled owned merely because its last peer was local.

Tests cover both random choices, concurrent initialization, session reuse, sticky failover, both peers failing, malformed/server/client errors, explicit endpoint tests, upload non-replay, disabled mode, in-flight configuration changes, concurrent old-peer failures, URL validation, Own node isolation, broadcast override and fail-closed Tor routing. Server UI tests also cover both host permissions, failed saves, permission refusal, duplicates/missing URLs and switching network tabs while permission is pending.

## Validation

119 JavaScript tests pass. Syntax checks cover 15 JS files, 478 unique IDs and all literal popup bindings. Settings tests execute the real migration/save code with controlled storage; UI tests execute actual handlers. Browser verification also confirmed an unanswered refresh releases its button and a second click succeeds. The separate local preview has 14 checks, including all nine method/profile combinations, stop/resume, progress completion and send-card scope. The preview is excluded from the release source ZIP.

Browser validation uses fake data. No real transaction was submitted, and no browser proof-speed benchmark was run. Rust coin selection, notification encryption and proof code are unchanged from 0.23.3; the earlier 24 local core tests and native/WASM compile checks remain historical results, not new runs for this patch. CI still excludes light-core Rust unit tests and retains JavaScript checks/builds.

## Practical limits

- One scan engine, shared chain accumulator, one network connection and one outgoing payment at a time remain. Each profile's preference, balance, input/change selection, sending card and recovery view are scoped. Starting another recovery job pauses the previous job; this is not three independently running chain databases.
- Stop acts at asynchronous fetch/batch boundaries; synchronous WASM work must return before the worker can handle a stop message. Recovery-control replies have a 30-second UI deadline and an explicit unconfirmed-action warning rather than automatic replay.
- Progress/history of recovery jobs is session UI metadata. Browser restart or seed-only restore does not recreate those UI records. Confirmed coins remain recoverable by a compatible scan; encrypted wallet checkpoints and the optional shared-root backup are different from progress records.
- Fast needs a working UTXO index. Genuine unresolved off-chain codes, incompatible checkpoints or invalid index responses can still fall back to Private scan. Old rewound states without a retained base may need a full scan to reconstruct missing indices.
- Proving is compute/memory intensive. Preparation duration is recorded and the existing Last proofs report records proof job timings, but actual installed-wallet delays are not diagnosed without measurements on that workload. No speedup is claimed for the cryptographic proving itself.
- Installed extension, fresh release WASM, real network relay/mining, proof acceptance, real Tor/IP routing, full reorg/crash/adversarial-load matrices and independent crypto/security review remain unverified. Node consensus trust, unbounded RPC response sizes, shared-root custody and conservative uncertain-broadcast blocking remain documented in [SECURITY.md](SECURITY.md).
