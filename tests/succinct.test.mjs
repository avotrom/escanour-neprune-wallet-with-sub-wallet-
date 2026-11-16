import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as succinct from '../extension/lib/succinct.js';
import { readCapped, post } from '../extension/lib/rpc.js';

const A = 'a'.repeat(80);
const B = 'b'.repeat(80);
const report = (over = {}) => ({
  proven: true, height: 62_600, hash: 'tip', parent_hash: 'parent', activation_height: 62_500,
  activation_parent_hash: A, work_since_activation: '12345', tip_fully_validated: false, ...over,
});
const on = { localArchive: true, network: 'main', servers: { main: { sync: 'https://a.example/', fallback: 'https://b.example/' } } };

test('chain proof checking is part of Full node mode and off by default', () => {
  assert.equal(succinct.available(), true);
  assert.equal(succinct.enabled({}), false);
  assert.equal(succinct.enabled({ localArchive: 'yes' }), false);
  assert.equal(succinct.enabled({ succinct: true }), false);
  assert.equal(succinct.enabled(on), true);
});

test('tips are verified on Node A then Node B, never on the broadcast server', () => {
  assert.deepEqual(succinct.targets(on), ['https://a.example/', 'https://b.example/']);
  assert.deepEqual(succinct.targets({ network: 'main', servers: { main: { sync: 'https://a.example/', fallback: 'https://a.example/', broadcast: 'https://c.example/' } } }), ['https://a.example/']);
  assert.deepEqual(succinct.targets({ network: 'testnet', servers: {} }), []);
});

test('a built-in anchor wins; a pinned one must be a digest', () => {
  assert.deepEqual(succinct.anchorFor('main', null), { hash: '', source: 'none' });
  assert.equal(succinct.anchorFor('main', { hash: A, source: 'user' }).source, 'user');
  assert.equal(succinct.anchorFor('main', { hash: 'not-a-digest' }).source, 'none');
});

test('the first proven tip pins the anchor; agreeing nodes pin once', () => {
  const results = [{ url: 'a', ok: true, report: report() }, { url: 'b', ok: true, report: report({ hash: 'other' }) }];
  const d = succinct.decide(results, 0, { hash: '', source: 'none' });
  assert.deepEqual(d.pin, { hash: A, source: 'first-use' });
  assert.equal(d.best.hash, 'tip');
  assert.equal(d.conflict, false);
});

test('nodes that prove different histories pin nothing and follow nothing', () => {
  const results = [{ url: 'a', ok: true, report: report() }, { url: 'b', ok: true, report: report({ activation_parent_hash: B }) }];
  const d = succinct.decide(results, 0, { hash: '', source: 'none' });
  assert.equal(d.conflict, true);
  assert.equal(d.pin, null);
  assert.equal(d.best, null);
});

test('a known anchor is never re-pinned, and a chain below activation pins nothing', () => {
  const known = succinct.decide([{ url: 'a', ok: true, report: report() }], 0, { hash: A, source: 'user' });
  assert.equal(known.pin, null);
  assert.equal(known.best.hash, 'tip');
  const early = succinct.decide([{ url: 'a', ok: true, report: report({ proven: false, activation_parent_hash: '' }) }], 0, { hash: '', source: 'none' });
  assert.equal(early.pin, null);
  assert.equal(early.best.proven, false);
  const none = succinct.decide([{ url: 'a', ok: false, error: 'x' }], -1, { hash: '', source: 'none' });
  assert.equal(none.best, null);
});

test('status: only a wallet on the proven chain is shown as proven', () => {
  const record = { at: 1, results: [{ url: 'a', ok: true, report: report() }], best: report(), anchor: { hash: A } };
  assert.equal(succinct.provenState({ localArchive: false }, record, 'on-proven-chain').state, 'off');
  assert.equal(succinct.provenState(on, null, 'unknown').state, 'waiting');
  assert.equal(succinct.provenState(on, record, 'on-proven-chain').state, 'proven');
  assert.equal(succinct.provenState(on, record, 'not-comparable').state, 'syncing');
  assert.equal(succinct.provenState(on, record, 'unknown').state, 'syncing');
  assert.equal(succinct.provenState(on, record, 'diverged').state, 'diverged');
  assert.equal(succinct.provenState(on, { ...record, best: report({ proven: false }) }, 'unknown').state, 'inactive');
  assert.equal(succinct.provenState(on, { at: 1, results: [{ url: 'a', ok: false, error: 'boom' }], best: null }, 'unknown').error, 'boom');
  assert.equal(succinct.provenState(on, { ...record, best: null, conflict: true }, 'unknown').state, 'conflict');
});

test('the tip itself counts as proven only when it was validated in full', () => {
  const header = { at: 1, results: [], best: report() };
  const full = { at: 1, results: [], best: report({ tip_fully_validated: true }) };
  assert.equal(succinct.provenState(on, header, 'on-proven-chain').provenHeight, 62_599);
  assert.equal(succinct.provenState(on, full, 'on-proven-chain').provenHeight, 62_600);
});

test('sending stops on a diverged wallet or conflicting histories, and only then', () => {
  assert.equal(succinct.blocksSending({ state: 'diverged' }), true);
  assert.equal(succinct.blocksSending({ state: 'conflict' }), true);
  for (const state of ['off', 'waiting', 'inactive', 'proven', 'syncing', 'error']) assert.equal(succinct.blocksSending({ state }), false);
  assert.equal(succinct.blocksSending(undefined), false);
});

// ------------------------------------------------ response size ceiling ----

function streamOf(chunks, onCancel = () => {}) {
  let i = 0;
  return { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => onCancel() }) };
}

test('a node answer is dropped the moment it passes the ceiling', async () => {
  let cancelled = false;
  const big = { headers: { get: () => null }, body: streamOf([new Uint8Array(600), new Uint8Array(600), new Uint8Array(600)], () => { cancelled = true; }) };
  await assert.rejects(readCapped(big, 1000), /NODE_BAD_RESPONSE/);
  assert.equal(cancelled, true);
  // A declared length over the ceiling is refused before a byte is read.
  let read = false;
  const declared = { headers: { get: () => '5000' }, body: { getReader: () => { read = true; return {}; } } };
  await assert.rejects(readCapped(declared, 1000), /NODE_BAD_RESPONSE/);
  assert.equal(read, false);
});

test('an answer under the ceiling arrives intact, multi-byte characters included', async () => {
  const bytes = new TextEncoder().encode('{"result":"é✓"}');
  const res = { headers: { get: () => null }, body: streamOf([bytes.slice(0, 12), bytes.slice(12)]) };
  assert.equal(await readCapped(res, 1000), '{"result":"é✓"}');
  assert.equal(await readCapped({ text: async () => 'plain' }, 1000), 'plain');
  await assert.rejects(readCapped({ text: async () => 'x'.repeat(50) }, 10), /NODE_BAD_RESPONSE/);
});

// ----------------------------------- Tor: the offscreen page fails closed --

// db.js opens its database once per process, so the stand-in reads this.
const stored = { tor: false };
async function withOffscreenChrome(reply, tor, fn) {
  stored.tor = tor;
  // An offscreen document sees chrome.runtime and nothing else.
  const asked = [];
  const saved = { chrome: globalThis.chrome, fetch: globalThis.fetch, indexedDB: globalThis.indexedDB };
  globalThis.chrome = { runtime: { sendMessage: async (m) => { asked.push(m); if (reply instanceof Error) throw reply; return reply; } } };
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"result":1}' }; };
  // settings.load() reads IndexedDB; a one-key stand-in is enough.
  const reqOf = (value) => { const r = {}; queueMicrotask(() => { r.result = value; r.onsuccess?.({ target: r }); }); return r; };
  const store = { get: (k) => reqOf(k === 'settings' ? { tor: stored.tor } : undefined), put: () => reqOf(undefined) };
  const database = { objectStoreNames: { contains: () => true }, createObjectStore: () => {}, transaction: () => { const t = { objectStore: () => store }; setTimeout(() => t.oncomplete?.(), 0); return t; } };
  globalThis.indexedDB = { open: () => reqOf(database) };
  try {
    await fn({ asked, fetched: () => fetched });
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('offscreen requests ask the service worker for the route and stop on a refusal', async () => {
  await withOffscreenChrome({ ok: false, error: 'Tor is not connected. Check Tor settings before retrying.' }, true, async ({ asked, fetched }) => {
    await assert.rejects(post('https://node.example/', '{}'), /Tor is not connected/);
    assert.equal(fetched(), 0, 'nothing may leave the browser');
    assert.equal(asked[0].cmd, 'assertRoute');
    assert.equal(asked[0].target, 'background');
  });
});

test('offscreen requests go out once the service worker confirms the route', async () => {
  await withOffscreenChrome({ ok: true, data: true }, true, async ({ fetched }) => {
    assert.equal(await post('https://node.example/', '{}'), '{"result":1}');
    assert.equal(fetched(), 1);
  });
});

test('a local node needs no route check', async () => {
  await withOffscreenChrome(new Error('worker asleep'), true, async ({ asked, fetched }) => {
    await post('http://127.0.0.1:9797/', '{}');
    assert.equal(asked.length, 0);
    assert.equal(fetched(), 1);
  });
});

test('a silent service worker blocks the request when Tor is on, not when it is off', async () => {
  await withOffscreenChrome(new Error('worker asleep'), true, async ({ fetched }) => {
    await assert.rejects(post('https://node.example/', '{}'), /Tor is not connected/);
    assert.equal(fetched(), 0);
  });
  await withOffscreenChrome(new Error('worker asleep'), false, async ({ fetched }) => {
    await post('https://node.example/', '{}');
    assert.equal(fetched(), 1);
  });
});

// ------------------------------------------------------- source contracts --

const background = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const runner = fs.readFileSync(new URL('../extension/node-runner.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../extension/node-worker.js', import.meta.url), 'utf8');
const offscreen = fs.readFileSync(new URL('../extension/offscreen.js', import.meta.url), 'utf8');

test('the node module holds no keys and the worker never touches the network', () => {
  for (const src of [runner, worker]) assert.doesNotMatch(src, /vault|sessionKey|phrase|exportRawKey/);
  assert.doesNotMatch(worker, /fetch\(|rpc\./);
  // Every node request goes through rpc.post: Tor check and size ceiling.
  assert.doesNotMatch(runner, /\bfetch\(/);
  assert.match(runner, /maxBytes: TIP_MAX_BYTES/);
});

test('the node files load only when Full node mode is on', () => {
  assert.doesNotMatch(background, /import[^\n]*(node-runner|node-worker|pkg\/node)/);
  assert.doesNotMatch(offscreen, /^import .*node-runner/m);
});

test('the offscreen page is not closed under a running node, and a locked wallet keeps its routing', () => {
  assert.match(background, /async function closeOffscreenIfIdle\(\) \{\n[^\n]*\n\s*if \(succinct\.enabled\(/);
  assert.match(background, /Unlock the wallet to change this setting/);
  assert.match(background, /sender\.id !== chrome\.runtime\.id/);
});
