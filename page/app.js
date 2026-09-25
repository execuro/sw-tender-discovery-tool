/* Tender Discovery Tool page - vanilla ES module, no build step. 0.2.0 item model.
   Shell (header, notes stack, popover, annotate mode, chat, session/SSE wiring) kept from 0.1.x;
   the §4 grid, filters, proposals, profile wizard and export preview are new (WP-5, P-0..P-9).
   Pure filter/marker/report logic lives in ./view.mjs so it is unit-testable without a browser. */
import { isNotDecomposed } from './lib/calc.mjs';
import {
  COVERAGE_VALUES, SIZES, TABS, emptyFilters, matchesFilters, itemMarkers, bulkConfirmPlan,
  waitingProposalIds, tabProposalSummary, openQuestionItemIds, parseRunReport, emptyProfileForm, profileToForm, formToProfile,
  groupByTopic, parseGlossary, markGlossary, changedIdsFromReply, lastRunChangedIds,
  queuedRows, panelState, canSend, toggleDecision, decisionFor, answerFor, toggleAnswer, decisionCount, tabDecisionCount,
} from './view.mjs';

// P-2: once queued decisions (accept/reject on suggestion chips) exceed this count, the queue
// sends itself instead of waiting for the operator to press Send — never while a run holds the
// lock (queued behind it, sent once the run ends, see the `run` SSE handler below).
const AUTO_SEND_DECISIONS_ABOVE = 15;

// Fixed tabs, always present, in this order (build contract §6): Overview, Project information,
// the three §4 scope tabs, then §6 Integrations, §7 Glossary, §8 Log as their own tabs.
const FIXED_TABS = [
  { key: '__overview__', label: 'Overview' },
  { key: '__projectinfo__', label: 'Project information' },
  ...TABS.map(t => ({ key: t, label: t, scope: true })),
  { key: '__sec6__', n: 6, label: 'Integrations' },
  { key: '__sec7__', n: 7, label: 'Glossary' },
  { key: '__sec8__', n: 8, label: 'Log' },
];

// ---------------------------------------------------------------- state
const S = {
  session: null, analysis: null, source: null, model: null, notes: [], chat: [],
  proposals: [], profile: null, profilePath: null, profileLegacy: false, profileChecked: false,
  changed: new Set(),
  area: { active: null }, // one of FIXED_TABS' keys, plus 'overview'
  filters: emptyFilters(),
  agent: { present: false, everPolled: false }, run: null, queue: [], queuedWrites: 0, closed: false, serverGone: false, parseError: null,
  intake: { state: null, notTaken: 0, unusedSheets: [] }, fitBack: null, sinceExport: null, // D-34: ids changed since the last export, null before the first export
  tab: Math.random().toString(36).slice(2, 10), annotate: false, wizardOpen: false, wizardForm: null, wizardSaving: false,
  expanded: new Set(), // P-0: item ids whose clamped long cells (Requirement, Client Response, Internal note) are lifted open
  queuedOpen: true, panelOpen: true,
};
const LS = { filters: 'tender-tool:filters', annotate: 'tender-tool:annotate', area: 'tender-tool:area', wizardSkipped: 'tender-tool:wizard-skipped', panel: 'tender-tool:panel' };
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'dataset') Object.assign(n.dataset, v); else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ap = (node, ...kids) => { for (const k of kids.flat()) if (k != null) node.append(k); return node; };
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
const num = v => v == null || v === '' ? '—' : (Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(2).replace(/\.?0+$/, ''));

// ---------------------------------------------------------------- markdown (raw HTML escaped)
const renderer = new marked.Renderer();
renderer.html = ({ text }) => esc(text);
marked.use({ renderer, gfm: true, breaks: false });
const md = (text) => { try { return marked.parse(String(text ?? '')); } catch { return esc(text); } };
const mdInline = (text) => { try { return marked.parseInline(String(text ?? '')); } catch { return esc(text); } };
const ID_RE = /(^|[\s(>,.])([A-Z][A-Z0-9]{0,5}-\d+)(?=[\s.,;:)<]|$)/g;
function linkifyIds(html) {
  return html.replace(ID_RE, (m, pre, id) => (S.idSet && S.idSet.has(id)) || /^(?:CQ|Q)-\d+$/.test(id) ? `${pre}<a class="blocklink" href="#${id}" data-goto="${id}">${id}</a>` : m);
}
// §9 terms get their tooltip wherever tool text is rendered (P-6); S.gloss is empty until a
// working document with a §9 body loads, so this is a no-op before that.
function inlineHtml(text) { return markGlossary(linkifyIds(mdInline(String(text ?? '').replace(/<br\s*\/?>/gi, '\n'))).replace(/\n/g, '<br>'), S.gloss); }
function renderMd(text, cls = 'md') { const d = el('div', { class: cls }); d.innerHTML = markGlossary(linkifyIds(md(text)), S.gloss); return d; }

// ---------------------------------------------------------------- api
async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) throw Object.assign(new Error(j.reason || j.error || `HTTP ${r.status}`), { status: r.status, body: j });
  j._status = r.status;
  return j;
}

// ---------------------------------------------------------------- model helpers
function itemById(id) { return (S.model?.items || []).find(i => i.id === id) || null; }
function blockById(id) { return (S.model?.blocks || []).find(b => b.id === id) || null; }
function questionById(id) { return (S.model?.questions || []).find(q => q.id === id) || null; }
function proposalsFor(itemId) { return S.proposals.filter(p => p.item === itemId); }
function globalProposals() { return S.proposals.filter(p => p.item == null); }
function recompute() {
  S.idSet = new Set((S.model?.items || []).map(i => i.id));
  const glossSec = (S.model?.blocks || []).find(b => b.n === 7);
  S.gloss = parseGlossary(glossSec?.raw || '');
  S.openQuestionIds = openQuestionItemIds(S.model?.questions || []);
  const remembered = lsGet(LS.area, null);
  const keys = FIXED_TABS.map(t => t.key);
  if (!keys.includes(S.area.active)) S.area.active = keys.includes(remembered) ? remembered : '__overview__';
}
/** Glossary-aware inline HTML for the client's own wording (requirement text): linkified ids, no
 * markdown reinterpretation, §9 terms marked with their tooltip (P-6). */
function reqCellHtml(text) { return markGlossary(linkifyIds(esc(text || '')).replace(/\n/g, '<br>'), S.gloss); }

// ---------------------------------------------------------------- Queued (n) block (Specs Editor accordion)
function noteFor(block) { return S.notes.find(n => n.block === block && n.kind !== 'free'); }
function addNote(n) {
  n.id = n.id || 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  S.notes.push(n);
  S.queuedOpen = true;
  saveNotes(); renderQueued(); markNoted();
}
let saveTimer = null;
function saveNotes() { clearTimeout(saveTimer); saveTimer = setTimeout(() => api('/api/notes', { notes: S.notes, tab: S.tab }).catch(() => {}), 400); }
function noteContext(block) {
  return {
    file: S.analysis || null, block: block.id, blockKind: block.kind,
    line: block.line ?? null, endLine: block.endLine ?? block.line ?? null,
    quote: (block.raw || block.title || block.requirement || '').slice(0, 200),
  };
}
function rebindNotes() {
  for (const n of S.notes) {
    if (n.type === 'decision' && n.action === 'answer') { const q = questionById(n.cq); n.missing = !q || Boolean(q.answered); continue; }
    if (!n.block || n.kind === 'free') continue;
    n.missing = !S.model || !(blockById(n.block) || itemById(n.block) || questionById(n.block));
  }
}
function markNoted() {
  document.querySelectorAll('#doc .noted').forEach(e => e.classList.remove('noted'));
  for (const n of S.notes) if (n.block) document.querySelectorAll(`#doc [data-id="${CSS.escape(n.block)}"]`).forEach(e => e.classList.add('noted'));
}
/** The Agent card's `Queued (n)` accordion — replaces the old Notes panel (ported from
 * sw-specs-editor's `renderQueued`/`queuedRow`); `queuedRows` (view.mjs) is the pure row logic. */
function renderQueued() {
  const box = $('#queued'), host = $('#queued-list'), chat = $('#chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 24;
  box.hidden = false;
  box.classList.toggle('collapsed', !S.queuedOpen);
  $('#queued-toggle').setAttribute('aria-expanded', String(S.queuedOpen));
  $('#queued-count').textContent = S.notes.length ? `(${S.notes.length})` : '';
  $('#queued-clear').hidden = !S.notes.length;
  host.innerHTML = '';
  const rows = queuedRows(S.notes, S.model);
  if (!rows.length) host.append(el('div', { class: 'q-empty' }, 'No queued messages'));
  else for (let i = 0; i < rows.length; i++) host.append(queuedRow(S.notes[i], rows[i]));
  if (atBottom) chat.scrollTop = chat.scrollHeight;
  updateSendButton();
  renderRail();
}
function queuedRow(n, row) {
  return el('div', { class: 'q-row' + (row.missing ? ' missing' : ''), dataset: { nid: n.id }, title: row.title || null },
    row.missing ? el('span', { class: 'q-kind' }, '⚠') : null,
    row.ref ? el('span', { class: 'q-ref', onclick: () => gotoBlock(row.ref) }, row.ref) : el('span', { class: 'q-kind' }, row.kind),
    el('div', { class: 'q-text' }, row.text),
    el('button', { class: 'q-x', type: 'button', title: 'Remove from the batch', onclick: () => removeQueued(n) }, '✕'));
}
function removeQueued(n) {
  S.notes = S.notes.filter(x => x !== n);
  saveNotes(); renderQueued(); markNoted();
  if (n.type === 'decision' && n.action === 'answer') refreshQuestionCard(n.cq);
  else if (n.type === 'decision') refreshSuggestionChip(n.proposal);
}
function clearQueued() {
  if (!S.notes.length) return;
  if (!confirm(`Remove all ${S.notes.length} queued item(s)? Nothing is sent to the agent.`)) return;
  const removed = S.notes.filter(n => n.type === 'decision');
  S.notes = [];
  saveNotes(); renderQueued(); markNoted();
  for (const n of removed) { if (n.action === 'answer') refreshQuestionCard(n.cq); else refreshSuggestionChip(n.proposal); }
}
function updateSendButton() {
  const b = $('#chat-send'), n = S.notes.length, text = $('#chat-text') && $('#chat-text').value || '';
  b.disabled = S.closed || !canSend(n, text);
  b.textContent = n ? `Send (${n})` : 'Send';
}
async function sendBatch(chatText) {
  const chat = (chatText || '').trim();
  if (!S.notes.length && !chat) return;
  if (!S.agent.present && !confirm('The agent is not connected (no session loop polling). The batch will wait in the queue until the skill is (re)started. Send anyway?')) return;
  try {
    // `missing` is a client-side flag (`rebindNotes`) for the queue's own display; never post it.
    const notes = S.notes.map(({ missing, ...n }) => n);
    const r = await api('/api/batch', { kind: 'notes', notes, chat });
    S.notes = []; S.queuedOpen = true; saveNotes(); renderQueued(); markNoted(); S.changed.clear();
    $('#chat-text').value = ''; $('#chat-text').style.height = '';
    document.querySelectorAll('#doc .changed').forEach(e => e.classList.remove('changed'));
    if (r.queued) toast(`Batch ${r.id} queued behind the active run.`, 'info');
    return r;
  } catch (e) { toast('Send failed: ' + e.message, 'bad'); }
}

// ---------------------------------------------------------------- note popover (floats next to the annotated block)
const pop = { open: false, id: null, ctx: null, existing: null, selection: '' };
const popEl = () => $('#note-popover');
function anchorEl() { return pop.id ? document.querySelector(`#doc [data-id="${CSS.escape(pop.id)}"]`) : null; }
function closeNoteEditors() {
  const p = popEl();
  if (!pop.open) return;
  pop.open = false; p.hidden = true;
  document.querySelectorAll('#doc .anchored').forEach(e => e.classList.remove('anchored'));
}
function blockLike(id) {
  const item = itemById(id); if (item) return { id, kind: 'item', requirement: item.requirement };
  const q = questionById(id); if (q) return { id, kind: 'question', title: q.question };
  return blockById(id);
}
function openNoteEditor(blockEl, id, extra = {}) {
  const p = popEl();
  const block = blockLike(id); if (!block) return;
  if (pop.open && pop.id === id && !extra.selection) { p.querySelector('textarea').focus(); return; }
  closeNoteEditors();
  const existing = noteFor(id);
  const ctx = noteContext(block);
  // A text selection inside the block (P-0: select text in any block → note) is the quote the
  // operator actually meant, not the block's own opening words `noteContext` falls back to.
  if (extra.selection) ctx.quote = extra.selection;
  Object.assign(pop, { open: true, id, ctx, existing, selection: extra.selection || '' });
  const meta = p.querySelector('.ne-ctx'); meta.innerHTML = '';
  meta.append(el('span', { class: 'id' }, id), el('span', { class: 'muted' }, ctx.line ? ` L${ctx.line}` : ''));
  const sel = p.querySelector('.ne-sel');
  sel.hidden = !extra.selection;
  sel.textContent = extra.selection ? '“' + extra.selection + '”' : '';
  const ta = p.querySelector('textarea'); ta.value = existing ? existing.text : '';
  p.querySelector('.save').textContent = existing ? 'Update note' : 'Add note';
  p.querySelector('.delete').hidden = !existing;
  p.hidden = false;
  positionPopover();
  ta.focus();
}
function positionPopover() {
  const p = popEl();
  if (!pop.open) return;
  const a = anchorEl();
  if (!a) { closeNoteEditors(); return; }
  a.classList.add('anchored');
  const docR = $('#doc').getBoundingClientRect();
  const r = a.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(420, vw - 16);
  p.style.width = w + 'px';
  const h = p.offsetHeight, gap = 10;
  const fitsBelow = r.bottom + gap + h <= Math.min(vh, docR.bottom) - 8;
  let top = fitsBelow ? r.bottom + gap : Math.max(docR.top + 8, Math.min(r.bottom + gap, vh - h - 8));
  let left = Math.min(Math.max(8, r.left), vw - w - 8);
  p.style.top = top + 'px'; p.style.left = left + 'px';
  const arrow = p.querySelector('.arrow');
  arrow.style.left = Math.min(Math.max(14, r.left + Math.min(24, r.width / 2) - left), w - 26) + 'px';
}
function savePopover() {
  const p = popEl();
  const text = p.querySelector('textarea').value.trim();
  if (!text) { p.querySelector('textarea').focus(); return; }
  const withSelection = pop.selection ? { ...pop.ctx, selection: pop.selection } : pop.ctx;
  if (pop.existing) { pop.existing.text = text; Object.assign(pop.existing, withSelection); saveNotes(); renderQueued(); }
  else addNote({ kind: 'comment', ...withSelection, text });
  closeNoteEditors();
}
{
  const p = popEl();
  p.querySelector('.save').addEventListener('click', savePopover);
  p.querySelector('.cancel').addEventListener('click', closeNoteEditors);
  p.querySelector('.delete').addEventListener('click', () => {
    if (pop.existing) { S.notes = S.notes.filter(x => x !== pop.existing); saveNotes(); renderQueued(); markNoted(); }
    closeNoteEditors();
  });
  p.querySelector('textarea').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); savePopover(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNoteEditors(); }
  });
  $('#doc').addEventListener('scroll', positionPopover, { passive: true });
  window.addEventListener('resize', positionPopover);
  document.addEventListener('mousedown', (e) => {
    if (!pop.open || p.contains(e.target)) return;
    if (S.annotate && e.target.closest('#doc [data-id]')) return;
    closeNoteEditors();
  });
}

// ---------------------------------------------------------------- annotate mode (header switch; click any block to note it)
const INTERACTIVE = 'a, button, input, textarea, select, label, summary, .opt, .opt *, .filters *, .wizard *, .answer *, .proposal *';
let pressedBlock = null;
function blockElAt(target) { return target.closest ? target.closest('#doc [data-id]') : null; }
function setAnnotate(on, persist = true) {
  S.annotate = Boolean(on);
  document.body.classList.toggle('annotating', S.annotate);
  $('#annotate-toggle').checked = S.annotate;
  if (!S.annotate) closeNoteEditors();
  if (persist) lsSet(LS.annotate, S.annotate ? 1 : 0);
}
/** Text the operator highlighted inside `elm` (P-0: select text in any block → note), trimmed and
 * capped so a whole-paragraph drag does not blow up the popover. Empty when nothing is selected,
 * the selection is collapsed (a plain click), or it reaches outside the block entirely. */
function selectionInside(elm) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const range = sel.getRangeAt(0);
  if (!elm.contains(range.commonAncestorContainer)) return '';
  return sel.toString().trim().slice(0, 500);
}
$('#doc').addEventListener('mousedown', (e) => { pressedBlock = S.annotate && e.button === 0 ? blockElAt(e.target) : null; });
$('#doc').addEventListener('mouseup', (e) => {
  if (!S.annotate || e.button !== 0) return;
  const blockEl = blockElAt(e.target);
  const pressed = pressedBlock; pressedBlock = null;
  if (!blockEl || blockEl !== pressed) return;
  if (e.target.closest(INTERACTIVE)) return;
  const selection = selectionInside(blockEl);
  openNoteEditor(blockEl, blockEl.dataset.id, selection ? { selection } : {});
});
$('#annotate-toggle').addEventListener('change', (e) => setAnnotate(e.target.checked));
// §4 grid: click a requirement row (outside its controls, and not while annotating) to lift the
// line-clamp off its long cells (Requirement, Client Response, Internal note — References is
// never clamped) instead of opening a separate detail view; every column is already in the row.
$('#doc').addEventListener('click', (e) => {
  if (S.annotate) return;
  const tr = e.target.closest('tr.req-row');
  if (!tr || e.target.closest(INTERACTIVE)) return;
  const id = tr.dataset.id; if (!id) return;
  if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
  tr.classList.toggle('expanded');
});
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape' && !inField) { if (pop.open) closeNoteEditors(); else if (S.annotate) setAnnotate(false); return; }
  if ((e.key === 'a' || e.key === 'A') && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setAnnotate(!S.annotate); }
});
if (lsGet(LS.annotate, 0) === 1) setAnnotate(true, false);

// ---------------------------------------------------------------- §4 grid: state markers, coverage, effort
const COVERAGE_LABEL = c => c || '—';
function coverageBadge(item) {
  const c = item.coverage || '';
  return el('span', { class: 'badge cov cov-' + (c ? c.toLowerCase() : 'none') }, COVERAGE_LABEL(c));
}
function effortText(effort) {
  if (!effort) return '—';
  if (effort.regime === 'profile') return `${num(effort.pd)} PD`;
  if (effort.size === '—') return '— (0 PD)';
  return `${effort.size} (${num(effort.pd)} PD)`;
}
function markerBadges(item) {
  const m = itemMarkers(item, { isNotDecomposed, profile: S.profile });
  const out = [];
  if (m.confirmed) out.push(el('span', { class: 'badge marker confirmed', title: 'confirmed ' + m.confirmedDate }, 'confirmed ' + m.confirmedDate));
  if (m.reopened) out.push(el('span', { class: 'badge marker reopened', title: m.reopenedCause || 'reopened' }, 'reopened' + (m.reopenedCause ? ': ' + m.reopenedCause : '')));
  if (m.blockedCq) out.push(el('a', { class: 'badge marker blocked', href: '#' + m.blockedCq, dataset: { goto: m.blockedCq } }, 'blocked ' + m.blockedCq));
  if (m.failed) out.push(el('span', { class: 'badge marker failed', title: m.failedReason || 'failed' }, 'failed' + (m.failedReason ? ': ' + m.failedReason : '')));
  if (m.notDecomposed) out.push(el('span', { class: 'badge marker not-decomposed', title: 'too large to estimate reliably (E-2)' }, 'not decomposed'));
  if (m.cost) out.push(el('span', { class: 'badge marker cost', title: m.costLine }, 'cost'));
  return out;
}

// ---------------------------------------------------------------- editable-in-place (Client Response / Internal note, P-5;
// Project information Value): a visible, always-editable textarea, never a click-to-edit swap.
// `focusedCell` + `pendingDoc` (below, wired from applyDoc) keep an SSE `doc` update from wiping
// what the operator is typing: the update is buffered until the cell blurs.
let focusedCell = null; // { id, field } of the textarea currently focused, or null
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
/** The shared always-editable textarea: grows with its content, saves on blur or Ctrl/Cmd+Enter
 * when the value changed, Esc reverts to the last saved value. `onSave(value)` persists the change
 * and may return `false` to reject it (the textarea then reverts). `focusKey` (`{ id, field }`)
 * feeds the SSE focus-buffering above; omit it for a field that isn't reloaded from `doc` events. */
function liveTextarea(value, placeholder, onSave, focusKey) {
  const ta = el('textarea', { class: 'sheet-cell', placeholder, rows: '1' });
  let saved = value || '';
  ta.value = saved;
  const save = async () => {
    const v = ta.value;
    if (v === saved) return;
    const ok = await onSave(v);
    if (ok === false) ta.value = saved; else saved = v;
  };
  if (focusKey) ta.addEventListener('focus', () => { focusedCell = focusKey; });
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('blur', async () => {
    await save();
    if (focusKey && focusedCell && focusedCell.id === focusKey.id && focusedCell.field === focusKey.field) focusedCell = null;
    flushPendingDoc();
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ta.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); ta.value = saved; ta.blur(); }
  });
  setTimeout(() => autosize(ta), 0);
  return ta;
}
function editableCell(item, field, placeholder) {
  const td = el('td', { class: 'long-col editable-cell' });
  const ta = liveTextarea(item[field], placeholder, async (v) => {
    const prev = item[field]; item[field] = v;
    try {
      const body = field === 'clientResponse' ? { clientResponse: v } : { internalNote: v };
      await api(`/api/item/${encodeURIComponent(item.id)}`, body, 'PATCH');
    } catch (e) { item[field] = prev; toast(`Save failed: ${e.message}`, 'bad'); return false; }
  }, { id: item.id, field });
  td.append(ta);
  return td;
}

// ---------------------------------------------------------------- assumptions (accept/reject proposals, type/remove)
/** Queues (or changes, or undoes — `toggleDecision`) an accept/reject decision for a suggestion
 * chip: no API call, unlike the old `acceptProposal`/`rejectProposal` (P-2 change 1). The chip
 * updates itself in place (`refreshSuggestionChip`), and crossing the auto-send threshold may send
 * the whole queue right away. */
function toggleProposalDecision(p, action) {
  S.notes = toggleDecision(S.notes, p, action);
  S.queuedOpen = true;
  saveNotes(); renderQueued();
  refreshSuggestionChip(p.id);
  maybeAutoSendDecisions();
}
/** Re-renders one suggestion chip's body from its current decision state, wherever it appears
 * (an item's assumptions cell, the Global proposals card) — never a full `renderArea()` (P-2: "no
 * table jump on accept or reject", change 1). */
function refreshSuggestionChip(proposalId) {
  const p = S.proposals.find(x => x.id === proposalId);
  if (!p) return;
  document.querySelectorAll(`#doc .proposal.chip.suggested[data-proposal="${CSS.escape(proposalId)}"]`).forEach(li => {
    li.innerHTML = '';
    for (const node of suggestionChipBody(p)) if (node) li.append(node);
  });
}
/** Sends the queue once queued decisions cross the threshold (P-2 change 1's auto-send) — never
 * while a run holds the lock; the `run`/heartbeat SSE handling below re-checks once it clears, so
 * the send still happens, just after the run instead of during it. */
function maybeAutoSendDecisions() {
  if (S.run) return;
  if (decisionCount(S.notes) <= AUTO_SEND_DECISIONS_ABOVE) return;
  toast(`${AUTO_SEND_DECISIONS_ABOVE}+ decisions queued — sent to the agent.`, 'info');
  sendBatch('');
}
async function addAssumption(item, statement) {
  if (!statement.trim()) return;
  try { await api(`/api/item/${encodeURIComponent(item.id)}/assumption`, { statement: statement.trim() }); await load(); }
  catch (e) { toast(`Add assumption failed: ${e.message}`, 'bad'); }
}
async function removeAssumption(item, statement) {
  try { await api(`/api/item/${encodeURIComponent(item.id)}/assumption/remove`, { statement }); await load(); }
  catch (e) { toast(`Remove assumption failed: ${e.message}`, 'bad'); }
}
// Inline SVG check mark shared by the confirm button and a suggestion's Accept chip button;
// declared once (used again as `TICK_SVG` further down) so both share the exact same glyph.
const SUGGESTION_TICK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 8.5 6.5 12 13 4"></polyline></svg>';
/** One waiting proposal, rendered as a highlighted "Suggested" chip (item-level assumptions cell
 * and the Global proposals card share this), as three stacked rows so nothing overflows the cell:
 * "Suggested" label + "−N PD" badge on top, the full statement below (wraps, never truncates),
 * then an Accept button styled the same as the row's own confirm tick, and a Reject ×, aligned
 * right on their own row. Once a decision is queued for it (P-2), the actions are replaced by the
 * pending state instead: "✓ accept queued" (green outline) or "✗ reject queued" (struck through),
 * each with a small ↺ to undo. */
function suggestionChipBody(p) {
  const d = decisionFor(S.notes, p.id);
  if (d) {
    const label = d.action === 'accept' ? '✓ accept queued' : '✗ reject queued';
    return [el('div', { class: 'chip-pending ' + d.action },
      el('span', { class: 'chip-pending-label' }, label),
      el('button', { class: 'btn sm subtle chip-undo', type: 'button', title: 'Undo', onclick: () => toggleProposalDecision(p, d.action) }, '↺'))];
  }
  const accept = el('button', { class: 'btn-confirm accept-proposal', type: 'button', title: 'Accept this suggestion', onclick: () => toggleProposalDecision(p, 'accept') });
  accept.innerHTML = SUGGESTION_TICK_SVG;
  return [
    el('div', { class: 'chip-top' },
      el('span', { class: 'chip-label' }, 'Suggested'),
      el('span', { class: 'muted pd-saved' }, `−${num(p.pdSaved)} PD`)),
    el('div', { class: 'stmt' }, p.statement),
    el('div', { class: 'chip-actions' },
      el('button', { class: 'btn sm subtle', type: 'button', title: 'Reject this suggestion', onclick: () => toggleProposalDecision(p, 'reject') }, '×'),
      accept),
  ];
}
function assumptionsCell(item) {
  const td = el('td', { class: 'long-col' });
  const list = el('ul', { class: 'assumptions' });
  for (const a of item.assumptions || []) {
    list.append(el('li', {}, el('span', { class: 'stmt' }, a), el('button', { class: 'btn sm subtle', title: 'remove this assumption', onclick: () => removeAssumption(item, a) }, '×')));
  }
  for (const p of proposalsFor(item.id).filter(p => p.status === 'waiting')) {
    list.append(el('li', { class: 'proposal chip suggested', dataset: { proposal: p.id } }, suggestionChipBody(p)));
  }
  td.append(list);
  const add = el('input', { type: 'text', class: 'add-assumption', placeholder: '+ assumption' });
  add.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAssumption(item, add.value); add.value = ''; } });
  td.append(add);
  return td;
}

// ---------------------------------------------------------------- confirm / patch actions
function skippedMessage(skipped) {
  return skipped.map(s => `${s.id}: ${s.reason}`).join(' · ');
}
async function confirmItems(ids) {
  try {
    const r = await api('/api/confirm', { ids });
    if (r.queued) { toast('Confirm queued - applies when the run ends.', 'info'); return; }
    const scroll = captureScroll();
    await refreshProposals(); await load();
    restoreScroll(scroll);
    const confirmedCount = r.confirmed ? r.confirmed.length : 0;
    if (confirmedCount) toast(`Confirmed ${confirmedCount} item${confirmedCount === 1 ? '' : 's'}.`, 'ok');
    if (r.skipped && r.skipped.length) toast(`Skipped ${r.skipped.length}: ${skippedMessage(r.skipped)}`, confirmedCount ? 'info' : 'bad');
  } catch (e) {
    // A bulk confirm that skipped every id still carries the per-id reasons (build contract §4).
    if (e.body && Array.isArray(e.body.skipped) && e.body.skipped.length) toast(`Confirm failed: ${skippedMessage(e.body.skipped)}`, 'bad');
    else toast(`Confirm failed: ${e.message}`, 'bad');
  }
}
/** Reverses `confirmItems` for one row (no confirmation dialog — cheap to re-confirm right
 * after, contract §4). */
async function unconfirmItems(ids) {
  try {
    const r = await api('/api/unconfirm', { ids });
    if (r.queued) { toast('Unconfirm queued - applies when the run ends.', 'info'); return; }
    const scroll = captureScroll();
    await refreshProposals(); await load();
    restoreScroll(scroll);
    const count = r.unconfirmed ? r.unconfirmed.length : 0;
    if (count) toast(`Unconfirmed ${count} item${count === 1 ? '' : 's'}.`, 'ok');
    if (r.skipped && r.skipped.length) toast(`Skipped ${r.skipped.length}: ${skippedMessage(r.skipped)}`, count ? 'info' : 'bad');
  } catch (e) {
    if (e.body && Array.isArray(e.body.skipped) && e.body.skipped.length) toast(`Unconfirm failed: ${skippedMessage(e.body.skipped)}`, 'bad');
    else toast(`Unconfirm failed: ${e.message}`, 'bad');
  }
}
function bulkConfirm() {
  const items = visibleItems();
  const plan = bulkConfirmPlan(items, S.proposals);
  if (!plan.count) { toast('Nothing to confirm in the current filter.', 'info'); return; }
  // AC-28: state plainly whether the active tab narrows the scope, and by how much, so
  // "current filter" never reads as "everything" when a scope tab is also selected.
  const tabActive = TABS.includes(S.area.active);
  const scope = tabActive
    ? `tab "${S.area.active}" + the current filters (${plan.count} item${plan.count === 1 ? '' : 's'})`
    : `the current filters across every tab (${plan.count} item${plan.count === 1 ? '' : 's'})`;
  const msg = `Confirm everything matched by ${scope}. `
    + (plan.waitingCount ? `${plan.waitingCount} waiting proposal${plan.waitingCount === 1 ? '' : 's'} will be rejected.` : 'No waiting proposals will be affected.');
  if (!confirm(msg)) return;
  confirmItems(plan.ids);
}
/** Queues an accept decision for every still-waiting proposal `tabProposalSummary` found for a tab
 * (its own confirm dialog, mirroring `bulkConfirm`'s) that is not already queued to accept — no API
 * call (P-2 change 1), each chip's own `refreshSuggestionChip` picks up the new pending state. */
function acceptAllOnTab(tab, summary) {
  const msg = `Accept all ${summary.count} suggested assumption${summary.count === 1 ? '' : 's'} on "${tab}"? `
    + `Up to −${num(summary.pdSaved)} PD will be queued.`;
  if (!confirm(msg)) return;
  for (const p of summary.proposals) {
    const d = decisionFor(S.notes, p.id);
    if (d && d.action === 'accept') continue;
    S.notes = toggleDecision(S.notes, p, 'accept');
  }
  S.queuedOpen = true;
  saveNotes(); renderQueued();
  for (const p of summary.proposals) refreshSuggestionChip(p.id);
  maybeAutoSendDecisions();
}
/** The summary bar above a scope tab's grid (P-2-adjacent): how many suggested assumptions are
 * still waiting on this tab and the PD they would save together, how many of them already have a
 * decision queued, an "Accept all on this tab" button and a "has suggestions" toggle — the toggle
 * reuses the existing `waitingProposals` filter (the "waiting proposals" checkbox in the filters
 * bar below is the very same state), rather than a second filter flag that would just duplicate
 * it. */
function suggestionsSummaryBar(tab, summary, queuedCount) {
  const toggle = el('input', { type: 'checkbox', onchange: (e) => { S.filters.waitingProposals = e.target.checked; lsSet(LS.filters, S.filters); renderArea(); } });
  toggle.checked = Boolean(S.filters.waitingProposals);
  return el('div', { class: 'suggestions-summary' },
    el('span', {}, `${summary.count} suggested assumption${summary.count === 1 ? '' : 's'} · up to −${num(summary.pdSaved)} PD if all accepted`
      + (queuedCount ? ` · ${queuedCount} queued` : '')),
    el('button', { class: 'btn sm primary', type: 'button', onclick: () => acceptAllOnTab(tab, summary) }, 'Accept all on this tab'),
    el('label', { class: 'chk', title: 'show only items with a waiting suggestion' }, toggle, 'has suggestions'));
}
/** Queues (or changes, or undoes) the answer to a question: no API call, no `load()`, no
 * `renderDoc()` — the card updates in place and the queue applies it on Send. */
function answerQuestion(q, option) {
  S.notes = toggleAnswer(S.notes, q, option);
  S.queuedOpen = true;
  saveNotes(); renderQueued();
  refreshQuestionCard(q.id);
  maybeAutoSendDecisions();
}
function refreshQuestionCard(cq) {
  const q = questionById(cq);
  if (!q) return;
  document.querySelectorAll(`#doc .question.blk[data-id="${CSS.escape(cq)}"]`).forEach(card => card.replaceWith(questionCard(q)));
}

// ---------------------------------------------------------------- item row rendering
// Inline SVG check mark shared by the confirm button and the confirmed badge; colour comes from
// `currentColor` so CSS drives the stroke per state.
const TICK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 8.5 6.5 12 13 4"></polyline></svg>';
/** The sticky confirm control (replaces the old Confirm column): a button with a green tick icon;
 * click to confirm. Once confirmed the button is gone and the id cell shows a small solid green
 * badge instead. Disabled with a reason when a failed item has no Client Response yet (L-6), or
 * when the session is closed. Moving or skipping a row is a queued note ("move to <tab>" /
 * "skip: <why>") the agent turns into `move`/`skip` — not a page control (contract §6,
 * editor-session.md "Batch kinds"). */
function confirmTick(item) {
  const confirmed = item.status?.kind === 'confirmed';
  if (confirmed) {
    const badgeAttrs = { class: 'confirm-badge', type: 'button', title: 'Confirmed — click to unconfirm', 'aria-label': `Unconfirm ${item.id}` };
    if (S.closed) badgeAttrs.disabled = ''; else badgeAttrs.onclick = () => unconfirmItems([item.id]);
    const badge = el('button', badgeAttrs);
    badge.innerHTML = TICK_SVG;
    return badge;
  }
  const blocked = item.status?.kind === 'failed' && !item.clientResponse;
  const attrs = { class: 'btn-confirm', type: 'button', 'aria-label': `Confirm ${item.id}` };
  if (blocked || S.closed) { attrs.disabled = ''; attrs.title = blocked ? 'a failed item needs an operator-written Client Response first (L-6)' : 'session closed'; }
  else { attrs.title = `Confirm ${item.id}`; attrs.onclick = () => confirmItems([item.id]); }
  const btn = el('button', attrs);
  btn.innerHTML = TICK_SVG;
  return btn;
}
/** The Requirement cell (P-0 3b): clamped to 20 lines by default, a "More"/"Less" link appears
 * below it only when the text actually overflows that clamp — detected after the row is attached
 * (`reqDiv.scrollHeight > reqDiv.clientHeight`), since a clamped box's rendered height is only
 * known once laid out. The link toggles the same `S.expanded`/`tr.expanded` the row click already
 * uses, in place, without a re-render; clicking the requirement cell itself (the row click handler
 * below) or the link's "Less" state collapses it back. */
function requirementCell(item, tr) {
  const td = el('td', { class: 'long-col ro-col' });
  const reqDiv = el('div', { class: 'cell-text' }); reqDiv.innerHTML = reqCellHtml(item.requirement);
  td.append(reqDiv);
  const link = el('button', { class: 'cell-more', type: 'button', hidden: '' }, S.expanded.has(item.id) ? 'Less' : 'More');
  link.addEventListener('click', () => {
    const nowExpanded = !S.expanded.has(item.id);
    if (nowExpanded) S.expanded.add(item.id); else S.expanded.delete(item.id);
    tr.classList.toggle('expanded', nowExpanded);
    link.textContent = nowExpanded ? 'Less' : 'More';
  });
  td.append(link);
  setTimeout(() => {
    // Measure against the clamped height regardless of the row's current expanded state, so the
    // link still shows (as "Less") for a row a previous render already left expanded.
    const wasExpanded = tr.classList.contains('expanded');
    if (wasExpanded) tr.classList.remove('expanded');
    const overflows = reqDiv.scrollHeight > reqDiv.clientHeight + 1;
    if (wasExpanded) tr.classList.add('expanded');
    if (overflows) { link.hidden = false; link.textContent = wasExpanded ? 'Less' : 'More'; }
  }, 0);
  return td;
}
function itemRow(item) {
  const expanded = S.expanded.has(item.id);
  const tr = el('tr', { class: 'req-row blk row-blk' + (expanded ? ' expanded' : ''), dataset: { id: item.id }, title: 'click the row to expand the clamped cells' });
  tr.append(el('td', { class: 'sticky-col id-col' }, confirmTick(item), el('span', { class: 'id' }, item.id)));
  tr.append(el('td', { class: 'narrow-col ro-col' }, item.prio || '—'));
  tr.append(requirementCell(item, tr));
  tr.append(el('td', { class: 'narrow-col ro-col' }, coverageBadge(item)));
  tr.append(el('td', { class: 'narrow-col ro-col' }, item.confidence || '—'));
  tr.append(el('td', { class: 'narrow-col ro-col mono' }, effortText(item.effort)));
  tr.append(assumptionsCell(item));
  tr.append(editableCell(item, 'clientResponse', 'Client Response'));
  tr.append(editableCell(item, 'internalNote', 'Internal note'));
  const refsTd = el('td', { class: 'long-col ro-col muted' });
  refsTd.innerHTML = (item.references || []).map(r => `<div>${inlineHtml(r)}</div>`).join('') || '—';
  tr.append(refsTd);
  const statusTd = el('td', { class: 'narrow-col ro-col' });
  ap(statusTd, el('span', { class: 'badge status' }, item.status?.kind || '—'), ...markerBadges(item));
  tr.append(statusTd);
  return tr;
}

// ---------------------------------------------------------------- filters bar (P-2)
function visibleItems() {
  const waiting = waitingProposalIds(S.proposals);
  const openQ = S.openQuestionIds || openQuestionItemIds(S.model?.questions || []);
  const changedIds = lastRunChangedIds(S.chat);
  const sinceExportIds = S.sinceExport ? new Set(S.sinceExport) : null;
  const tabItems = (S.model?.items || []).filter(i => (i.tab || '') === S.area.active);
  return tabItems.filter(i => matchesFilters(i, S.filters, waiting, openQ, changedIds, sinceExportIds));
}
function renderFilters() {
  const sel = (key, first, pairs) => {
    const s = el('select', { title: first, onchange: (e) => { S.filters[key] = e.target.value; lsSet(LS.filters, S.filters); renderArea(); } }, el('option', { value: '' }, first), ...pairs.map(([v, l]) => el('option', { value: v }, l)));
    s.value = pairs.some(([v]) => v === S.filters[key]) ? S.filters[key] : '';
    return s;
  };
  const chk = (key, label, title) => { const i = el('input', { type: 'checkbox', onchange: (e) => { S.filters[key] = e.target.checked; lsSet(LS.filters, S.filters); renderArea(); } }); i.checked = Boolean(S.filters[key]); return el('label', { class: 'chk', title }, i, label); };
  const q = el('input', { type: 'search', placeholder: 'Search id, requirement, response, notes…', oninput: (e) => { S.filters.q = e.target.value; lsSet(LS.filters, S.filters); renderArea(); } }); q.value = S.filters.q || '';
  // P-2: `prio` restores the 0.1.x priority filter, options built from the priorities actually
  // present on the items (not a fixed Must/Should/Could list — the client's own wording varies).
  const prios = [...new Set((S.model?.items || []).map(i => i.prio).filter(Boolean))];
  return el('div', { id: 'filters', class: 'filters' },
    chk('unconfirmed', 'unconfirmed', 'items not yet confirmed'),
    sel('prio', 'Any priority', prios.map(p => [p, p])),
    sel('coverage', 'Any coverage', [...COVERAGE_VALUES.map(c => [c, c]), ['(empty)', '— not assessed —']]),
    sel('effort', 'Any estimation', SIZES.map(s => [s, s])),
    chk('openQuestion', 'open question', 'referenced by an unanswered client question (CQ)'),
    chk('failed', 'failed', 'the agent could not assess this item'),
    chk('waitingProposals', 'waiting proposals', 'has a proposal not yet accepted or rejected'),
    chk('changed', 'changed', 'rows the agent changed on its last run, or reopened since'),
    chk('sinceExport', 'changed since last export', 'rows whose export text differs from the last export, or newly confirmed since (D-34)'),
    q,
    el('button', { class: 'btn sm subtle', title: 'reset filters', onclick: () => { S.filters = emptyFilters(); lsSet(LS.filters, S.filters); renderArea(); } }, 'reset'),
    el('button', { class: 'btn sm primary', title: 'confirm every item the current filter shows (P-3)', onclick: bulkConfirm }, 'Bulk confirm filtered'),
    el('span', { id: 'f-count', class: 'mono' }));
}
function updateFilterCount() {
  const fc = $('#f-count'); if (!fc) return;
  const total = (S.model?.items || []).filter(i => (i.tab || '') === S.area.active).length;
  fc.textContent = `${visibleItems().length}/${total}`;
}

// ---------------------------------------------------------------- open questions (CQ/Q) inline (task 10)
function questionCard(q) {
  const card = el('div', { class: 'question blk', dataset: { id: q.id } });
  const answered = q.answered ? el('span', { class: 'answered' }, `✓ answered ${q.answered.date}: ${q.answered.key}`) : null;
  card.append(el('div', { class: 'q-meta' }, el('span', { class: 'id' }, q.id), el('span', { class: 'badge ' + (q.kind === 'cq' ? 'client' : 'partner') }, q.kind === 'cq' ? 'client question' : 'operator question'),
    q.items.length ? el('span', { class: 'q-blocks' }, ...q.items.map(id => el('a', { href: '#' + id, dataset: { goto: id } }, id))) : null));
  card.append(el('div', { class: 'q-text' }, mdInline(q.question)));
  const list = el('div', { class: 'options' });
  const queued = q.answered ? null : answerFor(S.notes, q.id);
  for (const o of q.options || []) {
    const on = queued ? queued.key === o.key : o.checked;
    list.append(el('label', { class: 'option opt' + (on ? ' selected' : '') },
      el('input', { type: 'radio', name: 'q-' + q.id, value: o.key, ...(on ? { checked: '' } : {}), disabled: S.closed || q.answered ? '' : null, onchange: () => answerQuestion(q, o.key) }),
      el('span', { class: 'opt-id' }, o.key), el('span', { class: 'opt-text' }, o.text), el('span', { class: 'muted' }, ` — effect: ${o.effect}`)));
  }
  card.append(list);
  if (queued) card.append(el('div', { class: 'chip-pending accept' },
    el('span', { class: 'chip-pending-label' }, '✓ answer queued'),
    el('button', { class: 'btn sm subtle chip-undo', type: 'button', title: 'Undo', onclick: () => answerQuestion(q, queued.key) }, '↺')));
  if (q.fallback) card.append(el('div', { class: 'muted' }, `Fallback: ${q.fallback}`));
  if (answered) card.append(answered);
  return card;
}

// ---------------------------------------------------------------- sections 6/7/8 (Integrations/Glossary/Log) + §2 totals
// A section card is itself annotatable (P-6: any block, not only item rows/question cards) —
// `dataset.id` is the section's own block id, which `blockLike`/`blockById` already resolve.
function sectionCard(n) {
  const b = (S.model?.blocks || []).find(x => x.n === n);
  if (!b) return null;
  const card = el('div', { class: 'card section n' + n + ' blk row-blk', id: 'sec-' + b.id, dataset: { id: b.id, kind: 'section' } });
  card.append(el('h2', { class: 'sec-title' }, `§${n} ${b.title}`));
  card.append(renderMd(b.raw || '', 'md'));
  return card;
}
/** §1's own free prose only — the `### Project information` / `### Not taken from the source`
 * subsections get their own rendering (the Project information tab; the review banner's Not-taken
 * rows), never a second, non-interactive copy inside this card. */
function contextProseCard() {
  const b = (S.model?.blocks || []).find(x => x.n === 1);
  if (!b) return null;
  const idx = (b.raw || '').indexOf('### Project information');
  const prose = idx >= 0 ? (b.raw || '').slice(0, idx).trim() : (b.raw || '');
  if (!prose) return null;
  const card = el('div', { class: 'card section n1 blk row-blk', id: 'sec-' + b.id, dataset: { id: b.id, kind: 'section' } });
  card.append(el('h2', { class: 'sec-title' }, `§1 ${b.title}`));
  card.append(renderMd(prose, 'md'));
  return card;
}

/** Overview's Not-taken banner (contract §6): the rows the extraction did not take, each with a
 * Restore button — a normal, always-shown banner now that intake confirms itself and there is no
 * review step to gate it behind. */
function notTakenBanner() {
  const notTaken = S.model?.notTaken || [];
  if (!notTaken.length) return null;
  const card = el('div', { class: 'card' }, el('h2', {}, `Not taken from the source (${notTaken.length})`));
  const table = el('table', { class: 'tk-params' });
  table.append(el('thead', {}, el('tr', {}, ...['Source', 'Text', 'Why', ''].map(h => el('th', {}, h)))));
  const tbody = el('tbody');
  for (const row of notTaken) {
    tbody.append(el('tr', {}, el('td', {}, row.source), el('td', {}, row.text), el('td', {}, row.why),
      el('td', {}, el('button', { class: 'btn sm subtle', disabled: S.closed ? '' : null, onclick: () => restoreNotTaken(row.source) }, 'Restore'))));
  }
  table.append(tbody);
  card.append(table);
  return card;
}
async function restoreNotTaken(source) {
  try { await api('/api/intake/restore', { source }); await load(); }
  catch (e) { toast(`Restore failed: ${e.message}`, 'bad'); }
}
function overviewPanel() {
  const panel = el('div', { class: 'tab-panel', dataset: { tab: 'overview' } });
  const fm = S.model?.frontmatter?.data || {};
  const summary = el('div', { class: 'card' }, el('h2', {}, 'Working document'),
    el('div', { class: 'overview' },
      el('div', { class: 'kpi' }, el('div', { class: 'k' }, 'State'), el('div', { class: 'v' }, el('span', { class: 'pill ' + (fm.state === 'Ready' ? 'ready' : 'progress') }, fm.state || '—'))),
      el('div', { class: 'kpi' }, el('div', { class: 'k' }, 'Regime'), el('div', { class: 'v' }, fm.regime || '—')),
      el('div', { class: 'kpi' }, el('div', { class: 'k' }, 'Items'), el('div', { class: 'v' }, String((S.model?.items || []).length))),
      el('div', { class: 'kpi' }, el('div', { class: 'k' }, 'Client / Type'), el('div', { class: 'v small' }, [fm.client, fm['tender-type']].filter(Boolean).join(' · ') || '—'))));
  panel.append(summary);
  const banner = notTakenBanner();
  if (banner) panel.append(banner);
  const prose = contextProseCard();
  if (prose) panel.append(prose);
  for (const n of [2, 3]) { const c = sectionCard(n); if (c) panel.append(c); }
  const gp = globalProposals();
  if (gp.length) {
    const card = el('div', { class: 'card' }, el('h2', {}, 'Global proposals'));
    for (const p of gp.filter(p => p.status === 'waiting')) card.append(el('div', { class: 'proposal chip suggested', dataset: { proposal: p.id } }, suggestionChipBody(p)));
    panel.append(card);
  }
  const orphanQuestions = (S.model?.questions || []).filter(q => !q.items.some(id => itemById(id)));
  if (orphanQuestions.length) {
    const card = el('div', { class: 'card' }, el('h2', {}, 'Questions'));
    for (const q of orphanQuestions) card.append(questionCard(q));
    panel.append(card);
  }
  return panel;
}

// ---------------------------------------------------------------- Project information tab (contract §6)
async function saveProjectInfo(row, value) {
  try { await api(`/api/project-info/${encodeURIComponent(row.key)}`, { value }, 'PATCH'); await load(); }
  catch (e) { toast(`Save failed: ${e.message}`, 'bad'); }
}
function projectInfoPanel() {
  const panel = el('div', { class: 'tab-panel', dataset: { tab: '__projectinfo__' } });
  const card = el('div', { class: 'card' }, el('h2', {}, 'Project information'));
  const table = el('table', { class: 'tk-params' });
  table.append(el('thead', {}, el('tr', {}, ...['Parameter', 'Value', 'Source'].map(h => el('th', {}, h)))));
  const tbody = el('tbody');
  for (const row of S.model?.projectInfo || []) {
    const valueTd = el('td', {});
    const ta = liveTextarea(row.value, 'not stated', (v) => saveProjectInfo(row, v), { id: row.key, field: '__projectinfo__' });
    valueTd.append(ta);
    tbody.append(el('tr', {}, el('td', {}, row.label), valueTd, el('td', { class: 'muted' }, row.source || '—')));
  }
  table.append(tbody);
  card.append(table);
  panel.append(card);
  return panel;
}

// ---------------------------------------------------------------- fixed tabs (contract §6)
function areaTabs() {
  const nav = el('div', { class: 'secnav-links tabs' });
  for (const t of FIXED_TABS) {
    if (t.n && !(S.model?.blocks || []).some(b => b.n === t.n)) continue;
    const btn = el('button', { class: 'sectab' + (t.key === S.area.active ? ' active' : ''), dataset: { sec: t.key }, onclick: () => setArea(t.key) }, t.label);
    if (t.scope) btn.append(el('span', { class: 'tab-badge' }, String((S.model?.items || []).filter(i => i.tab === t.key).length)));
    nav.append(btn);
  }
  return nav;
}
function setArea(key) {
  S.area.active = key;
  lsSet(LS.area, S.area.active);
  renderDoc();
}
/** One working-document section as its own tab (§6/§7/§8, contract §6). §7 (Glossary) also lists
 * every glossary term this working document defines, as a reading aid alongside the inline
 * tooltips (P-6). */
function docSectionPanel(t) {
  const panel = el('div', { class: 'tab-panel', dataset: { tab: t.key } });
  const card = sectionCard(t.n);
  panel.append(card || el('div', { class: 'card' }, el('h2', {}, t.label), el('div', { class: 'muted' }, 'Nothing here yet.')));
  if (t.n === 7) {
    const terms = [...new Map(Object.values(S.gloss || {}).map(g => [g.term, g])).values()];
    if (terms.length) {
      const list = el('dl', { class: 'glossary-list' });
      for (const g of terms) { list.append(el('dt', {}, g.term), el('dd', {}, g.meaning, g.mapsTo ? el('span', { class: 'muted' }, ` → ${g.mapsTo}`) : null)); }
      panel.append(el('div', { class: 'card' }, el('h2', {}, 'Terms'), list));
    }
  }
  return panel;
}
const GRID_HEADER = ['ID', 'Prio', 'Requirement', 'Requirement Coverage', 'Confidence', 'Estimation', 'Assumptions', 'Client Response', 'Internal note', 'References', 'Status'];
/** One of the three fixed scope tabs (contract §6): topics as sub-headings in first-seen order,
 * the existing item grid per topic. "No items" when the tab is empty. */
function scopePanel(tab) {
  const panel = el('div', { class: 'tab-panel', dataset: { tab } });
  const allTabItems = (S.model?.items || []).filter(i => (i.tab || '') === tab);
  const summary = tabProposalSummary(allTabItems, S.proposals);
  if (summary.count) panel.append(suggestionsSummaryBar(tab, summary, tabDecisionCount(allTabItems, S.notes)));
  panel.append(renderFilters());
  if (!allTabItems.length) { panel.append(el('div', { class: 'empty' }, 'No items')); return panel; }
  const visible = new Set(visibleItems().map(i => i.id));
  const groups = groupByTopic(allTabItems, tab).map(g => ({ topic: g.topic, items: g.items.filter(i => visible.has(i.id)) }));
  if (!groups.some(g => g.items.length)) panel.append(el('div', { class: 'empty' }, 'No items match the filters.'));
  for (const g of groups) {
    if (!g.items.length) continue;
    panel.append(el('h3', { class: 'topic-heading' }, g.topic || '(no topic)'));
    const table = el('table', { class: 'req-grid blk-table' });
    table.append(el('thead', {}, el('tr', {}, ...GRID_HEADER.map(h => el('th', {}, h)))));
    const tbody = el('tbody');
    for (const it of g.items) tbody.append(itemRow(it));
    table.append(tbody);
    panel.append(el('div', { class: 'grid-wrap' }, table));
  }
  const qs = (S.model?.questions || []).filter(q => q.items.some(id => { const it = itemById(id); return it && (it.tab || '') === tab; }));
  if (qs.length) { const card = el('div', { class: 'card' }, el('h2', {}, 'Open questions')); for (const q of qs) card.append(questionCard(q)); panel.append(card); }
  return panel;
}
/** Scroll positions right before a rebuild wipes the DOM they live on (P-2 change 3: "no table
 * jump"): the page's own `window.scrollY`, plus every `.grid-wrap`'s `scrollTop`/`scrollLeft` in
 * DOM order — keyed to the active tab, so a scroll captured just before a tab switch is never
 * applied to the tab switched into. */
function captureScroll() {
  return {
    tab: S.area.active,
    win: window.scrollY,
    grids: [...document.querySelectorAll('.grid-wrap')].map(g => ({ top: g.scrollTop, left: g.scrollLeft })),
  };
}
function restoreScroll(state) {
  if (!state || state.tab !== S.area.active) return;
  window.scrollTo(0, state.win);
  const grids = document.querySelectorAll('.grid-wrap');
  state.grids.forEach((g, i) => { if (grids[i]) { grids[i].scrollTop = g.top; grids[i].scrollLeft = g.left; } });
}
function renderArea() {
  const active = S.area.active;
  const old = document.querySelector('#doc .area-body');
  const scroll = captureScroll();
  const body = el('div', { class: 'area-body' });
  const docTab = FIXED_TABS.find(t => t.key === active && t.n);
  if (!active || active === '__overview__') body.append(overviewPanel());
  else if (active === '__projectinfo__') body.append(projectInfoPanel());
  else if (docTab) body.append(docSectionPanel(docTab));
  else if (TABS.includes(active)) body.append(scopePanel(active));
  else body.append(overviewPanel());
  if (old) old.replaceWith(body); else $('#doc').append(body);
  updateFilterCount();
  markNoted();
  restoreScroll(scroll);
}

// ---------------------------------------------------------------- partner profile wizard (P-8)
function isvRow(isv, onChange) {
  const name = el('input', { type: 'text', placeholder: 'name', value: isv.name });
  const vendor = el('input', { type: 'text', placeholder: 'vendor', value: isv.vendor });
  const versions = el('input', { type: 'text', placeholder: 'supported versions, comma separated', value: isv.versions });
  for (const inp of [name, vendor, versions]) inp.addEventListener('input', () => { isv.name = name.value; isv.vendor = vendor.value; isv.versions = versions.value; onChange(); });
  return el('div', { class: 'wizard-row' }, name, vendor, versions, el('button', { class: 'btn sm subtle', onclick: () => onChange(isv, true) }, 'remove'));
}
function assetRow(asset, onChange) {
  const name = el('input', { type: 'text', placeholder: 'name', value: asset.name });
  const covers = el('input', { type: 'text', placeholder: 'what it covers', value: asset.covers });
  const pdSaved = el('input', { type: 'number', step: '0.25', placeholder: 'PD saved', value: asset.pdSaved });
  for (const inp of [name, covers, pdSaved]) inp.addEventListener('input', () => { asset.name = name.value; asset.covers = covers.value; asset.pdSaved = pdSaved.value; onChange(); });
  return el('div', { class: 'wizard-row' }, name, covers, pdSaved, el('button', { class: 'btn sm subtle', onclick: () => onChange(asset, true) }, 'remove'));
}
function renderWizard() {
  const form = S.wizardForm || (S.wizardForm = profileToForm(S.profile));
  const overlay = el('div', { class: 'overlay wizard-overlay' });
  const box = el('div', { class: 'wizard-box' });
  box.append(el('h2', {}, 'Partner profile'), el('p', { class: 'muted' }, 'Four inputs drive precise per-item estimates instead of T-shirt sizes. Skippable — you can open this again later.'));
  const small = el('input', { type: 'number', step: '0.25', value: form.calibrationSmall, placeholder: 'e.g. 1.5' });
  const big = el('input', { type: 'number', step: '0.25', value: form.calibrationBig, placeholder: 'e.g. 25' });
  const overhead = el('input', { type: 'number', step: '1', value: form.overhead, placeholder: 'e.g. 15' });
  const bufferPercent = el('input', { type: 'number', step: '1', value: form.bufferPercent, placeholder: 'e.g. 10' });
  const bufferMode = el('select', {}, el('option', { value: 'folded' }, 'folded into each figure'), el('option', { value: 'separate' }, 'stated separately'));
  bufferMode.value = form.bufferMode;
  for (const [inp, key] of [[small, 'calibrationSmall'], [big, 'calibrationBig'], [overhead, 'overhead'], [bufferPercent, 'bufferPercent']]) inp.addEventListener('input', () => { form[key] = inp.value; });
  bufferMode.addEventListener('change', () => { form.bufferMode = bufferMode.value; });
  box.append(el('h3', {}, 'Estimation calibration'), el('p', { class: 'muted' }, 'Anchor your estimates: how many person-days does your team need for the smallest and for a big typical change?'));
  box.append(
    el('label', {}, 'Typical small change (PD)', small),
    el('p', { class: 'field-hint' }, 'XS — e.g. add a custom field to products and show it on the product detail page.'),
    el('label', {}, 'Typical big change (PD)', big),
    el('p', { class: 'field-hint' }, 'XL — e.g. a new B2B checkout flow with ERP price and stock sync and approval rules.'),
    el('label', {}, 'Overhead % (PM/QA)', overhead),
    el('label', {}, 'Risk buffer %', bufferPercent),
    el('label', {}, 'Buffer applied', bufferMode));
  box.append(el('h3', {}, 'Vetted ISV list (a preference, not a limit)'));
  const isvHost = el('div', {});
  const rebuildIsv = () => { isvHost.innerHTML = ''; for (const i of form.isv) isvHost.append(isvRow(i, (row, remove) => { if (remove) form.isv = form.isv.filter(x => x !== row); rebuildIsv(); })); };
  rebuildIsv();
  box.append(isvHost, el('button', { class: 'btn sm subtle', onclick: () => { form.isv.push({ name: '', vendor: '', versions: '' }); rebuildIsv(); } }, '+ ISV'));
  box.append(el('h3', {}, 'Reusable assets (e.g. your own plugin list, estimation guidelines, boilerplates, CI templates)'));
  const assetHost = el('div', {});
  const rebuildAssets = () => { assetHost.innerHTML = ''; for (const a of form.assets) assetHost.append(assetRow(a, (row, remove) => { if (remove) form.assets = form.assets.filter(x => x !== row); rebuildAssets(); })); };
  rebuildAssets();
  box.append(assetHost, el('button', { class: 'btn sm subtle', onclick: () => { form.assets.push({ name: '', covers: '', pdSaved: '' }); rebuildAssets(); } }, '+ asset'));
  const errBox = el('div', { class: 'wizard-error' });
  box.append(errBox);
  const save = el('button', { class: 'btn primary', disabled: S.wizardSaving ? '' : null }, 'Save profile');
  save.addEventListener('click', async () => {
    const r = formToProfile(form);
    if (r.errors) { errBox.textContent = r.errors.join(' · '); return; }
    S.wizardSaving = true; save.disabled = true;
    try { await api('/api/profile', r.profile, 'PUT'); S.wizardOpen = false; S.wizardForm = null; toast('Profile saved. Every item re-estimates on the next run.', 'ok'); await load(); }
    catch (e) { errBox.textContent = e.message; }
    S.wizardSaving = false; renderDoc();
  });
  const skip = el('button', { class: 'btn subtle' }, 'Skip for now');
  skip.addEventListener('click', () => { S.wizardOpen = false; S.wizardForm = null; lsSet(LS.wizardSkipped, 1); renderDoc(); });
  box.append(el('div', { class: 'wizard-actions' }, save, skip));
  if (S.profilePath) box.append(el('p', { class: 'muted wizard-where' }, `Saved in ${S.profilePath} — one profile per project, shared by every tender${S.profileLegacy ? ' (read from the old specs/ location until the next save)' : ''}.`));
  overlay.append(box);
  return overlay;
}

// ---------------------------------------------------------------- header/doc rendering
/** True while the opening intake batch (auto-queued by the server, or sent by the "Start intake"
 * button) is queued behind another run or actively running — never once an analysis exists, since
 * `S.model` gates the whole card. */
function intakeQueuedOrRunning() {
  return (S.run && S.run.kind === 'intake') || (S.queue || []).some(id => String(id).startsWith('i-'));
}
/** The most recent progress line posted for the active intake run, or '' before the agent has
 * emitted one — `S.chat`'s `progress` entries carry it (`renderChat` groups them the same way). */
function intakeProgressLine() {
  const id = S.run?.id;
  if (!id) return '';
  for (let i = S.chat.length - 1; i >= 0; i--) {
    const e = S.chat[i];
    if (e.type === 'progress' && (e.batch || null) === id) return e.text || '';
  }
  return '';
}
/** The "No working document yet" card's action area: the button, or - while intake is queued or
 * running - a spinner, its stage and the latest progress line. Re-derived on every `renderDoc()`
 * call, which `run`, `progress` and `chat` SSE events all trigger while there is no model yet. */
function intakeCardBody() {
  if (!intakeQueuedOrRunning()) {
    return [el('button', { class: 'btn primary', disabled: S.closed ? '' : null, onclick: () => postBatch({ kind: 'intake' }, 'Intake') }, 'Start intake')];
  }
  const running = S.run && S.run.kind === 'intake';
  const label = running ? `Intake running · ${S.run.stage || 'starting…'}` : 'Intake queued · behind the active run';
  const line = running ? intakeProgressLine() : '';
  return [
    el('div', { class: 'intake-running' }, el('span', { class: 'spinner' }), label),
    line ? el('p', { class: 'muted' }, line) : null,
  ];
}
function renderDoc() {
  const host = $('#doc');
  // P-2 change 3: captured before the wipe below destroys the `.grid-wrap`s it reads from — this
  // is what covers a full rebuild (an SSE `doc` refresh, e.g. once a queued batch of decisions
  // lands), on top of `renderArea`'s own capture/restore for a body-only rebuild.
  const scroll = captureScroll();
  host.innerHTML = '';
  if (!S.model) {
    // Own-tabs contract §3: an xlsx/csv source needs no operator mapping step any more — the same
    // "Start intake" card a PDF source has always shown covers every source kind. The server
    // queues the opening `intake` batch itself the moment the page opens (Session#maybeEnqueueIntake);
    // this card shows that as a spinner instead of a button while it is queued or running.
    host.append(el('div', { class: 'card' }, el('h2', {}, 'No working document yet'),
      el('p', {}, 'The working document ', el('code', {}, S.analysis || '?'), ' does not exist yet', S.source ? [' for ', el('code', {}, S.source)] : null, '.'),
      ...intakeCardBody()));
    renderHeader();
    return;
  }
  host.append(el('h1', { class: 'doc-title' }, S.model.title || S.analysis || ''));
  const nav = el('div', { id: 'secnav' }, areaTabs());
  host.append(nav);
  host.append(el('div', { class: 'area-body' }));
  renderArea();
  if (S.wizardOpen) host.append(renderWizard());
  markNoted();
  positionPopover();
  renderHeader();
  restoreScroll(scroll);
}
async function refreshProposals() { try { const r = await api('/api/proposals'); S.proposals = Array.isArray(r) ? r : (Array.isArray(r?.proposals) ? r.proposals : []); } catch { /* WP-4 endpoint may not be up yet */ } }
/**
 * The partner profile drives per-item estimates (P-8) and the "not decomposed" marker
 * (`itemMarkers`) even when the wizard itself is never reopened — loaded on every `load()`
 * (page start and after every PUT), not only the first time, so a profile saved in an earlier
 * session or by another tab is never missed just because this tab already skipped the wizard once.
 */
async function loadProfile() {
  try { const r = await api('/api/profile'); S.profile = r.profile || null; S.profilePath = r.path || null; S.profileLegacy = Boolean(r.legacy); }
  catch { /* endpoint not up yet */ }
  return S.profile;
}
function maybeOpenWizard() {
  if (S.profileChecked || lsGet(LS.wizardSkipped, 0)) return;
  S.profileChecked = true;
  if (!S.profile) { S.wizardOpen = true; renderDoc(); }
}

// ---------------------------------------------------------------- writes: batch actions
async function postBatch(body, label) {
  try {
    const r = await api('/api/batch', body);
    toast(`${label} ${r.id || ''} ${r.queued ? 'queued behind the active run' : 'sent'}${S.agent.present ? '' : ' · the agent is not connected; it runs once the skill reconnects'}.`, S.agent.present ? 'info' : 'warn');
    return r;
  } catch (e) { toast(`${label} failed: ${e.message}`, 'bad'); }
}
function reestimate() { return postBatch({ kind: 'reestimate' }, 'Re-estimate'); }
async function exportRun() {
  try {
    const r = await api('/api/export', {}, 'POST');
    // Coverage tokens not mapped yet (RC-4): the server queues an `export` batch for the agent
    // instead of exporting, and returns 202 `queued` rather than a file.
    if (r._status === 202 || r.queued) { toast(`Coverage tokens need mapping first — queued an export batch${r.batch ? ` (${r.batch})` : ''} for the agent.`, 'info'); return; }
    // D-34: every export is numbered and never overwrites; refresh the "changed since last
    // export" filter's baseline right away, without waiting for the next full session reload.
    // `r.changedSinceLast` is the count against the *previous* export (for the toast below) — the
    // filter's own baseline is the freshly recorded snapshot this export just wrote, i.e. empty.
    S.sinceExport = [];
    const changedCount = Array.isArray(r.changedSinceLast) ? r.changedSinceLast.length : 0;
    const warnings = Array.isArray(r.notWritten) && r.notWritten.length ? ` · ${r.notWritten.length} not written` : '';
    toast(`Exported v${r.version ?? '?'} to ${r.file || r.path || '(see terminal)'} · changed since last export: ${changedCount}${warnings}.`, warnings ? 'warn' : 'ok');
    renderArea();
  } catch (e) { toast(`Export failed: ${e.message}`, 'bad'); }
}
async function abortRun() {
  if (!S.run || !confirm(`Abort run ${S.run.id}? Edits already applied stay; the batch is marked aborted.`)) return;
  try { await api('/api/run/abort', { reason: 'aborted from the page' }); } catch (e) { toast(`Abort failed: ${e.message}`, 'bad'); }
}

// ---------------------------------------------------------------- toast, header, banners
function toast(text, cls = 'info', ms = 5000) {
  const host = $('#toasts');
  const t = el('div', { class: 'toast ' + cls }, text);
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
/** Whether an analyze chain is currently active (IN-11): the running batch is `analyze`, or a
 * queued one is (looked up by id in the chat log, which is the only place a queued batch's own
 * `kind` reaches the page — `S.queue` from the `run` SSE event carries ids only). */
function activeAnalyzeChain() {
  if (S.run?.kind === 'analyze') return true;
  const kindOf = new Map((S.chat || []).filter(e => e.type === 'batch').map(e => [e.id, e.kind]));
  return (S.queue || []).some(id => kindOf.get(id) === 'analyze');
}
/** Header progress while the automatic analyze chain runs (IN-11/#5): "Analysing n of N", n the
 * scope items no longer queued/reopened, N every scope item — no button drives this any more, so
 * this is the only visible sign a chunk is in flight or about to be. */
function renderAnalyzeProgress() {
  const p = $('#analyze-progress');
  if (!p) return;
  if (!S.model || !activeAnalyzeChain()) { p.hidden = true; return; }
  const total = S.model.items.length;
  const remaining = S.model.items.filter(i => i.status?.kind === 'queued' || i.status?.kind === 'reopened').length;
  p.hidden = false;
  p.textContent = `Analysing ${Math.max(0, total - remaining)} of ${total}`;
}
function renderHeader() {
  const fm = S.model?.frontmatter?.data || {};
  $('#doc-ref').textContent = [fm.client, fm.slug].filter(Boolean).join(' · ') || (S.session?.slug || '');
  const pill = $('#status-pill');
  pill.hidden = !fm.state; pill.textContent = fm.state || ''; pill.className = 'pill ' + (fm.state === 'Ready' ? 'ready' : 'progress');
  $('#confidence').hidden = true;
  document.title = `${fm.client || S.session?.slug || 'Tender'} · Tender Discovery Tool`;
  const rb = $('#reconcile-btn');
  rb.textContent = 'Re-estimate';
  rb.disabled = S.closed || !S.model;
  renderAnalyzeProgress();
  const xb = $('#export-btn');
  xb.disabled = S.closed; // X-1: export available anytime
  xb.title = 'Export the current working sheets (available anytime; unconfirmed items export empty).';
  $('#stop-btn').disabled = S.closed;
}
const uptimeSec = () => S.session?.started ? (Date.now() - Date.parse(S.session.started)) / 1000 : 0;
const stateClass = () => S.closed || S.serverGone ? 'bad' : S.run ? 'busy' : S.agent.present ? 'ok' : 'bad';
function renderBanners() {
  const host = $('#banners'); host.innerHTML = '';
  if (S.closed) host.append(el('div', { class: 'banner bad' }, 'Session ended. Re-run the skill with --editor to open it again.'));
  else if (S.serverGone) host.append(el('div', { class: 'banner bad' }, 'Server unreachable - the session may have ended (heartbeat timeout or stop).'));
  if (S.parseError && !S.closed) host.append(el('div', { class: 'banner bad' }, `${S.analysis || 'the working document'} does not parse right now: ${S.parseError.message} - showing the last good version until it is fixed.`));
  // AC-5: the file still parses (blocks/items load) but carries grammar violations lib/parse.mjs
  // caught in passing — an invalid Requirement Coverage value typed by hand, a malformed CQ, a
  // wrong section title. The page never offers a free-text fix; it names the reason so the
  // operator edits the file (or asks the agent to).
  if (S.model?.errors?.length && !S.closed) {
    const n = S.model.errors.length;
    host.append(el('div', { class: 'banner bad' }, `${S.analysis || 'the working document'} has ${n} grammar issue${n === 1 ? '' : 's'}: ${S.model.errors.join(' · ')}`));
  }
  if (S.run && !S.closed) {
    const b = el('div', { class: 'banner info' }, el('span', { class: 'spinner' }), `Agent working on ${S.run.id}${S.run.kind ? ' (' + S.run.kind + ')' : ''}${S.run.stage ? ' · ' + S.run.stage : ''} - confirm, unconfirm and accept/reject are saved immediately; other direct writes are queued and applied when the run ends.`);
    if (!S.agent.present) b.append(el('span', { class: 'muted' }, 'the agent is not polling'), el('button', { class: 'btn sm', title: 'Finish the run as aborted so queued batches can start when the agent returns', onclick: abortRun }, 'Abort run'));
    host.append(b);
  }
  if (!S.closed && !S.serverGone && !S.agent.present && (S.agent.everPolled || uptimeSec() > (S.session?.agent?.timeout || 180))) host.append(el('div', { class: 'banner' }, 'Agent disconnected - re-run sw-discover-tender --editor on this tender to resume. The page keeps working; batches wait in the queue.'));
  if (S.queuedWrites && !S.closed) host.append(el('div', { class: 'banner' }, `${S.queuedWrites} non-confirm write${S.queuedWrites > 1 ? 's' : ''} queued until the run ends.`));
  const qb = $('#queued-badge'); qb.hidden = !S.queuedWrites; qb.textContent = S.queuedWrites ? `${S.queuedWrites} queued` : '';
  const dot = $('#status-dot'), txt = $('#status-text'), st = stateClass();
  dot.className = 'dot ' + st; txt.className = 'muted ' + st;
  txt.textContent = S.closed ? 'session closed' : S.serverGone ? 'server unreachable' : S.run ? `agent working · ${S.run.id}` + (S.run.stage ? ` · ${S.run.stage}` : '') + (S.queue.length ? ` · ${S.queue.length} queued` : '') : S.agent.present ? 'agent connected' : 'agent not connected';
  const as = $('#agent-state'); as.className = 'agent-state ' + st;
  as.textContent = S.run ? 'working' : S.agent.present ? 'connected' : S.closed || S.serverGone ? 'offline' : 'not connected';
  updateSendButton();
  renderRail();
  if (S.model) renderHeader();
}

// ---------------------------------------------------------------- chat, including the run report (P-9, task 9)
function reportCard(fields) {
  const box = el('dl', { class: 'run-report' });
  for (const f of fields) box.append(el('dt', {}, f.label), el('dd', {}, f.value));
  return box;
}
function renderChat() {
  const host = $('#chat'); host.innerHTML = '';
  const progress = new Map();
  const entries = S.chat;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'progress') {
      const k = e.batch || '_';
      if (!progress.has(k)) progress.set(k, []);
      progress.get(k).push(e.text || '');
      const later = entries.slice(i + 1).some(x => (x.type === 'reply' && (x.batch || '_') === k) || (x.type === 'progress' && (x.batch || '_') === k));
      if (!later) host.append(el('div', { class: 'msg agent' }, el('div', { class: 'm-head' }, 'agent · working'), el('div', { class: 'm-body progress' }, ...progress.get(k).map((l, j, arr) => el('div', { class: 'line' + (j === arr.length - 1 ? ' last' : '') }, l)))));
      continue;
    }
    if (e.type === 'batch') host.append(batchBubble(e));
    else if (e.type === 'reply') host.append(replyBubble(e, progress.get(e.batch || '_')));
    else if (e.type === 'system') host.append(el('div', { class: 'msg system' }, e.text || ''));
    else if (e.type === 'divider') host.append(el('div', { class: 'msg divider' }, e.text || ''));
  }
  host.scrollTop = host.scrollHeight;
}
/** working | queued | done | aborted | null, from the live run, the queue and the chat (never from e.queued). */
function batchState(id) {
  if (!id) return null;
  if (S.run && S.run.id === id) return 'working';
  if ((S.queue || []).includes(id)) return 'queued';
  if (S.chat.some(x => x.batch === id && x.type === 'system' && /aborted/.test(x.text || ''))) return 'aborted';
  if (S.chat.some(x => x.batch === id && x.type === 'reply')) return 'done';
  return null;
}
function elapsedText(startedAt) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
function batchBadge(st) {
  if (!st) return null;
  if (st !== 'working') return el('span', { class: 'badge bs-' + st }, st);
  const parts = ['working', S.run.stage, S.run.startedAt ? elapsedText(S.run.startedAt) : null].filter(Boolean);
  return el('span', { class: 'badge bs-working' }, el('span', { class: 'pulse-dot' }), el('span', { class: 'bs-text', dataset: { started: S.run.startedAt || '', prefix: parts.slice(0, S.run.stage ? 2 : 1).join(' · ') } }, parts.join(' · ')));
}
function tickBatchElapsed() {
  document.querySelectorAll('.bs-working .bs-text').forEach(n => { const d = n.dataset; n.textContent = d.started ? `${d.prefix} · ${elapsedText(d.started)}` : d.prefix; });
}
function batchBubble(e) {
  const label = { intake: 'intake', analyze: 'analyse', reestimate: 're-estimate', export: 'export', notes: 'you' }[e.kind] || e.kind || 'batch';
  const st = batchState(e.id);
  const m = el('div', { class: 'msg user' + (e.kind === 'notes' ? '' : ' auto') + (st === 'working' ? ' working' : '') }, el('div', { class: 'm-head' }, `${label} · ${e.id || ''}`, batchBadge(st)));
  if (e.kind === 'intake') m.append(el('div', { class: 'm-body' }, 'Intake: build the working document from the confirmed mapping.'));
  else if (e.kind === 'analyze') m.append(el('div', { class: 'm-body' }, 'Analyse: assess coverage, confidence and effort for every queued item; propose assumptions and client questions.'));
  else if (e.kind === 'reestimate') m.append(el('div', { class: 'm-body' }, 'Re-estimate the items a profile change or answered question marked.'));
  else {
    const notes = e.notes || [];
    if (notes.length) {
      m.append(el('details', { class: 'sent' }, el('summary', {}, `Sent (${notes.length})`),
        el('ul', { class: 'note-list' }, ...notes.map(n => el('li', {}, n.block ? el('a', { class: 'blocklink', href: '#' + n.block, dataset: { goto: n.block } }, n.block) : null, n.block ? ' ' : '', n.text || '')))));
    }
    if (e.chat) m.append(renderMd(e.chat, 'm-body'));
  }
  return m;
}
function replyBubble(e, progressLines) {
  const m = el('div', { class: 'msg agent' }, el('div', { class: 'm-head' }, 'agent', e.kind ? el('span', { class: 'badge' }, e.kind) : null, e.batch ? el('span', { class: 'muted' }, e.batch) : null));
  const fields = parseRunReport(e.md || '');
  if (fields) { m.append(el('div', { class: 'm-head' }, 'Run report')); m.append(reportCard(fields)); }
  else m.append(renderMd(e.md || '', 'm-body'));
  const changed = changedIdsFromReply(e);
  if (changed.length) m.append(el('div', { class: 'changed-links' }, el('span', { class: 'muted' }, 'changed: '), ...changed.slice(0, 40).map(id => el('a', { href: '#' + id, dataset: { goto: id } }, id)), changed.length > 40 ? el('span', { class: 'muted' }, `+${changed.length - 40}`) : null));
  if (e.repairs?.length) m.append(el('div', { class: 'repairs' }, 'warnings: ' + e.repairs.join('; ')));
  if (progressLines?.length) m.append(el('details', { class: 'progress-log' }, el('summary', {}, `progress log (${progressLines.length})`), ...progressLines.map(l => el('div', {}, '› ' + l))));
  return m;
}

// ---------------------------------------------------------------- deep links
function gotoBlock(id) {
  const item = itemById(id);
  if (item && S.area.active !== item.tab) setArea(item.tab || '__overview__');
  const q = questionById(id);
  if (q && q.items.length) { const owner = itemById(q.items[0]); if (owner && S.area.active !== owner.tab) setArea(owner.tab || '__overview__'); }
  setTimeout(() => {
    const target = document.querySelector(`#doc [data-id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
  }, 0);
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-goto]');
  if (a) { e.preventDefault(); e.stopPropagation(); gotoBlock(a.dataset.goto); }
});

// ---------------------------------------------------------------- events + session
function applySession(info) {
  S.session = info; S.agent = info.agent || S.agent;
  S.run = info.run ? { id: info.run.id, kind: info.run.kind, stage: info.run.stage || null } : null; S.queue = info.queue || [];
  S.queuedWrites = info.queuedWrites || 0;
  if ('parseError' in info) S.parseError = info.parseError || null;
  if (info.analysis) S.analysis = info.analysis; if (info.source) S.source = info.source;
}
// A `doc` event received while a spreadsheet cell has focus (editableCell) is buffered instead of
// applied, so typing is never wiped out from under the operator; `flushPendingDoc` (called on blur)
// applies the latest one once the cell is no longer focused.
let pendingDoc = null;
function flushPendingDoc() {
  if (focusedCell || !pendingDoc) return;
  const d = pendingDoc; pendingDoc = null;
  applyDoc(d);
}
function applyDoc(d) {
  if (focusedCell) { pendingDoc = d; return; }
  S.model = d.model || null;
  S.parseError = d.parseError || null;
  // D-34: the server recomputes `sinceExport` on every `doc` event (an in-place Client Response /
  // Internal note write, an agent's applied batch), so the "changed since last export" filter's
  // baseline never goes stale between one full `/api/session` reload and the next.
  if ('sinceExport' in d) S.sinceExport = d.sinceExport;
  recompute(); rebindNotes(); renderQueued();
  renderDoc();
  renderBanners();
  refreshProposals().then(() => { renderArea(); if (!S.profileChecked) loadProfile().then(maybeOpenWizard); });
}
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (ev) => { S.serverGone = false; applySession(JSON.parse(ev.data).session); renderBanners(); });
  es.addEventListener('doc', (ev) => applyDoc(JSON.parse(ev.data)));
  es.addEventListener('chat', (ev) => { S.chat.push(JSON.parse(ev.data)); renderChat(); if (!S.model) renderDoc(); });
  es.addEventListener('progress', () => { /* the chat event carries it too */ });
  es.addEventListener('run', (ev) => { const r = JSON.parse(ev.data); S.queue = r.queue || []; S.run = r.active ? { id: r.active, kind: r.kind, stage: r.stage || null, startedAt: r.startedAt || null } : null; renderBanners(); renderHeader(); renderChat(); if (!S.model) renderDoc(); if (!S.run) maybeAutoSendDecisions(); });
  es.addEventListener('agent', (ev) => { const a = JSON.parse(ev.data); S.agent.present = a.present; S.agent.everPolled = a.everPolled || S.agent.everPolled; renderBanners(); });
  es.addEventListener('queued', (ev) => { S.queuedWrites = JSON.parse(ev.data).count || 0; renderBanners(); });
  es.addEventListener('notes', (ev) => { const n = JSON.parse(ev.data); if (n.tab && n.tab !== S.tab) { S.notes = n.notes || []; rebindNotes(); renderQueued(); markNoted(); } });
  es.addEventListener('closing', () => { S.closed = true; es.close(); renderBanners(); renderHeader(); document.body.append(el('div', { class: 'overlay' }, 'Session ended. You can close this tab.')); });
  es.onerror = () => { if (S.closed) return; S.serverGone = true; renderBanners(); };
  es.onopen = () => { if (S.serverGone) { S.serverGone = false; load(); } };
}
async function load() {
  const j = await api('/api/session');
  applySession(j.session); S.analysis = j.analysis; S.source = j.source;
  S.model = j.model || null; S.parseError = j.parseError || null; S.notes = j.notes || []; S.chat = j.chat || [];
  S.intake = j.intake || { state: null, notTaken: 0, unusedSheets: [] };
  S.fitBack = j.fitBack || null;
  S.sinceExport = j.sinceExport || null;
  S.proposals = Array.isArray(j.proposals) ? j.proposals : [];
  S.queuedWrites = Array.isArray(j.queued) ? j.queued.length : (typeof j.queued === 'number' ? j.queued : S.queuedWrites);
  recompute(); rebindNotes();
  await Promise.all([refreshProposals(), loadProfile()]);
  renderDoc(); renderQueued(); renderChat(); renderBanners();
  maybeOpenWizard();
}
function heartbeat() {
  if (S.closed) return;
  fetch('/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tab: S.tab }) })
    .then(r => r.json()).then(j => {
      let dirty = S.serverGone; S.serverGone = false;
      if (j.agent && j.agent.present !== S.agent.present) { S.agent.present = j.agent.present; dirty = true; }
      if ('run' in j && (j.run?.id || null) !== (S.run?.id || null)) { S.run = j.run ? { id: j.run.id, kind: j.run.kind, stage: j.run.stage || null, startedAt: j.run.startedAt || null } : null; dirty = true; if (!S.run) maybeAutoSendDecisions(); }
      if (dirty) { renderBanners(); renderChat(); }
    })
    .catch(() => { S.serverGone = true; renderBanners(); });
}

// ---------------------------------------------------------------- foldable agent panel (default open)
function renderRail() {
  const badge = $('#rail-badge'), dot = $('#rail-dot');
  badge.hidden = !S.notes.length; badge.textContent = S.notes.length ? String(S.notes.length) : '';
  dot.hidden = !S.run;
}
/** Collapsed <-> open never happens on its own (a reply or progress event never calls this): the
 * rail badge/dot are the only signal while folded (AC "collapsed panel never auto-opens"). */
function setPanelOpen(open, persist = true) {
  S.panelOpen = Boolean(open);
  $('#panel').classList.toggle('collapsed', !S.panelOpen);
  $('#panel-rail').hidden = S.panelOpen;
  if (persist) lsSet(LS.panel, S.panelOpen ? 'open' : 'closed');
  renderRail();
}
setPanelOpen(panelState(lsGet(LS.panel, null)) === 'open', false);

// ---------------------------------------------------------------- wiring
Object.assign(S.filters, lsGet(LS.filters, {}));
$('#queued-toggle').addEventListener('click', () => { S.queuedOpen = !S.queuedOpen; renderQueued(); });
$('#queued-clear').addEventListener('click', clearQueued);
$('#panel-fold').addEventListener('click', () => setPanelOpen(false));
$('#panel-unfold').addEventListener('click', () => setPanelOpen(true));
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === ']' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setPanelOpen(!S.panelOpen); }
});
$('#chat-send').addEventListener('click', () => sendBatch($('#chat-text').value));
$('#chat-text').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
    e.preventDefault();
    const ta = e.target, s = ta.selectionStart, t = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(t); ta.selectionStart = ta.selectionEnd = s + 1;
    ta.dispatchEvent(new Event('input')); return;
  }
  e.preventDefault();
  if (e.target.value.trim() || S.notes.length) sendBatch(e.target.value);
});
$('#chat-text').addEventListener('input', (e) => { const ta = e.target; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 8 * 20 + 14) + 'px'; updateSendButton(); });
$('#reconcile-btn').addEventListener('click', reestimate);
$('#export-btn').addEventListener('click', exportRun);
$('#profile-btn')?.addEventListener('click', () => { S.wizardOpen = true; S.wizardForm = null; renderDoc(); });
$('#stop-btn').addEventListener('click', async () => {
  if (!confirm('End the editor session? The server stops; the skill in the terminal reports and exits. Edits already made are already in the working document.')) return;
  try { await api('/api/close', {}); } catch { /* already gone */ }
});

load().then(() => { connect(); heartbeat(); setInterval(heartbeat, 5000); setInterval(renderBanners, 15000); setInterval(tickBatchElapsed, 1000); })
  .catch(e => { document.body.append(el('div', { class: 'overlay' }, 'Could not load the session: ' + e.message)); });
