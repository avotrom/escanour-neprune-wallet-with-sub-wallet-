import * as db from './db.js';

export const NETWORKS = ['main', 'testnet', 'testnet-mock'];

/** Public servers known to work, per network. Empty: the user adds one. */
export const DEFAULT_SERVERS = {
  main: {
    // Blocks are fetched from here. It learns only which heights you ask for.
    sync: 'https://wallet.neptunefundamentals.org/',
    // Transactions are sent here. A different operator than the sync server
    // means no single server sees both your syncing and your transaction.
    broadcast: 'https://wallet.neptunefundamentals.org/',
  },
  testnet: { sync: '', broadcast: '' },
  'testnet-mock': { sync: '', broadcast: '' },
};

export const DEFAULTS = {
  network: 'main',
  servers: DEFAULT_SERVERS,
  workers: 'auto',
  autoLockMinutes: 15,
  // Start proving right after a block arrives, to finish before the next one.
  waitForFreshBlock: true,
  lowMemoryProving: 'auto', // 'auto' | 'on' | 'off'
  // Route the wallet's servers and price lookups through Tor on this computer.
  tor: false,
  torPort: 9150, // Tor Browser; the tor service uses 9050
  // Keep every block's spends (public data) for exact anonymity counts.
  exactPrivacy: true,
  // Keep the whole archival mutator set (tens of MB) on this device, so
  // membership proofs and spend checks never need a server.
  localArchive: false,
  birthday: null,
  // Receiving address kind shown first: 'generation' (post-quantum, long) or
  // 'ec-hybrid' (short; notification privacy relies on elliptic curves).
  addressKind: 'generation',
  // Experimental app-address sending/publishing; mainnet is disabled in Rust too.
  privateNotifications: false,
  freshAddresses: false,
  rotateOnLeak: true,
  // Interface: 'auto' follows the system / browser.
  theme: 'auto',
  language: 'auto',
  // Value shown under the balance: 'off', 'usdt', 'usd', 'eur' or 'gbp'.
  currency: 'usdt',
  // Ask CoinGecko for the NPT price. CoinGecko then sees this computer's IP.
  priceLookup: true,
  // Chrome notifications: payment sent, received, confirmed, failed.
  notifications: true,
  hideAssets: false,
};

/** Settings written by versions before 0.3 kept one server pair for the wallet's network. */
function migrate(s) {
  const out = { ...DEFAULTS, ...s };
  out.servers = {};
  for (const n of NETWORKS) out.servers[n] = { ...DEFAULT_SERVERS[n], ...(s.servers?.[n] || {}) };
  if (s.syncServer && !s.servers) {
    out.servers[out.network] = { sync: s.syncServer, broadcast: s.broadcastServer || s.syncServer };
  }
  delete out.syncServer;
  delete out.broadcastServer;
  return out;
}

export async function load() {
  return migrate((await db.get(db.STORES.kv, 'settings')) || {});
}

export async function save(patch) {
  const next = migrate({ ...(await load()), ...patch });
  await db.put(db.STORES.kv, 'settings', next);
  return next;
}

/** The server pair for a network (the wallet's current one by default). */
export function serversFor(s, network = s.network) {
  return s.servers?.[network] || { sync: '', broadcast: '' };
}

/** Worker count: about one per 2 GB of device memory, at most 4, leaving a core free. */
export function workerCount(setting, deviceMemoryGb, cores) {
  if (setting !== 'auto') return Math.max(1, Number(setting) || 1);
  const byMemory = Math.floor((deviceMemoryGb || 4) / 2);
  const byCores = Math.max(1, (cores || 2) - 1);
  return Math.max(1, Math.min(4, byMemory, byCores));
}
