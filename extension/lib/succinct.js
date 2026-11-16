// Succinct node: shared rules, no I/O.
//
// The node module (node-worker.js + pkg/node) verifies the recursive proof of
// a server's tip block. Since Neptune's epsilon soft fork that one proof
// covers every block above the activation parent, so the server can no longer
// invent a chain. This file holds the decisions around that verdict, so the
// service worker, the offscreen runner and the tests all use the same ones.

/** Hash (hex) of the last block below the activation height, per network:
 *  the one thing a succinct client cannot prove and must know.
 *
 *  Empty means "not built in": the wallet then pins the value the first
 *  proven tip reports (trust on first use), shows it in Servers, and refuses
 *  any later chain built on a different one. Fill a value in here once it is
 *  published and confirmed from independent sources; a built-in value always
 *  wins over a pinned one. */
export const KNOWN_ANCHORS = Object.freeze({
  main: '', // block 62,499
  testnet: '', // block 7,143 on testnet-0
  'testnet-mock': '',
});

export const DIGEST_HEX = /^[0-9a-f]{80}$/;

export function available() {
  return true;
}

/** Proof checking is one half of Full node mode (the other is the archive). */
export function enabled(settings) {
  return settings?.localArchive === true;
}

/** The nodes whose tips are verified: Node A, then Node B when configured.
 *  Order matters: the first wins a tie in proven work. */
export function targets(settings, network = settings?.network) {
  const srv = settings?.servers?.[network] || {};
  return [...new Set([srv.sync, srv.fallback].filter(Boolean))];
}

/** Which anchor to hold a chain to, and where it came from. */
export function anchorFor(network, pinned) {
  const builtin = KNOWN_ANCHORS[network] || '';
  if (builtin) return { hash: builtin, source: 'builtin' };
  if (pinned?.hash && DIGEST_HEX.test(pinned.hash)) return { hash: pinned.hash, source: pinned.source || 'first-use', at: pinned.at };
  return { hash: '', source: 'none' };
}

/**
 * Decide what a round of verdicts means.
 *
 * `results`: one per node, `{ url, ok, report?, error? }`. `bestIndex`: the
 * node module's fork choice among the reports of the `ok` results (by proven
 * work since activation), as an index into that filtered list.
 *
 * Returns `{ best, pin, conflict }`:
 * - `best`: the report to follow, or null.
 * - `pin`: an anchor to store, when none was known and the proven tips agree.
 * - `conflict`: true when no anchor was known and two nodes prove chains built
 *   on different activation parents. Nothing is pinned then: one of them is
 *   on another history and only the user can say which.
 */
export function decide(results, bestIndex, anchor) {
  const proven = results.filter((r) => r.ok && r.report?.proven).map((r) => r.report);
  const okReports = results.filter((r) => r.ok).map((r) => r.report);
  const best = bestIndex >= 0 ? okReports[bestIndex] || null : null;
  if (!proven.length) return { best, pin: null, conflict: false };
  const anchors = new Set(proven.map((r) => r.activation_parent_hash));
  if (!anchor?.hash) {
    if (anchors.size > 1) return { best: null, pin: null, conflict: true };
    return { best, pin: { hash: [...anchors][0], source: 'first-use' }, conflict: false };
  }
  return { best, pin: null, conflict: false };
}

/**
 * The status the wallet shows, from the stored round and how the wallet's
 * own chain compares with the proven tip.
 *
 * state:
 *  'off'       node mode is off (or this is the light build)
 *  'waiting'   no round finished yet
 *  'inactive'  the chain is still below the activation height
 *  'proven'    the wallet's chain is the proven chain
 *  'syncing'   a tip is proven; the wallet has not reached it yet
 *  'diverged'  the wallet holds blocks that are not on the proven chain
 *  'conflict'  nodes disagree about the history below activation
 *  'error'     no node's tip could be verified
 */
export function provenState(settings, record, match) {
  if (!enabled(settings)) return { state: 'off' };
  if (!record) return { state: 'waiting' };
  const base = { at: record.at, anchor: record.anchor || null, nodes: (record.results || []).length };
  if (record.conflict) return { ...base, state: 'conflict' };
  const best = record.best;
  if (!best) {
    const first = (record.results || []).find((r) => !r.ok);
    return { ...base, state: 'error', error: String(first?.error || record.error || 'No node answered').slice(0, 300) };
  }
  const tip = { height: best.height, hash: best.hash, activationHeight: best.activation_height };
  if (!best.proven) return { ...base, ...tip, state: 'inactive' };
  const proven = {
    ...base, ...tip,
    work: best.work_since_activation,
    // The parent is proven recursively; the tip itself is fully validated
    // only when the node module also had the wallet's mutator set.
    provenHeight: best.tip_fully_validated ? best.height : best.height - 1,
    // Nodes that answered but follow a weaker or different tip.
    behind: (record.results || []).filter((r) => r.ok && r.report?.hash !== best.hash).length,
    failed: (record.results || []).filter((r) => !r.ok).length,
  };
  if (match === 'diverged') return { ...proven, state: 'diverged' };
  if (match === 'on-proven-chain') return { ...proven, state: 'proven' };
  return { ...proven, state: 'syncing' };
}

/** A send must not be built on a chain the proofs contradict. */
export function blocksSending(proven) {
  return proven?.state === 'diverged' || proven?.state === 'conflict';
}
