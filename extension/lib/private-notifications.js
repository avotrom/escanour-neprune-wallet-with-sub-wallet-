/** Receiving scans stay enabled on test networks even after the user turns
 * this switch off. Otherwise a previously published address could lose money.
 * The switch only controls publishing addresses and starting new sends. */
export function privateNotificationsEnabled(settings) {
  return settings.network !== 'main' && settings.privateNotifications === true;
}

/** A disclosure changes future address publication, never moves funds. */
export function rotateReceivingAddress(settings, kind, activity = []) {
  return settings.freshAddresses === true || (kind === 'private-app' && settings.rotateOnLeak !== false && activity.some(e => e.privateDowngrade === true));
}

export function requirePrivateNotifications(settings) {
  if (settings.network === 'main') throw new Error('Private app notifications are experimental and disabled on mainnet.');
  if (settings.privateNotifications !== true) throw new Error('Enable Encrypted receipt in Wallet modes first.');
}

/** The ordinary receiver-ID index cannot find custom envelopes. This build
 * always scans test-network restores in full, including on a fresh install. */
export function notificationRestoreMode(network, requested) {
  return 'private';
}

export function validatePrivateSend(settings, info, mode = 'auto', message = '') {
  if (!['auto', 'standard', 'private'].includes(mode)) throw new Error('Unknown payment mode.');
  const privateAddress = info.kind === 'private-app';
  if (mode === 'private' && !privateAddress) throw new Error('Private mode requires a private address. Ask the recipient for one.');
  if (mode === 'standard' && privateAddress) throw new Error('Choose Private for this address.');
  if (privateAddress) requirePrivateNotifications(settings);
  if (message && !privateAddress) throw new Error('Encrypted messages require a private app address.');
  if (new TextEncoder().encode(message).length > 512) throw new Error('Encrypted message exceeds 512 UTF-8 bytes.');
}

/** Include the known first-payment block; sync starts AFTER the snapshot. */
export function privateRecoveryStart(firstPaymentBlock) {
  if (firstPaymentBlock === '' || firstPaymentBlock == null) return 0;
  const height = Number(firstPaymentBlock);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error('Enter a valid first-payment block or leave it empty.');
  return Math.max(0, height - 1);
}
