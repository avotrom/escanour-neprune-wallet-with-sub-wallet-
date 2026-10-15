#!/usr/bin/env bash
# Build both wasm modules into extension/pkg/ and print their sizes.
#   scripts/build.sh            release build
#   scripts/build.sh --dev      faster build, slower proving
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# getrandom 0.3+ needs an explicit browser backend on wasm32 (Triton VM draws
# randomness for zero-knowledge). Set here instead of a hidden .cargo folder.
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='--cfg getrandom_backend="wasm_js"'

PROFILE="--release"
[ "${1:-}" = "--dev" ] && PROFILE="--dev"

command -v wasm-pack >/dev/null || { echo "install wasm-pack: cargo install wasm-pack"; exit 1; }
rustup target list --installed | grep -q wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown
[ -d vendor/neptune-core ] || scripts/vendor-neptune.sh

# --target web: ES modules that load in a module service worker, an offscreen
# document and module Web Workers alike.
wasm-pack build crates/light-wasm  $PROFILE --target web --out-dir ../../extension/pkg/light  --out-name light_wasm  --no-typescript
wasm-pack build crates/prover-wasm $PROFILE --target web --out-dir ../../extension/pkg/prover --out-name prover_wasm --no-typescript

rm -f extension/pkg/*/.gitignore extension/pkg/*/package.json extension/pkg/*/README.md

# Ship the open-source licenses of the code compiled into the wasm modules.
mkdir -p extension/THIRD_PARTY
cp LICENSE NOTICE extension/THIRD_PARTY/
for f in vendor/neptune-core/LICENSE*; do
  [ -e "$f" ] && cp "$f" "extension/THIRD_PARTY/neptune-core-$(basename "$f")"
done
echo
echo "wasm sizes:"
ls -lh extension/pkg/light/*.wasm extension/pkg/prover/*.wasm
echo
echo "Load it: chrome://extensions -> Developer mode -> Load unpacked -> $ROOT/extension"
