#!/usr/bin/env bash
# Fetch neptune-core at a pinned commit into vendor/ and apply the wasm patch.
# Upstream Neptune is not modified; the patch lives only in this repo.
set -euo pipefail

# neptune-core `release` branch, crates at 0.19.x (October 2026).
NEPTUNE_REPO="https://github.com/Neptune-Crypto/neptune-core.git"
NEPTUNE_COMMIT="cc3fca93fa4410bc6f7ab8db7c2416dde33d7f04"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/neptune-core"
PATCH="$ROOT/patches/neptune-wasm.patch"

if [ -d "$DEST/.git" ]; then
  echo "vendor/neptune-core exists; resetting it to $NEPTUNE_COMMIT"
  git -C "$DEST" fetch --quiet origin "$NEPTUNE_COMMIT" || git -C "$DEST" fetch --quiet origin
  git -C "$DEST" checkout --quiet --force "$NEPTUNE_COMMIT"
  git -C "$DEST" clean -fdq
else
  mkdir -p "$ROOT/vendor"
  git clone --quiet "$NEPTUNE_REPO" "$DEST"
  git -C "$DEST" checkout --quiet "$NEPTUNE_COMMIT"
fi

echo "applying $(basename "$PATCH")"
git -C "$DEST" apply --whitespace=nowarn "$PATCH"
git -C "$DEST" diff --stat
echo "done: vendor/neptune-core is ready"
