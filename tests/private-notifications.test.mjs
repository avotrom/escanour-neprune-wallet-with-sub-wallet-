import test from 'node:test';
import assert from 'node:assert/strict';
import { privateNotificationsEnabled, requirePrivateNotifications, notificationRestoreMode, validatePrivateSend, privateRecoveryStart, rotateReceivingAddress } from '../extension/lib/private-notifications.js';
import { setLanguage, t } from '../extension/lib/i18n.js';

test('private sending/publishing requires explicit opt-in and rejects mainnet', () => {
  for (const network of ['main', 'testnet', 'testnet-mock']) {
    assert.equal(privateNotificationsEnabled({ network }), false);
    assert.throws(() => requirePrivateNotifications({ network }));
  }
  assert.equal(privateNotificationsEnabled({ network: 'main', privateNotifications: true }), false);
  assert.throws(() => requirePrivateNotifications({ network: 'main', privateNotifications: true }), /mainnet/);
  for (const network of ['testnet', 'testnet-mock']) {
    const settings = { network, privateNotifications: true };
    assert.equal(privateNotificationsEnabled(settings), true);
    assert.doesNotThrow(() => requirePrivateNotifications(settings));
  }
});

test('fresh test-network restores cannot skip anonymous envelopes via the address index', () => {
  for (const network of ['testnet', 'testnet-mock']) {
    for (const mode of ['fast', 'node', 'private']) assert.equal(notificationRestoreMode(network, mode), 'private');
  }
  for (const mode of ['fast', 'node', 'private']) assert.equal(notificationRestoreMode('main', mode), mode);
});

test('experimental mode and recovery limitations are translated in all UI languages', () => {
  for (const lang of ['en', 'fr', 'ar']) {
    setLanguage(lang);
    for (const key of ['private.kind', 'private.setting', 'private.warning', 'private.receive', 'private.hint', 'private.restore', 'fresh.hint', 'guard.title', 'backup.hint', 'private.controlsTitle']) {
      assert.notEqual(t(key), key);
      assert.ok(t(key).trim().length > 0);
    }
  }
});

test('fresh receiving and leak-response policies are explicit and never require a transfer', () => {
  for (const kind of ['generation','ec-hybrid','private-app']) {
    assert.equal(rotateReceivingAddress({},kind),false);
    assert.equal(rotateReceivingAddress({freshAddresses:true},kind),true);
  }
  const leaked=[{privateDowngrade:true}];
  assert.equal(rotateReceivingAddress({},'private-app',leaked),true);
  assert.equal(rotateReceivingAddress({rotateOnLeak:false},'private-app',leaked),false);
  assert.equal(rotateReceivingAddress({},'ec-hybrid',leaked),false);
});

test('private addresses cannot downgrade and messages cannot escape via standard mode', () => {
  const settings = { network: 'testnet-mock', privateNotifications: true };
  const privateAddress = { kind: 'private-app' }, standard = { kind: 'ec-hybrid' };
  assert.throws(() => validatePrivateSend(settings, standard, 'private', ''), /requires/);
  assert.throws(() => validatePrivateSend(settings, privateAddress, 'standard', ''), /Choose Private/);
  assert.throws(() => validatePrivateSend(settings, standard, 'standard', 'hello'), /require/);
  assert.doesNotThrow(() => validatePrivateSend(settings, privateAddress, 'private', 'é'.repeat(256)));
  assert.throws(() => validatePrivateSend(settings, privateAddress, 'private', 'é'.repeat(257)), /512/);
});

test('targeted recovery includes the first payment block and defaults to genesis', () => {
  assert.equal(privateRecoveryStart(''), 0);
  assert.equal(privateRecoveryStart('1'), 0);
  assert.equal(privateRecoveryStart('50'), 49);
  for (const value of ['-1', '1.5', 'bad', '9007199254740992']) assert.throws(() => privateRecoveryStart(value));
});
