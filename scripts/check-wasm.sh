#!/usr/bin/env bash
# Step 0: does the Neptune stack compile for the browser? Prints only errors.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# getrandom 0.3+ needs an explicit browser backend on wasm32 (Triton VM draws
# randomness for zero-knowledge). Set here instead of a hidden .cargo folder.
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='--cfg getrandom_backend="wasm_js"'
[ -d vendor/neptune-core ] || scripts/vendor-neptune.sh
rustup target list --installed | grep -q wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown

echo "== native check (light-core, CLI)"
cargo check -p light-core -p light-cli

echo "== wasm32 check (light-wasm, prover-wasm)"
cargo check -p light-wasm -p prover-wasm --target wasm32-unknown-unknown

echo "== getrandom versions in the wasm graph (each needs its browser backend)"
cargo tree -p light-wasm --target wasm32-unknown-unknown -i getrandom -e normal 2>/dev/null | grep -E '^getrandom' || true
echo "OK"
