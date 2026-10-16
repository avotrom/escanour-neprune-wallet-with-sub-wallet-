import { activeMode, activityForMode, addressKind } from './lib/wallet-modes.js';
import { requirePrivateNotifications, notificationRestoreMode, validatePrivateSend, rotateReceivingAddress } from './lib/private-notifications.js';
import { encryptRecoveryFile } from './lib/recovery-file.js';
// Service worker: wallet state, sync, and the send pipeline.
//
// Design rules
// - Networking and storage happen here in JS; all Neptune logic runs in the
//   light wasm module. Proving AND broadcasting run in the offscreen document:
//   Chrome stops an idle service worker after about 30 seconds, which is
//   shorter than building and uploading a large transaction.
// - Every piece of state lives in IndexedDB, so this worker can be stopped at
//   any time and resume on the next event or alarm (resumeSends).
// - Wallet data is kept per network (snapshots, history, sends, status), so
//   one seed can be used on Mainnet and Testnet side by side.
// - The wallet syncs only while unlocked: scanning needs the keys.

import initLight, * as light from './pkg/light/light_wasm.js';
import * as db from './lib/db.js';
import * as vault from './lib/vault.js';
import * as rpc from './lib/rpc.js';
import * as settingsStore from './lib/settings.js';
import { t, setLanguage } from './lib/i18n.js';
import { activeWatchIds, contactAddresses, decorateWatch, singleFlight } from './lib/watch-model.js';

const SNAPSHOTS_KEPT = 30;
const MAX_BLOCKS_PER_RUN = 2000; // one chunk; the next follows right away (scheduleFollowUp)
const PREFETCH = 3; // most block batches downloaded in parallel during a scan
const SAVE_EVERY = 1000; // blocks between snapshot saves during a long scan
const SAVE_EVERY_MS = 15_000; // ...or this much time, so a restart loses little
// Chrome may stop an extension worker whose fetch waits about 30 s, so a
// block request gives up first and is retried smaller.
const BLOCKS_TIMEOUT_MS = 25_000;
const SLOW_MS = 12_000; // a response this slow means: ask for less at once
const MAX_FETCH_FAILURES = 8; // in a row, before the run stops with an error
const FRESH_BLOCK_WINDOW_MS = 60_000;
const MAX_BLOCK_WAIT_MS = 20 * 60_000;
const MAX_SEND_ATTEMPTS = 3;
const STALE_RESERVATION_BLOCKS = 30;
const BLOCK_TIME_MS = 588_000; // Neptune's target block interval
const STALLED_MS = 3 * 60_000; // a step with no progress for this long was interrupted

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- wasm ----

let wasmReady = null;
function wasm() {
  wasmReady ??= initLight({ module_or_path: chrome.runtime.getURL('pkg/light/light_wasm_bg.wasm') });
  return wasmReady;
}

let walletCache = null; // { id, wallet }

async function openWallet() {
  const key = await vault.sessionKey();
  if (!key) return null;
  const s = await settingsStore.load();
  const raw = await vault.exportRawKey(key);
  const id = `${s.network}|${Array.from(raw.slice(0, 8)).join(',')}`;
  if (walletCache?.id === id) return { key, wallet: walletCache.wallet, s };
  await wasm();
  const phrase = await vault.phrase(key);
  walletCache?.wallet.free?.();
  walletCache = { id, wallet: new light.LightWallet(phrase, s.network) };
  return { key, wallet: walletCache.wallet, s };
}

function dropWallet() {
  walletCache?.wallet.free?.();
  walletCache = null;
  snapCache = null;
}

// ----------------------------------------------------- lifetime & locking --

// An extension service worker stays alive while it calls extension APIs.
// Long tasks (sync, building a transaction) ping one every 20 seconds.
let keepers = 0;
let keepTimer = null;
async function keepAlive(fn) {
  keepers += 1;
  keepTimer ??= setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  try {
    return await fn();
  } finally {
    keepers -= 1;
    if (keepers === 0) {
      clearInterval(keepTimer);
      keepTimer = null;
    }
  }
}

let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// A user action that needs the lock: background work (sync, archive,
// watch-only catch-up, spend index) checks `wanted` between batches and
// steps aside, so a tap never waits for a long run.
let wanted = 0;
function exclusiveNow(fn) {
  wanted += 1;
  rpc.interrupt();
  let counted = true;
  const release = () => {
    if (counted) {
      counted = false;
      wanted -= 1;
    }
  };
  return exclusive(async () => {
    release();
    return fn();
  }).finally(release);
}
const yieldNow = () => wanted > 0;

// Jobs the popup can cancel while they wait, and their progress.
const cancelledJobs = new Set();
function cancelled(jobId) {
  if (jobId && cancelledJobs.has(jobId)) {
    cancelledJobs.delete(jobId);
    throw new Error('CANCELLED');
  }
}
function jobProgress(jobId, patch) {
  if (jobId) chrome.runtime.sendMessage({ target: 'popup', type: 'job', jobId, ...patch }).catch(() => {});
}

// ------------------------------------------------------------ migration ----

// Versions before 0.3 stored one network's data without a network prefix.
let migrated = null;
function migrateStorage() {
  migrated ??= (async () => {
    const s = await settingsStore.load();
    await settingsStore.save({}); // rewrites old server fields into `servers`
    for (const k of await db.keys(db.STORES.snapshots)) {
      if (typeof k === 'number' || /^\d+$/.test(String(k))) {
        const box = await db.get(db.STORES.snapshots, k);
        await db.put(db.STORES.snapshots, snapKey(s.network, Number(k)), box);
        await db.del(db.STORES.snapshots, k);
      }
    }
    const oldActivity = await db.get(db.STORES.kv, 'activity');
    if (oldActivity) {
      await db.put(db.STORES.kv, `activity:${s.network}`, oldActivity);
      await db.del(db.STORES.kv, 'activity');
    }
    for (const id of await db.keys(db.STORES.sends)) {
      const rec = await db.get(db.STORES.sends, id);
      if (rec && !rec.network) {
        rec.network = s.network;
        await db.put(db.STORES.sends, id, rec);
      }
    }
  })().catch((e) => {
    migrated = null;
    throw e;
  });
  return migrated;
}

// --------------------------------------------------------------- status ----

async function currentNetwork() {
  return (await settingsStore.load()).network;
}

async function status(network) {
  const n = network || (await currentNetwork());
  const r = await chrome.storage.session.get(`status:${n}`);
  return r[`status:${n}`] || {};
}

let statusWrites = Promise.resolve();
function setStatus(patch, network) {
  const write = async () => {
    const n = network || (await currentNetwork());
    const next = { ...(await status(n)), ...patch };
    await chrome.storage.session.set({ [`status:${n}`]: next });
    notify('status', { network: n, status: next });
    return next;
  };
  const result = statusWrites.then(write, write);
  statusWrites = result.catch(() => {});
  return result;
}

function notify(type, extra = {}) {
  chrome.runtime.sendMessage({ target: 'popup', type, ...extra }).catch(() => {});
}

// -------------------------------------------------------- notifications ----

const SCALE = 34n;
function toUnits(a) {
  const str = String(a ?? '0').trim();
  const neg = str.startsWith('-');
  const [i, f = ''] = str.replace(/^-/, '').split('.');
  const v = BigInt(i || '0') * 10n ** SCALE + BigInt((f + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE)) || '0');
  return neg ? -v : v;
}
function fromUnits(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const f = (a % 10n ** SCALE).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 10n ** SCALE}${f ? `.${f}` : ''}`;
}
const amt = (a) => fromUnits(toUnits(a));
const plus = (a, b) => fromUnits(toUnits(a) + toUnits(b));

/** Show a Chrome notification when the user has them on. Text only: no address. */
async function pushNotice(kind, vars = {}) {
  try {
    const s = await settingsStore.load();
    if (s.notifications === false || !chrome.notifications) return;
    setLanguage(s.language);
    const net = s.network === 'main' ? '' : ` (${s.network === 'testnet' ? t('net.testnet') : t('net.mock')})`;
    await chrome.notifications.create(`esc-${kind}-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `${t(`nt.${kind}Title`, vars)}${net}`,
      message: t(`nt.${kind}`, vars),
      priority: 1,
    });
  } catch {
    /* notifications are a convenience */
  }
}

chrome.notifications?.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  // The wallet's place is the side panel; a full tab if Chrome refuses.
  try {
    const win = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab') });
  }
});

// ------------------------------------------------------------ snapshots ----

const snapKey = (network, height) => `${network}:${String(height).padStart(12, '0')}`;

async function snapHeights(network) {
  const prefix = `${network}:`;
  return (await db.keys(db.STORES.snapshots))
    .map(String)
    .filter((k) => k.startsWith(prefix))
    .map((k) => Number(k.slice(prefix.length)))
    .sort((a, b) => b - a);
}

// The newest decrypted state stays in memory while the wallet is unlocked, so
// opening the popup does not decrypt the whole wallet again for every number.
let snapCache = null; // { key, network, height, state }

async function latestSnapshot(key, network) {
  const n = network || (await currentNetwork());
  const heights = await snapHeights(n);
  if (!heights.length) return null;
  if (snapCache && snapCache.key === key && snapCache.network === n && snapCache.height === heights[0]) {
    return { height: snapCache.height, state: snapCache.state };
  }
  const box = await db.get(db.STORES.snapshots, snapKey(n, heights[0]));
  let state = await vault.decrypt(key, box);
  const meta = await readWatchData(key, n);
  if (meta && walletCache?.wallet) state = walletCache.wallet.watchReconcile(state, JSON.stringify(meta.records));
  snapCache = { key, network: n, height: heights[0], state };
  return { height: heights[0], state };
}

async function saveSnapshot(key, height, state, network) {
  const n = network || (await currentNetwork());
  await db.put(db.STORES.snapshots, snapKey(n, height), await vault.encrypt(key, state));
  snapCache = { key, network: n, height, state };
  const heights = await snapHeights(n);
  await Promise.all(heights.slice(SNAPSHOTS_KEPT).map((h) => db.del(db.STORES.snapshots, snapKey(n, h))));
}

async function dropSnapshots(network) {
  snapCache = null;
  await db.delPrefix(db.STORES.snapshots, `${network}:`);
}

// ------------------------------------------------------------- history -----

async function readActivity(key, network) {
  const n = network || (await currentNetwork());
  const box = await db.get(db.STORES.kv, `activity:${n}`);
  return box ? JSON.parse(new TextDecoder().decode(await vault.decrypt(key, box))) : [];
}

async function writeActivity(key, list, network) {
  const n = network || (await currentNetwork());
  const data = new TextEncoder().encode(JSON.stringify(list.slice(0, 500)));
  await db.put(db.STORES.kv, `activity:${n}`, await vault.encrypt(key, data));
}

/**
 * Turn a sync batch into history:
 * - money received on a receiving address -> "received"
 * - change coming back to us -> hidden (it is part of our own send)
 * - our coin spent by our own transaction -> marks that "sent" entry confirmed
 * - our coin spent by a transaction we did not make here -> "spent elsewhere"
 * Entries have stable ids, so a rescan never adds duplicates.
 */
async function recordBlockEvents(key, events) {
  if (!events.length) return false;
  const list = await readActivity(key);
  const ids = new Set(list.map((e) => e.id));
  const fresh = [];
  for (const ev of events) {
    for (const u of ev.received) {
      if (u.is_change) continue;
      const id = `r:${ev.height}:${u.aocl_index}`;
      if (ids.has(id)) continue;
      ids.add(id);
      fresh.push({
        kind: 'received', walletMode:u.wallet_mode || (u.private_message!=null||u.address_kind==='private-unprotected'?'encrypted':'standard'), amount: u.amount, height: ev.height, at: ev.timestamp_ms,
        addressKind: u.address_kind === 'private-unprotected' ? 'private-unprotected' : u.private_message != null ? 'private-app' : u.address_kind,
        privateDowngrade: u.address_kind === 'private-unprotected',
        encryptedMessage: u.private_message ?? null, status: 'confirmed', id,
      });
    }
    const seenTx = new Set();
    for (const u of ev.spent) {
      if (u.tx_id) {
        if (seenTx.has(u.tx_id)) continue;
        seenTx.add(u.tx_id);
        const sent = list.find((e) => e.kind === 'sent' && e.txId === u.tx_id);
        if (sent) Object.assign(sent, { status: 'confirmed', height: ev.height, confirmedAt: ev.timestamp_ms });
      } else {
        const id = `s:${ev.height}:${u.aocl_index}`;
        if (ids.has(id)) continue;
        ids.add(id);
        fresh.push({ kind: 'spent-elsewhere', walletMode:u.wallet_mode || 'standard', amount: u.amount, height: ev.height, at: ev.timestamp_ms, status: 'confirmed', id });
      }
    }
  }
  fresh.reverse(); // newest first
  await writeActivity(key, [...fresh, ...list]);

  const recent = (e) => Date.now() - (e.at || 0) < 3 * 3600_000;
  const received = fresh.filter((e) => e.kind === 'received' && recent(e));
  if (received.length === 1) {
    const k = received[0].addressKind === 'private-app' ? t('private.kind') : received[0].addressKind === 'ec-hybrid' ? t('kind.ecHybridShort') : t('kind.generationShort');
    pushNotice('received', { n: amt(received[0].amount), k });
  } else if (received.length > 1) {
    pushNotice('receivedMany', { c: received.length, n: amt(received.reduce((a, e) => plus(a, e.amount), '0')) });
  }
  for (const ev of events) {
    for (const u of ev.spent) {
      const sent = u.tx_id && list.find((e) => e.kind === 'sent' && e.txId === u.tx_id && e.confirmedAt === ev.timestamp_ms);
      if (sent && Date.now() - ev.timestamp_ms < 3 * 3600_000 && !sent.notified) {
        sent.notified = true;
        pushNotice('confirmed', { n: amt(plus(sent.amount, sent.fee || '0')), c: amt(sent.change || '0') });
      }
    }
  }
  return true;
}

/** Payments still pending long after broadcast: their coins were released. */
async function expireOldSends(key, height) {
  const list = await readActivity(key);
  let changed = false;
  for (const e of list) {
    if (e.kind === 'sent' && e.status === 'pending' && !e.broadcastUncertain && e.atHeight != null && height - e.atHeight >= STALE_RESERVATION_BLOCKS) {
      e.status = 'expired';
      changed = true;
    }
  }
  if (changed) await writeActivity(key, list);
  return changed;
}

// ----------------------------------------------------------------- sync ----

// The tip check runs every minute, so it is plain JSON: no wasm to load.
async function fetchHeight(server, { interruptible = false } = {}) {
  if (!server) throw new Error('NEED_SERVER');
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpc.id(), method: 'chain_height', params: [] });
  const text = await rpc.post(server, body, { timeoutMs: 20_000, interruptible });
  const h = JSON.parse(text)?.result?.height;
  const n = typeof h === 'string' ? Number(h) : h;
  if (Number.isSafeInteger(n) && n >= 0) return n;
  await wasm(); // an encoding this code does not know: let the node's own types decide
  return light.parseHeight(text);
}

/**
 * First state: right after `height` (the tip for a new wallet). Height 0 is
 * the genesis block, rebuilt locally (servers never send it): a scan from
 * there also covers block 1 and finds premine allocations.
 */
async function initialState(wallet, server, height) {
  if (height <= 0) return wallet.genesisState();
  const body = await rpc.post(server, light.getBlocksRequest(rpc.id(), height, height));
  return wallet.stateFromBlock(body);
}

/** The block height at a date: estimate from the block time, then correct with real timestamps. */
async function heightAtDate(server, dateMs) {
  await wasm();
  const tip = await fetchHeight(server);
  let h = tip - Math.round((Date.now() - dateMs) / BLOCK_TIME_MS);
  for (let i = 0; i < 5; i++) {
    h = Math.min(tip, Math.max(1, h));
    const info = light.blockInfo(await rpc.post(server, light.getBlocksRequest(rpc.id(), h, h)));
    const diff = info.timestamp_ms - dateMs;
    if (Math.abs(diff) < 6 * 3600_000) break;
    h -= Math.round(diff / BLOCK_TIME_MS);
  }
  // Start a little earlier: a day of margin.
  return Math.max(1, Math.min(tip, h) - 150);
}

// --------------------------------------------------------------------- tor ---
// "Connect through Tor": the wallet's servers, the price service and the Tor
// check go through the Tor SOCKS port on this computer (Tor Browser: 9150,
// the tor service: 9050), via a proxy script that names only those hosts.
// The rest of the browser is untouched. It fails closed: the script offers no
// direct fallback, so if Tor is down requests fail instead of leaking the IP.

const TOR_CHECK_URL = 'https://check.torproject.org/api/ip';
const TOR_RECHECK_MS = 10 * 60_000;
const isLocalHost = (h) => ['localhost', '127.0.0.1', '[::1]'].includes(h);

async function torState() {
  const r = await chrome.storage.session.get('tor');
  return r.tor || { state: 'off' };
}

async function setTorState(next) {
  next = { ...next, required: next.state !== 'off' };
  await chrome.storage.session.set({ tor: next });
  notify('tor', { tor: next });
  return next;
}

function torHosts(s) {
  const hosts = new Set(['api.coingecko.com', 'check.torproject.org']);
  for (const srv of Object.values(s.servers || {})) {
    for (const u of [srv.sync, srv.broadcast]) {
      try {
        const h = new URL(u).hostname;
        if (h && !isLocalHost(h)) hosts.add(h);
      } catch {
        /* empty or invalid: nothing to route */
      }
    }
  }
  for (const url of s.watchNodes || []) {
    try { const h = new URL(url).hostname; if (!isLocalHost(h)) hosts.add(h); } catch {}
  }
  return [...hosts];
}

function pacScript(hosts, port) {
  return `function FindProxyForURL(url, host) {
  var tor = ${JSON.stringify(hosts)};
  for (var i = 0; i < tor.length; i++) {
    if (host === tor[i]) return "SOCKS5 127.0.0.1:${Number(port)}";
  }
  return "DIRECT";
}`;
}

/** Set or clear the proxy to match the settings, then check Tor. */
async function applyTor({ check = true } = {}) {
  const s = await settingsStore.load();
  if (!chrome.proxy?.settings) {
    if (s.tor) return setTorState({ state: 'error', error: 'NO_PERMISSION', at: Date.now() });
    return setTorState({ state: 'off' });
  }
  if (!s.tor) {
    await chrome.proxy.settings.clear({ scope: 'regular' }).catch(() => {});
    return setTorState({ state: 'off' });
  }
  const port = Number(s.torPort) || 9150;
  try {
    const control = await chrome.proxy.settings.get({});
    if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(control.levelOfControl)) {
      return setTorState({ state: 'error', error: control.levelOfControl === 'not_controllable' ? 'POLICY' : 'OTHER_PROXY', port, at: Date.now() });
    }
    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: pacScript(torHosts(s), port), mandatory: true } }, scope: 'regular',
    });
    const got = await chrome.proxy.settings.get({});
    if (got.levelOfControl !== 'controlled_by_this_extension') return setTorState({ state: 'error', error: 'OTHER_PROXY', port, at: Date.now() });
  } catch (e) {
    return setTorState({ state: 'error', error: 'PROXY_ERROR', detail: String(e.message || e).slice(0, 150), port, at: Date.now() });
  }
  return check ? checkTor() : torState();
}

/** Ask the Tor Project whether our requests arrive through Tor. */
async function checkTor() {
  const s = await settingsStore.load();
  if (!s.tor) return setTorState({ state: 'off' });
  const port = Number(s.torPort) || 9150;
  await setTorState({ state: 'connecting', port, at: Date.now() });
  try {
    const res = await fetch(TOR_CHECK_URL, { cache: 'no-store', credentials: 'omit', redirect:'error', signal: AbortSignal.timeout(30_000) });
    const j = await res.json();
    if (j?.IsTor === true) return setTorState({ state: 'on', port, at: Date.now() });
    return setTorState({ state: 'error', error: 'NOT_TOR', port, at: Date.now() });
  } catch {
    return setTorState({ state: 'error', error: 'NO_TOR', port, at: Date.now() });
  }
}

async function maybeRecheckTor() {
  const t = await torState();
  const s = await settingsStore.load();
  if (!s.tor) return;
  if (t.state !== 'on' || Date.now() - (t.at || 0) > TOR_RECHECK_MS) await applyTor().catch(() => {});
}

// ------------------------------------------------------------ spend index --
// The spends of every block, as an observer sees them (an interval of AOCL
// leaves per spend; light_core::anonymity). Public chain data, kept so the
// privacy panel can give each coin's exact anonymity count. Stored in pages of
// 1000 blocks, keyed by height, so re-applying a block simply overwrites it.

const SPEND_PAGE = 1000;
const spendPageKey = (net, page) => `spends:${net}:${String(page).padStart(6, '0')}`;
let spendCache = null; // { net, height, flat } for the last complete build

// Pages are read, changed and written back; parallel downloads must not
// interleave those steps, or one batch's blocks would overwrite another's.
let spendWrites = Promise.resolve();
function recordSpends(net, list) {
  const run = spendWrites.then(() => writeSpends(net, list));
  spendWrites = run.catch(() => {});
  return run;
}

async function writeSpends(net, list) {
  if (!list?.length) return;
  const pages = new Map();
  for (const b of list) {
    const page = Math.floor((b.height - 1) / SPEND_PAGE);
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(b);
  }
  for (const [page, blocks] of pages) {
    const k = spendPageKey(net, page);
    const cur = (await db.get(db.STORES.kv, k)) || {};
    for (const b of blocks) cur[b.height] = b.ranges ? Array.from(b.ranges) : null;
    await db.put(db.STORES.kv, k, cur);
  }
  spendCache = null;
}

/** Heights in [1, upTo] the index lacks (or could not compute), as runs. */
async function spendGaps(net, upTo) {
  const gaps = [];
  let have = 0;
  let runStart = null;
  const lastPage = Math.floor((upTo - 1) / SPEND_PAGE);
  for (let page = 0; page <= lastPage; page++) {
    const cur = (await db.get(db.STORES.kv, spendPageKey(net, page))) || {};
    const end = Math.min(upTo, (page + 1) * SPEND_PAGE);
    for (let h = page * SPEND_PAGE + 1; h <= end; h++) {
      const ok = Array.isArray(cur[h]);
      if (ok) have += 1;
      if (!ok && runStart == null) runStart = h;
      if (ok && runStart != null) {
        gaps.push([runStart, h - 1]);
        runStart = null;
      }
    }
  }
  if (runStart != null) gaps.push([runStart, upTo]);
  return { gaps, have, total: Math.max(0, upTo) };
}

/** Every spend interval of blocks 1..upTo, flattened, or null if incomplete. */
async function spendIndex(net, upTo) {
  if (spendCache && spendCache.net === net && spendCache.height === upTo) return spendCache.flat;
  const flat = [];
  const lastPage = Math.floor((upTo - 1) / SPEND_PAGE);
  for (let page = 0; page <= lastPage; page++) {
    const cur = (await db.get(db.STORES.kv, spendPageKey(net, page))) || {};
    const end = Math.min(upTo, (page + 1) * SPEND_PAGE);
    for (let h = page * SPEND_PAGE + 1; h <= end; h++) {
      if (!Array.isArray(cur[h])) return null;
      for (const v of cur[h]) flat.push(v);
    }
  }
  spendCache = { net, height: upTo, flat };
  return flat;
}

/** Fill in missing blocks of the spend index, a chunk per run. Returns true when more is left. */
async function fillSpendIndex(server, net, upTo) {
  const { gaps, have, total } = await spendGaps(net, upTo);
  await setStatus({ spendIndex: { have, total } });
  if (!gaps.length) return false;
  let budget = MAX_BLOCKS_PER_RUN;
  const heights = [];
  for (const [a, b] of gaps) {
    for (let h = a; h <= b && budget > 0; h++, budget--) heights.push(h);
    if (budget <= 0) break;
  }
  let done = have;
  await fetchBlocksAt(server, heights, async (body) => {
    const list = light.spendRanges(body, net);
    await recordSpends(net, list);
    done += list.filter((b) => b.ranges).length;
    await setStatus({ spendIndex: { have: done, total } });
  }, true);
  // Count again from what is stored, not from what was attempted.
  const after = await spendGaps(net, upTo);
  await setStatus({ spendIndex: { have: after.have, total: after.total } });
  return after.gaps.length > 0 && (after.have > have || yieldNow());
}

// ------------------------------------------------------------ fast restore --

/** Download the blocks at `heights` (any order) in ranges, a few at a time. */
async function fetchBlocksAt(server, heights, onBody, stopEarly = false) {
  const perCall = light.maxBlocksPerCall();
  const sorted = [...new Set(heights)].sort((a, b) => a - b);
  const ranges = [];
  for (const h of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && h === last[1] + 1 && h - last[0] < perCall) last[1] = h;
    else ranges.push([h, h]);
  }
  let next = 0;
  const worker = async () => {
    while (next < ranges.length && !(stopEarly && yieldNow())) {
      const [from, to] = ranges[next++];
      let body;
      for (let attempt = 0; ; attempt++) {
        try {
          body = await rpc.post(server, light.getBlocksRequest(rpc.id(), from, to), { timeoutMs: BLOCKS_TIMEOUT_MS, interruptible: true });
          break;
        } catch (e) {
          if (e.message === 'SCAN_INTERRUPTED' || attempt >= 3) throw e;
          await sleep(800 * (attempt + 1));
        }
      }
      await onBody(body);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, ranges.length) }, worker));
}

/**
 * Fast restore through the server's UTXO index (light_core::fast). Seconds
 * instead of a full scan; the server learns which coins are the wallet's.
 * Throws FAST_UNSUPPORTED when the server has no UTXO index.
 */
async function fastRestore(wallet, server, onProgress, previousState, profile) {
  const fr = profile ? light.FastRestore.forProfile(profile) : new light.FastRestore();
  try {
    if (previousState) fr.seedState(previousState);
    // 1. Which blocks hold payments to our keys. Each round can reveal keys
    //    beyond the look-ahead window; the next round asks about those too.
    let complete = false;
    for (let round = 0; round < 64; round++) {
      const req = fr.flagsRequest(wallet, rpc.id());
      if (!req) { complete = true; break; }
      let body;
      try {
        body = await rpc.post(server, req, { timeoutMs: BLOCKS_TIMEOUT_MS, interruptible: true });
      } catch (e) {
        if (e.message === 'SCAN_INTERRUPTED') throw e;
        if (round === 0) throw new Error(`FAST_UNSUPPORTED: ${e.message}`);
        throw e;
      }
      const heights = fr.heightsToFetch(body);
      await fetchBlocksAt(server, heights, async (b) => {
        fr.scanBlocks(wallet, b);
        await onProgress?.(fr.progress());
      });
    }
    if (!complete) throw new Error('Indexed recovery exceeded its key discovery limit. Continuing with a private scan.');
    // 2. Membership proofs, all relative to one block, checked locally.
    const chunks = fr.restoreChunks();
    if (chunks > 0) {
      for (let attempt = 0; ; attempt++) {
        try {
          for (let i = 0; i < chunks; i++) {
            fr.applyRestore(i, await rpc.post(server, fr.restoreRequest(rpc.id(), i), { timeoutMs: BLOCKS_TIMEOUT_MS, interruptible: true }));
          }
          break;
        } catch (e) {
          if (!/TIP_MOVED/.test(String(e.message)) || attempt >= 4) throw e;
          fr.resetProofs();
        }
      }
      // 3. Where spent coins were spent, for the history. Optional.
      const spentReq = fr.spentRequest(rpc.id());
      if (spentReq) {
        try {
          const heights = fr.parseSpentHeights(await rpc.post(server, spentReq, { timeoutMs: BLOCKS_TIMEOUT_MS, interruptible: true }));
          await fetchBlocksAt(server, heights, async (b) => fr.scanSpends(wallet, b));
        } catch {
          // Without it, spent coins still count as spent; only their dates are missing.
        }
      }
    }
    // 4. Wallet state at the block the proofs belong to (the tip if nothing was found).
    const h = fr.snapshotHeight() ?? (await fetchHeight(server));
    const block = await rpc.post(server, light.getBlocksRequest(rpc.id(), h, h), { timeoutMs: BLOCKS_TIMEOUT_MS, interruptible: true });
    return fr.finish(wallet, block);
  } finally {
    fr.free?.();
  }
}

/** Run a pending fast restore inside a sync run. Returns the new snapshot, or null. */
async function runFastRestore({ key, wallet, s, server, st, snap }) {
  const mode = st.fastPending;
  await setStatus({ fastPhase: 'scan', syncing: true });
  try {
    // Pending payment codes have no AOCL index yet. Previously confirmed
    // coins, including unannounced coins, are seeded into indexed recovery.
    if (snap?.state && wallet.expectedList(snap.state).length) throw new Error('Waiting payment codes require a private full scan.');
    const out = await fastRestore(wallet, server, (p) => {
      return setStatus({ fastPhase: 'scan', fastFound: p.coins_found, fastBlocks: p.blocks_scanned });
    }, snap?.state, st.recoveryWallet);
    if (snap?.state && st.recoveryWallet) out.state = wallet.mergeRecoveredProfile(snap.state, out.state, st.recoveryWallet);
    if (snap?.state) out.state = wallet.carryOver(snap.state, out.state);
    await dropSnapshots(s.network);
    await saveSnapshot(key, out.height, out.state);
    if (out.events?.length && (await recordBlockEvents(key, out.events))) notify('activity');
    await db.put(db.STORES.kv, `fastRestored:${s.network}`, { mode, server, at: Date.now() });
    await setStatus({ fastPending: null, fastPhase: null, fastFailed: null, height: out.height, startHeight: out.height, restored: true });
    return { height: out.height, state: out.state };
  } catch (e) {
    // No index on this server, or it answered something we could not check:
    // fall back to the private full scan, which needs nothing from the server.
    const msg = String(e.message || e);
    if (msg === 'SCAN_INTERRUPTED') throw e;
    const start = st.recoveryStart ?? 0;
    let state = await initialState(wallet, server, start);
    if (snap?.state) state = wallet.rescanState(snap.state, state);
    await dropSnapshots(s.network);
    await saveSnapshot(key, start, state);
    await setStatus({ height:start, startHeight:start, fastPending: null, fastPhase: null, fastFailed: /FAST_UNSUPPORTED/.test(msg) ? 'unsupported' : msg.slice(0, 200) });
    return {height:start,state};
  }
}

// Request size and parallelism, adjusted to how the server answers.
const tune = { parallel: 2, maxParallel: PREFETCH, size: 0, good: 0 };

let followUp = null;
function scheduleFollowUp() {
  if (followUp) return;
  followUp = setTimeout(() => {
    followUp = null;
    syncOnce().catch(() => {});
  }, 200);
}

const syncOnce = singleFlight(() => keepAlive(() =>
    exclusive(async () => {
      await migrateStorage();
      if (!(await vault.sessionKey())) return;
      const s0 = await settingsStore.load();
      if (s0.tor && !(await torState()).required) await applyTor();
      const server = settingsStore.serversFor(s0).sync;

      let tip;
      try {
        tip = await fetchHeight(server, { interruptible: true });
      } catch (e) {
        if (e.message === 'SCAN_INTERRUPTED') throw e;
        await setStatus({ serverOk: false, lastCheckAt: Date.now(), error: e.message === 'NEED_SERVER' ? 'NEED_SERVER' : null });
        throw e;
      }
      const st = await status();
      // Nothing new on chain: a status update and done. The wallet is not
      // opened, nothing is decrypted and no wasm is loaded.
      const [savedHeight] = await snapHeights(s0.network);
      const indexDone = s0.exactPrivacy === false
        || (st.spendIndex && st.spendIndex.total >= savedHeight && st.spendIndex.have >= st.spendIndex.total);
      const archiveDone = !s0.localArchive || (st.archive && st.archive.state === 'ready'
        && st.archive.target >= Math.max(0, savedHeight - ARCHIVE_LAG) && !st.adoptPending);
      if (savedHeight != null && savedHeight >= tip && st.height === savedHeight && !st.fastPending && !st.error && indexDone && !st.watchBehind && archiveDone) {
        await setStatus({ serverOk: true, lastCheckAt: Date.now(), tip, syncing: false });
        return;
      }

      const w = await openWallet();
      if (!w) return;
      const { key, wallet, s } = w;
      let snap = await latestSnapshot(key);
      if (!snap) throw new Error('This network has no wallet state yet. Switch to it again from the home page.');
      const watchData = await watchDataFor(key, wallet, snap, s.network);
      const watching = activeWatchIds(wallet.watchList(snap.state, Date.now()), watchData.prefs);
      if (st.fastPending) {
        snap = (await runFastRestore({ key, wallet, s, server, st, snap })) || snap;
      }
      await setStatus({
        serverOk: true, lastCheckAt: Date.now(), tip,
        lastTipChangeAt: !st.tip || tip > st.tip ? Date.now() : st.lastTipChangeAt,
        syncing: snap.height < tip, height: snap.height, error: null,
        startHeight: st.startHeight ?? snap.height,
      });

      let applied = 0;
      let retries = 0;
      const perCall = light.maxBlocksPerCall();
      const runEnd = Math.min(tip, snap.height + MAX_BLOCKS_PER_RUN);
      // Download several batches at once (the network is the slow part) and
      // apply them strictly in order. A batch that no longer fits after a
      // reorganization is thrown away and fetched again. When the server is
      // slow or refuses, the wallet asks for fewer blocks, one request at a
      // time, and speeds up again once answers come back quickly.
      tune.size = Math.min(tune.size || perCall, perCall);
      let pending = [];
      let nextFrom = snap.height + 1;
      const fill = () => {
        while (pending.length < tune.parallel && nextFrom <= runEnd) {
          const from = nextFrom;
          const to = Math.min(from + tune.size - 1, runEnd);
          const job = { from, to, started: Date.now() };
          job.body = rpc.post(server, light.getBlocksRequest(rpc.id(), from, to), { timeoutMs: BLOCKS_TIMEOUT_MS, interruptible: true });
          job.body.then(() => { job.ms = Date.now() - job.started; }, () => {}); // a discarded batch must not raise
          pending.push(job);
          nextFrom = to + 1;
        }
      };
      const restart = () => {
        pending = [];
        nextFrom = snap.height + 1;
      };
      let unsaved = 0;
      let savedAt = Date.now();
      let failures = 0;
      const save = async () => {
        if (!unsaved) return;
        await saveSnapshot(key, snap.height, snap.state);
        unsaved = 0;
        savedAt = Date.now();
      };

      while (snap.height < runEnd) {
        // A user action is waiting: save and step aside; the next run continues.
        if (yieldNow() && applied > 0) break;
        fill();
        const job = pending.shift();
        if (!job) break;
        if (job.from !== snap.height + 1) {
          restart();
          continue;
        }
        let body;
        try {
          body = await job.body;
        } catch (e) {
          // Keep what was scanned so far, then ask for less, one at a time.
          await save();
          if (e.message === 'SCAN_INTERRUPTED') { scheduleFollowUp(); return; }
          if (++failures > MAX_FETCH_FAILURES) throw e;
          // Refused while several requests were open: stay below that from now on.
          if (tune.parallel > 1) tune.maxParallel = Math.max(1, tune.parallel - 1);
          tune.parallel = 1;
          tune.size = Math.max(1, Math.floor((job.to - job.from + 1) / 2));
          tune.good = 0;
          await setStatus({ height: snap.height, retrying: true });
          await sleep(Math.min(10_000, 500 * 2 ** failures));
          restart();
          continue;
        }
        failures = 0;
        if (job.ms > SLOW_MS) {
          tune.parallel = Math.max(1, tune.parallel - 1);
          if (tune.parallel === 1) tune.size = Math.max(1, Math.floor(tune.size / 2));
          tune.good = 0;
        } else if (job.ms < SLOW_MS / 4 && ++tune.good >= 5) {
          // Speed up again only after several quick answers in a row.
          tune.good = 0;
          if (tune.size < perCall) tune.size = Math.min(perCall, tune.size * 2);
          else if (tune.parallel < tune.maxParallel) tune.parallel += 1;
        }

        const out = wallet.applyBlocksWatching(snap.state, body, JSON.stringify(watching));
        const r = out.result;

        if (r.reorg) {
          if (++retries > 5) throw new Error('The server keeps returning blocks that do not connect');
          await save();
          if (r.applied === 0) {
            // Our tip was orphaned: drop this snapshot and step back.
            await db.del(db.STORES.snapshots, snapKey(s.network, snap.height));
            snapCache = null;
            snap = await latestSnapshot(key);
            if (!snap) throw new Error('Reorganization deeper than saved history. Restore the wallet again.');
          }
          restart(); // the chain changed mid-request: refetch
          continue;
        }

        if (!r.applied) throw new Error('The node returned no usable blocks. Retry or choose another sync server.');
        snap = { height: r.height, state: out.state };
        applied += r.applied;
        unsaved += r.applied;
        const found = r.events.length > 0;
        // Saving encrypts the whole state, so during a long scan it happens
        // every SAVE_EVERY blocks or SAVE_EVERY_MS, and right after coins are found.
        if (found || unsaved >= SAVE_EVERY || Date.now() - savedAt >= SAVE_EVERY_MS || snap.height >= runEnd) {
          await save();
        }
        if (found && (await recordBlockEvents(key, r.events))) notify('activity');
        await recordSpends(s.network, r.spends).catch(() => {});
        await setStatus({ height: snap.height, retrying: false });
      }
      if (unsaved) await saveSnapshot(key, snap.height, snap.state);

      // Free inputs of our transactions that never confirmed.
      const released = wallet.releaseStale(snap.state, STALE_RESERVATION_BLOCKS);
      await saveSnapshot(key, snap.height, released);
      snap.state = released;
      if (await expireOldSends(key, snap.height)) notify('activity');

      await setStatus({ syncing: snap.height < tip, height: snap.height, lastSyncAt: Date.now() });
      // Not at the tip yet (a restore): carry on right away instead of waiting
      // a minute for the alarm. Each chunk releases the lock in between, so
      // other actions (send, receive, settings) are never blocked for long.
      if (snap.height < tip) {
        scheduleFollowUp();
      } else {
        // Caught up. Background work, one chunk per run, each retried on the
        // next run if it fails: watch-only addresses that lag behind, then the
        // local archive (which also fills the spend index), or else the
        // spend index alone, for exact anonymity counts.
        let more = false;
        try {
          if (yieldNow()) more = true;
          else more = (await watchCatchUp({ key, wallet, server, snap })) || more;
        } catch (e) {
          if (e.message === 'SCAN_INTERRUPTED') more = true;
          else await setStatus({ watchError: String(e.message || e).slice(0, 200) });
        }
        if (yieldNow()) {
          more = true;
        } else if (s.localArchive) {
          try {
            more = (await archiveStep({ key, wallet, server, net: s.network, snap })) || more;
          } catch (e) {
            await setArchiveStatus({ state: 'error', error: String(e.message || e).slice(0, 200) });
          }
        } else if (s.exactPrivacy !== false) {
          try {
            more = (await fillSpendIndex(server, s.network, snap.height)) || more;
          } catch {
            // Retried on the next run.
          }
        }
        if (more) scheduleFollowUp();
      }
    }),
  ).catch(async (e) => {
    if (e.message === 'SCAN_INTERRUPTED') { scheduleFollowUp(); return; }
    if (e.message !== 'NEED_SERVER') await setStatus({ syncing: false, error: String(e.message || e) }).catch(() => {});
    throw e;
  }));

// --------------------------------------------- blocks in strict order -----

/**
 * Download blocks `from..to` and hand each response to `onBody` in order (two
 * requests ahead). Stops early, between batches, when a user action waits.
 * Returns the last height handed over.
 */
async function fetchInOrder(server, from, to, onBody) {
  const perCall = light.maxBlocksPerCall();
  const ranges = [];
  for (let a = from; a <= to; a += perCall) ranges.push([a, Math.min(to, a + perCall - 1)]);
  const get = ([a, b]) => {
    const p = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await rpc.post(server, light.getBlocksRequest(rpc.id(), a, b), { timeoutMs: BLOCKS_TIMEOUT_MS, interruptible: true });
        } catch (e) {
          if (e.message === 'SCAN_INTERRUPTED' || yieldNow()) throw e;
          if (attempt >= 3) throw e;
          await sleep(800 * (attempt + 1));
        }
      }
    })();
    p.catch(() => {}); // awaited below; a rejection before that must not surface
    return p;
  };
  const ahead = ranges.slice(0, 2).map(get);
  let last = from - 1;
  for (let i = 0; i < ranges.length; i++) {
    if (yieldNow()) break;
    const body = await ahead[i];
    if (i + 2 < ranges.length) ahead.push(get(ranges[i + 2]));
    await onBody(body, ranges[i]);
    last = ranges[i][1];
  }
  return last;
}

// ---------------------------------------------------------- watch-only -----
// Other wallets' addresses, followed with their viewing keys. They live in
// the wallet state (so a reorg rollback restores them too). A new one is
// scanned from its first block in the background, here, a chunk per run.

// Registration and preferences are one encrypted record, independent of block snapshots.
async function readWatchData(key, network) {
  const box = await db.get(db.STORES.kv, `watchData:${network || await currentNetwork()}`);
  return box ? JSON.parse(dec.decode(await vault.decrypt(key, box))) : null;
}
async function writeWatchData(key, data, network) {
  await db.put(db.STORES.kv, `watchData:${network || await currentNetwork()}`, await vault.encrypt(key, enc.encode(JSON.stringify(data))));
}
async function watchDataFor(key, wallet, snap, network) {
  return await readWatchData(key, network) || {
    records: wallet.watchRegistry(snap.state), prefs: {},
    nextId: Math.max(0, ...wallet.watchList(snap.state, Date.now()).map((a) => a.id)) + 1,
  };
}
const fastWatchKey = (net, id) => `watchFast:${net}:${id}`;

// One bounded indexed step. The checkpoint holds only the watched account,
// encrypted like the rest of the wallet, and survives worker termination.
async function watchFastStep({ key, wallet, server, snap, account, pref, net }) {
  const taskKey = fastWatchKey(net, account.id);
  const box = await db.get(db.STORES.kv, taskKey);
  let task = box ? JSON.parse(dec.decode(await vault.decrypt(key, box))) : { phase: 'flags', next: 0, offset: 0, heights: [] };
  const scan = task.bytes ? light.WatchFastScan.fromBytes(new Uint8Array(task.bytes)) : new light.WatchFastScan(snap.state, account.id);
  let consumed = false;
  const checkpoint = async () => {
    task.bytes = Array.from(scan.toBytes());
    await db.put(db.STORES.kv, taskKey, await vault.encrypt(key, enc.encode(JSON.stringify(task))));
    await setStatus({ watchBehind: { at: account.scanned_to, end: scan.height() },
      watchFast: { id: account.id, phase: task.phase, done: task.next, total: task.heights.length, found: scan.found() } });
  };
  try {
    const source = pref.mode === 'node' ? pref.server : server;
    if (!source) throw new Error('Choose a node URL for this watched address');
    const post = (body) => rpc.post(source, body, { timeoutMs: BLOCKS_TIMEOUT_MS, interruptible: true });
    if (task.phase === 'flags') {
      task.heights = Array.from(scan.heights(await post(scan.flagsRequest(rpc.id())), false));
      task.phase = 'receipts'; task.next = 0;
      await checkpoint();
    }
    const deadline = Date.now() + 3000;
    let processed = 0;
    while ((task.phase === 'receipts' || task.phase === 'spends') && task.next < task.heights.length) {
      if (yieldNow() || processed >= 12 || Date.now() > deadline) { await checkpoint(); return true; }
      const h = task.heights[task.next];
      scan.scan(await post(light.getBlocksRequest(rpc.id(), h, h)));
      task.next++; processed++;
      // Every returned block is a durable checkpoint.
      await checkpoint();
    }
    if (yieldNow()) { await checkpoint(); return true; }
    if (task.phase === 'receipts') { task.phase = 'spendIndex'; task.next = 0; task.heights = []; await checkpoint(); }
    if (task.phase === 'spendIndex') {
      const req = scan.spentRequest(rpc.id(), task.offset);
      if (req) {
        task.heights = [...new Set([...task.heights, ...scan.heights(await post(req), true)])].sort((a, b) => a - b);
        task.offset += 256;
        await checkpoint();
        return true;
      }
      task.phase = 'spends'; task.next = 0; await checkpoint();
      if (task.heights.length) return true;
    }
    if (task.phase === 'spends' && task.next === task.heights.length) {
      const anchor = await post(light.getBlocksRequest(rpc.id(), scan.height(), scan.height()));
      // finish consumes the WASM object.
      consumed = true;
      const state = scan.finish(snap.state, anchor);
      await saveSnapshot(key, snap.height, state, net); snap.state = state;
      await db.del(db.STORES.kv, taskKey);
      await setStatus({ watchFast: null, watchError: null });
      notify('watch', { network: net });
      return false;
    }
    return true;
  } finally { if (!consumed) scan.free?.(); }
}

async function watchCatchUp({ key, wallet, server, snap }) {
  const net = await currentNetwork();
  const data = await watchDataFor(key, wallet, snap, net);
  let list = decorateWatch(wallet.watchList(snap.state, Date.now()), data.prefs);
  // Prefer the least-recently served indexed account so one long scan cannot starve another.
  const indexed = list.filter((a) => !a.paused && a.mode !== 'private' && a.scanned_to < snap.height)
    .sort((a, b) => (a.servedAt || 0) - (b.servedAt || 0));
  if (indexed.length && !yieldNow()) {
    const account = indexed[0];
    const pref = data.prefs[account.id] ||= {};
    try {
      await watchFastStep({ key, wallet, server, snap, account, pref, net });
    } catch (e) {
      if (e.message === 'SCAN_INTERRUPTED') throw e;
      await db.del(db.STORES.kv, fastWatchKey(net, account.id));
      if (/WATCH_TIP_MOVED/.test(e.message)) { pref.warning = 'watch.tipMoved'; }
      else { pref.mode = 'private'; pref.warning = 'watch.fastFallback'; }
    }
    pref.servedAt = Date.now();
    await writeWatchData(key, data, net);
    list = decorateWatch(wallet.watchList(snap.state, Date.now()), data.prefs);
  }
  const active = list.filter((a) => !a.paused && a.scanned_to < snap.height);
  const privateAccounts = active.filter((a) => a.mode === 'private');
  if (privateAccounts.length && !yieldNow()) {
    const from = Math.min(...privateAccounts.map((a) => a.scanned_to + 1));
    const end = snap.height;
    const to = Math.min(end, from + 100 - 1);
    const ids = JSON.stringify(privateAccounts.map((a) => a.id));
    await setStatus({ watchBehind: { at: from - 1, end }, watchError: null });
    await fetchInOrder(server, from, to, async (body) => {
      const out = wallet.watchCatchUpFor(snap.state, body, ids);
      if (out.result.scanned === 0) throw new Error('The node returned no usable watch blocks. Retry or choose another sync server.');
      // Save before publishing progress. A later failed request cannot undo it.
      await saveSnapshot(key, snap.height, out.state, net);
      snap.state = out.state;
      const remaining = wallet.watchList(snap.state, Date.now()).filter((a) => privateAccounts.some((p) => p.id === a.id));
      await setStatus({ watchBehind: { at: Math.min(...remaining.map((a) => a.scanned_to)), end }, watchError: null });
      notify('watch', { network: net });
    });
  }
  const left = decorateWatch(wallet.watchList(snap.state, Date.now()), data.prefs)
    .filter((a) => !a.paused && a.scanned_to < snap.height);
  await setStatus({ watchBehind: left.length ? { at: Math.min(...left.map((a) => a.scanned_to)), end: snap.height } : null,
    watchFast: left.some((a) => a.mode !== 'private') ? (await status()).watchFast : null, watchError: null });
  return left.length > 0;
}

/**
 * Change the latest wallet state under the sync lock; `fn` returns
 * `{ state, out }`. Jumps ahead of background work; a job the popup
 * cancelled while waiting stops here, before any change.
 */
async function withState(fn, jobId) {
  jobProgress(jobId, { phase: 'waiting' });
  return exclusiveNow(async () => {
    cancelled(jobId);
    const { key, wallet, s } = await requireWallet();
    jobProgress(jobId, { phase: 'saving' });
    const snap = await latestSnapshot(key, s.network);
    if (!snap) throw new Error('NO_STATE');
    const r = await fn({ key, wallet, s, snap });
    if (r?.state) await saveSnapshot(key, snap.height, r.state, s.network);
    return r?.out;
  });
}

// ------------------------------------------------------------- archive -----
// The archival mutator set on this device (light_core::archive): every AOCL
// leaf and Bloom-filter chunk, tens of MB, built from genesis in order and
// checked against every block's commitment. It stays ARCHIVE_LAG blocks
// behind the wallet so that a small reorganization never reaches it; coins
// it finds are carried to the wallet's block through those last blocks.
// Stored as pages in one atomic write per run; reading it also fills the
// spend index for exact anonymity counts.

const ARCHIVE_LAG = 10;
const archKey = (net, part) => `arch:${net}:${part}`;
const pageKey = (net, kind, p) => archKey(net, `${kind}:${String(p).padStart(6, '0')}`);
let archiveCache = null; // { net, a }

function dropArchive() {
  archiveCache?.a.free?.();
  archiveCache = null;
}

async function setArchiveStatus(patch) {
  const st = await status();
  await setStatus({ archive: { ...(st.archive || {}), ...patch, at: Date.now() } });
}

async function deleteArchive(net) {
  dropArchive();
  await db.delPrefix(db.STORES.kv, archKey(net, ''));
}

/** The archive of `net`, from memory, from storage, or new at genesis. */
async function loadArchive(net) {
  if (archiveCache?.net === net) return archiveCache.a;
  await wasm();
  dropArchive();
  const meta = await db.get(db.STORES.kv, archKey(net, 'meta'));
  let a;
  if (!meta) {
    a = new light.Archive(net);
  } else {
    try {
      a = light.Archive.fromMeta(meta, net);
      for (let p = 0; ; p++) {
        const b = await db.get(db.STORES.kv, pageKey(net, 'L', p));
        if (!b) break;
        a.loadLeafPage(p, b);
      }
      for (let p = 0; ; p++) {
        const b = await db.get(db.STORES.kv, pageKey(net, 'C', p));
        if (!b) break;
        a.loadChunkPage(p, b);
      }
      a.finishLoad();
    } catch (e) {
      // Damaged or from an older layout: start over from genesis.
      a?.free?.();
      await db.delPrefix(db.STORES.kv, archKey(net, ''));
      await setArchiveStatus({ note: `rebuilt: ${String(e.message || e).slice(0, 120)}` });
      a = new light.Archive(net);
    }
  }
  archiveCache = { net, a };
  return a;
}

/** Write the pages changed since the last save, and the meta record, in one transaction. */
async function saveArchive(net, a) {
  const dirty = a.dirtyPages();
  const entries = [];
  for (const p of dirty.leaves) entries.push([pageKey(net, 'L', p), a.leafPage(p)]);
  for (const p of dirty.chunks) entries.push([pageKey(net, 'C', p), a.chunkPage(p)]);
  entries.push([archKey(net, 'meta'), a.metaBytes()]);
  await db.putMany(db.STORES.kv, entries);
  a.clearDirty();
}

/** One chunk of archive work. Returns true when more is left. */
async function archiveStep({ key, wallet, server, net, snap }) {
  const target = Math.max(0, snap.height - ARCHIVE_LAG);
  const a = await loadArchive(net);
  if (a.height() < target) {
    const from = a.height() + 1;
    const to = Math.min(target, from + MAX_BLOCKS_PER_RUN - 1);
    const prev = (await status()).archive || {};
    await setArchiveStatus({ state: 'building', height: a.height(), target, error: null, startedAt: prev.startedAt || Date.now() });
    let applyError = null;
    let downloaded = prev.downloaded || 0;
    let rate = prev.rate || 0; // blocks per minute, smoothed
    try {
      let lastAt = Date.now();
      await fetchInOrder(server, from, to, async (body, [ra, rb]) => {
        let spends;
        try {
          spends = a.applyBlocks(body);
        } catch (e) {
          applyError = e;
          throw e;
        }
        await recordSpends(net, spends).catch(() => {});
        downloaded += body.length;
        // Blocks per minute, download and checking included, smoothed.
        const now = Date.now();
        const inst = ((rb - ra + 1) * 60_000) / Math.max(1, now - lastAt);
        lastAt = now;
        rate = rate ? rate * 0.8 + inst * 0.2 : inst;
        await setArchiveStatus({ state: 'building', height: a.height(), target, downloaded, rate: Math.round(rate), leaves: a.numLeaves(), size: a.sizeBytes() });
      });
    } catch (e) {
      if (!applyError) {
        // The network failed between blocks: what was applied is whole. Keep it.
        await saveArchive(net, a);
        throw e;
      }
      if (/does not extend the archive/.test(String(applyError.message || applyError))) {
        // The archive's last block was orphaned by a deep reorganization.
        await deleteArchive(net);
        await setArchiveStatus({ state: 'building', height: 0, target, error: null, note: 'reorg' });
        return true;
      }
      // A block may be half applied: forget the copy in memory, keep what was saved.
      dropArchive();
      throw applyError;
    }
    await saveArchive(net, a);
  }
  const ready = a.height() >= target;
  await setArchiveStatus({ state: ready ? 'ready' : 'building', height: a.height(), target, size: a.sizeBytes(), leaves: a.numLeaves(), error: null, ...(ready ? { rate: 0 } : {}) });
  if (ready && !yieldNow()) {
    const adopted = await adoptWaiting({ key, wallet, server, snap, a });
    await setStatus({ adoptPending: false, ...(adopted.length ? { lastAdopted: { at: Date.now(), list: adopted } } : {}) });
  }
  return !ready || yieldNow();
}

/**
 * What the archive will take on this device, from the chain as the wallet
 * sees it: every AOCL leaf (40 bytes), every Bloom-filter chunk (its hash and
 * a length, 48 bytes), the 45 indices of every spend (4 bytes each, 180 per
 * spend) and the AOCL size after each block (8 bytes). The spend count is
 * exact once the spend index is complete, otherwise scaled from its pages.
 */
let estimateCache = null;
async function archiveEstimate(s) {
  const key = await vault.sessionKey();
  if (!key) return null;
  const snap = await latestSnapshot(key);
  if (!snap) return null;
  if (estimateCache && estimateCache.net === s.network && Math.abs(estimateCache.height - snap.height) < 50) return estimateCache.value;
  await wasm();
  const { wallet } = await requireWallet();
  const c = wallet.chainCounts(snap.state);
  let spends = 0;
  let blocks = 0;
  const lastPage = Math.floor((snap.height - 1) / SPEND_PAGE);
  for (let page = 0; page <= lastPage; page++) {
    const cur = (await db.get(db.STORES.kv, spendPageKey(s.network, page))) || {};
    for (const v of Object.values(cur)) {
      if (!Array.isArray(v)) continue;
      blocks += 1;
      spends += v.length / 2;
    }
  }
  const exact = blocks >= snap.height && snap.height > 0;
  // Without a spend index yet: about one spend for every two coins created.
  const spendCount = blocks > 0 ? Math.round((spends * snap.height) / blocks) : Math.round(c.aocl_leaves / 2);
  const bytes = c.aocl_leaves * 40 + c.chunks * 48 + spendCount * 180 + snap.height * 8 + c.active * 4;
  const value = { bytes, leaves: c.aocl_leaves, chunks: c.chunks, spends: spendCount, spendsExact: exact, spendsSampled: blocks > 0, height: snap.height };
  estimateCache = { net: s.network, height: snap.height, value };
  return value;
}

/** Timestamp (ms) of block `height`; the genesis block's is not served, so 0. */
async function blockTime(server, height) {
  if (height <= 0) return 0;
  try {
    return light.blockInfo(await rpc.post(server, light.getBlocksRequest(rpc.id(), height, height))).timestamp_ms;
  } catch {
    return 0;
  }
}

/** Registered coins the archive finds become the wallet's. */
async function adoptWaiting({ key, wallet, server, snap, a }) {
  if (!wallet.expectedList(snap.state).length) return [];
  if (a.height() > snap.height) return [];
  const body = a.height() < snap.height
    ? await rpc.post(server, light.getBlocksRequest(rpc.id(), a.height() + 1, snap.height), { timeoutMs: BLOCKS_TIMEOUT_MS })
    : undefined;
  const out = wallet.adoptFromArchive(snap.state, a, body);
  if (!out.adopted.length) return [];
  await saveSnapshot(key, snap.height, out.state);
  snap.state = out.state;
  const events = [];
  for (const x of out.adopted.filter((c) => !c.spent)) {
    events.push({
      height: x.height, hash: '', timestamp_ms: await blockTime(server, x.height), spent: [],
      received: [{ aocl_index: x.aocl_index, wallet_mode: x.wallet_mode || 'standard', amount: x.amount, is_change: x.key_kind === 'change', tx_id: null, address_kind: x.key_kind === 'change' ? null : x.key_kind }],
    });
  }
  if (events.length && (await recordBlockEvents(key, events))) notify('activity');
  return out.adopted;
}

// ----------------------------------------------------- offscreen prover -----

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Prove and broadcast transactions in parallel Web Workers',
  });
}

async function offscreenAlive() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function closeOffscreenIfIdle() {
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await getSend(id);
    if (rec && ['proving', 'proved', 'submitting'].includes(rec.status)) return;
  }
  if (await offscreenAlive()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  for (let i = 0; i < 15; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    } catch (e) {
      if (!/Receiving end|Could not establish/i.test(String(e.message))) throw e;
      await sleep(200);
    }
  }
  throw new Error('The proving page did not start');
}

/** Which send the offscreen page is working on right now, if any. */
async function offscreenBusyWith() {
  if (!(await offscreenAlive())) return null;
  try {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
    return r?.sendId || null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- send ----

// Send records live in IndexedDB. Who you pay, how much, and your note are
// sealed with the vault key, so a locked wallet's disk shows only progress.
const SEALED_FIELDS = ['to', 'amount', 'fee', 'view', 'pinned', 'toKind', 'fromKind', 'note', 'privateMessage', 'notificationMode', 'walletMode', 'error'];
const enc = new TextEncoder();
const dec = new TextDecoder();

async function getSend(id) {
  const rec = await db.get(db.STORES.sends, id);
  if (!rec?.sealed) return rec;
  const key = await vault.sessionKey();
  if (!key) return rec; // locked: progress fields only
  try {
    Object.assign(rec, JSON.parse(dec.decode(await vault.decrypt(key, rec.sealed))));
    rec.unsealed = true;
  } catch {
    /* sealed by a previous wallet: leave it */
  }
  return rec;
}

async function saveSend(rec) {
  rec.updatedAt = Date.now();
  const stored = { ...rec };
  delete stored.unsealed;
  const plain = {};
  let has = false;
  for (const f of SEALED_FIELDS) {
    if (f in stored) {
      plain[f] = stored[f];
      has = true;
      delete stored[f];
    }
  }
  const key = await vault.sessionKey();
  if (has && key) stored.sealed = await vault.encrypt(key, enc.encode(JSON.stringify(plain)));
  else if (has) throw new Error('Wallet locked before the encrypted payment record could be saved. Unlock to continue.');
  await db.put(db.STORES.sends, rec.id, stored);
  notify('send', { send: { ...rec, prepared: undefined, sealed: undefined } });
}

const ACTIVE = ['starting', 'waiting-block', 'preparing', 'rebuilding', 'proving', 'proved', 'submitting', 'uncertain', 'needs-lustration'];

async function activeSend(network) {
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await getSend(id);
    if (rec && rec.network === network && ACTIVE.includes(rec.status)) return rec;
  }
  return null;
}

async function startSend(req) {
  await migrateStorage();
  const id=await exclusiveNow(async()=>{
    const {s}=await requireWallet();
    const network=s.network;
    if(req.networkContext!==network || req.walletMode!==activeMode(s))throw new Error('The selected wallet changed. Review this payment again.');
    const st=await status(network);
    if(st.fastPending||st.fastPhase||(st.height!=null&&st.tip!=null&&st.height<st.tip))throw new Error('Wallet recovery or syncing is still running. Wait until it is up to date.');
    const busy = await activeSend(network);
    if (busy) throw new Error('A payment is still being sent. Wait until it finishes, or open it from the home page.');
    const rec = {
      id: crypto.randomUUID(),
      network,
      to: req.to,
      toKind: req.toKind || null,
      walletMode: req.walletMode || 'standard',
      note: String(req.note || '').slice(0, 200),
      privateMessage: String(req.privateMessage || ''),
      notificationMode: req.notificationMode || 'auto',
      fromKind: ['generation', 'ec-hybrid'].includes(req.fromKind) ? req.fromKind : 'any',
      amount: req.amount,
      fee: req.fee,
      acceptLustration: Boolean(req.acceptLustration),
      waitForFreshBlock: req.waitForFreshBlock !== false,
      attempt: 1,
      pinned: null,
      createdAt: Date.now(),
      status: 'starting',
    };
    await saveSend(rec);
    return rec.id;
  });
  runSend(id).catch(() => {});
  return id;
}

const running = new Set(); // send ids with a step in progress in this worker

function guarded(id, fn) {
  if (running.has(id)) return Promise.resolve();
  running.add(id);
  return keepAlive(fn).finally(() => running.delete(id));
}

async function failSend(rec, error) {
  if(rec.broadcastUncertain) {
    rec.status='uncertain';
    await saveSend(rec);
    return;
  }
  rec.status = 'failed';
  rec.error = friendlyError(error);
  pushNotice('failed', { e: rec.error });
  delete rec.prepared;
  await saveSend(rec);
  await db.delPrefix(db.STORES.jobs, `${rec.id}:`);
  await db.delPrefix(db.STORES.proofs, `${rec.id}:`);
  await closeOffscreenIfIdle();
}

function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (/HTTP 413|RequestBodyTooBig|too big|too large/i.test(m)) {
    return 'The broadcast server refused the transaction because of its size. Choose another broadcast server in Settings > Servers.';
  }
  if (/Failed to fetch|NetworkError|aborted|timed out/i.test(m)) {
    return 'Could not confirm the broadcast result. Check your transaction history before retrying; the node may already have received this payment.';
  }
  if (/FeeNegative|fee/i.test(m) && /node:/.test(m)) return `The node refused the fee. ${m}`;
  if (/insufficient spendable balance/i.test(m)) return m.replace('insufficient spendable balance', 'Not enough available balance');
  return m;
}

function runSend(id) {
  return guarded(id, async () => {
    let rec = await getSend(id);
    if (!rec || !['starting', 'waiting-block', 'rebuilding'].includes(rec.status)) return;
    try {
      const w = await openWallet();
      if (!w) throw new Error('The wallet is locked. Unlock it to continue sending.');
      const { key, wallet, s } = w;
      if (s.network !== rec.network) return; // resumes when that network is active again

      // Timing: start right after a block, so proving finishes before the next.
      if (rec.waitForFreshBlock && rec.attempt === 1) {
        const st = await status();
        const sinceBlock = Date.now() - (st.lastTipChangeAt || 0);
        const freshSinceStart = (st.lastTipChangeAt || 0) > rec.createdAt;
        const waitedTooLong = Date.now() - rec.createdAt > MAX_BLOCK_WAIT_MS;
        if (sinceBlock > FRESH_BLOCK_WINDOW_MS && !freshSinceStart && !waitedTooLong) {
          if (rec.status !== 'waiting-block') {
            rec.status = 'waiting-block';
            await saveSend(rec);
          }
          return; // resumed by the sync alarm
        }
      }

      rec.status = 'preparing';
      await saveSend(rec);
      await syncOnce();
      if (await wasCancelled(id)) return;

      const snap = await latestSnapshot(key);
      const out = wallet.prepareSend(
        snap.state, rec.to, rec.amount, rec.fee, Date.now(),
        rec.pinned ? new Float64Array(rec.pinned) : undefined,
        rec.acceptLustration,
        rec.fromKind || 'any',
        rec.privateMessage || undefined,
        rec.walletMode || 'standard',
      );
      rec.view = out.view;
      rec.pinned = out.view.input_aocl_indices;
      rec.prepared = await vault.encrypt(key, out.prepared);
      rec.builtAtHeight = snap.height;
      rec.jobCount = out.jobs.length;
      rec.jobsDone = 0;
      await db.delPrefix(db.STORES.jobs, `${id}:`);
      await db.delPrefix(db.STORES.proofs, `${id}:`);
      await db.del(db.STORES.kv, `submit:${id}`);
      for (let i = 0; i < out.jobs.length; i++) {
        await db.put(db.STORES.jobs, `${id}:${i}`, await vault.encrypt(key, out.jobs[i]));
      }
      if (await wasCancelled(id)) return;
      await saveSend(rec);

      if (out.jobs.length === 0) return await dispatchSubmit(rec); // mock-proof network
      await dispatchProve(rec);
    } catch (e) {
      rec = (await getSend(id)) || rec;
      const msg = String(e.message || e);
      if (msg.includes('LUSTRATION_REQUIRED')) {
        rec.status = 'needs-lustration';
        rec.error = null;
        await saveSend(rec);
      } else {
        await failSend(rec, e);
      }
    }
  });
}

async function wasCancelled(id) {
  return (await getSend(id))?.status === 'cancelled';
}

const CANCELLABLE = ['starting', 'waiting-block', 'preparing', 'rebuilding', 'proving', 'needs-lustration'];

/** Stop a payment that has not reached the network yet. */
async function cancelSend(id) {
  const rec = await getSend(id);
  if (!rec) throw new Error('Payment not found');
  if(rec.broadcastUncertain || await db.get(db.STORES.kv, `submit:${id}`))throw new Error('Too late to cancel: the transaction may already have reached the network.');
  if (!CANCELLABLE.includes(rec.status)) {
    throw new Error('Too late to cancel: the payment is already being sent to the network.');
  }
  if (rec.status === 'proving' && (await offscreenBusyWith()) === id) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', sendId: id }).catch(() => {});
  }
  rec.status = 'cancelled';
  rec.dismissed = true;
  rec.doneAt = Date.now();
  delete rec.prepared;
  await saveSend(rec);
  await db.delPrefix(db.STORES.jobs, `${id}:`);
  await db.delPrefix(db.STORES.proofs, `${id}:`);
  await closeOffscreenIfIdle().catch(() => {});
}

async function dispatchProve(rec) {
  const raw = await vault.sessionKeyRaw();
  if (!raw) throw new Error('The wallet is locked. Unlock it to continue sending.');
  const s = await settingsStore.load();
  rec.status = 'proving';
  rec.provingStartedAt ??= Date.now();
  await saveSend(rec);
  await toOffscreen({
    type: 'prove', sendId: rec.id, count: rec.jobCount, labels: rec.view?.job_labels,
    workers: s.workers, key: Array.from(raw), lowMemory: s.lowMemoryProving || 'auto',
  });
}

async function dispatchSubmit(rec) {
  const raw = await vault.sessionKeyRaw();
  if (!raw) throw new Error('The wallet is locked. Unlock it to continue sending.');
  rec.status = 'submitting';
  await saveSend(rec);
  await toOffscreen({ type: 'submit', sendId: rec.id, key: Array.from(raw) });
}

/** The offscreen page wrote a submit result to `kv/submit:<id>`. */
function onSubmitted(id) {
  return guarded(id, () => handleSubmitted(id)).then((next) => {
    if (next === 'rebuild') return runSend(id);
  });
}

async function handleSubmitted(id) {
  {
    await wasm();
    const res = await db.get(db.STORES.kv, `submit:${id}`);
    let rec = await getSend(id);
    if (!res || !rec) return;
    if (['done', 'failed'].includes(rec.status) || (rec.status === 'cancelled' && !res.ok)) {
      await db.del(db.STORES.kv, `submit:${id}`);
      return;
    }
    const w = await openWallet();
    if (!w) return; // finished on unlock (resumeSends)
    const { key, wallet } = w;

    if (res.ok && !rec.prepared) {
      // Cancelled at the last moment, but the network already has it: the
      // coins are spent. Their state updates on the next sync.
      rec.status = 'done';
      rec.doneAt = Date.now();
      rec.note = 'cancel-too-late';
      await saveSend(rec);
      await db.del(db.STORES.kv, `submit:${id}`);
      return;
    }
    if (res.ok || res.uncertain || rec.broadcastUncertain) {
      const prepared = await vault.decrypt(key, rec.prepared);
      let height = rec.builtAtHeight;
      await exclusive(async () => {
        const snap = await latestSnapshot(key, rec.network);
        height = snap.height;
        if (!rec.broadcastRecorded || res.ok) {
          const next = wallet.recordBroadcast(snap.state, prepared);
          await saveSnapshot(key, snap.height, next, rec.network);
        }
      });
      rec.broadcastRecorded = true;
      const list = await readActivity(key, rec.network);
      const existing = list.find(e => e.txId === rec.view.tx_id);
      if (existing && res.ok) {
        existing.broadcastUncertain = false;
        if (existing.status !== 'confirmed') Object.assign(existing, {status: 'pending', atHeight: height});
        await writeActivity(key, list, rec.network);
      }
      if (!list.some((e) => e.txId === rec.view.tx_id)) {
        list.unshift({
          kind: 'sent', id: `t:${rec.view.tx_id}`, txId: rec.view.tx_id, status: 'pending',
          amount: rec.view.amount, fee: rec.view.fee, change: rec.view.change, to: rec.to,
          walletMode: rec.walletMode || 'standard', toKind: rec.toKind || null, note: rec.note || '', encryptedMessage: rec.toKind === 'private-app' ? rec.privateMessage || '' : null, at: Date.now(), atHeight: height, height: null, broadcastUncertain: !res.ok,
        });
        await writeActivity(key, list, rec.network);
      }
      notify('activity');
      if (!res.ok) {
        rec.status = 'uncertain';
        rec.broadcastUncertain = true;
        rec.error = 'The node may have received this payment. Retry resends the same transaction. New payments stay blocked until its outcome is known.';
        await saveSend(rec);
        await db.del(db.STORES.kv, `submit:${id}`);
        // Keep the exact prepared transaction and its proofs for safe rebroadcast.
        return;
      }
      rec.broadcastUncertain = false;
      rec.error = null;
      const total = plus(rec.view.amount, rec.view.fee);
      const change = amt(rec.view.change || '0');
      pushNotice(toUnits(change) > 0n ? 'sentChange' : 'sent', { n: total, c: change });
      rec.status = 'done';
      rec.doneAt = Date.now();
      delete rec.prepared;
      await saveSend(rec);
      await db.del(db.STORES.kv, `submit:${id}`);
      await db.delPrefix(db.STORES.jobs, `${id}:`);
      await db.delPrefix(db.STORES.proofs, `${id}:`);
      await closeOffscreenIfIdle();
      return;
    }

    await db.del(db.STORES.kv, `submit:${id}`);
    if (light.isNotConfirmable(res.error || '') && rec.attempt < MAX_SEND_ATTEMPTS) {
      // A block arrived while proving. Rebuild with the same inputs.
      rec.attempt += 1;
      rec.status = 'rebuilding';
      await saveSend(rec);
      return 'rebuild';
    }
    rec = (await getSend(id)) || rec;
    await failSend(rec, res.error);
    return null;
  }
}

/** Pick up sends interrupted by a worker restart, a browser restart or a lock. */
async function resumeSends() {
  await migrateStorage();
  const network = await currentNetwork();
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await getSend(id);
    if (!rec || rec.network !== network || running.has(id)) continue;
    const stalled = Date.now() - (rec.updatedAt || rec.createdAt) > STALLED_MS;

    if (['starting', 'waiting-block'].includes(rec.status)) {
      await runSend(id);
    } else if (['preparing', 'rebuilding'].includes(rec.status) && stalled) {
      rec.status = rec.attempt > 1 ? 'rebuilding' : 'starting';
      await saveSend(rec);
      await runSend(id);
    } else if (rec.status === 'uncertain') {
      if (await db.get(db.STORES.kv, `submit:${id}`)) {
        await onSubmitted(id);
        continue;
      }
      const w = await openWallet();
      if (!w) continue;
      const entry = (await readActivity(w.key, network)).find(e => e.txId === rec.view?.tx_id);
      if (entry?.status === 'confirmed') {
        rec.status = 'done'; rec.doneAt = Date.now(); rec.error = null;
        delete rec.prepared;
        await saveSend(rec);
        await db.delPrefix(db.STORES.jobs, `${id}:`);
        await db.delPrefix(db.STORES.proofs, `${id}:`);
        await closeOffscreenIfIdle();
      }
    } else if (['proving', 'proved', 'submitting'].includes(rec.status)) {
      if (await db.get(db.STORES.kv, `submit:${id}`)) {
        await onSubmitted(id);
        continue;
      }
      if ((await offscreenBusyWith()) === id || !stalled) continue;
      await guarded(id, async () => {
        try {
          let proofs = 0;
          let jobs = 0;
          for (let i = 0; i < (rec.jobCount || 0); i++) {
            if (await db.get(db.STORES.proofs, `${id}:${i}`)) proofs += 1;
            if (await db.get(db.STORES.jobs, `${id}:${i}`)) jobs += 1;
          }
          if (rec.prepared && proofs === rec.jobCount) await dispatchSubmit(rec);
          else if (rec.prepared && jobs === rec.jobCount && !rec.broadcastUncertain) await dispatchProve(rec);
          else {
            if(rec.broadcastUncertain)throw new Error('The original transaction proofs are unavailable. Its outcome still needs verification.');
            rec.status = 'starting';
            await saveSend(rec);
          }
        } catch (e) {
          if(rec.broadcastUncertain) {
            rec.status='uncertain';
            await saveSend(rec);
          } else await failSend(rec, e);
        }
      });
      if (rec.status === 'starting') await runSend(id);
    }
  }
}

async function latestSend(network) {
  const profile=activeMode(await settingsStore.load());
  let latest = null;
  for (const id of await db.keys(db.STORES.sends)) {
    const rec = await getSend(id);
    if (rec?.network !== network || (rec.walletMode || 'standard')!==profile) continue;
    if (!latest || rec.createdAt > latest.createdAt) latest = rec;
  }
  return latest ? { ...latest, prepared: undefined, sealed: undefined } : null;
}

// ----------------------------------------------------------------- price ----

// NPT price for the optional local-currency line. CoinGecko learns only that
// someone asked for the NPT price, never an address or a balance.
const PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=neptune-cash,tether&vs_currencies=usd,eur,gbp&include_24hr_change=true';
const PRICE_TTL_MS = 5 * 60_000;
let priceCache = null;

async function fetchPrice() {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache;
  await rpc.assertRoute(PRICE_URL);
  const r = await fetch(PRICE_URL, { credentials: 'omit', cache: 'no-store', redirect:'error' });
  if (!r.ok) throw new Error(`price service answered ${r.status}`);
  const j = await r.json();
  const npt = j['neptune-cash'] || {};
  const tether = j.tether || {};
  if (!npt.usd) throw new Error('no NPT price available');
  priceCache = {
    at: Date.now(),
    usd: npt.usd,
    eur: npt.eur,
    gbp: npt.gbp,
    // NPT trades against USDT; USDT is close to, but not exactly, one dollar.
    usdt: tether.usd ? npt.usd / tether.usd : npt.usd,
    change24h: typeof npt.usd_24h_change === 'number' ? npt.usd_24h_change : null,
  };
  return priceCache;
}

// The NPT price over the last 7 days, for the chart behind the balance.
const HISTORY_TTL_MS = 30 * 60_000;
let historyCache = null;
async function fetchPriceHistory(cur) {
  const vs = cur === 'eur' ? 'eur' : cur === 'gbp' ? 'gbp' : 'usd';
  if (historyCache && historyCache.vs === vs && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache;
  const url = `https://api.coingecko.com/api/v3/coins/neptune-cash/market_chart?vs_currency=${vs}&days=7`;
  await rpc.assertRoute(url);
  const r = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect:'error' });
  if (!r.ok) throw new Error(`price service answered ${r.status}`);
  const j = await r.json();
  const raw = (j.prices || []).filter((p) => Array.isArray(p) && Number.isFinite(p[1]));
  if (raw.length < 2) throw new Error('no price history');
  // About 64 points is plenty for a small chart.
  const step = Math.max(1, Math.floor(raw.length / 64));
  const points = raw.filter((_, i) => i % step === 0 || i === raw.length - 1).map(([t, p]) => [t, p]);
  historyCache = { at: Date.now(), vs, points };
  return historyCache;
}

// ------------------------------------------------------------- commands ----

async function bumpAutoLock() {
  const s = await settingsStore.load();
  await chrome.alarms.create('autolock', { delayInMinutes: Number(s.autoLockMinutes) || 15 });
}

async function requireWallet() {
  await migrateStorage();
  const w = await openWallet();
  if (!w) throw new Error('locked');
  await bumpAutoLock();
  return w;
}

async function actionSelection(args = {}) {
  const w = await requireWallet();
  const selected = { ...w, profile: activeMode(w.s), network: w.s.network };
  if ((args.walletMode && args.walletMode !== selected.profile) || (args.networkContext && args.networkContext !== selected.network)) {
    throw new Error('The selected wallet changed. Open this page again.');
  }
  return selected;
}

function assertSameSelection(current, selected) {
  if(current.wallet!==selected.wallet || current.s.network!==selected.network || activeMode(current.s)!==selected.profile) {
    throw new Error('The selected wallet changed. Open this page again.');
  }
}

function paymentCode(text) {
  if(typeof text!=='string'||text.length>65536)throw new Error('Payment code exceeds the 64 KiB limit.');
  const code=text.trim();
  if(!code)throw new Error('Enter a payment code.');
  return code;
}

/** Start height for a restore: a block height, a date, or the tip. */
async function startHeight(server, { birthday, birthdayDate }) {
  if (birthday !== undefined && birthday !== null && birthday !== '') {
    const b = Number(birthday);
    if (!Number.isSafeInteger(b) || b < 0) throw new Error('Not a block height');
    return b <= 1 ? 0 : b; // from the very beginning: the genesis block
  }
  if (birthdayDate) return heightAtDate(server, Number(birthdayDate));
  return fetchHeight(server);
}

/** Include the chosen node in the proxy rules BEFORE any recovery request. */
async function configureRecoveryNode(s, network, url) {
  const saved=await settingsStore.save({servers:{...s.servers,[network]:{sync:url,broadcast:url}}});
  if(saved.tor) {
    if(!(await torState()).required)await setTorState({state:'connecting',port:Number(saved.torPort)||9150});
    await applyTor({check:false});
  }
  return saved;
}

// ------------------------------------------------------------ contacts ----

async function readContacts(key, network) {
  const n = network || (await currentNetwork());
  const box = await db.get(db.STORES.kv, `contacts:${n}`);
  return box ? JSON.parse(dec.decode(await vault.decrypt(key, box))) : [];
}

async function writeContacts(key, list, network) {
  const n = network || (await currentNetwork());
  await db.put(db.STORES.kv, `contacts:${n}`, await vault.encrypt(key, enc.encode(JSON.stringify(list))));
}

/** Seal send records written in plain text by versions before 0.6. */
async function sealOldSends() {
  if (!(await vault.sessionKey())) return;
  for (const id of await db.keys(db.STORES.sends)) {
    const raw = await db.get(db.STORES.sends, id);
    if (raw && !raw.sealed && SEALED_FIELDS.some((f) => f in raw)) await saveSend(raw);
  }
}

function receivingAddress(wallet, settings, state, activity, kind, profile=activeMode(settings)) {
  if(profile==='encrypted') requirePrivateNotifications(settings);
  kind=addressKind(kind || settings.addressKind);
  return wallet.profileReceiveAddress(state,profile,kind);
}
function profileState(wallet,state,profile){return wallet.profileState(state,profile);}

const commands = {
  async createSubwallet({ mode }) {
    const { s }=await requireWallet();
    if(!['refresh','encrypted'].includes(mode)) throw new Error('Choose Auto-refresh or Encrypted.');
    if(mode==='encrypted' && s.network==='main') throw new Error('Encrypted notifications are experimental and disabled on mainnet.');
    if(s.createdWallets?.[mode]) throw new Error('This sub-wallet already exists. Open it from Sub-wallets.');
    return settingsStore.save({createdWallets:{...s.createdWallets,standard:true,[mode]:true},activeMode:mode,...(mode==='refresh'?{autoRefresh:true}:{privateNotifications:true})});
  },
  async selectMode({ mode }) {
    const { s } = await requireWallet();
    if (!['standard','refresh','encrypted'].includes(mode)) throw new Error('Unknown sub-wallet.');
    if (mode !== 'standard' && !s.createdWallets?.[mode]) throw new Error('Create this sub-wallet first.');
    if (mode === 'encrypted') requirePrivateNotifications(s);
    if (mode === 'refresh' && s.autoRefresh !== true) throw new Error('Enable Auto-refresh first.');
    return settingsStore.save({ activeMode: mode });
  },
  async exportRecovery({ password }) {
    const {s,wallet}=await requireWallet();
    if(activeMode(s)!=='encrypted')throw new Error('The encrypted recovery file is only available in the Encrypted sub-wallet.');
    requirePrivateNotifications(s);
    const phrase = await vault.checkPassword(String(password || ''));
    const file=await encryptRecoveryFile(phrase,String(password||''));
    const current=await requireWallet();
    if(current.wallet!==wallet||activeMode(current.s)!=='encrypted')throw new Error('The wallet changed or locked before the backup finished.');
    return file;
  },
  async state() {
    await migrateStorage();
    const s = await settingsStore.load();
    return {
      exists: await vault.exists(),
      unlocked: Boolean(await vault.sessionKey()),
      settings: s,
      tor: { ...(await torState()), hosts: torHosts(s) },
      status: await status(s.network),
      send: await latestSend(s.network),
      networks: Object.fromEntries(
        await Promise.all(settingsStore.NETWORKS.map(async (n) => [n, (await snapHeights(n)).length > 0])),
      ),
    };
  },

  async newPhrase() {
    await wasm();
    return light.phraseFromEntropy(crypto.getRandomValues(new Uint8Array(24)));
  },

  async checkPhrase({ phrase, network = 'main' }) {
    await wasm();
    const w = new light.LightWallet(String(phrase).trim().toLowerCase().split(/\s+/).join(' '), network);
    w.free?.();
    return true;
  },

  async create({ password, phrase, network, birthday, birthdayDate, restoreMode = 'private', nodeUrl }) {
    const effectiveRestoreMode = notificationRestoreMode(network, restoreMode);
    if (!password || password.length < 10) throw new Error('Use a password of at least 10 characters');
    await wasm();
    const clean = String(phrase).trim().toLowerCase().split(/\s+/).join(' ');
    const wallet = new light.LightWallet(clean, network); // validates the phrase
    let prev = await settingsStore.load();
    const restoring = (birthday !== undefined && birthday !== null && birthday !== '') || Boolean(birthdayDate);
    if (restoring && restoreMode === 'node') {
      // Fast and private: the user's own node does the lookups and keeps
      // serving this network afterwards.
      const url = rpc.normalizeServer(nodeUrl || 'http://127.0.0.1:9797/');
      prev = await configureRecoveryNode(prev,network,url);
    }
    const server = settingsStore.serversFor(prev, network).sync;
    if (!server) throw new Error(`Add a ${network} server in Settings > Servers first.`);
    // New wallet: start at the tip. Restore: start at the birthday (height or date).
    const start = await startHeight(server, { birthday, birthdayDate });
    const state = await initialState(wallet, server, start);
    wallet.free?.();
    dropWallet();
    // The spend index and the archive are public chain data, not the wallet's: keep them.
    await db.wipeExcept(['spends:', 'arch:']);
    dropArchive();
    await chrome.storage.session.clear();
    // The start height is not kept in plain settings: it would date the wallet.
    await settingsStore.save({ ...prev, network, birthday: null, activeMode: 'standard', privateNotifications: false, autoRefresh: false, createdWallets:{standard:true,refresh:false,encrypted:false}, freshAddresses: false, rotateOnLeak: false });
    const key = await vault.create(password, clean);
    await saveSnapshot(key, start, state, network);
    const fastPending = restoring && ['fast', 'node'].includes(effectiveRestoreMode) ? effectiveRestoreMode : null;
    await setStatus({ height: start, startHeight: start, recoveryStart:start, recoveryMode:effectiveRestoreMode, restored: restoring, syncing: true, fastPending }, network);
    await bumpAutoLock();
    notify('walletChanged');
    syncOnce().catch(() => {});
    return { start };
  },

  async unlock({ password }) {
    if (!password) throw new Error('Enter your password');
    if (!(await vault.exists())) throw new Error('No wallet on this device. Create or restore one.');
    await vault.unlock(password);
    await bumpAutoLock();
    sealOldSends().catch(() => {});
    syncOnce().catch(() => {}).finally(() => resumeSends().catch(() => {}));
    return true;
  },

  async lock() {
    // Stop fetches before freeing the WASM wallet used by the current run.
    return exclusiveNow(async () => {
      await vault.lock(); dropWallet(); notify('locked'); return true;
    });
  },

  /** Everything the home screen shows, from one decrypted state. */
  async home() {
    const { key, wallet, s } = await requireWallet();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    // Seed restoration discovers funded optional sub-wallets without a settings backup.
    const found={...s.createdWallets,standard:true};let discovered=false;
    for(const profile of ['refresh','encrypted']) {
      if(!found[profile] && (profile!=='encrypted'||s.network!=='main')) {
        const summary=wallet.summary(profileState(wallet,snap.state,profile),Date.now());
        if(summary.utxos.length) {found[profile]=true;discovered=true;}
      }
    }
    if(discovered) Object.assign(s,await settingsStore.save({createdWallets:found,...(found.refresh?{autoRefresh:true}:{}),...(found.encrypted?{privateNotifications:true}:{})}));
    const [activity, contacts, privacy] = await Promise.all([
      readActivity(key),
      readContacts(key),
      commands.privacy().catch(() => null),
    ]);
    return {
      walletSettings:{activeMode:activeMode(s),createdWallets:s.createdWallets,autoRefresh:s.autoRefresh,privateNotifications:s.privateNotifications},
      createdWallets:s.createdWallets,
      profile: activeMode(s),
      allActivity: activity,
      summary: wallet.summary(profileState(wallet,snap.state,activeMode(s)), Date.now()),
      addresses: Object.fromEntries(['generation','ec-hybrid'].map(kind=>[kind,receivingAddress(wallet,s,snap.state,activity,kind).address])),
      activity: activityForMode(activity,activeMode(s)),
      contacts,
      privacy,
      watch: decorateWatch(wallet.watchList(snap.state, Date.now()), (await watchDataFor(key, wallet, snap)).prefs),
      height: snap.height,
    };
  },

  async summary() {
    const { key, wallet, s } = await requireWallet();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    return wallet.summary(profileState(wallet,snap.state,activeMode(s)), Date.now());
  },

  async privacy() {
    const { key, s, wallet } = await requireWallet();
    await wasm();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    let spends = null;
    if (s.exactPrivacy !== false) spends = await spendIndex(s.network, snap.height);
    const report = light.privacyReport(profileState(wallet,snap.state,activeMode(s)), Date.now(), spends ? new Float64Array(spends) : undefined);
    const st = await status();
    report.spendIndex = st.spendIndex || null;
    const srv = settingsStore.serversFor(s);
    let sameServer = true;
    let ownNode = false;
    try {
      const a = new URL(srv.sync).hostname;
      const b = new URL(srv.broadcast).hostname;
      sameServer = a === b;
      ownNode = ['localhost', '127.0.0.1'].includes(a) && ['localhost', '127.0.0.1'].includes(b);
    } catch {
      /* missing server: reported elsewhere */
    }
    const fast = await db.get(db.STORES.kv, `fastRestored:${s.network}`);
    let fastRestored = null;
    if (fast) {
      let host = '';
      try {
        host = new URL(fast.server).hostname;
      } catch {
        /* keep empty */
      }
      fastRestored = { host, own: fast.mode === 'node' || ['localhost', '127.0.0.1'].includes(host), at: fast.at };
    }
    return { ...report, sameServer: sameServer && !ownNode, ownNode, fastRestored, priceLookup: s.priceLookup !== false && s.currency !== 'off' };
  },

  async sync() {
    const s = await settingsStore.load();
    if (s.tor && !(await torState()).required) await applyTor();
    await syncOnce();
    resumeSends().catch(() => {});
    return status();
  },

  /** Fixed by default; optional rotation follows confirmed state. */
  async receive({ kind, index } = {}) {
    const { wallet, s, key } = await requireWallet();
    kind ||= s.addressKind || 'generation';
    const profile=kind==='private-app'?'encrypted':activeMode(s);
    if (kind === 'private-app') {requirePrivateNotifications(s);kind=s.addressKind || 'generation';}
    const snap = await latestSnapshot(key);
    const current=receivingAddress(wallet, s, snap?.state, await readActivity(key), kind,profile);
    if(index==null)return {...current,current:true};
    if(profile!=='refresh'||!Number.isInteger(index)||index<0||index>current.index)throw new Error('Unknown previous address.');
    return {kind,index,profile,current:index===current.index,address:wallet.profileAddressAt(profile,addressKind(kind),index)};
  },

  async addressHistory({kind='generation',offset=0}={}) {
    const {wallet,s,key}=await requireWallet();const snap=await latestSnapshot(key);
    if(!snap)throw new Error('NO_STATE');
    if(!Number.isInteger(offset)||offset<0||offset>0xffffffff)throw new Error('Invalid address-history page.');
    return wallet.profileAddressHistory(snap.state,activeMode(s),addressKind(kind),offset);
  },

  async qr({ text, dark = '#0b1220', bg = '#ffffff' }) {
    await wasm();
    return light.qrSvg(text, dark, bg);
  },

  async addressInfo({ text }) {
    await wasm();
    return light.addressInfo(String(text || ''), await currentNetwork());
  },

  async price() {
    const s = await settingsStore.load();
    if (s.priceLookup === false || s.currency === 'off') return null; // no request at all
    return fetchPrice();
  },

  async priceHistory() {
    const s = await settingsStore.load();
    if (s.priceLookup === false || s.currency === 'off' || s.network !== 'main') return null;
    return fetchPriceHistory(s.currency);
  },

  async testServer({ url }) {
    await wasm();
    return fetchHeight(rpc.normalizeServer(url));
  },

  /** What a server offers: its tip, its network, and the optional features
   *  the wallet can use (fast restore via the UTXO index). */
  async serverInfo({ url }) {
    const server = rpc.normalizeServer(url);
    const height = await fetchHeight(server);
    const probe = async (method, params) => {
      try {
        const text = await rpc.post(server, JSON.stringify({ jsonrpc: '2.0', id: rpc.id(), method, params }), { timeoutMs: 15_000 });
        return JSON.parse(text).result ?? null;
      } catch {
        return undefined;
      }
    };
    const net = await probe('node_network', []);
    const flags = await probe('utxoindex_blockHeightsByFlags', [[]]);
    let host = '';
    try {
      host = new URL(server).hostname;
    } catch {
      /* keep empty */
    }
    return {
      height,
      network: typeof net?.network === 'string' ? net.network : null,
      own: ['localhost', '127.0.0.1'].includes(host),
      fastRestore: flags !== undefined,
      // neptune-core has no endpoint yet for proving help (a proof collection
      // without chunk data, or lock-script-only proving); every send is a
      // full proof collection made in the browser.
      proving: 'full',
    };
  },

  async proofReport() {
    return (await db.get(db.STORES.kv, 'proofReport')) || null;
  },

  async maxSendable({ fee, fromKind = 'any' }) {
    const { key, wallet } = await requireWallet();
    const snap = await latestSnapshot(key);
    return wallet.maxSendable(profileState(wallet,snap.state,activeMode((await settingsStore.load()))), fee, Date.now(), fromKind);
  },

  async send(req) {
    const { s } = await requireWallet();
    await wasm();
    const info = light.addressInfo(String(req.to || ''), await currentNetwork());
    if (!info.valid) throw new Error(info.error || 'Not a valid address');
    validatePrivateSend(s, info, req.notificationMode || 'auto', String(req.privateMessage || ''));
    const profile=activeMode(s);
    if(req.walletMode && req.walletMode!==profile) throw new Error('Sub-wallet changed. Review this payment again.');
    if(profile==='encrypted' && info.kind!=='private-app') throw new Error('The Encrypted sub-wallet requires an encrypted receiving address.');
    return startSend({ ...req, walletMode:profile, toKind: info.kind, networkContext:s.network });
  },

  async retrySend({ id }) {
    const {s}=await requireWallet();
    const rec = await getSend(id);
    if (!rec) throw new Error('Payment not found');
    if(rec.network!==s.network||(rec.walletMode||'standard')!==activeMode(s))throw new Error('Select the payment’s sub-wallet and network before retrying.');
    if(rec.status==='uncertain') {
      if((await offscreenBusyWith())===id)throw new Error('The original transaction is still being uploaded. Wait for its response.');
      await guarded(id,()=>dispatchSubmit(rec));
      return id;
    }
    if(rec.status!=='failed')throw new Error('Only a failed payment can be started again.');
    return commands.send({ to: rec.to, amount: rec.amount, fee: rec.fee, fromKind: rec.fromKind, privateMessage: rec.privateMessage || '', notificationMode: rec.notificationMode || 'auto', walletMode:rec.walletMode || 'standard', waitForFreshBlock: false });
  },

  async cancelSend({ id }) {
    await cancelSend(id);
    return true;
  },

  async testNotice() {
    await pushNotice('test');
    return true;
  },

  async contacts() {
    const { key } = await requireWallet();
    return readContacts(key);
  },

  async saveContact({ id, name, address, addresses }) {
    return exclusiveNow(async () => {
      const { key, s } = await requireWallet();
      await wasm();
      const label = String(name || '').trim().slice(0, 40);
      if (!label) throw new Error('NAME_REQUIRED');
      const inputs = Array.isArray(addresses) ? addresses : [address];
      const clean = inputs.map((a) => String(typeof a === 'object' ? a.address : a || '').trim().toLowerCase()).filter(Boolean);
      if (!clean.length || clean.length > 2 || new Set(clean).size !== clean.length) throw new Error('Enter one or two different addresses');
      const entries = clean.map((address) => {
        const info = light.addressInfo(address, s.network);
        if (!info.valid) throw new Error(info.error || 'Not a valid address');
        return { address, kind: info.kind };
      });
      if (entries.length === 2 && (new Set(entries.map((a) => a.kind)).size !== 2 || entries.some((a) => !['generation', 'ec-hybrid'].includes(a.kind)))) {
        throw new Error('Use one Generation address and one EC Hybrid address');
      }
      const list = await readContacts(key, s.network);
      if (list.some((c) => c.id !== id && contactAddresses(c).some((a) => clean.includes(a.address)))) throw new Error('DUPLICATE');
      const existing = list.find((c) => c.id === id);
      const values = { name: label, addresses: entries, address: entries[0].address, kind: entries[0].kind, updatedAt: Date.now() };
      if (existing) Object.assign(existing, values);
      else list.push({ id: crypto.randomUUID(), ...values, createdAt: Date.now() });
      list.sort((a, b) => a.name.localeCompare(b.name));
      await writeContacts(key, list, s.network);
      notify('contacts');
      return list;
    });
  },

  async deleteContact({ id }) {
    return exclusiveNow(async () => {
      const { key, s } = await requireWallet();
      const list = (await readContacts(key, s.network)).filter((c) => c.id !== id);
      await writeContacts(key, list, s.network);
      notify('contacts');
      return list;
    });
  },

  async setNote({ id, note }) {
    const { key } = await requireWallet();
    const list = await readActivity(key);
    const e = list.find((x) => x.id === id);
    if (!e) throw new Error('Payment not found');
    e.note = String(note || '').slice(0, 200);
    await writeActivity(key, list);
    return e;
  },

  async dismissSend({ id }) {
    const rec = await getSend(id);
    if (rec && ['failed', 'done', 'needs-lustration'].includes(rec.status)) {
      rec.status = rec.status === 'needs-lustration' ? 'failed' : rec.status;
      rec.dismissed = true;
      await saveSend(rec);
      await db.delPrefix(db.STORES.jobs, `${id}:`);
      await db.delPrefix(db.STORES.proofs, `${id}:`);
    }
    return true;
  },

  async latestSend() {
    return latestSend(await currentNetwork());
  },

  async acceptLustrationAndRetry({ id }) {
    const rec = await getSend(id);
    rec.acceptLustration = true;
    rec.status = 'starting';
    rec.error = null;
    await saveSend(rec);
    runSend(id).catch(() => {});
    return true;
  },

  async activity() {
    const { key } = await requireWallet();
    return activityForMode(await readActivity(key),activeMode((await settingsStore.load())));
  },

  async saveSettings(patch) {
    const clean = { ...patch };
    if (clean.privateNotifications === true && (await settingsStore.load()).network === 'main') {
      throw new Error('Private app notifications are experimental and disabled on mainnet.');
    }
    if (clean.servers) {
      const prev = await settingsStore.load();
      const servers = { ...prev.servers };
      for (const [n, v] of Object.entries(clean.servers)) {
        servers[n] = {
          sync: v.sync ? rpc.normalizeServer(v.sync) : '',
          broadcast: v.broadcast ? rpc.normalizeServer(v.broadcast) : v.sync ? rpc.normalizeServer(v.sync) : '',
        };
      }
      clean.servers = servers;
    }
    delete clean.network; // use switchNetwork
    delete clean.activeMode; // use selectMode
    delete clean.createdWallets; // use createSubwallet
    if (clean.privateNotifications === false && (await settingsStore.load()).activeMode === 'encrypted') clean.activeMode = 'standard';
    if (clean.tor === true) { rpc.interrupt(); await setTorState({ state: 'connecting', port: Number(clean.torPort) || 9150 }); }
    if (clean.autoRefresh === false && (await settingsStore.load()).activeMode === 'refresh') clean.activeMode = 'standard';
    const saved = await settingsStore.save(clean);
    // Servers or Tor changed: the proxy script must name the right hosts.
    if ('tor' in clean || 'torPort' in clean || clean.servers) await applyTor({ check: 'tor' in clean || 'torPort' in clean }).catch(() => {});
    return saved;
  },

  async torStatus() {
    const s = await settingsStore.load();
    return { ...(await torState()), hosts: torHosts(s) };
  },

  async checkTor() {
    const s = await settingsStore.load();
    return { ...(await applyTor()), hosts: torHosts(s) };
  },

  async switchNetwork({ network }) {
    if (!settingsStore.NETWORKS.includes(network)) throw new Error('Unknown network');
    await migrateStorage();
    const s = await settingsStore.load();
    if (network === s.network) return { network };
    const server = settingsStore.serversFor(s, network).sync;
    if (!server) throw new Error('NEED_SERVER');
    const key = await vault.sessionKey();
    if (!key) throw new Error('locked');
    return exclusiveNow(async () => {
      await wasm();
      if (!(await snapHeights(network)).length) {
        // First visit to this network: start at its tip.
        const phrase = await vault.phrase(key);
        const w = new light.LightWallet(phrase, network);
        try {
          const tip = await fetchHeight(server);
          await saveSnapshot(key, tip, await initialState(w, server, tip), network);
          await setStatus({ height: tip, tip, startHeight: tip, lastTipChangeAt: Date.now() }, network);
        } finally {
          w.free?.();
        }
      }
      await settingsStore.save({ network });
      dropWallet();
      syncOnce().catch(() => {});
      return { network };
    });
  },

  /** Scan again from an earlier point: finds payments a restore without a date missed. */
  async rescan({ birthday = 0, birthdayDate, mode = 'private', nodeUrl, walletMode, networkContext, encryptedOnly = false, rememberMode = true } = {}) {
    const { key, wallet, s } = await requireWallet();
    mode = notificationRestoreMode(s.network, mode);
    const network=s.network, profile=activeMode(s);
    if(networkContext&&networkContext!==network)throw new Error('The selected network changed. Open recovery again.');
    if (walletMode && walletMode !== activeMode(s)) throw new Error('The selected sub-wallet changed. Open recovery again.');
    if (encryptedOnly && activeMode(s) !== 'encrypted') throw new Error('Encrypted receipt recovery is only available in the Encrypted sub-wallet.');
    if (encryptedOnly) requirePrivateNotifications(s);
    const server = mode === 'node' ? rpc.normalizeServer(String(nodeUrl || 'http://127.0.0.1:9797/')) : settingsStore.serversFor(s).sync;
    if (!server) throw new Error('NEED_SERVER');
    let start;
    await exclusiveNow(async () => {
      const current=await requireWallet();
      if(current.wallet!==wallet || current.s.network!==network || activeMode(current.s)!==profile)throw new Error('The selected wallet changed. Open recovery again.');
      const old = await latestSnapshot(key);
      if(await activeSend(network) || (old && wallet.summary(old.state,Date.now()).utxos.some(u=>u.reserved&&u.spent_height==null)))throw new Error('A payment is still pending. Wait for confirmation, expiry, or cancel it before starting recovery.');
      if(mode==='node')await configureRecoveryNode(current.s,network,server);
      start=await startHeight(server,{birthday:birthdayDate?undefined:birthday,birthdayDate});
      if(mode==='private' && old) {
        // A later requested height must not hide receipts we already know.
        const known=wallet.summary(old.state,Date.now()).utxos.map(u=>u.received_height).filter(h=>Number.isSafeInteger(h)&&h>=0);
        if(wallet.expectedList(old.state).length)start=0;
        else if(known.length)start=Math.min(start,Math.max(0,known.reduce((min,h)=>Math.min(min,h),Infinity)-1));
      }
      const indexed = ['fast','node'].includes(mode);
      let state = indexed && old ? old.state : await initialState(wallet, server, start);
      // Waiting coins and watch-only addresses survive the new scan.
      if (old && !indexed) state = wallet.rescanState(old.state, state);
      if (!indexed || !old) {
        await dropSnapshots(s.network);
        await saveSnapshot(key, start, state);
      }
      const fastPending = indexed ? mode : null;
      if(rememberMode)await settingsStore.save({recoveryModes:{...current.s.recoveryModes,[profile]:mode}});
      await setStatus({ height: indexed && old ? old.height : start, startHeight:start, recoveryStart:start, syncing: true, error: null, restored: true, recoveryMode:mode, recoveryWallet:activeMode(s), fastPending, fastPhase:null, fastFailed:null });
    });
    syncOnce().catch(() => {});
    return { start, mode, walletMode:activeMode(s) };
  },

  async heightForDate({ date }) {
    const s = await settingsStore.load();
    return heightAtDate(settingsStore.serversFor(s).sync, Number(date));
  },

  // ------------------------------------------------------- watch-only --

  async watchList() {
    const { key, wallet } = await requireWallet();
    const snap = await latestSnapshot(key);
    if (!snap) throw new Error('NO_STATE');
    const st = await status();
    return { list: decorateWatch(wallet.watchList(snap.state, Date.now()), (await watchDataFor(key, wallet, snap)).prefs), height: snap.height, behind: st.watchBehind || null, fast: st.watchFast || null, error: st.watchError || null };
  },

  /** Add one independent watch entry and persist it before starting its scan. */
  async watchAdd({ label, viewingKey, spendKey, from, mode = 'private', nodeUrl, contactId, jobId }) {
    if (!['private', 'fast', 'node'].includes(mode)) throw new Error('Unknown scan mode');
    const server = mode === 'node' ? rpc.normalizeServer(String(nodeUrl || '')) : undefined;
    if (server) {
      const s = await settingsStore.load();
      await settingsStore.save({ watchNodes: [...new Set([...(s.watchNodes || []), server])] });
      if (s.tor) await applyTor({ check: false });
    }
    await withState(async ({ key, wallet, s, snap }) => {
      let fromHeight = from === 'now' ? snap.height + 1 : from === 'start' || !from ? 1 : Number(from);
      if (!Number.isSafeInteger(fromHeight) || fromHeight < 1) throw new Error('Not a block height');
      const data = await watchDataFor(key, wallet, snap, s.network);
      const id = data.nextId;
      const record = { id, label: String(label || '').trim().slice(0, 40), viewingKey: String(viewingKey || '').trim().toLowerCase(),
        spendKey: String(spendKey || '').trim() || null, fromHeight };
      const records = [...data.records, record];
      const state = wallet.watchReconcile(snap.state, JSON.stringify(records));
      cancelled(jobId);
      data.records = records; data.nextId++;
      data.prefs[id] = { mode, server, contactId: contactId || null, paused: false, hidden: false };
      await writeWatchData(key, data, s.network);
      await setStatus({ watchBehind: { at: Math.min(fromHeight - 1, snap.height), end: snap.height }, watchError: null });
      return { state, out: id };
    }, jobId);
    notify('watch'); scheduleFollowUp();
    return true;
  },

  async watchUpdate({ id, paused, hidden, label }) {
    await withState(async ({ key, wallet, s, snap }) => {
      const data = await watchDataFor(key, wallet, snap, s.network);
      const record = data.records.find((a) => a.id === Number(id));
      if (!record) throw new Error('Watch address no longer exists');
      const pref = data.prefs[id] ||= { mode: 'private' };
      if (typeof paused === 'boolean') pref.paused = paused;
      if (typeof hidden === 'boolean') pref.hidden = hidden;
      if (typeof label === 'string') record.label = label.trim().slice(0, 40);
      const state = wallet.watchReconcile(snap.state, JSON.stringify(data.records));
      await writeWatchData(key, data, s.network);
      await setStatus({ watchBehind: { at: 0, end: snap.height }, watchError: null });
      return { state };
    });
    notify('watch'); scheduleFollowUp();
    return true;
  },

  async watchRemove({ id }) {
    await withState(async ({ key, wallet, s, snap }) => {
      const data = await watchDataFor(key, wallet, snap, s.network);
      data.records = data.records.filter((a) => a.id !== Number(id));
      delete data.prefs[id];
      await writeWatchData(key, data, s.network);
      await db.del(db.STORES.kv, fastWatchKey(s.network, id));
      return { state: wallet.watchReconcile(snap.state, JSON.stringify(data.records)) };
    });
    notify('watch'); scheduleFollowUp();
    return true;
  },

  /** This wallet's viewing keys (and spend keys), after the password. */
  async viewingKeys({ password }) {
    const initial=await requireWallet();
    const initialMode=activeMode(initial.s);
    try {
      await vault.checkPassword(password);
    } catch {
      throw new Error('Wrong password');
    }
    const { key, wallet, s } = await requireWallet();
    if(wallet!==initial.wallet||activeMode(s)!==initialMode)throw new Error('The selected wallet changed before export completed.');
    if(activeMode(s)==='encrypted')throw new Error('Encrypted receipt viewing-key export is not supported. Ordinary viewing keys cannot follow encrypted envelopes.');
    const snap=await latestSnapshot(key);
    if(!snap)throw new Error('NO_STATE');
    const current=await requireWallet();
    if(current.wallet!==wallet||activeMode(current.s)!==initialMode)throw new Error('The wallet changed or locked before export completed.');
    return wallet.viewingKeys(snap.state,activeMode(s));
  },

  // ------------------------------------------------- registered coins --

  async claimCheck(args) {
    const text=paymentCode(args.text), selected=await actionSelection(args);
    const { key, wallet }=selected;
    const snap = await latestSnapshot(key,selected.network);
    if (!snap) throw new Error('NO_STATE');
    assertSameSelection(await requireWallet(),selected);
    return wallet.claimDecode(snap.state, text, selected.profile);
  },

  async claimRegister(args) {
    const text=paymentCode(args.text), selected=await actionSelection(args);
    const claim = await withState(async ({ wallet, snap, s }) => {
      assertSameSelection({wallet,s},selected);
      const out = wallet.claimRegister(snap.state, text, selected.profile);
      return { state: out.state, out: out.claim };
    }, args.jobId);
    if (selected.s.localArchive) await setStatus({ adoptPending: true },selected.network);
    syncOnce().catch(() => {});
    return claim;
  },

  async claimRemove(args) {
    const selected=await actionSelection(args),record=String(args.record||'');
    await withState(async ({ wallet, snap, s }) => {
      assertSameSelection({wallet,s},selected);
      if(!wallet.expectedList(profileState(wallet,snap.state,activeMode(s))).some(c=>c.addition_record===String(record)))throw new Error('No waiting payment with this code in the selected sub-wallet.');
      return {state:wallet.claimRemove(snap.state,String(record))};
    });
    return true;
  },

  async waiting(args = {}) {
    const selected=await actionSelection(args),{ key, wallet, s }=selected;
    const snap = await latestSnapshot(key,selected.network);
    if (!snap) throw new Error('NO_STATE');
    const st = await status(selected.network);
    assertSameSelection(await requireWallet(),selected);
    const lastAdopted=st.lastAdopted?{...st.lastAdopted,list:(st.lastAdopted.list||[]).filter(c=>(c.wallet_mode||'standard')===selected.profile)}:null;
    return { profile:selected.profile, list: wallet.expectedList(profileState(wallet,snap.state,selected.profile)), archive: s.localArchive ? st.archive || { state: 'building' } : null, lastAdopted };
  },

  /**
   * Look for this wallet's premine allocations, one key at a time (with
   * progress), then register what was found. The archive (or a scan from
   * genesis) then adds them.
   */
  async findPremine(args) {
    const selected=await actionSelection(args), {wallet,s}=selected, {jobId}=args;
    if(selected.profile!=='standard')throw new Error('Premine allocations belong to the Standard sub-wallet.');
    jobProgress(jobId, { phase: 'genesis', done: 0, total: 10 });
    await sleep(0);
    const hits = [];
    for (let i = 0; i < 10; i++) {
      cancelled(jobId);
      assertSameSelection(await requireWallet(),selected);
      if (wallet.premineForKey(i) > 0) hits.push(i);
      jobProgress(jobId, { phase: 'keys', done: i + 1, total: 10 });
      await sleep(0); // let the progress message go out
    }
    if (!hits.length) return { found: 0, archive: Boolean(s.localArchive) };
    const found = await withState(async ({ wallet: w, snap, s:current }) => {
      assertSameSelection({wallet:w,s:current},selected);
      const out = w.registerPremine(snap.state, new Float64Array(hits));
      return { state: out.found ? out.state : null, out: out.found };
    }, jobId);
    if (found && s.localArchive) await setStatus({ adoptPending: true },selected.network);
    if (found) syncOnce().catch(() => {});
    return { found, archive: Boolean(s.localArchive) };
  },

  /** Stop a job that is still waiting (watch-only add, registration, premine). */
  async cancelJob({ jobId }) {
    if (!jobId) return false;
    cancelledJobs.add(jobId);
    setTimeout(() => cancelledJobs.delete(jobId), 120_000);
    return true;
  },

  // ---------------------------------------------------------- archive --

  async archiveStatus() {
    const s = await settingsStore.load();
    const st = await status();
    return { on: Boolean(s.localArchive), lag: ARCHIVE_LAG, walletHeight: st.height ?? null, estimate: await archiveEstimate(s).catch(() => null), ...(st.archive || {}) };
  },

  async archiveSet({ on }) {
    const s = await settingsStore.save({ localArchive: Boolean(on) });
    if (!on) {
      dropArchive();
      await db.delPrefix(db.STORES.kv, 'arch:');
      await setStatus({ archive: null, adoptPending: false });
    } else {
      await setStatus({ archive: { state: 'building', height: 0, target: null, at: Date.now() }, adoptPending: true });
      syncOnce().catch(() => {});
    }
    return { on: Boolean(s.localArchive) };
  },

  /** Rebuild every commitment from the stored leaves and chunks. */
  async archiveCheck() {
    const s = await settingsStore.load();
    if (!s.localArchive) throw new Error('The local archive is off');
    return keepAlive(() =>
      exclusiveNow(async () => {
        const a = await loadArchive(s.network);
        a.check();
        await setArchiveStatus({ checkedAt: Date.now(), checkedHeight: a.height() });
        return { ok: true, height: a.height(), size: a.sizeBytes() };
      }),
    );
  },

  async revealPhrase({ password }) {
    const {wallet}=await requireWallet();
    let phrase;
    try {
      phrase=await vault.checkPassword(password);
    } catch {
      throw new Error('Wrong password');
    }
    if((await requireWallet()).wallet!==wallet)throw new Error('The wallet changed before the recovery phrase was revealed.');
    return phrase;
  },

  async reset() {
    await vault.lock();
    dropWallet();
    dropArchive();
    const s = await settingsStore.load();
    await db.wipe();
    // Keep interface and server preferences; everything about the wallet goes.
    await settingsStore.save({ ...s, birthday: null, network: 'main' });
    await chrome.storage.session.clear();
    await closeOffscreenIfIdle().catch(() => {});
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return false;

  // From the offscreen page.
  if (msg.type === 'proveProgress') {
    getSend(msg.sendId).then((rec) => {
      if (!rec || rec.status !== 'proving') return;
      rec.jobsDone = msg.done;
      rec.lastJob = msg.label;
      return saveSend(rec);
    });
    return false;
  }
  if (msg.type === 'proved') {
    getSend(msg.sendId).then((rec) => {
      if (!rec || rec.status !== 'proving') return;
      rec.status = 'submitting';
      rec.jobsDone = rec.jobCount;
      return saveSend(rec);
    });
    return false;
  }
  if (msg.type === 'submitted') {
    onSubmitted(msg.sendId).catch(() => {});
    return false;
  }
  if (msg.type === 'proveFailed') {
    getSend(msg.sendId).then(async (rec) => {
      if (!rec || ['done', 'failed'].includes(rec.status)) return;
      await failSend(rec, `Proving failed: ${msg.error}. Try fewer proving workers in Settings > Advanced, or a payment that uses fewer coins.`);
    });
    return false;
  }

  // From the popup.
  const fn = commands[msg.cmd];
  if (!fn) {
    sendResponse({ ok: false, error: `unknown command ${msg.cmd}` });
    return false;
  }
  keepAlive(() => fn(msg.args || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// ---------------------------------------------------------------- alarms ----

// The wallet lives in Chrome's side panel: a click on the toolbar icon opens
// it next to the page. Setting up a wallet takes a full tab.
function panelOnClick() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}
panelOnClick();

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create('sync', { periodInMinutes: 1 });
  panelOnClick();
  if (details?.reason === 'install' && !(await vault.exists().catch(() => false))) {
    Promise.resolve(chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab') })).catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('sync', { periodInMinutes: 1 });
  // The proxy setting survives a restart; check Tor is still there.
  applyTor().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autolock') {
    await commands.lock();
    return;
  }
  if (alarm.name === 'sync') {
    if (!(await vault.sessionKey())) return;
    await maybeRecheckTor().catch(() => {});
    await syncOnce().catch(() => {});
    await resumeSends().catch(() => {});
  }
});
