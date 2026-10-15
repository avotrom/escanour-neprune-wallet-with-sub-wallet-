import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptRecoveryFile, decryptRecoveryFile, isEncryptedRecoveryFile } from '../extension/lib/recovery-file.js';
const phrase = Array(18).fill('test').join(' '); // Synthetic, never a funded wallet.
test('portable encrypted recovery is randomized and restores only the seed', async () => {
  const a = await encryptRecoveryFile(phrase, 'test password'), b = await encryptRecoveryFile(phrase, 'test password');
  assert.notEqual(a, b); assert.ok(!a.includes(phrase)); assert.ok(isEncryptedRecoveryFile(a));
  assert.equal(await decryptRecoveryFile(a, 'test password'), phrase);
  await assert.rejects(decryptRecoveryFile(a, 'wrong'), /password|damaged/);
  const bad = JSON.parse(a); bad.ciphertext = (bad.ciphertext[0] === 'A' ? 'B' : 'A') + bad.ciphertext.slice(1);
  await assert.rejects(decryptRecoveryFile(JSON.stringify(bad), 'test password'));
});
test('recovery import rejects unsupported KDF settings before expensive work', async () => {
  assert.equal(isEncryptedRecoveryFile('plain text'), false);
  await assert.rejects(decryptRecoveryFile(JSON.stringify({format:'escanour-encrypted-recovery',version:1,iterations:999999999}), 'x'), /Unsupported/);
  await assert.rejects(decryptRecoveryFile('x'.repeat(32769), 'x'), /Invalid/);
});
