// Pure, DOM-free view logic for the Tender Discovery Tool page (0.2.0 item model).
// Kept separate from app.js so filters, state markers and run-report formatting can be
// unit-tested without a browser. Grammar: build contract `tender-0.2.0-contract.md`.
// No imports: mirrors the no-import rule of lib/calc.mjs so this file can also be served
// to the browser unmodified (see server route for /page/lib/calc.mjs).

/** The six Requirement Coverage values, contract §1 (R-1). Empty item.coverage means "not assessed". */
export const COVERAGE_VALUES = ['OOTB', 'Configuration', 'Extension', 'ISV', 'Custom', '—'];

/** T-shirt sizes, small to large (contract §5 / calc.mjs SCALE, minus the OOTB `—` bucket). */
export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

const SIZE_PD = { '—': 0, XS: 0.5, S: 1.5, M: 4, L: 10, XL: 25, XXL: 50 };

/**
 * The effort-filter bucket for one item: a T-shirt size, or (in the profile regime, no size on
 * the item) the size whose PD band the item's PD falls in — so "size" filters work in both
 * regimes (P-2 "effort (size buckets / PD ranges)"). `null` when the item carries no effort yet.
 */
export function effortBucket(item) {
  const e = item?.effort;
  if (!e || typeof e.pd !== 'number') return null;
  if (e.size) return e.size;
  for (const s of ['—', ...SIZES]) if (e.pd <= SIZE_PD[s]) return s;
  return 'XXL';
}

/** Blank filter state (P-2; `prio` restores the 0.1.x priority filter; `changed` restores the
 * 0.1.x "rows the agent changed since your last run" filter, P-0; `sinceExport` is D-34's "changed
 * since last export"). */
export function emptyFilters() {
  return { unconfirmed: false, prio: '', coverage: '', effort: '', openQuestion: false, failed: false, waitingProposals: false, changed: false, sinceExport: false, q: '' };
}

/** Case-insensitive substring match across the fields an operator would search. */
function textHit(item, q) {
  if (!q) return true;
  const hay = [item.id, item.prio, item.requirement, item.clientResponse, item.internalNote,
    ...(item.assumptions || []), ...(item.references || [])].join(' \n ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

/**
 * One scope item against the combinable filters (P-2, AC-28). `waitingProposalIds` is a Set of
 * item ids that have at least one `waiting` proposal (built once per render from `/api/proposals`).
 * `openQuestionIds` is a Set of item ids referenced by an unanswered client question (built by
 * `openQuestionItemIds`, AC-28); when omitted the filter falls back to the item's own `blocked`
 * status, so a caller that has not wired up §5 yet still gets a usable filter. `sinceExportIds` is
 * `/api/session`'s `sinceExport` (D-34) turned into a Set — `null` before this document has ever
 * been exported, in which case the "changed since last export" filter matches nothing.
 */
export function matchesFilters(item, filters, waitingProposalIds = new Set(), openQuestionIds = null, changedIds = null, sinceExportIds = null) {
  const f = { ...emptyFilters(), ...filters };
  if (f.unconfirmed && item.status?.kind === 'confirmed') return false;
  if (f.prio && (item.prio || '') !== f.prio) return false;
  if (f.coverage) {
    const val = f.coverage === '(empty)' ? '' : f.coverage;
    if ((item.coverage || '') !== val) return false;
  }
  if (f.effort && effortBucket(item) !== f.effort) return false;
  if (f.openQuestion) {
    const hit = openQuestionIds ? openQuestionIds.has(item.id) : item.status?.kind === 'blocked';
    if (!hit) return false;
  }
  if (f.failed && item.status?.kind !== 'failed') return false;
  if (f.waitingProposals && !waitingProposalIds.has(item.id)) return false;
  // P-0: "rows the agent changed since your last run" — every id the last run report named as
  // changed, plus a reopened item even when the last report predates the reopen (`changedIds`
  // omitted falls back to reopened-only, so a caller that has not wired up the chat log yet still
  // gets a usable filter).
  if (f.changed) {
    const hit = (changedIds && changedIds.has(item.id)) || item.status?.kind === 'reopened';
    if (!hit) return false;
  }
  // D-34: "changed since last export" — the id is in the last export's `changedSinceLast`/
  // `sinceExport` set; no export yet (`sinceExportIds` null) means nothing matches.
  if (f.sinceExport && !(sinceExportIds && sinceExportIds.has(item.id))) return false;
  if (!textHit(item, f.q)) return false;
  return true;
}

/**
 * Item ids referenced by at least one unanswered client question (AC-28): the "open question"
 * filter matches these, not only items whose own status happens to read `blocked` — a CQ can name
 * several items while only one of them carries the `blocked CQ-n` status.
 */
export function openQuestionItemIds(questions = []) {
  const out = new Set();
  for (const q of questions) {
    if (q.kind !== 'cq' || q.answered) continue;
    for (const id of q.items || []) out.add(id);
  }
  return out;
}

const REOPENED_RE = /^reopened\s+(\d{4}-\d{2}-\d{2}):\s*(.*)$/;
const FAILED_RE = /^failed:\s*(.*)$/;
const COST_RE = /^cost:\s*(.*)$/;

/**
 * State markers visible without opening the item (P-7, AC-28): confirmed, reopened (+ cause),
 * blocked CQ-n, failed (+ reason), not decomposed, cost (+ line, D-33). `isNotDecomposed` is
 * `lib/calc.mjs`'s function, passed in so this module stays import-free; `profile` is the parsed
 * partner profile or null.
 */
export function itemMarkers(item, { isNotDecomposed, profile } = {}) {
  const refs = item?.references || [];
  let reopenedCause = null;
  for (const r of refs) { const m = REOPENED_RE.exec(r); if (m) reopenedCause = m[2]; }
  let failedReason = null;
  for (const r of refs) { const m = FAILED_RE.exec(r); if (m) failedReason = m[1]; }
  let costLine = null;
  for (const r of refs) { const m = COST_RE.exec(r); if (m) costLine = r; }
  return {
    confirmed: item?.status?.kind === 'confirmed',
    confirmedDate: item?.status?.kind === 'confirmed' ? item.status.date : null,
    reopened: item?.status?.kind === 'reopened',
    reopenedCause,
    blockedCq: item?.status?.kind === 'blocked' ? item.status.cq : null,
    failed: item?.status?.kind === 'failed',
    failedReason,
    notDecomposed: typeof isNotDecomposed === 'function' ? Boolean(isNotDecomposed(item, profile || null)) : false,
    cost: Boolean(costLine),
    costLine,
  };
}

/**
 * Bulk confirm warning (P-3, L-2, AC-17): how many items the current filter covers and how many
 * of their proposals are `waiting` (and so would be rejected by the confirm). `proposals` is the
 * full `/api/proposals` array.
 */
export function bulkConfirmPlan(items, proposals = []) {
  const ids = items.filter(i => i.status?.kind !== 'confirmed').map(i => i.id);
  const idSet = new Set(ids);
  const waiting = proposals.filter(p => p.status === 'waiting' && p.item && idSet.has(p.item)).length;
  return { ids, count: ids.length, waitingCount: waiting };
}

/** Set of item ids with at least one `waiting` proposal, for the "waiting proposals" filter. */
export function waitingProposalIds(proposals = []) {
  return new Set(proposals.filter(p => p.status === 'waiting' && p.item).map(p => p.item));
}

/**
 * Suggested-assumptions summary for one scope tab (its own summary bar): how many of `items`'
 * proposals are still `waiting`, and the total PD they would save if every one of them were
 * accepted. `items` is the tab's own items (any subset — the caller decides whether that is every
 * item on the tab or only the currently filtered ones); `proposals` is the full `/api/proposals`
 * array.
 */
export function tabProposalSummary(items, proposals = []) {
  const idSet = new Set((items || []).map(i => i.id));
  const waiting = (proposals || []).filter(p => p.status === 'waiting' && p.item && idSet.has(p.item));
  const pdSaved = waiting.reduce((sum, p) => sum + (typeof p.pdSaved === 'number' ? p.pdSaved : 0), 0);
  return { count: waiting.length, pdSaved, proposals: waiting };
}

// ---------------------------------------------------------------- run report (P-9)

/**
 * P-9's nine labelled fields, in order, and the regexes that read them off the report text.
 * `lib/report.mjs` writes these as snake_case `key: value` lines via `lib/out.mjs`'s `line()`
 * (the skill posts that stdout verbatim as the batch reply, `SKILL.md` §6) — the regexes match
 * that literal runtime shape, not a narrative rewording of it.
 */
export const REPORT_FIELDS = [
  { key: 'state', label: 'State', re: /^state:\s*(.+)$/im },
  { key: 'confirmed', label: 'Confirmed', re: /^confirmed:\s*(.+)$/im },
  { key: 'failed', label: 'Failed', re: /^failed:\s*(.+)$/im },
  { key: 'openCQ', label: 'Open client questions', re: /^open_client_questions:\s*(.+)$/im },
  { key: 'notDecomposed', label: 'Not decomposed', re: /^not_decomposed:\s*(.+)$/im },
  { key: 'lowConfidence', label: 'Low confidence', re: /^low_confidence:\s*(.+)$/im },
  { key: 'effort', label: 'Estimation by priority', re: /^estimation_by_priority:\s*(.+)$/im },
  { key: 'waitingProposals', label: 'Waiting proposals', re: /^waiting_proposals:\s*(.+)$/im },
  { key: 'changed', label: 'What changed', re: /^changed:\s*(.+)$/im },
];

/**
 * `md` (the run-report chat message the skill posts) → an ordered `{ key, label, value }[]` when
 * it recognisably carries the nine P-9 fields, else `null` so the caller falls back to plain
 * markdown. Matching is line-anchored and label-only, so field order and extra prose don't matter.
 */
export function parseRunReport(md) {
  const text = String(md ?? '');
  const fields = REPORT_FIELDS.map(f => { const m = f.re.exec(text); return m ? { key: f.key, label: f.label, value: m[1].trim() } : null; }).filter(Boolean);
  return fields.length >= 5 ? fields : null;
}

/** A chat reply's `changed` field, whatever shape the server sent it in — an id array, or (an
 * older shape) an object of id arrays keyed by kind — as a flat list of ids. */
export function changedIdsFromReply(e) {
  if (Array.isArray(e?.changed)) return e.changed.filter(x => typeof x === 'string');
  if (e?.changed && typeof e.changed === 'object') return Object.values(e.changed).flat().filter(x => typeof x === 'string');
  return [];
}

/**
 * The ids the "changed since last run" filter matches (P-0): every id the most recent agent
 * reply named as changed. Reads the chat log from the end so a later run's report replaces an
 * earlier one instead of accumulating every run ever.
 */
export function lastRunChangedIds(chat = []) {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i]?.type === 'reply') return new Set(changedIdsFromReply(chat[i]));
  }
  return new Set();
}

// ---------------------------------------------------------------- partner profile wizard (P-8)

/** Blank wizard state: four inputs, contract §2. No `licence` field (R-6). */
export function emptyProfileForm() {
  return { calibrationSmall: '', calibrationBig: '', overhead: '', bufferPercent: '', bufferMode: 'folded', isv: [], assets: [] };
}

/** `readProfile()`'s `{ profile }` (or `PUT`/`GET /api/profile` body) → the wizard's editable form. */
export function profileToForm(profile) {
  if (!profile) return emptyProfileForm();
  return {
    calibrationSmall: String(profile.calibration?.small ?? ''),
    calibrationBig: String(profile.calibration?.big ?? ''),
    overhead: String(profile.overhead ?? ''),
    bufferPercent: String(profile.buffer?.percent ?? ''),
    bufferMode: profile.buffer?.mode === 'separate' ? 'separate' : 'folded',
    isv: (profile.isv || []).map(i => ({ name: i.name || '', vendor: i.vendor || '', versions: (i.versions || []).join(', ') })),
    assets: (profile.assets || []).map(a => ({ name: a.name || '', covers: a.covers || '', pdSaved: String(a.pdSaved ?? '') })),
  };
}

/**
 * The wizard form → `PUT /api/profile` body, or `{ errors }` when a required number is missing
 * or not finite. No `licence` field is ever produced (R-6, X-7).
 */
export function formToProfile(form) {
  const errors = [];
  const num = (v, label) => { const n = Number(v); if (v === '' || v == null || !Number.isFinite(n)) { errors.push(`${label} must be a number`); return null; } return n; };
  const small = num(form.calibrationSmall, 'Small calibration');
  const big = num(form.calibrationBig, 'Big calibration');
  const overhead = num(form.overhead, 'Overhead %');
  const bufferPercent = num(form.bufferPercent, 'Buffer %');
  const bufferMode = form.bufferMode === 'separate' ? 'separate' : 'folded';
  const isv = (form.isv || []).filter(i => i.name || i.vendor || i.versions).map(i => ({
    name: i.name || '', vendor: i.vendor || '', versions: String(i.versions || '').split(',').map(s => s.trim()).filter(Boolean),
  }));
  const assets = (form.assets || []).filter(a => a.name || a.covers || a.pdSaved).map(a => ({
    name: a.name || '', covers: a.covers || '', pdSaved: Number(a.pdSaved) || 0,
  }));
  if (errors.length) return { errors };
  return { profile: { calibration: { small, big }, overhead, buffer: { percent: bufferPercent, mode: bufferMode }, isv, assets } };
}

// ---------------------------------------------------------------- glossary tooltips (P-6, §9)

/**
 * §9's raw markdown → `{ term(lowercase): { term, meaning } }`. The grammar leaves §9's body free
 * text, so this reads either a two/three-column table (`| Term | Meaning | Maps to |`) or a bullet
 * list (`- **Term** — meaning`); `Term A / Term B` defines two spellings of the same entry. Terms
 * under two characters are skipped (table separator rows, stray punctuation).
 */
export function parseGlossary(raw) {
  const out = {};
  const add = (rawTerm, meaning, mapsTo) => {
    const term = String(rawTerm ?? '').replace(/[`*]/g, '').trim();
    if (term.length < 2 || /^-+$/.test(term) || term.toLowerCase() === 'term') return;
    for (const alias of term.split(/\s+\/\s+/).map(s => s.trim()).filter(s => s.length >= 2)) {
      out[alias.toLowerCase()] = { term, meaning: String(meaning ?? '').trim(), mapsTo: String(mapsTo ?? '').trim() };
    }
  };
  for (const line of String(raw ?? '').split('\n')) {
    const t = line.trim();
    let m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]*?)\s*)?\|$/.exec(t);
    if (m) { add(m[1], m[2], m[3]); continue; }
    m = /^[-*]\s+\*\*([^*]+)\*\*\s*[:—-]\s*(.+)$/.exec(t);
    if (m) { add(m[1], m[2]); continue; }
  }
  return out;
}

/**
 * Marks every occurrence of a glossary term in already-escaped inline HTML with a `.gloss` span
 * carrying the definition as its title, tag by tag so a replacement never touches markup (an `id`
 * inside an `<a href>`, say). Case-insensitive, whole word only, first match per term per pass.
 */
export function markGlossary(html, gloss) {
  const terms = Object.keys(gloss || {});
  if (!terms.length || !html) return html;
  const re = new RegExp(`(?<![\\w-])(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'gi');
  const mark = (m) => {
    const g = gloss[m.toLowerCase()];
    if (!g) return m;
    const tip = [g.meaning, g.mapsTo ? `→ ${g.mapsTo}` : null].filter(Boolean).join('\n').replace(/"/g, '&quot;');
    return `<span class="gloss" title="${tip}">${m}</span>`;
  };
  let out = '', i = 0;
  for (const tag of html.matchAll(/<[^>]*>/g)) {
    out += html.slice(i, tag.index).replace(re, mark) + tag[0];
    i = tag.index + tag[0].length;
  }
  return out + html.slice(i).replace(re, mark);
}

// ---------------------------------------------------------------- tabs / topics (own-tabs contract §1, §6)

/** The three fixed §4 tabs, canonical render order — mirrors `lib/parse.mjs`'s `TABS` (no import:
 * this file is served to the browser unmodified, same rule as `lib/calc.mjs`). */
export const TABS = ['Functional', 'Non-functional', 'Project & services'];

/**
 * Splits a §4 heading into `{ tab, topic }` — mirrors `lib/parse.mjs`'s `splitHeading`. Returns
 * `{ tab: null, topic: null }` for a heading with no ` · ` separator (never thrown here; the
 * parser is what refuses a malformed document).
 */
export function splitHeading(text) {
  const s = String(text ?? '');
  const idx = s.indexOf('·');
  if (idx < 0 || s[idx - 1] !== ' ') return { tab: null, topic: null };
  return { tab: s.slice(0, idx - 1).trim(), topic: s.slice(idx + 1).trim() };
}

/** Topics under one tab, in client (source) first-seen order — the sub-headings a tab's panel
 * renders (contract §6). Items whose tab does not match are ignored. */
export function topicsOf(items, tab) {
  const seen = [];
  for (const it of items || []) {
    if ((it.tab || '') !== tab) continue;
    const t = it.topic || '';
    if (!seen.includes(t)) seen.push(t);
  }
  return seen;
}

/** Every item on one tab, grouped by topic in first-seen order: `[{ topic, items }]`. Empty tab
 * yields `[]` — the caller renders "No items" for that case (contract §6). */
export function groupByTopic(items, tab) {
  const topics = topicsOf(items, tab);
  return topics.map(topic => ({ topic, items: (items || []).filter(it => (it.tab || '') === tab && (it.topic || '') === topic) }));
}

// ---------------------------------------------------------------- Queued (n) block (replaces the Notes panel)

const numPd = v => (v == null || v === '' ? null : (Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(2).replace(/\.?0+$/, '')));

/**
 * One row per queued entry, for the Agent card's `Queued (n)` accordion (ported from the Specs
 * Editor's `renderQueued`/`queuedRow`): `missing` when the entry names a block/item/question the
 * current model no longer carries (or no model has loaded yet); `ref` is the clickable block id,
 * `kind` the label shown instead for an entry with no block (a free/chat-only entry); `title` is
 * the row's tooltip — the quote and, if the operator highlighted text, the selection. A `decision`
 * entry (P-2: queued accept/reject) reads as "Accept P-3 · GEN-04 · −2 PD" instead.
 */
export function queuedRows(notes = [], model = null) {
  const ids = new Set([
    ...((model?.items || []).map(i => i.id)),
    ...((model?.blocks || []).map(b => b.id)),
    ...((model?.questions || []).map(q => q.id)),
  ]);
  return (notes || []).map(n => {
    if (n && n.type === 'decision' && n.action === 'answer') {
      const q = (model?.questions || []).find(x => x.id === n.cq);
      return {
        id: n.id,
        missing: !q || Boolean(q.answered),
        ref: n.item || null,
        kind: null,
        text: `Answer ${n.cq} · option ${n.key}`,
        title: n.statement || '',
      };
    }
    if (n && n.type === 'decision') {
      const label = n.action === 'reject' ? 'Reject' : 'Accept';
      const pd = numPd(n.pdSaved);
      return {
        id: n.id,
        missing: Boolean(n.item) && (!model || !ids.has(n.item)),
        ref: n.item || null,
        kind: null,
        text: [`${label} ${n.proposal || ''}`.trim(), n.item, pd != null ? `−${pd} PD` : null].filter(Boolean).join(' · '),
        title: n.statement || '',
      };
    }
    return {
      id: n.id,
      missing: Boolean(n.block) && (!model || !ids.has(n.block)),
      ref: n.block || null,
      kind: n.block ? null : (n.kind || 'free'),
      text: n.text || '',
      // `selection` mirrors `quote` when the operator's highlight became the quote itself
      // (`openNoteEditor`, page/app.js): show it once, never both lines saying the same thing.
      title: [n.quote ? `“${n.quote}”` : null, n.selection && n.selection !== n.quote ? n.selection : null].filter(Boolean).join('\n'),
    };
  });
}

/**
 * Queues (or changes, or undoes) one accept/reject decision for a suggested-assumption proposal
 * (P-2): the page's Accept/Reject chip and "Accept all on this tab" call this instead of posting
 * to `/api/proposal/:id/accept|reject` directly. At most one `decision` entry per proposal —
 * clicking the same action again removes the entry (undo); clicking the other action replaces it.
 * `proposal` is the `/api/proposals` shape (`{ id, item, statement, pdSaved }`).
 */
export function toggleDecision(notes, proposal, action) {
  const list = notes || [];
  const idx = list.findIndex(n => n && n.type === 'decision' && n.action !== 'answer' && n.proposal === proposal.id);
  if (idx >= 0) {
    if (list[idx].action === action) return list.filter((_, i) => i !== idx);
    const updated = list.slice();
    updated[idx] = { ...updated[idx], action };
    return updated;
  }
  const entry = {
    id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    type: 'decision', proposal: proposal.id, item: proposal.item ?? null, action,
    statement: proposal.statement || '', pdSaved: proposal.pdSaved,
  };
  return [...list, entry];
}

/** The pending decision entry for one proposal, or `null` — drives the suggestion chip's queued
 * state (page/app.js `suggestionChipBody`). */
export function decisionFor(notes, proposalId) {
  return (notes || []).find(n => n && n.type === 'decision' && n.action !== 'answer' && n.proposal === proposalId) || null;
}

/** The queued answer entry for one question, or `null`. */
export function answerFor(notes, cq) {
  return (notes || []).find(n => n && n.type === 'decision' && n.action === 'answer' && n.cq === cq) || null;
}

/** Queues (or replaces, or undoes) the answer for one client question: one entry per question;
 * picking the same option again removes it. `q` is the model question (`{ id, question, items }`). */
export function toggleAnswer(notes, q, key) {
  const list = notes || [];
  const idx = list.findIndex(n => n && n.type === 'decision' && n.action === 'answer' && n.cq === q.id);
  if (idx >= 0) {
    if (list[idx].key === key) return list.filter((_, i) => i !== idx);
    const updated = list.slice();
    updated[idx] = { ...updated[idx], key };
    return updated;
  }
  return [...list, {
    id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    type: 'decision', action: 'answer', cq: q.id, key, item: (q.items || [])[0] ?? null, statement: q.question || '',
  }];
}

/** Count of queued decisions in `notes` — `Send (n)` and the auto-send threshold both read this. */
export function decisionCount(notes = []) {
  return (notes || []).filter(n => n && n.type === 'decision').length;
}

/** Queued decisions among `items`' own proposals (one scope tab's summary bar, P-2). */
export function tabDecisionCount(items, notes = []) {
  const idSet = new Set((items || []).map(i => i.id));
  return (notes || []).filter(n => n && n.type === 'decision' && idSet.has(n.item)).length;
}

/** Whether Send should be enabled: at least one queued entry, or non-empty chat text (whitespace
 * does not count) — mirrors the server's own `enqueue` refusal for a `notes` batch. */
export function canSend(queuedCount, chatText) {
  return Boolean(queuedCount) || Boolean(String(chatText ?? '').trim());
}

/** The foldable agent panel's state from `localStorage`'s `tender-tool:panel` value: default open,
 * anything but the literal `closed` (missing key, garbage) reads as open. */
export function panelState(stored) {
  return stored === 'closed' ? 'closed' : 'open';
}

// ---------------------------------------------------------------- coverage token check (RC-4/T1)

// Every one of the six Requirement Coverage values, `—` included, is work the partner delivers
// (`—` names non-Shopware work, e.g. training — it is not "we don't do this") — a client token
// that reads as an outright refusal contradicts that for any of them. An "n/a"/"not applicable"
// token is not a refusal: it is the legitimate, client-side way of saying "not applicable", the
// exact shape `—` maps to. Reused by the `tokens --file` validation (lib/ops.mjs) at export time,
// where the six-value -> client-token map is decided (RC-4).
const NEGATIVE_TOKEN_RE = /^(not[\s.-]?(offered|supported|available)|no\b|none|nicht[\s.-]?(erf(u|ü)llt|verf(u|ü)gbar|unterst(u|ü)tzt))\b/i;

/** Whether `token` reads as an outright refusal ("not supported", "no", …) — T1. Never true for an
 * "n/a"/"not applicable"-style token — that is a legitimate answer, not a refusal. */
export function isNegativeToken(token) {
  return NEGATIVE_TOKEN_RE.test(String(token ?? '').trim());
}
