// Node page: start, stop and watch a node on this Mac through the native
// helper (neptune-light native-host), and point the wallet at it.
//
// Light: neptune-light peer-node. Talks only to Neptune peers; with Full
// node mode the wallet checks the recursive proof of what it serves.
// Full: neptune-core, the official archival node.

import { t, setLanguage, applyI18n } from './lib/i18n.js';

const $ = (id) => document.getElementById(id);
const HOST = 'com.escanour.node';
const RPC = 'http://127.0.0.1:9797/';
let kind = 'light';
let settings = null;

async function wallet(cmd, args) {
  const r = await chrome.runtime.sendMessage({ target: 'background', cmd, args });
  if (!r?.ok) throw new Error(r?.error || 'The wallet did not answer.');
  return r.data;
}

function helper(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, msg, (r) => {
      const e = chrome.runtime.lastError;
      if (e) return reject(Object.assign(new Error(e.message), { missingHost: /not found|forbidden|not allowed/i.test(e.message) }));
      if (!r?.ok) return reject(new Error(r?.error || 'The helper did not answer.'));
      resolve(r.data);
    });
  });
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'node error');
  return j.result;
}

function setKind(k) {
  kind = k;
  for (const b of document.querySelectorAll('#npKind .seg-btn')) b.classList.toggle('on', b.dataset.kind === k);
  $('npLightOpts').hidden = k !== 'light';
  $('npFullOpts').hidden = k !== 'full';
  $('npKindHint').textContent = t(k === 'light' ? 'np.lightHint' : 'np.fullHint');
  try { localStorage.setItem('np.kind', k); } catch { /* convenience only */ }
}

function fact(list, k, v) {
  if (v == null || v === '') return;
  const dt = document.createElement('dt');
  dt.textContent = k;
  const dd = document.createElement('dd');
  dd.textContent = v;
  list.append(dt, dd);
}

async function refresh() {
  const facts = $('npFacts');
  let st;
  try {
    st = await helper({ cmd: 'status' });
    $('npSetup').hidden = true;
  } catch (e) {
    $('npSetup').hidden = false;
    facts.textContent = '';
    $('npMsg').textContent = e.missingHost ? t('np.noHelper') : String(e.message);
    $('npStart').disabled = true;
    return;
  }
  $('npStart').disabled = false;
  if (st.neptuneCore && !$('npCorePath').value) $('npCoreFound').textContent = t('np.coreFound', { p: st.neptuneCore });
  else if (!st.neptuneCore) $('npCoreFound').textContent = t('np.coreMissing');
  const mine = st[kind];
  const other = st[kind === 'light' ? 'full' : 'light'];
  facts.textContent = '';
  fact(facts, t('np.state'), mine.running ? t('np.running', { pid: mine.pid }) : other.running ? t('np.otherRunning') : t('np.stopped'));
  fact(facts, t('np.address'), st.rpc);
  if (mine.running) {
    try {
      if (kind === 'light') {
        const s = await rpc('lightnode_status');
        fact(facts, t('np.peersConnected'), `${s.peers} (${s.known} ${t('np.known')})`);
        fact(facts, t('np.tip'), s.height ? s.height.toLocaleString() : t('np.waitingPeers'));
      } else {
        const h = await rpc('chain_height');
        fact(facts, t('np.tip'), String(Array.isArray(h) ? h[0] : h?.height ?? h));
      }
    } catch {
      fact(facts, t('np.tip'), t('np.starting'));
    }
  }
  const log = mine.log || [];
  $('npLog').hidden = !log.length;
  $('npLog').textContent = log.join('\n');
  $('npStop').disabled = !mine.running;
}

async function useForWallet() {
  if (!$('npUse').checked) return;
  // The wallet talks to 127.0.0.1 only after Chrome allows it (asked on click).
  const ok = await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] }).catch(() => false);
  if (!ok) throw new Error(t('np.noLocalPermission'));
  await wallet('saveSettings', { servers: { [settings.network]: { sync: RPC, broadcast: RPC, fallback: '', randomFallback: false } } });
  // Full node mode: the recursive proof is checked whatever the peers send.
  await wallet('archiveSet', { on: true });
}

$('npStart').onclick = async () => {
  $('npMsg').textContent = '';
  $('npStart').disabled = true;
  try {
    const peers = $('npPeers').value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    try { localStorage.setItem('np.peers', peers.join('\n')); } catch { /* convenience only */ }
    if (kind === 'light' && !peers.length) throw new Error(t('np.needPeer'));
    await helper({ cmd: 'start', kind, network: settings.network, peers, path: $('npCorePath').value.trim() });
    await useForWallet();
    $('npMsg').textContent = t(kind === 'light' ? 'np.startedLight' : 'np.startedFull');
  } catch (e) {
    $('npMsg').textContent = String(e.message || e);
  } finally {
    $('npStart').disabled = false;
    setTimeout(refresh, 1500);
  }
};

$('npStop').onclick = async () => {
  try {
    await helper({ cmd: 'stop', kind });
    $('npMsg').textContent = t('np.stoppedMsg');
  } catch (e) {
    $('npMsg').textContent = String(e.message || e);
  }
  refresh();
};

for (const b of document.querySelectorAll('#npKind .seg-btn')) b.onclick = () => { setKind(b.dataset.kind); refresh(); };
$('npCopy').onclick = () => navigator.clipboard.writeText($('npInstallCmd').textContent);
$('npRetry').onclick = refresh;

(async () => {
  const st = await wallet('state').catch(() => null);
  settings = st?.settings || { network: 'main', language: 'auto' };
  setLanguage(settings.language);
  applyI18n(document);
  $('npInstallCmd').textContent = `./neptune-light install-host --extension-id ${chrome.runtime.id}`;
  try {
    $('npPeers').value = localStorage.getItem('np.peers') || '';
    setKind(localStorage.getItem('np.kind') === 'full' ? 'full' : 'light');
  } catch {
    setKind('light');
  }
  await refresh();
  setInterval(refresh, 5000);
})();
