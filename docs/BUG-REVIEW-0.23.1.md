# Recovery and sub-wallet bug review

Reviewed and fixed locally on 16 October 2026. This is a targeted review of recovery, account separation, payment codes, exports and their UI paths; it is not an independent security audit of the wallet or Neptune.

| Bug | Fix | Verification |
| --- | --- | --- |
| Fast and Own node were silently replaced with Private scan | Preserve the selected mode on every network; add three choices in Recover assets | JS mode matrix for all three sub-wallets and networks |
| Indexed recovery missed Auto-refresh receiving/change branches and custom encrypted envelopes | Scan both receiving kinds in each branch; query shared v1/v2/v3 envelope flags; decrypt locally; iterate key discovery | Core mock-node flag responses, valid proof responses, full/indexed balance comparisons before and after spending |
| A restored wallet at the chain tip could skip a pending indexed recovery | Pending recovery bypasses idle early-return and runs at an existing tip | Backend regression test with a seeded snapshot |
| Explicit birthday zero was treated as a new-wallet creation | Recognize zero as an explicit restore start | JS seed-restore tests for all three modes |
| Indexed recovery failure or a full rescan could forget previously known unannounced receipts | Seed known coins into indexed discovery; carry known receipts into a full rescan; retain old snapshots until indexed recovery succeeds or its fallback snapshot exists | JS preservation/fallback tests and core seeded proof/balance checks |
| Payment-code recovery did not derive Auto-refresh keys | Include account scan branches; constrain decode/register/remove and waiting lists to the selected sub-wallet | Core decode assertions for both address types in all three sub-wallets; JS ownership checks |
| Viewing-key export always used Standard index zero | Export the current Standard or Auto-refresh receiving keys; reject unsupported Encrypted envelope viewing export explicitly | JS export scoping tests; WASM compilation |
| Generic recovery reused encrypted-only scanning text and pages | Asset recovery is common; encrypted receipt recovery is only reachable from Encrypted; generic progress uses block counts | Browser route, radio and progress checks |
| Indexed discovery could stop at its round limit and present an incomplete result as complete | Fall back to full scanning when key discovery does not converge | Explicit bounded discovery path; broader load testing remains open |
| The pinned node caps a flag's lookup list at 10,000 blocks, including shared encrypted-format flags | Treat responses of 10,000 or more heights as potentially capped and fall back to a full scan | New core regression test rejects a capped response |
| Changing the recovery node could leave Tor's host list pointing at the previous node | Configure the new node and mandatory proxy rules before recovery requests | JS Tor host-rule regression test |
| Recovery could reset state while another sub-wallet had an outgoing payment or reserved coins | Reject a rescan until that payment confirms, expires or is cancelled; recheck the current wallet under the state lock | JS tests retain the old snapshot and reservations |
| A scan starting later than a known receipt could make an existing asset disappear | Move the starting point back before the earliest known receipt; pending codes start at genesis; reject fractional/unsafe block heights | JS start-height and preservation checks |
| Concurrent Send requests could both pass the active-payment check | Serialize payment creation and recheck network/profile under the state lock; reject sends while recovery/sync is behind | JS concurrent Send and recovery-state tests |

The mocked spending blocks also used unpacked transaction inputs where real blocks require packed removal lists. This could pass or fail depending on random index values. The fixtures now pack those lists after updating the accumulator and assert round-trip equivalence before replay.

Fast recovery rechecks returned membership information against the returned snapshot block. The server can still omit payments or serve a fork; a flag index is not a completeness proof. Fast mode queries ordinary receiver IDs (including encrypted receiving keys to discover unprotected notices) and owned coin index sets. The shared encrypted format flags do not reveal the scanning secret, but membership-proof requests identify coins after local discovery. Own node uses the chosen node; it does not make an untrusted remote service private. Private scan reads all relevant blocks and decrypts locally.

The mock-node proof test initially reused stale AOCL paths for spent coins. The fixture now advances those paths as a node response would; the production verifier correctly rejected the stale paths. The complete core suite then passed.

Unannounced rewards or external off-chain payment codes cannot generally be recreated from a seed and an announcement index alone. Existing known coins are retained; pending codes trigger a full scan. On a fresh restoration, off-chain codes must be supplied again when their encrypted notification never reached the chain. Premine coins are rebuilt from genesis; newly discovered miner rewards require full scanning. The optional encrypted backup remains seed-only.

Still unverified: release WASM build and installed-extension behavior; live unchanged-node admission/relay/mining and real proof acceptance; deep reorgs and adversarial load across all profiles; browser performance and worker lifetime under large indexed restores; independent review of the encrypted protocol. Encrypted is disabled on mainnet. No real funds or user recovery words were used in validation.
