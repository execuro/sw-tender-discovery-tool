import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/calc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from '../lib/parse.mjs';

const st = (state, suspect = false) => ({ state, suspect });
const req = (id, prio, cls, mid, lvl, pd, children = [], status = { kind: 'estimated', cq: null }) => ({
  id, kind: 'req', prio, cls, lmh: mid == null ? null : { low: mid - 2, mid, high: mid + 4 }, lvl, pd, status, children,
});

function model(overrides = {}) {
  const a1 = { id: 'STF-01.a1', kind: 'assume', parent: 'STF-01', pdSaved: 5, cls: null, status: st('proposed') };
  const a2 = { id: 'STF-01.a2', kind: 'assume', parent: 'STF-01', pdSaved: 2, cls: 'config', status: st('accepted') };
  const c1 = { id: 'STF-01.c1', kind: 'clarify', parent: 'STF-01' };
  const ca1 = { id: 'CAT-03.a1', kind: 'assume', parent: 'CAT-03', pdSaved: 1, cls: null, status: st('proposed', true) };
  const A1 = { id: 'A-1', kind: 'global', gkind: 'assume', rowsNamed: ['STF-01', 'STF-02', 'STF-03'],
    pdSaved: { total: 4, perRow: { 'STF-01': 3, 'CAT-03': 1 } }, cls: null, status: st('proposed') };
  const X1 = { id: 'X-1', kind: 'global', gkind: 'exclude', rowsNamed: ['GEN-02'], pdSaved: { total: null, perRow: null }, cls: null, status: st('proposed') };
  const m = {
    meta: { totals: { must: 15.5, should: 2.25, could: 0, services: 0, total: 17.75 },
      overhead: { pct: 10, tbd: false }, buffer: { pct: 5, mode: 'separate', tbd: false } },
    blocks: [
      { id: 's3', kind: 'section', n: 3, children: [{ kind: 'table', tableKind: 'global', children: [A1, X1] }] },
      { id: 's4', kind: 'section', n: 4, children: [{ kind: 'table', tableKind: 'analysis', children: [
        req('STF-01', 'Must', 'custom', 16, 'vague', 15.5, [a1, a2, c1]),
        req('GEN-02', 'Must', 'commitment', 0, 'detailed', 0),
        req('CAT-03', 'Should', 'config', 2, 'medium', 2.25, [ca1], { kind: 'provisional', cq: 'CQ-1' }),
      ] }] },
      { id: 's5', kind: 'section', n: 5, children: [
        { id: 'CQ-1', kind: 'question', options: [{ letter: 'A', checked: false }, { letter: 'B', checked: false }], other: { text: '', checked: false } },
        { id: 'Q-1', kind: 'question', options: [{ letter: 'A', checked: false }], other: { text: '', checked: false } },
      ] },
    ],
  };
  Object.assign(m.meta, overrides.meta || {});
  return m;
}
const stf = m => C.reqRows(m).find(r => r.id === 'STF-01');
const line = (m, id) => { for (const r of C.reqRows(m)) for (const c of r.children) if (c.id === id) return c; return C.globalLines(m).find(g => g.id === id); };

test('constants and helpers', () => {
  assert.deepEqual(C.LADDER, ['stock', 'config', 'plugin', 'extension', 'custom']);
  assert.deepEqual(C.OFF, ['commitment', 'service', 'not-offered', 'blocked']);
  assert.deepEqual(C.LEVEL_BUFFER, { detailed: 0, medium: 0.10, vague: 0.25 });
  assert.equal(C.ladderOf('stock'), 'ootb'); assert.equal(C.ladderOf('config'), 'ootb');
  assert.equal(C.ladderOf('plugin'), 'plugin'); assert.equal(C.ladderOf('extension'), 'extension');
  assert.equal(C.ladderOf('commitment'), 'off'); assert.equal(C.ladderOf(null), null);
  assert.equal(C.rank('stock'), 0); assert.equal(C.rank('custom'), 4); assert.equal(C.rank('service'), -1);
  assert.equal(C.round025(15.375), 15.5); assert.equal(C.round025(15.125), 15.25);
  assert.ok(Object.is(C.round025(0), 0)); assert.ok(Object.is(C.round025(-0.1), 0));
  assert.deepEqual(C.factors(model().meta), { overhead: 1.1, risk: 1 });
  assert.deepEqual(C.factors({ overhead: { pct: 10, tbd: false }, buffer: { pct: 5, mode: 'folded', tbd: false } }), { overhead: 1.1, risk: 1.05 });
  assert.deepEqual(C.factors({ overhead: { pct: null, tbd: true }, buffer: { pct: null, mode: null, tbd: true } }), { overhead: 1, risk: 1 });
});

test('reqRows, globalLines, linesFor, applied, pdSavedFor', () => {
  const m = model();
  assert.deepEqual(C.reqRows(m).map(r => r.id), ['STF-01', 'GEN-02', 'CAT-03']);
  assert.deepEqual(C.globalLines(m).map(g => g.id), ['A-1']);
  const lines = C.linesFor(stf(m), m);
  assert.deepEqual(lines.map(l => l.id), ['STF-01.a1', 'STF-01.a2', 'A-1']);
  assert.deepEqual(C.applied(lines, 'doc').map(l => l.id), ['STF-01.a2']);
  line(m, 'STF-01.a1').status.state = 'ticked-accept';
  assert.deepEqual(C.applied(lines, 'doc').map(l => l.id), ['STF-01.a2']);
  assert.deepEqual(C.applied(lines, 'projected').map(l => l.id), ['STF-01.a1', 'STF-01.a2']);
  assert.deepEqual(C.applied(C.linesFor(C.reqRows(m)[2], m), 'projected'), []); // suspect never
  assert.deepEqual(C.pdSavedFor(line(m, 'STF-01.a1'), 'STF-01'), { value: 5, unknown: false });
  assert.deepEqual(C.pdSavedFor(line(m, 'A-1'), 'STF-01'), { value: 3, unknown: false });
  assert.deepEqual(C.pdSavedFor(line(m, 'A-1'), 'STF-02'), { value: null, unknown: true });
  assert.deepEqual(C.pdSavedFor({ kind: 'global', rowsNamed: ['X-1'], pdSaved: { total: 4, perRow: null } }, 'X-1'), { value: 4, unknown: false });
});

test('computeRow doc mode: fixture parity STF-01', () => {
  const m = model();
  const r = C.computeRow(stf(m), m, 'doc');
  assert.deepEqual(r.applied, ['STF-01.a2']);
  assert.equal(r.lvl, 'detailed'); assert.equal(r.buffer, 0);
  assert.equal(r.mid, 16); assert.equal(r.saved, 2); assert.equal(r.mid2, 14);
  assert.equal(r.final, 15.5); assert.equal(r.cls, 'config'); assert.equal(r.ladder, 'ootb');
  assert.equal(r.docPd, 15.5); assert.equal(r.drift, 0); assert.equal(r.blocked, false);
  assert.deepEqual(r.unknownSaved, []);
});

test('computeRow projected with ticked line, force, folded buffer, tbd overhead', () => {
  const m = model();
  line(m, 'STF-01.a1').status.state = 'ticked-accept';
  const p = C.computeRow(stf(m), m, 'projected');
  assert.equal(p.mid2, 9); assert.equal(p.final, 10); assert.equal(p.drift, null);
  const f = C.computeRow(stf(m), m, 'projected', { force: { 'A-1': 'accepted' } });
  assert.equal(f.mid2, 6); assert.equal(f.final, 6.5);
  assert.deepEqual(f.applied, ['STF-01.a1', 'STF-01.a2', 'A-1']);
  const off = C.computeRow(stf(m), m, 'projected', { force: { 'STF-01.a1': 'proposed' } });
  assert.equal(off.final, 15.5);
  const folded = model({ meta: { buffer: { pct: 5, mode: 'folded', tbd: false } } });
  assert.equal(C.computeRow(stf(folded), folded, 'doc').final, C.round025(14 * 1.1 * 1.05));
  const tbd = model({ meta: { overhead: { pct: null, tbd: true } } });
  assert.equal(C.computeRow(stf(tbd), tbd, 'doc').final, 14);
  const untouched = model(); untouched.blocks[1].children[0].children[0].children = [];
  const u = C.computeRow(stf(untouched), untouched, 'doc');
  assert.equal(u.lvl, 'vague'); assert.equal(u.cls, 'custom'); assert.equal(u.final, C.round025(16 * 1.25 * 1.1));
});

test('computeRow commitment, blocked, unknown global saving', () => {
  const m = model();
  const gen = C.computeRow(C.reqRows(m)[1], m, 'doc');
  assert.equal(gen.final, 0); assert.equal(gen.commitment, true); assert.equal(gen.ladder, 'off');
  const b1 = req('B-1', 'Must', 'blocked', null, 'vague', null, [], { kind: 'blocked', cq: 'CQ-9' }); b1.lmh = 'blocked';
  m.blocks[1].children[0].children.push(b1);
  const b = C.computeRow(b1, m, 'doc');
  assert.equal(b.final, null); assert.equal(b.blocked, true); assert.equal(b.drift, null);
  const s2 = req('STF-02', 'Could', 'plugin', 4, 'detailed', 4.5);
  m.blocks[1].children[0].children.push(s2);
  line(m, 'A-1').status.state = 'accepted';
  const r = C.computeRow(s2, m, 'doc');
  assert.deepEqual(r.unknownSaved, ['A-1']); assert.equal(r.saved, 0); assert.equal(r.final, 4.5);
  assert.deepEqual(C.computeRow(stf(m), m, 'doc').applied, ['STF-01.a2', 'A-1']);
  assert.equal(C.computeRow(stf(m), m, 'doc').final, 12); // 16-2-3=11 × 1.1 = 12.1
});

test('computeAll, totals, delta', () => {
  const m = model();
  const b1 = req('B-1', 'Must', 'custom', null, 'vague', null, [], { kind: 'blocked', cq: 'CQ-9' }); b1.lmh = 'blocked';
  const svc = req('SVC-1', 'should', 'service', 3, 'detailed', 3.25);
  m.blocks[1].children[0].children.push(b1, svc);
  const all = C.computeAll(m, 'doc');
  assert.deepEqual(Object.keys(all), ['STF-01', 'GEN-02', 'CAT-03', 'B-1', 'SVC-1']);
  const t = C.totals(m, all);
  assert.equal(t.must, 15.5); assert.equal(t.should, 2.5 + 3.25); assert.equal(t.could, 0); // CAT-03: 2 × 1.1 (medium) × 1.1 = 2.5
  assert.equal(t.services, 3.25); assert.equal(t.total, 21.25); assert.deepEqual(t.blocked, ['B-1']); assert.equal(t.rows, 5);
  line(m, 'STF-01.a1').status.state = 'ticked-accept';
  assert.deepEqual(C.delta(m), { must: -5.5, should: 0, could: 0, total: -5.5 }); // ticks only, never rounding drift vs §2
  const noTotals = model({ meta: { totals: null } });
  assert.deepEqual(C.delta(noTotals), { must: 0, should: 0, could: 0, total: 0 }); // no ticks → no delta, even without §2 totals
});

test('computeRow / totals: queued and analysing rows carry no PD but bucket separately from blocked', () => {
  const m = model();
  const q1 = req('Q-9', 'Must', 'custom', 10, 'vague', 12, [], { kind: 'queued', cq: null });
  const a1r = req('A-9', 'Should', 'custom', 8, 'vague', 9, [], { kind: 'analysing', cq: null });
  m.blocks[1].children[0].children.push(q1, a1r);
  const cq = C.computeRow(q1, m, 'doc');
  assert.equal(cq.mid, 10); assert.equal(cq.blocked, true); assert.equal(cq.final, null);
  const ca = C.computeRow(a1r, m, 'doc');
  assert.equal(ca.blocked, true); assert.equal(ca.final, null);
  const all = C.computeAll(m, 'doc');
  const t = C.totals(m, all);
  assert.deepEqual(t.queued, ['Q-9']);
  assert.deepEqual(t.analysing, ['A-9']);
  assert.deepEqual(t.blocked, []);
  assert.equal(t.must, 15.5); // Q-9 is Must but carries no estimate yet, so it is not in the total
});

test('sourceTables / reqTabs: group §4 rows by the §1 source-map id ranges, in document order', () => {
  const srcTable = { kind: 'table', tableKind: 'source', colIndex: { '#': 0, 'table (sheet / section)': 1, locator: 2 }, children: [
    { kind: 'row', cells: ['1', 'Cover', '`01-cover.csv` rows 1–5'] },
    { kind: 'row', cells: ['2', 'Requirements', '`02-req.csv` rows 2–5 (`GEN-01`…`GEN-02`)'] },
    { kind: 'row', cells: ['3', 'Compliance', '`03-nfr.csv` rows 2–3 (`NFR-01`…`NFR-01`)'] },
  ] };
  const s1 = { id: 's1', kind: 'section', n: 1, children: [srcTable] };
  const reqs = [
    req('GEN-01', 'Must', 'custom', 4, 'detailed', 4),
    req('GEN-02', 'Must', 'custom', 2, 'detailed', 2),
    req('NFR-01', 'Should', 'custom', 3, 'detailed', 3),
    req('XTR-01', 'Could', 'custom', 1, 'detailed', 1), // no source table claims it -> Other
  ];
  const s4 = { id: 's4', kind: 'section', n: 4, children: [{ kind: 'table', tableKind: 'analysis', children: reqs }] };
  const m = { meta: {}, blocks: [s1, s4] };

  const st = C.sourceTables(m);
  assert.deepEqual(st.map(t => [t.num, t.name, t.first, t.last]), [
    [1, 'Cover', null, null], [2, 'Requirements', 'GEN-01', 'GEN-02'], [3, 'Compliance', 'NFR-01', 'NFR-01'],
  ]);

  const tabs = C.reqTabs(m);
  assert.deepEqual(tabs.map(t => t.key), ['src-2', 'src-3', 'other']);
  assert.deepEqual(tabs[0].rows.map(r => r.id), ['GEN-01', 'GEN-02']);
  assert.equal(tabs[0].num, 2); assert.equal(tabs[0].name, 'Requirements');
  assert.deepEqual(tabs[1].rows.map(r => r.id), ['NFR-01']);
  assert.deepEqual(tabs[2].rows.map(r => r.id), ['XTR-01']);

  // no parseable range anywhere -> one tab holding every row (today's behaviour)
  const flatSrc = { kind: 'table', tableKind: 'source', colIndex: { '#': 0, 'table (sheet / section)': 1, locator: 2 }, children: [
    { kind: 'row', cells: ['1', 'Requirements', 'rows 2–4'] },
  ] };
  const noRanges = { meta: {}, blocks: [{ id: 's1', kind: 'section', n: 1, children: [flatSrc] }, s4] };
  const all = C.reqTabs(noRanges);
  assert.deepEqual(all.map(t => t.key), ['all']);
  assert.equal(all[0].rows.length, 4);

  // no source table at all -> same fallback
  assert.deepEqual(C.reqTabs({ meta: {}, blocks: [s4] }).map(t => t.key), ['all']);
});

test('impact', () => {
  const m = model();
  const i = C.impact(m, 'STF-01.a1');
  assert.equal(i.pd, 5.5); assert.equal(i.unknown, false);
  assert.deepEqual(i.rows, [{ id: 'STF-01', from: 15.5, to: 10, fromCls: 'config', toCls: 'config' }]);
  const g = C.impact(m, 'A-1');
  assert.equal(g.pd, 15.5 - 12); assert.deepEqual(g.rows.map(r => r.id), ['STF-01']); assert.equal(g.unknown, false);
  m.blocks[1].children[0].children.push(req('STF-02', 'Could', 'plugin', 4, 'detailed', 4.5));
  const g2 = C.impact(m, 'A-1');
  assert.equal(g2.unknown, true); assert.equal(g2.pd, 3.5); assert.equal(g2.rows.length, 2);
  assert.equal(C.impact(m, 'STF-01.a2').pd, 0); // already applied
  assert.deepEqual(C.impact(m, 'nope'), { pd: 0, rows: [], unknown: false });
});

test('pending', () => {
  const m = model();
  assert.deepEqual(C.pending(m), { ticks: [], answers: [], count: 0 });
  line(m, 'STF-01.a1').status.state = 'ticked-accept';
  line(m, 'A-1').status.state = 'ticked-reject';
  m.blocks[2].children[0].options[1].checked = true;
  m.blocks[2].children[1].other.checked = true;
  assert.deepEqual(C.pending(m), { ticks: ['A-1', 'STF-01.a1'], answers: ['CQ-1', 'Q-1'], count: 4 });
});

// --- page tabs: the client's own document shape ---------------------------------------------

const fixDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tabsModel = parse(readFileSync(path.join(fixDir, 'rfp-0098-tabs-analysis.md'), 'utf8'));
const legacyModel = parse(readFileSync(path.join(fixDir, 'rfp-0099-mini-analysis.md'), 'utf8'));

test('pageTabs: the seven tabs in navigation order', () => {
  assert.deepEqual(C.pageTabs(tabsModel).map(t => t.key),
    ['overview', 'meta', 'company', 'req', 'nfr', 'integrations', 'glossary']);
});

test('pageTabs: NFR/compliance splits off, the vendor-response PRJ rows stay with Requirements', () => {
  const tabs = C.pageTabs(tabsModel);
  const req = tabs.find(t => t.key === 'req'), nfr = tabs.find(t => t.key === 'nfr');
  assert.deepEqual(req.groups.map(g => g.name), ['Requirements', 'Vendor Response & Evaluation']);
  assert.deepEqual(req.groups.flatMap(g => g.rows.map(r => r.id)), ['GEN-01', 'STF-01', 'PRJ-01']);
  assert.deepEqual(nfr.groups.map(g => g.name), ['Non-functional & Compliance']);
  assert.deepEqual(nfr.groups.flatMap(g => g.rows.map(r => r.id)), ['NFR-01']);
});

test('pageTabs: each tab owns its sections and none is empty in the full grammar', () => {
  const by = Object.fromEntries(C.pageTabs(tabsModel).map(t => [t.key, t]));
  assert.deepEqual(by.meta.sections.map(s => s.title), ['1.1 Meta', '1.3 Source map', '1.4 Ground truth', 'Log']);
  assert.deepEqual(by.company.sections.map(s => s.title), ['1.2 Company & context', 'Global assumptions', 'Approach']);
  assert.deepEqual(by.overview.sections.map(s => s.title), ['Summary']);
  assert.deepEqual(by.integrations.sections.map(s => s.title), ['Integrations']);
  assert.deepEqual(by.glossary.sections.map(s => s.title), ['Glossary']);
  assert.ok(C.pageTabs(tabsModel).every(t => !t.empty));
});

test('pageTabs: a document written before this grammar still exposes every section', () => {
  const tabs = C.pageTabs(legacyModel);
  const by = Object.fromEntries(tabs.map(t => [t.key, t]));
  assert.equal(by.meta.legacySection1, true, 'the flat §1 rides along on Meta');
  assert.deepEqual(by.meta.sections.map(s => s.title), ['Context', 'Log']);
  assert.deepEqual(by.integrations.sections, []);
  assert.equal(by.integrations.empty, true, 'no §8 yet — the page says so instead of rendering blank');
  assert.equal(by.glossary.empty, true);
  // The mini fixture's locator carries no id range, so every row falls into the single `all` group.
  assert.deepEqual(by.req.groups.map(g => g.key), ['all']);
  assert.deepEqual(by.req.groups[0].rows.map(r => r.id), ['STF-01', 'GEN-02', 'CAT-03']);
  assert.equal(by.nfr.empty, true);
});

test('tabOfRow / tabOfSection resolve a deep link to its tab', () => {
  const tabs = C.pageTabs(tabsModel);
  assert.equal(C.tabOfRow(tabs, 'NFR-01'), 'nfr');
  assert.equal(C.tabOfRow(tabs, 'PRJ-01'), 'req');
  assert.equal(C.tabOfRow(tabs, 'nope'), null);
  assert.equal(C.tabOfSection(tabs, 's9'), 'glossary');
  assert.equal(C.tabOfSection(tabs, 's2'), 'overview');
});

test('glossary: terms indexed, slash aliases split, short terms skipped', () => {
  const g = C.glossary(tabsModel);
  assert.equal(g['sku'].meaning.startsWith('Stock keeping unit'), true);
  assert.equal(g['sku'].mapsTo, 'product variant / `ProductEntity` · GEN-01');
  assert.equal(g['packaging unit'].term, 'PU / Packaging unit', 'both spellings resolve to one entry');
  assert.equal(g['pu'], undefined, 'two-character term is not highlighted');
  assert.deepEqual(C.glossary(legacyModel), {}, 'no §9 yields no lookup, not a crash');
});
