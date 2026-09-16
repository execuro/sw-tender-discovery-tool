import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseYaml } from '../lib/yaml.mjs';
import { parse, findBlock, collect, expandRows, toNum, splitRow, slugFromPath, analysisPathFor, hash } from '../lib/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = readFileSync(path.join(here, 'fixtures/rfp-0099-mini-analysis.md'), 'utf8');

const model = parse(FIX, { path: 'specs/rfp-0099-mini-analysis.md' });

test('yaml: scalars, nested maps, inline maps and lists', () => {
  const d = parseYaml('a: 1\nb: text # comment\nc: "x # y"\nd: null\ne: ~\nf: true\nm:\n  k: 2\n  n:\n    deep: v\nl:\n  - {a: 1, b: [x, y], c: null}\n  - plain\ninline: {date: null, files: [], stale: false}\nhash: 0000000000000000\n');
  assert.deepEqual(d, { a: 1, b: 'text', c: 'x # y', d: null, e: null, f: true, m: { k: 2, n: { deep: 'v' } }, l: [{ a: 1, b: ['x', 'y'], c: null }, 'plain'], inline: { date: null, files: [], stale: false }, hash: '0000000000000000' });
});

test('frontmatter', () => {
  const fm = model.frontmatter;
  assert.equal(fm.line, 1);
  assert.equal(fm.endLine, 17);
  assert.ok(fm.raw.startsWith('---\nrfp: RFP-0099') && fm.raw.endsWith('\n---'));
  assert.equal(fm.data.rfp, 'RFP-0099');
  assert.equal(fm.data.confidence, 64);
  assert.deepEqual(fm.data.counts.assumptions, { proposed: 2, accepted: 1, rejected: 0, suspect: 1 });
  assert.equal(fm.data.source[0].file, 'rfp-0099-mini.csv');
  assert.equal(fm.data.source[0].size, 412);
  assert.equal(typeof fm.data.source[0].sha256, 'string');
  assert.deepEqual(fm.data.export, { date: null, files: [], source_sha256: null, stale: false });
  assert.equal(model.title, 'RFP-0099 — Mini GmbH — Mini shop');
  assert.equal(model.rfp, 'RFP-0099');
  assert.equal(model.client, 'Mini GmbH');
  assert.equal(model.project, 'Mini shop');
  assert.equal(model.slug, 'rfp-0099-mini');
});

test('sections s1..s7 with line ranges; unknown section s8', () => {
  const ids = model.blocks.map(s => s.id);
  assert.deepEqual(ids, ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
  const s4 = findBlock(model, 's4');
  assert.equal(s4.n, 4);
  assert.equal(s4.title, 'Requirement analysis');
  assert.equal(s4.line, 69);
  assert.equal(s4.endLine, 81);
  assert.equal(findBlock(model, 's7').endLine, 125);
  assert.equal(s4.hash, hash('Requirement analysis'));
  const m2 = parse(FIX + '\n## 8. Notes\n\nfree text\n\n## Appendix\n\nmore\n');
  assert.equal(findBlock(m2, 's8').title, 'Notes');
  assert.equal(findBlock(m2, 's8').children[0].kind, 'paragraph');
  assert.equal(findBlock(m2, 's-appendix').n, null);
});

test('§4 tree: req rows with typed sub-lines', () => {
  const t4 = findBlock(model, 't4');
  assert.equal(t4.tableKind, 'analysis');
  assert.equal(t4.colIndex.status, 9);
  assert.equal(t4.colIndex['evidence / risk'], 8);
  assert.deepEqual(t4.children.map(r => r.id), ['STF-01', 'GEN-02', 'CAT-03']);
  const stf = findBlock(model, 'STF-01');
  assert.equal(stf.kind, 'req');
  assert.deepEqual(stf.children.map(c => c.id), ['STF-01.a1', 'STF-01.a2', 'STF-01.c1']);
  assert.deepEqual(stf.lmh, { low: 12, mid: 16, high: 22 });
  assert.equal(stf.pd, 15.5);
  assert.equal(stf.prio, 'Must');
  assert.equal(stf.cls, 'custom');
  assert.equal(stf.lvl, 'vague');
  assert.equal(stf.line, 73);
  assert.equal(stf.endLine, 76);
  assert.deepEqual(stf.status, { kind: 'estimated', cq: [] });
  assert.deepEqual(stf.path, ['Requirement analysis', 'table (ID | Kind | Prio)']);
  assert.equal(stf.tableId, 't4');
  const a1 = findBlock(model, 'STF-01.a1');
  assert.equal(a1.kind, 'assume');
  assert.equal(a1.parent, 'STF-01');
  assert.equal(a1.n, 1);
  assert.equal(a1.pdSaved, 5);
  assert.equal(a1.pdSavedRaw, '−5');
  assert.equal(a1.status.state, 'proposed');
  assert.equal(a1.riskTo, 'client');
  assert.equal(a1.raw, FIX.split('\n')[73]);
  assert.deepEqual(a1.path, ['Requirement analysis', 'table (ID | Kind | Prio)', 'STF-01']);
  const a2 = findBlock(model, 'STF-01.a2');
  assert.deepEqual(a2.status, { state: 'accepted', date: '2026-09-01', suspect: false, raw: 'accepted 2026-09-01' });
  assert.equal(a2.cls, 'config');
  const c1 = findBlock(model, 'STF-01.c1');
  assert.equal(c1.kind, 'clarify');
  assert.equal(c1.decision, 'Branch stock shown from synced fields, central stock sellable');
  assert.equal(c1.source, 'client, CQ-2');
  assert.equal(c1.date, '2026-09-04');
  const cat = findBlock(model, 'CAT-03');
  assert.deepEqual(cat.status, { kind: 'provisional', cq: ['CQ-1'] });
  const cs = findBlock(model, 'CAT-03.a1').status;
  assert.equal(cs.state, 'suspect');
  assert.equal(cs.suspect, true);
  const gen = findBlock(model, 'GEN-02');
  assert.equal(gen.cls, 'commitment');
  assert.equal(gen.pd, 0);
  assert.equal(a1.hash, hash('STF-01.a1|' + a1.statement));
  assert.equal(stf.hash, hash('STF-01|' + stf.text));
});

test('§3 global rows', () => {
  const a1 = findBlock(model, 'A-1');
  assert.equal(a1.kind, 'global');
  assert.equal(a1.gkind, 'assume');
  assert.deepEqual(a1.rowsNamed, ['STF-01', 'STF-02', 'STF-03']);
  assert.deepEqual(a1.pdSaved, { total: 4, perRow: { 'STF-01': 3, 'CAT-03': 1 }, raw: 'STF-01 −3 · CAT-03 −1' });
  assert.equal(a1.status.state, 'proposed');
  assert.equal(a1.riskTo, 'client');
  assert.equal(findBlock(model, 'X-1').gkind, 'exclude');
  assert.deepEqual(findBlock(model, 'X-1').status, { state: null, raw: 'rfp' });
  assert.equal(findBlock(model, 'RC-1').gkind, 'clarify');
  assert.equal(findBlock(model, 't3').tableKind, 'global');
});

test('§5 question blocks', () => {
  const cq = findBlock(model, 'CQ-1');
  assert.equal(cq.kind, 'question');
  assert.equal(cq.qkind, 'cq');
  assert.deepEqual(cq.rows, ['CAT-03']);
  assert.equal(cq.blocking, false);
  assert.equal(cq.priority, null);
  assert.equal(cq.question, 'Does the CSV quick order list corrected lines before adding to the cart?');
  assert.deepEqual(cq.options, [
    { letter: 'A', text: 'yes, a correction list is shown first', checked: false, line: 87 },
    { letter: 'B', text: 'no, quantities are corrected silently', checked: false, line: 88 },
  ]);
  assert.deepEqual(cq.other, { text: '', checked: false, line: 89 });
  assert.equal(cq.assume, 'option B');
  assert.equal(cq.line, 85);
  assert.equal(cq.endLine, 90);
  assert.equal(cq.hash, hash('CQ-1|' + cq.question));
  const q = findBlock(model, 'Q-1');
  assert.equal(q.qkind, 'q');
  assert.equal(q.priority, 'high');
  assert.equal(q.blocking, null);
  assert.deepEqual(q.rows, []);
  const ns = collect(model.blocks).find(b => b.notSent);
  assert.deepEqual(ns.notSent, []);
  assert.equal(ns.kind, 'paragraph');
  const m2 = parse(FIX.replace('Not sent — cap: none', 'Not sent — cap: STF-01, CAT-03 (comment)'));
  assert.deepEqual(collect(m2.blocks).find(b => b.notSent).notSent, ['STF-01', 'CAT-03']);
  const ticked = parse(FIX.replace('- [ ] B — no, quantities', '- [x] B — no, quantities'));
  assert.equal(findBlock(ticked, 'CQ-1').options[1].checked, true);
});

test('meta', () => {
  const m = model.meta;
  assert.equal(m.rfp, 'RFP-0099');
  assert.equal(m.status, 'Draft');
  assert.equal(m.confidence, 64);
  assert.equal(m.counts.rows, 3);
  assert.deepEqual(m.counts.assume, { proposed: 2, tickedAccept: 0, tickedReject: 0, accepted: 1, rejected: 0, suspect: 1 });
  assert.deepEqual(m.counts.questions, { client: 1, blocking: 0, blockingOnMust: 0, partner: 1, high: 1 });
  assert.equal(m.counts.clarifications, 2);
  assert.equal(m.counts.req.estimated, 2);
  assert.equal(m.counts.req.provisional, 1);
  assert.equal(m.totals.must, 15.5);
  assert.equal(m.totals.should, 2.5);
  assert.equal(m.totals.could, 0);
  assert.equal(m.totals.services, 0);
  assert.equal(m.totals.total, 18);
  assert.deepEqual(m.overhead, { pct: 10, mode: 'folded', tbd: false });
  assert.deepEqual(m.buffer, { pct: 5, mode: 'separate', tbd: false });
  assert.equal(m.readyGate.ready, false);
  assert.ok(m.readyGate.reasons.some(r => r.startsWith('confidence 64')));
  assert.ok(m.readyGate.reasons.includes('open high Q-1'));
  assert.ok(m.readyGate.reasons.includes('1 suspect line'));
  assert.deepEqual(m.exportState, { exported: false, date: null, files: [], stale: false, gateNow: false });
  assert.deepEqual(m.fmMismatch, []);
  const off = parse(FIX.replace('rows: 3', 'rows: 4').replace('| STF-01.a1 | assume | | | | | −5 |', '| STF-01.a1 | assume | | | | | −5 |').replace('| [ ] |\n| STF-01.a2', '| [x] |\n| STF-01.a2'));
  assert.deepEqual(off.meta.fmMismatch, ['counts.rows: frontmatter 4, document 3', 'counts.assumptions.proposed: frontmatter 2, document 1']);
  assert.ok(off.meta.readyGate.reasons.includes('1 unreconciled tick'));
  const blocking = parse(FIX.replace('### CQ-1 · CAT-03 · blocking: no', '### CQ-1 · STF-01 · blocking: yes'));
  assert.ok(blocking.meta.readyGate.reasons.includes('blocking CQ-1 on Must STF-01'));
  assert.equal(blocking.meta.counts.questions.blockingOnMust, 1);
});

test('req status: queued and analysing', () => {
  const q = parse(FIX.replace('| provisional, CQ-1 |', '| queued |'));
  assert.deepEqual(findBlock(q, 'CAT-03').status, { kind: 'queued', cq: [] });
  assert.equal(q.meta.counts.req.queued, 1);
  assert.equal(q.meta.counts.req.analysing, 0);
  assert.equal(q.meta.counts.req.provisional, 0);
  const a = parse(FIX.replace('| provisional, CQ-1 |', '| analysing, CQ-1 |'));
  assert.deepEqual(findBlock(a, 'CAT-03').status, { kind: 'analysing', cq: ['CQ-1'] });
  assert.equal(a.meta.counts.req.analysing, 1);
});

test('tolerance: bold overhead label, prose PD saved, _TBD_, escapes, ASCII minus, ticked suspect', () => {
  const v = FIX
    .replace('By area: STF: 15.5 · GEN: 0 · CAT: 2.5 · Foundation efforts: none · Overhead / buffer: 10% folded · buffer 5% separate · level buffers 0/10/25% · Plan variants: single variant · Blocking rows: none',
      '**By area:** STF 15.5\n**Overhead / buffer applied:** overhead `_TBD_` (none applied) · risk buffer `_TBD_`\n**Blocking rows:** none')
    .replace('STF-01 −3 · CAT-03 −1', '40 total, per row at acceptance')
    .replace('| vague | 15.5 |', '| vague | `_TBD_` |')
    .replace('Availability is display-only from the async sync, no live ERP call', 'Sync is async \\| display-only<br>no live ERP call')
    .replace('| −5 |', '| -5 |')
    .replace('| [ ] suspect |', '| [x] suspect |');
  const m = parse(v);
  assert.deepEqual(m.meta.overhead, { pct: null, mode: null, tbd: true });
  assert.deepEqual(m.meta.buffer, { pct: null, mode: null, tbd: true });
  const a = findBlock(m, 'A-1');
  assert.equal(a.pdSaved.total, 40);
  assert.equal(a.pdSaved.perRow, null);
  const stf = findBlock(m, 'STF-01');
  assert.equal(stf.pd, null);
  assert.equal(stf.pdRaw, '`_TBD_`');
  const a1 = findBlock(m, 'STF-01.a1');
  assert.equal(a1.statement, 'Sync is async | display-only<br>no live ERP call');
  assert.equal(a1.pdSaved, 5);
  const cs = findBlock(m, 'CAT-03.a1').status;
  assert.equal(cs.state, 'ticked-accept');
  assert.equal(cs.suspect, true);
  assert.equal(m.meta.counts.assume.tickedAccept, 1);
  assert.equal(m.meta.counts.assume.suspect, 1);
  const rej = parse(FIX.replace('| [ ] suspect |', '| [-] suspect |'));
  assert.equal(findBlock(rej, 'CAT-03.a1').status.state, 'ticked-reject');
});

test('fenced code inside a section is not a table', () => {
  const m = parse(FIX.replace('**Source map.**', '```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n\n**Source map.**'));
  const s1 = findBlock(m, 's1');
  assert.equal(s1.children.filter(b => b.kind === 'table').length, 1);
  assert.equal(s1.children.find(b => b.kind === 'code').md.split('\n').length, 5);
  assert.equal(findBlock(m, 't1').tableKind, 'source');
  assert.equal(m.blocks.length, 7);
});

test('helpers', () => {
  assert.deepEqual(expandRows('STF-01..STF-10'), ['STF-01', 'STF-02', 'STF-03', 'STF-04', 'STF-05', 'STF-06', 'STF-07', 'STF-08', 'STF-09', 'STF-10']);
  assert.deepEqual(expandRows('GEN-06, B2B-02..06 · §6; X'), ['GEN-06', 'B2B-02', 'B2B-03', 'B2B-04', 'B2B-05', 'B2B-06']);
  assert.equal(toNum('−5'), -5);
  assert.equal(toNum('15,5 PD'), 15.5);
  assert.equal(toNum('`_TBD_`'), null);
  assert.equal(toNum(''), null);
  assert.deepEqual(splitRow('| a \\| b | `c|d` | e |'), ['a | b', '`c|d`', 'e']);
  assert.equal(slugFromPath('specs/rfp-0001-x-analysis.md'), 'rfp-0001-x');
  assert.equal(slugFromPath('/abs/rfp-0001-x.xlsx'), 'rfp-0001-x');
  assert.equal(slugFromPath('specs/0001-cart.md'), null);
  assert.equal(analysisPathFor('specs/rfp-0001-x.csv'), 'specs/rfp-0001-x-analysis.md');
  assert.equal(analysisPathFor('specs/rfp-0001-x-analysis.md'), 'specs/rfp-0001-x-analysis.md');
  const dup = parse(FIX.replace('| GEN-02 | req |', '| STF-01 | req |'));
  assert.ok(findBlock(dup, 'STF-01~2'));
});

test('a full analysis document parses with every invariant intact', () => {
  const file = path.join(here, 'fixtures/rfp-0099-mini-analysis.md');
  const text = readFileSync(file, 'utf8');
  const m = parse(text, { path: 'specs/rfp-0099-mini-analysis.md' });
  const all = collect(m.blocks);
  // Invariants, never exact counts: the fixture may grow without breaking this.
  assert.ok(all.filter(b => b.kind === 'req').length > 0);
  assert.ok(all.filter(b => b.kind === 'assume').length > 0);
  assert.equal(all.filter(b => b.orphan).length, 0);
  assert.equal(typeof m.meta.totals.must, 'number');
  for (const b of all.filter(b => b.kind === 'assume' && b.parent)) {
    assert.ok(findBlock(m, b.parent), `assume ${b.id} has a parent row`);
  }
  for (const b of all.filter(b => b.kind === 'req')) {
    assert.ok(b.status.kind !== null || b.statusRaw === '', `req ${b.id} has a known status (${b.statusRaw})`);
  }
});

// --- client-tab grammar (§1.1/§1.2/§8/§9) --------------------------------------------------
const TABS = readFileSync(path.join(here, 'fixtures/rfp-0098-tabs-analysis.md'), 'utf8');
const tabsModel = parse(TABS, { path: 'specs/rfp-0098-tabs-analysis.md' });

test('nine sections parse, §8 and §9 included', () => {
  const ids = tabsModel.blocks.filter(b => b.kind === 'section').map(b => b.id);
  assert.deepEqual(ids, ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
});

test('§1 carries the four fixed subsections as nested sections', () => {
  const titles = findBlock(tabsModel, 's1').children.filter(b => b.kind === 'section').map(b => b.title);
  assert.deepEqual(titles, ['1.1 Meta', '1.2 Company & context', '1.3 Source map', '1.4 Ground truth']);
});

test('tableKind types the client-owned tables', () => {
  const kinds = collect(tabsModel.blocks).filter(b => b.kind === 'table').map(b => b.tableKind);
  for (const k of ['meta', 'params', 'migration', 'integration', 'glossary', 'source', 'analysis', 'global', 'log']) {
    assert.ok(kinds.includes(k), `missing tableKind ${k} (got ${kinds.join(', ')})`);
  }
});

test('a params row keeps its _not provided_ status cell verbatim', () => {
  const t = collect(tabsModel.blocks).find(b => b.kind === 'table' && b.tableKind === 'params');
  const row = t.children.find(r => r.cells[0] === 'P-12');
  assert.equal(row.cells[t.colIndex['value']], '_not provided_');
  assert.equal(row.cells[t.colIndex['status']], '_not provided_ ⚠ CQ-1');
});
