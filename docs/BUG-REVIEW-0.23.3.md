# Wallet logic, features and security review — 0.23.3

This targeted source and regression review checks the three-sub-wallet prototype, payment codes, archive recovery, manual scans and Available refresh. It does not certify that every feature is bug-free or that the wallet is ready for real funds. No real seed or funds were used. The original supplied ZIP and Neptune dependency pin are unchanged.

## Fixes and evidence

| Problem | Resulting behavior | Evidence |
| --- | --- | --- |
| Editing a checked payment code left the old code ready to register | Edits clear the old review; registration uses the exact reviewed code and its wallet/network | UI tests execute actual handlers with deferred responses and edits |
| Late payment-code/list replies could refill hidden or locked pages | Page/epoch/profile/network guards reject stale replies; leaving/locking clears code text and review | Executed UI tests and browser navigation |
| A registration queued behind sync could apply after selection changed | Backend captures and rechecks wallet identity, profile and network under the state lock | Queued-registration, stale-context and cancellation tests |
| Waiting/archive results included other-wallet metadata | Waiting lists and adopted history are scoped to the selected profile | Backend scope tests; native six-branch archive adoption |
| Archive adoption treated reserved Generation indices as ordinary counters | Shares sync’s bounded, profile-aware counter updates; preserves the owning profile on all adoption results | Native tests assert ordinary counters stay at 1 with all six receiving branches present |
| Archive history omitted sub-wallet labels and marked change as incoming funds | Events include wallet_mode and is_change; change is not presented as a new receipt | Source path checked; native adoption labels verified |
| Removal could discard an off-chain recovery code with one tap | Inline Cancel/Remove confirmation explains that re-adding requires the original code; cancelled or stale confirmation does not remove | UI confirmation guard tests; backend selected-profile removal |
| Manual scanning silently replaced a saved Fast/Own node preference | Explicit Private scan uses rememberMode:false and preserves saved choices | Backend/UI tests and browser Fast radio remaining selected during a manual Private scan |
| Fractional block input was silently rounded down | Requires a safe whole block number, starts before that payment block | UI/backend bounds checks; browser error for 10.5 and progress from 9 for input 10 |
| Premine controls appeared under optional sub-wallets | Premine is visible and callable only under Standard | Backend rejection and conditional UI |
| A slow Home reply could replace the selected wallet with old balances | Home requests are versioned and bound to profile, network and UI epoch | Deferred-response test: Refresh balance remains after an older Standard reply |
| No balance-refresh control beside Available | Accessible refresh button checks chain updates without rotating addresses or resetting state | UI test asserts only sync is requested; browser shows Assets updated |
| Duplicate refresh clicks and errors could give confusing results | Busy guard prevents concurrent clicks; failed/stale refresh cannot claim success | UI regression tests |
| Backend notification arithmetic truncated at 12 decimals | Totals retain up to 34 decimal places, matching the UI’s exact arithmetic | Sub-pico NPT regression case |
| Payment-code size/case validation was weak | 64 KiB import bound before key derivation/parsing; mixed case rejected, valid uppercase retained | Core parser tests, foreign-wallet/network tests and UI maxlength |
| Privacy check wording implied a broad guarantee | Labels describe checked settings and alerts | English/French/Arabic text reviewed |

## Rules and feature checks

- Standard exists by default; optional wallets are created on request. Separate coin selection, balances, activity and same-wallet change remain covered by native and backend tests.
- Generation and EC Hybrid work in all three wallets. Auto-refresh advances only after a confirmed receipt, and earlier receiving addresses remain usable and visible in history.
- Per-wallet Fast / Private scan / Own node preferences remain independent. Indexed sub-wallet recovery excludes other profiles’ lookup identifiers/proofs. The chain scan and network connection remain shared.
- Valid manual codes can be decoded, registered once, listed as waiting, adopted from a matching archive and recognized as already owned. Their amounts do not become spendable merely because a code was added. Wrong wallet/network, malformed code and duplicate registration paths are checked.
- A six-branch mock chain covers archive adoption of Standard, Auto-refresh and Encrypted Generation/EC Hybrid receipts, matching commitments/membership proofs, preserved wallet labels and bounded counters.
- Removing a waiting code removes local tracking; it does not cancel the sender’s transaction. Keep the original code if restoration may need it.
- Encrypted-only recovery/file controls remain absent from Standard and Auto-refresh. The optional encrypted file still backs up the root phrase shared by all three wallets.
- Existing guards remain: no automatic mutation replay, exact original-transaction rebroadcast for unknown outcomes, no spending across profiles, mainnet exclusion for Encrypted, Tor fail-closed checks and blocked redirects.

## Validation and practical limits

24 local core tests passed, 0 failed, 1 optional benchmark ignored. 78 JavaScript checks passed. Native light-cli and wasm32 light-wasm/prover-wasm compile checks passed. Syntax covers 15 JS files and 472 unique popup IDs; all 321 static keys and new dynamic labels exist in English, French and Arabic; 26 screen declarations match. The unchanged CI workflows skip light-core Rust unit tests and retain JavaScript tests, compilation and builds.

Browser verification uses a UI-only mock, including DEMO-GENERATION / DEMO-EC-HYBRID strings. Actual code validation/adoption was tested natively with generated test notifications; the mock does not validate real codes or move funds. No fresh release WASM build or installed-extension/live-node acceptance was completed. Screenshots show mock data.

## Security concerns still open

1. **Node trust:** hash/accumulator consistency is checked, but block proof, PoW and canonical-chain authentication are not independently verified. A malicious node can serve an internally consistent false view. A trusted validating node remains necessary.
2. **Unknown broadcast availability:** an uncertain transaction preserves its original data and blocks new sends/rescans. If its outcome cannot be established, this may require manual investigation; timeout alone does not prove failure.
3. **Resource bounds:** payment-code imports are bounded, but RPC responses still have no streaming byte ceiling. Large/adversarial blocks and encrypted-envelope loads need stress tests.
4. **Encrypted protocol:** outer recipient/message privacy is unaudited classical encryption, including with Generation addresses. Messages/address sharing can identify participants; a malicious sender can disclose identifiers. Encrypted is testnet-only.
5. **Shared root and restore limits:** one seed/password controls all wallets. Seed replay restores confirmed compatible receipts, not every local label, unfinished send or unsaved off-chain code. The optional file is not isolated to Encrypted funds.
6. **Untested production boundaries:** installed extension, real Tor/IP routing, live relay/mining, real proofs, deep reorgs, crashes across every persistence boundary and browser performance remain unverified. An independent security review is still needed.

Earlier transport/send findings and details: [SECURITY-REVIEW-0.23.2.md](SECURITY-REVIEW-0.23.2.md). No GitHub upload or deployment was performed.
