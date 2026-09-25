import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '../lib/parse.mjs';
import { renderItemsSection, renderQuestionsSection, replaceSection, replaceSections, setFrontmatterField, snapshot, verifyAndRepair } from '../lib/edit.mjs';
import { HERE } from './helpers.mjs';

const FIX = readFileSync(path.join(HERE, 'fixtures/rfp-0101-xlsx-ids-analysis.md'), 'utf8');

test('renderItemsSection round-trips through parse: same ids, same field values', () => {
  const model = parse(FIX);
  const rendered = renderItemsSection(model.items);
  const reparsed = parse(`## 4. Scope items\n\n${rendered}\n\n## 5. Questions\n`).items;
  assert.equal(reparsed.length, model.items.length);
  for (const [a, b] of model.items.map((it, i) => [it, reparsed[i]])) {
    assert.equal(b.id, a.id);
    assert.equal(b.area, a.area);
    assert.equal(b.coverage, a.coverage);
    assert.deepEqual(b.effort, a.effort);
    assert.deepEqual(b.status, a.status);
    assert.deepEqual(b.assumptions, a.assumptions);
    assert.deepEqual(b.references, a.references);
  }
});

test('renderItemsSection produces canonical order: TABS order, then first-seen topic order, regardless of item array order', () => {
  const items = [
    { id: 'A-1', tab: 'Non-functional', topic: 'Ops', area: 'Non-functional · Ops', prio: 'Must', assumptions: [], references: [], status: {} },
    { id: 'B-1', tab: 'Functional', topic: 'Catalogue', area: 'Functional · Catalogue', prio: 'Must', assumptions: [], references: [], status: {} },
    // Same tab/topic as A-1, but not adjacent in the array (e.g. after a `move`) — must still
    // land in the same rendered table as A-1, not a second one.
    { id: 'A-2', tab: 'Non-functional', topic: 'Ops', area: 'Non-functional · Ops', prio: 'Should', assumptions: [], references: [], status: {} },
  ];
  const rendered = renderItemsSection(items);
  const headings = rendered.split('\n').filter(l => l.startsWith('### '));
  assert.deepEqual(headings, ['### Functional · Catalogue', '### Non-functional · Ops']);
  const opsBlock = rendered.slice(rendered.indexOf('### Non-functional · Ops'));
  assert.ok(opsBlock.indexOf('A-1') < opsBlock.indexOf('A-2'), 'items within a topic keep client order');
});

test('renderQuestionsSection round-trips an answered CQ', () => {
  const model = parse(FIX);
  const rendered = renderQuestionsSection(model.questions);
  const reparsed = parse(`## 5. Questions\n\n${rendered}\n\n## 6. Integrations\n`).questions;
  assert.equal(reparsed.length, 1);
  assert.equal(reparsed[0].id, 'CQ-1');
  assert.equal(reparsed[0].fallback, 'B');
});

test('replaceSection touches only the named section; every other byte is unchanged', () => {
  const model = parse(FIX);
  const next = replaceSection(FIX, model.blocks, 4, renderItemsSection(model.items));
  const beforeLines = FIX.split('\n');
  const afterLines = next.split('\n');
  // Everything up to and including the §4 heading is untouched.
  const headingIdx = beforeLines.findIndex(l => l.startsWith('## 4.'));
  assert.deepEqual(afterLines.slice(0, headingIdx + 1), beforeLines.slice(0, headingIdx + 1));
  // §5 onward (unchanged, just reflowed to the new §4 length) still contains the CQ block.
  assert.ok(next.includes('### CQ-1 · HIB-03'));
  assert.ok(next.includes('## 8. Log'));
});

test('replaceSections is idempotent: writing the same content repeatedly never accumulates blank lines', () => {
  let text = FIX;
  let model = parse(text);
  const edits = m => [[4, renderItemsSection(m.items)], [5, renderQuestionsSection(m.questions)]];
  text = replaceSections(text, model.blocks, edits(model));
  const once = text;
  for (let i = 0; i < 4; i++) {
    model = parse(text);
    text = replaceSections(text, model.blocks, edits(model));
  }
  assert.equal(text, once, 'five writes of the same content produce byte-identical output after the first');
  assert.doesNotMatch(text, /\n{3,}/, 'no run of blank lines grew across repeated writes');
});

test('replaceSections applies bottom-up so earlier line numbers stay valid', () => {
  const model = parse(FIX);
  const next = replaceSections(FIX, model.blocks, [
    [4, renderItemsSection(model.items)],
    [5, renderQuestionsSection(model.questions)],
  ]);
  const reparsed = parse(next);
  assert.equal(reparsed.errors.length, 0, reparsed.errors.join('; '));
  assert.equal(reparsed.items.length, model.items.length);
  assert.equal(reparsed.questions.length, model.questions.length);
});

test('setFrontmatterField updates an existing key without touching the rest of the frontmatter', () => {
  const next = setFrontmatterField(FIX, 'state', 'Ready');
  assert.match(next, /^state: Ready$/m);
  assert.match(next, /^regime: T-shirt$/m);
});

test('snapshot + verifyAndRepair: a corrupted §4 row is restored, everything else kept', () => {
  const snap = snapshot(FIX);
  const corrupted = FIX.replace('Customers can create an account and log in. | OOTB |', 'Customers can create an account and log in. | NOT-A-VALUE |');
  const { text, repairs } = verifyAndRepair(corrupted, snap);
  assert.ok(repairs.some(r => r.includes('HIB-01')));
  const model = parse(text);
  assert.equal(model.errors.length, 0);
  assert.equal(model.items.find(it => it.id === 'HIB-01').coverage, 'OOTB');
});

test('verifyAndRepair restores a row for an id that disappeared entirely', () => {
  const snap = snapshot(FIX);
  const lines = FIX.split('\n');
  const idx = lines.findIndex(l => l.startsWith('| HIB-02 |'));
  lines.splice(idx, 1);
  const { text, repairs } = verifyAndRepair(lines.join('\n'), snap);
  assert.ok(repairs.some(r => r.includes('HIB-02')));
  assert.ok(parse(text).items.some(it => it.id === 'HIB-02'));
});

test('verifyAndRepair leaves a legitimately-changed row alone', () => {
  const snap = snapshot(FIX);
  const changed = FIX.replace('| Extension | medium |', '| Extension | high |');
  const { text, repairs } = verifyAndRepair(changed, snap);
  assert.deepEqual(repairs, []);
  assert.equal(parse(text).items.find(it => it.id === 'HIB-02').confidence, 'high');
});

test('verifyAndRepair restores a missing frontmatter block', () => {
  const snap = snapshot(FIX);
  const noFm = FIX.replace(/^---[\s\S]*?---\r?\n/, '');
  const { text, repairs } = verifyAndRepair(noFm, snap);
  assert.ok(repairs.includes('restored frontmatter'));
  assert.ok(parse(text).frontmatter);
});

// §1 Project information rows the operator set by hand (`info <doc> <key> "<value>"`, Source
// `operator`) — a run must never silently lose one (WP-3b addendum).
const OPERATOR_ROW = '| Business model | B2B wholesale, MRO distributor set by hand | operator |';
const FIX_WITH_OPERATOR_ROW = FIX.replace(
  '| Business model | B2B wholesale, MRO distributor | 1 Company & Context r4 |',
  OPERATOR_ROW,
);

test('verifyAndRepair restores an operator-sourced §1 Project information row a run corrupted in place', () => {
  const snap = snapshot(FIX_WITH_OPERATOR_ROW);
  // Corrupt the row's label (its position is unchanged) — `parse` reports it as a §1 Project
  // information row-order error, same shape as a single §4 row going bad in place.
  const corrupted = FIX_WITH_OPERATOR_ROW.replace('| Business model |', '| Bosiness model |');
  const { text, repairs } = verifyAndRepair(corrupted, snap);
  assert.ok(repairs.some(r => r.includes('Business model')), repairs.join('; '));
  const model = parse(text);
  assert.equal(model.errors.length, 0, model.errors.join('; '));
  const row = model.projectInfo.find(r => r.key === 'business-model');
  assert.equal(row.value, 'B2B wholesale, MRO distributor set by hand');
  assert.equal(row.source, 'operator');
});

test('verifyAndRepair restores an operator-sourced §1 row whose Source a run overwrote away from `operator`', () => {
  const snap = snapshot(FIX_WITH_OPERATOR_ROW);
  const overwritten = FIX_WITH_OPERATOR_ROW.replace(
    OPERATOR_ROW,
    '| Business model | B2B wholesale, MRO distributor | 1 Company & Context r4 |',
  );
  const { text, repairs } = verifyAndRepair(overwritten, snap);
  assert.ok(repairs.some(r => r.includes('Business model')), repairs.join('; '));
  const row = parse(text).projectInfo.find(r => r.key === 'business-model');
  assert.equal(row.value, 'B2B wholesale, MRO distributor set by hand');
  assert.equal(row.source, 'operator');
});

test('verifyAndRepair leaves an operator-sourced §1 row alone when it is legitimately re-set to a new value', () => {
  const snap = snapshot(FIX_WITH_OPERATOR_ROW);
  const changed = FIX_WITH_OPERATOR_ROW.replace(
    OPERATOR_ROW,
    '| Business model | B2B wholesale, MRO distributor, updated by a later `info` call | operator |',
  );
  const { text, repairs } = verifyAndRepair(changed, snap);
  assert.deepEqual(repairs, []);
  assert.equal(
    parse(text).projectInfo.find(r => r.key === 'business-model').value,
    'B2B wholesale, MRO distributor, updated by a later `info` call',
  );
});
