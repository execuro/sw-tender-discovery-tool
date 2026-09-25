import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, validateReport } from '../lib/apply.mjs';
import { confirm } from '../lib/ops.mjs';
import { parse, ITEM_HEADER_LINE } from '../lib/parse.mjs';
import * as proposals from '../lib/proposals.mjs';
import { runSync } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), 'utf8');

function host(docContent = FIXTURE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-apply-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const doc = path.join(root, 'specs', 'rfp-0101-xlsx-ids-analysis.md');
  fs.writeFileSync(doc, docContent, 'utf8');
  return { root, doc, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function docModel(doc) { return parse(fs.readFileSync(doc, 'utf8'), { path: doc }); }

test('AC-5: apply refuses an invalid Requirement Coverage with a reason', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Bespoke' }] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /invalid coverage/);
  } finally { cleanup(); }
});

test('apply refuses an unknown item field with a reason', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { items: [{ id: 'HIB-03', coverage: 'OOTB', bogusField: 1 }] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /unknown field "bogusField"/);
  } finally { cleanup(); }
});

test('apply tolerates an unknown top-level report field', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'OOTB', references: ['kb: Some feature'] }], someWorkPackageBookkeeping: { anything: true } } });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { cleanup(); }
});

test('apply refuses an item id that is not in the document', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { items: [{ id: 'NOPE-1', coverage: 'OOTB' }] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a scope item/);
  } finally { cleanup(); }
});

test('apply: T-shirt regime writes the Effort cell and moves queued/estimated items forward', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'analyze', items: [
      { id: 'HIB-03', coverage: 'Configuration', confidence: 'medium', size: 'S', clientResponse: 'We configure a Rule.', references: ['project: Admin Rule Builder setup'], proposals: [{ statement: 'Client accepts the default Rule Builder conditions.', pdSaved: 0.5 }] },
    ] } });
    assert.equal(r.ok, true);
    const model = docModel(doc);
    const it = model.items.find(i => i.id === 'HIB-03');
    assert.equal(it.coverage, 'Configuration');
    assert.equal(it.effort.pd, 1.5);
    assert.equal(it.status.kind, 'estimated');
    assert.equal(it.clientResponse, 'We configure a Rule.');
  } finally { cleanup(); }
});

test('a failed item keeps its other fields and gets a failed: reference', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-02', failed: 'agent could not reach the KB' }] } });
    const it = docModel(doc).items.find(i => i.id === 'HIB-02');
    assert.equal(it.status.kind, 'failed');
    assert.equal(it.coverage, 'Extension', 'other fields kept');
    assert.ok(it.references.includes('failed: agent could not reach the KB'));
  } finally { cleanup(); }
});

test('AC-8/AC-11/L-3: a confirmed item whose Effort changes is reopened, with the cause in References', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'CQ-1 answered B', items: [{ id: 'HIB-01', size: 'S' } ] } });
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.status.kind, 'reopened');
    assert.ok(it.references.some(r => /^reopened \d{4}-\d{2}-\d{2}: CQ-1 answered B$/.test(r)));
  } finally { cleanup(); }
});

test('an unchanged confirmed item stays confirmed', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-01', coverage: 'OOTB', confidence: 'high' }] } });
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.status.kind, 'confirmed');
  } finally { cleanup(); }
});

test('draft rule: a differing Client Response on a confirmed item reopens it and keeps the operator text, drafting to References', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'reanalyse', items: [{ id: 'HIB-01', clientResponse: 'A brand-new draft.' }] } });
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.status.kind, 'reopened');
    assert.equal(it.clientResponse, 'Stock Shopware customer accounts cover this out of the box.', 'operator text is kept');
    assert.ok(it.references.includes('draft: A brand-new draft.'));
  } finally { cleanup(); }
});

test('a blocked item gets the fallback effort and references its CQ; a new CQ is numbered after the existing ones', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [
      { id: 'CMP-01', coverage: 'Custom', confidence: 'low', size: 'S', blockedBy: 'new:0', references: ['project: retention purge job'], proposals: [{ statement: 'Client accepts a 5-year retention period instead of 7.', pdSaved: 1 }] },
    ], questions: [
      { items: ['CMP-01'], question: 'Is a 7-year retention mandatory?', options: [{ key: 'A', text: 'yes', effect: 'custom archive' }, { key: 'B', text: 'no', effect: 'stock log suffices' }], fallback: 'B' },
    ] } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.questions, ['CQ-2']);
    const model = docModel(doc);
    const it = model.items.find(i => i.id === 'CMP-01');
    assert.equal(it.status.kind, 'blocked');
    assert.equal(it.status.cq, 'CQ-2');
    assert.equal(it.effort.pd, 1.5, 'AC-10: the blocked item carries the fallback option\'s effort');
    const cq2 = model.questions.find(q => q.id === 'CQ-2');
    assert.ok(cq2 && cq2.options.length === 2);
  } finally { cleanup(); }
});

test('#4: re-reporting the same blockedBy on an already-blocked item, with unchanged effort/coverage/response, adds no second reopened reference', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-01', blockedBy: 'new:0' },
    ], questions: [
      { items: ['HIB-01'], question: 'Does the client need SSO?', options: [{ key: 'A', text: 'yes', effect: '+2 PD' }, { key: 'B', text: 'no', effect: 'no change' }], fallback: 'A' },
    ] } });
    const after1 = docModel(doc).items.find(i => i.id === 'HIB-01');
    const refCount1 = after1.references.length;
    assert.equal(after1.status.kind, 'blocked');

    // Re-reported with the SAME (now-existing) CQ id, no coverage/size/response sent — nothing
    // substantive changed.
    apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-01', blockedBy: after1.status.cq }] } });
    const after2 = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(after2.status.kind, 'blocked');
    assert.equal(after2.status.cq, after1.status.cq);
    assert.equal(after2.references.length, refCount1, 'no duplicate reopened reference from re-reporting the same block');
  } finally { cleanup(); }
});

test('L-3: blockedBy on a confirmed item applies the block but records reopened <date>: blocked by CQ-n, not a silent status replacement', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-01', blockedBy: 'new:0' },
    ], questions: [
      { items: ['HIB-01'], question: 'Does the client need SSO?', options: [{ key: 'A', text: 'yes', effect: '+2 PD' }, { key: 'B', text: 'no', effect: 'no change' }], fallback: 'A' },
    ] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.status.kind, 'blocked');
    assert.ok(it.references.some(ref => /^reopened \d{4}-\d{2}-\d{2}: blocked by CQ-2$/.test(ref)));
  } finally { cleanup(); }
});

test('#2: a confirmed item re-reported blocked by the SAME CQ it was confirmed under, with nothing substantive changed, stays confirmed with no new reference', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-01', blockedBy: 'new:0' },
    ], questions: [
      { items: ['HIB-01'], question: 'Does the client need SSO?', options: [{ key: 'A', text: 'yes', effect: '+2 PD' }, { key: 'B', text: 'no', effect: 'no change' }], fallback: 'A' },
    ] } });
    const blocked = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(blocked.status.kind, 'blocked');
    const cqId = blocked.status.cq;

    // Operator confirms the item as-is (accepting the fallback effort) — a normal confirm.
    confirm({ root, doc, ids: ['HIB-01'] });
    const confirmedModel = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(confirmedModel.status.kind, 'confirmed');
    const refCount = confirmedModel.references.length;

    // Re-reported by the architect with the SAME CQ, identical coverage/effort/clientResponse.
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-01', blockedBy: cqId }] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(after.status.kind, 'confirmed', 'stays confirmed — same known block, nothing substantive changed');
    assert.equal(after.references.length, refCount, 'no reopened reference added');
  } finally { cleanup(); }
});

test('#2: a confirmed item re-reported blocked by a NEW/different CQ reopens (L-3 still applies)', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-01', blockedBy: 'new:0' },
    ], questions: [
      { items: ['HIB-01'], question: 'Does the client need SSO?', options: [{ key: 'A', text: 'yes', effect: '+2 PD' }, { key: 'B', text: 'no', effect: 'no change' }], fallback: 'A' },
    ] } });
    confirm({ root, doc, ids: ['HIB-01'] });

    const r = apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-01', blockedBy: 'new:0' },
    ], questions: [
      { items: ['HIB-01'], question: 'Does the client need MFA too?', options: [{ key: 'A', text: 'yes', effect: '+1 PD' }, { key: 'B', text: 'no', effect: 'no change' }], fallback: 'A' },
    ] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(after.status.kind, 'blocked');
    assert.ok(after.references.some(ref => /^reopened \d{4}-\d{2}-\d{2}: blocked by CQ-3$/.test(ref)));
  } finally { cleanup(); }
});

test('D-5: apply refuses size in the profile regime, pd in the T-shirt regime, and neither on a non-OOTB, non-failed item being scored', () => {
  const { root, doc, cleanup } = host();
  try {
    const rNeither = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Extension' }] } });
    assert.equal(rNeither.ok, false);
    assert.match(rNeither.reason, /needs size or pd/);

    const rPdInTshirt = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Extension', pd: 4 }] } });
    assert.equal(rPdInTshirt.ok, false);
    assert.match(rPdInTshirt.reason, /pd is not valid in the T-shirt regime/);
  } finally { cleanup(); }
});

test('D-5: apply refuses size in the profile regime', () => {
  const { root, doc, cleanup } = host();
  try {
    fs.mkdirSync(path.dirname(path.join(root, 'specs', 'rfp-partner-profile.md')), { recursive: true });
    fs.writeFileSync(path.join(root, 'specs', 'rfp-partner-profile.md'),
      '---\ncalibration: { small: 2, big: 20 }\noverhead: 10\nbuffer: { percent: 5, mode: folded }\nisv: []\nassets: []\n---\n');
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Extension', size: 'S' }] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /size is not valid in the profile regime/);
  } finally { cleanup(); }
});

test('D-6: OOTB coverage auto-fills the effort — — (0 PD) in T-shirt, 0 PD in profile — with neither size nor pd sent', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'OOTB', references: ['kb: Some feature'] }] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const it = docModel(doc).items.find(i => i.id === 'HIB-03');
    assert.equal(it.effort.size, '—');
    assert.equal(it.effort.pd, 0);
  } finally { cleanup(); }
});

test('D-6 (profile regime): OOTB coverage auto-fills 0 PD with no pd sent', () => {
  const { root, doc, cleanup } = host();
  try {
    fs.mkdirSync(path.dirname(path.join(root, 'specs', 'rfp-partner-profile.md')), { recursive: true });
    fs.writeFileSync(path.join(root, 'specs', 'rfp-partner-profile.md'),
      '---\ncalibration: { small: 2, big: 20 }\noverhead: 10\nbuffer: { percent: 5, mode: folded }\nisv: []\nassets: []\n---\n');
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'OOTB', references: ['kb: Some feature'] }] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const it = docModel(doc).items.find(i => i.id === 'HIB-03');
    assert.equal(it.effort.pd, 0);
    assert.equal(it.effort.regime, 'profile');
  } finally { cleanup(); }
});

test('AC-6: an isv: reference needs 4 · separated parts ending in an http(s) URL; a kb: reference must not be empty or n/a', () => {
  const { root, doc, cleanup } = host();
  try {
    const badIsv = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'ISV', size: 'S', references: ['isv: Example Connector · Acme'] } ] } });
    assert.equal(badIsv.ok, false);
    assert.match(badIsv.reason, /isv: needs 4/);

    const goodIsv = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'ISV', size: 'S', references: ['isv: Example Connector · Acme Software · 6.6, 6.7 · https://store.shopware.com/example'], proposals: [{ statement: 'Client accepts the connector\'s stock configuration.', pdSaved: 0.5 }] } ] } });
    assert.equal(goodIsv.ok, true, JSON.stringify(goodIsv));

    const emptyKb = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-02', references: ['kb: n/a'] } ] } });
    assert.equal(emptyKb.ok, false);
    assert.match(emptyKb.reason, /kb: needs a real value/);
  } finally { cleanup(); }
});

test('D-33: a cost: reference is accepted, needs no amount check money words otherwise refused, and is refused with an amount, multi-line or a second one on the same item', () => {
  const { root, doc, cleanup } = host();
  try {
    const good = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'ISV', size: 'S', proposals: [{ statement: 'Client accepts the connector\'s stock configuration.', pdSaved: 0.5 }], references: [
      'isv: Example Connector · Acme Software · 6.6, 6.7 · https://store.shopware.com/example',
      'cost: recurring subscription fee for the connector licence',
    ] } ] } });
    assert.equal(good.ok, true, JSON.stringify(good));
    const it = docModel(doc).items.find(i => i.id === 'HIB-03');
    assert.ok(it.references.includes('cost: recurring subscription fee for the connector licence'));
  } finally { cleanup(); }
});

test('D-33: cost: is refused with an amount', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'ISV', size: 'S', references: [
      'isv: Example Connector · Acme Software · 6.6, 6.7 · https://store.shopware.com/example',
      'cost: EUR 500 per month',
    ] } ] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /cost: must not state an amount/);
  } finally { cleanup(); }
});

test('D-33: cost: is refused when it spans more than one line', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'ISV', size: 'S', references: [
      'isv: Example Connector · Acme Software · 6.6, 6.7 · https://store.shopware.com/example',
      'cost: line one\nline two',
    ] } ] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /cost: must be a single line/);
  } finally { cleanup(); }
});

test('D-33: at most one cost: reference per item, counting one already on the document', () => {
  const { root, doc, cleanup } = host();
  try {
    const first = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'ISV', size: 'S', proposals: [{ statement: 'Client accepts the connector\'s stock configuration.', pdSaved: 0.5 }], references: [
      'isv: Example Connector · Acme Software · 6.6, 6.7 · https://store.shopware.com/example',
      'cost: licence fee',
    ] } ] } });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', references: ['cost: another cost line'] }] } });
    assert.equal(second.ok, false);
    assert.match(second.reason, /at most one cost: reference/);
  } finally { cleanup(); }
});

test('CLI: apply prints its refusal reason once, not twice, on stdout', () => {
  const { root, doc, cleanup } = host();
  try {
    const reportFile = path.join(root, 'report.json');
    fs.writeFileSync(reportFile, JSON.stringify({ cause: 'x', items: [{ id: 'HIB-03', coverage: 'ISV', size: 'S', references: [
      'isv: Example Connector · Acme Software · 6.6, 6.7 · https://store.shopware.com/example',
      'cost: 1,200 EUR per year',
    ] }] }));
    const r = runSync(['apply', doc, '--report', reportFile], root);
    assert.equal(r.code, 1, r.out + r.err);
    const combined = r.out + r.err;
    const hits = combined.split('\n').filter(l => l.includes('cost: must not state an amount'));
    assert.equal(hits.length, 1, `expected the refusal reason once, got:\n${combined}`);
  } finally { cleanup(); }
});

test('D-33: a cost: reference never reopens a confirmed item', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-01', references: ['cost: a licence applies'] }] } });
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.status.kind, 'confirmed');
    assert.ok(it.references.includes('cost: a licence applies'));
  } finally { cleanup(); }
});

test('AC-6 runtime enforcement: a scored item with no kb:/project:/isv: reference at all is refused; ISV coverage with only a kb: reference is refused too', () => {
  const { root, doc, cleanup } = host();
  try {
    const noRef = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Custom', size: 'M' }] } });
    assert.equal(noRef.ok, false);
    assert.match(noRef.reason, /needs a kb:, project: or isv: reference/);

    const isvWithOnlyKb = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'ISV', size: 'S', references: ['kb: Something'] }] } });
    assert.equal(isvWithOnlyKb.ok, false);
    assert.match(isvWithOnlyKb.reason, /coverage ISV needs an isv: reference/);

    // Scored earlier with a reference already on the item — a later report that just touches it
    // (no new coverage) does not need to repeat the reference.
    const scored = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Custom', size: 'M', references: ['project: bespoke module'], proposals: [{ statement: 'Client accepts the bespoke module\'s default fields.', pdSaved: 1 }] }] } });
    assert.equal(scored.ok, true, JSON.stringify(scored));
    const later = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', confidence: 'high' }] } });
    assert.equal(later.ok, true, JSON.stringify(later));
  } finally { cleanup(); }
});

test('D-12: a CQ option needs a non-empty effect', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', blockedBy: 'new:0' }], questions: [
      { items: ['HIB-03'], question: 'q', options: [{ key: 'A', text: 't', effect: '' }, { key: 'B', text: 't2', effect: 'e' }], fallback: 'B' },
    ] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /needs a non-empty effect/);
  } finally { cleanup(); }
});

// #12: this test's title used to promise "an unchanged one stays confirmed" but its body only
// re-applied the SAME changed report a second time (asserting "stays reopened", a different
// claim) — the "unchanged confirmed item" half is the dedicated #9/AC-14 test below.
test('AC-14: a profile change reopens a confirmed item whose Effort it changes; re-applying the same report a second time leaves it reopened, not silently re-confirmed', () => {
  const { root, doc, cleanup } = host();
  try {
    fs.mkdirSync(path.dirname(path.join(root, 'specs', 'rfp-partner-profile.md')), { recursive: true });
    fs.writeFileSync(path.join(root, 'specs', 'rfp-partner-profile.md'),
      '---\ncalibration: { small: 2, big: 20 }\noverhead: 10\nbuffer: { percent: 5, mode: folded }\nisv: []\nassets: []\n---\n');
    apply({ root, doc, report: { cause: 'profile changed', items: [{ id: 'HIB-01', pd: 2 }] } });
    const changed = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(changed.status.kind, 'reopened');

    apply({ root, doc, report: { cause: 'profile changed', items: [{ id: 'HIB-01', pd: 2 }] } });
    const unchanged = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(unchanged.status.kind, 'reopened', 'stays reopened, not silently re-confirmed');
  } finally { cleanup(); }
});

test('#9/AC-14: a regime switch that leaves the PD figure unchanged (0 -> 0) does not reopen a confirmed item, even though `size` differs (T-shirt label vs profile\'s none)', () => {
  const { root, doc, cleanup } = host();
  try {
    // HIB-01 is `confirmed`, OOTB, `— (0 PD)` (T-shirt: size '—', pd 0).
    fs.mkdirSync(path.dirname(path.join(root, 'specs', 'rfp-partner-profile.md')), { recursive: true });
    fs.writeFileSync(path.join(root, 'specs', 'rfp-partner-profile.md'),
      '---\ncalibration: { small: 2, big: 20 }\noverhead: 10\nbuffer: { percent: 5, mode: folded }\nisv: []\nassets: []\n---\n');
    // No `pd` sent: OOTB auto-fills 0 PD in the profile regime too (D-6) — same PD, no size label.
    apply({ root, doc, report: { cause: 'profile changed', items: [{ id: 'HIB-01', coverage: 'OOTB' }] } });
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.effort.pd, 0);
    assert.equal(it.effort.regime, 'profile');
    assert.equal(it.status.kind, 'confirmed', 'PD unchanged (0 -> 0) across the regime switch must not reopen it');
  } finally { cleanup(); }
});

test('AC-7: proposals from the report land in the proposals store, not in the document', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-02', proposals: [{ statement: 'Branch stock sync happens once a day.', pdSaved: 2 }] },
    ], globalProposals: [{ statement: 'The client uses standard Incoterms.', pdSaved: 1 }] } });
    const list = proposals.list(root, 'rfp-0101-xlsx-ids');
    assert.equal(list.length, 2);
    assert.ok(list.some(p => p.item === 'HIB-02' && p.pdSaved === 2));
    assert.ok(list.some(p => p.item === null && p.pdSaved === 1));
    const text = fs.readFileSync(doc, 'utf8');
    assert.ok(!text.includes('Branch stock sync happens once a day.'));
  } finally { cleanup(); }
});

test('a proposal (item or global) without a numeric pdSaved > 0 is refused, with a reason naming the item (AQ-2)', () => {
  const { root, doc, cleanup } = host();
  try {
    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });

    // Item proposal: missing pdSaved.
    let reasons = validateReport({ items: [
      { id: 'HIB-02', proposals: [{ statement: 'Branch stock sync happens once a day.' }] },
    ] }, model, { regimeStr: 'T-shirt' });
    assert.ok(reasons.some(r => /item HIB-02: proposal pdSaved must be a number > 0/.test(r)), reasons.join('; '));

    // Item proposal: negative pdSaved.
    reasons = validateReport({ items: [
      { id: 'HIB-02', proposals: [{ statement: 'x', pdSaved: -1 }] },
    ] }, model, { regimeStr: 'T-shirt' });
    assert.ok(reasons.some(r => /item HIB-02: proposal pdSaved must be a number > 0/.test(r)), reasons.join('; '));

    // Item proposal: zero pdSaved (AQ-2 refuses <= 0, not just < 0).
    reasons = validateReport({ items: [
      { id: 'HIB-02', proposals: [{ statement: 'x', pdSaved: 0 }] },
    ] }, model, { regimeStr: 'T-shirt' });
    assert.ok(reasons.some(r => /item HIB-02: proposal pdSaved must be a number > 0/.test(r)), reasons.join('; '));

    // Global proposal: missing pdSaved.
    reasons = validateReport({ items: [], globalProposals: [{ statement: 'The client uses standard Incoterms.' }] }, model, { regimeStr: 'T-shirt' });
    assert.ok(reasons.some(r => /global proposal: pdSaved must be a number > 0/.test(r)), reasons.join('; '));

    // `apply` itself refuses rather than writing a proposal the page cannot show "saves - PD" for.
    const r = apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-02', proposals: [{ statement: 'Branch stock sync happens once a day.' }] },
    ] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /item HIB-02: proposal pdSaved must be a number/);
    assert.equal(proposals.list(root, 'rfp-0101-xlsx-ids').length, 0, 'nothing is written on a refused report');
  } finally { cleanup(); }
});

test('AQ-2: an item proposal cannot claim more pdSaved than the item\'s own effort in PD', () => {
  const { root, doc, cleanup } = host();
  try {
    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });

    // HIB-02 already carries M (4 PD) in the document; this report does not resend an effort, so
    // the cap comes from the document's existing effort.
    let reasons = validateReport({ items: [
      { id: 'HIB-02', proposals: [{ statement: 'x', pdSaved: 5 }] },
    ] }, model, { regimeStr: 'T-shirt' });
    assert.ok(reasons.some(r => /item HIB-02: proposal pdSaved \(5\) exceeds the item's effort \(4 PD\) \(AQ-2\)/.test(r)), reasons.join('; '));

    // At the cap is accepted.
    reasons = validateReport({ items: [
      { id: 'HIB-02', proposals: [{ statement: 'x', pdSaved: 4 }] },
    ] }, model, { regimeStr: 'T-shirt' });
    assert.ok(!reasons.some(r => /exceeds the item's effort/.test(r)), reasons.join('; '));

    // This report's own `size` sets the cap (S = 1.5 PD) even though the document had no effort yet.
    reasons = validateReport({ items: [
      { id: 'HIB-03', coverage: 'Configuration', size: 'S', references: ['project: x'], proposals: [{ statement: 'x', pdSaved: 2 }] },
    ] }, model, { regimeStr: 'T-shirt' });
    assert.ok(reasons.some(r => /item HIB-03: proposal pdSaved \(2\) exceeds the item's effort \(1\.5 PD\) \(AQ-2\)/.test(r)), reasons.join('; '));

    // A global proposal is never capped by an item's effort — only > 0 is required.
    reasons = validateReport({ items: [], globalProposals: [{ statement: 'x', pdSaved: 100 }] }, model, { regimeStr: 'T-shirt' });
    assert.ok(!reasons.some(r => /exceeds/.test(r)), reasons.join('; '));

    const r = apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-02', proposals: [{ statement: 'Branch stock sync happens once a day.', pdSaved: 5 }] },
    ] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /exceeds the item's effort/);
  } finally { cleanup(); }
});

test('apply preserves every other section byte-for-byte', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'OOTB', size: '—' }] } });
    const before = FIXTURE.split('\n');
    const after = fs.readFileSync(doc, 'utf8').split('\n');
    const s4Heading = before.findIndex(l => l.startsWith('## 4.'));
    // Everything up to and including the §4 heading (frontmatter, §1 Context with its Project
    // information / Not taken tables, §2 Totals, §3 Global assumptions and exclusions) is
    // byte-for-byte untouched — `apply` only ever rewrites §4 and §5.
    assert.equal(after.slice(0, s4Heading + 1).join('\n'), before.slice(0, s4Heading + 1).join('\n'), '§1–§3 and above untouched');
    assert.ok(before.slice(0, s4Heading).includes('### Assumptions'));
  } finally { cleanup(); }
});

test('validateReport: a question needs at least two options and a fallback among them', () => {
  const model = parse(FIXTURE, { path: 'x' });
  const reasons = validateReport({ items: [], questions: [{ items: ['HIB-03'], question: 'q', options: [{ key: 'A', text: 't', effect: 'e' }], fallback: 'A' }] }, model);
  assert.ok(reasons.some(r => /at least two options/.test(r)));
});

test('AQ-2: apply refuses a non-OOTB item with no proposal and no noProposal; OOTB and — stay exempt', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Extension', size: 'S', references: ['project: something'] }] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /needs at least one proposal or a noProposal reason \(AQ-2\)/);

    // A proposal (a suggestion is mandatory for every estimated item) satisfies it.
    const withProposal = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Extension', size: 'S', references: ['project: something'], proposals: [{ statement: 'Client accepts the storefront default layout.', pdSaved: 1 }] }] } });
    assert.equal(withProposal.ok, true, JSON.stringify(withProposal));

    // OOTB is exempt even with neither.
    const ootb = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-02', coverage: 'OOTB' }] } });
    assert.equal(ootb.ok, true, JSON.stringify(ootb));
  } finally { cleanup(); }
});

test('AQ-2: noProposal is refused unless the item already has an accepted assumption covering it', () => {
  const { root, doc, cleanup } = host();
  try {
    // HIB-03 has no assumptions yet: noProposal alone is not enough any more.
    const noAssumptionYet = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Extension', size: 'S', references: ['project: something'], noProposal: 'nothing to shrink here' }] } });
    assert.equal(noAssumptionYet.ok, false);
    assert.match(noAssumptionYet.reason, /noProposal is only valid when the item already has an accepted assumption covering it \(AQ-2\)/);

    // HIB-02 already carries an accepted assumption (fixture Assumptions column): noProposal is
    // accepted, since the assumption already locks its scope.
    const alreadyCovered = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-02', coverage: 'Extension', size: 'M', noProposal: 'already scoped down by the existing assumption' }] } });
    assert.equal(alreadyCovered.ok, true, JSON.stringify(alreadyCovered));
  } finally { cleanup(); }
});

test('two sequential applies each with a proposal keep both sets of proposals in the store', () => {
  const { root, doc, cleanup } = host();
  try {
    const first = apply({ root, doc, report: { cause: 'x', items: [
      { id: 'HIB-03', coverage: 'Extension', size: 'S', references: ['project: something'], proposals: [{ statement: 'First assumption shrinks the scope.', pdSaved: 1 }] },
    ] } });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = apply({ root, doc, report: { cause: 'y', items: [
      { id: 'HIB-02', proposals: [{ statement: 'Second assumption, a different item.', pdSaved: 0.5 }] },
    ] } });
    assert.equal(second.ok, true, JSON.stringify(second));
    const list = proposals.list(root, 'rfp-0101-xlsx-ids');
    assert.ok(list.some(p => p.item === 'HIB-03' && p.statement === 'First assumption shrinks the scope.'));
    assert.ok(list.some(p => p.item === 'HIB-02' && p.statement === 'Second assumption, a different item.'));
    assert.equal(list.length, 2, 'both proposals from the two applies survive');
  } finally { cleanup(); }
});

test('5b: a document written with the pre-rename header/order is rewritten in the new order on the next apply', () => {
  const OLD_HEADER_LINE = '| ID | Prio | Requirement Coverage | Confidence | Effort | Requirement | Client Response | Assumptions | Internal note | References | Status |';
  const oldDoc = FIXTURE
    .replaceAll(ITEM_HEADER_LINE, OLD_HEADER_LINE)
    .replace('| HIB-01 | Must | Customers can create an account and log in. | OOTB | high | — (0 PD) | Stock Shopware customer accounts cover this out of the box. |  |  | kb: Customer accounts | confirmed 2026-09-01 |',
      '| HIB-01 | Must | OOTB | high | — (0 PD) | Customers can create an account and log in. | Stock Shopware customer accounts cover this out of the box. |  |  | kb: Customer accounts | confirmed 2026-09-01 |')
    .replace('| HIB-02 | Should | Show stock per branch on the product page. | Extension | medium | M (4 PD) | We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | estimated |',
      '| HIB-02 | Should | Extension | medium | M (4 PD) | Show stock per branch on the product page. | We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | estimated |')
    .replace('| HIB-03 | Could | The client\'s requirement text is too vague to size yet. |  |  |  |  |  |  |  | blocked CQ-1 |',
      '| HIB-03 | Could |  |  |  | The client\'s requirement text is too vague to size yet. |  |  |  |  | blocked CQ-1 |')
    .replace('| CMP-01 | Must | Provide an audit trail of every price change for the last seven years. | Custom | low | XL (25 PD) | We build a dedicated audit-trail module for pricing changes. |  |  | failed: no stock or project feature to extend | failed |',
      '| CMP-01 | Must | Custom | low | XL (25 PD) | Provide an audit trail of every price change for the last seven years. | We build a dedicated audit-trail module for pricing changes. |  |  | failed: no stock or project feature to extend | failed |');
  const { root, doc, cleanup } = host(oldDoc);
  try {
    assert.ok(fs.readFileSync(doc, 'utf8').includes(OLD_HEADER_LINE), 'the fixture actually starts in the old layout');
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'OOTB', size: '—', references: ['kb: Some feature'] }] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = fs.readFileSync(doc, 'utf8');
    assert.ok(after.includes(ITEM_HEADER_LINE), 'rewritten with the new header');
    assert.ok(!after.includes(OLD_HEADER_LINE), 'the old header is gone');
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.requirement, 'Customers can create an account and log in.', 'columns landed correctly, not just relabelled');
  } finally { cleanup(); }
});

test('apply dedupes a reference the item already carries instead of piling up a duplicate', () => {
  const { root, doc, cleanup } = host();
  try {
    const first = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'OOTB', references: ['kb: Some feature'] }] } });
    assert.equal(first.ok, true, JSON.stringify(first));
    const afterFirst = docModel(doc).items.find(i => i.id === 'HIB-03');
    assert.equal(afterFirst.references.filter(r => r === 'kb: Some feature').length, 1);

    // A later re-report repeating the exact same reference must not add a second copy.
    const second = apply({ root, doc, report: { cause: 'y', items: [{ id: 'HIB-03', references: ['kb: Some feature', 'project: a new one'] }] } });
    assert.equal(second.ok, true, JSON.stringify(second));
    const afterSecond = docModel(doc).items.find(i => i.id === 'HIB-03');
    assert.equal(afterSecond.references.filter(r => r === 'kb: Some feature').length, 1, 'no duplicate reference from a report that repeats one already present');
    assert.ok(afterSecond.references.includes('project: a new one'), 'a genuinely new reference in the same report still lands');
  } finally { cleanup(); }
});

const CQ_REPORT = () => ({ cause: 'x', items: [{ id: 'CMP-01', coverage: 'OOTB', confidence: 'low', size: 'S', blockedBy: 'new:0', references: ['project: purge job'] }], questions: [
  { items: ['CMP-01'], question: 'Is a 7-year retention mandatory?', options: [{ key: 'A', text: 'yes', effect: 'custom archive' }, { key: 'B', text: 'no', effect: 'stock log suffices' }], fallback: 'B' },
] });

test('CQ idempotence: applying the same report twice adds no question', () => {
  const { root, doc, cleanup } = host();
  try {
    assert.equal(apply({ root, doc, report: CQ_REPORT() }).ok, true);
    const before = docModel(doc).questions.length;
    const r = apply({ root, doc, report: CQ_REPORT() });
    assert.equal(r.ok, true);
    assert.deepEqual(r.questions, []);
    assert.equal(docModel(doc).questions.length, before);
    assert.equal(docModel(doc).items.find(i => i.id === 'CMP-01').status.cq, 'CQ-2');
  } finally { cleanup(); }
});

test('CQ idempotence: same text with different case/whitespace and an overlapping item merges; new items are unioned', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: CQ_REPORT() });
    const rep = CQ_REPORT();
    rep.questions[0].items = ['CMP-01', 'HIB-03'];
    rep.questions[0].question = '  is a 7-YEAR   retention mandatory? ';
    rep.items.push({ id: 'HIB-03', coverage: 'OOTB', confidence: 'low', size: 'S', blockedBy: 'new:0', references: ['project: x'] });
    const r = apply({ root, doc, report: rep });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.questions, []);
    const cq = docModel(doc).questions.find(q => q.id === 'CQ-2');
    assert.deepEqual(cq.items, ['CMP-01', 'HIB-03']);
    assert.equal(docModel(doc).items.find(i => i.id === 'HIB-03').status.cq, 'CQ-2');
  } finally { cleanup(); }
});

test('CQ idempotence: re-apply after a failed check adds no question, and blockedBy CQ-n appends the item', () => {
  const { root, doc, cleanup } = host();
  try {
    apply({ root, doc, report: CQ_REPORT() });
    const r = apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'OOTB', confidence: 'low', size: 'S', blockedBy: 'CQ-2', references: ['project: x'] }] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(docModel(doc).questions.find(q => q.id === 'CQ-2').items, ['CMP-01', 'HIB-03']);
    assert.equal(apply({ root, doc, report: CQ_REPORT() }).ok, true);
    assert.equal(docModel(doc).questions.filter(q => q.question === 'Is a 7-year retention mandatory?').length, 1);
  } finally { cleanup(); }
});
