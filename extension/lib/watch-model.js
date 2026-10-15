// Presentation and scheduling helpers shared by the popup and worker.
export function contactAddresses(contact) {
  return contact.addresses?.length ? contact.addresses : contact.address ? [{ address: contact.address, kind: contact.kind }] : [];
}

export function decorateWatch(list, prefs = {}) {
  return list.map((a) => ({ ...a, mode: 'private', paused: false, hidden: false, ...prefs[a.id], id: a.id }));
}

export function visibleWatch(list, showHidden = false, query = '') {
  const q = query.trim().toLowerCase();
  return list.filter((a) => (showHidden || !a.hidden) && (!q || `${a.label} ${a.kind} ${a.key_short}`.toLowerCase().includes(q)));
}

export function scanProgress(account, height) {
  const start = Math.max(0, (account.from_height || 1) - 1);
  const at = Math.max(start, account.scanned_to || 0);
  const end = Math.max(start, height || 0);
  return { at, end, percent: end > start ? Math.min(100, Math.max(0, Math.floor(100 * (at - start) / (end - start)))) : 100 };
}

export function activeWatchIds(list, prefs = {}) {
  return list.filter((a) => !prefs[a.id]?.paused).map((a) => a.id);
}

// Share concurrent refreshes/runs instead of building an unbounded queue.
export function singleFlight(fn) {
  let pending = null;
  return (...args) => {
    if (!pending) pending = Promise.resolve().then(() => fn(...args)).finally(() => { pending = null; });
    return pending;
  };
}
