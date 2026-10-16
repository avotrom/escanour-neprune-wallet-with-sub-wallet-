import { activeMode } from './lib/wallet-modes.js';
import { privateNotificationsEnabled, validatePrivateSend, privateRecoveryStart, rotateReceivingAddress } from './lib/private-notifications.js';
import { isEncryptedRecoveryFile, decryptRecoveryFile } from './lib/recovery-file.js';
// Popup UI. Holds no secrets except a recovery phrase the user is looking at;
// every action is a message to the service worker.

import { t, setLanguage, applyI18n, lang } from './lib/i18n.js';
import { contactAddresses, visibleWatch, scanProgress, singleFlight } from './lib/watch-model.js';
import { readAddressFromFile, readAddressFromImageBlob, cleanAddress } from './lib/qrimport.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['welcome', 'ready', 'setup', 'unlock', 'home', 'address-history', 'modes', 'mode-standard', 'mode-refresh', 'private-payments', 'private-backup', 'private-recovery', 'private-history', 'settings', 'contacts', 'phrase', 'servers', 'advanced', 'about', 'pcheck', 'tor', 'watch', 'claim', 'payment-codes', 'recovery-options', 'archive'];
const PARAMS = new URLSearchParams(location.search);
const IN_TAB = PARAMS.get('view') === 'tab';
// The wallet's usual home: Chrome's side panel, full height next to the page.
const IN_PANEL = PARAMS.get('view') === 'panel';
// A file picker would close a popup, not a tab or the side panel.
const CAN_PICK = IN_TAB || IN_PANEL;
const VERSION = chrome.runtime.getManifest().version;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

let app = null; // last `state` from the service worker
let setupMode = 'create';
let replacing = false; // setup opened from Settings
let currentSheet = null;
let fee = '0.05';
let fromKind = 'any';
let sendNotificationMode = 'standard';
let receiveRequest = 0;
let receivingHistoryIndex = null;
let addressHistoryRequest = 0;
let addressHistoryKind = 'generation';
let addressHistoryOffset = 0;
let privateAddressRevealed = false;
let lastAvail = null;
let lastSend = null;
let lastSummary = null;
let shownHeight = null; // block height the home numbers were read at
let historyCache = [];
let price = null;
let serversNet = 'main';
let serversReturn = 'settings';
let privateTrail = [];
const addrCache = {}; // kind -> receiving address (one per kind and network)
let contacts = [];
let homeWatchCache = [];
let currentScreen = 'home';
let secretEpoch = 0;
let watchOrigin = 'home';
let watchFocus = null; // decrypted address book for this network

if (IN_TAB) document.body.classList.add('in-tab');
if (IN_PANEL) document.body.classList.add('in-panel');

// ------------------------------------------------------------ messaging ---

const RETRY_SAFE = new Set(['state','home','summary','activity','contacts','receive','addressHistory','privacy','price','torStatus','watchList','waiting','archiveStatus','proofReport','latestSend','addressInfo','qr','checkPhrase','heightForDate','testServer','nodeSession']);
async function call(cmd, args) {
  // The service worker may be asleep: retry briefly while it wakes up.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'background', cmd, args });
      if (r === undefined) throw new Error('no response');
      if (!r.ok) throw new Error(r.error);
      return r.data;
    } catch (e) {
      const transient = /no response|Receiving end|Could not establish/i.test(String(e.message));
      if(transient && !RETRY_SAFE.has(cmd))throw new Error(t('err.actionUnknown'));
      if (!transient || attempt === 3) throw transient ? new Error(t('err.service')) : e;
      await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
    }
  }
}

// ------------------------------------------------------------- helpers ----

function showScreen(name) {
  if(name!==currentScreen) {
    cancelAssetRefresh();
    secretEpoch++;
    if(currentScreen==='phrase') {revealed='';$('revealGrid').textContent='';$('revealPw').value='';$('revealBox').hidden=true;$('revealForm').hidden=false;}
    if(currentScreen==='watch') {$('vkOut').textContent='';$('vkOut').hidden=true;$('vkPw').value='';}
    if(currentScreen==='private-backup')$('recoveryExportPassword').value='';
    if(currentScreen==='payment-codes')clearClaimReview(true);
  }
  currentScreen = name;
  for (const s of SCREENS) $(`v-${s}`).hidden = s !== name;
  $(`v-${name}`).scrollTop = 0;
}

function openSheet(id) {
  if (currentSheet && currentSheet !== id) $(`s-${currentSheet}`).hidden = true;
  currentSheet = id;
  $('scrim').hidden = false;
  const el = $(`s-${id}`);
  el.classList.remove('leaving');
  el.hidden = false;
  el.scrollTop = 0;
}

function closeSheet() {
  if (!currentSheet) return;
  const el = $(`s-${currentSheet}`);
  currentSheet = null;
  el.classList.add('leaving');
  $('scrim').hidden = true;
  setTimeout(() => {
    el.hidden = true;
    el.classList.remove('leaving');
  }, 280);
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2200);
}

function busy(btn, on) {
  btn.disabled = on;
  btn.classList.toggle('busy', on);
}

function err(id, e) {
  $(id).textContent = e ? String(e.message || e) : '';
}

const fmtNum = (n) => Number(n).toLocaleString(lang());

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(lang(), { month: 'short', day: 'numeric' });
}

function shortAddr(a, head = 10, tail = 6) {
  return a && a.length > head + tail + 3 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a || '';
}

/** Exact decimal arithmetic for amounts like "1.25" + "0.05". Neptune amounts
 *  are exact to 34 decimals (1 NPT = 4 * 10^30 nau), so keep them all. */
const SCALE = 34;
function toUnits(s) {
  const str = String(s ?? '0').trim();
  const neg = str.startsWith('-');
  const [i, f = ''] = str.replace(/^-/, '').split('.');
  const v = BigInt(i || '0') * 10n ** BigInt(SCALE) + BigInt((f + '0'.repeat(SCALE)).slice(0, SCALE) || '0');
  return neg ? -v : v;
}
function fromUnits(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const i = a / 10n ** BigInt(SCALE);
  const f = (a % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${i}${f ? `.${f}` : ''}`;
}
const addDec = (a, b) => fromUnits(toUnits(a) + toUnits(b));
/** Amount for display: at most 8 decimals, cut (never rounded up, so it never
 *  shows more than you have), no trailing zeros ("7.15000000" -> "7.15"). */
const SHOW = 10n ** BigInt(SCALE - 8);
const cut8 = (v) => (v / SHOW) * SHOW;
const fmtAmt = (a) => fromUnits(cut8(toUnits(a ?? '0')));

function wordsInto(list, phrase) {
  list.textContent = '';
  phrase.trim().split(/\s+/).forEach((w, i) => {
    const li = document.createElement('li');
    li.textContent = w;
    li.style.animationDelay = `${i * 18}ms`;
    list.append(li);
  });
}

const kindLabel = (kind) => kind === 'private-unprotected' ? t('private.unprotectedKind') : kind === 'private-app' ? t('private.kind') : (kind === 'ec-hybrid' ? t('kind.ecHybrid') : t('kind.pqAddr'));
const netLabel = (n) => (n === 'main' ? t('net.main') : n === 'testnet' ? t('net.testnet') : t('net.mock'));

function kindChip(el, kind, text) {
  el.hidden = false;
  el.dataset.kind = kind;
  const icon = kind === 'generation' ? 'i-shield' : kind === 'ec-hybrid' ? 'i-bolt' : 'i-x';
  el.innerHTML = `<svg><use href="#${icon}"/></svg>`;
  el.append(document.createTextNode(text));
}


function saveText(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Copy a secret; clear it again after a minute if this window is still open. */
async function copySecret(text) {
  await navigator.clipboard.writeText(text);
  toast(t('phrase.copied'));
  setTimeout(async () => {
    try {
      if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText('');
    } catch {
      /* the window lost focus: nothing more can be done from here */
    }
  }, 60_000);
}

function phraseFileText(phrase) {
  return `Escanour Neptune Wallet - recovery phrase\nKeep this file offline. Anyone with these words can take your funds.\n\n${phrase.trim()}\n`;
}

// ------------------------------------------------------ theme & language ---

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  for (const b of document.querySelectorAll('#themeSeg button')) b.classList.toggle('on', b.dataset.theme === (theme || 'auto'));
  try {
    localStorage.setItem('esc.theme', theme || 'auto');
  } catch {
    /* only a convenience */
  }
}

function applyLanguage(setting) {
  setLanguage(setting);
  applyI18n(document);
  try {
    localStorage.setItem('esc.lang', lang());
  } catch {
    /* only a convenience */
  }
}

// ---------------------------------------------------------------- boot ----

async function boot() {
  app = await call('state');
  applyTheme(app.settings.theme);
  applyLanguage(app.settings.language);
  renderTor(app.tor);
  if (!app.exists) {
    showScreen('welcome');
    return runUrlAction();
  }
  if (!app.unlocked) {
    clearWatchSecrets(); clearPrivateText(); closeSheet();
    showScreen('unlock');
    setTimeout(() => $('unlockPw').focus(), 60);
    return;
  }
  showScreen('home');
  renderNetwork();
  renderStatus(app.status || {});
  renderSendCard(app.send);
  shownHeight = app.status?.height ?? null;
  await refreshHome();
  renderPrice();
  call('sync').catch(() => {}); // updates arrive by message
  runUrlAction();
}

// ---------------------------------------------------------------- tabs ---

let homeTab = 'addr';
try {
  homeTab = localStorage.getItem('esc.tab') || 'addr';
} catch {
  /* only a convenience */
}

function showTab(name) {
  homeTab = ['addr', 'watch', 'act'].includes(name) ? name : 'addr';
  for (const b of document.querySelectorAll('.tabs .tab')) {
    const on = b.dataset.tab === homeTab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('#v-home .pane')) p.hidden = p.dataset.pane !== homeTab;
  $('homeWatchSection').hidden = homeTab !== 'watch';
  renderPrivatePanel();
  try {
    localStorage.setItem('esc.tab', homeTab);
  } catch {
    /* only a convenience */
  }
}
for (const b of document.querySelectorAll('.tabs .tab')) b.onclick = () => showTab(b.dataset.tab);
showTab(homeTab);

$('goWatch').onclick = () => openWatch('home');
$('goPrivacy').onclick = () => $('privacyChip').click();
$('homeWatchEmpty').onclick = () => addWatchFromHome();
$('homeWatchMore').onclick = () => openWatch('home');
$('homeWatchAdd').onclick = () => addWatchFromHome();
$('homeContacts').onclick = () => openSub('contacts');
$('homeWatchSearch').oninput = () => renderHomeWatch(homeWatchCache);
$('homeShowHidden').onchange = () => renderHomeWatch(homeWatchCache);
async function addWatchFromHome() { await openWatch('home'); $('watchAddBox').open = true; $('watchKey').focus(); }

const amountText = (value, suffix = '') => app?.settings?.hideAssets ? '••••' : `${fmtAmt(value)}${suffix}`;
const watchModeText = (a) => t(a.mode === 'node' ? 'watch.modeNodeShort' : a.mode === 'fast' ? 'watch.modeFastShort' : 'watch.modePrivateShort');
function accountStatus(a, height) {
  if (a.paused) return t('watch.paused');
  const fast = app?.status?.watchFast;
  if (fast?.id === a.id) return t('watch.indexProgress', { n: fast.found || 0, a: fast.done || 0, b: fast.total || 0 });
  const p = scanProgress(a, height);
  return a.scanned_to < height ? t('watch.scanning', { a: fmtNum(p.at), b: fmtNum(p.end) }) : t('watch.caughtUp', { h: fmtNum(height) });
}
function watchProgressBar(a, height) {
  const progress = document.createElement('progress');
  progress.className = 'watch-meter'; progress.max = 100;
  progress.value = scanProgress(a, height).percent;
  progress.setAttribute('aria-label', accountStatus(a, height));
  return progress;
}
function renderHomeWatch(list) {
  homeWatchCache = list;
  const ul = $('homeWatch'); ul.textContent = '';
  const shown = visibleWatch(list, $('homeShowHidden').checked, $('homeWatchSearch').value);
  $('homeWatchCount').textContent = t('watch.count', { n: list.length, h: list.filter((a) => a.hidden).length });
  $('homeWatchEmpty').hidden = shown.length > 0;
  $('homeWatchMore').hidden = list.length === 0;
  const height = app?.status?.height || 0;
  for (const a of shown) {
    const li = document.createElement('li'); li.className = 'watch-preview';
    li.dataset.paused = String(a.paused); li.dataset.hidden = String(a.hidden);
    const btn = document.createElement('button'); btn.className = 'hw-row';
    btn.onclick = () => { watchFocus = a.id; openWatch('home'); };
    const ic = document.createElement('span'); ic.className = 'hw-ic';
    ic.textContent = (a.label || 'W').slice(0, 1).toUpperCase();
    const mid = document.createElement('span'); mid.className = 'hw-mid';
    const name = document.createElement('b'); name.textContent = a.label || a.key_short;
    const sub = document.createElement('small');
    sub.textContent = `${t(a.kind === 'ec-hybrid' ? 'kind.ecHybridShort' : 'kind.generationShort')} · ${watchModeText(a)}`;
    mid.append(name, sub);
    const amt = document.createElement('span'); amt.className = 'hw-amt';
    const value = document.createElement('b'); value.textContent = amountText(a.unspent ?? a.received, ' NPT');
    const label = document.createElement('small'); label.textContent = t(a.unspent != null ? 'watch.unspent' : 'watch.received');
    amt.append(value, label); btn.append(ic, mid, amt);
    const line = document.createElement('small'); line.className = 'watch-cursor'; line.textContent = accountStatus(a, height);
    if (a.warning) line.textContent += ` · ${t(a.warning)}`;
    li.append(btn, watchProgressBar(a, height), line); ul.append(li);
  }
}
$('hideAssets').onclick = async () => {
  const saved = await savePref({ hideAssets: !app.settings.hideAssets });
  if (saved) await refreshHome();
};

/** One request for everything on the home screen (one decrypted state). */
let homeRequest=0;
async function refreshHome() {
  const request=++homeRequest, network=app?.settings?.network, profile=activeMode(app?.settings||{}), epoch=secretEpoch;
  let h;
  try {
    h = await call('home');
  } catch (e) {
    if (e.message === 'NO_STATE'&&request===homeRequest&&app?.unlocked&&app.settings.network===network&&activeMode(app.settings)===profile&&epoch===secretEpoch) $('balAvail').textContent = '—';
    return false;
  }
  if(request!==homeRequest||!app?.unlocked||app.settings.network!==network||activeMode(app.settings)!==profile||secretEpoch!==epoch||(h.profile&&h.profile!==profile))return false;
  contacts = h.contacts || [];
  if(h.recoveries)app.recoveries=h.recoveries;
  app.send=h.send||null;renderSendCard(app.send);
  if(lastSend&&!sendBelongsHere(lastSend))lastSend=null;
  if (app && h.height != null) app.status = { ...app.status, height: h.height };
  $('hideAssets').textContent = t(app?.settings?.hideAssets ? 'watch.showAmounts' : 'watch.hideAmounts');
  $('hideAssets').setAttribute('aria-pressed', String(Boolean(app?.settings?.hideAssets)));
  Object.assign(addrCache, h.addresses || {});
  if(h.createdWallets) app.settings.createdWallets=h.createdWallets;
  if(h.walletSettings) Object.assign(app.settings,h.walletSettings);
  const receivingKind = $('addrText').dataset.kind;
  if (currentSheet === 'receive' && receivingHistoryIndex === null && receivingKind && h.addresses?.[receivingKind] && h.addresses[receivingKind] !== $('addrText').dataset.addr) {
    await showReceive(receivingKind);
  }
  await Promise.all([renderBalance(h.summary), renderHistory(h.activity), renderAddresses()]);
  renderPrivacy(h.privacy);
  renderHomeWatch(h.watch || []);
  renderPrivatePanel();
  return true;
}

/** Actions passed when the popup reopens as a tab (file pickers close popups). */
function runUrlAction() {
  const action = PARAMS.get('action');
  PARAMS.delete('action');
  if (action === 'import' && app?.unlocked) {
    openSend();
    $('importTo').classList.add('glow');
  }
  if (action === 'restore') {
    startSetup('restore', Boolean(app?.exists));
    if (!PARAMS.get('from')) $('importPhraseFile').classList.add('glow');
  }
  if (action === 'create' && !app?.exists) startSetup('create');
}

function renderNetwork() {
  const n = app.settings.network;
  $('netName').textContent = netLabel(n);
  $('netBtn').dataset.net = n;
}

// -------------------------------------------------------------- setup -----

// Setup goes one step at a time, each with its own title, like a card deck:
// create: the words, then a password; restore: the words, how to find the
// coins, then a password.
const STEPS = { create: ['words', 'password'], restore: ['enter', 'how', 'password'] };
const STEP_ICON = { words: 'i-phrase', enter: 'i-key', how: 'i-search', password: 'i-lock' };
let stepIdx = 0;

function renderStep() {
  const steps = STEPS[setupMode];
  const step = steps[stepIdx];
  for (const el of document.querySelectorAll('#v-setup .step')) el.hidden = el.dataset.step !== step;
  $('stepIcUse').setAttribute('href', `#${STEP_ICON[step]}`);
  $('stepTitle').textContent = t(`step.${step}`);
  $('stepSub').textContent = t(`step.${step}Sub`);
  const dots = $('stepDots');
  dots.textContent = '';
  for (let i = 0; i < steps.length; i++) {
    const li = document.createElement('li');
    if (i <= stepIdx) li.className = 'on';
    dots.append(li);
  }
  const last = stepIdx === steps.length - 1;
  $('setupNext').hidden = last;
  $('setupGo').hidden = !last;
  err('setupErr');
  $('v-setup').scrollTop = 0;
  if (step === 'password') setTimeout(() => $('pw1').focus(), 80);
  if (step === 'enter') setTimeout(() => $('phraseInput').focus(), 80);
}

$('setupNext').onclick = () => {
  const step = STEPS[setupMode][stepIdx];
  if (step === 'words' && !$('savedPhrase').checked) return err('setupErr', t('setup.errWrite'));
  if (step === 'enter' && $('phraseInput').value.trim().split(/\s+/).filter(Boolean).length !== 18) return err('setupErr', t('setup.err18'));
  stepIdx += 1;
  renderStep();
};

for (const b of document.querySelectorAll('.pw-eye')) {
  b.onclick = () => {
    const input = $(b.dataset.for);
    input.type = input.type === 'password' ? 'text' : 'password';
    b.classList.toggle('on', input.type === 'text');
  };
}

/** 0 to 3: length first, then variety. Only a hint; 10 characters is the rule. */
function pwScore(pw) {
  if (pw.length < 10) return pw.length ? 1 : 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((r) => r.test(pw)).length;
  return pw.length >= 16 || kinds >= 3 ? 3 : 2;
}
$('pw1').addEventListener('input', () => ($('pwMeter').dataset.s = String(pwScore($('pw1').value))));

async function startSetup(mode, fromSettings = false) {
  recoveryGeneration++;
  pendingRecoveryFile = '';
  $('recoveryImportBox').hidden = true; $('recoveryImportPassword').value = '';
  setupMode = mode;
  replacing = fromSettings;
  stepIdx = 0;
  closeSheet();
  err('setupErr');
  $('setupWarn').hidden = !fromSettings;
  $('setupTitle').textContent = mode === 'create' ? t('setup.newTitle') : t('setup.restoreTitle');
  $('setupGo').textContent = mode === 'create' ? t('setup.createGo') : t('setup.restoreGo');
  $('phraseWrap').hidden = mode !== 'create';
  $('phraseInputWrap').hidden = mode !== 'restore';
  $('restoreModes').hidden = mode !== 'restore';
  $('savedPhrase').checked = false;

  if (app?.settings?.network) $('network').value = app.settings.network;
  updatePhraseCount();
  if (mode === 'create') {
    const phrase = await call('newPhrase');
    $('phraseGrid').dataset.phrase = phrase;
    wordsInto($('phraseGrid'), phrase);
  }
  $('pwMeter').dataset.s = '0';
  showScreen('setup');
  renderStep();
}

/** Setting up takes a full tab: from the side panel, open one. */
function setupInTab(action) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?view=tab&action=${action}&from=panel`) });
}
$('goCreate').onclick = () => (IN_PANEL ? setupInTab('create') : startSetup('create'));
$('goImport').onclick = () => (IN_PANEL ? setupInTab('restore') : startSetup('restore'));
$('forgot').onclick = () => startSetup('restore', true);
document.querySelector('.back-setup').onclick = () => {
  if (stepIdx > 0) {
    stepIdx -= 1;
    return renderStep();
  }
  return replacing && app?.unlocked ? openSettings() : boot();
};

// After setup in a tab: open the wallet in the side panel. The window is
// looked up first, so the click itself can open the panel (Chrome needs the
// call to come straight from a user action).
let readyWindowId = null;
async function showReady() {
  showScreen('ready');
  try {
    readyWindowId = (await chrome.windows.getCurrent()).id;
  } catch {
    readyWindowId = null;
  }
}
$('openPanel').onclick = () => {
  if (!chrome.sidePanel?.open || readyWindowId == null) return toast(t('ready.lede'));
  chrome.sidePanel.open({ windowId: readyWindowId }).then(() => window.close(), () => toast(t('ready.lede')));
};

$('copyNewPhrase').onclick = () => copySecret($('phraseGrid').dataset.phrase || '');
$('saveNewPhrase').onclick = () => saveText(phraseFileText($('phraseGrid').dataset.phrase || ''), 'escanour-recovery-phrase.txt');

function updatePhraseCount() {
  const n = $('phraseInput').value.trim().split(/\s+/).filter(Boolean).length;
  $('phraseCount').textContent = n ? t('setup.wordCount', { n }) : '';
  $('phraseCount').classList.toggle('pending', n > 0 && n !== 18);
}
$('phraseInput').oninput = updatePhraseCount;

$('importPhraseFile').onclick = () => {
  $('importPhraseFile').classList.remove('glow');
  if (!CAN_PICK) {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab&action=restore') });
    window.close();
    return;
  }
  $('phraseFile').value = '';
  $('phraseFile').click();
};
let pendingRecoveryFile = '', recoveryGeneration = 0;
$('phraseFile').onchange = async () => {
  const generation = ++recoveryGeneration;
  const f = $('phraseFile').files?.[0];
  if (!f) return;
  if (f.size > 20_000) return err('setupErr', t('setup.fileTooBig'));
  // Take the line with 18 words; skip the file's explanation lines.
  const text = await f.text();
  if (generation !== recoveryGeneration) return;
  if (isEncryptedRecoveryFile(text)) {
    pendingRecoveryFile = text; $('phraseInput').value = ''; updatePhraseCount();
    $('recoveryImportBox').hidden = false; $('recoveryImportPassword').focus();
    return;
  }
  pendingRecoveryFile = ''; $('recoveryImportBox').hidden = true; $('recoveryImportPassword').value = '';
  const words = text.toLowerCase().match(/\b[a-z]{3,8}\b/g) || [];
  const lines = text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l.split(/\s+/).length === 18);
  $('phraseInput').value = lines[0] || words.slice(-18).join(' ');
  updatePhraseCount();
  toast(t('setup.fileRead'));
};
$('recoveryImport').onclick = async () => {
  const generation = recoveryGeneration;
  busy($('recoveryImport'), true); err('recoveryImportError');
  try {
    const phrase = await decryptRecoveryFile(pendingRecoveryFile, $('recoveryImportPassword').value);
    if (generation !== recoveryGeneration) return;
    $('phraseInput').value = phrase;
    clearClaimReview(true);waitingRequest++;$('claimWaiting').textContent='';$('claimAdopted').textContent='';
  pendingRecoveryFile = ''; $('recoveryImportPassword').value = ''; $('recoveryImportBox').hidden = true;
    updatePhraseCount(); toast(t('setup.fileRead'));
  } catch (e) { err('recoveryImportError', e); }
  finally { busy($('recoveryImport'), false); }
};

$('setupGo').onclick = async () => {
  err('setupErr');
  const password = $('pw1').value;
  if (password.length < 10) return err('setupErr', t('setup.errShort'));
  if (password !== $('pw2').value) return err('setupErr', t('setup.errMatch'));
  const phrase = setupMode === 'create' ? $('phraseGrid').dataset.phrase : $('phraseInput').value.trim().toLowerCase().split(/\s+/).join(' ');
  if (setupMode === 'restore' && phrase.split(' ').length !== 18) return err('setupErr', t('setup.err18'));
  if (setupMode === 'create' && !$('savedPhrase').checked) return err('setupErr', t('setup.errWrite'));
  if (replacing && !confirm(t('setup.confirmReplace'))) return;
  // A restore scans the whole chain, so every coin of this seed is found
  // without asking when the wallet was created. A new wallet starts at the tip.
  const from = setupMode === 'restore' ? { birthday: 1 } : {};
  if (setupMode === 'restore') {
    from.restoreMode = document.querySelector('input[name="restoreMode"]:checked')?.value || 'private';
    if (from.restoreMode === 'node') {
      let url;
      try {
        url = new URL($('rmNodeUrl').value.trim());
      } catch {
        return err('setupErr', t('rm.badUrl'));
      }
      from.nodeUrl = url.href;
      // Chrome must allow this extension to reach the node first.
      const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }).catch(() => false);
      if (!granted) return err('setupErr', t('srv.denied'));
    }
  }
  busy($('setupGo'), true);
  try {
    await call('create', { password, phrase, network: $('network').value, ...from });
    for (const id of ['pw1', 'pw2', 'phraseInput']) $(id).value = '';
    $('phraseGrid').textContent = '';
    delete $('phraseGrid').dataset.phrase;
    for (const k of Object.keys(addrCache)) delete addrCache[k];
    lastAvail = null;
    if (IN_TAB && !replacing) {
      // The wallet lives in the side panel from now on.
      app = await call('state');
      await showReady();
    } else {
      await boot();
    }
    toast(setupMode === 'create' ? t('setup.created') : t('setup.restored'));
  } catch (e) {
    err('setupErr', /NEED_SERVER|Add a .* server/.test(e.message) ? t('net.needServer') : e);
  } finally {
    busy($('setupGo'), false);
  }
};

// --------------------------------------------------------------- unlock ---

$('unlockForm').onsubmit = async (ev) => {
  ev.preventDefault();
  err('unlockErr');
  const pw = $('unlockPw').value;
  if (!pw) return err('unlockErr', t('unlock.empty'));
  busy($('unlockGo'), true);
  try {
    await call('unlock', { password: pw });
    $('unlockPw').value = '';
    await boot();
  } catch (e) {
    err('unlockErr', /^Wrong password$/.test(String(e.message)) ? t('unlock.wrong') : e);
    $('unlockPw').select();
  } finally {
    busy($('unlockGo'), false);
  }
};

$('lockBtn').onclick = async () => {
  await call('lock');
  await boot();
};

// --------------------------------------------------------------- status ---

function renderStatus(st) {
  const wrap = $('statusBtn');
  let state = 'busy';
  let heights = '';
  let title = t('status.connecting');
  let sub = t('status.reaching');
  let ratio = 0.25;

  if (st.error === 'NEED_SERVER') {
    state = 'bad';
    title = t('status.noServer');
    sub = t('status.addServer');
  } else if (st.scanPaused) {
    title=t('assets.paused');sub=t('assets.resumeHint');
  } else if (st.checking && !(st.height < st.tip) && !st.fastPending) {
    title = t('status.connecting');
    sub = t('status.reaching');
  } else if (st.serverOk === false) {
    state = 'bad';
    title = t('status.unreachable');
    sub = t('status.retrying');
  } else if (st.error) {
    state = 'bad';
    title = t('status.problem');
    sub = st.error;
  } else if (st.watchError) {
    state = 'bad'; title = t('watch.scanError'); sub = st.watchError;
  } else if (st.watchBehind || st.watchFast) {
    title = t('watch.reading');
    const p = st.watchBehind || { at: 0, end: st.height || 0 };
    sub = st.watchFast ? t('watch.indexShort', { n: st.watchFast.found || 0 }) : `${fmtNum(p.at)} / ${fmtNum(p.end)}`;
    ratio = p.end ? Math.max(0.04, Math.min(1, p.at / p.end)) : 0;
  } else if (st.height != null && st.tip != null) {
    if (st.fastPhase || st.fastPending) {
      title = t('rm.title2');
      sub = t('rm.running', { n: st.fastFound || 0 });
    } else if (st.height >= st.tip) {
      state = 'ok';
      title = t('status.upToDate');
      sub = `#${fmtNum(st.height)}`;
      ratio = 1;
    } else {
      const start = Math.min(st.startHeight ?? st.height, st.height);
      ratio = st.tip > start ? Math.max(0.04, (st.height - start) / (st.tip - start)) : 0;
      title = t('status.syncing');
      // Short form: the header also holds the network, Tor, lock and settings.
      // One number, not two: the exact heights stay in the tooltip.
      const pct = st.tip > start ? Math.floor((100 * (st.height - start)) / (st.tip - start)) : 0;
      sub = st.retrying ? t('status.slowShort') : `${pct}%`;
      heights = `${fmtNum(st.height)} / ${fmtNum(st.tip)}`;
    }
  }
  wrap.dataset.state = state;
  // Calm by default: when all is well, only the network pill's dot says so.
  wrap.hidden = false;
  $('netBtn').dataset.sync = state;
  $('netBtn').title = `${title} ${heights || sub}`.trim();
  $('statusTitle').textContent = title;
  $('statusSub').textContent = sub;
  $('orbitArc').style.strokeDashoffset = String(100 * (1 - ratio));
  wrap.title = st.lastCheckAt ? t('status.lastCheck', { time: new Date(st.lastCheckAt).toLocaleTimeString(lang()) }) : '';
}

let assetsRefreshing=false;
const ASSET_REFRESH_TIMEOUT_MS=8000;
function cancelAssetRefresh() {
  const request=assetsRefreshing;
  if(!request)return;
  assetsRefreshing=false;
  request.cancel();
  $('refreshAssets').disabled=false;
  $('refreshAssets').setAttribute('aria-busy','false');
}
async function refreshAssetsNow() {
  if(!app?.unlocked||assetsRefreshing)return;
  if(app.status?.error==='NEED_SERVER')return openServers(app.settings.network);
  const network=app.settings.network, profile=activeMode(app.settings),epoch=secretEpoch;
  const request={cancel:()=>{}};
  const current=()=>assetsRefreshing===request&&app?.unlocked&&app.settings.network===network&&activeMode(app.settings)===profile&&secretEpoch===epoch;
  assetsRefreshing=request;const button=$('refreshAssets');button.disabled=true;button.setAttribute('aria-busy','true');
  let timer;
  try {
    // Acknowledge the request, not the entire scan. Status/activity events
    // update the balance when checked blocks arrive. Never claim a balance
    // is current just because the background task was queued.
    const response=await Promise.race([
      call('requestSync',{networkContext:network}),
      new Promise((resolve,reject)=>{
        request.cancel=()=>resolve(null);
        timer=setTimeout(()=>reject(new Error(t('home.refreshTimeout'))),ASSET_REFRESH_TIMEOUT_MS);
      }),
    ]);
    if(!current()||!response)return;
    if(response.network!==network||response.queued!==true)throw new Error(t('home.refreshFailed'));
    toast(t('home.refreshRequested'));
  }catch(e){if(current())toast(String(e.message||e));}
  finally{clearTimeout(timer);if(assetsRefreshing===request)cancelAssetRefresh();}
}
$('statusBtn').onclick=$('refreshAssets').onclick=refreshAssetsNow;

// -------------------------------------------------------------- balance ---

function pendingSends() {
  return historyCache.filter((e) => e.kind === 'sent' && e.status === 'pending');
}

async function renderBalance(given) {
  try {
    const s = given || (await call('summary'));
    lastSummary = s;
    const k = s.by_kind || {};
    // The total is shown as the sum of the two address amounts as displayed,
    // so Generation + EC Hybrid always equals Available on screen.
    const shown = k.generation != null && k.ec_hybrid != null
      ? fromUnits(cut8(toUnits(k.generation)) + cut8(toUnits(k.ec_hybrid)))
      : fmtAmt(s.available);
    $('balAvail').textContent = app?.settings?.hideAssets ? '••••' : shown;
    lastAvail = s.available;
    renderExtra();
    for (const [kind, v] of [['generation', k.generation], ['ec-hybrid', k.ec_hybrid]]) {
      $(`kBal-${kind}`).textContent = amountText(v);
      document.querySelector(`.acard[data-kind="${kind}"]`).classList.toggle('has', Number(v) > 0);
    }
    $('kChangeRow').hidden = true; // change counts for the address that paid
    renderFiat();
  } catch (e) {
    if (e.message === 'NO_STATE') $('balAvail').textContent = '—';
  }
}

function renderExtra() {
  const s = lastSummary;
  if (!s) return;
  if (app?.settings?.hideAssets) { $('balExtra').textContent = ''; return; }
  // Short pills, never sentences: sync progress lives in the sync line above.
  const pills = [];
  const st = app?.status || {};
  if (st.fastPhase || st.fastPending) pills.push(['', t('pill.fast')]);
  else if (st.fastFailed && st.syncing) pills.push(['warn', t('rm.failed')]);
  const pend = pendingSends();
  if (pend.length) {
    const out = pend.reduce((a, e) => addDec(a, addDec(e.amount, e.fee || '0')), '0');
    const change = pend.reduce((a, e) => addDec(a, e.change || '0'), '0');
    pills.push(['out', t('pill.sending', { n: fmtAmt(out) })]);
    if (Number(change) > 0) pills.push(['back', t('pill.returning', { c: fmtAmt(change) })]);
  } else if (Number(s.pending_out) > 0) {
    pills.push(['back', t('pill.returning', { c: fmtAmt(s.pending_out) })]);
  }
  if (Number(s.timelocked) > 0) pills.push(['', t('pill.locked', { n: fmtAmt(s.timelocked) })]);
  const box = $('balExtra');
  box.replaceChildren(...pills.map(([kind, text]) => {
    const el = document.createElement('span');
    el.className = `bpill ${kind}`.trim();
    el.textContent = text;
    return el;
  }));
}

// -------------------------------------------------------------- privacy ---

let privacy = null;

/** Other coins whoever paid you cannot tell this coin's spend apart from:
 *  exact when the wallet has every block's spends, otherwise an upper bound.
 *  The coin itself and the other outputs of its block (the sender's) are out. */
const hiddenAmong = (c) => c.sender_sees ?? Math.max(0, (c.exact_possible ?? c.hidden_among_now) - 1);

/** Level from the measured anonymity set and the other leaks. */
function privacyLevel(p) {
  const coins = p.coins.filter((c) => c.spendable);
  if (!coins.length) return { level: 'none', min: null };
  const min = Math.min(...coins.map(hiddenAmong));
  const reveals = coins.some((c) => c.reveals_amount);
  let level = min >= 64 ? 'strong' : min >= 24 ? 'good' : 'fair';
  if (reveals || p.sameServer) level = level === 'strong' ? 'good' : 'fair';
  if (reveals && p.sameServer) level = 'fair';
  // A server that did a fast restore knows these coins are yours.
  if (p.fastRestored && !p.fastRestored.own) level = 'fair';
  return { level, min, reveals };
}

async function renderPrivacy(given) {
  if (given !== undefined) {
    privacy = given;
  } else {
    try {
      privacy = await call('privacy');
    } catch {
      privacy = null;
    }
  }
  const chip = $('privacyChip');
  chip.hidden = false; // always there: the header stays symmetric
  if (!privacy) {
    chip.dataset.level = 'none';
    return;
  }
  const { level, min } = privacyLevel(privacy);
  chip.dataset.level = level;
  // Compact on the home: the level and the smallest anonymity set.
  const lv = t(`pv.${level}`);
  $('privacyLabel').textContent = level === 'none' ? t('pv.chipNone') : `${lv.charAt(0).toUpperCase()}${lv.slice(1)} · ${fmtNum(min)}`;
  $('privacyChip').title = level === 'none' ? t('pv.chipNone') : t('pv.chip', { l: lv, n: fmtNum(min) });
}

function blocksFor(leaves) {
  const rate = privacy?.leaves_per_block || 0;
  return rate > 0 ? Math.max(1, Math.ceil(leaves / rate)) : null;
}

function check(state, title, text) {
  const li = document.createElement('li');
  li.dataset.s = state;
  li.innerHTML = `<svg><use href="#${state === 'ok' ? 'i-check' : state === 'warn' ? 'i-info' : 'i-info'}"/></svg>`;
  const div = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = title;
  const span = document.createElement('span');
  span.textContent = text;
  div.append(b, span);
  li.append(div);
  return li;
}

function openPrivacy() {
  if (!privacy) return;
  const p = privacy;
  const { level, min, reveals } = privacyLevel(p);
  const coins = p.coins.filter((c) => c.spendable);
  $('pvNumber').textContent = min == null ? '–' : fmtNum(min);
  const hero = document.querySelector('.pv-hero');
  hero.dataset.level = level;
  const fullMin = coins.length ? Math.min(...coins.map((c) => c.hidden_among_full - 1)) : 1;
  $('pvArc').style.strokeDashoffset = '100';
  requestAnimationFrame(() => {
    $('pvArc').style.strokeDashoffset = String(100 * (1 - (min == null ? 0 : Math.min(1, min / Math.max(fullMin, 1)))));
  });
  const exactAll = coins.length > 0 && coins.every((c) => c.exact_possible != null);
  $('pvHeadline').textContent = min == null
    ? t('pv.noCoins')
    : t(exactAll ? 'pv.headline' : 'pv.headlineUpTo', { n: fmtNum(min), l: t(`pv.${level}`) });

  const list = $('pvChecks');
  list.textContent = '';
  const growing = coins.filter((c) => c.leaves_until_full > 0).sort((a, b) => b.leaves_until_full - a.leaves_until_full)[0];
  if (min != null) {
    if (growing) {
      const blocks = blocksFor(growing.leaves_until_full);
      list.append(check('info', t('pv.growTitle'), t('pv.grow', { now: fmtNum(hiddenAmong(growing)), full: fmtNum(hiddenAmong(growing) + growing.leaves_until_full), b: blocks ?? '?' })));
    } else {
      list.append(check('ok', t('pv.fullTitle'), t('pv.full')));
    }
    const n = coins.filter((c) => c.reveals_amount).length;
    list.append(reveals ? check('warn', t('pv.lustTitle'), t('pv.lust', { n })) : check('ok', t('pv.amountsTitle'), t('pv.amounts')));
  }
  if (min != null) {
    const ex = p.exact || {};
    if (ex.computed) {
      list.append(check('ok', t('pv.exactTitle'), t('pv.exact', { s: fmtNum(ex.spends_considered), l: fmtNum(ex.provably_spent_leaves) })));
    } else if (ex.error) {
      list.append(check('warn', t('pv.exactErrTitle'), t('pv.exactErr', { e: ex.error })));
    } else if (app?.settings?.exactPrivacy === false) {
      list.append(check('info', t('pv.exactOffTitle'), t('pv.exactOff')));
    } else {
      const ix = p.spendIndex;
      const pct = ix && ix.total ? Math.floor((100 * ix.have) / ix.total) : 0;
      list.append(check('info', t('pv.exactBuildTitle'), t('pv.exactBuild', { p: pct })));
    }
    list.append(check('info', t('pv.whoTitle'), t('pv.who')));
    if (coins.some((c) => c.sender_block_known === false)) list.append(check('warn', t('pv.whoOldTitle'), t('pv.whoOld')));
    const least = [...coins].sort((a, b) => hiddenAmong(a) - hiddenAmong(b))[0];
    list.append(check('info', t('pv.timeTitle'), t('pv.time', { a: fmtNum(least.est_block_lo), b: fmtNum(least.est_block_hi) })));
    if (coins.length > 1) list.append(check('info', t('pv.linkTitle'), t('pv.link')));
  }
  const ms = p.mutator_set;
  const st = p.stark;
  if (ms) list.append(check('ok', t('pv.msTitle'), t('pv.ms', { k: ms.num_trials, w: `2^${Math.log2(ms.window_size)}`, c: fmtNum(ms.chunk_size), b: ms.batch_size, n: fmtNum(p.aocl_leaves) })));
  if (st) list.append(check('ok', t('pv.starkTitle'), t('pv.stark', { s: st.security_level, f: st.fri_expansion_factor, q: st.num_collinearity_checks, r: st.num_trace_randomizers })));
  list.append(check('info', t('pv.notifTitle'), t('pv.notif')));
  if (p.ownNode) list.append(check('ok', t('pv.ownNodeTitle'), t('pv.ownNode')));
  else list.append(p.sameServer ? check('warn', t('pv.serverTitle'), t('pv.server')) : check('ok', t('pv.serversOkTitle'), t('pv.serversOk')));
  if (p.fastRestored) {
    list.append(p.fastRestored.own
      ? check('ok', t('pv.fastOwnTitle'), t('pv.fastOwn'))
      : check('warn', t('pv.fastTitle'), t('pv.fast', { host: p.fastRestored.host || '?' })));
  }
  list.append(p.priceLookup ? check('info', t('pv.priceTitle'), t('pv.price')) : check('ok', t('pv.noPriceTitle'), t('pv.noPrice')));
  list.append(check('info', t('pv.reuseTitle'), t('pv.reuse')));
  list.append(check('ok', t('pv.localTitle'), t('pv.local')));

  const cl = $('pvCoins');
  cl.textContent = '';
  for (const c of [...p.coins].sort((a, b) => hiddenAmong(a) - hiddenAmong(b))) {
    const li = document.createElement('li');
    const a = document.createElement('b');
    a.textContent = `${fmtAmt(c.amount)} NPT`;
    const h = document.createElement('span');
    h.textContent = c.exact_possible != null
      ? t('pv.coinExact', { n: fmtNum(hiddenAmong(c)) })
      : t('pv.coinUpTo', { n: fmtNum(hiddenAmong(c)) });
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round((100 * hiddenAmong(c)) / Math.max(1, c.hidden_among_full - 1))}%`;
    bar.append(fill);
    const sm = document.createElement('small');
    sm.textContent = [
      c.kind === 'change' ? t('kind.change') : kindLabel(c.kind),
      t('pv.coinRange', { lo: fmtNum(c.aocl_lo), hi: fmtNum(c.aocl_hi), a: fmtNum(c.est_block_lo), b: fmtNum(c.est_block_hi) }),
      c.reveals_amount ? t('pv.revealsShort') : '',
      c.spendable ? '' : t('pv.locked'),
    ].filter(Boolean).join(' · ');
    li.append(a, h, bar, sm);
    cl.append(li);
  }
  openSheet('privacy');
}
$('privacyChip').onclick = openPrivacy;

// ---------------------------------------------------------------- price ---

async function renderPrice() {
  const cur = app?.settings?.currency || 'usdt';
  if (cur === 'off' || app?.settings?.priceLookup === false || app?.settings?.network !== 'main') {
    price = null;
    $('fiat').hidden = true;
    $('market').hidden = true;
    return;
  }
  try {
    price = await call('price');
  } catch {
    price = null;
  }
  renderFiat();
  renderSpark();
}

// ------------------------------------------------------------ price chart ---
// The NPT price over 7 days, drawn behind the balance: a soft area and a line,
// drawn in once when the popup opens, with a pulsing dot on today's price.

let sparkDrawn = false;

/** Smooth path through the points (Catmull-Rom as cubic Béziers). */
function smoothPath(pts) {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

async function renderSpark() {
  const box = $('spark');
  if (!price) {
    $('market').hidden = true;
    return;
  }
  let h = null;
  try {
    h = await call('priceHistory');
  } catch {
    h = null;
  }
  const pts = h?.points;
  if (!pts || pts.length < 2) {
    box.hidden = true;
    $('sparkTag').textContent = '';
    return;
  }
  const W = 300;
  const H = 60;
  const vals = pts.map((p) => p[1]);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || max || 1;
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  // A little room at both ends and top and bottom, so the line never touches the edges.
  const xy = pts.map(([tt, v]) => [6 + ((tt - t0) / Math.max(1, t1 - t0)) * (W - 12), 6 + (1 - (v - min) / span) * (H - 12)]);
  const line = smoothPath(xy);
  $('sparkLine').setAttribute('d', line);
  $('sparkArea').setAttribute('d', `${line} L${W},${H} L0,${H} Z`);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const change = first ? ((last - first) / first) * 100 : 0;
  box.dataset.dir = change >= 0 ? 'up' : 'down';
  const [lx, ly] = xy[xy.length - 1];
  const dot = $('sparkDot');
  dot.style.left = `${(lx / W) * 100}%`;
  dot.style.top = `${(ly / H) * 100}%`;
  // The figure is isolated left-to-right so "+8.7%" never flips in Arabic.
  const tag = $('sparkTag');
  const [before, after = ''] = t('price.week', { c: '\u0000' }).split('\u0000');
  const num = document.createElement('bdi');
  num.dir = 'ltr';
  num.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
  tag.dir = lang() === 'ar' ? 'rtl' : 'ltr';
  tag.replaceChildren(before, num, after);
  box.hidden = false;
  if (!sparkDrawn && !REDUCED) {
    sparkDrawn = true;
    const path = $('sparkLine');
    // The line is scaled by the SVG, so draw it in with a normalised length.
    path.setAttribute('pathLength', '1');
    path.style.strokeDasharray = '1';
    path.style.strokeDashoffset = '1';
    box.classList.remove('drawn');
    void box.offsetWidth;
    box.classList.add('drawn');
  }
}

function fmtMoney(value, cur, digits = 2) {
  const opts = { minimumFractionDigits: digits, maximumFractionDigits: digits };
  if (cur === 'usdt') return `${value.toLocaleString(lang(), opts)} USDT`;
  return new Intl.NumberFormat(lang(), { style: 'currency', currency: cur.toUpperCase(), ...opts }).format(value);
}

/** Decimals for a unit price: 4 below 1, so small prices stay readable. */
const unitDigits = (v) => (v >= 100 ? 2 : v >= 1 ? 3 : 4);

function renderFiat() {
  const cur = app?.settings?.currency || 'usdt';
  const p = price?.[cur];
  if (cur === 'off' || !p || !lastSummary || app?.settings?.network !== 'main') {
    $('fiat').hidden = true;
    $('market').hidden = true;
    return;
  }
  $('market').hidden = false;
  $('fiat').hidden = false;
  $('fiatVal').textContent = app?.settings?.hideAssets ? '••••' : `≈ ${fmtMoney(Number(lastSummary.available) * p, cur)}`;
  $('unitPrice').textContent = t('price.one', { v: fmtMoney(p, cur, unitDigits(p)) });
  $('fiat').title = '';
  const chg = price.change24h;
  const c = $('fiatChg');
  if (typeof chg === 'number') {
    c.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%`;
    c.dataset.dir = chg >= 0 ? 'up' : 'down';
  } else {
    c.textContent = '';
  }
}

// ------------------------------------------------------------ addresses ---

async function currentAddress(kind) {
  if (addrCache[kind] && activeMode(app?.settings)!=='refresh') return addrCache[kind];
  const r = await call('receive', { kind });
  addrCache[kind] = r.address;
  return r.address;
}
async function renderAddresses() {

  for (const kind of ['generation', 'ec-hybrid']) {
    try {
      const result=await call('receive',{kind});const a=result.address;addrCache[kind]=a;
      $(`kState-${kind}`).textContent=activeMode(app.settings)==='refresh'?t('recv.number',{n:fmtNum(Number(result.index||0)+1)}):activeMode(app.settings)==='encrypted'?t('modes.encryptedNote'):'';
      $(`kAddr-${kind}`).textContent = shortAddr(a, 6, 3);
      $(`kAddr-${kind}`).title = a;
    } catch {
      $(`kAddr-${kind}`).textContent = '—';
    }
  }
}

for (const card of document.querySelectorAll('.acard')) {
  const kind = card.dataset.kind;
  card.onclick = (ev) => !ev.target.closest('.mini') && openReceive(kind);
  card.onkeydown = (ev) => ev.key === 'Enter' && ev.target === card && openReceive(kind);
}
for (const b of document.querySelectorAll('.k-copy')) {
  b.onclick = async () => {
    await navigator.clipboard.writeText(await currentAddress(b.dataset.kind));
    toast(t('recv.copiedKind', { k: kindLabel(b.dataset.kind) }));
  };
}
for (const b of document.querySelectorAll('.k-qr')) b.onclick = () => openReceive(b.dataset.kind);
for (const b of document.querySelectorAll('.k-dl')) {
  b.onclick = async () => downloadAddress(b.dataset.kind, await currentAddress(b.dataset.kind));
}

// -------------------------------------------------------------- history ---

function txRow(e, i = 0) {
  const li = document.createElement('li');
  const kind = e.kind;
  li.className = `tx ${kind === 'received' ? 'in' : 'out'} ${e.status === 'expired' ? 'expired' : ''}`;
  li.tabIndex = 0;
  li.style.animationDelay = `${Math.min(i, 8) * 30}ms`;

  const icon = document.createElement('span');
  icon.className = 'tx-icon';
  icon.innerHTML = `<svg><use href="#${kind === 'received' ? 'i-receive' : 'i-send'}"/></svg>`;
  // Which of your addresses received it (or which kind you paid): a small badge.
  const via = kind === 'received' ? e.addressKind : e.toKind;
  if (via) {
    const badge = document.createElement('i');
    badge.className = `via ${via === 'generation' ? 'pq' : 'ech'}`;
    badge.innerHTML = `<svg><use href="#${via === 'ec-hybrid' ? 'i-bolt' : 'i-shield'}"/></svg>`;
    icon.append(badge);
  }

  const main = document.createElement('span');
  main.className = 'tx-main';
  const title = document.createElement('b');
  title.textContent =
    kind === 'sent' && nameFor(e.to) ? t('tx.to', { a: nameFor(e.to) }) :
    kind === 'received' ? (e.addressKind ? t('tx.receivedOn', { k: kindLabel(e.addressKind) }) : t('tx.received')) : kind === 'sent' ? t('tx.to', { a: shortAddr(e.to, 9, 5) }) : t('tx.elsewhere');
  const sub = document.createElement('small');
  if (e.status === 'pending') {
    sub.textContent = t('tx.waiting');
    sub.className = 'pending';
  } else if (e.status === 'expired') {
    sub.textContent = t('tx.expired');
  } else {
    const parts = [fmtDate(e.confirmedAt || e.at)];
    if (kind !== 'received' && e.toKind) parts.push(kindLabel(e.toKind));
    sub.textContent = parts.filter(Boolean).join(' · ');
    if (e.note) {
      sub.textContent = e.note;
      sub.className = 'tx-note';
    }
  }
  main.append(title, sub);

  const amt = document.createElement('span');
  amt.className = 'tx-amt';
  const v = document.createElement('span');
  v.textContent = app?.settings?.hideAssets ? '••••' : `${kind === 'received' ? '+' : '−'}${fmtAmt(e.amount)}`;
  amt.append(v);
  if (e.fee) {
    const f = document.createElement('small');
    f.textContent = app?.settings?.hideAssets ? '' : t('tx.fee', { n: fmtAmt(e.fee) });
    amt.append(f);
  }

  li.append(icon, main, amt);
  li.onclick = () => showTx(e);
  li.onkeydown = (ev) => ev.key === 'Enter' && showTx(e);
  return li;
}

async function renderHistory(given) {
  if (given) {
    historyCache = given;
  } else {
    try {
      historyCache = await call('activity');
    } catch {
      historyCache = [];
    }
  }
  const list = $('historyList');
  list.textContent = '';
  $('seeAll').hidden = historyCache.length <= 6;
  if (!historyCache.length) {
    const p = document.createElement('li');
    p.className = 'empty';
    p.textContent = t('tx.empty');
    list.append(p);
  }
  historyCache.slice(0, 6).forEach((e, i) => list.append(txRow(e, i)));
  renderExtra();
}

function openHistory() {
  const all = $('historyAll');
  all.textContent = '';
  if (!historyCache.length) {
    const p = document.createElement('li');
    p.className = 'empty';
    p.textContent = t('tx.empty');
    all.append(p);
  }
  historyCache.forEach((e, i) => all.append(txRow(e, i)));
  openSheet('history');
}
$('seeAll').onclick = openHistory;

function showTx(e) {
  $('txTitle').textContent = e.kind === 'received' ? t('tx.received') : e.kind === 'sent' ? t('tx.sent') : t('tx.elsewhere');
  $('txAmount').textContent = app?.settings?.hideAssets ? '••••' : `${e.kind === 'received' ? '+' : '−'}${fmtAmt(e.amount)} NPT`;
  const statusText = e.status === 'pending' ? t('tx.waiting') : e.status === 'expired' ? t('tx.expired') : t('tx.confirmed');
  const rows = [
    [t('tx.status'), statusText],
    e.to && nameFor(e.to) && [t('ct.name'), nameFor(e.to)],
    e.to && [t('send.to'), e.to, 'mono'],
    e.toKind && [t('tx.addrType'), kindLabel(e.toKind)],
    e.fee && [t('send.fee'), `${fmtAmt(e.fee)} NPT`],
    e.fee && [t('review.total'), `${addDec(e.amount, e.fee)} NPT`],
    e.change && Number(e.change) > 0 && [t('tx.change'), `${fmtAmt(e.change)} NPT`],
    e.height && [t('tx.blockLabel'), fmtNum(e.height)],
    (e.confirmedAt || e.at) && [t('tx.date'), new Date(e.confirmedAt || e.at).toLocaleString(lang())],
    e.addressKind && [t('tx.receivedBy'), kindLabel(e.addressKind)],
    (e.addressKind === 'private-app' || e.privateDowngrade) && [t('private.receiptMode'), t(e.privateDowngrade ? 'private.receiptPublic' : 'private.receiptVerified')],
    e.txId && [t('tx.id'), e.txId, 'mono'],
  ].filter(Boolean);
  const dl = $('txDetails');
  dl.textContent = '';
  for (const [k, v, cls] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (cls) dd.className = cls;
    dl.append(dt, dd);
  }
  $('txProtectionWarning').hidden = !e.privateDowngrade;
  const encryptedText = typeof e.encryptedMessage === 'string' ? e.encryptedMessage : '';
  $('txEncryptedBox').hidden = !encryptedText;
  $('txEncryptedMessage').textContent = app?.settings?.hideAssets ? '••••' : encryptedText;
  const input = $('txNoteInput');
  input.value = e.note || '';
  input.onchange = async () => {
    try {
      const updated = await call('setNote', { id: e.id, note: input.value });
      e.note = updated.note;
      renderHistory();
      toast(t('note.saved'));
    } catch (er) {
      toast(String(er.message || er));
    }
  };
  $('txSaveContact').hidden = !(e.kind === 'sent' && e.to && !nameFor(e.to));
  $('txSaveContact').onclick = () => openContact(null, e.to);
  const note = $('txNote');
  note.hidden = e.status !== 'pending';
  if (e.status === 'pending') {
    const blocks = e.atHeight != null && app?.status?.height ? Math.max(0, app.status.height - e.atHeight) : null;
    note.textContent = t('tx.pendingHelp', { n: blocks ?? '?' });
  }
  openSheet('tx');
}

// -------------------------------------------------------------- receive ---

async function showReceive(kind,index=null) {
  receivingHistoryIndex=index;
  const request = ++receiveRequest;
  $('copyAddr').disabled = $('dlQr').disabled = $('revealPrivateAddress').disabled = true;
  privateAddressRevealed = false;
  $('qrBox').hidden = activeMode(app.settings) === 'encrypted';
  $('revealPrivateAddress').hidden = false;
  $('revealPrivateAddress').textContent = t(activeMode(app.settings) === 'encrypted' ? 'private.showAddress' : 'recv.showFull');
  const profile=activeMode(app.settings);
  const encrypted=profile==='encrypted';
  const rotating = profile === 'refresh';
  $('receiveProfileTitle').textContent = t(`modes.${profile}`);
  $('receiveModeStatus').textContent = t(encrypted ? 'modes.encryptedNote' : 'modes.normalReceipt');
  $('receiveModeStatus').dataset.state = 'on';
  $('receiveRotationStatus').textContent = t(rotating ? 'modes.autoOn' : 'modes.fixed');
  $('receiveRotationStatus').dataset.state = rotating ? 'on' : 'neutral';
  $('receiveAddressNumber').hidden = !rotating;
  $('receiveAddressNumber').textContent = '…';
  for (const b of document.querySelectorAll('#s-receive .seg-btn')) {
    b.classList.toggle('on', b.dataset.kind === kind);
    b.setAttribute('aria-selected', String(b.dataset.kind === kind));
  }
  $('kindHint').textContent = encrypted ? t('modes.encryptedDetails') : rotating ? t('modes.refreshDetails') : kind === 'ec-hybrid' ? t('recv.hintShort') : t('recv.hintPq');
  $('receivePrivateApp').hidden = true;
  delete $('addrText').dataset.addr;
  delete $('addrText').dataset.kind;
  const qr = $('qrBox');
  qr.className = 'qr';
  qr.textContent = '';
  $('addrText').textContent = '…';
  try {
    const result = await call('receive', { kind, index });
    const address = result.address;
    if (request !== receiveRequest) return;
    addrCache[kind] = address;
    $('receiveAddressNumber').textContent = t('recv.number',{n:fmtNum(Number(result.index||0)+1)});
    if(index!=null && !result.current){$('receiveRotationStatus').textContent=t('addrHistory.stillValid');$('receiveRotationStatus').dataset.state='neutral';}
    $('addrText').textContent = shortAddr(address, 12, 8);
    $('addrText').dataset.addr = address;
    $('addrText').dataset.kind = kind;
    $('copyAddr').disabled = $('dlQr').disabled = $('revealPrivateAddress').disabled = false;
    try {
      const svg = await call('qr', { text: address });
      if (request !== receiveRequest) return;
      qr.innerHTML = svg;
    } catch {
      if (request !== receiveRequest) return;
      qr.className = 'qr none';
      qr.textContent = t('recv.tooLong');
    }
  } catch (e) {
    if (request !== receiveRequest) return;
    $('addrText').textContent = String(e.message || e);
  }
}

function openReceive(kind,index=null) {
  openSheet('receive');
  showReceive(kind === 'private-app' ? app.settings.addressKind || 'generation' : kind || app.settings.addressKind || 'generation',index);
}

$('revealPrivateAddress').onclick = () => {
  privateAddressRevealed = !privateAddressRevealed;
  const privateMode = activeMode(app.settings) === 'encrypted';
  if (privateMode) $('qrBox').hidden = !privateAddressRevealed;
  const address = $('addrText').dataset.addr || '';
  $('addrText').textContent = privateAddressRevealed ? address : shortAddr(address, 12, 8);
  $('revealPrivateAddress').textContent = t(privateMode ? privateAddressRevealed ? 'private.hideAddress' : 'private.showAddress' : privateAddressRevealed ? 'recv.hideFull' : 'recv.showFull');
};
$('receivePrivateApp').onclick = () => showReceive('private-app');
$('goReceive').onclick = () => openReceive(app.settings.addressKind || 'generation');
for (const b of document.querySelectorAll('#s-receive .seg-btn')) b.onclick = () => showReceive(b.dataset.kind);
$('copyAddr').onclick = async () => {
  await navigator.clipboard.writeText($('addrText').dataset.addr || '');
  toast(t('recv.copiedKind', { k: kindLabel($('addrText').dataset.kind) }));
};
$('dlQr').onclick = () => {
  const a = $('addrText').dataset.addr;
  if (a) downloadAddress($('addrText').dataset.kind, a);
};

/** Save the address as a QR picture (PNG), or as a text file when it is too long for a QR code. */
async function downloadAddress(kind, address) {
  const net = app?.settings?.network === 'main' ? '' : `-${app.settings.network}`;
  const base = `escanour-${activeMode(app?.settings)}-${kind === 'private-app' ? 'private-app' : kind === 'ec-hybrid' ? 'short' : 'postquantum'}-address${net}`;
  let svg;
  try {
    svg = await call('qr', { text: address, dark: '#000000', bg: '#ffffff' });
  } catch {
    saveBlob(new Blob([`${address}\n`], { type: 'text/plain' }), `${base}.txt`);
    toast(t('recv.savedText'));
    return;
  }
  const img = new Image();
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = svgUrl;
  });
  URL.revokeObjectURL(svgUrl);
  const size = 900;
  const caption = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size + caption;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, size, size);
  g.textAlign = 'center';
  g.fillStyle = '#00007b';
  g.font = '600 30px -apple-system, system-ui, sans-serif';
  g.fillText(`Neptune Cash · ${kindLabel(kind)}`, size / 2, size + 34);
  g.fillStyle = '#4a4f6a';
  g.font = '22px ui-monospace, monospace';
  g.fillText(shortAddr(address, 18, 12), size / 2, size + 72);
  c.toBlob((blob) => {
    saveBlob(blob, `${base}.png`);
    toast(t('recv.savedQr'));
  }, 'image/png');
}

// ----------------------------------------------------------------- send ---

function openSend(mode = 'standard') {
  setSendNotificationMode(typeof mode === 'string' ? mode : 'standard');
  err('sendErr');
  updateAvailHint();
  $('sendProfileHint').textContent = t('modes.sendingWith', {m:t(`modes.${activeMode(app.settings)}`)});
  $('sendFeeSummary').textContent = `${fee} NPT`;
  $('sendEncryptedBox').open = Boolean($('sendEncryptedMessage').value);
  openSheet('send');
  setTimeout(() => $('sendTo').focus(), 320);
}

function updateAvailHint() {
  const s = lastSummary;
  if (!s) return;
  const v = fromKind === 'generation' ? s.by_kind?.generation : fromKind === 'ec-hybrid' ? s.by_kind?.ec_hybrid : s.available;
  $('availHint').textContent = t('send.available', { n: fmtAmt(v) });
}

$('goSend').onclick = () => openSend(activeMode(app.settings) === 'encrypted' ? 'private' : 'standard');

let checkTimer = null;
let toInfo = null;
function checkRecipient() {
  clearTimeout(checkTimer);
  const text = cleanAddress($('sendTo').value);
  if (!text) {
    $('toKind').hidden = true;
    toInfo = null;
    return;
  }
  checkTimer = setTimeout(async () => {
    try {
      toInfo = await call('addressInfo', { text });
    } catch (e) {
      toInfo = { valid: false, error: e.message };
    }
    if (cleanAddress($('sendTo').value) !== text) return;
    if (toInfo.valid && toInfo.kind === 'private-app') setSendNotificationMode('private');
    const own = Object.values(addrCache).includes(text);
    if (!toInfo.valid) kindChip($('toKind'), 'bad', t('send.badAddr'));
    else if (own) kindChip($('toKind'), 'own', t('send.ownAddr', { k: kindLabel(toInfo.kind) }));
    else if (nameFor(text)) kindChip($('toKind'), toInfo.kind, `${nameFor(text)} (${kindLabel(toInfo.kind)})`);
    else kindChip($('toKind'), toInfo.kind, t('send.toKind', { k: kindLabel(toInfo.kind) }));
  }, 200);
}
$('sendTo').addEventListener('input', checkRecipient);

$('pasteTo').onclick = async () => {
  try {
    $('sendTo').value = cleanAddress(await navigator.clipboard.readText());
    checkRecipient();
  } catch {
    $('sendTo').focus();
    toast(t('send.pasteKeys'));
  }
};

/** File pickers close extension popups, so the picker opens from a tab. */
function startImport() {
  if (CAN_PICK) {
    $('importFile').value = '';
    $('importFile').click();
    return;
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab&action=import') });
  window.close();
}
$('importTo').onclick = () => {
  $('importTo').classList.remove('glow');
  startImport();
};

async function useImported(promise) {
  err('sendErr');
  try {
    $('sendTo').value = await promise;
    $('sendTo').classList.add('filled');
    setTimeout(() => $('sendTo').classList.remove('filled'), 1000);
    checkRecipient();
    toast(t('send.imported'));
    $('sendAmount').focus();
  } catch (e) {
    err('sendErr', e.message === 'NO_QR' ? t('send.noQr') : e.message === 'NO_ADDR' ? t('send.noAddr') : e);
  }
}

$('importFile').onchange = () => {
  const f = $('importFile').files?.[0];
  if (f) useImported(readAddressFromFile(f));
};

const drop = $('dropZone');
drop.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (ev) => {
  ev.preventDefault();
  drop.classList.remove('over');
  const f = ev.dataTransfer?.files?.[0];
  if (f) useImported(readAddressFromFile(f));
});
$('s-send').addEventListener('paste', (ev) => {
  const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  ev.preventDefault();
  useImported(readAddressFromImageBlob(item.getAsFile()));
});

for (const b of document.querySelectorAll('#fromSeg .seg-btn')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('#fromSeg .seg-btn')) x.classList.toggle('on', x === b);
    fromKind = b.dataset.from;
    updateAvailHint();
  };
}
for (const b of document.querySelectorAll('.fee')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.fee')) x.classList.toggle('on', x === b);
    fee = b.dataset.fee;
    $('sendFeeSummary').textContent = `${fee} NPT`;
  };
}

$('maxBtn').onclick = async () => {
  try {
    $('sendAmount').value = fmtAmt(await call('maxSendable', { fee, fromKind }));
  } catch (e) {
    err('sendErr', e);
  }
};

$('sendForm').onsubmit = async (ev) => {
  ev.preventDefault();
  err('sendErr');
  const to = cleanAddress($('sendTo').value);
  const amount = $('sendAmount').value.trim().replace(',', '.');
  if (!to) return err('sendErr', t('send.errTo'));
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return err('sendErr', t('send.errAmount'));
  // Recheck the exact address shown in the review, including while a
  // debounced address-chip update is still pending.
  const info = await call('addressInfo', { text: to }).catch((e) => ({ valid: false, error: e.message }));
  if (!info.valid) return err('sendErr', `${t('send.badAddr')}: ${info.error || ''}`);
  try { validatePrivateSend(app.settings, info, sendNotificationMode, $('sendEncryptedMessage').value); } catch (e) { return err('sendErr', e); }
  const s = lastSummary;
  const avail = fromKind === 'generation' ? s?.by_kind?.generation : fromKind === 'ec-hybrid' ? s?.by_kind?.ec_hybrid : s?.available;
  if (avail != null && toUnits(addDec(amount, fee)) > toUnits(avail)) return err('sendErr', t('send.errFunds', { n: fmtAmt(avail) }));
  $('rvBig').textContent = `${amount} NPT`;
  kindChip($('rvKind'), info.kind, kindLabel(info.kind));
  $('rvTo').textContent = to;
  const message = sendNotificationMode === 'private' ? $('sendEncryptedMessage').value : '';
  $('rvMessage').textContent = message;
  $('rvMessage').hidden = $('rvMessageT').hidden = !message;
  $('rvFrom').textContent = fromKind === 'any' ? t('send.fromAnyLong') : kindLabel(fromKind);
  const note = $('sendNote').value.trim();
  $('rvNote').textContent = note;
  $('rvNote').hidden = $('rvNoteT').hidden = !note;
  const name = nameFor(to);
  if (name) $('rvTo').textContent = `${name}\n${to}`;
  $('rvFee').textContent = `${fee} NPT`;
  $('rvTotal').textContent = `${addDec(amount, fee)} NPT`;
  $('confirmSend').dataset.walletMode = activeMode(app.settings);
  $('confirmSend').dataset.network=app.settings.network;
  $('confirmSend').dataset.to = to;
  $('confirmSend').dataset.amount = amount;
  openSheet('review');
};

$('confirmSend').onclick = async () => {
  const b = $('confirmSend');
  busy(b, true);
  const epoch=secretEpoch,network=app.settings.network,profile=activeMode(app.settings);
  try {
    const id=await call('send', { networkContext:b.dataset.network,walletMode:b.dataset.walletMode, to: b.dataset.to, amount: b.dataset.amount, fee, fromKind, note: $('sendNote').value.trim(), notificationMode: sendNotificationMode, privateMessage: sendNotificationMode === 'private' ? $('sendEncryptedMessage').value : '', waitForFreshBlock: app.settings.waitForFreshBlock===true });
    if(!app?.unlocked||secretEpoch!==epoch||app.settings.network!==network||activeMode(app.settings)!==profile)return;
    $('sendTo').value = '';
    $('sendNote').value = '';
    $('sendEncryptedMessage').value = '';
    updateEncryptedMessageCount();
    $('sendAmount').value = '';
    $('toKind').hidden = true;
    renderProgress(app.send?.id===id?app.send:{id,status:'starting',network:app.settings.network,walletMode:b.dataset.walletMode,amount:b.dataset.amount,waitForFreshBlock:app.settings.waitForFreshBlock===true,toKind:sendNotificationMode==='private'?'private-app':null});
    openSheet('progress');
  } catch (e) {
    toast(String(e.message || e));
  } finally {
    busy(b, false);
  }
};

// ------------------------------------------------------------- progress ---

const STEP_OF = {
  starting: 'check', 'waiting-block': 'wait', checking:'check', preparing: 'build', rebuilding: 'build',
  proving: 'prove', proved: 'send', submitting: 'send', uncertain: 'send', done: 'done',
};
const ORDER = ['wait', 'check', 'build', 'prove', 'send', 'done'];
const sendSteps=s=>ORDER.filter(step=>step!=='wait'||s.waitForFreshBlock===true||s.status==='waiting-block');

function progressPct(s) {
  const current = STEP_OF[s.status];
  const steps=sendSteps(s),idx=steps.indexOf(current);
  const total = s.jobCount || 0;
  if (s.status === 'done') return 100;
  if (idx < 0) return 0;
  const span=100/(steps.length-1);
  return idx*span+(current==='prove'&&total?((s.jobsDone||0)/total)*span:0);
}

function sendBelongsHere(s) {return Boolean(s)&&(!s.network||s.network===app?.settings?.network)&&(s.walletMode||'standard')===activeMode(app?.settings||{});}
function renderProgress(s) {
  if(!sendBelongsHere(s))return;
  lastSend = s;
  $('pgPrivateMode').hidden = s.toKind !== 'private-app';
  const current = STEP_OF[s.status];
  const steps=sendSteps(s),idx=steps.indexOf(current);
  for (const li of document.querySelectorAll('.steps li')) {
    const i=steps.indexOf(li.dataset.step);li.hidden=i<0;
    li.classList.toggle('done', idx > i || s.status === 'done');
    li.classList.toggle('active', i === idx && s.status !== 'done');
  }
  const total = s.jobCount || 0;
  $('pgCount').textContent = s.status === 'proving' && total ? t('pg.count', { a: s.jobsDone || 0, b: total }) : '';
  $('pgBar').style.width = `${Math.round(progressPct(s))}%`;
  $('pgTitle').textContent = s.status==='uncertain' ? t('pg.unknown') : s.toKind === 'private-app' && !['done', 'failed'].includes(s.status) ? t('private.sending') : s.status === 'done' ? t('pg.done') : s.status === 'failed' ? t('pg.notSent') : t('pg.sending');
  $('pgDetail').textContent =
    s.status==='checking'||s.status==='starting'?t('pg.checking'):s.status==='preparing'?t(s.toKind==='private-app'?'private.encrypting':'pg.buildHint') : s.status === 'rebuilding' ? t('pg.rebuilding', { n: s.attempt })
      : s.status === 'uncertain' ? t('pg.unknownHint') : s.status === 'done' ? t('pg.confirmSoon')
        : s.status === 'submitting' || s.status === 'proved' ? t('pg.uploading')
          : s.lastJob ? t('pg.finished', { job: s.lastJob }) : '';
  $('lustrationBox').hidden = s.status !== 'needs-lustration';
  $('pgErr').textContent = s.status === 'failed' ? s.error || t('pg.failed') : '';
  $('pgActions').hidden = !['failed','uncertain'].includes(s.status);
  $('pgRetry').textContent=t(s.status==='uncertain'?'pg.retryOriginal':'pg.retry');
  $('pgCancel').hidden = !CANCELLABLE.includes(s.status) || !s.id;
}

$('lustrationOk').onclick = async () => {
  if (!lastSend?.id) return;
  await call('acceptLustrationAndRetry', { id: lastSend.id });
  renderProgress({ ...lastSend, status: 'starting' });
};
$('pgDismiss').onclick = async () => {
  if (lastSend?.id) await call('dismissSend', { id: lastSend.id }).catch(() => {});
  $('sendCard').hidden = true;
  closeSheet();
};
$('pgRetry').onclick = async () => {
  if (!lastSend?.id) return;
  const b = $('pgRetry');
  busy(b, true);
  try {
    await call('dismissSend', { id: lastSend.id });
    await call('retrySend', { id: lastSend.id });
    renderProgress({ ...lastSend, status: lastSend.status==='uncertain'?'submitting':'starting' });
  } catch (e) {
    $('pgErr').textContent = String(e.message || e);
  } finally {
    busy(b, false);
  }
};

/** Before the payment reaches the network it can still be stopped. */
const CANCELLABLE = ['starting', 'waiting-block', 'checking', 'preparing', 'rebuilding', 'proving', 'needs-lustration'];

$('pgCancel').onclick = async () => {
  if (!lastSend?.id || !confirm(t('pg.cancelConfirm'))) return;
  const b = $('pgCancel');
  busy(b, true);
  try {
    await call('cancelSend', { id: lastSend.id });
    $('sendCard').hidden = true;
    closeSheet();
    toast(t('pg.cancelled'));
  } catch (e) {
    $('pgErr').textContent = String(e.message || e);
  } finally {
    busy(b, false);
  }
};

const STEP_LABEL = {
  starting: 'pg.checking', 'waiting-block': 'pg.wait', checking:'pg.checking', preparing: 'pg.build', rebuilding: 'pg.build',
  proving: 'pg.prove', proved: 'pg.send', submitting: 'pg.send', uncertain: 'pg.unknown', done: 'pg.done', failed: 'pg.notSent', 'needs-lustration': 'pg.needsOk',
};

function renderSendCard(send) {
  const card = $('sendCard');
  const ended = send && ['done', 'failed'].includes(send.status);
  if (!sendBelongsHere(send) || send.dismissed || send.status === 'cancelled' || (ended && Date.now() - (send.doneAt || send.updatedAt || send.createdAt) > 10 * 60_000)) {
    card.hidden = true;card.onclick=null;
    return;
  }
  card.hidden = false;
  card.dataset.state = send.status;
  $('scTitle').textContent = t('banner.sending', { n: send.amount });
  $('scStep').textContent =
    send.status === 'proving' && send.jobCount ? t('pg.proveShort', { a: send.jobsDone || 0, b: send.jobCount }) : t(STEP_LABEL[send.status] || 'pg.sending');
  $('scBar').style.width = `${Math.round(progressPct(send))}%`;
  $('scNote').textContent = send.status === 'uncertain' ? t('pg.unknownHint') : send.status === 'failed' ? t('banner.failed') : send.status === 'done' ? t('pg.confirmSoon') : '';
  card.onclick = () => {
    renderProgress(send);
    openSheet('progress');
  };
}

// ------------------------------------------------------------- network ----

$('netBtn').onclick = () => {
  err('netErr');
  for (const b of document.querySelectorAll('.net-opt')) b.classList.toggle('on', b.dataset.net === app.settings.network);
  openSheet('network');
};

for (const b of document.querySelectorAll('.net-opt')) {
  b.onclick = async () => {
    const net = b.dataset.net;
    if (net === app.settings.network) return closeSheet();
    err('netErr');
    b.classList.add('busy-row');
    try {
      await call('switchNetwork', { network: net });
      for (const k of Object.keys(addrCache)) delete addrCache[k];
      lastAvail = null;
      lastSummary = null;
      closeSheet();
      await boot();
      toast(t('net.switched', { n: netLabel(net) }));
    } catch (e) {
      if (e.message === 'NEED_SERVER') {
        closeSheet();
        await openServers(net);
        toast(t('net.needServer'));
      } else {
        err('netErr', e);
      }
    } finally {
      b.classList.remove('busy-row');
    }
  };
}

// ------------------------------------------------------------- contacts ---

async function loadContacts() {
  try {
    contacts = await call('contacts');
  } catch {
    contacts = [];
  }
}

function nameFor(address) {
  if (!address) return '';
  return contacts.find((c) => contactAddresses(c).some((a) => a.address === address))?.name || '';
}

function contactRow(c, onPick) {
  const li = document.createElement('li');
  li.tabIndex = 0;
  const av = document.createElement('span');
  av.className = `avatar-txt ${c.kind === 'ec-hybrid' ? 'ech' : ''}`;
  av.textContent = (c.name.trim()[0] || '?').toUpperCase();
  const main = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = c.name;
  const sm = document.createElement('small');
  sm.textContent = contactAddresses(c).length > 1 ? t('ct.twoAddresses') : shortAddr(c.address, 12, 8);
  main.append(b, sm);
  const tag = document.createElement('span');
  tag.className = 'k-tag';
  tag.textContent = c.kind === 'private-app' ? t('private.kind') : contactAddresses(c).length > 1 ? t('ct.bothKinds') : c.kind === 'ec-hybrid' ? t('kind.ecHybridShort') : t('kind.generationShort');
  li.append(av, main, tag);
  li.onclick = () => onPick(c);
  li.onkeydown = (ev) => ev.key === 'Enter' && onPick(c);
  return li;
}

function renderContacts() {
  const list = $('contactList');
  list.textContent = '';
  if (!contacts.length) {
    const p = $('contactList').parentElement.querySelector('.empty-card') || document.createElement('p');
    p.className = 'empty-card';
    p.textContent = t('ct.empty');
    list.after(p);
    return;
  }
  $('contactList').parentElement.querySelector('.empty-card')?.remove();
  contacts.forEach((c, i) => {
    const li = contactRow(c, (x) => openContact(x));
    li.style.animationDelay = `${i * 25}ms`;
    list.append(li);
  });
}

let editing = null;
function openContact(c, prefill = '') {
  editing = c;
  err('ctErr');
  $('ctTitle').textContent = c ? t('ct.edit') : t('ct.add');
  $('ctName').value = c?.name || '';
  $('ctAddr').value = (c && contactAddresses(c)[0]?.address) || prefill;
  $('ctAddr2').value = (c && contactAddresses(c)[1]?.address) || '';
  $('ctDelete').hidden = !c;
  checkContactAddr();
  openSheet('contact');
  setTimeout(() => $('ctName').focus(), 320);
}

let ctTimer = null;
function checkContactAddr() {
  clearTimeout(ctTimer);
  ctTimer = setTimeout(async () => {
    for (const [input, chip] of [['ctAddr', 'ctKind'], ['ctAddr2', 'ctKind2']]) {
      const text = cleanAddress($(input).value);
      if (!text) { $(chip).hidden = true; continue; }
      const info = await call('addressInfo', { text }).catch((e) => ({ valid: false, error: e.message }));
      if (cleanAddress($(input).value) !== text) continue;
      kindChip($(chip), info.valid ? info.kind : 'bad', info.valid ? kindLabel(info.kind) : t('send.badAddr'));
    }
  }, 200);
}
$('ctAddr').addEventListener('input', checkContactAddr);
$('ctAddr2').addEventListener('input', checkContactAddr);
$('ctPaste').onclick = async () => {
  try {
    $('ctAddr').value = cleanAddress(await navigator.clipboard.readText());
    checkContactAddr();
  } catch {
    $('ctAddr').focus();
  }
};

$('ctSave').onclick = async () => {
  err('ctErr');
  const b = $('ctSave');
  busy(b, true);
  try {
    contacts = await call('saveContact', { id: editing?.id, name: $('ctName').value, addresses: [cleanAddress($('ctAddr').value), cleanAddress($('ctAddr2').value)] });
    closeSheet();
    renderContacts();
    renderHistory();
    toast(t('ct.saved'));
  } catch (e) {
    err('ctErr', e.message === 'NAME_REQUIRED' ? t('ct.needName') : e.message === 'DUPLICATE' ? t('ct.dup') : `${t('send.badAddr')}: ${e.message}`);
  } finally {
    busy(b, false);
  }
};

$('ctDelete').onclick = async () => {
  if (!editing || !confirm(t('ct.confirmDelete', { n: editing.name }))) return;
  contacts = await call('deleteContact', { id: editing.id });
  closeSheet();
  renderContacts();
  renderHistory();
};

$('addContact').onclick = () => openContact(null);

function renderPick() {
  const q = $('pickSearch').value.trim().toLowerCase();
  const list = $('pickList');
  list.textContent = '';
  const found = contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || contactAddresses(c).some((a) => a.address.includes(q)));
  if (!found.length) {
    const li = document.createElement('li');
    li.className = 'empty-card';
    li.textContent = contacts.length ? t('ct.noMatch') : t('ct.empty');
    list.append(li);
    return;
  }
  for (const c of found.flatMap((c) => contactAddresses(c).map((a) => ({ ...c, ...a, addresses: [a] })))) {
    list.append(
      contactRow(c, (x) => {
        $('sendTo').value = x.address;
        openSheet('send');
        checkRecipient();
        setTimeout(() => $('sendAmount').focus(), 320);
      }),
    );
  }
}
$('pickTo').onclick = () => {
  $('pickSearch').value = '';
  renderPick();
  openSheet('pick');
};
$('pickSearch').addEventListener('input', renderPick);

// ------------------------------------------------------------- settings ---

async function openSettings() {
  app = await call('state');
  const s = app.settings;
  applyTheme(s.theme);
  $('setCurrency').value = s.currency || 'usdt';
  $('setLanguage').value = s.language || 'auto';
  $('setKind').value = s.addressKind || 'generation';
  $('setNotif').checked = s.notifications !== false;
  $('setPrices').checked = s.priceLookup !== false;
  $('setLock').value = String(s.autoLockMinutes || 15);
  if (!$('setLock').value) $('setLock').value = '15';
  $('versionLine').textContent = t('set.version', { v: VERSION });
  renderTor(app.tor);
  showScreen('settings');
  renderPcSummary();
  renderMoreNav();
}

/** The hints of the "Coins and addresses" rows. */
async function renderMoreNav() {
  try {
    const w = await call('watchList');
    $('watchNavHint').textContent = w.list.length ? t('watch.navSome', { n: w.list.length }) : t('watch.navNone');
  } catch {
    $('watchNavHint').textContent = t('watch.navNone');
  }
  try {
    renderArchNav(await call('archiveStatus'));
  } catch {
    /* status shows on the next open */
  }
}

function archPct(a) {
  return a.target ? Math.min(100, Math.floor((100 * (a.height || 0)) / a.target)) : 0;
}

function renderArchNav(a) {
  const light = $('archNavLight');
  if (!a.on) {
    light.dataset.s = 'off';
    $('archNavHint').textContent = t('arch.navOff');
  } else if (a.state === 'error') {
    light.dataset.s = 'bad';
    $('archNavHint').textContent = t('arch.navError');
  } else if (a.state === 'ready') {
    light.dataset.s = 'ok';
    $('archNavHint').textContent = t('arch.navReady', { size: fmtBytes(a.size || 0) });
  } else {
    light.dataset.s = 'info';
    $('archNavHint').textContent = t('arch.navBuilding', { p: archPct(a) });
  }
}

// ------------------------------------------------------- waiting jobs ---
// An action that may wait for the sync to pause shows why it waits, and can
// be cancelled. A cancelled job changes nothing; the button is free again.

const jobHandlers = new Map(); // jobId -> progress callback

function newJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run `cmd` as a job. Returns `{ data }`, `{ cancelled: true }`, or
 * `{ cancelled: true, late: data }` when it finished just as it was cancelled.
 */
async function runJob({ cmd, args = {}, btn, cancelBtn, line, onProgress, waitAfterMs = 900 }) {
  const jobId = newJobId();
  let done = false;
  let byUser = false;
  const finish = () => {
    done = true;
    clearTimeout(timer);
    busy(btn, false);
    cancelBtn.hidden = true;
    jobHandlers.delete(jobId);
  };
  busy(btn, true);
  line.textContent = '';
  line.hidden = true;
  const timer = setTimeout(() => {
    if (done) return;
    cancelBtn.hidden = false;
    line.hidden = false;
    if (!line.textContent) line.textContent = t('job.waiting');
  }, waitAfterMs);
  jobHandlers.set(jobId, (m) => {
    if (m.phase === 'waiting') line.textContent = t('job.waiting');
    else if (m.phase === 'saving') line.textContent = t('job.saving');
    onProgress?.(m);
  });
  cancelBtn.onclick = () => {
    if (done) return;
    byUser = true;
    finish();
    line.hidden = false;
    line.textContent = t('job.cancelled');
    call('cancelJob', { jobId }).catch(() => {});
  };
  try {
    const data = await call(cmd, { ...args, jobId });
    if (byUser) return { cancelled: true, late: data };
    finish();
    line.hidden = true;
    return { data };
  } catch (e) {
    if (byUser) return { cancelled: true };
    finish();
    if (/CANCELLED/.test(String(e.message))) {
      line.hidden = false;
      line.textContent = t('job.cancelled');
      return { cancelled: true };
    }
    throw e;
  }
}

function fmtDuration(ms) {
  if (!(ms > 0) || !Number.isFinite(ms)) return '—';
  const min = Math.round(ms / 60_000);
  if (min < 1) return t('time.lessMin');
  if (min < 60) return t('time.min', { n: min });
  return t('time.h', { h: Math.floor(min / 60), m: min % 60 });
}

/** Status updates arrive often during a scan: refresh an open screen at most every 1.5 s. */
let refreshTimer = null;
function refreshOpenScreen() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (!$('v-archive').hidden) renderArchive().catch(() => {});
    if (!$('v-watch').hidden) renderWatch().catch(() => {});
    if (!$('v-home').hidden || currentScreen.startsWith('private')) refreshHome().catch(() => {});
    if (!$('v-claim').hidden) renderAssetRecovery();
    if (['payment-codes','recovery-options'].includes(currentScreen)) renderWaiting().catch(() => {});
  }, 1500);
}

// ----------------------------------------------------------- watch-only ---

function watchErr(e) {
  const m = String(e?.message || e);
  if (/receiving address/.test(m)) return t('watch.errAddress');
  if (/spend key|hex/.test(m)) return t('watch.errSpend');
  if (/already watched/.test(m)) return t('watch.errTwice');
  if (/too many/.test(m)) return t('watch.errMany');
  if (/viewing key|viewing address/.test(m)) return t('watch.errKey');
  return m;
}

let watchFrom = 'start';
function clearWatchSecrets() {
  $('watchForm').reset(); watchFrom = 'start';
  $('watchFromBlock').hidden = true;
  for (const b of document.querySelectorAll('#watchFromSeg button')) b.classList.toggle('on', b.dataset.from === 'start');
  $('vkPw').value = ''; $('vkOut').textContent = ''; $('vkOut').hidden = true;
}

async function openWatch(origin = currentScreen === 'settings' ? 'settings' : 'home') {
  watchOrigin = origin;
  showScreen('watch');
  $('vkOut').hidden = true; $('vkOut').textContent = ''; $('vkPw').value = '';
  $('vkForm').hidden = activeMode(app.settings)==='encrypted'; err('vkErr');
  $('vkScope').textContent=t(activeMode(app.settings)==='encrypted'?'assets.viewUnsupported':'assets.viewCurrent');
  const selected = $('watchContact').value;
  await loadContacts();
  $('watchContact').replaceChildren(new Option(t('watch.noContact'), ''));
  for (const contact of contacts) $('watchContact').add(new Option(contact.name, contact.id));
  $('watchContact').value = selected;
  renderWatchMode();
  await renderWatch();
  if (watchFocus != null) {
    const card = document.querySelector(`[data-watch-id="${watchFocus}"]`);
    card?.scrollIntoView({ block: 'center' }); card?.focus(); watchFocus = null;
  }
}
$('watchBack').onclick = () => watchOrigin === 'settings' ? openSettings() : boot();
$('watchShowHidden').onchange = () => renderWatch();
$('watchRetry').onclick = () => { call('sync').catch((e) => err('watchScanError', e)); };
$('watchContact').onchange = () => {
  const contact = contacts.find((c) => c.id === $('watchContact').value);
  if (contact) $('watchLabel').value = contact.name;
};
function renderWatchMode() {
  const mode = $('watchMode').value;
  $('watchNodeField').hidden = mode !== 'node';
  $('watchModeHint').textContent = t(mode === 'private' ? 'watch.privateHint' : mode === 'node' ? 'watch.ownHint' : 'watch.fastHint');
}
$('watchMode').onchange = renderWatchMode;
const renderWatch = singleFlight(async () => {
  let w;
  try { w = await call('watchList'); } catch (e) { err('watchScanError', e); return; }
  const list = $('watchList'); list.textContent = '';
  const shown = visibleWatch(w.list, $('watchShowHidden').checked);
  $('watchEmpty').hidden = shown.length > 0;
  // Rendering progress must never collapse or reset an unfinished form.
  if (!w.list.length) $('watchAddBox').open = true;
  const p = $('watchProgress'); p.hidden = !w.behind;
  if (w.behind) p.textContent = t('watch.scanning', { a: fmtNum(w.behind.at), b: fmtNum(w.behind.end) });
  err('watchScanError', w.error || ''); $('watchRetry').hidden = !w.error;
  for (const a of shown) list.append(watchCard(a, w.height));
});

function watchCard(a, height) {
  const card = document.createElement('article');
  card.className = 'w-card'; card.dataset.watchId = a.id; card.tabIndex = -1;
  const head = document.createElement('header');
  const name = document.createElement('b');
  name.textContent = a.label || shortAddr(a.key_short, 10, 4);
  const kind = document.createElement('span');
  kind.className = 'w-kind';
  kind.textContent = a.kind === 'ec-hybrid' ? t('kind.ecHybridShort') : a.kind === 'generation' ? t('kind.generationShort') : 'Viewing';
  head.append(name, kind);

  const nums = document.createElement('div');
  nums.className = 'w-nums';
  const cell = (label, value, dim) => {
    const c = document.createElement('div');
    const l = document.createElement('small');
    l.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    if (dim) v.className = 'dim';
    c.append(l, v);
    return c;
  };
  nums.append(cell(t('watch.received'), amountText(a.received, ' NPT')));
  nums.append(a.unspent != null ? cell(t('watch.unspent'), amountText(a.unspent, ' NPT')) : cell(t('watch.unspent'), '—', true));

  const meta = document.createElement('small');
  meta.className = 'w-meta';
  meta.textContent = `${accountStatus(a, height)} · ${watchModeText(a)}`;
  if (a.warning) meta.textContent += ` · ${t(a.warning)}`;
  if (!a.sees_spends) meta.textContent += ` · ${t('watch.noSpends')}`;

  const coins = document.createElement('ul');
  coins.className = 'w-coins';
  if (!a.coins.length) {
    const li = document.createElement('li');
    li.className = 'dim';
    li.textContent = t('watch.noCoins');
    coins.append(li);
  }
  for (const c of a.coins.slice(0, 6)) {
    const li = document.createElement('li');
    const amt = document.createElement('b');
    amt.textContent = amountText(c.amount, ' NPT');
    const sub = document.createElement('small');
    const bits = [c.received_ms ? fmtDate(c.received_ms) : t('watch.coinBlock', { h: fmtNum(c.received_height) })];
    if (c.timelocked_now && c.release_ms) bits.push(t('watch.coinLocked', { d: new Date(c.release_ms).toLocaleDateString(lang()) }));
    if (c.spent_height != null) bits.push(t('watch.coinSpent', { h: fmtNum(c.spent_height) }));
    sub.textContent = bits.join(' · ');
    if (c.spent_height != null) li.className = 'spent';
    li.append(amt, sub);
    coins.append(li);
  }

  const rm = document.createElement('button');
  rm.className = 'btn plain danger-text w-rm';
  rm.textContent = t('watch.remove');
  rm.onclick = async () => {
    if (!rm.dataset.armed) {
      rm.dataset.armed = '1';
      rm.textContent = t('watch.removeAgain');
      setTimeout(() => {
        delete rm.dataset.armed;
        rm.textContent = t('watch.remove');
      }, 3000);
      return;
    }
    busy(rm, true);
    try {
      await call('watchRemove', { id: a.id });
      await renderWatch();
      await refreshHome();
    } catch (e) {
      toast(String(e.message || e));
      busy(rm, false);
    }
  };
  const controls = document.createElement('div'); controls.className = 'watch-controls';
  const updateButton = (label, patch) => {
    const button = document.createElement('button'); button.className = 'chip'; button.textContent = label;
    button.onclick = async () => {
      busy(button, true);
      try { await call('watchUpdate', { id: a.id, ...patch }); await renderWatch(); await refreshHome(); }
      catch (e) { toast(String(e.message || e)); } finally { busy(button, false); }
    };
    return button;
  };
  controls.append(updateButton(t(a.paused ? 'watch.resume' : 'watch.pause'), { paused: !a.paused }),
    updateButton(t(a.hidden ? 'watch.unhide' : 'watch.hide'), { hidden: !a.hidden }));
  card.append(head, nums, meta, watchProgressBar(a, height), controls, coins, rm);
  return card;
}

for (const b of document.querySelectorAll('#watchFromSeg button')) {
  b.onclick = () => {
    watchFrom = b.dataset.from;
    for (const x of document.querySelectorAll('#watchFromSeg button')) x.classList.toggle('on', x === b);
    $('watchFromBlock').hidden = watchFrom !== 'block';
    if (watchFrom === 'block') $('watchFromBlock').focus();
  };
}

$('watchForm').onsubmit = async (ev) => {
  ev.preventDefault();
  err('watchErr');
  const label = $('watchLabel').value.trim();
  const from = watchFrom === 'block' ? $('watchFromBlock').value : watchFrom;
  const mode = $('watchMode').value;
  try {
    if (mode === 'node') {
      const url = new URL($('watchNodeUrl').value.trim());
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) throw new Error(t('watch.nodePermission'));
    }
    const r = await runJob({
      cmd: 'watchAdd',
      args: { label, viewingKey: $('watchKey').value.trim(), spendKey: $('watchSpend').value.trim(), from, mode, nodeUrl: $('watchNodeUrl').value.trim(), contactId: $('watchContact').value },
      btn: $('watchGo'), cancelBtn: $('watchCancel'), line: $('watchWait'),
    });
    if (r.cancelled && !r.late) return; // the form keeps what was typed: try again
    toast(t('watch.added', { l: label || t('watch.title') }));
    $('watchForm').reset();
    watchFrom = 'start';
    for (const x of document.querySelectorAll('#watchFromSeg button')) x.classList.toggle('on', x.dataset.from === 'start');
    $('watchFromBlock').hidden = true; renderWatchMode();
    $('watchWait').hidden = true;
    $('watchAddBox').open = false;
    await renderWatch(); await refreshHome();
  } catch (e) {
    err('watchErr', watchErr(e));
  }
};

$('vkForm').onsubmit = async (ev) => {
  ev.preventDefault();
  err('vkErr');
  busy($('vkGo'), true);
  const epoch=secretEpoch;
  try {
    const keys = await call('viewingKeys', { password: $('vkPw').value });
    if(epoch!==secretEpoch||currentScreen!=='watch'||!app?.unlocked)return;
    $('vkPw').value = '';
    $('vkForm').hidden = true;
    const out = $('vkOut');
    out.textContent = '';
    for (const [kind, k] of [['generation', keys.generation], ['ec-hybrid', keys.ec_hybrid]]) out.append(vkBlock(kind, k));
    out.hidden = false;
  } catch (e) {
    err('vkErr', /password/i.test(String(e.message)) ? t('unlock.wrong') : e);
  } finally {
    $('vkPw').value='';
    busy($('vkGo'), false);
  }
};

function vkBlock(kind, k) {
  const box = document.createElement('div');
  box.className = 'vk-box';
  const h = document.createElement('b');
  h.textContent = kindLabel(kind);
  const code = document.createElement('code');
  code.className = 'mono vk-code';
  code.textContent = k.viewing_key;
  const copy = document.createElement('button');
  copy.className = 'btn soft';
  copy.innerHTML = '<svg><use href="#i-copy"/></svg>';
  const label = document.createElement('span');
  label.textContent = t('recv.copy');
  copy.append(label);
  copy.onclick = () => copySecret(k.viewing_key);
  const spendBtn = document.createElement('button');
  spendBtn.className = 'btn plain';
  spendBtn.textContent = t('watch.spendShow');
  spendBtn.onclick = () => {
    const warn = document.createElement('p');
    warn.className = 'hint small warn-text';
    warn.textContent = t('watch.spendWarn');
    const sc = document.createElement('code');
    sc.className = 'mono vk-code';
    sc.textContent = k.spend_key;
    const c2 = document.createElement('button');
    c2.className = 'btn soft';
    c2.innerHTML = '<svg><use href="#i-copy"/></svg>';
    const l2 = document.createElement('span');
    l2.textContent = t('recv.copy');
    c2.append(l2);
    c2.onclick = () => copySecret(k.spend_key);
    spendBtn.replaceWith(warn, sc, c2);
  };
  box.append(h, code, copy, spendBtn);
  return box;
}

// ------------------------------------------------------ registered coins ---

function claimErr(e) {
  const m = String(e?.message || e);
  if (/another sub-wallet/i.test(m)) return t('codes.otherProfile');
  if (/another wallet|no key of this wallet/i.test(m)) return t('claim.errOther');
  if (/not a payment notification/i.test(m)) return t('claim.errNotCode');
  return m;
}

let claimShown = null, claimRevision = 0, claimCheckPending = false, waitingRequest = 0;
let assetRecoveryReturn = 'settings', assetRecoveryProfile = 'standard';

function clearClaimReview(clearText=false) {
  claimRevision++; claimShown=null;
  if(clearText)$('claimText').value='';
  $('claimCard').hidden=true;
  for(const id of ['claimAmount','claimLock','claimTo','claimStatus'])$(id).textContent='';
  $('claimRead').disabled=claimCheckPending||!$('claimText').value.trim();
  err('claimErr');
}
function claimContext() {
  return {epoch:secretEpoch,revision:claimRevision,page:currentScreen,walletMode:assetRecoveryProfile,networkContext:app?.settings?.network};
}
function claimCurrent(c, review=true) {
  return app?.unlocked && c.epoch===secretEpoch && (!review||c.revision===claimRevision) && c.page===currentScreen && c.walletMode===activeMode(app.settings) && c.networkContext===app.settings.network;
}
function claimArgs(c) {return {walletMode:c.walletMode,networkContext:c.networkContext};}
$('claimText').oninput=()=>clearClaimReview();

async function openClaim() {
  assetRecoveryReturn=currentScreen;
  assetRecoveryProfile=activeMode(app.settings);
  const mode=app.settings.recoveryModes?.[assetRecoveryProfile] || (assetRecoveryProfile==='standard'?'fast':'private');
  for(const r of document.querySelectorAll('input[name="assetRecoveryMode"]'))r.checked=r.value===mode;
  $('assetNodeField').hidden=mode!=='node';
  const server=app.settings.servers?.[app.settings.network]?.sync;
  $('assetNodeUrl').value=isLocalUrl(server)?server:'http://127.0.0.1:9797/';
  err('assetRecoveryError');renderAssetRecovery();showScreen('claim');
}

function selectedRecoveryStatus() {
  const st=app?.status||{};
  return (st.recoveryWallet===assetRecoveryProfile||(!st.recoveryWallet&&st.restored&&assetRecoveryProfile==='standard'))?st:app?.recoveries?.[assetRecoveryProfile]||{};
}
let recoveryRequest=false;
function renderAssetRecovery() {
  const st=selectedRecoveryStatus(),h=Number(st.height||0),tip=Number(st.tip||h),start=Number(st.startHeight||0);
  const selected=document.querySelector('input[name="assetRecoveryMode"]:checked')?.value||'private';
  const owns=(app?.status?.recoveryWallet||'standard')===assetRecoveryProfile&&Boolean(app?.status?.recoveryMode);
  const failed=Boolean(st.error||st.serverOk===false);
  const running=owns&&!st.scanPaused&&!failed&&Boolean(st.fastPending||st.fastPhase||(st.syncing&&st.recoveryMode));
  $('assetRecoveryWallet').textContent=t(`modes.${assetRecoveryProfile}`);
  $('assetEncryptedRecovery').hidden=assetRecoveryProfile!=='encrypted';
  $('assetRecoveryBar').style.width=`${Math.round(tip>start?Math.max(0,Math.min(1,(h-start)/(tip-start)))*100:100)}%`;
  $('assetRecoveryStatus').textContent=st.scanPaused?t('assets.paused'):failed?String(st.error||t('status.unreachable')):!st.recoveryMode?t('assets.notStarted'):st.fastPending||st.fastPhase?t('rm.running',{n:st.fastFound||0}):st.fastFailed?`${t('assets.fallback')} · ${t('assets.progress',{h:fmtNum(h),t:fmtNum(tip)})}`:t('assets.progress',{h:fmtNum(h),t:fmtNum(tip)});
  if(running&&st.recoveryMode){const label=t(st.fastFailed?'assets.private':st.recoveryMode==='fast'?'rm.fast':st.recoveryMode==='node'?'assets.node':'assets.private');$('assetRecoveryStatus').textContent=`${label} · ${$('assetRecoveryStatus').textContent}`;}
  $('assetRecover').disabled=recoveryRequest||(running&&selected===st.recoveryMode);
  $('assetRecover').textContent=t(owns&&st.scanPaused&&selected===st.recoveryMode?'assets.resume':running&&selected!==st.recoveryMode?'assets.switch':'assets.start');
  $('assetPause').hidden=!owns||st.scanPaused||!(st.fastPending||st.fastPhase||st.syncing);
  $('assetPause').disabled=recoveryRequest;
}
async function recoveryCall(cmd,args) {
  let timer;
  try{return await Promise.race([call(cmd,args),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(t('assets.controlTimeout'))),30000);})]);}
  finally{clearTimeout(timer);}
}
async function recoveryControl(cmd) {
  const c=claimContext();recoveryRequest=true;renderAssetRecovery();err('assetRecoveryError');
  try {
    const result=await recoveryCall(cmd,claimArgs(c));
    if(!claimCurrent(c,false))return;
    app.status=result.status;app.recoveries=result.recoveries;renderAssetRecovery();
  }catch(e){if(claimCurrent(c,false))err('assetRecoveryError',e);}
  finally{recoveryRequest=false;renderAssetRecovery();}
}
$('assetPause').onclick=()=>recoveryControl('pauseRecovery');
$('assetRecoveryBack').onclick=()=>showScreen(assetRecoveryReturn);
let recoveryPreferenceVersion=0;
let recoveryPreferenceWrites=Promise.resolve();
async function rememberRecoveryMode(mode) {
  const c=claimContext(),version=++recoveryPreferenceVersion;
  app.settings.recoveryModes={...app.settings.recoveryModes,[c.walletMode]:mode};
  const request=recoveryPreferenceWrites.then(()=>call('setRecoveryMode',{...claimArgs(c),mode}));
  recoveryPreferenceWrites=request.catch(()=>{});
  try{const settings=await request;if(claimCurrent(c,false)&&version===recoveryPreferenceVersion)app.settings.recoveryModes=settings.recoveryModes;}
  catch(e){if(claimCurrent(c,false)&&version===recoveryPreferenceVersion)err('assetRecoveryError',e);}
}
for(const r of document.querySelectorAll('input[name="assetRecoveryMode"]'))r.onchange=()=>{
  $('assetNodeField').hidden=r.value!=='node'||!r.checked;
  if(r.checked)rememberRecoveryMode(r.value);
  renderAssetRecovery();
};
$('assetEncryptedRecovery').onclick=()=>openPrivatePage('recovery','encrypted');
$('assetRecover').onclick=async()=>{
  if(recoveryRequest)return;
  const button=$('assetRecover');err('assetRecoveryError');
  const mode=document.querySelector('input[name="assetRecoveryMode"]:checked')?.value||'private';
  // Resume an interrupted recovery of the same kind; do not erase its
  // checkpoint by starting another rescan just to retry the connection.
  const st=selectedRecoveryStatus();
  if((app.status?.recoveryWallet||'standard')===assetRecoveryProfile&&st.scanPaused&&st.recoveryMode===mode)return recoveryControl('resumeRecovery');
  if((app.status?.recoveryWallet||'standard')===assetRecoveryProfile&&(st.error||st.serverOk===false)&&st.recoveryMode===mode&&(st.fastPending||st.fastPhase||st.height<st.tip)) {
    await refreshAssetsNow();return;
  }
  let nodeUrl;
  if(mode==='node') {
    try{nodeUrl=new URL($('assetNodeUrl').value.trim()).href;}catch{return err('assetRecoveryError',t('rm.badUrl'));}
    const url=new URL(nodeUrl);
    if(!['http:','https:'].includes(url.protocol))return err('assetRecoveryError',t('rm.badUrl'));
    const granted=await chrome.permissions.request({origins:[`${url.protocol}//${url.hostname}/*`]}).catch(()=>false);
    if(!granted)return err('assetRecoveryError',t('srv.denied'));
  }
  recoveryRequest=true;busy(button,true);
  const context=claimContext();
  try{await recoveryCall('rescan',{birthday:0,mode,nodeUrl,walletMode:assetRecoveryProfile,networkContext:app.settings.network});const state=await recoveryCall('state');if(!claimCurrent(context,false))return;app=state;renderAssetRecovery();toast(t('assets.started'));}
  catch(e){if(claimCurrent(context,false))err('assetRecoveryError',e);}finally{recoveryRequest=false;busy(button,false);renderAssetRecovery();}
};


function openPaymentCodes() {
  clearClaimReview(true);
  $('paymentCodeWallet').textContent=t(`modes.${assetRecoveryProfile}`);
  $('claimWaitingPanel').open=false; $('claimWaiting').textContent=''; $('claimWaitingCount').textContent='0';
  $('claimAdopted').hidden=true; showScreen('payment-codes');renderWaiting();
}
function openRecoveryOptions() {
  $('claimOptionsWallet').textContent=t(`modes.${assetRecoveryProfile}`);
  $('claimPreminePanel').hidden=assetRecoveryProfile!=='standard';$('claimPreminePanel').open=false;
  $('claimFrom').value='';$('claimPremineOut').hidden=true;$('premineProg').hidden=true;
  err('claimOptionsError');showScreen('recovery-options');renderWaiting();
}
$('assetPaymentCodes').onclick=openPaymentCodes;
$('assetMoreOptions').onclick=openRecoveryOptions;
$('paymentCodesBack').onclick=$('recoveryOptionsBack').onclick=()=>showScreen('claim');

async function renderWaiting() {
  const ctx=claimContext(), request=++waitingRequest;
  let w;
  try {w=await call('waiting',claimArgs(ctx));}
  catch(e){if(claimCurrent(ctx,false))err(currentScreen==='payment-codes'?'claimErr':'claimOptionsError',e);return;}
  if(!claimCurrent(ctx,false)||request!==waitingRequest)return;
  $('claimPast').textContent=w.archive?t('claim.pastArchive'):t('claim.pastNoArchive');
  if(currentScreen!=='payment-codes')return;
  const ul=$('claimWaiting');ul.textContent='';$('claimWaitingCount').textContent=String(w.list.length);
  if(!w.list.length){const li=document.createElement('li');li.className='dim';li.textContent=t('claim.waitingEmpty');ul.append(li);}
  for(const c of w.list) {
    const li=document.createElement('li'),txt=document.createElement('span'),b=document.createElement('b'),sm=document.createElement('small');
    b.textContent=`${fmtAmt(c.amount)} NPT`;
    sm.textContent=c.release_ms?t('claim.lock',{d:new Date(c.release_ms).toLocaleDateString(lang())}):t('claim.noLock');txt.append(b,sm);
    const x=document.createElement('button');x.className='btn plain danger-text';x.textContent=t('codes.remove');
    const confirmation=document.createElement('div');confirmation.className='code-remove-confirm';confirmation.hidden=true;
    const explanation=document.createElement('p');explanation.textContent=t('codes.removeConfirm');
    const actions=document.createElement('div');actions.className='row2';
    const keep=document.createElement('button');keep.className='btn soft';keep.textContent=t('job.cancel');
    const remove=document.createElement('button');remove.className='btn soft danger-text';remove.textContent=t('codes.remove');
    x.onclick=()=>{if(claimCurrent(ctx,false)){confirmation.hidden=false;x.hidden=true;}};
    keep.onclick=()=>{confirmation.hidden=true;x.hidden=false;};
    remove.onclick=async()=>{
      if(!claimCurrent(ctx,false)||confirmation.hidden)return;
      busy(remove,true);keep.disabled=true;
      try{await call('claimRemove',{record:c.addition_record,...claimArgs(ctx)});if(claimCurrent(ctx,false))await renderWaiting();}
      catch(e){if(claimCurrent(ctx,false))toast(String(e.message||e));}
      finally{busy(remove,false);keep.disabled=false;}
    };
    actions.append(keep,remove);confirmation.append(explanation,actions);li.append(txt,x,confirmation);ul.append(li);
  }
  const ad=w.lastAdopted?.list?.filter(x=>!x.spent)||[];
  $('claimAdopted').hidden=!ad.length;
  $('claimAdopted').textContent=ad.map(x=>t('claim.adopted',{n:fmtAmt(x.amount),h:fmtNum(x.height)})).join('\n');
}

$('claimRead').onclick=async()=>{
  if(claimCheckPending)return;
  clearClaimReview();
  const text=$('claimText').value.trim();if(!text)return;
  const ctx=claimContext();claimCheckPending=true;busy($('claimRead'),true);
  try {
    const c=await call('claimCheck',{text,...claimArgs(ctx)});
    if(!claimCurrent(ctx)||$('claimText').value.trim()!==text)return;
    claimShown={text,context:ctx};
    $('claimAmount').textContent=`${fmtAmt(c.amount)} NPT`;
    $('claimLock').textContent=c.release_ms?t('claim.lock',{d:new Date(c.release_ms).toLocaleDateString(lang())}):t('claim.noLock');
    $('claimTo').textContent=t('claim.to',{k:c.key_kind==='change'?t('kind.change'):kindLabel(c.key_kind)});
    $('claimStatus').textContent={new:t('claim.statusNew'),waiting:t('claim.statusWaiting'),owned:t('claim.statusOwned')}[c.status]||'';
    $('claimStatus').dataset.s=c.status;$('claimGo').hidden=c.status!=='new';$('claimCard').hidden=false;
  } catch(e){if(claimCurrent(ctx))err('claimErr',claimErr(e));}
  finally{claimCheckPending=false;busy($('claimRead'),false);$('claimRead').disabled=!$('claimText').value.trim();}
};

$('claimGo').onclick=async()=>{
  const shown=claimShown;if(!shown||!claimCurrent(shown.context)||$('claimText').value.trim()!==shown.text)return;
  try {
    const r=await runJob({cmd:'claimRegister',args:{text:shown.text,...claimArgs(shown.context)},btn:$('claimGo'),cancelBtn:$('claimCancel'),line:$('claimWait')});
    if((r.cancelled&&!r.late)||!claimCurrent(shown.context))return;
    const result=r.data??r.late;
    toast(t(result?.status==='owned'?'claim.statusOwned':result?.status==='waiting'?'claim.statusWaiting':'claim.registered'));
    clearClaimReview(true);await renderWaiting();$('claimWaitingPanel').open=true;
  }catch(e){if(claimCurrent(shown.context))err('claimErr',claimErr(e));}
};

async function rescanFrom(height) {
  const ctx=claimContext();if(!Number.isSafeInteger(Number(height))||Number(height)<0){err('claimOptionsError',t('codes.badBlock'));return;}
  busy($('claimRescan'),true);busy($('claimRescanStart'),true);err('claimOptionsError');
  try {
    const r=await call('rescan',{birthday:privateRecoveryStart(height),mode:'private',rememberMode:false,...claimArgs(ctx)});
    if(!claimCurrent(ctx))return;
    const next=await call('state');if(!claimCurrent(ctx))return;app=next;
    renderAssetRecovery();showScreen('claim');toast(t('claim.rescanned',{h:fmtNum(r.start)}));
  }catch(e){if(claimCurrent(ctx))err('claimOptionsError',e);}
  finally{busy($('claimRescan'),false);busy($('claimRescanStart'),false);}
}
$('claimRescan').onclick=()=>{const v=$('claimFrom').value.trim();if(v===''){err('claimOptionsError',t('codes.badBlock'));$('claimFrom').focus();return;}return rescanFrom(v);};
$('claimRescanStart').onclick=()=>rescanFrom(0);

$('claimPremine').onclick=async()=>{
  const ctx=claimContext();if(ctx.walletMode!=='standard')return;
  const prog=$('premineProg'),out=$('claimPremineOut');out.hidden=true;$('premineBar').style.width='2%';prog.hidden=false;err('claimOptionsError');
  try {
    const r=await runJob({cmd:'findPremine',args:claimArgs(ctx),btn:$('claimPremine'),cancelBtn:$('premineCancel'),line:$('premineLine'),waitAfterMs:0,onProgress:m=>{
      if(!claimCurrent(ctx))return;
      if(m.phase==='genesis'){$('premineLine').textContent=t('claim.premineGenesis');$('premineBar').style.width='4%';}
      else if(m.phase==='keys'){const p=Math.round(100*m.done/m.total);$('premineLine').textContent=t('claim.premineKeys',{i:m.done,p});$('premineBar').style.width=`${Math.max(4,p)}%`;}
    }});
    if(!claimCurrent(ctx))return;
    if(r.cancelled&&!r.late){$('premineBar').style.width='0%';return;}
    const res=r.data??r.late;prog.hidden=true;out.textContent=!res.found?t('claim.premineNone'):res.archive?t('claim.premineArchive',{n:res.found}):t('claim.premineScan',{n:res.found});out.hidden=false;
  }catch(e){if(claimCurrent(ctx)){prog.hidden=true;err('claimOptionsError',e);}}
};

// -------------------------------------------------------- local archive ---

async function openArchive() {
  showScreen('archive');
  $('archChecked').textContent = '';
  err('archErr');
  await renderArchive();
}

async function renderArchive(given) {
  let a = given;
  if (!a) {
    try {
      a = await call('archiveStatus');
    } catch (e) {
      err('archErr', e);
      return;
    }
  }
  $('setArchive').checked = a.on;
  const hero = $('archHero');
  const state = !a.on ? 'off' : a.state === 'error' ? 'error' : a.state === 'ready' ? 'ready' : 'building';
  hero.dataset.state = state;
  $('archArc').style.strokeDashoffset = String(100 - (state === 'ready' ? 100 : state === 'building' ? archPct(a) : 0));
  if (state === 'off') {
    $('archHeroTitle').textContent = t('arch.heroOff');
    $('archHeroSub').textContent = t('arch.heroOffSub');
  } else if (state === 'error') {
    $('archHeroTitle').textContent = t('arch.heroError');
    $('archHeroSub').textContent = a.error || '';
  } else if (state === 'ready') {
    $('archHeroTitle').textContent = t('arch.heroReady');
    $('archHeroSub').textContent = t('arch.heroReadySub', { h: fmtNum(a.height || 0), size: fmtBytes(a.size || 0) });
  } else {
    $('archHeroTitle').textContent = t('arch.heroBuilding');
    $('archHeroSub').textContent = a.target ? t('arch.heroBuildingSub', { a: fmtNum(a.height || 0), b: fmtNum(a.target) }) : '';
  }
  $('archLag').textContent = t('arch.lag', { n: a.lag || 10 });
  $('archCheck').hidden = state !== 'ready';
  renderArchNav(a);

  // What it will take, and from what.
  const est = a.estimate;
  $('archEstimate').textContent = est ? t('arch.estimate', { size: fmtBytes(est.bytes) }) : t('arch.switchHint');
  $('archHow').textContent = est
    ? `${t('arch.how', { leaves: fmtNum(est.leaves), spends: fmtNum(est.spends), chunks: fmtNum(est.chunks) })} ${est.spendsExact ? t('arch.howExact') : est.spendsSampled ? t('arch.howSampled') : t('arch.howGuess')} ${t('arch.switchHint')}`
    : t('arch.switchHint');

  // The numbers while it builds, and once it is ready.
  const facts = $('archFacts');
  facts.textContent = '';
  if (state === 'off') {
    facts.hidden = true;
    return;
  }
  const row = (k, v) => {
    if (v == null || v === '') return;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    facts.append(dt, dd);
  };
  const pct = state === 'ready' ? 100 : archPct(a);
  row(t('arch.fProgress'), `${pct}%`);
  if (a.target) row(t('arch.fBlocks'), `${fmtNum(a.height || 0)} / ${fmtNum(a.target)}`);
  if (state === 'building' && a.rate) {
    row(t('arch.fSpeed'), t('arch.speedVal', { n: fmtNum(a.rate) }));
    row(t('arch.fLeft'), fmtDuration((((a.target || 0) - (a.height || 0)) / a.rate) * 60_000));
  }
  if (a.leaves) row(t('arch.fCoins'), fmtNum(a.leaves));
  if (a.size) row(t('arch.fStored'), fmtBytes(a.size));
  if (state === 'building' && est) row(t('arch.fTotal'), `≈ ${fmtBytes(est.bytes)}`);
  if (a.downloaded) row(t('arch.fDown'), fmtBytes(a.downloaded));
  if (a.checkedAt) row(t('arch.fChecked'), `${fmtDate(a.checkedAt)} · #${fmtNum(a.checkedHeight || 0)}`);
  try {
    const q = await navigator.storage?.estimate?.();
    if (q?.usage != null && q?.quota) row(t('arch.fDevice'), t('arch.deviceVal', { used: fmtBytes(q.usage), quota: fmtBytes(q.quota) }));
  } catch {
    /* not available here */
  }
  facts.hidden = facts.childElementCount === 0;
}

$('setArchive').onchange = async () => {
  const on = $('setArchive').checked;
  try {
    await call('archiveSet', { on });
  } catch (e) {
    err('archErr', e);
  }
  await renderArchive();
};

$('archCheck').onclick = async () => {
  busy($('archCheck'), true);
  $('archChecked').textContent = t('arch.checking');
  try {
    const r = await call('archiveCheck');
    $('archChecked').textContent = t('arch.checked', { h: fmtNum(r.height) });
  } catch (e) {
    $('archChecked').textContent = '';
    err('archErr', e);
  } finally {
    busy($('archCheck'), false);
  }
};

// ------------------------------------------------------------------ tor ---

let torInfo = null;

/** Light, hint and app colour for the Tor state. */
function renderTor(tor) {
  const prev = torInfo?.state;
  // Status messages carry no host list; keep the last one.
  torInfo = { hosts: torInfo?.hosts, ...(tor || { state: 'off' }) };
  const on = Boolean(app?.settings?.tor);
  const st = on ? torInfo.state : 'off';
  document.documentElement.dataset.tor = st;
  const light = { on: 'ok', connecting: 'wait', error: 'bad', off: 'off' }[st] || 'off';
  $('torLight').dataset.s = light;
  $('torNavLight').dataset.s = light;
  $('setTor').checked = on;
  $('setTorPort').value = String(app?.settings?.torPort || 9150);
  let hint = t('tor.hintOff');
  if (st === 'on') hint = t('tor.hintOn', { p: torInfo.port || app.settings.torPort });
  else if (st === 'connecting') hint = t('tor.hintConnecting', { p: torInfo.port || app.settings.torPort });
  else if (st === 'error') {
    hint = {
      NO_TOR: t('tor.errNoTor', { p: torInfo.port || app.settings.torPort }),
      NOT_TOR: t('tor.errNotTor'),
      OTHER_PROXY: t('tor.errOther'),
      NO_PERMISSION: t('tor.errPermission'),
      POLICY: t('tor.errPolicy'),
      PROXY_ERROR: t('tor.errProxy'),
    }[torInfo.error] || t('tor.errNoTor', { p: torInfo.port || app.settings.torPort });
  }
  $('torHint').textContent = hint;
  $('torNavHint').textContent = { on: t('tor.navOn'), connecting: t('tor.navConnecting'), error: t('tor.navError'), off: t('tor.navOff') }[st];

  // Home: the onion button, and a banner whenever Tor is turned on.
  $('torBtn').dataset.state = st;
  const banner = $('torBanner');
  // Connected: the pill turns Tor purple, no banner needed. Not connected:
  // a banner, because the wallet is paused.
  banner.hidden = !on || st === 'on';
  banner.dataset.state = st;
  $('torBannerTitle').textContent = { on: t('tor.bannerOn'), connecting: t('tor.bannerConnecting'), error: t('tor.bannerError') }[st] || '';
  $('torBannerSub').textContent = { on: t('tor.bannerOnSub'), connecting: t('tor.bannerConnectingSub'), error: t('tor.bannerErrorSub') }[st] || '';

  // Tor screen
  $('torHero').dataset.state = st;
  $('torHeroTitle').textContent = { on: t('tor.heroOn'), connecting: t('tor.heroConnecting'), error: t('tor.heroError'), off: t('tor.heroOff') }[st];
  $('torHeroSub').textContent = hint;
  $('torChecked').textContent = on && torInfo.at ? t('tor.lastCheck', { time: new Date(torInfo.at).toLocaleTimeString(lang()) }) : '';
  const hosts = $('torHosts');
  hosts.textContent = '';
  for (const h of torInfo.hosts || []) {
    const li = document.createElement('li');
    li.dataset.state = st === 'on' ? 'ok' : on ? 'info' : 'wait';
    li.textContent = h;
    hosts.append(li);
  }
  // Only a live change from "connecting" gets the moment, not opening the popup.
  if (st === 'on' && prev === 'connecting') {
    const row = $('torRow');
    row.classList.remove('just-on');
    void row.offsetWidth;
    row.classList.add('just-on');
    toast(t('tor.connected'));
  }
}

$('setTor').onchange = async () => {
  const want = $('setTor').checked;
  if (want) renderTor({ state: 'connecting', port: Number($('setTorPort').value) });
  await savePref({ tor: want, torPort: Number($('setTorPort').value) });
  try {
    renderTor(await call('torStatus'));
  } catch {
    /* the status message will follow */
  }
  renderPcSummary();
};

$('setTorPort').onchange = async () => {
  await savePref({ torPort: Number($('setTorPort').value) });
  renderTor(await call('torStatus').catch(() => torInfo));
};

let torFrom = 'settings';
async function openTor(from = 'settings') {
  torFrom = from;
  if (!app?.settings) app = await call('state');
  renderTor(await call('torStatus').catch(() => torInfo));
  showScreen('tor');
}
$('torBtn').onclick = () => openTor('home');
$('torBanner').onclick = () => openTor('home');
document.querySelector('.tor-back').onclick = () => (torFrom === 'home' ? boot() : openSettings());
$('torCheck').onclick = async () => {
  const b = $('torCheck');
  busy(b, true);
  try {
    renderTor(await call('checkTor'));
  } finally {
    busy(b, false);
  }
};
$('copyTorCmd').onclick = async () => {
  await navigator.clipboard.writeText($('torCmd').textContent);
  toast(t('node.copied'));
};

// -------------------------------------------------------- privacy check ---

/** Every privacy setting and fact the wallet knows, each with a light:
 *  ok (protected), info (worth knowing), warn (to improve), bad (broken). */
function privacyChecks() {
  const s = app?.settings || {};
  const srv = s.servers?.[s.network] || {};
  const host = (u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return '';
    }
  };
  const local = (u) => ['localhost', '127.0.0.1'].includes(host(u));
  const ownNode = local(srv.sync) && local(srv.broadcast);
  const tor = s.tor ? (torInfo?.state || 'off') : 'off';
  const torOk = tor === 'on';
  const items = [];
  const add = (state, title, detail, go) => items.push({ state, title, detail, go });

  // Who sees your IP
  if (ownNode) add('ok', t('pc.ipTitle'), t('pc.ipNode'), 'servers');
  else if (s.tor && tor !== 'on') add('bad', t('pc.ipTitle'), t('pc.ipTorDown'), 'tor');
  else if (torOk) add('ok', t('pc.ipTitle'), t('pc.ipTor'), 'tor');
  else add('warn', t('pc.ipTitle'), t('pc.ipDirect'), 'tor');

  // One server for both syncing and sending
  if (ownNode) add('ok', t('pc.srvTitle'), t('pc.srvNode'), 'servers');
  else if (host(srv.sync) && host(srv.sync) === host(srv.broadcast)) add('warn', t('pc.srvTitle'), t('pc.srvSame'), 'servers');
  else add('ok', t('pc.srvTitle'), t('pc.srvSplit'), 'servers');

  // Price lookups
  const prices = s.priceLookup !== false && s.currency !== 'off';
  if (!prices) add('ok', t('pc.priceTitle'), t('pc.priceOff'), 'prices');
  else if (torOk) add('ok', t('pc.priceTitle'), t('pc.priceTor'), 'prices');
  else add('warn', t('pc.priceTitle'), t('pc.priceOn'), 'prices');

  // Coins: anonymity sets, exact count, amounts, restore
  const p = privacy;
  if (p) {
    const coins = p.coins.filter((c) => c.spendable);
    if (!coins.length) add('info', t('pc.coinsTitle'), t('pc.coinsNone'), 'privacy');
    else {
      const { level, min } = privacyLevel(p);
      const exactAll = coins.every((c) => c.exact_possible != null);
      add(level === 'fair' ? 'warn' : 'ok', t('pc.coinsTitle'),
        t(exactAll ? 'pc.coinsExact' : 'pc.coinsUpTo', { n: fmtNum(min), l: t(`pv.${level}`) }), 'privacy');
      const reveal = coins.filter((c) => c.reveals_amount).length;
      add(reveal ? 'warn' : 'ok', t('pc.amountTitle'), reveal ? t('pc.amountSome', { n: reveal }) : t('pc.amountNone'), 'privacy');
    }
    const ex = p.exact || {};
    if (ex.computed) add('ok', t('pc.exactTitle'), t('pc.exactOn', { s: fmtNum(ex.spends_considered) }), 'advanced');
    else if (ex.error) add('warn', t('pc.exactTitle'), t('pc.exactErr'), 'advanced');
    else if (s.exactPrivacy === false) add('info', t('pc.exactTitle'), t('pc.exactOff'), 'advanced');
    else {
      const ix = p.spendIndex;
      add('info', t('pc.exactTitle'), t('pc.exactBuild', { p: ix && ix.total ? Math.floor((100 * ix.have) / ix.total) : 0 }), 'advanced');
    }
    if (p.fastRestored) {
      add(p.fastRestored.own ? 'ok' : 'warn', t('pc.restoreTitle'),
        p.fastRestored.own ? t('pc.restoreOwn') : t('pc.restoreThird', { h: p.fastRestored.host || '?' }), 'privacy');
    }
  }

  // Address kind for payment notices
  if ((s.addressKind || 'generation') === 'generation') add('ok', t('pc.addrTitle'), t('pc.addrGen'), 'prefs');
  else add('info', t('pc.addrTitle'), t('pc.addrEc'), 'prefs');

  // Notifications show amounts on screen
  add(s.notifications !== false ? 'info' : 'ok', t('pc.notifTitle'), s.notifications !== false ? t('pc.notifOn') : t('pc.notifOff'), 'prefs');

  // Auto-lock
  const lock = Number(s.autoLockMinutes) || 15;
  add(lock <= 15 ? 'ok' : lock <= 60 ? 'info' : 'warn', t('pc.lockTitle'), t('pc.lock', { m: lock }), 'lock');

  // Keys and proofs never leave the device
  add('ok', t('pc.localTitle'), t('pc.local'), null);
  return items;
}

const PC_RANK = { bad: 3, warn: 2, info: 1, ok: 0 };

function pcOverall(items) {
  const worst = items.reduce((w, i) => (PC_RANK[i.state] > PC_RANK[w] ? i.state : w), 'ok');
  const toImprove = items.filter((i) => i.state === 'warn' || i.state === 'bad').length;
  return { worst, toImprove };
}

async function ensurePrivacy() {
  if (privacy || !app?.unlocked) return;
  try {
    privacy = await call('privacy');
  } catch {
    privacy = null;
  }
}

async function renderPcSummary() {
  await ensurePrivacy();
  const items = privacyChecks();
  const { worst, toImprove } = pcOverall(items);
  $('pcLight').dataset.s = worst;
  $('pcSummary').textContent = toImprove ? t('pc.summaryImprove', { n: toImprove }) : t('pc.summaryGood');
}

async function openPcheck() {
  await ensurePrivacy();
  const items = privacyChecks();
  const { worst, toImprove } = pcOverall(items);
  $('pcHero').dataset.s = worst;
  $('pcHeadline').textContent = toImprove ? t('pc.headImprove', { n: toImprove }) : t('pc.headGood');
  $('pcSub').textContent = t('pc.sub', { n: items.length });
  const list = $('pcList');
  list.textContent = '';
  for (const it of [...items].sort((a, b) => PC_RANK[b.state] - PC_RANK[a.state])) {
    const li = document.createElement('li');
    const light = document.createElement('span');
    light.className = 'light';
    light.dataset.s = it.state;
    const body = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = it.title;
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = it.detail;
    body.append(b, d);
    li.append(light, body);
    if (it.go) {
      const go = document.createElement('button');
      go.textContent = t('pc.open');
      go.onclick = () => pcGo(it.go);
      li.append(go);
    } else {
      li.append(document.createElement('span'));
    }
    list.append(li);
  }
  showScreen('pcheck');
}

function pcGo(where) {
  if (where === 'servers') return openServers(app.settings.network);
  if (where === 'advanced') return openSub('advanced');
  if (where === 'privacy') {
    boot().then(() => openPrivacy());
    return;
  }
  // Settings rows: open Settings and bring the row into view.
  if (where === 'tor') return openTor('settings');
  openSettings().then(() => {
    const id = { prices: 'setPrices', prefs: 'setKind', lock: 'setLock' }[where];
    const el = id && $(id);
    el?.closest('.row')?.scrollIntoView({ block: 'center' });
    el?.closest('.row')?.classList.add('just-on');
  });
}

async function savePref(patch) {
  try {
    const s = await call('saveSettings', patch);
    app.settings = s;
    return s;
  } catch (e) {
    toast(String(e.message || e));
    return null;
  }
}

$('settingsBtn').onclick = openSettings;
for (const b of document.querySelectorAll('.to-home')) b.onclick = () => boot();
for (const b of document.querySelectorAll('.to-settings')) b.onclick = openSettings;

for (const b of document.querySelectorAll('#themeSeg button')) {
  b.onclick = async () => {
    applyTheme(b.dataset.theme);
    await savePref({ theme: b.dataset.theme });
  };
}
$('setCurrency').onchange = async () => {
  await savePref({ currency: $('setCurrency').value });
  renderPrice();
};
$('setLanguage').onchange = async () => {
  const s = await savePref({ language: $('setLanguage').value });
  if (s) applyLanguage(s.language);
  $('versionLine').textContent = t('set.version', { v: VERSION });
};
$('recoveryExportForm').onsubmit = async ev => {
  ev.preventDefault(); busy($('recoveryExport'), true); err('recoveryExportError');
  const epoch=secretEpoch;
  try {
    const text = await call('exportRecovery', { password: $('recoveryExportPassword').value });
    if(epoch!==secretEpoch||currentScreen!=='private-backup'||!app?.unlocked||activeMode(app.settings)!=='encrypted')return;
    saveText(text, 'escanour-encrypted-recovery.json');
  } catch (e) { err('recoveryExportError', e); }
  finally { $('recoveryExportPassword').value = ''; busy($('recoveryExport'), false); }
};
$('setKind').onchange = () => savePref({ addressKind: $('setKind').value });
$('setPrices').onchange = async () => {
  await savePref({ priceLookup: $('setPrices').checked });
  renderPrice();
  toast($('setPrices').checked ? t('set.pricesOn') : t('set.pricesOff'));
};
$('setNotif').onchange = async () => {
  await savePref({ notifications: $('setNotif').checked });
  if ($('setNotif').checked) call('testNotice').catch(() => {});
};
$('setLock').onchange = () => savePref({ autoLockMinutes: Number($('setLock').value) || 15 });

for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => openSub(b.dataset.go);

async function openServers(net, returnTo = 'settings') {
  if (!app?.settings) app = await call('state');
  serversReturn = returnTo;
  serversNet = net || app.settings.network;
  fillServers();
  showScreen('servers');
}
$('serversBack').onclick = () => serversReturn.startsWith('private') ? showScreen(serversReturn) : openSettings();

function fillServers() {
  for (const b of document.querySelectorAll('#srvNet .seg-btn')) b.classList.toggle('on', b.dataset.net === serversNet);
  const srv = app.settings.servers?.[serversNet] || {};
  $('setSync').value = srv.sync || '';
  $('setBroadcast').value = srv.broadcast===srv.sync?'':srv.broadcast||'';
  $('setNodePool').checked=srv.randomFallback===true;
  $('setNodeB').value=srv.fallback||'';
  $('nodeBField').hidden=!$('setNodePool').checked;
  $('nodeSessionStatus').textContent='';
  const network=serversNet;
  call('nodeSession',{network}).then(choice=>{if(serversNet===network&&choice?.url)$('nodeSessionStatus').textContent=t('srv.poolUsing',{node:choice.label,host:new URL(choice.url).host});}).catch(()=>{});
  $('setMsg').textContent = '';
  const local = isLocalUrl(srv.sync) && isLocalUrl(srv.broadcast);
  $('nodeMode').checked = local;
  if (local) $('nodeUrl').value = srv.sync;
  $('nodeChecks').hidden = true;
}
$('setNodePool').onchange=()=>{$('nodeBField').hidden=!$('setNodePool').checked;};
for (const b of document.querySelectorAll('#srvNet .seg-btn')) {
  b.onclick = () => {
    serversNet = b.dataset.net;
    fillServers();
  };
}

function openSub(name) {
  const s = app.settings;
  if (name === 'servers') return openServers(s.network);
  if (name === 'pcheck') return openPcheck();
  if (name === 'tor') return openTor('settings');
  if (name === 'watch') return openWatch(currentScreen === 'settings' ? 'settings' : 'home');
  if (name === 'claim') return openClaim();
  if (name === 'archive') return openArchive();
  if (name === 'contacts') {
    loadContacts().then(renderContacts);
  }
  if (name === 'advanced') {
    $('setWorkers').value = String(s.workers);
    $('setLowMem').value = s.lowMemoryProving || 'auto';
    $('setExact').checked = s.exactPrivacy !== false;
    $('setWaitBlock').checked=s.waitForFreshBlock===true;
    renderProofReport();
    $('advNetwork').textContent = netLabel(s.network);
    $('advHeight').textContent = app.status?.height != null ? fmtNum(app.status.height) : '—';
    $('advSince').textContent = app.status?.startHeight != null ? fmtNum(app.status.startHeight) : s.birthday ? fmtNum(s.birthday) : '—';
  }
  if (name === 'phrase') {
    $('revealBox').hidden = true;
    $('revealGrid').textContent = '';
    $('revealForm').hidden = false;
    $('revealPw').value = '';
    err('revealErr');
    setTimeout(() => $('revealPw').focus(), 120);
  }
  if (name === 'about') $('aboutVersion').textContent = t('set.version', { v: VERSION });
  showScreen(name);
}

$('setWaitBlock').onchange=()=>savePref({waitForFreshBlock:$('setWaitBlock').checked,sendTimingConfigured:true});
$('setWorkers').onchange = () => savePref({ workers: $('setWorkers').value });
$('setLowMem').onchange = () => savePref({ lowMemoryProving: $('setLowMem').value });
$('setExact').onchange = () => savePref({ exactPrivacy: $('setExact').checked });

const fmtBytes = (n) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : n >= 2 ** 20 ? `${Math.round(n / 2 ** 20)} MB` : `${Math.round(n / 2 ** 10)} KB`);

/** What the last payment's proofs cost on this device. */
async function renderProofReport() {
  let r = null;
  try {
    r = await call('proofReport');
  } catch {
    r = null;
  }
  const list = $('advProofList');
  list.textContent = '';
  if (!r || !r.jobs?.length) {
    $('advProofs').textContent = t('adv.noProofs');
    list.hidden = true;
    return;
  }
  const peak = Math.max(...r.jobs.map((j) => j.memory_bytes || 0));
  $('advProofs').textContent = t('adv.proofsSummary', {
    d: fmtDate(r.at), s: Math.round(r.totalSeconds), w: r.workers, m: peak ? fmtBytes(peak) : '?',
  });
  for (const j of r.jobs) {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = j.label;
    const detail = document.createElement('span');
    detail.textContent = t('adv.proofLine', {
      s: j.seconds.toFixed(1), h: `2^${Math.round(Math.log2(j.padded_height))}`,
      c: fmtBytes(j.lde_cache_bytes), k: j.low_memory ? t('adv.notKept') : t('adv.kept'),
      p: fmtBytes(j.proof_bytes), m: j.memory_bytes ? fmtBytes(j.memory_bytes) : '?',
    });
    li.append(name, detail);
    list.append(li);
  }
  list.hidden = false;
}

$('copyCmd').onclick = async () => {
  await navigator.clipboard.writeText($('nodeCmd').textContent + (serversNet === 'testnet' ? ' --network testnet' : ''));
  toast(t('node.copied'));
};
const PUBLIC_SERVERS = { main: 'https://wallet.neptunefundamentals.org/' };

function isLocalUrl(u) {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
}

/** Show what a server offers, as a short checklist. */
async function showServerChecks(url) {
  const list = $('nodeChecks');
  list.hidden = false;
  list.textContent = '';
  const add = (state, text) => {
    const li = document.createElement('li');
    li.dataset.state = state;
    li.textContent = text;
    list.append(li);
  };
  add('wait', t('node.checking'));
  try {
    const info = await call('serverInfo', { url });
    list.textContent = '';
    add('ok', t('node.reach', { n: fmtNum(info.height) }));
    if (info.network) {
      const want = serversNet === 'main' ? 'main' : 'testnet';
      add(info.network.startsWith(want) ? 'ok' : 'bad', t('node.net', { n: info.network }));
    }
    add(info.fastRestore ? 'ok' : 'info', info.fastRestore ? t('node.fastYes') : t('node.fastNo'));
    add('info', t('node.provingFull'));
    return info;
  } catch (e) {
    list.textContent = '';
    add('bad', t('srv.fail', { e: e.message || e }));
    return null;
  }
}

$('nodeMode').onchange = async () => {
  const on = $('nodeMode').checked;
  $('setMsg').textContent = '';
  try {
    if (on) {
      const url = new URL($('nodeUrl').value.trim()).href;
      const granted = await chrome.permissions.request({ origins: [`${new URL(url).protocol}//${new URL(url).hostname}/*`] }).catch(() => false);
      if (!granted) throw new Error(t('srv.denied'));
      await savePref({ servers: { [serversNet]: { sync: url, broadcast: url,fallback:'',randomFallback:false } } });
      $('setSync').value = url;
      $('setBroadcast').value = url;
      await showServerChecks(url);
    } else {
      const d = PUBLIC_SERVERS[serversNet] || '';
      await savePref({ servers: { [serversNet]: { sync: d, broadcast: d,fallback:'',randomFallback:false } } });
      $('setSync').value = d;
      $('setBroadcast').value = d;
      $('nodeChecks').hidden = true;
      $('setMsg').textContent = d ? t('node.publicOn') : t('node.noPublic');
    }
    if (serversNet === app.settings.network) call('sync').catch(() => {});
  } catch (e) {
    $('nodeMode').checked = !on;
    $('setMsg').textContent = String(e.message || e);
  }
};

$('setSave').onclick = async () => {
  const b = $('setSave');
  const network=serversNet,epoch=secretEpoch;
  const current=()=>currentScreen==='servers'&&serversNet===network&&secretEpoch===epoch;
  busy(b, true);
  try {
    const sync = $('setSync').value.trim();
    const broadcast = $('setBroadcast').value.trim();
    const fallback=$('setNodeB').value.trim(),randomFallback=$('setNodePool').checked;
    if(randomFallback&&(!sync||!fallback||new URL(sync).href===new URL(fallback).href))throw new Error(t('srv.poolNeedTwo'));
    if (sync) {
      // Match patterns cover every port of a host, so the port is left out.
      const origins = [...new Set([sync, fallback, broadcast].filter(Boolean).map((u) => {
        const x = new URL(u);
        return `${x.protocol}//${x.hostname}/*`;
      }))];
      const granted = await chrome.permissions.request({ origins });
      if (!granted) throw new Error(t('srv.denied'));
    }
    if(!current())return;
    const settings=await call('saveSettings',{servers:{[network]:{sync,broadcast,fallback,randomFallback}}});
    if(!current())return;
    app.settings=settings;
    $('setMsg').textContent = t('srv.saved');
    const choice=await call('nodeSession',{network});if(current()&&choice?.url)$('nodeSessionStatus').textContent=t('srv.poolUsing',{node:choice.label,host:new URL(choice.url).host});
    if (network === app.settings.network) call('sync').catch(() => {});
  } catch (e) {
    if(current())$('setMsg').textContent = String(e.message || e);
  } finally {
    busy(b, false);
  }
};

$('testServer').onclick = async () => {
  const b = $('testServer');
  busy(b, true);
  $('setMsg').textContent = '';
  try {
    await showServerChecks($('setSync').value);
  } finally {
    busy(b, false);
  }
};

let revealed = '';
$('revealForm').onsubmit = async (ev) => {
  ev.preventDefault();
  err('revealErr');
  const b = $('revealGo');
  busy(b, true);
  const epoch=secretEpoch;
  try {
    const phrase = await call('revealPhrase', { password: $('revealPw').value });
    if(epoch!==secretEpoch||currentScreen!=='phrase'||!app?.unlocked)return;
    revealed=phrase;
    wordsInto($('revealGrid'), revealed);
    $('revealBox').hidden = false;
    $('revealForm').hidden = true;
    $('revealPw').value = '';
  } catch {
    err('revealErr', t('unlock.wrong'));
  } finally {
    $('revealPw').value='';
    busy(b, false);
  }
};
$('copyPhrase').onclick = () => revealed && copySecret(revealed);
$('savePhrase').onclick = () => revealed && saveText(phraseFileText(revealed), 'escanour-recovery-phrase.txt');
$('revealHide').onclick = () => {
  secretEpoch++;$('revealGrid').textContent='';
  revealed = '';
  openSub('phrase');
};

$('setRestore').onclick = () => startSetup('restore', true);
$('setCreate').onclick = () => startSetup('create', true);

$('resetGo').onclick = async () => {
  if (!confirm(t('set.confirmRemove'))) return;
  await call('reset');
  for (const k of Object.keys(addrCache)) delete addrCache[k];
  lastAvail = null;
  await boot();
};

// ----------------------------------------------------------- sheets/misc ---

for (const b of document.querySelectorAll('.sheet .close')) b.onclick = closeSheet;
$('scrim').onclick = closeSheet;
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'popup') return;
  if (msg.type === 'tor') {
    if (app) app.tor = msg.tor;
    renderTor(msg.tor);
    if (!$('v-settings').hidden) renderPcSummary();
    if (!$('v-pcheck').hidden) openPcheck();
  }
  if (msg.type === 'status') {
    if (msg.network && app?.settings && msg.network !== app.settings.network) return;
    if (app) {app.status=msg.status;if(msg.recoveries)app.recoveries=msg.recoveries;}
    if(currentScreen==='servers'&&serversNet===app.settings.network&&msg.status.node?.url)$('nodeSessionStatus').textContent=t('srv.poolUsing',{node:msg.status.node.label,host:new URL(msg.status.node.url).host});
    if (currentScreen==='claim') renderAssetRecovery();
    if (!$('v-home').hidden) renderHomeWatch(homeWatchCache);
    if (!$('v-home').hidden || currentScreen.startsWith('private')) renderPrivatePanel();
    if (!$('v-home').hidden) renderStatus(msg.status);
    if (!$('v-home').hidden) {
      renderExtra();
      // Refresh the numbers once a sync run ends with new blocks, not on every tip check.
      const h = msg.status.height;
      if (!msg.status.syncing && h !== shownHeight) {
        shownHeight = h;
        refreshHome();
      }
    }
  }
  if (msg.type === 'activity' && (!$('v-home').hidden || currentScreen.startsWith('private'))) refreshHome();
  if (msg.type === 'status') refreshOpenScreen();
  if (msg.type === 'job') jobHandlers.get(msg.jobId)?.(msg);
  // A wallet was created or restored in the setup tab: the side panel follows.
  if (msg.type === 'walletChanged' && !IN_TAB) boot().catch(() => {});
  if (msg.type === 'watch' && (!msg.network || msg.network === app?.settings?.network)) {
    if (!$('v-home').hidden) refreshHome();
    if (!$('v-watch').hidden) renderWatch();
  }
  if (msg.type === 'locked') { if(app)app.unlocked=false;cancelAssetRefresh();clearWatchSecrets(); clearPrivateText(); closeSheet(); boot().catch(() => {}); }
  if (msg.type === 'contacts') { loadContacts().then(() => { if (!$('v-contacts').hidden) renderContacts(); }); }
  if (msg.type === 'send') {
    if (msg.send.network && app?.settings && msg.send.network !== app.settings.network) return;
    if ((msg.send.walletMode || 'standard')!==activeMode(app?.settings)) return;
    app.send=msg.send;renderSendCard(msg.send);
    if (currentSheet === 'progress' && (!lastSend?.id || lastSend.id === msg.send.id)) renderProgress(msg.send);
    if (msg.send.status === 'done') refreshHome();
  }
  if (msg.type === 'proveProgress' && lastSend && msg.sendId===lastSend.id && sendBelongsHere(lastSend)) {
    const s = { ...lastSend, status: 'proving', jobsDone: msg.done, jobCount: msg.total, lastJob: msg.label };
    if (currentSheet === 'progress') renderProgress(s);
    renderSendCard(s);
  }
});

boot().catch((e) => {
  showScreen('welcome');
  toast(String(e.message || e));
});


function setSendNotificationMode(mode) {
  sendNotificationMode = mode === 'private' ? 'private' : 'standard';
  const privateMode = sendNotificationMode === 'private';
  for (const button of document.querySelectorAll('#sendMode [data-mode]')) {
    const active = button.dataset.mode === sendNotificationMode;
    button.classList.toggle('on', active); button.setAttribute('aria-checked', String(active));
  }
  $('sendPrivateMode').disabled = app?.settings?.network === 'main';
  for(const b of document.querySelectorAll('#sendMode [data-mode=standard]'))b.disabled=activeMode(app?.settings)==='encrypted';
  $('sendEncryptedBox').hidden = !privateMode;
  $('sendModeStatus').textContent = `${t(privateMode ? 'modes.encrypted' : 'modes.normalReceipt')} · ${t('private.on')}`;
  $('sendModeStatus').dataset.state = 'on';
  if (!privateMode) $('sendEncryptedMessage').value = '';
  $('sendModeHint').textContent = t(privateMode ? 'private.sendHint' : 'private.standardHint');
  updateEncryptedMessageCount();
}
function updateEncryptedMessageCount() {
  const bytes = new TextEncoder().encode($('sendEncryptedMessage').value).length;
  $('encryptedMessageCount').textContent = `${bytes} / 512 bytes`;
  $('encryptedMessageCount').classList.toggle('err', bytes > 512);
}
for (const button of document.querySelectorAll('#sendMode [data-mode]')) button.onclick = () => setSendNotificationMode(button.dataset.mode);
$('sendEncryptedMessage').oninput = updateEncryptedMessageCount;
function clearPrivateText() {
  secretEpoch++;revealed='';$('revealGrid').textContent='';$('revealPw').value='';$('revealBox').hidden=true;$('revealForm').hidden=false;
  $('phraseGrid').textContent='';delete $('phraseGrid').dataset.phrase;$('pw1').value='';$('pw2').value='';
  receiveRequest++; addressHistoryRequest++; receivingHistoryIndex=null; $('addressHistoryList').textContent='';
  recoveryGeneration++; $('phraseInput').value = '';
  clearClaimReview(true);waitingRequest++;$('claimWaiting').textContent='';$('claimAdopted').textContent='';
  pendingRecoveryFile = ''; $('recoveryImportPassword').value = ''; $('recoveryExportPassword').value = '';
  $('sendEncryptedMessage').value = ''; $('txEncryptedMessage').textContent = ''; $('rvMessage').textContent = '';
  $('txDetails').textContent = ''; $('txNoteInput').value = ''; $('sendNote').value = '';
  $('privateActivity').textContent = ''; $('qrBox').innerHTML = ''; historyCache = []; lastSend = null;
  $('txEncryptedBox').hidden = true; $('qrBox').hidden = true;
  delete addrCache['private-app']; delete $('addrText').dataset.addr; $('addrText').textContent = '';
}
function renderPrivatePanel() {
  const settings = app?.settings || { network: 'main' };
  const enabled = privateNotificationsEnabled(settings);
  const st = app?.status || {};
  const scanning = enabled && (st.syncing || Number(st.tip || 0) > Number(st.height || 0));
  const state = settings.network === 'main' ? 'unavailable' : !enabled ? 'off' : scanning ? 'scanning' : 'ready';
  const text = t(`private.state.${state}`);
  $('goModes').dataset.state = 'ready'; $('privateStripState').textContent = text; $('privateState').textContent = text;
  $('privateSend').disabled = $('privateReceive').disabled = !enabled;
  $('privateRecover').disabled = !enabled || activeMode(settings)!=='encrypted';
  $('recoveryPageTitle').textContent=t('recovery.encryptedTitle');
  $('openRecoveredEncrypted').hidden=!settings.createdWallets?.encrypted||settings.network==='main';
  $('walletRecoveryTitle').textContent=t('modes.encrypted');
  $('walletRecoveryHint').textContent=t('recovery.encryptedHint');
  $('privateRecover').textContent=t('recovery.scanEncrypted');
  const start = Number(st.startHeight || 0), height = Number(st.height || 0), tip = Number(st.tip || height);
  const ratio = tip > start ? Math.max(0, Math.min(1, (height - start) / (tip - start))) : 1;
  $('privateScanBar').style.width = `${Math.round(ratio * 100)}%`;
  $('privateScanBar').parentElement.hidden = $('privateScanText').hidden = false;
  $('privateScanText').textContent = t('private.scanProgress', { h: fmtNum(height), t: fmtNum(tip) });
  const list = historyCache.filter(e => e.toKind === 'private-app' || e.addressKind === 'private-app' || e.privateDowngrade);
  const indicator = (id, label, state) => {
    if ($(id)) { $(id).textContent = label; $(id).dataset.state = state; }
    const feature = {privateModeIndicator:'payments',privateFreshIndicator:'fresh',privateLeakIndicator:'leaks',privateBackupIndicator:'backup',privateRecoveryIndicator:'recovery',privateHistoryIndicator:'history'}[id];
    const hero = feature && document.querySelector(`[data-private-feature="${feature}"]`);
    if (hero) { hero.dataset.state = state; const status = hero.querySelector('.private-nav-status'); status.textContent = label; status.dataset.state = state; }
  };
  indicator('privateModeIndicator', t(settings.network === 'main' ? 'private.testOnly' : enabled ? 'private.on' : 'private.off'), enabled ? 'on' : 'off');
  indicator('privateBackupIndicator', t('private.optional'), 'neutral');
  indicator('privateRecoveryIndicator', `${fmtNum(height)} / ${fmtNum(tip)}`, scanning ? 'on' : 'neutral');
  indicator('privateHistoryIndicator', fmtNum(list.length), 'neutral');
  $('privateDowngradeAlert').hidden = !list.some(e => e.privateDowngrade);
  $('privateActivity').textContent = ''; list.slice(0, 6).forEach((e, i) => $('privateActivity').append(txRow(e, i)));
  $('privateEmpty').hidden = list.length > 0;
  renderModes();
}
$('goModes').onclick = openModes;
function openPrivatePage(name,profile=activeMode(app.settings)) { if(['backup','recovery'].includes(name) && (profile!=='encrypted'||activeMode(app.settings)!=='encrypted')){toast(t('backup.encryptedOnly'));return;}privateTrail.push(currentScreen);renderPrivatePanel();showScreen(`private-${name}`); }
for (const b of document.querySelectorAll('.private-route')) b.onclick = () => {
  openPrivatePage(b.dataset.privatePage,b.dataset.recoveryWallet || activeMode(app.settings));
};
for (const b of document.querySelectorAll('.to-private')) b.onclick = () => {
  const previous = privateTrail.pop() || 'modes';
  renderPrivatePanel(); showScreen(previous);
};
$('privateSend').onclick = () => openSend('private');
$('privateReceive').onclick = () => openReceive('private-app');
$('privateServers').onclick = () => openServers(app.settings.network, 'private-recovery');
$('privateRecover').onclick = async () => {
  const button = $('privateRecover'); busy(button, true); err('privateRecoveryError');
  try {
    const start = privateRecoveryStart($('privateFirstBlock').value);
    await call('rescan', { birthday: start, mode:'private', walletMode:'encrypted', networkContext:app.settings.network, encryptedOnly:true, rememberMode:false });
    app = await call('state'); renderPrivatePanel(); toast(t('private.recoveryStarted'));
  } catch (e) { err('privateRecoveryError', e); }
  finally { busy(button, false); }
};

function renderModes() {
  const s=app?.settings || {network:'main'},mode=activeMode(s);
  const created={standard:true,refresh:s.createdWallets?.refresh===true,encrypted:s.createdWallets?.encrypted===true};
  const state=(id,on,selected=false)=>{ $(id).textContent=selected?t('modes.selected'):t(on?'modes.ready':'modes.createShort');$(id).dataset.state=on?'on':'off'; };
  state('modeGenerationState',true,mode==='standard');state('generationHeroState',true,mode==='standard');
  state('modeRefreshState',created.refresh,mode==='refresh');state('refreshHeroState',created.refresh,mode==='refresh');
  state('modeEncryptedState',created.encrypted,mode==='encrypted');
  $('refreshHero').dataset.state=created.refresh?'on':'off';
  $('createRefreshWallet').hidden=created.refresh;$('useRefreshMode').hidden=!created.refresh;
  $('createEncryptedWallet').hidden=created.encrypted;$('useEncryptedMode').hidden=!created.encrypted;
  $('refreshAssetsOpen').hidden=!created.refresh;
  $('encryptedAssetsOpen').hidden=$('encryptedDetailsRecovery').hidden=!created.encrypted;
  $('createEncryptedWallet').disabled=s.network==='main';
  if(s.network==='main') $('modeEncryptedState').textContent=t('private.testOnly');
  for(const b of document.querySelectorAll('.use-mode')) b.textContent=t('modes.open');
  $('modeHomeName').textContent=t(`modes.${mode}`);
  $('modeHomeHint').textContent=t(`modes.${mode}Hint`);
  $('modeHomeIcon').setAttribute('href',mode==='encrypted'?'#i-lock':mode==='refresh'?'#i-change':'#i-card');
  $('modeHomeStatus').textContent=t(mode==='refresh'?'private.on':'modes.selected');$('modeHomeStatus').dataset.state='on';
  $('modeHomeAddress').hidden=true;
  $('addressHistoryOpen').hidden=mode!=='refresh';
  $('encryptedRecoveryOpen').hidden=mode!=='encrypted';
  $('modeHomeCard').dataset.mode=mode;document.body.dataset.wallet=mode;
  $('privateStripState').textContent=t(`modes.${mode}`);$('goModes').title=t('modes.title');
  $('sendMode').hidden=true;

}
async function openModes() {privateTrail=[];app=await call('state');renderPrivatePanel();showScreen('modes');}
$('modeHomeManage').onclick=openModes;$('modeHomeCard').onclick=openModes;
for(const b of document.querySelectorAll('.mode-route'))b.onclick=async()=>{
  const mode=b.dataset.modePage;
  if(mode!==activeMode(app.settings)&&(mode==='standard'||app.settings.createdWallets?.[mode])) {
    try{await call('selectMode',{mode});app=await call('state');for(const k of Object.keys(addrCache))delete addrCache[k];lastSummary=null;await refreshHome();showTab('addr');showScreen('home');}
    catch(e){toast(e.message);}return;
  }
  privateTrail=['modes'];renderPrivatePanel();showScreen(mode==='encrypted'?'private-payments':`mode-${mode}`);
};
for(const b of document.querySelectorAll('.to-modes'))b.onclick=openModes;
for(const b of document.querySelectorAll('.use-mode'))b.onclick=async()=>{
  busy(b,true);try{await call('selectMode',{mode:b.dataset.selectMode});app=await call('state');for(const k of Object.keys(addrCache))delete addrCache[k];await refreshHome();showTab('addr');showScreen('home');}
  catch(e){toast(e.message);}finally{busy(b,false);renderModes();}
};
for(const b of document.querySelectorAll('.create-subwallet'))b.onclick=async()=>{
  const mode=b.dataset.createWallet;const error=mode==='refresh'?'refreshWalletError':'encryptedWalletError';busy(b,true);err(error);
  try{await call('createSubwallet',{mode});app=await call('state');for(const k of Object.keys(addrCache))delete addrCache[k];await refreshHome();renderModes();showScreen('home');}
  catch(e){err(error,e);}finally{busy(b,false);}
};

$('encryptedRecoveryOpen').onclick=()=>openPrivatePage('recovery','encrypted');
$('restorePrivateSeed').onclick=()=>startSetup('restore',Boolean(app?.exists));
async function loadAddressHistory(reset=false) {
  const request=++addressHistoryRequest;
  if(reset){addressHistoryOffset=0;$('addressHistoryList').textContent='';}
  err('addressHistoryError');$('addressHistoryLoading').hidden=false;busy($('addressHistoryMore'),true);
  for(const b of document.querySelectorAll('[data-history-kind]'))b.classList.toggle('on',b.dataset.historyKind===addressHistoryKind);
  try {
    const result=await call('addressHistory',{kind:addressHistoryKind,offset:addressHistoryOffset});
    if(request!==addressHistoryRequest||currentScreen!=='address-history')return;
    if(result.profile!==activeMode(app.settings))throw new Error('Sub-wallet changed. Open address history again.');
    for(const row of result.rows){
      const el=document.createElement('div');el.className='address-history-row';
      const view=document.createElement('button');view.className='address-history-view';
      const title=document.createElement('b');title.textContent=t('recv.number',{n:fmtNum(row.index+1)});
      const status=document.createElement('span');status.className='address-history-status';status.textContent=t(row.current?'addrHistory.current':'addrHistory.previous');status.dataset.current=String(row.current);
      const top=document.createElement('span');top.className='address-history-heading';top.append(title,status);
      const address=document.createElement('small');address.className='mono';address.textContent=shortAddr(row.address,14,10);
      const detail=document.createElement('small');detail.textContent=row.receipts?t('addrHistory.receipts',{n:fmtNum(row.receipts)}):t('addrHistory.unused');
      view.append(top,address,detail);view.onclick=()=>openReceive(result.kind,row.index);
      const copy=document.createElement('button');copy.className='chip';copy.textContent=t('recv.copy');copy.setAttribute('aria-label',`${t('recv.copy')} ${title.textContent}`);
      copy.onclick=async()=>{try{await navigator.clipboard.writeText(row.address);toast(t('recv.copiedKind',{k:kindLabel(result.kind)}));}catch(e){toast(e.message);}};
      el.append(view,copy);$('addressHistoryList').append(el);
    }
    addressHistoryOffset=result.next;$('addressHistoryMore').hidden=result.next>=result.total;
    $('addressHistoryEmpty').hidden=result.rows.some(r=>r.receipts>0)||result.total>1;
  }catch(e){if(request===addressHistoryRequest)err('addressHistoryError',e);}
  finally{if(request===addressHistoryRequest){$('addressHistoryLoading').hidden=true;busy($('addressHistoryMore'),false);}}
}
$('addressHistoryOpen').onclick=()=>{showScreen('address-history');addressHistoryKind=app.settings.addressKind||'generation';loadAddressHistory(true);};
for(const b of document.querySelectorAll('[data-history-kind]'))b.onclick=()=>{addressHistoryKind=b.dataset.historyKind;loadAddressHistory(true);};
$('addressHistoryMore').onclick=()=>loadAddressHistory(false);
