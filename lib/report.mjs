// `report <doc>` — the P-9 run report (nine fields, regime named on the effort figure) and
// `last-run.json`, used next run for "what changed" (added / changed / reopened, with cause).
import fs from 'node:fs';
import path from 'node:path';
import * as out from './out.mjs';
import { canonical, resolveRoot } from './paths.mjs';
import { totals as calcTotals, readiness as calcReadiness, isReady, isNotDecomposed, openQuestions } from './calc.mjs';
import { readProfile, regime as regimeOf } from './profile.mjs';
import { checkReasons, regimeLabel, moneyHits } from './check.mjs';
import { replaceSections, atomicWrite } from './edit.mjs';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') { opts.root = argv[++i]; continue; }
    if (!a.startsWith('--')) opts._.push(a);
  }
  return opts;
}

function lastRunPath(root, slug) { return path.join(root, 'specs', '.rfp', slug, 'last-run.json'); }
// One entry per `apply` since the last `report` (apply.mjs appends, this file reads-and-clears):
// several applies can land between two reports (e.g. a batch of `reestimate` runs), and every
// one of their causes belongs in §8, not just the last.
function lastAppliesPath(root, slug) { return path.join(root, 'specs', '.rfp', slug, 'last-applies.json'); }

function today() { return new Date().toISOString().slice(0, 10); }

/** Appends one line to §8 Log (build contract addendum) — `report`'s own cause/confirmed/
 * reopened/changed line, or `import-export.mjs`'s `export v<n>` line (D-34): both go through this
 * one section writer. Section content otherwise untouched; heading stays "## 8. Log". */
export function appendLogLine(text, blocks, line) {
  const sec = (blocks || []).find(b => b.n === 8);
  // `sec.raw` can carry a leading blank line (parse.mjs only trims the section's own trailing
  // blanks, not a leading one left by the "heading, blank line, content" convention) — trimmed
  // here so it never gets baked into the body and re-appears as a second blank line under the
  // heading on the next write.
  const raw = sec ? sec.raw.trim() : '';
  const body = raw ? `${raw}\n${line}` : line;
  return replaceSections(text, blocks, [[8, body]]);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** `reopened YYYY-MM-DD: <cause>` References entries, in document order. */
function reopenedRefs(item) {
  return (item.references || []).filter(r => /^reopened\s+\d{4}-\d{2}-\d{2}:/.test(r));
}

function snapshotOf(items) {
  const s = {};
  // `reopenedCount` (not just current `status`) is what lets `diffChanges` catch an item that
  // reopened, was re-confirmed, and reopened again entirely between two `report` runs (N-2):
  // its status transition (confirmed -> reopened) looks identical to "still reopened since last
  // time" unless the count of reopened References entries is compared too.
  for (const it of items) s[it.id] = { coverage: it.coverage, effort: it.effort, status: it.status, clientResponse: it.clientResponse, reopenedCount: reopenedRefs(it).length };
  return s;
}

/** Added / changed / reopened item ids since `prevSnapshot` (from the last `last-run.json`). */
export function diffChanges(prevSnapshot, items) {
  const prev = prevSnapshot || {};
  const added = [], changed = [], reopened = [];
  for (const it of items) {
    const before = prev[it.id];
    if (!before) { added.push(it.id); continue; }
    const refs = reopenedRefs(it);
    // Any reopen (§3, R-2, R-3) appends a `reopened <date>: <cause>` reference, so a growth in
    // this count — not just "status is reopened now but was not last time" — is what "reopened
    // since the last report" means; it also survives a reopen -> confirm -> reopen cycle that
    // starts and ends in the same status.kind. `before.reopenedCount` missing (an older
    // last-run.json written before this field existed) is UNKNOWN, never treated as 0 — that
    // would report every already-reopened item as newly reopened. Unknown means no reopened
    // verdict this run; it still falls through to the coverage/effort/response comparison below.
    const knownReopenedCount = typeof before.reopenedCount === 'number';
    if (knownReopenedCount && refs.length > before.reopenedCount) {
      const cause = refs[refs.length - 1];
      reopened.push({ id: it.id, cause: cause ? cause.replace(/^reopened\s+\d{4}-\d{2}-\d{2}:\s*/, '') : null });
      continue;
    }
    if (JSON.stringify(before.coverage) !== JSON.stringify(it.coverage) ||
        JSON.stringify(before.effort) !== JSON.stringify(it.effort) ||
        before.clientResponse !== it.clientResponse) {
      changed.push(it.id);
    }
  }
  return { added, changed, reopened };
}

export async function main(argv = []) {
  const opts = parseArgs(argv);
  const docArg = opts._[0];
  if (!docArg) { out.line('reason', 'usage: report <doc>'); process.exitCode = out.EXIT_USAGE; return; }
  const docAbs = canonical(docArg);
  if (!fs.existsSync(docAbs)) { out.line('reason', `document not found: ${docArg}`); process.exitCode = out.EXIT_UNREACHABLE; return; }
  const root = resolveRoot({ rootFlag: opts.root || '', docAbs });

  // A run report on a document `check` itself rejects is worse than none: refuse first,
  // nothing written to §8 or last-run.json (B).
  const { text, model, reasons } = checkReasons(docAbs, root);
  if (reasons.length) {
    for (const r of reasons) out.line('reason', r);
    out.nextStep('run `check <doc>` for the full list of reasons, fix them, then run report again');
    process.exitCode = out.EXIT_UNREACHABLE;
    return;
  }

  const { profile } = readProfile(root);
  const regimeStr = regimeOf(root);
  const slug = model.slug || path.basename(docAbs).replace(/-analysis\.md$/i, '');
  let proposals = [];
  const proposalsFile = path.join(root, 'specs', '.rfp', slug, 'proposals.json');
  if (fs.existsSync(proposalsFile)) {
    try { proposals = JSON.parse(fs.readFileSync(proposalsFile, 'utf8')); } catch { proposals = []; }
  }

  const t = calcTotals(model.items, { profile });
  const r = calcReadiness(model.items, { proposals, questions: model.questions });
  const state = isReady(model.items) ? 'Ready' : 'In progress';
  const openCqIds = openQuestions(model.questions).map(q => q.id);
  const notDecomposedIds = model.items.filter(it => isNotDecomposed(it, profile)).map(it => it.id);
  const regimeStrLabel = regimeLabel(regimeStr, profile);

  const lastRun = lastRunPath(root, slug);
  let prevSnapshot = null;
  if (fs.existsSync(lastRun)) {
    try { prevSnapshot = JSON.parse(fs.readFileSync(lastRun, 'utf8')).snapshot; } catch { prevSnapshot = null; }
  }
  const changes = diffChanges(prevSnapshot, model.items);

  // P-9: state · confirmed of total · failed · open client questions · not decomposed ·
  // low confidence · estimation by priority with regime · waiting proposals · what changed.
  // `intake: review` (contract §1/§3) is a legacy state now: intake confirms itself, so this only
  // ever prints for an old document from before that change — the analysis fields above still
  // print (they read straight off the model), but the reader needs telling that analysis is
  // queued once `intake-confirm` runs (IN-3: automatically, not a manual `batch --kind analyze`).
  const intakeState = model.frontmatter?.data?.intake;
  if (intakeState === 'review') out.line('intake', 'review — analysis queued once intake-confirm runs');
  out.line('state', state);
  out.line('confirmed', `${r.confirmed} of ${r.total}`);
  out.line('failed', r.failed);
  out.line('open_client_questions', openCqIds.join(', ') || 'none');
  out.line('not_decomposed', notDecomposedIds.join(', ') || 'none');
  out.line('low_confidence', r.lowConfidence);
  out.line('estimation_by_priority', `${t.byPriority.map(p => `${p.key}: ${p.estimatedPd} PD`).join(' · ')} (${regimeStrLabel})`);
  out.line('waiting_proposals', r.waitingProposals);
  out.line('changed', `added ${changes.added.length} · changed ${changes.changed.length} · reopened ${changes.reopened.map(x => x.id).join(', ') || 'none'}`);
  out.nextStep('confirm items under the current filter, or export');

  // §8 Log: one line per `apply` recorded since the last `report` (R-7: the cause is
  // money-scanned before it lands in the document); falls back to one generic "run" line when
  // `report` is run with none on record (e.g. right after `intake`, before any `apply`).
  const lastApplies = lastAppliesPath(root, slug);
  let causes = [];
  if (fs.existsSync(lastApplies)) {
    try { const parsed = JSON.parse(fs.readFileSync(lastApplies, 'utf8')); if (Array.isArray(parsed)) causes = parsed; } catch { /* none */ }
  }
  if (!causes.length) causes = [{ cause: 'run' }];
  const summary = `confirmed ${r.confirmed}/${r.total} · reopened ${changes.reopened.length} · changed ${changes.changed.length}`;
  const badCause = causes.map(c => c.cause).find(c => moneyHits(c).length);
  if (badCause) {
    out.line('reason', `run report: money terms in cause "${badCause}": ${moneyHits(badCause).join(', ')}`);
    out.nextStep('rewrite the cause without money terms, then run report again');
    process.exitCode = out.EXIT_UNREACHABLE;
    return;
  }
  const newLines = causes.map(c => `- ${today()} · ${c.cause || 'run'} · ${summary}`);
  const nextText = appendLogLine(text, model.blocks, newLines.join('\n'));
  if (nextText !== text) atomicWrite(docAbs, nextText);
  writeJson(lastApplies, []);

  writeJson(lastRun, { at: new Date().toISOString(), snapshot: snapshotOf(model.items) });
}
