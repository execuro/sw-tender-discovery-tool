// Totals, readiness and the effort scale for the Tender Discovery Tool.
// Grammar/rules: build contract `own-tabs-contract.md` §1, PRD estimation section (E-1..E-6).
// No imports: served to the browser as /page/lib/calc.mjs.
// `TABS`, the fixed §4 tabs, lives in parse.mjs; this module is import-free (served to the
// browser), so its order is inlined here rather than imported.
const TABS = ['Functional', 'Non-functional', 'Project & services'];

/** Default T-shirt scale, PD. Contract §5. */
export const SCALE = { '—': 0, XS: 0.5, S: 1.5, M: 4, L: 10, XL: 25, XXL: 50 };

export function round025(x) {
  if (x == null || Number.isNaN(x)) return null;
  const r = Math.round(x * 4) / 4;
  return r === 0 ? 0 : r;
}

/** `round0.25(pd × (1+overhead/100) × (1+buffer/100 if folded))`. Contract §3 apply rule. */
export function profileFigure(pd, profile) {
  if (typeof pd !== 'number') return null;
  const overhead = Number(profile?.overhead) || 0;
  const bufferPct = Number(profile?.buffer?.percent) || 0;
  const folded = profile?.buffer?.mode === 'folded';
  const factor = (1 + overhead / 100) * (folded ? (1 + bufferPct / 100) : 1);
  return round025(pd * factor);
}

/** *Not decomposed* (E-2): `XXL`, or — in the profile regime — the item's PD above the big
 * calibration point. #5: a stale profile-format figure (the live regime has since reverted to
 * T-shirt, so there is no calibration point left to re-check it against) is judged by the regime
 * IT WAS PRODUCED IN, not blanket-flagged: without a calibration point every profile PD counted
 * as "not decomposed" before, which buried genuinely small figures under the same flag as huge
 * ones. The fallback is the T-shirt regime's own ceiling (`XXL` = 50 PD, contract §5) — a stale
 * figure at or above it is still called out; a stale figure below it is not, and is not silently
 * called "decomposed" either — `isStale` (below) is what marks it pending re-estimate. */
export function isNotDecomposed(item, profile) {
  const effort = item?.effort;
  if (!effort) return false;
  if (effort.size === 'XXL') return true;
  if (effort.regime === 'profile') {
    if (typeof profile?.calibration?.big === 'number') return effort.pd > profile.calibration.big;
    return typeof effort.pd === 'number' && effort.pd >= SCALE.XXL;
  }
  return false;
}

/** #5: an item's effort was produced under a DIFFERENT regime than the one live now (a profile
 * added or removed since — T4, contract D-4). Stale — pending the next apply's re-estimate
 * (`check --write` already queues it via `markReestimate('*', ...)`) — so §2 can call it out
 * instead of letting the live regime's own label silently cover a figure from the other one. */
export function isStale(item, regimeStr) {
  return Boolean(item?.effort && regimeStr && item.effort.regime && item.effort.regime !== regimeStr);
}

/** Count of stale items (see `isStale`), for the §2 footnote. */
export function staleCount(items, regimeStr) {
  return (items || []).filter(it => isStale(it, regimeStr)).length;
}

const NOT_ESTIMATED_STATUS = new Set(['queued', 'failed']);
export const isEstimated = item => !!item?.effort && typeof item.effort.pd === 'number';
export const isBlocked = item => item?.status?.kind === 'blocked';
export const isNotEstimated = item => !isEstimated(item) || NOT_ESTIMATED_STATUS.has(item?.status?.kind);

function emptyBucket() { return { items: 0, estimatedPd: 0, blocked: 0, notEstimated: 0, notDecomposed: 0 }; }

function addItem(map, key, item, profile) {
  const b = map.get(key) || emptyBucket();
  b.items++;
  // `queued` / `failed` is always "not estimated" (E-4), even when a stale
  // effort figure lingers on the item (e.g. `failed` keeps its other fields, contract §3).
  // A blocked item counts at its fallback estimate, marked (E-4): never also "not estimated".
  if (!NOT_ESTIMATED_STATUS.has(item.status?.kind) && isEstimated(item)) {
    b.estimatedPd += item.effort.pd;
    if (isBlocked(item)) b.blocked++;
  } else {
    b.notEstimated++;
  }
  if (isNotDecomposed(item, profile)) b.notDecomposed++;
  map.set(key, b);
}

function round2(x) { return Math.round(x * 100) / 100; }

function toRows(map) {
  return [...map.entries()].map(([key, v]) => ({ key, ...v, estimatedPd: round2(v.estimatedPd) }));
}

function sumRows(rows) {
  const t = emptyBucket();
  for (const r of rows) { t.items += r.items; t.estimatedPd += r.estimatedPd; t.blocked += r.blocked; t.notEstimated += r.notEstimated; t.notDecomposed += r.notDecomposed; }
  t.estimatedPd = round2(t.estimatedPd);
  return t;
}

/**
 * §2 totals (E-3): by priority (client's values verbatim, empty bucket named `—`) and by tab
 * (one row per `TABS` entry that has items, in `TABS` order; a tab with 0 items is omitted),
 * each `{ key, items, estimatedPd, blocked, notEstimated, notDecomposed }`, plus a total row.
 */
export function totals(items, { profile = null } = {}) {
  const byPrioMap = new Map(), byTabMap = new Map();
  for (const it of items || []) {
    addItem(byPrioMap, it.prio || '—', it, profile);
    addItem(byTabMap, it.tab || '—', it, profile);
  }
  const byPriority = toRows(byPrioMap);
  const tabRows = toRows(byTabMap);
  const byTab = TABS.filter(t => byTabMap.has(t)).map(t => tabRows.find(r => r.key === t));
  return { byPriority, byTab, total: sumRows(byPriority) };
}

/** Every open CQ (contract §1): a `### CQ-<n>` block in §5 with no `Answered` line yet — never a
 * count of blocked items (one CQ can block several, or none it has not been applied to yet). */
export function openQuestions(questions) {
  return (questions || []).filter(q => q.kind === 'cq' && !q.answered);
}

/** Readiness counts (§2 line, P-9). `proposals` is the parsed `proposals.json` array, `questions`
 * the parsed model's §5 blocks, both optional. */
export function readiness(items, { proposals = [], questions = [] } = {}) {
  const list = items || [];
  return {
    total: list.length,
    confirmed: list.filter(i => i.status?.kind === 'confirmed').length,
    reopened: list.filter(i => i.status?.kind === 'reopened').length,
    failed: list.filter(i => i.status?.kind === 'failed').length,
    openCQ: openQuestions(questions).length,
    lowConfidence: list.filter(i => i.confidence === 'low').length,
    waitingProposals: (proposals || []).filter(p => p.status === 'waiting').length,
  };
}

/** Whether an `analyze` batch has work to do (WP-5): items still `queued`/`reopened`, or items
 * `reestimate.json` marks. `reestimate` is the parsed `reestimate.json` array (or `[]`). Used to
 * let analyze through once intake is confirmed, without a `force` override, whenever there is
 * something for it to assess; `force` stays the override for the no-work case. */
export function hasAnalyzeWork(items, reestimate = []) {
  const list = items || [];
  const pending = list.some(i => i.status?.kind === 'queued' || i.status?.kind === 'reopened');
  return pending || (reestimate || []).length > 0;
}

/** Page order (contract §4/SI-4): tabs in `TABS` order, topics within a tab in client
 * first-seen order, items in client order. Same grouping `edit.mjs`'s `renderItemsSection`
 * produces for the rendered document — reused here (not a new sort) so a progressive analyze
 * batch's `items` and the page's "Analysing n of N" header agree with what §4 shows. A group
 * whose tab is not one of `TABS` (a malformed/legacy heading) sorts after the three tabs, in
 * first-seen order, same as the renderer. */
export function pageOrder(items) {
  const groups = new Map(); // key -> { tab, items }
  const order = [];
  for (const it of items || []) {
    const key = it.tab != null && it.topic != null ? `${it.tab}\u0000${it.topic}` : `\u0000legacy\u0000${it.area || ''}`;
    let g = groups.get(key);
    if (!g) { g = { tab: it.tab, items: [] }; groups.set(key, g); order.push(key); }
    g.items.push(it);
  }
  const ordered = [];
  for (const t of TABS) for (const key of order) if (groups.get(key).tab === t) ordered.push(...groups.get(key).items);
  for (const key of order) { const g = groups.get(key); if (!TABS.includes(g.tab)) ordered.push(...g.items); }
  return ordered;
}

const NEEDS_ANALYZE_STATUS = new Set(['queued', 'reopened']);

export const ANALYZE_CHUNK = 45;

/** The next chunk for a progressive analyze batch (IN-11): up to `limit` (default
 * `ANALYZE_CHUNK`) item ids, in page order (`pageOrder`, above), that still need work —
 * `queued`/`reopened`, or named by `reestimate.json`. `reestimate` is the parsed
 * `reestimate.json` array (or `[]`), same shape `proposals.reestimateList` returns.
 * `opts.starProgress` (ids already written since a `*` mark was set): a `*` mark selects only
 * items outside it, so the star walks the document and clears. `opts.skip` (ids applied and
 * unchanged since, still `reopened`): dropped unless an explicit per-item mark names them. */
export function nextAnalyzeItems(items, reestimate = [], limit = ANALYZE_CHUNK, { starProgress = null, skip = null } = {}) {
  const marks = reestimate || [];
  const star = marks.some(r => r.item === '*');
  const marked = new Set(marks.map(r => r.item).filter(i => i !== '*'));
  const done = starProgress || new Set();
  const settled = skip || new Set();
  const due = pageOrder(items).filter(it => marked.has(it.id)
    || (!settled.has(it.id) && ((star && !done.has(it.id)) || NEEDS_ANALYZE_STATUS.has(it.status?.kind))));
  return due.slice(0, limit).map(it => it.id);
}

/** Whether the working document is Ready (L-7): every scope item confirmed. */
export function isReady(items) {
  const list = items || [];
  return list.length > 0 && list.every(i => i.status?.kind === 'confirmed');
}
