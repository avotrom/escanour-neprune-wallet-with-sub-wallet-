// Succinct node loop. Lives in the offscreen document.
//
// Why here: Chrome stops an extension service worker after about 30 idle
// seconds and caps a single event at five minutes, so nothing that must
// follow a chain can live there. An offscreen document is an ordinary page
// that Chrome does not stop: its timers keep firing, its workers keep their
// wasm instances (and the program digests they derived), and it needs no keys
// for this job, so the node keeps following the chain while the wallet is
// locked. The service worker is only woken, by a message, when there is a new
// verdict to compare with the wallet.
//
// One round: ask every configured node for its height (tiny). Only when a
// height moved, download that node's tip block with its proof and verify it
// in node-worker.js. The verdicts are written to IndexedDB (`kv/succinct:
// <network>`) before the service worker is told, so nothing is lost if it is
// asleep.

import * as db from './lib/db.js';
import * as rpc from './lib/rpc.js';
import { load as loadSettings } from './lib/settings.js';
import * as succinct from './lib/succinct.js';

const POLL_MS = 30_000;
const TIP_TIMEOUT_MS = 90_000;
const TIP_MAX_BYTES = 64 * 1024 * 1024;
const VERIFY_TIMEOUT_MS = 5 * 60_000;

let timer = null;
let worker = null;
let nextId = 1;
const waiting = new Map(); // id -> { resolve, reject, timer }
const seen = new Map(); // `${network}|${url}` -> last height verified
let round = null; // the round in flight, so callers share it

function dropWorker(reason) {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) {
    clearTimeout(w.timer);
    w.reject(new Error(reason));
  }
  waiting.clear();
}

function ask(message) {
  if (!worker) {
    worker = new Worker('node-worker.js', { type: 'module' });
    worker.onmessage = (ev) => {
      const w = waiting.get(ev.data?.id);
      if (!w) return;
      waiting.delete(ev.data.id);
      clearTimeout(w.timer);
      if (ev.data.ok) w.resolve(ev.data);
      else w.reject(new Error(ev.data.error));
    };
    worker.onerror = (ev) => dropWorker(`the node module stopped (${ev.message || 'out of memory?'})`);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // A verification that never returns must not hold every later round.
    const t = setTimeout(() => dropWorker('verifying the tip took too long'), VERIFY_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer: t });
    worker.postMessage({ ...message, id });
  });
}

const body = (method) => JSON.stringify({ jsonrpc: '2.0', id: rpc.id(), method, params: [] });

async function heightOf(url) {
  const text = await rpc.post(url, body('chain_height'), { timeoutMs: 20_000, maxBytes: 65_536 });
  const h = Number(JSON.parse(text)?.result?.height);
  if (!Number.isSafeInteger(h) || h < 0) throw new Error('the node did not give a height');
  return h;
}

async function runRound({ force = false } = {}) {
  const s = await loadSettings();
  if (!succinct.enabled(s)) {
    stop();
    return null;
  }
  const network = s.network;
  const key = `succinct:${network}`;
  const urls = succinct.targets(s, network);
  const previous = await db.get(db.STORES.kv, key);
  if (!urls.length) {
    const record = { network, at: Date.now(), results: [], best: null, error: 'NEED_SERVER' };
    await db.put(db.STORES.kv, key, record);
    announce(network);
    return record;
  }

  const heights = await Promise.all(urls.map((u) => heightOf(u).then((h) => ({ h }), (e) => ({ error: String(e?.message || e) }))));
  const moved = urls.some((u, i) => heights[i].h !== undefined && seen.get(`${network}|${u}`) !== heights[i].h);
  const sameNodes = previous && JSON.stringify((previous.results || []).map((r) => r.url)) === JSON.stringify(urls);
  if (!force && !moved && sameNodes && !previous.error) {
    // Nothing new on any chain: the stored verdicts still stand.
    await db.put(db.STORES.kv, key, { ...previous, checkedAt: Date.now() });
    return previous;
  }

  const anchor = succinct.anchorFor(network, await db.get(db.STORES.kv, `succinctAnchor:${network}`));
  const msa = await db.get(db.STORES.kv, `succinctMsa:${network}`);
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (heights[i].error) {
      results.push({ url, ok: false, error: heights[i].error });
      continue;
    }
    try {
      const text = await rpc.post(url, body('chain_tip'), { timeoutMs: TIP_TIMEOUT_MS, maxBytes: TIP_MAX_BYTES });
      const out = await ask({
        type: 'verify', body: text, network, nowMs: Date.now(), anchor: anchor.hash,
        mutatorSet: msa?.bytes || null, mutatorSetHeight: msa?.height ?? null,
      });
      results.push({ url, ok: true, report: out.report, seconds: out.seconds });
      seen.set(`${network}|${url}`, out.report.height);
    } catch (e) {
      results.push({ url, ok: false, error: String(e?.message || e).slice(0, 300) });
    }
  }

  const okReports = results.filter((r) => r.ok).map((r) => r.report);
  let bestIndex = -1;
  if (okReports.length) {
    try {
      bestIndex = (await ask({ type: 'best', reports: okReports })).index;
    } catch {
      bestIndex = -1;
    }
  }
  const { best, pin, conflict } = succinct.decide(results, bestIndex, anchor);
  let held = anchor;
  if (pin) {
    held = { ...pin, at: Date.now() };
    await db.put(db.STORES.kv, `succinctAnchor:${network}`, held);
  }
  // The network may have been switched while this round ran: the record is
  // keyed by the network it was made for, so it never lands on another one.
  const record = { network, at: Date.now(), checkedAt: Date.now(), results, best, conflict, anchor: held };
  await db.put(db.STORES.kv, key, record);
  announce(network);
  return record;
}

function announce(network) {
  chrome.runtime.sendMessage({ target: 'background', type: 'succinctTip', network }).catch(() => {});
}

/** One round at a time; a forced request during a round runs another after it. */
export function tick(options = {}) {
  if (round) return options.force ? round.then(() => tick(options), () => tick(options)) : round;
  round = runRound(options)
    .catch((e) => ({ error: String(e?.message || e) }))
    .finally(() => {
      round = null;
    });
  return round;
}

export function start() {
  if (timer) return;
  timer = setInterval(() => tick().catch(() => {}), POLL_MS);
  tick().catch(() => {});
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  dropWorker('node mode was turned off');
  seen.clear();
}

export const running = () => Boolean(timer);
