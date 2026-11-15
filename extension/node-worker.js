// Succinct node worker: verifies tip blocks with its own wasm instance.
//
// Verifying a block proof (and, once per instance, deriving the program
// digests the claims are built from) is seconds of pure computation. Here it
// blocks neither the service worker nor the page that schedules proving. The
// worker holds no keys and never touches the network: bodies in, verdicts out.

import initNode, { verifyTip, bestTip } from './pkg/node/node_wasm.js';

let ready = null;

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    ready ??= initNode({ module_or_path: new URL('./pkg/node/node_wasm_bg.wasm', import.meta.url) });
    await ready;
    if (msg.type === 'verify') {
      const t0 = performance.now();
      const json = verifyTip(msg.body, msg.network, msg.nowMs, msg.mutatorSet || undefined, msg.mutatorSetHeight ?? undefined, msg.anchor || undefined);
      self.postMessage({ id: msg.id, ok: true, report: JSON.parse(json), seconds: (performance.now() - t0) / 1000 });
      return;
    }
    if (msg.type === 'best') {
      self.postMessage({ id: msg.id, ok: true, index: bestTip(JSON.stringify(msg.reports)) });
      return;
    }
    self.postMessage({ id: msg.id, ok: false, error: `unknown request ${msg.type}` });
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e?.message || e) });
  }
};
