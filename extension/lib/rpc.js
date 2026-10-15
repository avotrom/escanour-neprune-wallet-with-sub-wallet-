// Transport only: POST a JSON-RPC body to neptune-core's existing endpoint.
// Request bodies are built in wasm with neptune-rpc-api's own types, so the
// parameter encoding always matches what the node expects.
//
// Extensions with host permission for a server can call it even without
// CORS headers, so no change to the node is needed.

import { load as loadSettings } from './settings.js';

let nextId = 1;
const backgroundRequests = new Set();
export function interrupt() {
  for (const ctrl of backgroundRequests) ctrl.abort(new Error('SCAN_INTERRUPTED'));
}

export function id() {
  return nextId++;
}

// Shared by the worker and offscreen broadcaster. If Tor is requested but
// unavailable, remote RPC traffic must not fall back to a direct connection.
export async function assertRoute(url) {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  const host = new URL(url).hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return;
  const { tor } = await chrome.storage.session.get('tor');
  const required = tor ? tor.required : (await loadSettings()).tor;
  if (required && tor?.state !== 'on') throw new Error('Tor is not connected. Check Tor settings before retrying.');
}

export async function post(url, body, { timeoutMs = 60_000, interruptible = false } = {}) {
  await assertRoute(url);
  const ctrl = new AbortController();
  if (interruptible) backgroundRequests.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    // JSON-RPC errors arrive with HTTP 200; surface them here so callers can
    // match the node's message (e.g. "not confirmable").
    if (text.startsWith('{') && text.includes('"error"')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) throw new Error(`node: ${JSON.stringify(parsed.error)}`);
      } catch (e) {
        if (e.message.startsWith('node:')) throw e;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
    backgroundRequests.delete(ctrl);
  }
}

export function normalizeServer(url) {
  const u = new URL(url.trim());
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error('Use https:// (plain http is only allowed for localhost)');
  }
  return `${u.origin}/`;
}
