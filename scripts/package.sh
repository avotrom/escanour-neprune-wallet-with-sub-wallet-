#!/usr/bin/env bash
# Cut the two builds from extension/ (run scripts/build.sh first).
#
#   dist/escanour-light/  no node. The wallet as before: it needs no node and
#                         trusts its sync server for chain validity. Smaller,
#                         no node module, no background permission.
#   dist/escanour-node/   the same wallet plus the succinct node: it verifies
#                         the chain's recursive proof itself. Node mode is a
#                         switch in Settings > Servers and can stay off.
#
# Both are complete unpacked extensions; load either one in
# chrome://extensions. They share an extension name, so install one at a time
# (or load them in separate Chrome profiles).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f extension/pkg/light/light_wasm_bg.wasm ] || { echo "run scripts/build.sh first"; exit 1; }
[ -f extension/pkg/node/node_wasm_bg.wasm ] || { echo "extension/pkg/node is missing: run scripts/build.sh"; exit 1; }

rm -rf dist
mkdir -p dist
cp -R extension dist/escanour-node
cp -R extension dist/escanour-light

# ---- light: remove everything that belongs to the node ----
L=dist/escanour-light
rm -rf "$L/pkg/node" "$L/node-worker.js" "$L/node-runner.js"
node - "$L" <<'JS'
const fs = require('fs');
const dir = process.argv[2];
const flavor = `${dir}/lib/flavor.js`;
const src = fs.readFileSync(flavor, 'utf8');
if (!src.includes("FLAVOR = 'node'")) throw new Error('lib/flavor.js: FLAVOR line not found');
fs.writeFileSync(flavor, src.replace("FLAVOR = 'node'", "FLAVOR = 'light'"));
const mf = `${dir}/manifest.json`;
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.version_name = `${m.version} light (no node)`;
delete m.optional_permissions; // "background" is only for the node
fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
JS

# ---- node: label it ----
node - dist/escanour-node <<'JS'
const fs = require('fs');
const mf = `${process.argv[2]}/manifest.json`;
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.version_name = `${m.version} succinct node`;
fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
JS

# The light build must not carry the node, and must still be loadable.
if grep -rl "node_wasm" "$L" >/dev/null 2>&1 && [ -e "$L/pkg/node" ]; then echo "light build still contains the node module"; exit 1; fi
grep -q "FLAVOR = 'light'" "$L/lib/flavor.js"
grep -q "FLAVOR = 'node'" dist/escanour-node/lib/flavor.js

( cd dist && for d in escanour-light escanour-node; do
    if command -v zip >/dev/null; then (cd "$d" && zip -qr "../$d.zip" .); fi
  done )
echo "builds:"
du -sh dist/escanour-light dist/escanour-node
ls -lh dist/*.zip 2>/dev/null || true
