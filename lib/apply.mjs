// `apply <doc> --report <json>` — writes the architect's report into the working document.
// Build contract §3 (agent report JSON, apply rules), R-2, R-3, L-1…L-6.
import fs from 'node:fs';
import path from 'node:path';
import * as out from './out.mjs';
import { canonical, resolveRoot } from './paths.mjs';
import { parse, COVERAGE_VALUES, SIZES } from './parse.mjs';
import { SCALE, profileFigure } from './calc.mjs';
import { readProfile, regime as regimeOf } from './profile.mjs';
import * as proposals from './proposals.mjs';
import { renderItemsSection, renderQuestionsSection, replaceSections, atomicWrite, setFrontmatterField } from './edit.mjs';
import { amountHits } from './check.mjs';

const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);
const REFERENCE_PREFIX_RE = /^(kb|project|isv|cost):\s*.+/;
const CQ_ID_RE = /^CQ-\d+$/;
const NEW_CQ_RE = /^new:(\d+)$/;
// `—` is not a T-shirt size (`parse.mjs SIZES`) but is the explicit "no effort" selection an
// architect may still send for an OOTB item; the auto-fill (contract §1, D-6) covers the case
// where the field is omitted entirely.
const SIZE_VALUES = new Set([...SIZES, '—']);
// Build contract §3's item shape. An unknown field is refused with a reason, so a typo (or a
// field from a future contract revision) fails loudly instead of being silently dropped; an
// unknown *top-level* report field (e.g. a work package's own bookkeeping) is tolerated.
const KNOWN_ITEM_FIELDS = new Set(['id', 'coverage', 'confidence', 'size', 'pd', 'clientResponse', 'references', 'proposals', 'noProposal', 'blockedBy', 'failed']);
// AQ-2: coverage that is not OOTB and not `—` (Configuration, Extension, ISV, Custom) needs at
// least one proposal or a stated reason it has none — every non-OOTB item gets a chance at a
// PD-saving assumption, instead of that step being optional.
const PROPOSAL_REQUIRED_COVERAGE = new Set(['Configuration', 'Extension', 'ISV', 'Custom']);

function today() { return new Date().toISOString().slice(0, 10); }

function slugFor(model, docAbs) {
  return model.slug || path.basename(docAbs).replace(/-analysis\.md$/i, '');
}

/** `kb:`/`project:`/`isv:`/`cost:` shape (AC-6, D-33): `kb:` needs a real value (never empty or
 * "n/a"); `isv:` needs exactly 4 `·`-separated parts, the last one an http(s) URL; `cost:` is a
 * single line and never states an amount (the amount check applies to it; money words are the
 * architect's own vocabulary there). Returns a reason, or null. */
function referenceProblem(r) {
  const m = REFERENCE_PREFIX_RE.exec(String(r ?? ''));
  if (!m) return `invalid reference "${r}"`;
  const value = String(r).slice(String(r).indexOf(':') + 1).trim();
  if (m[1] === 'kb' && (!value || /^n\/a$/i.test(value))) return `invalid reference "${r}": kb: needs a real value`;
  if (m[1] === 'isv') {
    const parts = value.split('·').map(s => s.trim());
    if (parts.length !== 4 || !/^https?:\/\//.test(parts[3])) {
      return `invalid reference "${r}": isv: needs 4 · separated parts ending in an http(s) URL`;
    }
  }
  if (m[1] === 'cost') {
    if (/\n/.test(String(r))) return `invalid reference "${r}": cost: must be a single line`;
    if (amountHits(value).length) return `invalid reference "${r}": cost: must not state an amount`;
  }
  return null;
}

/** The item's own effort in PD, for the AQ-2 pdSaved cap: this report's own `pd`/`size` if it
 * sends one, else the document's existing effort for that item; `null` when neither states a
 * numeric effort (the cap is then skipped rather than guessed). `size` maps to PD through the
 * T-shirt `SCALE` table (`calc.mjs`); a profile-regime `pd` is scaled the same way `effortFor`
 * scales it into the document (`profileFigure`), so the cap matches the effort the item ends up
 * with, not the raw figure the architect typed. */
function itemEffortPd(regimeStr, profile, it, existing) {
  if (regimeStr === 'profile' && typeof it.pd === 'number') return profileFigure(it.pd, profile);
  if (it.size != null && SCALE[it.size] != null) return SCALE[it.size];
  if (existing && existing.effort && typeof existing.effort.pd === 'number') return existing.effort.pd;
  return null;
}

/** Validates the report against the document (contract §3): returns `[]`, or the reasons.
 * `regimeStr` (the document's regime) gates which of `size`/`pd` an item may carry (D-5). */
export function validateReport(report, model, { regimeStr, profile } = {}) {
  const reasons = [];
  if (!report || typeof report !== 'object') return ['report must be an object'];
  const byId = new Map(model.items.map(it => [it.id, it]));
  const items = Array.isArray(report.items) ? report.items : [];
  if (!Array.isArray(report.items)) reasons.push('report.items must be an array');
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || !byId.has(it.id)) { reasons.push(`report item "${it && it.id}" is not a scope item in this document`); continue; }
    for (const key of Object.keys(it)) if (!KNOWN_ITEM_FIELDS.has(key)) reasons.push(`item ${it.id}: unknown field "${key}"`);
    if (it.coverage != null && !COVERAGE_VALUES.includes(it.coverage)) reasons.push(`item ${it.id}: invalid coverage "${it.coverage}"`);
    if (it.confidence != null && !CONFIDENCE_VALUES.has(it.confidence)) reasons.push(`item ${it.id}: invalid confidence "${it.confidence}"`);
    if (it.size != null && !SIZE_VALUES.has(it.size)) reasons.push(`item ${it.id}: invalid size "${it.size}"`);
    if (it.pd != null && typeof it.pd !== 'number') reasons.push(`item ${it.id}: pd must be a number`);
    if (regimeStr === 'profile' && it.size != null) reasons.push(`item ${it.id}: size is not valid in the profile regime — use pd`);
    if (regimeStr === 'T-shirt' && it.pd != null) reasons.push(`item ${it.id}: pd is not valid in the T-shirt regime — use size`);
    // Only an item this report is actually scoring (it sends a coverage) needs an effort field —
    // a report item that only carries a proposal, a reference or a blockedBy is not re-scoring
    // anything and must not be forced to repeat the effort it already has (contract §3).
    if (!it.failed && it.coverage != null && it.coverage !== 'OOTB' && it.size == null && it.pd == null) {
      reasons.push(`item ${it.id}: needs size or pd`);
    }
    for (const r of it.references || []) { const p = referenceProblem(r); if (p) reasons.push(`item ${it.id}: ${p}`); }
    // D-33: at most one cost: reference per item, counting the document's existing one alongside
    // whatever this report adds.
    const existingForCost = byId.get(it.id);
    const combinedCostRefs = [...(existingForCost.references || []), ...(it.references || [])].filter(r => /^cost:/.test(r));
    if (combinedCostRefs.length > 1) reasons.push(`item ${it.id}: at most one cost: reference`);
    // AC-6: a scored item (coverage set, not `—`, not failed) needs at least one kb:/project:/isv:
    // reference; an ISV item needs an isv: one specifically. "Scored" looks at the coverage this
    // report leaves the item with, and references combine the document's existing ones with the
    // ones this report adds — an item scored earlier and referenced then does not need to repeat
    // the reference on every later report that merely touches it.
    if (!it.failed) {
      const existing = byId.get(it.id);
      const finalCoverage = it.coverage != null ? it.coverage : existing.coverage;
      if (finalCoverage && finalCoverage !== '—') {
        const combinedRefs = [...(existing.references || []), ...(it.references || [])];
        if (!combinedRefs.some(r => /^isv:/.test(r)) && finalCoverage === 'ISV') {
          reasons.push(`item ${it.id}: coverage ISV needs an isv: reference (AC-6)`);
        } else if (!combinedRefs.some(r => /^(kb|project|isv):/.test(r))) {
          reasons.push(`item ${it.id}: coverage ${finalCoverage} needs a kb:, project: or isv: reference (AC-6)`);
        }
      }
    }
    // AQ-2: only an item this report is actually scoring (it sends a coverage) is held to this —
    // a later report that merely touches an already-scored item (a reference, a confidence tweak)
    // does not need to repeat the proposal, same scoping as "needs size or pd" above.
    if (!it.failed && it.coverage != null && PROPOSAL_REQUIRED_COVERAGE.has(it.coverage)) {
      const hasProposal = Array.isArray(it.proposals) && it.proposals.length > 0;
      const hasNoProposal = typeof it.noProposal === 'string' && it.noProposal.trim().length > 0;
      // A suggestion is mandatory for every estimated item: `noProposal` is only accepted when the
      // item already carries an accepted assumption that locks its scope — an item with nothing
      // shrinking it yet must get a proposal, not a reason to skip one.
      const existingAssumptions = byId.get(it.id).assumptions || [];
      if (!hasProposal && !hasNoProposal) {
        reasons.push(`item ${it.id}: coverage ${it.coverage} needs at least one proposal or a noProposal reason (AQ-2)`);
      } else if (!hasProposal && hasNoProposal && !existingAssumptions.length) {
        reasons.push(`item ${it.id}: noProposal is only valid when the item already has an accepted assumption covering it (AQ-2)`);
      }
    }
    if (it.blockedBy != null && !CQ_ID_RE.test(it.blockedBy) && !NEW_CQ_RE.test(it.blockedBy)) reasons.push(`item ${it.id}: invalid blockedBy "${it.blockedBy}"`);
    if (it.blockedBy && NEW_CQ_RE.test(it.blockedBy)) {
      const idx = Number(NEW_CQ_RE.exec(it.blockedBy)[1]);
      if (!(report.questions || [])[idx]) reasons.push(`item ${it.id}: blockedBy "new:${idx}" has no matching questions[${idx}]`);
    }
    // A proposal without a numeric, positive pdSaved is refused rather than accepted with a
    // savings figure the page cannot show (it renders "saves — PD" instead of the real number).
    // AQ-2: a proposal cannot claim to save more PD than the item costs — when the item's own
    // effort is known (this report's own size/pd, else the document's existing effort), pdSaved
    // is capped at it.
    for (const p of it.proposals || []) {
      if (typeof p.pdSaved !== 'number' || !Number.isFinite(p.pdSaved) || p.pdSaved <= 0) {
        reasons.push(`item ${it.id}: proposal pdSaved must be a number > 0 (AQ-2)`);
        continue;
      }
      const itemPd = itemEffortPd(regimeStr, profile, it, byId.get(it.id));
      if (itemPd != null && p.pdSaved > itemPd) {
        reasons.push(`item ${it.id}: proposal pdSaved (${p.pdSaved}) exceeds the item's effort (${itemPd} PD) (AQ-2)`);
      }
    }
  }
  for (const p of report.globalProposals || []) {
    if (typeof p.pdSaved !== 'number' || !Number.isFinite(p.pdSaved) || p.pdSaved <= 0) {
      reasons.push(`global proposal: pdSaved must be a number > 0 (AQ-2)`);
    }
  }
  (report.questions || []).forEach((q, i) => {
    if (!Array.isArray(q.items) || !q.items.length) reasons.push(`questions[${i}]: items required`);
    if (!q.question) reasons.push(`questions[${i}]: question required`);
    if (!Array.isArray(q.options) || q.options.length < 2) reasons.push(`questions[${i}]: needs at least two options`);
    for (const o of q.options || []) if (!o.effect) reasons.push(`questions[${i}]: option ${o.key} needs a non-empty effect`);
    if (!q.fallback || !(Array.isArray(q.options) && q.options.some(o => o.key === q.fallback))) reasons.push(`questions[${i}]: fallback must be one of its options`);
  });
  return reasons;
}

/** `effCoverage` is the item's coverage after this report is applied — OOTB auto-fills the
 * effort (contract §1, D-6) when the architect sent neither `size` nor `pd`. */
function effortFor(regimeStr, profile, ri, existing, effCoverage) {
  if (regimeStr === 'profile') {
    if (typeof ri.pd === 'number') return { size: null, pd: profileFigure(ri.pd, profile), regime: 'profile' };
    if (effCoverage === 'OOTB') return { size: null, pd: 0, regime: 'profile' };
    return existing;
  }
  if (ri.size) return { size: ri.size, pd: SCALE[ri.size] ?? null, regime: 'T-shirt' };
  if (effCoverage === 'OOTB') return { size: '—', pd: 0, regime: 'T-shirt' };
  return existing;
}

// #9: compares the PD figure only — `size` is just the T-shirt regime's own label for it and a
// profile-regime effort never carries one (`size: null`), so comparing `size` too would report a
// reopen on every regime switch even when the PD itself is unchanged (0 -> 0, 4 -> 4).
function effortEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.pd === b.pd;
}

/**
 * `apply({ root, doc, report })` — writes §4/§5 per the report and every rule in contract §3.
 * Returns `{ ok: true, written: [ids] }` or `{ ok: false, reason, reasons? }`.
 */
export function apply({ root, doc, report }) {
  const docAbs = canonical(doc, root || process.cwd());
  if (!fs.existsSync(docAbs)) return { ok: false, reason: `document not found: ${doc}` };
  const rootDir = root || resolveRoot({ docAbs });
  const text = fs.readFileSync(docAbs, 'utf8');
  const model = parse(text, { path: docAbs });
  if (model.errors.length) return { ok: false, reason: `document does not parse: ${model.errors[0]}`, reasons: model.errors };

  const slug = slugFor(model, docAbs);
  const { profile } = readProfile(rootDir);
  const regimeStr = regimeOf(rootDir);
  const cause = report.cause || 'apply';

  const reasons = validateReport(report, model, { regimeStr, profile });
  if (reasons.length) return { ok: false, reason: reasons[0], reasons };

  // New CQs first, so items can reference `new:<index>` by the id just minted.
  let nextCq = 1 + model.questions.filter(q => q.kind === 'cq').reduce((m, q) => Math.max(m, Number(q.id.split('-')[1]) || 0), 0);
  const newCqIds = [];   // ids minted by this apply
  const cqRefs = [];     // id for each report question, minted or reused
  const questions = model.questions.map(q => ({ ...q, items: [...q.items] }));
  const normQ = t => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();
  for (const rq of report.questions || []) {
    // Idempotent: an existing cq question with the same normalised text and an overlapping item
    // set is reused (new item ids unioned in), never duplicated.
    const same = questions.find(q => q.kind === 'cq' && normQ(q.question) === normQ(rq.question) && q.items.some(i => rq.items.includes(i)));
    if (same) {
      for (const i of rq.items) if (!same.items.includes(i)) same.items.push(i);
      cqRefs.push(same.id);
      continue;
    }
    const id = `CQ-${nextCq++}`;
    newCqIds.push(id);
    cqRefs.push(id);
    questions.push({ id, kind: 'cq', items: [...rq.items], question: rq.question, options: rq.options.map(o => ({ key: o.key, text: o.text, effect: o.effect, checked: false })), fallback: rq.fallback, answered: null });
  }

  const byId = new Map(model.items.map(it => [it.id, it]));
  const written = [];

  for (const ri of report.items || []) {
    const item = byId.get(ri.id);
    const wasConfirmed = item.status.kind === 'confirmed';
    const wasReopened = item.status.kind === 'reopened';
    const beforeCoverage = item.coverage, beforeEffort = item.effort, beforeResponse = item.clientResponse;

    if (ri.failed) {
      item.status = { kind: 'failed', date: null, cq: null };
      item.references = [...item.references, `failed: ${ri.failed}`];
      written.push(item.id);
      continue;
    }

    if (ri.coverage != null) item.coverage = ri.coverage;
    if (ri.confidence != null) item.confidence = ri.confidence;
    const newEffort = effortFor(regimeStr, profile, ri, item.effort, item.coverage);

    // A re-report that repeats a reference the item already carries (e.g. the same `kb:` line
    // reported again across two runs) must not pile up a duplicate — dedupe against what the item
    // already has, and within the report's own list, keeping the first occurrence's order.
    if (Array.isArray(ri.references) && ri.references.length) {
      const seen = new Set(item.references);
      const additions = [];
      for (const r of ri.references) { if (!seen.has(r)) { seen.add(r); additions.push(r); } }
      if (additions.length) item.references = [...item.references, ...additions];
    }

    for (const p of ri.proposals || []) proposals.add(rootDir, slug, { item: item.id, statement: p.statement, pdSaved: p.pdSaved, run: cause });

    // Client Response: written straight when empty or the item is not confirmed/reopened;
    // for a confirmed/reopened item with existing text, a differing draft goes to References
    // and reopens instead of overwriting the operator's text (contract §3).
    let newResponse = item.clientResponse;
    let draftRef = null;
    if (ri.clientResponse != null) {
      const locked = (wasConfirmed || wasReopened) && item.clientResponse;
      if (!locked) newResponse = ri.clientResponse;
      else if (ri.clientResponse !== item.clientResponse) draftRef = `draft: ${ri.clientResponse}`;
    }

    const coverageChanged = beforeCoverage !== (ri.coverage != null ? ri.coverage : beforeCoverage);
    const effortChanged = !effortEqual(beforeEffort, newEffort);
    const responseChanged = draftRef != null;
    const substantive = coverageChanged || effortChanged || responseChanged;

    item.effort = newEffort;
    item.clientResponse = newResponse;
    if (draftRef) item.references = [...item.references, draftRef];

    if (ri.blockedBy) {
      const isNewCq = NEW_CQ_RE.test(ri.blockedBy);
      const cqId = isNewCq ? cqRefs[Number(NEW_CQ_RE.exec(ri.blockedBy)[1])] : ri.blockedBy;
      // #2: a confirmed/reopened item re-reported under the SAME CQ it was already blocked by
      // (and later confirmed under, e.g. via the fallback), with nothing substantive changed, is
      // not a new block — it stays confirmed/reopened, no reference, no re-blocking (contract §3).
      const targetQ = questions.find(q => q.id === cqId);
      const existingQ = !isNewCq && targetQ;
      const sameKnownBlock = existingQ && existingQ.items.includes(item.id);
      if (targetQ && !targetQ.items.includes(item.id)) targetQ.items.push(item.id);
      if (targetQ && targetQ.answered) {
        // Already answered: never re-block the item on it; status follows the non-blocked path.
        if (wasConfirmed || wasReopened) { if (substantive) { item.status = { kind: 'reopened', date: null, cq: null }; item.references = [...item.references, `reopened ${today()}: ${cause}`]; } }
        else item.status = { kind: 'estimated', date: null, cq: null };
      } else if ((wasConfirmed || wasReopened) && sameKnownBlock && !substantive) {
        // stays confirmed / stays reopened — status object already correct.
      } else {
        // A confirmed/reopened item that gets a NEW block is never silently replaced (L-3): the
        // audit trail records it exactly like any other reopen, before the block itself lands.
        if (wasConfirmed || wasReopened) item.references = [...item.references, `reopened ${today()}: blocked by ${cqId}`];
        item.status = { kind: 'blocked', date: null, cq: cqId };
      }
    } else if (wasConfirmed || wasReopened) {
      if (substantive) {
        item.status = { kind: 'reopened', date: null, cq: null };
        item.references = [...item.references, `reopened ${today()}: ${cause}`];
      }
      // else: stays confirmed / stays reopened (contract §3), status object already correct.
    } else {
      item.status = { kind: 'estimated', date: null, cq: null };
    }
    written.push(item.id);
  }

  for (const p of report.globalProposals || []) proposals.add(rootDir, slug, { item: null, statement: p.statement, pdSaved: p.pdSaved, run: cause });

  proposals.clearReestimate(rootDir, slug, written, model.items.map(it => it.id));

  let nextText = replaceSections(text, model.blocks, [
    [4, renderItemsSection(model.items)],
    [5, renderQuestionsSection(questions)],
  ]);
  // Frontmatter `regime` follows the profile file, not the other way round (D-4): `apply`
  // keeps it true rather than letting it drift and failing `check` on the next run.
  nextText = setFrontmatterField(nextText, 'regime', regimeStr);
  atomicWrite(docAbs, nextText);
  writeLastCause(rootDir, slug, cause);
  return { ok: true, written, questions: newCqIds };
}

/** `report`'s §7 line names the cause of every run it is reporting on; several `apply`s can land
 * between two `report`s (e.g. a batch of `reestimate` runs), so this appends rather than
 * overwrites — `report` reads and clears the whole list. */
function writeLastCause(root, slug, cause) {
  const file = path.join(root, 'specs', '.rfp', slug, 'last-applies.json');
  let causes = [];
  try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(parsed)) causes = parsed; } catch { /* none yet */ }
  causes.push({ cause, at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(causes, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') { opts.report = argv[++i]; continue; }
    if (a === '--root') { opts.root = argv[++i]; continue; }
    if (!a.startsWith('--')) opts._.push(a);
  }
  return opts;
}

export async function main(argv = []) {
  const opts = parseArgs(argv);
  const docArg = opts._[0];
  if (!docArg || !opts.report) { out.line('reason', 'usage: apply <doc> --report <json>'); process.exitCode = out.EXIT_USAGE; return; }
  const docAbs = canonical(docArg);
  const root = resolveRoot({ rootFlag: opts.root || '', docAbs });
  let report;
  try { report = JSON.parse(fs.readFileSync(canonical(opts.report), 'utf8')); }
  catch (e) { out.line('reason', `cannot read report: ${e.message}`); process.exitCode = out.EXIT_UNREACHABLE; return; }

  const result = apply({ root, doc: docAbs, report });
  if (!result.ok) {
    // `result.reasons`, when present, already carries `result.reason` as its first entry
    // (`apply()` sets `reason: reasons[0]`) — print the list once, never the reason on top of it.
    if (result.reasons && result.reasons.length) {
      for (const r of result.reasons) out.line('reason', r);
    } else {
      out.line('reason', result.reason);
    }
    out.nextStep('fix the report, then run apply again');
    process.exitCode = out.EXIT_UNREACHABLE;
    return;
  }
  out.line('written', result.written.join(', ') || 'none');
  if (result.questions.length) out.line('new_questions', result.questions.join(', '));
  out.nextStep('run `check --write <doc>` then `report <doc>`');
}
