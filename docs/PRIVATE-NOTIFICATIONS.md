# Encrypted notification implementation

Current account behavior, usage, privacy, performance and recovery are described in [SUB-WALLETS.md](SUB-WALLETS.md). This source implements three separate sub-wallets. Only Standard is created by default; Auto-refresh and Encrypted are created on request. Both address types exist in every sub-wallet. The earlier shared-balance controls and server payment-link idea are not the current design.

## Wire version 3

The `nescan` Bech32m payload is: version byte 3, network ID (u32 little endian), 32-byte scanning public key, receiving child index (u64 little endian), then the ordinary Generation or EC Hybrid receiving address as UTF-8. Only public receiving types are accepted. Input is capped at 8192 characters and rejects unsupported networks, checksums, low-order scanning keys and unsupported inner address types. Readers accept v1 (implicit EC Hybrid child zero) and v2 (explicit EC Hybrid child index).

The shared announcement marker remains `0x4553434e505631`. It is followed by wire version 3 and ciphertext packed in canonical seven-byte field elements. All v3 plaintexts are 8192 bytes, sealed ciphertexts are 8240 bytes, and announcements have 1180 field elements. Noncanonical field words, trailing bytes, invalid padding, wrong contexts and failed authentication are rejected.

Plaintext header: `ESCNPV03` (8 bytes), network ID (4), notification byte length (2), message byte length (2), child index (8), receiving type (1: 0 Generation, 1 EC Hybrid). Notification UTF-8 and optional message UTF-8 follow at byte 25, then zero padding. The message limit is 512 UTF-8 bytes; the combined notification and message must fit 8167 bytes. Legacy v1/v2 use 4096-byte plaintexts and their original headers.

Scanning secret derivation remains SHA-256 with domain `escanour/private-notification/scanning-key/v1\0`, the network ID and canonical wallet entropy encoding. The envelope is a crypto_box sealed box using fresh ephemeral randomness. Receiver spending and scanning material stays local. Incoming notification decoding uses the encrypted kind/index to derive a single expected payment key, then applies existing Neptune notification ownership checks.

The send path creates an off-chain-notified Neptune payment output and inserts the wrapper before primitive witness construction. The receive path opens announcements locally and matches the owned UTXO addition in the block before crediting it. This light wallet manages its own wallet state rather than calling a local node's `claim_utxo` RPC.

Messages are untrusted plain text in the UI. They and sensitive send fields are vault-encrypted at rest, excluded from desktop notification content, and cleared on locking. No sender identity authentication is claimed. Standard notices to encrypted receiving keys are flagged and valid funds are retained, including when both forms describe the same coin.

## Local use

Build fresh WASM modules using the included build workflow. Configure a test-network node in Settings → Servers. Open the sub-wallet icon beside Tor, select Encrypted and choose Create sub-wallet. Its home shows Generation and EC Hybrid cards; Receive selects either encrypted app address. Share only the complete app address with a compatible wallet. The optional message appears in encrypted Send. Ordinary wallets do not understand these app addresses. Mainnet is blocked.

The outer envelope is elliptic-curve based for both address types. The protocol has not had an independent anonymity or cryptographic audit. Live node acceptance and production proving were not validated. See [RELEASE-0.23.4.md](../RELEASE-0.23.4.md) for exactly which checks were completed.
