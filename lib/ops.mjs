// Operator operations on the working document: confirm, accept/reject a proposal, type or
// remove an assumption, answer a client question, patch Client Response / Internal note, and
// write the partner profile. Build contract §3, §4; L-1…L-6, AQ-1…AQ-6, R-2, R-3.
import fs from 'node:fs';
import path from 'node:path';
import * as out from './out.mjs';
import { canonical, resolveRoot } from './paths.mjs';
import { parse, TABS } from './parse.mjs';
import { readProfile, regime as regimeOf } from './profile.mjs';
import { round025 } from './calc.mjs';
import * as proposals from './proposals.mjs';
import { renderItemsSection, renderQuestionsSection, replaceSections, atomicWrite, setFrontmatterField } from './edit.mjs';
import { guessCoverageTokenMap, COVERAGE_KEYS } from './import-map.mjs';
import { confirmedMapFileForDoc } from './import-export.mjs';
import {
  proseBefore, renderContext, restoreFromSource, readPointers, writePointers, fitBackPathFor, confirmFitBack,
} from './intake.mjs';
import { isNegativeToken } from '../page/view.mjs';

function today() { return new Date().toISOString().slice(0, 10); }

/** Writes §1 (Context: Project information + Not taken) and §4 (Scope items) together, in
 * canonical order — the write primitive `move`/`skip`/`restore`/`info` share. */
function writeContextAndItems(ctx, { projectInfo = ctx.model.projectInfo, notTaken = ctx.model.notTaken, items = ctx.model.items } = {}) {
  const s1 = ctx.model.blocks.find(b => b.n === 1);
  const contextRaw = renderContext(proseBefore(s1?.raw), projectInfo, notTaken);
  const itemsRaw = renderItemsSection(items);
  atomicWrite(ctx.docAbs, replaceSections(ctx.text, ctx.model.blocks, [[1, contextRaw], [4, itemsRaw]]));
}

function load(root, doc) {
  const docAbs = canonical(doc, root || process.cwd());
  if (!fs.existsSync(docAbs)) return { error: { ok: false, reason: `document not found: ${doc}` } };
  const rootDir = root || resolveRoot({ docAbs });
  const text = fs.readFileSync(docAbs, 'utf8');
  const model = parse(text, { path: docAbs });
  if (model.errors.length) return { error: { ok: false, reason: `document does not parse: ${model.errors[0]}` } };
  const slug = model.slug || path.basename(docAbs).replace(/-analysis\.md$/i, '');
  return { model, docAbs, text, slug, root: rootDir };
}

function writeItemsSection(ctx) {
  atomicWrite(ctx.docAbs, replaceSections(ctx.text, ctx.model.blocks, [[4, renderItemsSection(ctx.model.items)]]));
}
function writeQuestionsSection(ctx) {
  atomicWrite(ctx.docAbs, replaceSections(ctx.text, ctx.model.blocks, [[5, renderQuestionsSection(ctx.model.questions)]]));
}

function addBulletUnderHeading(lines, heading, bulletText) {
  const idx = lines.findIndex(l => l.trim() === heading);
  if (idx < 0) return null;
  let end = idx + 1;
  while (end < lines.length && !/^###\s/.test(lines[end])) end++;
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  return [...lines.slice(0, insertAt), `- ${bulletText}`, ...lines.slice(insertAt)];
}

/** Appends a bullet under `### Assumptions` in §3 (global assumption/proposal, contract §1). */
function addGlobalAssumption(ctx, statement) {
  const sec = ctx.model.blocks.find(b => b.n === 3);
  const lines = (sec?.raw || '').split('\n');
  const updated = addBulletUnderHeading(lines, '### Assumptions', statement);
  if (!updated) return false;
  while (updated.length && updated[0].trim() === '') updated.shift();
  atomicWrite(ctx.docAbs, replaceSections(ctx.text, ctx.model.blocks, [[3, updated.join('\n')]]));
  return true;
}

// ---------------------------------------------------------------------------

/**
 * `confirm({ root, doc, ids })` — L-1, L-2, L-6. Confirms every id it can; an id that fails a
 * precondition (unknown, or a failed item with no Client Response) is skipped with a reason
 * instead of blocking the rest of a bulk confirm (AC-17). Confirming an item auto-rejects its
 * still-waiting proposals (AQ-4); `rejected` reports exactly which ones, so the operator sees
 * what confirming just gave up on (N-3).
 */
export function confirm({ root, doc, ids }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  if (!Array.isArray(ids) || !ids.length) return { ok: false, reason: 'ids required' };
  const byId = new Map(ctx.model.items.map(it => [it.id, it]));
  const dateStr = today();
  const confirmed = [], skipped = [], rejected = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) { skipped.push({ id, reason: `item ${id} not found` }); continue; }
    if (item.status.kind === 'failed' && !item.clientResponse) { skipped.push({ id, reason: `item ${id} is failed and needs an operator Client Response before it can be confirmed (L-6)` }); continue; }
    item.status = { kind: 'confirmed', date: dateStr, cq: null };
    for (const p of proposals.rejectWaitingFor(ctx.root, ctx.slug, id)) {
      item.references = [...item.references, `rejected: ${p.statement}`];
      rejected.push({ id: p.id, item: id, statement: p.statement });
    }
    confirmed.push(id);
  }
  if (confirmed.length) writeItemsSection(ctx);
  if (!confirmed.length) return { ok: false, reason: skipped[0]?.reason || 'nothing to confirm', skipped };
  return { ok: true, confirmed, skipped, rejected };
}

/**
 * `unconfirm({ root, doc, ids })` — reverses `confirm`: an operator changed their mind and takes
 * a confirmation back. Refuses any id that isn't confirmed instead of blocking the rest of a bulk
 * call (same skip-and-continue shape as `confirm`, AC-17). Reuses the `reopened` status the tool
 * already uses for reopened items, so the row counts as dirty/unconfirmed in readiness, filters
 * and totals like any other reopen — no new status. Client Response, Assumptions, Effort and
 * Internal note are left untouched; this only removes the confirmation.
 */
export function unconfirm({ root, doc, ids }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  if (!Array.isArray(ids) || !ids.length) return { ok: false, reason: 'ids required' };
  const byId = new Map(ctx.model.items.map(it => [it.id, it]));
  const dateStr = today();
  const unconfirmed = [], skipped = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) { skipped.push({ id, reason: `item ${id} not found` }); continue; }
    if (item.status.kind !== 'confirmed') { skipped.push({ id, reason: `item ${id} is not confirmed` }); continue; }
    item.status = { kind: 'reopened', date: null, cq: null };
    item.references = [...item.references, `reopened ${dateStr}: unconfirmed by operator`];
    unconfirmed.push(id);
  }
  if (unconfirmed.length) writeItemsSection(ctx);
  if (!unconfirmed.length) return { ok: false, reason: skipped[0]?.reason || 'nothing to unconfirm', skipped };
  return { ok: true, unconfirmed, skipped };
}

/** `accept({ root, doc, id })` — AQ-3, R-2, AC-8. */
export function accept({ root, doc, id }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  const p = proposals.list(ctx.root, ctx.slug).find(x => x.id === id);
  if (!p) return { ok: false, reason: `proposal ${id} not found` };
  if (p.status !== 'waiting') return { ok: false, reason: `proposal ${id} is ${p.status}, not waiting` };
  const r = proposals.accept(ctx.root, ctx.slug, id);
  if (!r.ok) return r;

  if (p.item == null) {
    if (!addGlobalAssumption(ctx, p.statement)) return { ok: false, reason: '§3 Assumptions heading not found' };
    proposals.markReestimate(ctx.root, ctx.slug, '*', `assumption ${id} accepted`);
    return { ok: true, global: true };
  }
  const item = ctx.model.items.find(it => it.id === p.item);
  if (!item) return { ok: false, reason: `item ${p.item} not found` };
  item.assumptions = [...item.assumptions, p.statement];
  if (item.status.kind === 'confirmed') {
    item.status = { kind: 'reopened', date: null, cq: null };
    item.references = [...item.references, `reopened ${today()}: assumption ${id} accepted`];
  }
  // The effort drops right away on accept: a numeric-PD Effort (profile regime) is lowered by
  // `pdSaved`, floored at the profile's smallest calibration point (or 0.25 with none) so it never
  // goes to zero or negative — the next reestimate (marked below regardless) can still refine it.
  // A T-shirt Effort (a size letter) is left as it is; the reestimate adjusts it instead.
  if (item.effort && item.effort.regime === 'profile' && typeof item.effort.pd === 'number' && typeof p.pdSaved === 'number' && p.pdSaved > 0) {
    const { profile } = readProfile(ctx.root);
    const floor = typeof profile?.calibration?.small === 'number' ? profile.calibration.small : 0.25;
    const before = item.effort.pd;
    const after = Math.max(floor, round025(before - p.pdSaved));
    if (after !== before) {
      item.effort = { ...item.effort, pd: after };
      item.references = [...item.references, `was ${before} PD`];
    }
  }
  writeItemsSection(ctx);
  proposals.markReestimate(ctx.root, ctx.slug, item.id, `assumption ${id} accepted`);
  return { ok: true, item: item.id };
}

/** Removes the bullet an accepted proposal added under `heading` in §3 (mirror of
 * `addBulletUnderHeading` — a rejected-after-accepted global proposal, contract §3/R-2). */
function removeBulletUnderHeading(lines, heading, bulletText) {
  const idx = lines.findIndex(l => l.trim() === heading);
  if (idx < 0) return null;
  let end = idx + 1;
  while (end < lines.length && !/^###\s/.test(lines[end])) end++;
  const bulletIdx = lines.slice(idx + 1, end).findIndex(l => l.trim() === `- ${bulletText}`);
  if (bulletIdx < 0) return null;
  const at = idx + 1 + bulletIdx;
  return [...lines.slice(0, at), ...lines.slice(at + 1)];
}

function removeGlobalAssumption(ctx, statement) {
  const sec = ctx.model.blocks.find(b => b.n === 3);
  const lines = (sec?.raw || '').split('\n');
  const updated = removeBulletUnderHeading(lines, '### Assumptions', statement);
  if (!updated) return false;
  atomicWrite(ctx.docAbs, replaceSections(ctx.text, ctx.model.blocks, [[3, updated.join('\n')]]));
  return true;
}

/** `reject({ root, doc, id })` — AQ-4. Rejecting an already-*accepted* proposal undoes the
 * assumption it added (same as `unassume`, R-2): the bullet is removed, `rejected:` is
 * recorded, the item is marked for re-estimate and reopens immediately if confirmed. */
export function reject({ root, doc, id }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  const p = proposals.list(ctx.root, ctx.slug).find(x => x.id === id);
  if (!p) return { ok: false, reason: `proposal ${id} not found` };
  const wasAccepted = p.status === 'accepted';
  proposals.reject(ctx.root, ctx.slug, id);

  if (p.item == null) {
    if (wasAccepted) {
      removeGlobalAssumption(ctx, p.statement);
      proposals.markReestimate(ctx.root, ctx.slug, '*', `assumption ${id} rejected`);
    }
    return { ok: true, global: true };
  }

  const item = ctx.model.items.find(it => it.id === p.item);
  if (!item) return { ok: true };
  if (wasAccepted) {
    const idx = item.assumptions.findIndex(a => a === p.statement);
    if (idx >= 0) item.assumptions = item.assumptions.filter((_, i) => i !== idx);
  }
  item.references = [...item.references, `rejected: ${p.statement}`];
  if (wasAccepted && item.status.kind === 'confirmed') {
    item.status = { kind: 'reopened', date: null, cq: null };
    item.references = [...item.references, `reopened ${today()}: assumption ${id} rejected`];
  }
  writeItemsSection(ctx);
  if (wasAccepted) proposals.markReestimate(ctx.root, ctx.slug, item.id, `assumption ${id} rejected`);
  return { ok: true };
}

/** `assume({ root, doc, item, statement })` — `item: null` is global. R-2. */
export function assume({ root, doc, item, statement }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  const stmt = String(statement ?? '').trim();
  if (!stmt) return { ok: false, reason: 'statement required' };
  if (item == null) {
    if (!addGlobalAssumption(ctx, stmt)) return { ok: false, reason: '§3 Assumptions heading not found' };
    proposals.markReestimate(ctx.root, ctx.slug, '*', 'operator-typed global assumption');
    return { ok: true, global: true };
  }
  const it = ctx.model.items.find(x => x.id === item);
  if (!it) return { ok: false, reason: `item ${item} not found` };
  it.assumptions = [...it.assumptions, stmt];
  if (it.status.kind === 'confirmed') {
    it.status = { kind: 'reopened', date: null, cq: null };
    it.references = [...it.references, `reopened ${today()}: operator-typed assumption`];
  }
  writeItemsSection(ctx);
  proposals.markReestimate(ctx.root, ctx.slug, item, 'operator-typed assumption');
  return { ok: true, item };
}

/** `unassume({ root, doc, item, statement })` — removes an accepted assumption; `item: null` (or
 * `"global"`) removes an operator-typed GLOBAL assumption from §3 instead (#11). R-2. */
export function unassume({ root, doc, item, statement }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  if (item == null || item === 'global') {
    const stmt = String(statement ?? '').trim();
    if (!stmt) return { ok: false, reason: 'statement required' };
    if (!removeGlobalAssumption(ctx, stmt)) return { ok: false, reason: `global assumption not found: "${stmt}"` };
    proposals.markReestimate(ctx.root, ctx.slug, '*', 'operator-typed global assumption removed');
    return { ok: true, global: true };
  }
  const it = ctx.model.items.find(x => x.id === item);
  if (!it) return { ok: false, reason: `item ${item} not found` };
  const idx = it.assumptions.findIndex(a => a === statement);
  if (idx < 0) return { ok: false, reason: `assumption not found on item ${item}` };
  it.assumptions = it.assumptions.filter((_, i) => i !== idx);
  it.references = [...it.references, `rejected: ${statement}`];
  if (it.status.kind === 'confirmed') {
    it.status = { kind: 'reopened', date: null, cq: null };
    it.references = [...it.references, `reopened ${today()}: assumption removed`];
  }
  writeItemsSection(ctx);
  const p = proposals.add(ctx.root, ctx.slug, { item, statement, run: 'unassume' });
  if (p) proposals.reject(ctx.root, ctx.slug, p.id);
  proposals.markReestimate(ctx.root, ctx.slug, item, 'assumption removed');
  return { ok: true, item };
}

/** `answer({ root, doc, cq, key })` — AQ-6, L-3. */
export function answer({ root, doc, cq, key }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  const q = ctx.model.questions.find(x => x.id === cq);
  if (!q) return { ok: false, reason: `question ${cq} not found` };
  if (q.answered) return { ok: false, reason: `${cq} is already answered` };
  const opt = (q.options || []).find(o => o.key === key);
  if (!opt) return { ok: false, reason: `option ${key} is not one of ${cq}'s options` };
  for (const o of q.options) o.checked = o.key === key;
  q.answered = { date: today(), key };
  writeQuestionsSection(ctx);
  const affected = new Set(q.items || []);
  for (const it of ctx.model.items) if (it.status.kind === 'blocked' && it.status.cq === cq) affected.add(it.id);
  for (const itemId of affected) proposals.markReestimate(ctx.root, ctx.slug, itemId, `${cq} answered: ${key}`);
  return { ok: true, affected: [...affected] };
}

/** `patch({ root, doc, id, clientResponse, internalNote })` — L-4: never reopens. */
export function patch({ root, doc, id, clientResponse, internalNote }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  const it = ctx.model.items.find(x => x.id === id);
  if (!it) return { ok: false, reason: `item ${id} not found` };
  if (clientResponse != null) it.clientResponse = clientResponse;
  if (internalNote != null) it.internalNote = internalNote;
  writeItemsSection(ctx);
  return { ok: true, item: id };
}

// --- intake review (own-tabs, build contract §3/§8) ---------------------------------------------

/** The document's own xlsx source, absolute — `null` when there is none, or it is not xlsx (a CSV
 * or PDF source has no fit-back map, contract §4). */
function xlsxSourceAbs(ctx) {
  const sources = Object.keys(ctx.model.frontmatter?.data?.['source-sha256'] || {});
  if (!sources.length) return null;
  const sourceFile = sources[sources.length - 1];
  if (!/\.xlsx$/i.test(sourceFile)) return null;
  return path.join(path.dirname(ctx.docAbs), sourceFile);
}

/** `intakeConfirm({ root, doc })` — backward compatibility only: intake confirms itself now
 * (own-tabs contract §3), so this is a harmless no-op on a document that already is; it only ever
 * does real work on an old document still at `review` from before that change, setting `intake:
 * confirmed` and `confirmedAt` on its fit-back map (xlsx sources only, `confirmFitBack`, shared
 * with `intake()`'s own auto-confirm — never duplicated). */
export function intakeConfirm({ root, doc }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  if (ctx.model.frontmatter?.data?.intake !== 'review') return { ok: true, already: true };
  const next = setFrontmatterField(ctx.text, 'intake', 'confirmed');
  atomicWrite(ctx.docAbs, next);
  confirmFitBack(xlsxSourceAbs(ctx));
  return { ok: true };
}

/** `move({ root, doc, id, tab, topic })` — moves the item to `### <tab> · <topic>`; `topic` omitted
 * keeps the item's current topic. Allowed in any intake state; never reopens, never changes the id
 * (contract §3). Creates or removes headings as a side effect of the canonical re-render. */
export function move({ root, doc, id, tab, topic }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  if (!TABS.includes(tab)) return { ok: false, reason: `tab "${tab}" is not one of ${TABS.join(', ')}` };
  const it = ctx.model.items.find(x => x.id === id);
  if (!it) return { ok: false, reason: `item ${id} not found` };
  const newTopic = topic != null && topic !== '' ? topic : it.topic;
  it.tab = tab; it.topic = newTopic; it.area = `${tab} · ${newTopic}`;
  writeContextAndItems(ctx);
  return { ok: true, item: id, tab, topic: newTopic };
}

/** `skip({ root, doc, id, why })` — allowed at any time (contract §3, the review gate is gone);
 * refused on a confirmed item ("unconfirm first") since skipping one would silently discard a
 * decision the operator already signed off. Removes the item from §4 and adds a Not-taken row
 * whose Source is the item's own pointer (`specs/.rfp/<slug>/item-pointers.json`, written by
 * `intake`) — so a later `restore` can find it again. */
export function skip({ root, doc, id, why }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  const it = ctx.model.items.find(x => x.id === id);
  if (!it) return { ok: false, reason: `item ${id} not found` };
  if (it.status.kind === 'confirmed') return { ok: false, reason: `item ${id} is confirmed — unconfirm first` };
  const reason = String(why ?? '').trim();
  if (!reason) return { ok: false, reason: 'why is required' };
  const pointers = readPointers(ctx.root, ctx.slug);
  const pointer = pointers[id];
  if (!pointer) return { ok: false, reason: `item ${id} has no recorded source pointer (re-run intake first)` };

  const items = ctx.model.items.filter(x => x.id !== id);
  const notTaken = [...ctx.model.notTaken, { source: pointer, text: it.requirement, why: reason }];
  writeContextAndItems(ctx, { notTaken, items });
  return { ok: true, item: id, source: pointer };
}

/** `restore({ root, doc, source })` — allowed at any time (contract §3, the review gate is gone).
 * Rebuilds the item from `extraction.json` plus the source's own snapshot (xlsx/csv) or
 * `extraction.json`'s `items` (pdf), status `queued`, placed per extraction; removes the matching
 * Not-taken row. */
export function restore({ root, doc, source }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  const row = ctx.model.notTaken.find(r => r.source === source);
  if (!row) return { ok: false, reason: `no Not-taken row for source "${source}"` };

  let built;
  try { built = restoreFromSource({ root: ctx.root, doc: ctx.docAbs, source }); }
  catch (e) { return { ok: false, reason: e.message }; }

  const id = built.id;

  const item = {
    id, area: `${built.tab} · ${built.topic}`, tab: built.tab, topic: built.topic, prio: built.prio || '',
    coverage: null, confidence: null, effort: null, requirement: built.requirement, clientResponse: '',
    assumptions: [], internalNote: '', references: [], status: { kind: 'queued', date: null, cq: null },
  };
  // Client order (contract §1): back before the first current item that comes after it in the source.
  const rank = new Map((built.order || []).map((x, i) => [x, i]));
  const mine = rank.get(id) ?? Infinity;
  const at = ctx.model.items.findIndex(x => (rank.get(x.id) ?? -1) > mine);
  const items = [...ctx.model.items];
  items.splice(at < 0 ? items.length : at, 0, item);
  const notTaken = ctx.model.notTaken.filter(r => r.source !== source);
  writeContextAndItems(ctx, { notTaken, items });

  const pointers = readPointers(ctx.root, ctx.slug);
  pointers[id] = source;
  writePointers(ctx.root, ctx.slug, pointers);
  return { ok: true, item: id };
}

/** `info({ root, doc, key, value })` — sets one §1 Project information Value, Source `operator`.
 * The operator's own value is kept verbatim, amounts included (2026-09-24 decision, contract §1). */
export function info({ root, doc, key, value }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  const row = ctx.model.projectInfo.find(r => r.key === key);
  if (!row) return { ok: false, reason: `unknown project information key "${key}"` };
  const v = String(value ?? '');
  const projectInfo = ctx.model.projectInfo.map(r => (r.key === key ? { ...r, value: v, source: 'operator' } : r));
  writeContextAndItems(ctx, { projectInfo });
  return { ok: true, key, value: v };
}

// --- partner profile ----------------------------------------------------------------------

function scalarYaml(v) { return typeof v === 'number' ? String(v) : JSON.stringify(String(v ?? '')); }
function isvYaml(list) {
  return '[ ' + (list || []).map(i => `{ name: ${scalarYaml(i.name)}, vendor: ${scalarYaml(i.vendor)}, versions: [${(i.versions || []).map(scalarYaml).join(', ')}] }`).join(', ') + ' ]';
}
function assetsYaml(list) {
  return '[ ' + (list || []).map(a => `{ name: ${scalarYaml(a.name)}, covers: ${scalarYaml(a.covers)}, pdSaved: ${Number(a.pdSaved)} }`).join(', ') + ' ]';
}

/** Serialises a profile object into the frontmatter YAML `readProfile` reads back. Contract §2, R-6. */
export function renderProfileYaml(data) {
  return [
    `calibration: { small: ${Number(data?.calibration?.small)}, big: ${Number(data?.calibration?.big)} }`,
    `overhead: ${Number(data?.overhead)}`,
    `buffer: { percent: ${Number(data?.buffer?.percent)}, mode: ${scalarYaml(data?.buffer?.mode)} }`,
    `isv: ${isvYaml(data?.isv)}`,
    `assets: ${assetsYaml(data?.assets)}`,
  ].join('\n') + '\n';
}

/** `profile({ root, doc, data })` — writes the profile, marks every item for re-estimate. */
export function profile({ root, doc, data }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  for (const isv of data?.isv || []) {
    if (isv && Object.prototype.hasOwnProperty.call(isv, 'licence')) return { ok: false, reason: 'profile: an isv entry must not carry a licence field (X-7)' };
  }
  const file = path.join(ctx.root, 'specs', 'rfp-partner-profile.md');
  let previous = null;
  try { previous = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  atomicWrite(file, `---\n${renderProfileYaml(data)}---\n`);
  const { reason } = readProfile(ctx.root);
  if (reason) {
    if (previous != null) atomicWrite(file, previous); else { try { fs.unlinkSync(file); } catch { /* ignore */ } }
    return { ok: false, reason };
  }
  // Frontmatter `regime` follows the profile, not the other way round (D-4): a profile write
  // that changes the regime keeps the document's own frontmatter true immediately.
  const nextRegime = regimeOf(ctx.root);
  const nextDocText = setFrontmatterField(ctx.text, 'regime', nextRegime);
  if (nextDocText !== ctx.text) atomicWrite(ctx.docAbs, nextDocText);
  proposals.markReestimate(ctx.root, ctx.slug, '*', 'profile changed');
  return { ok: true };
}

// --- coverage tokens, decided agentically at export time (RC-4) ----

function readConfirmedMap(mapFile) {
  try { return JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch { return null; }
}

/** `tokens({ root, doc, suggest: true })` — `tokens --suggest`. Prints, per fit-back table
 * (contract §4 — every table it lists already has a compliance column's worth of interest, since
 * `intake` only records requirements tables there) with a compliance column, the client's own
 * recorded tokens (and numeric legend, when the column has one) plus `guessCoverageTokenMap`'s
 * heuristic guess: input for the agent's own six-value -> client-token decision, never applied on
 * its own — the agent runs `tokens --file` with its actual choice. Keyed by the fit-back table's
 * own `key` (contract §4 — replacing the old area/sheet name), the same key `tokens --file` expects. */
export function tokensSuggest({ root, doc }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  let mapFile;
  try { mapFile = confirmedMapFileForDoc(ctx.model, ctx.docAbs); } catch (e) { return { ok: false, reason: e.message }; }
  const map = readConfirmedMap(mapFile);
  if (!map) return { ok: false, reason: `no fit-back map for this document; run intake first` };
  const tables = {};
  for (const t of map.tables || []) {
    if (!t.columns?.compliance) continue;
    tables[t.key] = {
      tokens: t.tokens?.compliance || [],
      legend: t.tokens?.complianceLegend || null,
      suggested: guessCoverageTokenMap(t.tokens?.compliance || []),
    };
  }
  return { ok: true, tables };
}

/** A numeric-key legend (T2) resolves a value to the LABEL it stands for, whichever form the
 * agent submitted — the label already IS the client's own token (`tokens.compliance`), and it is
 * what `isNegativeToken` must see (a bare digit is never itself "negative"-reading, but the label
 * it stands for might be) and what gets stored, so `exportText`'s own legend lookup (by label)
 * keeps working. A value that is neither a legend key nor a legend label (a plain client token, or
 * free text when the column has none) passes through unchanged. */
function resolveLegendValue(v, legend) {
  if (Object.prototype.hasOwnProperty.call(legend, v)) return v;                    // already a label
  const label = Object.keys(legend).find(l => String(legend[l]) === v);
  return label ?? v;
}

/** `tokens({ root, doc, data })` — `tokens --file <json>`. `data` is
 * `{ "<table key>": { OOTB, Configuration, Extension, ISV, Custom, "—" } }`, one entry per fit-back
 * table with a compliance column (keyed by the table's own `key`, contract §4, matching `tokens
 * --suggest`'s own keys). Validates, per table: all six keys present; each value (a numeric legend
 * key resolved to its label first, T2) is one of that table's own recorded compliance tokens or
 * legend labels, or free text when the client column carries no token list at all; and never a
 * negative-reading token (`isNegativeToken`, reused from the wizard's own check, T1) — every one of
 * the six values, `—` included, is work the partner delivers (`—` names non-Shopware work, not "we
 * don't offer this"). Writes the resolved `tokens.coverage` into the fit-back map. */
export function tokensApply({ root, doc, data }) {
  const ctx = load(root, doc);
  if (ctx.error) return ctx.error;
  let mapFile;
  try { mapFile = confirmedMapFileForDoc(ctx.model, ctx.docAbs); } catch (e) { return { ok: false, reason: e.message }; }
  const map = readConfirmedMap(mapFile);
  if (!map) return { ok: false, reason: `no fit-back map for this document; run intake first` };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'tokens --file: the JSON body must be an object keyed by table key' };

  const byKey = new Map((map.tables || []).filter(t => t.columns?.compliance).map(t => [t.key, t]));
  const problems = [];
  const resolvedByKey = new Map();
  for (const [key0, values] of Object.entries(data)) {
    const table = byKey.get(key0);
    if (!table) { problems.push(`"${key0}" is not a fit-back table with a compliance column`); continue; }
    if (!values || typeof values !== 'object') { problems.push(`"${key0}": value must be an object`); continue; }
    const missingKeys = COVERAGE_KEYS.filter(k => !Object.prototype.hasOwnProperty.call(values, k));
    if (missingKeys.length) { problems.push(`"${key0}": missing key(s) ${missingKeys.join(', ')}`); continue; }
    const clientTokens = table.tokens?.compliance || [];
    const legend = table.tokens?.complianceLegend || {};
    const resolved = {};
    for (const key of COVERAGE_KEYS) {
      const raw = String(values[key] ?? '').trim();
      if (!raw) { problems.push(`"${key0}": ${key} must not be empty`); continue; }
      const v = resolveLegendValue(raw, legend);
      resolved[key] = v;
      const known = clientTokens.includes(v) || Object.prototype.hasOwnProperty.call(legend, v);
      if (!known && clientTokens.length) problems.push(`"${key0}": ${key} value "${raw}" is not one of the client's own tokens`);
      if (isNegativeToken(v)) problems.push(`"${key0}": ${key} must not map to a negative-reading token ("${raw}"${raw !== v ? ` = "${v}"` : ''})`);
    }
    resolvedByKey.set(key0, resolved);
  }
  if (problems.length) return { ok: false, reason: problems[0], problems };

  const written = [];
  for (const [key0, resolved] of resolvedByKey) {
    const table = byKey.get(key0);
    table.tokens = table.tokens || {};
    table.tokens.coverage = resolved;
    written.push(key0);
  }
  atomicWrite(mapFile, JSON.stringify(map, null, 2) + '\n');
  return { ok: true, tables: written };
}

// ---------------------------------------------------------------------------

/** #11: `--root <dir>` may appear anywhere in argv, as every other command's usage line shows it
 * (bin/cli.mjs) — pulled out here before positional destructuring so it is never mistaken for a
 * statement/id/key argument. */
function extractRootFlag(argv) {
  const rest = [];
  let rootFlag = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') { rootFlag = argv[++i] || ''; continue; }
    rest.push(argv[i]);
  }
  return { argv: rest, rootFlag };
}

export async function main(argv = []) {
  const { argv: cleanArgv, rootFlag } = extractRootFlag(argv);
  const [op, docArg, ...rest] = cleanArgv;
  if (!op || !docArg) {
    out.line('reason', 'usage: <confirm|unconfirm|accept|reject|assume|unassume|answer|patch|profile|tokens|intake-confirm|move|skip|restore|info> <doc> ...');
    process.exitCode = out.EXIT_USAGE;
    return;
  }
  const docAbs = canonical(docArg);
  const root = resolveRoot({ rootFlag, docAbs });
  let result;
  let nextStep = 'run `check --write <doc>` then `report <doc>`';

  if (op === 'confirm') {
    let ids = rest.filter(a => a !== '--all-unconfirmed');
    if (rest.includes('--all-unconfirmed')) {
      if (!fs.existsSync(docAbs)) { out.line('reason', `document not found: ${docArg}`); process.exitCode = out.EXIT_UNREACHABLE; return; }
      const model = parse(fs.readFileSync(docAbs, 'utf8'), { path: docAbs });
      ids = model.items.filter(i => i.status.kind !== 'confirmed').map(i => i.id);
    }
    result = confirm({ root, doc: docAbs, ids });
  } else if (op === 'unconfirm') result = unconfirm({ root, doc: docAbs, ids: rest });
  else if (op === 'accept') result = accept({ root, doc: docAbs, id: rest[0] });
  else if (op === 'reject') result = reject({ root, doc: docAbs, id: rest[0] });
  else if (op === 'assume') result = assume({ root, doc: docAbs, item: rest[0] === 'global' ? null : rest[0], statement: rest[1] });
  else if (op === 'unassume') result = unassume({ root, doc: docAbs, item: rest[0], statement: rest[1] });
  else if (op === 'answer') result = answer({ root, doc: docAbs, cq: rest[0], key: rest[1] });
  else if (op === 'patch') {
    const opts = { id: rest[0] };
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--response') opts.clientResponse = rest[++i];
      else if (rest[i] === '--note') opts.internalNote = rest[++i];
    }
    result = patch({ root, doc: docAbs, ...opts });
  } else if (op === 'profile') {
    const fileIdx = rest.indexOf('--file');
    if (fileIdx < 0) { out.line('reason', 'usage: profile <doc> --file <json>'); process.exitCode = out.EXIT_USAGE; return; }
    let data;
    try { data = JSON.parse(fs.readFileSync(canonical(rest[fileIdx + 1]), 'utf8')); }
    catch (e) { out.line('reason', `cannot read profile json: ${e.message}`); process.exitCode = out.EXIT_UNREACHABLE; return; }
    result = profile({ root, doc: docAbs, data });
  } else if (op === 'tokens') {
    if (rest.includes('--suggest')) {
      result = tokensSuggest({ root, doc: docAbs });
      nextStep = 'decide the six-value -> client-token map per table (coverage-mapping.md), then run `tokens <doc> --file <json>`';
    } else if (rest.includes('--file')) {
      const fileIdx = rest.indexOf('--file');
      let data;
      try { data = JSON.parse(fs.readFileSync(canonical(rest[fileIdx + 1]), 'utf8')); }
      catch (e) { out.line('reason', `cannot read tokens json: ${e.message}`); process.exitCode = out.EXIT_UNREACHABLE; return; }
      result = tokensApply({ root, doc: docAbs, data });
      nextStep = 'run `export <doc>`';
    } else {
      out.line('reason', 'usage: tokens <doc> --suggest | --file <json>');
      process.exitCode = out.EXIT_USAGE;
      return;
    }
  } else if (op === 'intake-confirm') {
    result = intakeConfirm({ root, doc: docAbs });
    nextStep = result?.already
      ? 'already confirmed; work the scope items to confirmed, then `export <doc>`'
      : 'work the scope items to confirmed, then `export <doc>`';
  } else if (op === 'move') {
    const topicIdx = rest.indexOf('--topic');
    const topic = topicIdx >= 0 ? rest[topicIdx + 1] : undefined;
    const positional = topicIdx >= 0 ? rest.slice(0, topicIdx) : rest;
    result = move({ root, doc: docAbs, id: positional[0], tab: positional[1], topic });
  } else if (op === 'skip') {
    result = skip({ root, doc: docAbs, id: rest[0], why: rest[1] });
  } else if (op === 'restore') {
    result = restore({ root, doc: docAbs, source: rest[0] });
  } else if (op === 'info') {
    result = info({ root, doc: docAbs, key: rest[0], value: rest[1] });
  } else {
    out.line('reason', `unknown op ${op}`);
    process.exitCode = out.EXIT_USAGE;
    return;
  }

  if (!result || !result.ok) {
    out.line('reason', result?.reason || 'failed');
    out.nextStep('fix the reason above and retry');
    process.exitCode = out.EXIT_UNREACHABLE;
    return;
  }
  // out.mjs's contract once: key:value lines, then next_step, then the payload last — `result`
  // already carries `ok: true`, so no separate `ok:` line duplicates it.
  out.nextStep(nextStep);
  out.payload(result);
}
