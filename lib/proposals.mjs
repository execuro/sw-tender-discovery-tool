// Proposal memory (`specs/.rfp/<slug>/proposals.json`) and the re-estimate queue
// (`specs/.rfp/<slug>/reestimate.json`). Build contract §2, §3; AQ-1…AQ-4, R-2, R-3.
import fs from 'node:fs';
import path from 'node:path';

function proposalsFile(root, slug) { return path.join(root, 'specs', '.rfp', slug, 'proposals.json'); }
function reestimateFile(root, slug) { return path.join(root, 'specs', '.rfp', slug, 'reestimate.json'); }
// Items `apply` has written since the current `*` mark was set — several `apply`s can each
// cover only part of the scope (N-6: two applies, each re-estimating half the items), so
// whether `*` is satisfied has to accumulate across them, not judge a single `apply`'s
// `written` list against every item in the document.
function starProgressFile(root, slug) { return path.join(root, 'specs', '.rfp', slug, 'reestimate-star-progress.json'); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

/** lowercase, collapsed whitespace, trailing punctuation stripped (contract §2). */
export function normalise(statement) {
  return String(statement ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

export function list(root, slug) {
  return readJson(proposalsFile(root, slug), []);
}

function write(root, slug, all) {
  atomicWrite(proposalsFile(root, slug), JSON.stringify(all, null, 2) + '\n');
}

/**
 * Add a proposal unless a rejected one, same item (or global), same normalised statement,
 * already exists (AQ-4: never proposed again). Returns the created proposal, or `null` when
 * dropped by rejected-memory.
 */
export function add(root, slug, { item = null, statement, pdSaved = null, run = null }) {
  const all = list(root, slug);
  const norm = normalise(statement);
  const alreadyRejected = all.some(p => p.status === 'rejected' && p.item === item && normalise(p.statement) === norm);
  if (alreadyRejected) return null;
  const maxN = all.reduce((m, p) => { const n = Number((/^P-(\d+)$/.exec(p.id) || [])[1]); return Number.isFinite(n) ? Math.max(m, n) : m; }, 0);
  const proposal = { id: `P-${maxN + 1}`, item, statement: String(statement).trim(), pdSaved: pdSaved == null ? null : Number(pdSaved), status: 'waiting', run: run || null };
  all.push(proposal);
  write(root, slug, all);
  return proposal;
}

export function accept(root, slug, id) {
  const all = list(root, slug);
  const p = all.find(x => x.id === id);
  if (!p) return { ok: false, reason: `proposal ${id} not found` };
  if (p.status !== 'waiting') return { ok: false, reason: `proposal ${id} is ${p.status}, not waiting` };
  p.status = 'accepted';
  write(root, slug, all);
  return { ok: true, proposal: p };
}

export function reject(root, slug, id) {
  const all = list(root, slug);
  const p = all.find(x => x.id === id);
  if (!p) return { ok: false, reason: `proposal ${id} not found` };
  p.status = 'rejected';
  write(root, slug, all);
  return { ok: true, proposal: p };
}

/** Reject every `waiting` proposal of one scope item (L-2, confirming an item). */
export function rejectWaitingFor(root, slug, item) {
  const all = list(root, slug);
  const changed = [];
  for (const p of all) if (p.status === 'waiting' && p.item === item) { p.status = 'rejected'; changed.push(p); }
  if (changed.length) write(root, slug, all);
  return changed;
}

// --- reestimate.json ---------------------------------------------------------------------

export function reestimateList(root, slug) {
  return readJson(reestimateFile(root, slug), []);
}

function writeReestimate(root, slug, all) {
  atomicWrite(reestimateFile(root, slug), JSON.stringify(all, null, 2) + '\n');
}

/** `item: "*"` marks every scope item (contract §2). A fresh `*` mark restarts the star's
 * write-progress tracking (N-6): items written toward a previous `*` mark do not count toward
 * satisfying a new one. */
export function markReestimate(root, slug, item, cause) {
  const all = reestimateList(root, slug);
  all.push({ item, cause, at: new Date().toISOString() });
  writeReestimate(root, slug, all);
  if (item === '*') atomicWrite(starProgressFile(root, slug), JSON.stringify([]) + '\n');
}

export function isMarked(root, slug, item) {
  return reestimateList(root, slug).some(r => r.item === '*' || r.item === item);
}

/**
 * Consumed by `apply` for the items it wrote (contract §2). A per-item mark clears as soon as
 * that item is written; the `*` (every item) mark clears once every scope item the marker was
 * meant to cover has been written by SOME apply since the mark was set — not necessarily this
 * one (N-6): the write-progress accumulates across applies in `reestimate-star-progress.json`,
 * so two applies that each re-estimate half the items together clear `*`. `allItemIds` (every
 * scope item currently in the document, when the caller has it) makes that check possible;
 * without it `*` is left in place, as before, for the next `apply` to keep trying to satisfy.
 */
export function clearReestimate(root, slug, itemIds, allItemIds = null) {
  const all = reestimateList(root, slug);
  const hasStar = all.some(r => r.item === '*');
  let starCleared = false;
  if (hasStar && Array.isArray(allItemIds) && allItemIds.length > 0) {
    const progress = new Set(readJson(starProgressFile(root, slug), []));
    for (const id of itemIds) progress.add(id);
    starCleared = allItemIds.every(id => progress.has(id));
    if (starCleared) { try { fs.unlinkSync(starProgressFile(root, slug)); } catch { /* already gone */ } }
    else atomicWrite(starProgressFile(root, slug), JSON.stringify([...progress]) + '\n');
  }
  const keep = all.filter(r => (r.item === '*' ? !starCleared : !itemIds.includes(r.item)));
  writeReestimate(root, slug, keep);
}

export function clearAllReestimate(root, slug) {
  writeReestimate(root, slug, []);
  try { fs.unlinkSync(starProgressFile(root, slug)); } catch { /* already gone */ }
}
