/* Tender Discovery Tool page - vanilla ES module, no build step.
   Shell, note stack and popover from the Specs Editor; filters, chips and totals from the Proposal page.
   Renders the -analysis.md block model; writes only ticks, answers and proposals through the server. */
import { renderImportPanel } from './import.js';
import { ladderOf, computeRow, computeAll, totals, delta, impact, pending, linesFor, reqTabs, pageTabs, tabOfRow, tabOfSection, glossary } from './lib/calc.mjs';
import { clientCols as clientColsOf, costCols as costColsOf } from './req-cols.js';

// ---------------------------------------------------------------- state
const S = {
  session: null, analysis: null, source: null, model: null, meta: null, notes: [], chat: [],
  comp: {}, compDoc: {}, tot: null, delta: null, pend: { ticks: [], answers: [], count: 0 }, idSet: new Set(), tableOf: {}, reqTables: [],
  changed: new Set(), local: { ticks: {}, answers: {} },
  sourceCols: { available: false, files: [], byId: {}, columns: [], costColumns: [] }, expanded: new Set(),
  importState: null,   // the client's workbook as `import` read it, until the mapping is confirmed
  reqTab: { tabs: [], active: null, byId: {} }, // §4 rows grouped by §1 source table, switched not scrolled
  // Primary navigation: the client's own document shape (Overview · Meta · Company & Context ·
  // Requirements · Non-functional & Compliance · Integrations · Glossary), see calc.mjs pageTabs.
  page: { tabs: [], active: null }, sub: {}, gloss: {},
  filters: { prefix: '', prio: '', ladder: '', status: '', ticks: false, proposed: false, suspect: false, blocked: false, queued: false, analysing: false, changed: false, q: '' },
  agent: { present: false, everPolled: false }, run: null, queue: [], queuedWrites: 0, closed: false, serverGone: false, parseError: null,
  tab: Math.random().toString(36).slice(2, 10), annotate: false,
};
const LS = { filters: 'tender-tool:filters', annotate: 'tender-tool:annotate', reqTab: 'tender-tool:reqtab', page: 'tender-tool:pagetab', sub: 'tender-tool:subtab' };
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
const num = v => v == null ? '—' : (Number.isInteger(v) ? String(v) : Number(v).toFixed(2).replace(/\.?0+$/, ''));
const signed = d => `${d < 0 ? '−' : '+'}${num(Math.abs(d))}`;
const deltaStr = d => d == null || Math.abs(d) < 0.005 ? '' : `(${signed(d)})`;

// ---------------------------------------------------------------- markdown (raw HTML escaped)
const renderer = new marked.Renderer();
renderer.html = ({ text }) => esc(text);
marked.use({ renderer, gfm: true, breaks: false });
const md = (text) => { try { return marked.parse(String(text ?? '')); } catch { return esc(text); } };
const mdInline = (text) => { try { return marked.parseInline(String(text ?? '')); } catch { return esc(text); } };
const ID_RE = /(^|[\s(>,.])([A-Z][A-Z0-9]{0,5}-\d+(?:\.[ac]\d+)?)(?=[\s.,;:)<]|$)/g;
/** Links every id that exists in the model (plus CQ-n / Q-n) to its block. */
function linkifyIds(html) {
  return html.replace(ID_RE, (m, pre, id) => (S.idSet.has(id) || /^(?:CQ|Q)-\d+$/.test(id)) ? `${pre}<a class="blocklink" href="#${id}" data-goto="${id}">${id}</a>` : m);
}
function inlineHtml(text) { return linkifyIds(mdInline(String(text ?? '').replace(/<br\s*\/?>/gi, '\n'))).replace(/\n/g, '<br>'); }
/**
 * §9 Glossary as a reading aid: marks each defined term where it appears in a requirement, with
 * the client's own definition and our mapping in the tooltip. Runs over already-escaped HTML, so
 * it skips anything inside a tag (`<a href=…>`) and never matches a term twice in one pass.
 */
function glossHtml(html) {
  const terms = Object.keys(S.gloss || {});
  if (!terms.length) return html;
  const re = new RegExp(`(?<![\\w-])(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'gi');
  let out = '', i = 0;
  // Walk tag by tag so replacements only ever touch text nodes.
  for (const tag of html.matchAll(/<[^>]*>/g)) {
    out += html.slice(i, tag.index).replace(re, mark) + tag[0];
    i = tag.index + tag[0].length;
  }
  return out + html.slice(i).replace(re, mark);
  function mark(m) {
    const g = S.gloss[m.toLowerCase()];
    if (!g) return m;
    const tip = [g.meaning, g.mapsTo ? `→ ${g.mapsTo}` : null].filter(Boolean).join('\n');
    return `<span class="gloss" title="${esc(tip)}">${m}</span>`;
  }
}
function renderMd(text, cls = 'md') { const d = el('div', { class: cls }); d.innerHTML = linkifyIds(md(text)); return d; }

// ---------------------------------------------------------------- api
async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) throw Object.assign(new Error(j.error || j.reason || (j.reasons || []).join(' · ') || `HTTP ${r.status}`), { status: r.status, body: j });
  j._status = r.status;
  return j;
}

// ---------------------------------------------------------------- model helpers
function allBlocks(model, out = []) { for (const b of (model?.blocks || [])) walk(b, out); return out; }
function walk(b, out) { out.push(b); (b.children || []).forEach(c => walk(c, out)); }
function findBlock(id) { return allBlocks(S.model).find(b => b.id === id) || null; }
function findByHash(hash) { return hash ? allBlocks(S.model).find(b => b.hash === hash) || null : null; }
const isRow = b => ['row', 'req', 'assume', 'clarify', 'global', 'log'].includes(b.kind);
function blockText(b) {
  if (!b) return '';
  if (b.kind === 'question') return b.question;
  if (b.kind === 'req') return b.text || '';
  if (b.kind === 'assume' || b.kind === 'global') return b.statement || (b.cells || []).join(' | ');
  if (isRow(b)) return (b.cells || []).join(' | ');
  if (b.kind === 'section') return b.title;
  return b.md || '';
}
/** Markdown-ish source of a block, what the agent gets to recognise and rework it. Rows carry their exact line. */
function blockMarkdown(b) {
  if (!b) return '';
  if (isRow(b)) return b.raw || '| ' + (b.cells || []).join(' | ') + ' |';
  if (b.kind === 'question') return `### ${b.id} · ${b.question}`;
  if (b.kind === 'section') return `## ${b.n != null ? b.n + '. ' : ''}${b.title}`;
  if (b.kind === 'table') return '| ' + (b.header || []).join(' | ') + ' |';
  return b.md || '';
}
function noteContext(block) {
  return {
    file: S.analysis || null, block: block.id, blockKind: block.kind, path: (block.path || []).join(' › '),
    line: block.line ?? null, endLine: block.endLine ?? block.line ?? null, hash: block.hash,
    quote: blockText(block).slice(0, 200), md: blockMarkdown(block).slice(0, 2000),
  };
}
/** Group §4 rows by the §1 source table whose id range owns them (see lib/calc.mjs `reqTabs`);
 * one tab per source table, the active one persisted like the filters. */
function buildReqTab(model) {
  const groups = reqTabs(model);
  const tabs = groups.map(g => {
    const counts = { blocked: 0, queued: 0, analysing: 0 };
    for (const r of g.rows) { const k = r.status?.kind; if (k in counts) counts[k]++; }
    const label = g.num != null ? `${g.num} · ${g.name} (${g.rows.length})` : `${g.name || 'Requirements'} (${g.rows.length})`;
    return { key: g.key, num: g.num, name: g.name, label, rows: g.rows, counts };
  });
  const byId = {};
  for (const t of tabs) for (const r of t.rows) byId[r.id] = t.key;
  let active = lsGet(LS.reqTab, null);
  if (!tabs.some(t => t.key === active)) active = tabs[0]?.key ?? null;
  return { tabs, active, byId };
}
/**
 * The primary tab model. Each tab keeps the §4 groups it owns (already decorated by `buildReqTab`
 * with labels and counts) and the §5 question blocks whose rows live in it; a question no row owns
 * — every partner `Q-n`, and a `CQ-n` about a parameter rather than a row — belongs on Overview,
 * where it cannot be missed.
 */
function buildPageTabs(model) {
  const tabs = pageTabs(model).map(t => ({
    ...t,
    groups: t.groups.map(g => S.reqTab.tabs.find(x => x.key === g.key)).filter(Boolean),
    questions: [],
  }));
  const byKey = Object.fromEntries(tabs.map(t => [t.key, t]));
  for (const q of allBlocks(model).filter(b => b.kind === 'question')) {
    const owner = (q.rows || []).map(id => S.reqTab.byId[id]).find(Boolean);
    const host = (q.qkind === 'cq' && owner && tabs.find(t => t.groups.some(g => g.key === owner))) || byKey.overview;
    host.questions.push(q);
  }
  // Ticks and answers waiting for the next run, counted on the tab that shows them: a `<ROW>.a<n>`
  // line follows its row into a requirement tab, an `A-n`/`X-n` line follows §3, an answered
  // question follows wherever the question was routed above.
  const tabOfGlobal = tabs.find(t => t.sections.some(s => s.n === 3)) || byKey.company;
  for (const t of tabs) t.pending = 0;
  for (const id of S.pend.ticks) {
    const b = allBlocks(model).find(x => x.id === id);
    const rowId = b?.kind === 'assume' && b.parent ? b.parent : null;
    const host = rowId ? tabs.find(t => t.groups.some(g => g.rows.some(r => r.id === rowId))) : tabOfGlobal;
    if (host) host.pending++;
  }
  for (const qid of S.pend.answers) {
    const host = tabs.find(t => t.questions.some(q => q.id === qid));
    if (host) host.pending++;
  }
  for (const t of tabs) {
    t.blocked = t.groups.reduce((n, g) => n + g.counts.blocked, 0);
    t.queued = t.groups.reduce((n, g) => n + g.counts.queued + g.counts.analysing, 0);
    // The badge is a row count, so only the two requirement tabs carry one — a question count in
    // the same spot would read as "8 rows" on Overview.
    t.badge = t.groups.length ? t.groups.reduce((n, g) => n + g.rows.length, 0) : null;
    t.empty = t.empty && !t.groups.length && !t.questions.length;
  }
  let active = lsGet(LS.page, null);
  if (!tabs.some(t => t.key === active && !t.empty)) active = (tabs.find(t => !t.empty) || tabs[0])?.key ?? null;
  // One active source group per requirement tab, remembered separately so switching Requirements
  // and Non-functional back and forth keeps each one where the user left it.
  const sub = lsGet(LS.sub, {}) || {};
  for (const t of tabs) if (t.groups.length && !t.groups.some(g => g.key === sub[t.key])) sub[t.key] = t.groups[0].key;
  S.sub = sub;
  return { tabs, active };
}
function recompute() {
  const m = S.model;
  S.idSet = new Set(); S.tableOf = {};
  if (!m) {
    S.comp = {}; S.compDoc = {}; S.tot = null; S.delta = null; S.pend = { ticks: [], answers: [], count: 0 };
    S.reqTab = { tabs: [], active: null, byId: {} }; S.page = { tabs: [], active: null }; S.sub = {}; S.gloss = {};
    return;
  }
  if (S.meta) m.meta = S.meta; else S.meta = m.meta || null;
  for (const b of allBlocks(m)) {
    if (b.id) S.idSet.add(b.id);
    if (b.kind === 'table') for (const r of b.children || []) S.tableOf[r.id] = b;
  }
  S.comp = computeAll(m, 'projected'); S.compDoc = computeAll(m, 'doc');
  S.tot = totals(m, S.comp); S.delta = delta(m); S.pend = pending(m);
  S.reqTab = buildReqTab(m);
  S.page = buildPageTabs(m); // after buildReqTab: the page tabs reuse its decorated groups
  S.gloss = glossary(m);
}
const reqById = id => { const b = findBlock(id); return b?.kind === 'req' ? b : null; };
/** Projected effect of one assume line: for a ticked-accept line the effect already sits in the projection, so compare against "untick". */
function impactOf(line) {
  const st = line.status?.state;
  if (st === 'accepted' || st === 'rejected') return null;
  if (st !== 'ticked-accept') return impact(S.model, line.id);
  const ids = line.kind === 'global' ? (line.rowsNamed || []) : [line.parent];
  const rows = []; let pd = 0, unknown = false;
  for (const id of ids) {
    const req = reqById(id); if (!req) continue;
    const a = computeRow(req, S.model, 'projected', { force: { [line.id]: 'proposed' } }), b = computeRow(req, S.model, 'projected');
    if (b.unknownSaved.includes(line.id)) unknown = true;
    if (a.final != null && b.final != null) pd += a.final - b.final;
    rows.push({ id, from: a.final, to: b.final, fromCls: a.cls, toCls: b.cls });
  }
  return { pd: Math.round(pd * 1000) / 1000, rows, unknown };
}
const tickState = l => l.status?.state || 'proposed';
const isFrozen = l => ['accepted', 'rejected'].includes(tickState(l));
const isTicked = l => ['ticked-accept', 'ticked-reject'].includes(tickState(l));
const isSuspect = l => Boolean(l.status?.suspect) || tickState(l) === 'suspect';

// ---------------------------------------------------------------- notes (Specs Editor stack)
function noteFor(block) { return S.notes.find(n => n.block === block && n.kind !== 'free'); }
function addNote(n) {
  n.id = n.id || 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  S.notes.push(n);
  saveNotes(); renderNotes(); markNoted();
}
let saveTimer = null;
function saveNotes() { clearTimeout(saveTimer); saveTimer = setTimeout(() => api('/api/notes', { notes: S.notes, tab: S.tab }).catch(() => {}), 400); }
function rebindNotes() {
  for (const n of S.notes) {
    if (!n.block || n.kind === 'free') continue;
    if (!S.model) { n.missing = true; continue; }
    const hit = findByHash(n.hash) || findBlock(n.block);
    if (hit) { Object.assign(n, noteContext(hit)); n.missing = false; continue; }
    n.missing = true;
  }
}
function markNoted() {
  document.querySelectorAll('#doc .noted').forEach(e => e.classList.remove('noted'));
  for (const n of S.notes) if (n.block) document.querySelectorAll(`#doc [data-id="${CSS.escape(n.block)}"]`).forEach(e => e.classList.add('noted'));
}
function renderNotes() {
  const host = $('#notes');
  host.innerHTML = '';
  $('#notes-count').textContent = S.notes.length ? `(${S.notes.length})` : '';
  if (!S.notes.length) host.append(el('div', { class: 'empty' }, 'Switch on Annotate and click any block to add a note, or add a free note.'));
  for (const n of S.notes) {
    const box = el('div', { class: 'note' + (n.missing ? ' missing' : ''), dataset: { nid: n.id } });
    const head = el('div', { class: 'n-head' }, el('span', { class: 'n-kind' }, n.kind), n.blockKind ? el('span', { class: 'badge' }, n.blockKind) : null);
    if (n.block) head.append(el('span', { class: 'n-ref', onclick: () => gotoBlock(n.block) }, n.block));
    box.append(head);
    if (n.path) box.append(el('div', { class: 'n-path', title: n.path + (n.line ? ` · lines ${n.line}–${n.endLine || n.line}` : '') }, n.path + (n.line ? ` · L${n.line}${n.endLine && n.endLine !== n.line ? '–' + n.endLine : ''}` : '')));
    if (n.quote) box.append(el('div', { class: 'n-quote', title: n.quote }, '“' + n.quote + '”'));
    if (n.selection) box.append(el('div', { class: 'n-sel', title: 'highlighted text the comment refers to' }, n.selection));
    if (n.missing) box.append(el('div', { class: 'n-missing' }, 'block missing - the referenced block no longer exists'));
    const text = el('div', { class: 'n-text' }, n.text || '');
    box.append(text);
    const actions = el('div', { class: 'n-actions' });
    actions.append(el('button', { class: 'btn', onclick: () => {
      const ta = el('textarea', { rows: 3 }); ta.value = n.text || '';
      text.replaceWith(ta); ta.focus();
      const save = el('button', { class: 'btn primary', onclick: () => { n.text = ta.value.trim(); saveNotes(); renderNotes(); } }, 'Save');
      actions.innerHTML = ''; actions.append(save, el('button', { class: 'btn', onclick: renderNotes }, 'Cancel'));
    } }, 'Edit'));
    actions.append(el('button', { class: 'btn', onclick: () => { S.notes = S.notes.filter(x => x !== n); saveNotes(); renderNotes(); markNoted(); } }, 'Delete'));
    box.append(actions);
    host.append(box);
  }
  updateSendButton();
}
function updateSendButton() {
  const b = $('#send-btn');
  b.disabled = !S.notes.length || S.closed;
  // Stays enabled during a run: the queue is unbounded and accepts batches while one is in progress.
  b.textContent = S.queue.length ? `Send to agent (${S.queue.length} queued)` : S.run ? 'Send to agent (queues behind the run)' : 'Send to agent';
}
async function sendBatch(chatText) {
  const chat = (chatText || '').trim();
  if (!S.notes.length && !chat) return;
  if (!S.agent.present && !confirm('The agent is not connected (no session loop polling). The batch will wait in the queue until the skill is (re)started. Send anyway?')) return;
  try {
    const r = await api('/api/batch', { kind: 'batch', notes: S.notes, chat, remaining: [] });
    S.notes = []; renderNotes(); markNoted(); S.changed.clear();
    $('#chat-text').value = ''; $('#chat-text').style.height = '';
    document.querySelectorAll('#doc .changed').forEach(e => e.classList.remove('changed'));
    if (r.queued) toast(`Batch ${r.id} queued behind the active run.`, 'info');
    return r;
  } catch (e) { toast('Send failed: ' + e.message, 'bad'); }
}

// ---------------------------------------------------------------- note popover (floats next to the annotated block)
const pop = { open: false, id: null, ctx: null, existing: null, selection: '', selOffset: null };
const popEl = () => $('#note-popover');
function anchorEl() { return pop.id ? document.querySelector(`#doc [data-id="${CSS.escape(pop.id)}"]`) : null; }
function closeNoteEditors() {
  const p = popEl();
  if (!pop.open) return;
  pop.open = false; p.hidden = true;
  document.querySelectorAll('#doc .anchored').forEach(e => e.classList.remove('anchored'));
}
function openNoteEditor(blockEl, block, extra = {}) {
  const p = popEl();
  if (pop.open && pop.id === block.id && !extra.selection) { p.querySelector('textarea').focus(); return; }
  closeNoteEditors();
  const existing = noteFor(block.id);
  const ctx = noteContext(block);
  Object.assign(pop, { open: true, id: block.id, ctx, existing, selection: extra.selection || '', selOffset: extra.selOffset || null });
  const meta = p.querySelector('.ne-ctx'); meta.innerHTML = '';
  meta.append(el('span', { class: 'id' }, block.id), el('span', { class: 'muted' }, ' ' + [ctx.path, ctx.line ? `L${ctx.line}${ctx.endLine !== ctx.line ? '–' + ctx.endLine : ''}` : ''].filter(Boolean).join(' · ')));
  const sel = p.querySelector('.ne-sel'); sel.hidden = !pop.selection; sel.textContent = pop.selection ? '“' + pop.selection + '”' : '';
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
  const br = a.getBoundingClientRect();
  const r = pop.selOffset ? { left: br.left + pop.selOffset.dx, top: br.top + pop.selOffset.dy, width: pop.selOffset.w, height: pop.selOffset.h } : { left: br.left, top: br.top, width: br.width, height: br.height };
  r.right = r.left + r.width; r.bottom = r.top + r.height;
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(420, vw - 16);
  p.style.width = w + 'px';
  const h = p.offsetHeight, gap = 10;
  const fitsBelow = r.bottom + gap + h <= Math.min(vh, docR.bottom) - 8;
  const fitsAbove = r.top - gap - h >= Math.max(0, docR.top) + 8;
  let top, above = false;
  if (fitsBelow) top = r.bottom + gap;
  else if (fitsAbove) { top = r.top - gap - h; above = true; }
  else top = Math.max(docR.top + 8, Math.min(r.bottom + gap, vh - h - 8));
  let left = Math.min(Math.max(8, r.left), vw - w - 8);
  if (pop.selOffset) left = Math.min(Math.max(8, r.left - 16), vw - w - 8);
  p.style.top = top + 'px'; p.style.left = left + 'px';
  p.classList.toggle('above', above);
  const arrow = p.querySelector('.arrow');
  arrow.style.left = Math.min(Math.max(14, r.left + Math.min(24, r.width / 2) - left), w - 26) + 'px';
  p.classList.toggle('detached', r.bottom < docR.top || r.top > docR.bottom);
}
function savePopover() {
  const p = popEl();
  const text = p.querySelector('textarea').value.trim();
  if (!text) { p.querySelector('textarea').focus(); return; }
  if (pop.existing) { pop.existing.text = text; if (pop.selection) pop.existing.selection = pop.selection; Object.assign(pop.existing, pop.ctx); saveNotes(); renderNotes(); }
  else addNote({ kind: 'comment', ...pop.ctx, ...(pop.selection ? { selection: pop.selection } : {}), text });
  closeNoteEditors();
}
{
  const p = popEl();
  p.querySelector('.save').addEventListener('click', savePopover);
  p.querySelector('.cancel').addEventListener('click', closeNoteEditors);
  p.querySelector('.delete').addEventListener('click', () => {
    if (pop.existing) { S.notes = S.notes.filter(x => x !== pop.existing); saveNotes(); renderNotes(); markNoted(); }
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
const INTERACTIVE = 'a, button, input, textarea, select, label, summary, .tick, .tick *, .opt, .opt *, .propose-form, .propose-form *, .filters *, #secnav *, .answer *';
let pressedBlock = null;
function blockElAt(target) { return target.closest ? target.closest('#doc [data-id]') : null; }
function setAnnotate(on, persist = true) {
  S.annotate = Boolean(on);
  document.body.classList.toggle('annotating', S.annotate);
  $('#annotate-toggle').checked = S.annotate;
  if (!S.annotate) closeNoteEditors();
  if (persist) lsSet(LS.annotate, S.annotate ? 1 : 0);
}
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
  const block = findBlock(blockEl.dataset.id);
  if (!block) return;
  const selection = selectionInside(blockEl);
  let selOffset = null;
  if (selection) {
    const rr = window.getSelection().getRangeAt(0).getBoundingClientRect(), br = blockEl.getBoundingClientRect();
    if (rr.width || rr.height) selOffset = { dx: rr.left - br.left, dy: rr.top - br.top, w: rr.width, h: rr.height };
  }
  openNoteEditor(blockEl, block, selection ? { selection, selOffset } : {});
});
// §4 grid: click a requirement row (outside its controls) to lift the line-clamp off its long cells.
$('#doc').addEventListener('click', (e) => {
  if (S.annotate) return;
  const tr = e.target.closest('tr.req-row');
  if (!tr || e.target.closest(INTERACTIVE)) return;
  const id = tr.dataset.id; if (!id) return;
  if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
  patchFor(id);
});
$('#annotate-toggle').addEventListener('change', (e) => setAnnotate(e.target.checked));
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape' && !inField) { if (pop.open) closeNoteEditors(); else if (S.annotate) setAnnotate(false); return; }
  if ((e.key === 'a' || e.key === 'A') && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setAnnotate(!S.annotate); }
});
if (lsGet(LS.annotate, 0) === 1) setAnnotate(true, false);

// ---------------------------------------------------------------- shared pieces
const chg = id => S.changed.has(id) ? ' changed' : '';
const changedMark = id => S.changed.has(id) ? el('span', { class: 'changed-mark' }, 'changed') : null;
const prioBadge = p => p ? el('span', { class: 'badge prio p-' + String(p).toLowerCase().replace(/[^a-z]/g, '') }, p) : null;
function ladderChip(c) {
  const lad = c?.ladder || (c?.cls ? 'none' : 'none');
  const label = c?.cls || '?';
  const title = c?.cls ? `class ${c.cls}` + (c.ladder ? ` · ${c.ladder}` : '') : 'no class yet';
  return el('span', { class: 'chip lvl-' + (lad || 'none'), title }, label);
}
const lmhStr = l => l === 'blocked' ? 'blocked' : (l && typeof l === 'object') ? `${num(l.low)}/${num(l.mid)}/${num(l.high)}` : '—';
function pdCell(r, c) {
  const docTxt = r.pdRaw != null && String(r.pdRaw).trim() !== '' ? String(r.pdRaw) : (typeof r.pd === 'number' ? num(r.pd) : '—');
  const s = el('span', { class: 'pd', title: 'PD in the document → projected with your ticked lines applied' }, el('b', {}, docTxt), ' PD');
  if (!c) return s;
  if (c.commitment) s.append(el('span', { class: 'muted' }, ' · commitment'));
  else if (c.blocked) s.append(el('span', { class: 'proj warn' }, ' · blocked'));
  else if (c.final != null && typeof r.pd === 'number' && Math.abs(c.final - r.pd) >= 0.005) s.append(el('span', { class: 'proj' }, ` → ${num(c.final)}`), el('span', { class: 'd ' + (c.final < r.pd ? 'down' : 'up') }, ' ' + deltaStr(c.final - r.pd)));
  return s;
}
// The status template is migrating `provisional, CQ-n` -> `estimated, CQ-n`; render both the same
// colour until every row in the live document has been reconciled onto the new spelling.
function statusBadge(r) {
  const st = r.status || {};
  const kind = st.kind || 'none';
  const visualKind = kind === 'provisional' ? 'estimated' : kind;
  const wrap = el('span', { class: 'req-status' }, el('span', { class: 'badge rs-' + visualKind }, kind === 'none' ? 'unclassified' : kind));
  for (const cq of st.cq || []) wrap.append(' ', el('a', { class: 'blocklink', href: '#' + cq, dataset: { goto: cq } }, cq));
  return wrap;
}
function stateLabel(l) { const st = tickState(l); return st === 'ticked-accept' ? '[x]' : st === 'ticked-reject' ? '[-]' : st === 'proposed' ? '[ ]' : st; }
function tickControl(line) {
  const st = tickState(line);
  if (isFrozen(line)) return el('span', { class: 'frozen ' + st, title: 'frozen by the reconcile; only the agent changes it' }, `${st} ${line.status?.date || ''}`.trim());
  const b = (label, v, active, cls, title) => el('button', { class: 'tg' + (active ? ' active ' + cls : ''), disabled: S.closed ? '' : null, title, onclick: () => tick(line, v) }, label);
  // No reset: a proposed line starts with neither button active, and a decision — once made — is
  // Accept or Reject. The partner can still switch between the two until the run reconciles them.
  return el('span', { class: 'toggle tick' },
    b('Accept', 'x', st === 'ticked-accept', 'accept', 'Tick [x] — the next reconcile freezes it as accepted and re-estimates'),
    b('Reject', '-', st === 'ticked-reject', 'reject', 'Tick [-] — the next reconcile freezes it as rejected'));
}
function impactLine(line) {
  const imp = impactOf(line); if (!imp) return null;
  const k = tickState(line) === 'ticked-accept' ? 'projected' : 'if accepted';
  const parts = [imp.unknown && !imp.pd ? 'PD saved unknown' : `−${num(imp.pd)} PD`, `${imp.rows.length} row${imp.rows.length === 1 ? '' : 's'}`];
  const title = imp.rows.map(r => `${r.id}: ${num(r.from)} → ${num(r.to)} PD` + (r.fromCls !== r.toCls ? ` · ${r.fromCls} → ${r.toCls}` : '')).join('\n');
  return el('span', { class: 'impact' + (imp.unknown ? ' unknown' : ''), title }, el('span', { class: 'k' }, k), ' ' + parts.join(' · '));
}
function suspectBadge(line) { return isSuspect(line) ? el('span', { class: 'badge suspect', title: 'flagged suspect by the last reconcile - review before ticking' }, 'suspect') : null; }
/** 'STF-01..STF-03, CAT-03' → ['STF-01','STF-02','STF-03','CAT-03'] (edit.mjs wants explicit ids). */
function expandRows(text) {
  const out = [];
  for (const tok of String(text).split(/[\s,;·]+/).filter(Boolean)) {
    const m = /^([A-Z][A-Z0-9]{0,5}-)(\d+)\.\.(?:[A-Z][A-Z0-9]{0,5}-)?(\d+)$/.exec(tok);
    if (!m) { out.push(tok); continue; }
    const w = m[2].length; for (let i = Number(m[2]); i <= Number(m[3]); i++) out.push(m[1] + String(i).padStart(w, '0'));
  }
  return out;
}
function proposeForm(rowId) {
  const det = el('details', { class: 'propose-form' }, el('summary', {}, rowId ? '+ assumption' : '+ assumption / exclusion (global)'));
  const stmt = el('input', { type: 'text', class: 'stmt', placeholder: 'Statement — what we assume so the row gets cheaper', required: '' });
  const pd = el('input', { type: 'number', step: '0.25', min: '0', placeholder: 'PD saved', title: 'PD saved on the row (absolute)' });
  const cls = el('select', { title: 'class the row lands on when accepted' }, el('option', { value: '' }, 'class: unchanged'), ...['stock', 'config', 'plugin', 'extension', 'custom'].map(k => el('option', { value: k }, k)));
  const risk = el('input', { type: 'text', class: 'risk', placeholder: 'risk to', value: 'client', title: 'who carries the risk if the assumption fails' });
  const rows = rowId ? null : el('input', { type: 'text', class: 'rows', placeholder: 'rows, e.g. STF-01..STF-03 (empty = global)', title: 'rows the assumption / exclusion applies to' });
  const hint = el('span', { class: 'muted hint-inline' }, 'lands as a partner line with status [ ]');
  // exclude is global-only (no rowId) and not tickable: PD / class / risk-to do not apply.
  const kindSel = rowId ? null : el('select', { class: 'kind', title: 'assume: a scope-lock line to tick · exclude: what the RFP itself excludes, not tickable', onchange: () => applyKind() },
    el('option', { value: 'assume' }, 'assume'), el('option', { value: 'exclude' }, 'exclude'));
  function applyKind() {
    const isExclude = Boolean(kindSel && kindSel.value === 'exclude');
    stmt.placeholder = isExclude ? 'Statement — what the RFP itself excludes' : 'Statement — what we assume so the row gets cheaper';
    for (const inp of [pd, cls, risk]) inp.hidden = isExclude;
    hint.textContent = isExclude ? 'lands in §3 as a non-tickable exclusion line' : 'lands as a partner line with status [ ]';
  }
  const btn = el('button', { class: 'btn primary sm', onclick: async () => {
    const statement = stmt.value.trim(); if (!statement) { stmt.focus(); return; }
    const kind = kindSel ? kindSel.value : 'assume';
    const body = { row: rowId || null, statement, kind };
    if (kind !== 'exclude') {
      if (pd.value.trim() !== '') { const v = Number(pd.value); if (!Number.isFinite(v) || v < 0) { pd.focus(); return; } body.pdSaved = v; }
      if (cls.value) body.cls = cls.value;
      if (risk.value.trim()) body.riskTo = risk.value.trim();
    }
    if (rows && rows.value.trim()) body.rows = expandRows(rows.value);
    btn.disabled = true;
    try {
      const r = await api('/api/propose', body);
      if (r._status === 202) { toast(`${kind === 'exclude' ? 'Exclusion' : 'Proposal'} queued until the run ends.`, 'info'); }
      else toast(kind === 'exclude' ? `${r.id || 'Exclusion'} added.` : `${r.id || 'Assumption'} added as [ ] — tick it to apply.`, 'ok');
      stmt.value = ''; pd.value = ''; cls.value = ''; if (rows) rows.value = ''; if (kindSel) kindSel.value = 'assume'; applyKind(); det.open = false;
    } catch (e) { toast('Propose failed: ' + e.message, 'bad'); }
    btn.disabled = false;
  } }, 'Add');
  stmt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } });
  det.append(el('div', { class: 'pf-row' }, kindSel, stmt), el('div', { class: 'pf-row' }, pd, cls, risk, rows, btn, hint));
  return det;
}

// ---------------------------------------------------------------- block rendering
function renderBlockNode(b) {
  switch (b.kind) {
    case 'req': return renderReqRow(b); // array of <tr> (main row + its assume/clarify/propose rows)
    case 'question': return renderQuestion(b);
    case 'global': return renderGlobalRow(b);
    case 'row': case 'log': case 'assume': case 'clarify': return renderRowTr(b);
    case 'table': return renderTable(b);
    case 'section': return renderSubsection(b);
    case 'bullet': { const d = el('div', { class: 'blk bullet' + chg(b.id), dataset: { id: b.id, kind: b.kind } }); d.innerHTML = inlineHtml(b.md); return d; }
    default: return el('div', { class: 'blk ' + b.kind + chg(b.id), dataset: { id: b.id, kind: b.kind } }, renderMd(b.md), changedMark(b.id));
  }
}
function renderSubsection(sec) {
  const host = el('div', { class: 'subsection' }, el('h3', { class: 'blk', dataset: { id: sec.id, kind: 'section' } }, sec.title));
  (sec.children || []).forEach(c => host.append(renderBlockNode(c)));
  return host;
}
function renderRowTr(r) {
  const tr = el('tr', { class: 'row-blk blk' + chg(r.id), dataset: { id: r.id, kind: r.kind } });
  for (const c of r.cells || []) { const td = el('td'); td.innerHTML = inlineHtml(c); tr.append(td); }
  return tr;
}
function renderTable(t) {
  const table = el('table', { class: 'blk-table tk-' + (t.tableKind || 'generic'), dataset: { table: t.id } });
  table.append(el('thead', {}, el('tr', {}, ...(t.header || []).map(h => el('th', {}, h)))));
  const tbody = el('tbody');
  for (const r of t.children || []) tbody.append(r.kind === 'global' ? renderGlobalRow(r) : renderRowTr(r));
  table.append(tbody);
  return el('div', { class: 'table-wrap' }, table);
}
function colIndex(row, name) {
  const t = S.tableOf[row.id]; if (!t) return -1;
  const i = (t.header || []).findIndex(h => String(h).trim().toLowerCase() === name.toLowerCase());
  return i;
}
/** §3 row: fixed cells by header name; assume lines get the tick control, others stay read-only. */
function renderGlobalRow(g) {
  const tr = el('tr', { class: 'row-blk blk global gk-' + (g.gkind || 'x') + chg(g.id), dataset: { id: g.id, kind: 'global' } });
  const t = S.tableOf[g.id];
  const header = t?.header || ['ID', 'Kind', 'Rows', 'Statement', 'PD saved', 'Risk to', 'Status'];
  header.forEach((h, i) => {
    const name = String(h).trim().toLowerCase(), raw = g.cells?.[i] ?? '';
    const td = el('td');
    if (name === 'id') ap(td, el('span', { class: 'id' }, g.id), changedMark(g.id));
    else if (name === 'kind') td.append(el('span', { class: 'badge gk-' + (g.gkind || '') }, g.gkind || raw));
    else if (name === 'rows') td.innerHTML = linkifyIds(esc(raw));
    else if (name === 'statement') td.innerHTML = inlineHtml(g.statement || raw);
    else if (name === 'pd saved') { td.append(el('span', { class: 'mono' }, g.pdSaved?.raw ?? raw)); if (g.gkind === 'assume') ap(td, impactLine(g)); }
    else if (name === 'status') { if (g.gkind === 'assume') ap(td, tickControl(g), suspectBadge(g)); else td.innerHTML = inlineHtml(raw); td.className = 'status-cell'; }
    else td.innerHTML = inlineHtml(raw);
    tr.append(td);
  });
  return tr;
}
// ---------------------------------------------------------------- §4 grid: one <tr> per req, one per its assume/clarify/propose lines
// Client columns straight from the source export (read-only); the two vendor cost columns are
// rendered greyed and permanently empty (lib/source.mjs never reads their value).
// The server sends the confirmed mapping's own client/cost columns (req-cols.js); CLIENT_COLS /
// COST_HEADERS there are only the fallback for a session that has not loaded one yet.
const clientCols = () => clientColsOf(S.sourceCols);
const costCols = () => costColsOf(S.sourceCols);
function reqGridHeader() {
  const hasSrc = Boolean(S.sourceCols?.available);
  const cols = [{ h: 'ID', cls: 'sticky-col' }];
  if (hasSrc) cols.push(...clientCols().map(c => ({ h: c.key, cls: c.long ? 'long-col' : (c.cls || 'narrow-col') })));
  else cols.push({ h: 'Prio', cls: 'narrow-col' });
  cols.push({ h: 'Class', cls: 'narrow-col' }, { h: 'L/M/H', cls: 'narrow-col mono' }, { h: 'Lvl', cls: 'narrow-col' }, { h: 'PD', cls: 'narrow-col mono' },
    { h: 'Text', cls: 'long-col' }, { h: 'Evidence / risk', cls: 'long-col' }, { h: 'Status', cls: 'narrow-col' });
  if (hasSrc) { const cc = costCols(); cols.push({ h: cc[0], cls: 'cost-col' }, { h: cc[1], cls: 'cost-col' }); }
  return cols;
}
const gridColCount = () => reqGridHeader().length;
/** Our own authored text (markdown, may reference block ids) — rendered like the rest of the doc. */
function longTd(text, extraCls = '') {
  const div = el('div', { class: 'cell-text' }); div.innerHTML = glossHtml(inlineHtml(text || ''));
  return el('td', { class: 'long-col ' + extraCls }, div);
}
/** The client's own CSV wording — plain text (ids still link), no markdown reinterpretation. */
function clientLongTd(text) {
  const div = el('div', { class: 'cell-text' }); div.innerHTML = glossHtml(linkifyIds(esc(text || '')).replace(/\n/g, '<br>'));
  return el('td', { class: 'long-col' }, div);
}
function clientTd(src, col) {
  const val = src ? (src[col.key] || '') : '';
  if (col.long) return clientLongTd(val);
  return el('td', { class: col.cls || 'narrow-col' }, val || '—');
}
function renderReqRow(r) {
  const c = S.comp[r.id];
  const hasSrc = Boolean(S.sourceCols?.available);
  const src = hasSrc ? (S.sourceCols.byId[r.id] || null) : null;
  const expanded = S.expanded.has(r.id);
  const tr = el('tr', { class: 'req-row blk row-blk' + chg(r.id) + (c?.blocked ? ' blocked' : '') + (expanded ? ' expanded' : ''), dataset: { id: r.id, kind: 'req' }, title: 'click the row to expand the clamped cells' });
  tr.append(el('td', { class: 'sticky-col id-col' }, el('span', { class: 'id' }, r.id), changedMark(r.id)));
  if (hasSrc) for (const col of clientCols()) tr.append(clientTd(src, col));
  else tr.append(el('td', { class: 'narrow-col' }, prioBadge(r.prio)));
  tr.append(el('td', { class: 'narrow-col' }, ladderChip(c)));
  tr.append(el('td', { class: 'narrow-col mono' }, lmhStr(r.lmh)));
  tr.append(el('td', { class: 'narrow-col' }, r.lvl || '—'));
  tr.append(el('td', { class: 'narrow-col mono' }, pdCell(r, c)));
  tr.append(longTd(r.text));
  tr.append(longTd(r.evidence, 'muted'));
  tr.append(el('td', { class: 'narrow-col' }, statusBadge(r)));
  if (hasSrc) { tr.append(el('td', { class: 'cost-col', title: 'not answered here' }, '—')); tr.append(el('td', { class: 'cost-col', title: 'not answered here' }, '—')); }
  const rows = [tr];
  for (const ch of r.children || []) {
    if (ch.kind === 'assume') rows.push(renderAssumeRow(ch, r.id));
    else if (ch.kind === 'clarify') rows.push(renderClarifyRow(ch, r.id));
  }
  const globals = S.model ? linesFor(r, S.model).filter(l => l.kind === 'global') : [];
  if (globals.length) rows.push(renderGlobalRefRow(r, globals));
  rows.push(renderProposeRow(r));
  return rows;
}
/** Sub-row shell: sticky sub-id cell (real block ids only; helper lines below leave it blank) + one wide cell spanning every other column. */
function subRow(dataId, parentId, kind, idLabel, cellCls, ...cellChildren) {
  const tr = el('tr', { class: `sub-row blk row-blk ${kind}` + chg(dataId), dataset: { id: dataId, kind: kind.split(' ')[0], parent: parentId } });
  tr.append(el('td', { class: 'sticky-col id-col sub-id' }, idLabel || '', changedMark(dataId)));
  tr.append(el('td', { class: 'sub-cell ' + cellCls, colspan: String(gridColCount() - 1) }, ...cellChildren));
  return tr;
}
function renderAssumeRow(a, parentId) {
  const st = tickState(a);
  const d = el('div', { class: `sub assume st-${st}` + (isSuspect(a) ? ' suspect' : '') });
  ap(d, tickControl(a), suspectBadge(a));
  if (a.cls) d.append(el('span', { class: 'chip lvl-' + (ladderOf(a.cls) || 'none'), title: 'class the row lands on when accepted' }, '→ ' + a.cls));
  if (a.pdSaved != null) d.append(el('span', { class: 'pdsaved', title: 'PD saved on the row when accepted' }, `−${num(a.pdSaved)} PD`));
  const stmt = el('span', { class: 'stmt' }); stmt.innerHTML = inlineHtml(a.statement || ''); d.append(stmt);
  if (a.riskTo) d.append(el('span', { class: 'muted risk' }, `risk to ${a.riskTo}`));
  ap(d, impactLine(a));
  return subRow(a.id, parentId, `assume st-${st}` + (isSuspect(a) ? ' suspect' : ''), a.id, '', d);
}
function renderClarifyRow(cl, parentId) {
  const d = el('div', { class: 'sub clarify' });
  const dec = el('span', { class: 'stmt' }); dec.innerHTML = inlineHtml(cl.decision || '');
  const src = el('span', { class: 'muted' }); src.innerHTML = linkifyIds(esc([cl.source, cl.date].filter(Boolean).join(' · ')));
  ap(d, el('span', { class: 'badge clar' }, 'clarified'), dec, src);
  return subRow(cl.id, parentId, 'clarify', cl.id, '', d);
}
function renderGlobalRefRow(r, globals) {
  const line = ap(el('span', {}, 'global: '), ...globals.flatMap((g, i) => [i ? ' · ' : null, el('a', { href: '#' + g.id, dataset: { goto: g.id } }, g.id), el('span', { class: 'mono' }, ' ' + stateLabel(g))]));
  return subRow(r.id + '.globals', r.id, 'misc', '', 'sub-globals muted', line);
}
function renderProposeRow(r) {
  return subRow(r.id + '.propose', r.id, 'propose', '', '', proposeForm(r.id));
}
function renderQuestion(q) {
  const card = el('div', { class: 'question blk' + chg(q.id), dataset: { id: q.id, kind: 'question' } });
  const meta = el('div', { class: 'q-meta' }, el('span', { class: 'id' }, q.id), el('span', { class: 'badge ' + (q.qkind === 'cq' ? 'client' : 'partner') }, q.qkind === 'cq' ? 'client' : 'partner'));
  if (q.qkind === 'cq') meta.append(el('span', { class: 'badge ' + (q.blocking ? 'high' : '') }, q.blocking ? 'blocking' : 'not blocking'));
  else if (q.priority) meta.append(el('span', { class: 'badge ' + q.priority }, q.priority));
  if ((q.rows || []).length) meta.append(el('span', { class: 'q-blocks' }, el('span', { class: 'lbl' }, 'rows'), ...q.rows.map(b => S.idSet.has(b) ? el('a', { href: '#' + b, dataset: { goto: b } }, b) : el('span', {}, b))));
  const cm = changedMark(q.id); if (cm) meta.append(cm);
  const text = el('div', { class: 'q-text' }); text.innerHTML = inlineHtml(q.question);
  card.append(meta, text);
  const list = el('div', { class: 'options' });
  for (const o of q.options || []) {
    const optText = el('span', { class: 'opt-text' }); optText.innerHTML = inlineHtml(o.text);
    list.append(el('label', { class: 'option opt' + (o.checked ? ' selected' : '') },
      el('input', { type: 'radio', name: 'q-' + q.id, value: o.letter, ...(o.checked ? { checked: '' } : {}), disabled: S.closed ? '' : null, onchange: () => answer(q, { option: o.letter }) }),
      el('span', { class: 'opt-id' }, o.letter || '·'), optText));
  }
  card.append(list);
  const other = el('input', { type: 'text', class: 'other', placeholder: 'Other: answer in your own words…', disabled: S.closed ? '' : null });
  other.value = q.other?.checked ? (q.other.text || '') : '';
  const apply = el('button', { class: 'btn sm', onclick: () => { const t = other.value.trim(); if (t) answer(q, { other: t }); } }, 'Apply');
  const clear = el('button', { class: 'btn sm subtle', title: 'clear every tick on this question', onclick: () => answer(q, {}) }, 'Clear');
  other.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply.click(); } });
  card.append(el('div', { class: 'answer' + (q.other?.checked ? ' selected' : '') }, el('span', { class: 'opt-id' }, 'Other'), other, apply, clear));
  if (q.assume) { const u = el('div', { class: 'q-assume muted' }); u.innerHTML = 'Until answered we assume ' + inlineHtml(q.assume); card.append(u); }
  const answered = (q.options || []).find(o => o.checked) || (q.other?.checked ? { letter: 'Other', text: q.other.text } : null);
  if (answered) card.append(el('div', { class: 'answered' }, `✓ ${answered.letter === 'Other' ? 'Other' : 'Option ' + answered.letter} ticked · the next reconcile applies it`));
  return card;
}

// ---------------------------------------------------------------- §4 filters
const F = { prefix: 'select', prio: 'select', ladder: 'select', status: 'select', q: 'search', ticks: 'chk', proposed: 'chk', suspect: 'chk', blocked: 'chk', queued: 'chk', analysing: 'chk', changed: 'chk' };
function reqRowsAll() { return allBlocks(S.model).filter(b => b.kind === 'req'); }
function renderFilters() {
  const reqs = reqRowsAll();
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const sel = (key, first, pairs) => {
    const s = el('select', { title: first, onchange: (e) => { S.filters[key] = e.target.value; lsSet(LS.filters, S.filters); renderReqLists(); } }, el('option', { value: '' }, first), ...pairs.map(([v, l]) => el('option', { value: v }, l)));
    s.value = pairs.some(([v]) => v === S.filters[key]) ? S.filters[key] : '';
    return s;
  };
  const chk = (key, label, title) => { const i = el('input', { type: 'checkbox', onchange: (e) => { S.filters[key] = e.target.checked; lsSet(LS.filters, S.filters); renderReqLists(); } }); i.checked = Boolean(S.filters[key]); return el('label', { class: 'chk', title }, i, label); };
  const q = el('input', { type: 'search', placeholder: 'Search id, text, evidence, assumptions…', oninput: (e) => { S.filters.q = e.target.value; lsSet(LS.filters, S.filters); renderReqLists(); } }); q.value = S.filters.q || '';
  const bar = el('div', { id: 'filters', class: 'filters' },
    sel('prefix', 'All areas', uniq(reqs.map(r => r.id.split('-')[0])).sort().map(p => [p, p])),
    sel('prio', 'Any prio', uniq(reqs.map(r => r.prio)).map(p => [p, p])),
    sel('ladder', 'Any class', [['ootb', 'OOTB (stock/config)'], ['plugin', 'Plugin'], ['extension', 'Extension'], ['custom', 'Custom'], ['off', 'Off-ladder']]),
    sel('status', 'Any status', uniq(reqs.map(r => r.status?.kind)).map(s => [s, s])),
    q,
    chk('ticks', 'ticked', 'rows with an unreconciled [x] / [-] line'), chk('proposed', 'proposed', 'rows with an open [ ] line'), chk('suspect', 'suspect', 'rows with a suspect line'),
    chk('blocked', 'blocked', 'rows without a projected estimate'), chk('queued', 'queued', 'rows extracted but not yet estimated'), chk('analysing', 'analysing', 'rows being estimated right now'),
    chk('changed', 'changed', 'rows the agent changed since your last batch'),
    el('button', { class: 'btn sm subtle', title: 'reset filters', onclick: () => { for (const k of Object.keys(F)) S.filters[k] = F[k] === 'chk' ? false : ''; lsSet(LS.filters, S.filters); renderSecnav(); renderReqLists(); } }, 'reset'),
    el('span', { id: 'f-count', class: 'mono' }));
  return bar;
}
function reqMatches(r) {
  const f = S.filters, c = S.comp[r.id] || {};
  const lines = S.model ? linesFor(r, S.model) : [];
  if (f.prefix && r.id.split('-')[0] !== f.prefix) return false;
  if (f.prio && r.prio !== f.prio) return false;
  if (f.ladder && (c.ladder || 'none') !== f.ladder) return false;
  if (f.status && (r.status?.kind || '') !== f.status) return false;
  if (f.ticks && !lines.some(isTicked)) return false;
  if (f.proposed && !lines.some(l => tickState(l) === 'proposed')) return false;
  if (f.suspect && !lines.some(isSuspect)) return false;
  if (f.blocked && !c.blocked) return false;
  if (f.queued && r.status?.kind !== 'queued') return false;
  if (f.analysing && r.status?.kind !== 'analysing') return false;
  if (f.changed && !(S.changed.has(r.id) || (r.children || []).some(ch => S.changed.has(ch.id)))) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [r.id, r.text, r.evidence, r.cls, ...(r.children || []).map(ch => `${ch.id} ${ch.statement || ch.decision || ''}`)].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
function renderReqLists() {
  const nCols = gridColCount();
  for (const [host, t] of S.reqTables) {
    if (!host.isConnected) continue;
    host.innerHTML = '';
    let shown = 0, total = 0;
    for (const r of t.children || []) {
      if (r.kind !== 'req') { host.append(renderRowMisc(r, nCols)); continue; }
      total++; if (!reqMatches(r)) continue;
      shown++; host.append(...renderReqRow(r));
    }
    if (!host.children.length) host.append(el('tr', {}, el('td', { colspan: String(nCols), class: 'empty' }, total ? 'No rows match the filters.' : 'No requirement rows.')));
    host.dataset.shown = shown; host.dataset.total = total;
  }
  updateReqCount();
  markNoted();
}
/** `#f-count` reflects the visible grid only; filtering every tab up front keeps tab-switch instant. */
function updateReqCount() {
  const fc = $('#f-count'); if (!fc) return;
  const active = S.reqTables.find(([host]) => host.dataset.tab === S.page.active && host.dataset.group === S.sub[S.page.active]);
  fc.textContent = active ? `${active[0].dataset.shown || 0}/${active[0].dataset.total || 0}` : '0/0';
}
function renderRowMisc(r, nCols) {
  const tr = el('tr', { class: 'sub misc blk row-blk' + chg(r.id), dataset: { id: r.id, kind: r.kind } });
  tr.append(el('td', { class: 'sticky-col id-col' }, r.id || ''));
  const td = el('td', { class: 'sub-cell', colspan: String(nCols - 1) }); td.innerHTML = inlineHtml((r.cells || []).join(' · '));
  tr.append(td);
  return tr;
}

// ---------------------------------------------------------------- overview, secnav, sections
function kpi(k, v, small) { return el('div', { class: 'kpi' }, el('div', { class: 'k' }, k), el('div', { class: 'v' + (small ? ' small' : '') }, v)); }
function renderOverview() {
  const m = S.meta || {}, cnt = m.counts || {}, a = cnt.assume || {}, q = cnt.questions || {}, rq = cnt.req || {};
  const ready = Boolean(m.readyGate?.ready) || /ready/i.test(m.status || '');
  const card = el('div', { class: 'card', id: 'overview' }, el('h2', {}, 'Overview', el('span', { class: 'muted' }, m.updated ? `updated ${m.updated}` : '')));
  const grid = el('div', { class: 'overview' });
  grid.append(kpi('Status', el('span', { class: 'pill ' + (ready ? 'ready' : 'progress') }, m.status || 'unknown')));
  grid.append(kpi('Confidence', m.confidence != null ? m.confidence + '%' : '—'));
  const tot = m.totals;
  for (const [k, label] of [['must', 'Must'], ['should', 'Should'], ['could', 'Could'], ['total', 'Total']]) {
    const d = S.delta?.[k];
    const v = el('span', {}, tot && typeof tot[k] === 'number' ? num(tot[k]) : '—', el('span', { class: 'unit' }, ' PD'));
    if (deltaStr(d)) v.append(' ', el('span', { class: 'd ' + (d < 0 ? 'down' : 'up'), title: 'projected change once your ticked lines are reconciled' }, deltaStr(d)));
    grid.append(kpi(label + (k === 'must' ? ' (fixed price)' : ''), v));
  }
  if (tot && typeof tot.services === 'number' && tot.services) grid.append(kpi('of which Services', num(tot.services) + ' PD', true));
  grid.append(kpi('Rows', `${cnt.rows ?? reqRowsAll().length} rows · ${rq.estimated ?? 0} estimated · ${rq.blocked ?? 0} blocked`
    + (rq.queued ? ` · ${rq.queued} queued` : '')
    + (rq.analysing ? ` · ${rq.analysing} analysing` : '')
    + (rq.prefilled ? ` · ${rq.prefilled} prefilled` : '')
    + (rq.provisional ? ` · ${rq.provisional} provisional (legacy)` : ''), true));
  grid.append(kpi('Assumptions', `${a.proposed ?? 0} proposed · ${(a.tickedAccept ?? 0) + (a.tickedReject ?? 0)} ticked · ${a.accepted ?? 0} accepted · ${a.rejected ?? 0} rejected` + (a.suspect ? ` · ${a.suspect} suspect` : ''), true));
  grid.append(kpi('Questions', `CQ ${q.client ?? 0} open (${q.blocking ?? 0} blocking${q.blockingOnMust ? `, ${q.blockingOnMust} on Must` : ''}) · Q ${q.partner ?? 0} open (${q.high ?? 0} high) · ${cnt.clarifications ?? 0} clarifications`, true));
  const factors = [m.overhead ? `overhead ${m.overhead.tbd ? '_TBD_' : num(m.overhead.pct) + '%'}` : null, m.buffer ? `risk buffer ${m.buffer.tbd ? '_TBD_' : num(m.buffer.pct) + '%'}${m.buffer.mode ? ' ' + m.buffer.mode : ''}` : null].filter(Boolean).join(' · ');
  if (factors) grid.append(kpi('Factors', factors, true));
  card.append(grid);
  const gate = el('div', { class: 'gate' });
  if (m.readyGate?.ready) gate.append(el('span', { class: 'pill ready' }, 'Ready to submit'));
  else gate.append(el('span', { class: 'k' }, 'Not ready:'), el('ul', {}, ...(m.readyGate?.reasons || ['no gate information']).map(r => el('li', {}, r))));
  const ex = m.exportState || {};
  const exp = el('div', { class: 'export-state muted' });
  if (ex.exported) ap(exp, `Exported ${ex.date || ''}` + ((ex.files || []).length ? ` · ${ex.files.join(', ')}` : ''), ex.stale ? el('span', { class: 'badge medium', title: 'the source changed after the export' }, 'stale') : null);
  else exp.append('Not exported yet.');
  if ((m.fmMismatch || []).length) exp.append(' ', el('span', { class: 'badge medium', title: m.fmMismatch.join('\n') }, `frontmatter drift: ${m.fmMismatch.length}`));
  card.append(gate, exp);
  return card;
}
/**
 * The primary navigation: one button per page tab, mirroring the client's own document. The
 * filters belong to the two requirement tabs, so they are shown only there — on Meta or Glossary
 * a "status / class" filter row would be meaningless furniture.
 */
function renderSecnav() {
  const old = $('#secnav');
  const nav = el('div', { id: 'secnav' });
  const links = el('div', { class: 'secnav-links tabs' });
  for (const t of S.page.tabs) {
    const bits = [];
    if (t.pending) bits.push(`${t.pending} ticked, not yet reconciled`);
    if (t.blocked) bits.push(`${t.blocked} blocked`);
    if (t.queued) bits.push(`${t.queued} not estimated yet`);
    if (t.empty) bits.push('nothing extracted yet');
    const btn = el('button', {
      class: 'sectab' + (t.key === S.page.active ? ' active' : '') + (t.empty ? ' empty' : ''),
      dataset: { sec: t.key }, title: bits.join(' · ') || null, onclick: () => setPageTab(t.key),
    }, t.label);
    if (t.badge) btn.append(el('span', { class: 'tab-badge' }, String(t.badge)));
    if (t.pending) btn.append(el('span', { class: 'tab-dot', title: 'ticks waiting for the next run' }));
    links.append(btn);
  }
  nav.append(links, renderFilters());
  markActiveSection();
  if (old) old.replaceWith(nav);
  return nav;
}
/** Show one panel, hide the rest. Nothing re-renders, so a patch made to a row in a hidden tab survives. */
function setPageTab(key) {
  if (!S.page.tabs.length) return;
  if (!S.page.tabs.some(t => t.key === key)) key = S.page.tabs[0].key;
  S.page.active = key;
  lsSet(LS.page, key);
  document.querySelectorAll('#secnav .sectab').forEach(b => b.classList.toggle('active', b.dataset.sec === key));
  document.querySelectorAll('#doc .tab-panel').forEach(p => { p.hidden = p.dataset.tab !== key; });
  const showFilters = Boolean(S.page.tabs.find(t => t.key === key)?.groups.length);
  const f = $('#filters'); if (f) f.hidden = !showFilters;
  updateReqCount();
  $('#doc').scrollTop = 0;
}
/** Switch the active source group inside a requirement tab. */
function setSubTab(pageKey, groupKey) {
  S.sub[pageKey] = groupKey;
  lsSet(LS.sub, S.sub);
  const panel = document.querySelector(`#doc .tab-panel[data-tab="${CSS.escape(pageKey)}"]`);
  if (!panel) return;
  panel.querySelectorAll('.tab-strip .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === groupKey));
  panel.querySelectorAll('tbody.req-tab-panel').forEach(tb => { tb.hidden = tb.dataset.group !== groupKey; });
  updateReqCount();
}
/** #doc is the scroll container (the window never scrolls), so scroll it directly and leave room for the sticky #secnav. */
function gotoSection(id) {
  const doc = $('#doc'), nav = $('#secnav');
  const owner = tabOfSection(S.page.tabs, id);
  if (owner && owner !== S.page.active) setPageTab(owner);
  const t = document.getElementById('sec-' + id);
  if (!t) return;
  const top = doc.scrollTop + t.getBoundingClientRect().top - doc.getBoundingClientRect().top - (nav ? nav.offsetHeight : 0) - 6;
  // Smooth scrolling over a 135-card document is interrupted by the first re-render; jump when the distance is large.
  doc.scrollTo({ top: Math.max(0, top), behavior: Math.abs(top - doc.scrollTop) > 2000 ? 'auto' : 'smooth' });
  markActiveSection(id);
}
/** Mark the active page tab. */
function markActiveSection(forced) {
  const nav = $('#secnav'); if (!nav) return;
  const id = forced || S.page.active;
  nav.querySelectorAll('.secnav-links .sectab').forEach(a => a.classList.toggle('active', a.dataset.sec === id));
}
/** One button per source group inside a requirement tab; hidden when the tab holds only one. */
function renderTabStrip(pageKey, groups) {
  const strip = el('div', { class: 'tab-strip' });
  for (const t of groups) {
    const parts = [];
    if (t.counts.blocked) parts.push(`${t.counts.blocked} blocked`);
    if (t.counts.queued) parts.push(`${t.counts.queued} queued`);
    if (t.counts.analysing) parts.push(`${t.counts.analysing} analysing`);
    strip.append(el('button', { class: 'tab' + (t.key === S.sub[pageKey] ? ' active' : ''), dataset: { tab: t.key }, title: parts.join(' · ') || null, onclick: () => setSubTab(pageKey, t.key) }, t.label));
  }
  return strip;
}
/** The page tab a block sits in, found from the rendered DOM — covers questions, table rows and
 * paragraphs that neither `tabOfRow` nor `tabOfSection` can resolve from the model alone. */
function ownerTabOfNode(id) {
  const node = document.querySelector(`#doc [data-id="${CSS.escape(id)}"]`);
  return node?.closest('.tab-panel')?.dataset.tab || null;
}
/** The req row (or its assume/clarify line's parent req) that owns `id`, for tab lookup. */
function tabOwnerId(id) {
  const b = findBlock(id);
  return (b && (b.kind === 'assume' || b.kind === 'clarify') && b.parent) ? b.parent : id;
}
/** The §4 grid for one page tab: its source groups as sub-tabs, one tbody each, all pre-filtered. */
function renderReqGrid(pageKey, groups) {
  const wrap = el('div', {});
  const multi = groups.length > 1;
  if (multi) wrap.append(renderTabStrip(pageKey, groups));
  const table = el('table', { class: 'req-grid blk-table' });
  table.append(el('thead', {}, el('tr', {}, ...reqGridHeader().map(col => el('th', { class: col.cls }, col.h)))));
  for (const t of groups) {
    const tbody = el('tbody', { class: 'req-tab-panel', dataset: { tab: pageKey, group: t.key }, hidden: t.key === S.sub[pageKey] ? null : '' });
    table.append(tbody);
    S.reqTables.push([tbody, { children: t.rows }]);
  }
  wrap.append(el('div', { class: 'grid-wrap' }, table));
  if (!S.sourceCols?.available) wrap.append(el('div', { class: 'muted grid-note' }, 'No client source export found for this tender — showing analysis columns only.'));
  return wrap;
}
/**
 * One card per section (or §1 subsection). §4 never comes through here any more — the requirement
 * grid is built per page tab from that tab's own groups — so a section card is now always plain
 * document content.
 */
function renderSectionCard(sec) {
  const card = el('div', { class: 'card section n' + (sec.n ?? 'x'), id: 'sec-' + sec.id });
  const label = sec.n != null ? `§${sec.n} ${sec.title}` : sec.title;
  card.append(el('h2', { class: 'blk sec-title', dataset: { id: sec.id, kind: 'section' } }, label, changedMark(sec.id)));
  for (const c of sec.children || []) {
    // §1's opening paragraph duplicates the Overview KPIs; keep it in the document/model (notes still resolve), just don't render it.
    if (Number(sec.n) === 1 && c.kind === 'paragraph' && /^\*\*At a glance\.\*\*/.test(c.md || '')) continue;
    if (Number(sec.n) === 4 && c.kind === 'table' && (c.tableKind === 'analysis' || (c.children || []).some(r => r.kind === 'req'))) continue;
    else if (Number(sec.n) === 3 && c.kind === 'table' && c.tableKind === 'global') card.append(renderTable(c), proposeForm(null));
    else card.append(renderBlockNode(c));
  }
  if (!card.querySelector('.blk:not(.sec-title), .blk-table')) card.append(el('div', { class: 'muted' }, '(empty)'));
  return card;
}
/** A tab the analysis does not carry yet — written before this grammar, or a tender without that table. */
function renderMissingTab(t) {
  return el('div', { class: 'card missing' },
    el('h2', {}, t.label),
    el('p', { class: 'muted' }, 'This tender carries nothing here yet. An analysis written before the client-tab layout has no ',
      el('code', {}, '§1.1 Meta'), ', ', el('code', {}, '§1.2 Company & context'), ', ', el('code', {}, '§8 Integrations'),
      ' or ', el('code', {}, '§9 Glossary'), ' — the next ', el('code', {}, 'sw-discover-tender'), ' run extracts them from the source and fills this tab in.'));
}
/** The panel for one page tab: its sections, its requirement grid and the questions it owns. */
function renderTabPanel(t) {
  const panel = el('div', { class: 'tab-panel', dataset: { tab: t.key }, hidden: t.key === S.page.active ? null : '' });
  if (t.key === 'overview') panel.append(renderOverview());
  if (t.empty && !t.sections.length) { panel.append(renderMissingTab(t)); return panel; }
  for (const sec of t.sections) panel.append(renderSectionCard(sec));
  if (t.groups.length) {
    const card = el('div', { class: 'card section n4', id: 'sec-req-' + t.key });
    card.append(el('h2', { class: 'sec-title' }, t.label, el('span', { class: 'muted' }, ` · §4 rows from ${t.groups.map(g => g.name || 'the source').join(', ')}`)));
    card.append(renderReqGrid(t.key, t.groups));
    panel.append(card);
  }
  if (t.questions.length) {
    const card = el('div', { class: 'card section n5', id: 'sec-q-' + t.key });
    card.append(el('h2', { class: 'sec-title' }, 'Open questions', el('span', { class: 'muted' }, ` · ${t.questions.length}`)));
    for (const q of t.questions) card.append(renderBlockNode(q));
    panel.append(card);
  }
  return panel;
}
function renderDoc() {
  const host = $('#doc');
  const scrollY = host.scrollTop;
  host.innerHTML = ''; S.reqTables = [];
  if (!S.model) {
    // A workbook that has been imported but not mapped: steering comes first, because the
    // analysis cannot read a tender whose requirement tables nobody has identified yet.
    if (S.importState?.available && !S.importState.confirmedAt) {
      host.append(renderImportPanel({
        el, state: S.importState, closed: S.closed,
        save: map => api('/api/import/map', { map, tab: S.tab }).catch(() => {}),
        confirm: confirmImport,
      }));
      renderHeader();
      return;
    }
    host.append(el('div', { class: 'card analyze' }, el('h2', {}, 'No analysis yet'),
      el('p', {}, 'The analysis sidecar ', el('code', {}, S.analysis || '?'), ' does not exist yet', S.source ? [' for ', el('code', {}, S.source)] : null, '.'),
      el('p', { class: 'muted' }, 'The opening run reads the source tables, classifies every row against the installed Shopware, estimates it and proposes scope-lock assumptions. It writes the sidecar; this page then shows it live.'),
      el('button', { class: 'btn primary', disabled: S.closed ? '' : null, onclick: analyze }, 'Analyse this tender')));
    renderHeader();
    return;
  }
  host.append(el('h1', { class: 'doc-title' }, S.model.title || S.analysis || ''));
  host.append(renderSecnav());
  // One panel per client tab; every section of the document lands in exactly one of them, so
  // nothing becomes unreachable. Only the active panel is visible — the others stay rendered, so
  // switching tabs never re-renders and never loses a patch made to a row in a hidden tab.
  const placed = new Set();
  for (const t of S.page.tabs) {
    host.append(renderTabPanel(t));
    // A placed §1 subsection (`s1.h2`) also claims its parent §1, so the section is not rendered twice.
    for (const s of t.sections) { placed.add(s.id); const dot = s.id.indexOf('.'); if (dot > 0) placed.add(s.id.slice(0, dot)); }
  }
  // Anything the tab model did not claim (a hand-added section, a stray top-level block) is still
  // shown rather than silently dropped.
  const rest = (S.model.blocks || []).filter(b => !(b.kind === 'section' && (placed.has(b.id) || b.n === 4 || b.n === 5)));
  if (rest.length) {
    const panel = host.querySelector('.tab-panel[data-tab="overview"]');
    for (const b of rest) if (!placed.has(b.id)) panel.append(b.kind === 'section' ? renderSectionCard(b) : renderBlockNode(b));
  }
  setPageTab(S.page.active);
  renderReqLists();
  markNoted();
  host.scrollTop = scrollY;
  positionPopover();
  renderHeader();
}
/**
 * Re-render only the block that owns `id` (req row for its sub-lines, §3 row, question, paragraph);
 * falls back to a full render. A req row renders as an array of `<tr>` (main + assume/clarify/global-
 * ref/propose lines); the count can change between batches, so any stale trailing siblings the fresh
 * render no longer produced (marked `data-parent="<root id>"`) are dropped after the swap.
 */
function patchFor(id) {
  const b = findBlock(id); if (!b) { renderDoc(); return; }
  const rootId = (b.kind === 'assume' || b.kind === 'clarify') && b.parent ? b.parent : b.id;
  const root = findBlock(rootId) || b;
  if (root.kind === 'section' || root.kind === 'table') { renderDoc(); return; }
  const old = document.querySelector(`#doc [data-id="${CSS.escape(root.id)}"]`);
  if (!old) return; // filtered out or inside a list not rendered; nothing to patch
  const rendered = renderBlockNode(root);
  const nodes = Array.isArray(rendered) ? rendered : [rendered];
  if (!nodes.length || !nodes[0] || nodes[0].tagName !== old.tagName) { renderDoc(); return; }
  let sib = old.nextElementSibling;
  const stale = [];
  while (sib && sib.dataset.parent === root.id) { stale.push(sib); sib = sib.nextElementSibling; }
  old.replaceWith(...nodes);
  stale.forEach(n => n.remove());
  markNoted();
  if (pop.open) positionPopover();
}
function refreshSummary() {
  const ov = $('#overview'); if (ov) ov.replaceWith(renderOverview());
  renderHeader();
}
function flashIds(ids) {
  for (const id of ids) {
    const node = document.querySelector(`#doc [data-id="${CSS.escape(id)}"]`);
    if (node) { node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash'); }
  }
}
function gotoBlock(id, retried) {
  // Deep link into a block that lives in a tab that is not showing: switch the page tab first,
  // then its source group, before looking for the node.
  const rowId = tabOwnerId(id);
  const pageKey = tabOfRow(S.page.tabs, rowId) || tabOfSection(S.page.tabs, id) || ownerTabOfNode(id);
  if (pageKey && pageKey !== S.page.active) setPageTab(pageKey);
  const groupKey = S.reqTab.byId[rowId];
  if (pageKey && groupKey && S.sub[pageKey] !== groupKey) setSubTab(pageKey, groupKey);
  let target = document.querySelector(`#doc [data-id="${CSS.escape(id)}"]`);
  if (!target && !retried && findBlock(id)) { // hidden by the §4 filters → reset them once
    for (const k of Object.keys(F)) S.filters[k] = F[k] === 'chk' ? false : '';
    lsSet(LS.filters, S.filters); renderSecnav(); renderReqLists();
    return gotoBlock(id, true);
  }
  if (!target) return;
  const det = target.closest('details'); if (det) det.open = true;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-goto]');
  if (a) { e.preventDefault(); e.stopPropagation(); gotoBlock(a.dataset.goto); }
});

// ---------------------------------------------------------------- writes (optimistic; 202 = queued behind the run)
function setTickState(l, v) { const st = l.status || (l.status = {}); st.state = v === 'x' ? 'ticked-accept' : v === '-' ? 'ticked-reject' : (st.suspect ? 'suspect' : 'proposed'); }
async function tick(line, value) {
  if (S.closed) return;
  if (isFrozen(line)) { toast(`${line.id} is frozen (${tickState(line)}) — only the reconcile changes it.`, 'warn'); return; }
  const prev = JSON.stringify(line.status || {});
  setTickState(line, value); recompute(); patchFor(line.id); refreshSummary();
  try {
    const r = await api('/api/tick', { id: line.id, value });
    if (r._status === 202) { S.local.ticks[line.id] = value; toast(`${line.id}: queued until the run ends${r.lockedBy ? ` (${r.lockedBy})` : ''}.`, 'info'); }
  } catch (e) {
    line.status = JSON.parse(prev); recompute(); patchFor(line.id); refreshSummary();
    toast(e.status === 409 ? `${line.id} not changed: ${e.message}` : `Tick failed: ${e.message}`, 'bad');
    if (e.status !== 409) load().catch(() => {});
  }
}
function setAnswerState(q, a) {
  for (const o of q.options || []) o.checked = Boolean(a.option) && o.letter === a.option;
  if (q.other) { q.other.checked = Boolean(a.other); q.other.text = a.other || ''; }
  else if (a.other) q.other = { text: a.other, checked: true, line: null };
}
async function answer(q, a) {
  if (S.closed) return;
  const prev = JSON.stringify({ options: q.options, other: q.other });
  setAnswerState(q, a); recompute(); patchFor(q.id); refreshSummary();
  const body = { qid: q.id }; if (a.option) body.option = a.option; if (a.other) body.other = a.other;
  try {
    const r = await api('/api/answer', body);
    if (r._status === 202) { S.local.answers[q.id] = a; toast(`${q.id}: queued until the run ends.`, 'info'); }
  } catch (e) {
    Object.assign(q, JSON.parse(prev)); recompute(); patchFor(q.id); refreshSummary();
    toast(`Answer failed: ${e.message}`, 'bad'); load().catch(() => {});
  }
}
function applyLocal() {
  if (!S.model) return;
  for (const [id, v] of Object.entries(S.local.ticks)) { const l = findBlock(id); if (l && !isFrozen(l)) setTickState(l, v); }
  for (const [qid, a] of Object.entries(S.local.answers)) { const q = findBlock(qid); if (q) setAnswerState(q, a); }
}
async function postBatch(body, label) {
  try {
    const r = await api('/api/batch', body);
    S.changed.clear();
    toast(`${label} ${r.id || ''} ${r.queued ? 'queued behind the active run' : 'sent'}${S.agent.present ? '' : ' · the agent is not connected; it runs once the skill reconnects'}.`, S.agent.present ? 'info' : 'warn');
    return r;
  } catch (e) { toast(`${label} failed: ${e.message}`, 'bad'); }
}
function reconcile() {
  const p = S.pend;
  if (!p.count && !confirm('Nothing is ticked or answered. Run a reconcile anyway (refreshes status, confidence and the log)?')) return;
  return postBatch({ kind: 'reconcile' }, 'Reconcile');
}
async function exportRun() {
  if (!S.meta?.exportState?.gateNow) { toast('Export is gated: ' + (S.meta?.readyGate?.reasons || []).join(' · '), 'warn'); return; }
  return postBatch({ kind: 'export' }, 'Export');
}
function analyze() { return postBatch({ kind: 'analyze' }, 'Analysis'); }
/**
 * Confirming the mapping writes the normalised CSVs and hands the agent one ordinary batch
 * (`kind: batch`, `stage: import`) — the same channel every other run uses.
 */
async function confirmImport(map) {
  try {
    const j = await api('/api/import/confirm', { map });
    toast(`Mapping confirmed — ${(j.written || []).length} table${(j.written || []).length === 1 ? '' : 's'} written`);
    await load();
  } catch (e) {
    toast((e?.body?.problems || [e?.body?.error || 'could not confirm the mapping']).join(' · '), 'bad');
  }
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
function renderHeader() {
  const m = S.meta;
  $('#doc-ref').textContent = m ? [m.rfp, m.client].filter(Boolean).join(' · ') : (S.session?.slug || '');
  const pill = $('#status-pill'), conf = $('#confidence');
  pill.hidden = !m?.status; pill.textContent = m?.status || ''; pill.className = 'pill ' + (m?.readyGate?.ready || /ready/i.test(m?.status || '') ? 'ready' : 'progress');
  conf.hidden = m?.confidence == null; conf.textContent = m?.confidence != null ? `${m.confidence}%` : '';
  document.title = `${m?.rfp || S.session?.slug || 'Tender'} · Tender Discovery Tool`;
  const p = S.pend || { ticks: [], answers: [] };
  const rb = $('#reconcile-btn');
  rb.textContent = `Reconcile (${p.ticks.length} tick${p.ticks.length === 1 ? '' : 's'} · ${p.answers.length} answer${p.answers.length === 1 ? '' : 's'})`;
  rb.disabled = S.closed || !S.model;
  rb.classList.toggle('attention', p.count > 0);
  const xb = $('#export-btn');
  const gate = Boolean(m?.exportState?.gateNow);
  xb.disabled = S.closed || !gate;
  xb.title = gate ? 'Ready to submit — export one CSV per client table' : ((m?.readyGate?.reasons || []).join(' · ') || 'Export is enabled at Ready to submit');
  $('#stop-btn').disabled = S.closed;
}
const uptimeSec = () => S.session?.started ? (Date.now() - Date.parse(S.session.started)) / 1000 : 0;
const stateClass = () => S.closed || S.serverGone ? 'bad' : S.run ? 'busy' : S.agent.present ? 'ok' : 'bad';
function renderBanners() {
  const host = $('#banners'); host.innerHTML = '';
  if (S.closed) host.append(el('div', { class: 'banner bad' }, 'Session ended. Re-run the skill with --editor to open it again.'));
  else if (S.serverGone) host.append(el('div', { class: 'banner bad' }, 'Server unreachable - the session may have ended (heartbeat timeout or stop).'));
  if (S.parseError && !S.closed) host.append(el('div', { class: 'banner bad' }, `${S.analysis || 'the analysis file'} does not parse right now: ${S.parseError.message} - showing the last good version until it is fixed.`));
  if (S.run && !S.closed) {
    const b = el('div', { class: 'banner info' }, `Agent working on ${S.run.id}${S.run.kind ? ' (' + S.run.kind + ')' : ''}${S.run.stage ? ' · ' + S.run.stage : ''} - the document is locked; ticks, answers and proposals you make now are queued and applied when the run ends.`);
    if (!S.agent.present) b.append(el('span', { class: 'muted' }, 'the agent is not polling'), el('button', { class: 'btn sm', title: 'Finish the run as aborted so queued batches can start when the agent returns', onclick: abortRun }, 'Abort run'));
    host.append(b);
  }
  if (!S.closed && !S.serverGone && !S.agent.present && (S.agent.everPolled || uptimeSec() > (S.session?.agent?.timeout || 180))) host.append(el('div', { class: 'banner' }, 'Agent disconnected - re-run sw-discover-tender --editor on this tender to resume. The page keeps working; batches wait in the queue.'));
  if (S.queuedWrites && !S.closed) host.append(el('div', { class: 'banner' }, `${S.queuedWrites} direct write${S.queuedWrites > 1 ? 's' : ''} queued until the run ends.`));
  const qb = $('#queued-badge'); qb.hidden = !S.queuedWrites; qb.textContent = S.queuedWrites ? `${S.queuedWrites} queued` : '';
  const dot = $('#status-dot'), txt = $('#status-text'), st = stateClass();
  dot.className = 'dot ' + st; txt.className = 'muted ' + st;
  txt.textContent = S.closed ? 'session closed' : S.serverGone ? 'server unreachable' : S.run ? `agent working · ${S.run.id}` + (S.run.stage ? ` · ${S.run.stage}` : '') + (S.queue.length ? ` · ${S.queue.length} queued` : '') : S.agent.present ? 'agent connected' : 'agent not connected';
  dot.title = txt.title = S.closed ? 'The session has ended.' : S.serverGone ? 'The editor server does not answer.' : S.run ? 'The agent session is processing a batch.' : S.agent.present ? 'The skill session loop is polling this server; batches are processed right away.' : 'No skill session loop is polling this server. Batches wait in the queue - re-run sw-discover-tender --editor on this tender to resume.';
  const as = $('#agent-state'); as.className = 'agent-state ' + st;
  as.textContent = S.run ? 'working' : S.agent.present ? 'connected' : S.closed || S.serverGone ? 'offline' : 'not connected';
  updateSendButton();
  if (S.model) renderHeader();
}

// ---------------------------------------------------------------- chat
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
function batchBubble(e) {
  const label = { analyze: 'analyse', reconcile: 'reconcile', export: 'export', batch: 'you' }[e.kind] || e.kind || 'batch';
  const m = el('div', { class: 'msg user' + (e.kind === 'batch' ? '' : ' auto') }, el('div', { class: 'm-head' }, `${label} · ${e.id || ''}`, e.queued ? el('span', { class: 'badge' }, 'queued') : null));
  if (e.kind === 'analyze') m.append(el('div', { class: 'm-body' }, 'Analyse the tender: classify every row against the installed Shopware, estimate it, propose scope-lock assumptions and open questions.'));
  else if (e.kind === 'reconcile') m.append(el('div', { class: 'm-body' }, 'Reconcile: freeze the ticked assumptions, dissolve the answered questions, re-estimate the affected rows, refresh status and confidence.'));
  else if (e.kind === 'export') m.append(el('div', { class: 'm-body' }, 'Export the client response: one CSV per source table with compliance, comment and effort.'));
  else {
    const notes = e.notes || [];
    if (notes.length) m.append(el('div', { class: 'm-body' }, el('ul', { class: 'note-list' }, ...notes.map(n => el('li', {}, n.block ? el('a', { class: 'blocklink', href: '#' + n.block, dataset: { goto: n.block } }, n.block) : null, n.block ? ' ' : '', n.text || '')))));
    if (e.chat) m.append(renderMd(e.chat, 'm-body'));
  }
  return m;
}
function replyBubble(e, progressLines) {
  const m = el('div', { class: 'msg agent' }, el('div', { class: 'm-head' }, 'agent', e.kind ? el('span', { class: 'badge' }, e.kind) : null, e.batch ? el('span', { class: 'muted' }, e.batch) : null, e.interim ? el('span', { class: 'badge' }, 'interim') : null, e.orphan ? el('span', { class: 'badge medium', title: 'reply arrived for a run that was no longer active' }, 'orphan') : null));
  m.append(renderMd(e.md || '', 'm-body'));
  const changed = Array.isArray(e.changed) ? e.changed : e.changed && typeof e.changed === 'object' ? Object.values(e.changed).flat().filter(x => typeof x === 'string') : [];
  if (changed.length) m.append(el('div', { class: 'changed-links' }, el('span', { class: 'muted' }, 'changed: '), ...changed.slice(0, 40).map(id => el('a', { href: '#' + id, dataset: { goto: id } }, id)), changed.length > 40 ? el('span', { class: 'muted' }, `+${changed.length - 40}`) : null));
  if (e.repairs?.length) m.append(el('div', { class: 'repairs' }, 'repaired: ' + e.repairs.join('; ')));
  if (e.warnings?.length) m.append(el('div', { class: 'repairs' }, 'warnings: ' + e.warnings.join('; ')));
  if (progressLines?.length) m.append(el('details', { class: 'progress-log' }, el('summary', {}, `progress log (${progressLines.length})`), ...progressLines.map(l => el('div', {}, '› ' + l))));
  return m;
}

// ---------------------------------------------------------------- events + session
function applySession(info) {
  S.session = info; S.agent = info.agent || S.agent;
  S.run = info.run ? { id: info.run.id, kind: info.run.kind, stage: info.run.stage || null } : null; S.queue = info.queue || [];
  S.queuedWrites = info.queuedWrites || 0;
  if ('parseError' in info) S.parseError = info.parseError || null;
  if (info.analysis) S.analysis = info.analysis; if (info.source) S.source = info.source;
}
function applyDoc(d) {
  const hadModel = Boolean(S.model);
  S.model = d.model || null; S.meta = d.meta || d.model?.meta || null;
  S.parseError = d.parseError || null;
  applyLocal(); recompute(); rebindNotes(); renderNotes();
  const changed = [...(d.changed || []), ...(d.added || [])];
  if (!/^(tick|answer|propose)$/.test(d.reason || '')) for (const id of changed) S.changed.add(id); // own direct writes are not "agent changed"
  const structural = !hadModel || !S.model || (d.added || []).length || (d.removed || []).length || d.reason === 'reload' || !$('#overview');
  if (structural) renderDoc();
  else { for (const id of d.changed || []) patchFor(id); renderReqLists(); refreshSummary(); }
  flashIds(changed);
  renderBanners();
}
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (ev) => { S.serverGone = false; applySession(JSON.parse(ev.data).session); renderBanners(); });
  es.addEventListener('doc', (ev) => applyDoc(JSON.parse(ev.data)));
  es.addEventListener('chat', (ev) => { S.chat.push(JSON.parse(ev.data)); renderChat(); });
  es.addEventListener('progress', () => { /* the chat event carries it too */ });
  es.addEventListener('run', (ev) => { const r = JSON.parse(ev.data); S.queue = r.queue || []; S.run = r.active ? { id: r.active, kind: r.kind, stage: r.stage || null } : null; renderBanners(); });
  es.addEventListener('agent', (ev) => { const a = JSON.parse(ev.data); S.agent.present = a.present; S.agent.everPolled = a.everPolled || S.agent.everPolled; renderBanners(); });
  es.addEventListener('queued', (ev) => { S.queuedWrites = JSON.parse(ev.data).count || 0; if (!S.queuedWrites) S.local = { ticks: {}, answers: {} }; renderBanners(); });
  es.addEventListener('import', (ev) => { const n = JSON.parse(ev.data); if (n.tab && n.tab === S.tab) return; S.importState = n.importState || S.importState; if (!S.model) renderDoc(); });
  es.addEventListener('notes', (ev) => { const n = JSON.parse(ev.data); if (n.tab && n.tab !== S.tab) { S.notes = n.notes || []; rebindNotes(); renderNotes(); markNoted(); } });
  es.addEventListener('closing', () => { S.closed = true; es.close(); renderBanners(); renderHeader(); document.body.append(el('div', { class: 'overlay' }, 'Session ended. You can close this tab.')); });
  es.onerror = () => { if (S.closed) return; S.serverGone = true; renderBanners(); };
  es.onopen = () => { if (S.serverGone) { S.serverGone = false; load(); } };
}
async function load() {
  const j = await api('/api/session');
  applySession(j.session); S.analysis = j.analysis; S.source = j.source;
  S.model = j.model || null; S.meta = j.meta || j.model?.meta || null; S.parseError = j.parseError || null; S.notes = j.notes || []; S.chat = j.chat || [];
  S.sourceCols = j.sourceColumns || S.sourceCols;
  S.importState = j.importState || null;
  S.queuedWrites = Array.isArray(j.queued) ? j.queued.length : (typeof j.queued === 'number' ? j.queued : S.queuedWrites);
  applyLocal(); recompute(); rebindNotes(); renderDoc(); renderNotes(); renderChat(); renderBanners();
}
function heartbeat() {
  if (S.closed) return;
  fetch('/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tab: S.tab }) })
    .then(r => r.json()).then(j => {
      let dirty = S.serverGone; S.serverGone = false;
      if (j.agent && j.agent.present !== S.agent.present) { S.agent.present = j.agent.present; dirty = true; }
      if ('run' in j && (j.run?.id || null) !== (S.run?.id || null)) { S.run = j.run ? { id: j.run.id, kind: j.run.kind, stage: j.run.stage || null } : null; dirty = true; }
      if (dirty) renderBanners();
    })
    .catch(() => { S.serverGone = true; renderBanners(); });
}

// ---------------------------------------------------------------- wiring
Object.assign(S.filters, lsGet(LS.filters, {}));
$('#send-btn').addEventListener('click', () => sendBatch($('#chat-text').value));
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
$('#chat-text').addEventListener('input', (e) => { const ta = e.target; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 8 * 20 + 14) + 'px'; });
$('#free-note-btn').addEventListener('click', () => {
  const text = prompt('Free note for the agent (not bound to a block):');
  if (text && text.trim()) addNote({ kind: 'free', file: S.analysis || null, text: text.trim() });
});
$('#reconcile-btn').addEventListener('click', reconcile);
$('#export-btn').addEventListener('click', exportRun);
$('#stop-btn').addEventListener('click', async () => {
  if (!confirm('End the editor session? The server stops; the skill in the terminal reports and exits. Ticks and answers are already in the document.')) return;
  try { await api('/api/close', {}); } catch { /* already gone */ }
});

load().then(() => { connect(); heartbeat(); setInterval(heartbeat, 5000); setInterval(renderBanners, 15000); })
  .catch(e => { document.body.append(el('div', { class: 'overlay' }, 'Could not load the session: ' + e.message)); });
