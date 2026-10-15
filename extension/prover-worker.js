// One proving worker. Reads an encrypted job from IndexedDB, proves it with
// its own prover wasm instance, writes the proof back.

import initProver, { proveJob, lastReport } from './pkg/prover/prover_wasm.js';
import * as db from './lib/db.js';
import { decrypt, importRawKey } from './lib/vault.js';

let ready = null;
let sendId = null;
let key = null;
let lowMemory = 'auto';

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      sendId = msg.sendId;
      lowMemory = msg.lowMemory || 'auto';
      key = await importRawKey(new Uint8Array(msg.key));
      ready = initProver({ module_or_path: new URL('./pkg/prover/prover_wasm_bg.wasm', import.meta.url) });
      return;
    }
    if (msg.type === 'job') {
      const exports = await ready;
      const t0 = performance.now();
      const box = await db.get(db.STORES.jobs, `${sendId}:${msg.index}`);
      if (!box) throw new Error(`job ${msg.index} not found`);
      const job = await decrypt(key, box);
      const proof = proveJob(job, lowMemory);
      const seconds = (performance.now() - t0) / 1000;
      let report = null;
      try {
        report = JSON.parse(lastReport() || 'null');
      } catch {
        report = null;
      }
      // wasm memory only grows, so this is this worker's peak so far.
      const memoryBytes = exports?.memory?.buffer?.byteLength ?? null;
      await db.put(db.STORES.proofs, `${sendId}:${msg.index}`, proof);
      self.postMessage({ type: 'done', index: msg.index, seconds, report: report && { ...report, seconds, memory_bytes: memoryBytes } });
    }
  } catch (e) {
    self.postMessage({ type: 'error', index: msg.index, error: String(e?.message || e) });
  }
};
