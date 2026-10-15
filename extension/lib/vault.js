// Password vault built on WebCrypto only.
//
// - PBKDF2-SHA256 (600,000 iterations) turns the password into an AES-256-GCM
//   key. The seed phrase, wallet state, prepared sends and proof jobs are all
//   encrypted with it.
// - While unlocked, the raw key is kept in chrome.storage.session: memory
//   only, cleared when the browser closes or the wallet locks, and not
//   readable by web pages or content scripts.

import * as db from './db.js';

const ITERATIONS = 600_000;
const SESSION_KEY = 'vaultKey';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true, // extractable so it can live in chrome.storage.session while unlocked
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv, data };
}

export async function decrypt(key, box) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.data));
}

export async function importRawKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function exportRawKey(key) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

/** Create the vault: stores salt and the encrypted seed phrase. */
export async function create(password, phrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const box = await encrypt(key, enc.encode(phrase));
  await db.put(db.STORES.kv, 'vault', { salt, iv: box.iv, data: box.data });
  await rememberKey(key);
  return key;
}

export async function exists() {
  return Boolean(await db.get(db.STORES.kv, 'vault'));
}

/** Check the password and keep the key for this browser session. */
export async function unlock(password) {
  const v = await db.get(db.STORES.kv, 'vault');
  if (!v) throw new Error('No wallet on this device');
  const key = await deriveKey(password, v.salt);
  try {
    await decrypt(key, v);
  } catch {
    throw new Error('Wrong password');
  }
  await rememberKey(key);
  return key;
}

async function rememberKey(key) {
  await chrome.storage.session.set({ [SESSION_KEY]: b64(await exportRawKey(key)) });
}

export async function lock() {
  keyMemo = null;
  await chrome.storage.session.remove(SESSION_KEY);
}

// The same CryptoKey object while the stored key is unchanged, so callers can
// cache work per key, and the key is not imported again on every message.
let keyMemo = null; // { stored, key }

/** The session key, or null when locked. */
export async function sessionKey() {
  const r = await chrome.storage.session.get(SESSION_KEY);
  const stored = r[SESSION_KEY];
  if (!stored) {
    keyMemo = null;
    return null;
  }
  if (keyMemo?.stored !== stored) keyMemo = { stored, key: await importRawKey(unb64(stored)) };
  return keyMemo.key;
}

export async function sessionKeyRaw() {
  const r = await chrome.storage.session.get(SESSION_KEY);
  return r[SESSION_KEY] ? unb64(r[SESSION_KEY]) : null;
}

export async function phrase(key) {
  const v = await db.get(db.STORES.kv, 'vault');
  return dec.decode(await decrypt(key, v));
}

/** Re-check a password (for revealing the seed phrase). */
export async function checkPassword(password) {
  const v = await db.get(db.STORES.kv, 'vault');
  const key = await deriveKey(password, v.salt);
  return dec.decode(await decrypt(key, v));
}
