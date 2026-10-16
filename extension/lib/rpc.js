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

const poolWrites=new Map();
const READ_METHODS=new Set(['chain_height','wallet_getBlocks','wallet_restoreMembershipProof','utxoindex_blockHeightsByFlags','utxoindex_blockHeightsByAbsoluteIndexSets','node_network']);
function poolConfig(s,network) {
  const srv=s.servers?.[network]||{};
  const nodes=[srv.sync,srv.fallback].filter(Boolean).map(normalizeServer);
  const enabled=srv.randomFallback===true&&nodes.length===2&&nodes[0]!==nodes[1];
  return {nodes,enabled,signature:JSON.stringify([enabled,...nodes])};
}
function poolLock(network,fn) {
  const pending=(poolWrites.get(network)||Promise.resolve()).then(fn,fn);
  poolWrites.set(network,pending.catch(()=>{}));return pending;
}
async function poolState(s,network,failed) {
  return poolLock(network,async()=>{
    const cfg=poolConfig(s,network),key=`nodeSession:${network}`;
    if(!cfg.enabled)return {...cfg,index:0,url:cfg.nodes[0]||'',label:'A'};
    const old=(await chrome.storage.session.get(key))[key];
    let index=old?.signature===cfg.signature&&[0,1].includes(old.index)?old.index:crypto.getRandomValues(new Uint8Array(1))[0]&1;
    if(failed&&cfg.nodes[index]===failed)index=1-index;
    await chrome.storage.session.set({[key]:{signature:cfg.signature,index}});
    return {...cfg,index,url:cfg.nodes[index],label:index===0?'A':'B'};
  });
}
export async function nodeSession(s,network=s.network) {return poolState(s,network);}
export async function resetNodeSession(network) {return poolLock(network,()=>chrome.storage.session.set({[`nodeSession:${network}`]:null}));}
function canFailOver(error) {
  const m=String(error?.message||error);
  return !error?.nodeRejected&&!/SCAN_INTERRUPTED|Tor is not connected/.test(m)
    &&(error?.name==='AbortError'||error instanceof TypeError||/Failed to fetch|NetworkError|timed out|HTTP 5\d\d|NODE_BAD_RESPONSE/i.test(m));
}
/** Retry only known read operations, once, through the configured peer. */
export async function read(url,body,options={}) {
  let method;try{method=JSON.parse(body).method;}catch{}
  if(!READ_METHODS.has(method))return post(url,body,options);
  const s=await loadSettings(),network=s.network,cfg=poolConfig(s,network);
  if(!cfg.enabled||!cfg.nodes.includes(normalizeServer(url)))return post(url,body,options);
  const first=await poolState(s,network);
  const get=async endpoint=>{
    const text=await post(endpoint,body,options);
    try{JSON.parse(text);}catch{throw new Error('NODE_BAD_RESPONSE: invalid JSON from node');}
    return text;
  };
  try{return await get(first.url);}
  catch(e) {
    if(!canFailOver(e))throw e;
    const current=await loadSettings();
    if(current.network!==network||poolConfig(current,network).signature!==cfg.signature)throw e;
    const next=await poolState(current,network,first.url);
    return get(next.url);
  }
}

// Shared by the worker and offscreen broadcaster. If Tor is requested but
// unavailable, remote RPC traffic must not fall back to a direct connection.
export async function assertRoute(url) {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  const host = new URL(url).hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return;
  const { tor } = await chrome.storage.session.get('tor');
  const required = tor?.required === true || (await loadSettings()).tor === true;
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
      // A redirect could leave Tor's configured host list and expose RPC
      // metadata to an unchosen host. Require the configured endpoint itself.
      redirect: 'error',
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    // JSON-RPC errors arrive with HTTP 200; surface them here so callers can
    // match the node's message (e.g. "not confirmable").
    if (text.startsWith('{') && text.includes('"error"')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) {
          const error = new Error(`node: ${JSON.stringify(parsed.error)}`);
          error.nodeRejected = true;
          throw error;
        }
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
  if (!['http:','https:'].includes(u.protocol)) throw new Error('Use https:// (plain http is only allowed for localhost)');
  if (u.username || u.password) throw new Error('Do not put credentials in the node URL.');
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error('Use https:// (plain http is only allowed for localhost)');
  }
  return `${u.origin}/`;
}
