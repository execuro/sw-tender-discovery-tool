import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, diffChanges } from '../lib/report.mjs';
import { renderTotals } from '../lib/check.mjs';
import { parse } from '../lib/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW_FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), 'utf8');

/** `report` refuses a document `check` would refuse (B) — every fixture here carries totals
 * that already match, exactly as `check --write` would have left them. */
function withTotals(text) {
  const model = parse(text);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  return text.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
}

const FIXTURE = withTotals(RAW_FIXTURE);

function host(docContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-report-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // so path resolution finds this as the root
  const doc = path.join(root, 'specs', 'rfp-0101-xlsx-ids-analysis.md');
  fs.writeFileSync(doc, docContent, 'utf8');
  return { root, doc, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function runMain(argv) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = c => { chunks.push(String(c)); return true; };
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(argv);
    return { out: chunks.join(''), code: process.exitCode ?? 0 };
  } finally {
    process.stdout.write = orig;
    process.exitCode = origExit;
  }
}

test('P-9: the nine run-report fields', async () => {
  const h = host(FIXTURE);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /^intake:/m);
    assert.match(r.out, /^state: In progress$/m);
    assert.match(r.out, /^confirmed: 1 of 4$/m);
    assert.match(r.out, /^failed: 1$/m);
    assert.match(r.out, /^open_client_questions: CQ-1$/m);
    assert.match(r.out, /^not_decomposed: none$/m);
    assert.match(r.out, /^low_confidence: 1$/m);
    assert.match(r.out, /^estimation_by_priority: .*\(T-shirt, default scale, before overhead and buffer\)$/m);
    assert.match(r.out, /^waiting_proposals: 0$/m);
    assert.match(r.out, /^changed: added 4/m); // first run: every item is "added"
    assert.ok(fs.existsSync(path.join(h.root, 'specs', '.rfp', 'rfp-0101-xlsx-ids', 'last-run.json')));
  } finally { h.cleanup(); }
});

test('report prints the intake state for an old document still in review (backward compatibility)', async () => {
  const inReview = FIXTURE.replace('regime: T-shirt\n', 'regime: T-shirt\nintake: review\n');
  const h = host(inReview);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^intake: review — analysis queued once intake-confirm runs$/m);
  } finally { h.cleanup(); }
});

test('report writes last-run.json, and the next run reports "changed" from it', async () => {
  const h = host(FIXTURE);
  try {
    await runMain([h.doc]);
    const changed = withTotals(RAW_FIXTURE.replace('| estimated |', '| confirmed 2026-09-03 |'));
    fs.writeFileSync(h.doc, changed, 'utf8');
    const r = await runMain([h.doc]);
    assert.match(r.out, /^changed: added 0 · changed 0 · reopened none$/m);
    assert.match(r.out, /^confirmed: 2 of 4$/m);
  } finally { h.cleanup(); }
});

test('report appends one §8 Log line per run, cause "run" when no apply is on record', async () => {
  const h = host(FIXTURE);
  try {
    await runMain([h.doc]);
    const text = fs.readFileSync(h.doc, 'utf8');
    assert.match(text, /## 8\. Log\n\n- \d{4}-\d{2}-\d{2} · run · confirmed 1\/4 · reopened 0 · changed 0/);
  } finally { h.cleanup(); }
});

test('report takes the §8 Log causes from every apply recorded since the last report, then clears them', async () => {
  const h = host(FIXTURE);
  const lastApplies = path.join(h.root, 'specs', '.rfp', 'rfp-0101-xlsx-ids', 'last-applies.json');
  try {
    fs.mkdirSync(path.dirname(lastApplies), { recursive: true });
    // Two `apply` runs landed between reports (a reestimate batch) — both causes must appear.
    fs.writeFileSync(lastApplies, JSON.stringify([{ cause: 'analyze group 1' }, { cause: 'analyze group 2' }]));
    await runMain([h.doc]);
    const text = fs.readFileSync(h.doc, 'utf8');
    assert.match(text, /^- \d{4}-\d{2}-\d{2} · analyze group 1 · .+$/m);
    assert.match(text, /^- \d{4}-\d{2}-\d{2} · analyze group 2 · .+$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(lastApplies, 'utf8')), [], 'causes are cleared once reported');

    // A second report with nothing new to say falls back to one generic "run" line.
    await runMain([h.doc]);
    const text2 = fs.readFileSync(h.doc, 'utf8');
    assert.match(text2, /^- \d{4}-\d{2}-\d{2} · run · .+$/m);
  } finally { h.cleanup(); }
});

test('a second §8 Log append never leaves two blank lines under the heading', async () => {
  const h = host(FIXTURE);
  try {
    await runMain([h.doc]);
    await runMain([h.doc]);
    const text = fs.readFileSync(h.doc, 'utf8');
    assert.doesNotMatch(text, /## 8\. Log\n\n\n/, `expected one blank line after the heading, got:\n${text.slice(text.indexOf('## 8. Log'))}`);
    const logLines = text.split('\n').filter(l => /^- \d{4}-\d{2}-\d{2} · run ·/.test(l));
    assert.equal(logLines.length, 2, 'both run lines must still be recorded');
  } finally { h.cleanup(); }
});

test('report refuses (nothing written) when the cause of an apply since the last report carries a money term', async () => {
  const h = host(FIXTURE);
  const lastApplies = path.join(h.root, 'specs', '.rfp', 'rfp-0101-xlsx-ids', 'last-applies.json');
  try {
    fs.mkdirSync(path.dirname(lastApplies), { recursive: true });
    fs.writeFileSync(lastApplies, JSON.stringify([{ cause: 'the client asked about the price' }]));
    const before = fs.readFileSync(h.doc, 'utf8');
    const r = await runMain([h.doc]);
    assert.equal(r.code, 1);
    assert.match(r.out, /money term/);
    assert.equal(fs.readFileSync(h.doc, 'utf8'), before, 'nothing written to §8 on refusal');
  } finally { h.cleanup(); }
});

test('report refuses (nothing written to §8 or last-run.json) when `check` would fail on the document', async () => {
  const bad = withTotals(RAW_FIXTURE).replace('Confirmed 1 of 4', 'Confirmed 4 of 4');
  const h = host(bad);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 1);
    assert.match(r.out, /do not match the recomputed totals/);
    assert.ok(!fs.existsSync(path.join(h.root, 'specs', '.rfp', 'rfp-0101-xlsx-ids', 'last-run.json')));
  } finally { h.cleanup(); }
});

test('diffChanges: added, changed and reopened (with cause)', () => {
  const prev = { A: { coverage: 'OOTB', effort: null, status: { kind: 'estimated' }, clientResponse: 'x', reopenedCount: 0 } };
  const items = [
    { id: 'A', coverage: 'OOTB', effort: null, status: { kind: 'reopened' }, clientResponse: 'x', references: ['reopened 2026-09-01: profile change re-estimated the effort'] },
    { id: 'B', coverage: 'Extension', effort: { pd: 4 }, status: { kind: 'estimated' }, clientResponse: 'y', references: [] },
  ];
  const d = diffChanges(prev, items);
  assert.deepEqual(d.added, ['B']);
  assert.deepEqual(d.reopened, [{ id: 'A', cause: 'profile change re-estimated the effort' }]);
  assert.deepEqual(d.changed, []);
});

test('N-2: diffChanges catches reopened -> confirmed -> reopened again between two reports, even though status.kind matches the last snapshot', () => {
  const prev = {
    // last-run.json snapshot taken while A was already reopened once.
    A: { coverage: 'OOTB', effort: null, status: { kind: 'reopened' }, clientResponse: 'x', reopenedCount: 1 },
  };
  const items = [
    // Since that snapshot: A was confirmed, then reopened a second time — status.kind is
    // 'reopened' in both the snapshot and now, and coverage/effort/clientResponse never changed,
    // so only the growth in reopened References entries reveals the second reopen.
    {
      id: 'A', coverage: 'OOTB', effort: null, status: { kind: 'reopened' }, clientResponse: 'x',
      references: ['reopened 2026-09-01: profile change re-estimated the effort', 'reopened 2026-09-10: assumption P-4 accepted'],
    },
  ];
  const d = diffChanges(prev, items);
  assert.deepEqual(d.reopened, [{ id: 'A', cause: 'assumption P-4 accepted' }]);
  assert.deepEqual(d.changed, []);
});

test('T4: a last-run.json snapshot missing reopenedCount (an older format) is UNKNOWN — never treated as 0, so an already-reopened item is not reported as newly reopened', () => {
  const prev = {
    // No `reopenedCount` field at all — an older last-run.json written before it existed.
    A: { coverage: 'OOTB', effort: null, status: { kind: 'reopened' }, clientResponse: 'x' },
  };
  const items = [
    { id: 'A', coverage: 'OOTB', effort: null, status: { kind: 'reopened' }, clientResponse: 'x', references: ['reopened 2026-09-01: profile change re-estimated the effort'] },
  ];
  const d = diffChanges(prev, items);
  assert.deepEqual(d.reopened, [], 'unknown prior reopenedCount must not be treated as 0');
  assert.deepEqual(d.added, []);
});

test('a grammar error fails with reasons and points to `check`', async () => {
  const bad = FIXTURE.replace('| Custom | low |', '| Bespoke | low |');
  const h = host(bad);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 1);
    assert.match(r.out, /invalid Requirement Coverage/);
  } finally { h.cleanup(); }
});
