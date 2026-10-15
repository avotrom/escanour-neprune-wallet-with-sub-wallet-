// Portable seed-only backup. No network, storage, labels or send jobs.
const FORMAT = 'escanour-encrypted-recovery';
const ITERATIONS = 600000;
const AAD = new TextEncoder().encode(`${FORMAT}:1:PBKDF2-SHA256:${ITERATIONS}:AES-256-GCM`);
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function bytes(text, length) {
  if (typeof text !== 'string' || text.length > 16000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw Error('Invalid recovery file');
  const out = Uint8Array.from(atob(text), c => c.charCodeAt(0));
  if ((length != null && out.length !== length) || b64(out) !== text) throw Error('Invalid recovery file');
  return out;
}
async function key(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
}
export function isEncryptedRecoveryFile(text) {
  try { return JSON.parse(text).format === FORMAT; } catch { return false; }
}
export async function encryptRecoveryFile(phrase, password) {
  if (!password || phrase.trim().split(/\s+/).length !== 18) throw Error('Recovery phrase or password is missing');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify({ phrase: phrase.trim() }));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await key(password, salt), plain));
    return JSON.stringify({ format: FORMAT, version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext) }, null, 2);
  } finally { plain.fill(0); }
}
export async function decryptRecoveryFile(text, password) {
  if (typeof text !== 'string' || text.length > 32768) throw Error('Invalid recovery file');
  let file;
  try { file = JSON.parse(text); } catch { throw Error('Invalid recovery file'); }
  if (file.format !== FORMAT || file.version !== 1 || file.kdf !== 'PBKDF2-SHA256' || file.iterations !== ITERATIONS || file.cipher !== 'AES-256-GCM') throw Error('Unsupported recovery file');
  const salt = bytes(file.salt, 16), iv = bytes(file.iv, 12), ciphertext = bytes(file.ciphertext);
  if (ciphertext.length < 17 || ciphertext.length > 4096) throw Error('Invalid recovery file');
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await key(password, salt), ciphertext));
    const payload = JSON.parse(dec.decode(plain));
    if (typeof payload.phrase !== 'string' || payload.phrase.trim().split(/\s+/).length !== 18) throw Error('Invalid phrase');
    return payload.phrase.trim(); // Normal wallet creation validates BIP-39.
  } catch { throw Error('Wrong recovery-file password or damaged file'); }
  finally { plain?.fill(0); }
}
