// Offscreen page: proves a transaction across Web Workers, then broadcasts it.
//
// Each worker loads its own copy of the prover wasm, so each subproof has its
// own memory (wasm32 caps one instance at 4 GB). Jobs and proofs move through
// IndexedDB; messages carry only indices.
//
// Broadcasting happens here too, not in the service worker: building the
// request (several megabytes of proofs) and uploading it can take longer than
// the ~30 seconds Chrome lets an idle service worker live. A page like this one
// is not stopped. The result is written to IndexedDB (`kv/submit:<id>`) before
// the service worker is told, so nothing is lost if it is asleep.

import initLight, * as light from './pkg/light/light_wasm.js';
import * as db from './lib/db.js';
import * as rpc from './lib/rpc.js';
import { decrypt, importRawKey } from './lib/vault.js';
import { load as loadSettings, workerCount } from './lib/settings.js';

let active = null; // { sendId, queue, done, total, workers, failed, labels, key }
let submitting = null; // sendId being broadcast
let lightReady = null;
const cancelled = new Set(); // send ids the user stopped

function report(type, extra) {
  chrome.runtime.sendMessage({ target: 'background', type, ...extra }).catch(() => {});
  chrome.runtime.sendMessage({ target: 'popup', type, ...extra }).catch(() => {});
}

function stopAll() {
  if (!active) return;
  for (const w of active.workers) w.terminate();
  active = null;
}

async function startProving({ sendId, count, labels, workers: setting, key, lowMemory }) {
  stopAll();
  // Proofs already made (before an interruption) are kept.
  const queue = [];
  for (let i = 0; i < count; i++) {
    if (!(await db.get(db.STORES.proofs, `${sendId}:${i}`))) queue.push(i);
  }
  if (queue.length === 0) {
    report('proved', { sendId });
    return submit(sendId, key);
  }
  const n = Math.min(queue.length, workerCount(setting, navigator.deviceMemory, navigator.hardwareConcurrency));
  active = { sendId, queue, done: count - queue.length, total: count, workers: [], failed: false, labels, key, reports: [], started: Date.now(), lowMemory: lowMemory || 'auto' };

  for (let w = 0; w < n; w++) {
    const worker = new Worker('prover-worker.js', { type: 'module' });
    worker.onmessage = (ev) => onWorkerMessage(worker, ev.data);
    worker.onerror = (ev) => fail(`worker crashed (${ev.message || 'probably out of memory'})`);
    worker.postMessage({ type: 'init', sendId, key, lowMemory: active.lowMemory });
    active.workers.push(worker);
    feed(worker);
  }
  report('proveProgress', { sendId, done: active.done, total: count, label: null, workers: n });
}

function feed(worker) {
  if (!active || active.failed) return;
  const index = active.queue.shift();
  if (index === undefined) return;
  worker.postMessage({ type: 'job', index });
}

function fail(error) {
  if (!active || active.failed) return;
  active.failed = true;
  const sendId = active.sendId;
  stopAll();
  report('proveFailed', { sendId, error });
}

function onWorkerMessage(worker, msg) {
  if (!active) return;
  if (msg.type === 'done') {
    active.done += 1;
    if (msg.report) active.reports.push(msg.report);
    report('proveProgress', {
      sendId: active.sendId,
      done: active.done,
      total: active.total,
      label: active.labels?.[msg.index] ?? `job ${msg.index}`,
      seconds: msg.seconds,
    });
    if (active.done === active.total) {
      const { sendId, key, reports, started, lowMemory, workers } = active;
      // Kept for the "Last proofs" line in Advanced: what proving cost.
      db.put(db.STORES.kv, 'proofReport', {
        sendId, at: Date.now(), totalSeconds: (Date.now() - started) / 1000, lowMemory, workers: workers.length, jobs: reports,
      }).catch(() => {});
      stopAll();
      report('proved', { sendId });
      submit(sendId, key);
    } else {
      feed(worker);
    }
  } else if (msg.type === 'error') {
    fail(msg.error);
  }
}

/** Assemble the proofs into a transaction and send it to the broadcast server. */
async function submit(sendId, rawKey) {
  if (submitting === sendId || cancelled.has(sendId)) return;
  submitting = sendId;
  let result;
  let requestStarted = false;
  try {
    const key = await importRawKey(new Uint8Array(rawKey));
    const rec = await db.get(db.STORES.sends, sendId);
    if (!rec?.prepared) throw new Error('This payment can no longer be sent; start it again');
    const prepared = await decrypt(key, rec.prepared);
    const proofs = [];
    for (let i = 0; i < (rec.jobCount || 0); i++) {
      const p = await db.get(db.STORES.proofs, `${sendId}:${i}`);
      if (!p) throw new Error(`proof ${i} is missing`);
      proofs.push(p);
    }
    lightReady ??= initLight({ module_or_path: new URL('./pkg/light/light_wasm_bg.wasm', import.meta.url) });
    await lightReady;
    const route=await chrome.runtime.sendMessage({target:'background',cmd:'broadcastNode',args:{networkContext:rec.network}});
    if(!route?.ok)throw new Error(route?.error||'The wallet could not choose the broadcast node.');
    const server=route.data;
    if (!server) throw new Error('No broadcast server is set for this network');
    const body = light.submitRequest(rpc.id(), prepared, proofs);
    await rpc.assertRoute(server);
    if (cancelled.has(sendId)) return;
    // Persist uncertainty before upload: the page/browser can disappear after
    // the node accepts the transaction but before its reply is saved.
    await db.put(db.STORES.kv, `submit:${sendId}`, {
      ok: false, uncertain: true, error: 'The broadcast response was not saved.', at: Date.now(),
    });
    if (cancelled.has(sendId)) {
      await db.del(db.STORES.kv, `submit:${sendId}`);
      return;
    }
    requestStarted = true;
    // Large bodies on slow connections: allow up to 10 minutes.
    const text = await rpc.post(server, body, { timeoutMs: 600_000 });
    const ok = light.parseSubmit(text);
    result = ok ? { ok: true, at: Date.now() } : { ok: false, error: 'The node did not accept the transaction', at: Date.now() };
  } catch (e) {
    result = { ok: false, uncertain: requestStarted && e?.nodeRejected !== true, error: String(e?.message || e), at: Date.now() };
  } finally {
    submitting = null;
  }
  await db.put(db.STORES.kv, `submit:${sendId}`, result);
  report('submitted', { sendId });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'ping') {
    sendResponse({ sendId: active?.sendId || submitting || null });
    return false;
  }
  if (msg.type === 'prove') {
    cancelled.delete(msg.sendId);
    startProving(msg);
  }
  if (msg.type === 'submit') submit(msg.sendId, msg.key);
  if (msg.type === 'cancel') {
    if (msg.sendId) cancelled.add(msg.sendId);
    if (!msg.sendId || active?.sendId === msg.sendId) stopAll();
  }
  return false;
});
