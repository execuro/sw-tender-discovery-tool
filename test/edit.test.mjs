import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, findBlock } from '../lib/parse.mjs';
import { splitRaw, joinRaw, setCell, tick, answer, propose, snapshot, verifyAndRepair } from '../lib/edit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = readFileSync(path.join(here, 'fixtures/rfp-0099-mini-analysis.md'), 'utf8');
const L = t => t.split('\n');
const diffLines = (a, b) => { const x = L(a), y = L(b); assert.equal(x.length, y.length, 'line count'); return x.map((l, i) => (l === y[i] ? -1 : i + 1)).filter(i => i > 0); };

test('splitRaw / joinRaw / setCell keep bytes', () => {
  const line = '|  STF-01.a1 | assume | | `a|b` | x \\| y |   [ ]   |';
  const p = splitRaw(line);
  assert.equal(p.lead, '|');
  assert.equal(p.trail, '|');
  assert.deepEqual(p.cells, ['  STF-01.a1 ', ' assume ', ' ', ' `a|b` ', ' x \\| y ', '   [ ]   ']);
  assert.equal(joinRaw(p), line);
  assert.equal(setCell(line, 5, '[x]'), '|  STF-01.a1 | assume | | `a|b` | x \\| y |   [x]   |');
  assert.equal(setCell(line, 2, 'a|b'), '|  STF-01.a1 | assume | a\\|b | `a|b` | x \\| y |   [ ]   |');
  assert.equal(setCell(line, 1, ''), '|  STF-01.a1 | | | `a|b` | x \\| y |   [ ]   |');
  assert.equal(splitRaw('  | a | b |  ').lead, '  |');
  assert.equal(splitRaw('  | a | b |  ').trail, '|  ');
});

test('tick round trip changes exactly one line and keeps padding', () => {
  const padded = FIX.replace('| risk to client | [ ] |\n| STF-01.a2', '| risk to client |   [ ]   |\n| STF-01.a2');
  const r1 = tick(padded, 'STF-01.a1', 'x');
  assert.equal(r1.changed, true);
  assert.equal(r1.line, 74);
  assert.deepEqual(diffLines(padded, r1.text), [74]);
  assert.ok(L(r1.text)[73].endsWith('| risk to client |   [x]   |'));
  assert.equal(findBlock(parse(r1.text), 'STF-01.a1').status.state, 'ticked-accept');
  const r2 = tick(r1.text, 'STF-01.a1', '-');
  assert.deepEqual(diffLines(r1.text, r2.text), [74]);
  assert.equal(findBlock(parse(r2.text), 'STF-01.a1').status.state, 'ticked-reject');
  const r3 = tick(r2.text, 'STF-01.a1', ' ');
  assert.deepEqual(diffLines(r2.text, r3.text), [74]);
  assert.equal(r3.text, padded);
  assert.equal(tick(FIX, 'STF-01.a1', ' ').changed, false);
});

test('tick: frozen, suspect suffix, global, unknown', () => {
  const f = tick(FIX, 'STF-01.a2', 'x');
  assert.equal(f.changed, false);
  assert.equal(f.reason, 'frozen');
  assert.equal(f.text, FIX);
  const s = tick(FIX, 'CAT-03.a1', 'x');
  assert.ok(L(s.text)[78].endsWith('| [x] suspect |'));
  assert.equal(findBlock(parse(s.text), 'CAT-03.a1').status.suspect, true);
  const g = tick(FIX, 'A-1', 'x');
  assert.deepEqual(diffLines(FIX, g.text), [65]);
  assert.equal(findBlock(parse(g.text), 'A-1').status.state, 'ticked-accept');
  assert.equal(tick(FIX, 'NOPE-1', 'x').reason, 'not found');
  assert.equal(tick(FIX, 'STF-01', 'x').reason, 'not an assumption');
  assert.equal(tick(FIX, 'X-1', 'x').reason, 'not an assumption');
});

test('answer: single select, other, clear', () => {
  const b = answer(FIX, 'CQ-1', { option: 'B' });
  assert.equal(b.changed, true);
  assert.deepEqual(diffLines(FIX, b.text), [88]);
  let q = findBlock(parse(b.text), 'CQ-1');
  assert.deepEqual(q.options.map(o => o.checked), [false, true]);
  const o = answer(b.text, 'CQ-1', { other: 'text' });
  assert.deepEqual(diffLines(b.text, o.text), [88, 89]);
  assert.equal(L(o.text)[88], '- [x] Other: text');
  q = findBlock(parse(o.text), 'CQ-1');
  assert.deepEqual(q.options.map(x => x.checked), [false, false]);
  assert.deepEqual(q.other, { text: 'text', checked: true, line: 89 });
  const a = answer(o.text, 'CQ-1', { option: 'A', other: '' });
  q = findBlock(parse(a.text), 'CQ-1');
  assert.deepEqual(q.options.map(x => x.checked), [true, false]);
  assert.equal(L(a.text)[88], '- [ ] Other:');
  const c = answer(a.text, 'CQ-1', {});
  assert.equal(c.text, FIX);
  assert.equal(answer(FIX, 'CQ-1', {}).changed, false);
  assert.equal(answer(FIX, 'CQ-9', { option: 'A' }).reason, 'not found');
  assert.equal(answer(FIX, 'CQ-1', { option: 'Z' }).reason, 'option not found');
  assert.equal(answer(FIX, 'STF-01', { option: 'A' }).reason, 'not found');
});

test('propose under a req', () => {
  const r = propose(FIX, { row: 'STF-01', statement: ' Sync is  async\n display-only | no ERP ', pdSaved: 4, riskTo: 'client' });
  assert.equal(r.changed, true);
  assert.equal(r.id, 'STF-01.a3');
  assert.equal(r.line, 77);
  const lines = L(r.text);
  assert.equal(lines.length, L(FIX).length + 1);
  assert.equal(lines[75], L(FIX)[75]);
  assert.equal(lines[76], '| STF-01.a3 | assume | | | | | −4 | Sync is  async display-only \\| no ERP | risk to client; partner | [ ] |');
  assert.equal(lines[77], L(FIX)[76]);
  const m = parse(r.text);
  const a3 = findBlock(m, 'STF-01.a3');
  assert.equal(a3.parent, 'STF-01');
  assert.equal(a3.pdSaved, 4);
  assert.equal(a3.statement, 'Sync is  async display-only | no ERP');
  assert.equal(a3.status.state, 'proposed');
  assert.equal(a3.cells.length, 10);
  assert.equal(findBlock(m, 'STF-01').endLine, 77);
  const r2 = propose(FIX, { row: 'CAT-03', statement: 'x', cls: 'config' });
  assert.equal(r2.id, 'CAT-03.a2');
  assert.equal(L(r2.text)[79], '| CAT-03.a2 | assume | | config | | | | x | risk to client; partner | [ ] |');
  assert.equal(propose(FIX, { row: 'STF-01', statement: '  ' }).reason, 'empty statement');
  assert.equal(propose(FIX, { row: 'ZZZ-1', statement: 'x' }).reason, 'row not found');
  assert.equal(propose(FIX, { row: 'STF-01.a1', statement: 'x' }).reason, 'row not found');
});

test('propose global', () => {
  const r = propose(FIX, { statement: 'No pixel-perfect', pdSaved: 2, riskTo: 'client', rows: ['STF-01', 'CAT-03'] });
  assert.equal(r.id, 'A-2');
  assert.equal(r.line, 68);
  const lines = L(r.text);
  assert.equal(lines[66], L(FIX)[66]);
  assert.equal(lines[67], '| A-2 | assume | STF-01, CAT-03 | No pixel-perfect | 2 | client (partner) | [ ] |');
  assert.equal(lines[68], '');
  const g = findBlock(parse(r.text), 'A-2');
  assert.equal(g.kind, 'global');
  assert.deepEqual(g.rowsNamed, ['STF-01', 'CAT-03']);
  assert.equal(g.pdSaved.total, 2);
  const one = propose(FIX, { statement: 'x', pdSaved: 3, rows: ['STF-01'] });
  assert.equal(L(one.text)[67], '| A-2 | assume | STF-01 | x | STF-01 −3 | client (partner) | [ ] |');
  assert.deepEqual(findBlock(parse(one.text), 'A-2').pdSaved.perRow, { 'STF-01': 3 });
  const none = propose(FIX, { statement: 'x', riskTo: 'ERP partner' });
  assert.equal(L(none.text)[67], '| A-2 | assume | global | x | | ERP partner (partner) | [ ] |');
  assert.equal(propose(FIX.replace('## 3. Global assumptions', '## 3. Nothing').replace('| ID | Kind | Rows | Statement | PD saved | Risk to | Status |', '| a | b |'), { statement: 'x' }).reason, 'global table not found');
});

test('propose exclude: non-tickable X-n line in §3, fixture stays parseable', () => {
  const r = propose(FIX, { statement: 'Hosting is provided by the client (RFP section 4)', rows: ['GEN-02'], kind: 'exclude' });
  assert.equal(r.changed, true);
  assert.equal(r.id, 'X-2');
  assert.equal(r.line, 68);
  assert.equal(L(r.text)[67], '| X-2 | exclude | GEN-02 | Hosting is provided by the client (RFP section 4) | | | rfp |');
  const m = parse(r.text);
  const x2 = findBlock(m, 'X-2');
  assert.equal(x2.kind, 'global');
  assert.equal(x2.gkind, 'exclude');
  assert.deepEqual(x2.rowsNamed, ['GEN-02']);
  assert.deepEqual(x2.status, { state: null, raw: 'rfp' });
  const global = propose(FIX, { statement: 'What the RFP excludes overall', kind: 'exclude' });
  assert.equal(L(global.text)[67], '| X-2 | exclude | global | What the RFP excludes overall | | | rfp |');
  assert.equal(propose(FIX, { row: 'STF-01', statement: 'x', kind: 'exclude' }).reason, 'exclude must be global');
  assert.equal(propose(FIX, { statement: 'x', kind: 'bogus' }).reason, 'invalid kind');
  assert.equal(propose(FIX, { statement: '', kind: 'exclude' }).reason, 'empty statement');
});

test('snapshot', () => {
  const t = answer(tick(FIX, 'STF-01.a1', 'x').text, 'CQ-1', { option: 'B' }).text;
  const p = propose(t, { row: 'STF-01', statement: 'mine' });
  const snap = snapshot(p.text, { proposed: [p.id, 'GHOST-1.a9'] });
  assert.ok(snap.frontmatter.startsWith('---\n'));
  assert.deepEqual(snap.frozen, { 'STF-01.a2': 'accepted 2026-09-01' });
  assert.deepEqual(snap.ticks, { 'STF-01.a1': 'x' });
  assert.deepEqual(snap.answers, { 'CQ-1': { option: 'B', other: null } });
  assert.deepEqual(Object.keys(snap.pageProposed), ['STF-01.a3']);
  assert.ok(snap.pageProposed['STF-01.a3'].startsWith('| STF-01.a3 | assume |'));
  assert.deepEqual(snap.sections, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(snap.hashes['STF-01'], findBlock(parse(FIX), 'STF-01').hash);
});

test('verifyAndRepair', () => {
  const ticked = tick(FIX, 'STF-01.a1', 'x').text;
  const answered = answer(ticked, 'CQ-1', { option: 'B' }).text;
  const proposed = propose(answered, { row: 'STF-01', statement: 'mine', pdSaved: 1 });
  const base = proposed.text;
  const snap = snapshot(base, { proposed: [proposed.id] });

  // (a) tick reverted → restored
  let r = verifyAndRepair(tick(base, 'STF-01.a1', ' ').text, snap);
  assert.deepEqual(r.repairs, ['restored tick [x] on STF-01.a1']);
  assert.equal(r.text, base);
  assert.deepEqual(r.warnings, []);
  // consumed tick (accepted) is left alone
  r = verifyAndRepair(base.replace('| risk to client | [x] |', '| risk to client | accepted 2026-09-05 |'), snap);
  assert.deepEqual(r.repairs, []);

  // (b) frozen a2 changed → restored
  const broken = base.replace('| accepted 2026-09-01 |', '| [ ] |');
  r = verifyAndRepair(broken, snap);
  assert.deepEqual(r.repairs, ['restored frozen status on STF-01.a2']);
  assert.equal(r.text, base);

  // (c) a2 line deleted → warning only
  const without = L(base).filter(l => !l.startsWith('| STF-01.a2 ')).join('\n');
  r = verifyAndRepair(without, snap);
  assert.deepEqual(r.repairs, []);
  assert.deepEqual(r.warnings, ['frozen line STF-01.a2 removed']);
  assert.equal(r.text, without);

  // (d) CQ-1 block deleted after an answer → nothing
  const noCq = base.replace(/### CQ-1[\s\S]*?Until answered we assume option B\.\n\n/, '');
  r = verifyAndRepair(noCq, snap);
  assert.deepEqual(r.repairs, []);
  assert.equal(r.text, noCq);
  // answer lost while the block exists → restored
  r = verifyAndRepair(answer(base, 'CQ-1', {}).text, snap);
  assert.deepEqual(r.repairs, ['restored answer on CQ-1']);
  assert.equal(r.text, base);

  // (e) page-proposed a3 removed while STF-01 exists → re-inserted at the same place
  const noA3 = L(base).filter(l => !l.startsWith('| STF-01.a3 ')).join('\n');
  r = verifyAndRepair(noA3, snap);
  assert.deepEqual(r.repairs, ['re-inserted proposed line STF-01.a3']);
  assert.equal(r.text, base);
  // req gone as well → warning only
  const noReq = L(base).filter(l => !l.startsWith('| STF-01')).join('\n');
  r = verifyAndRepair(noReq, snap);
  assert.ok(r.warnings.includes('proposed line STF-01.a3 removed with its parent'));

  // (f) frontmatter removed → re-inserted
  const noFm = base.replace(/^---[\s\S]*?\n---\n/, '');
  r = verifyAndRepair(noFm, snap);
  assert.deepEqual(r.repairs, ['restored frontmatter']);
  assert.equal(r.text, base);

  // (g) §6 heading removed → warning
  r = verifyAndRepair(base.replace('## 6. Approach\n', ''), snap);
  assert.deepEqual(r.repairs, []);
  assert.deepEqual(r.warnings, ['section 6 missing']);

  // untouched document → no-op
  r = verifyAndRepair(base, snap);
  assert.deepEqual(r, { text: base, repairs: [], warnings: [] });
  assert.deepEqual(verifyAndRepair(base, null), { text: base, repairs: [], warnings: [] });
});

// --- §8 / §9 are guarded like any other section ----------------------------------------------
const TABS = readFileSync(path.join(here, 'fixtures/rfp-0098-tabs-analysis.md'), 'utf8');

test('snapshot / verifyAndRepair cover the nine-section grammar', () => {
  const snap = snapshot(TABS, {});
  assert.deepEqual(snap.sections, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // A run that drops the Integrations section is reported, not silently accepted.
  let r = verifyAndRepair(TABS.replace('## 8. Integrations\n', ''), snap);
  assert.deepEqual(r.warnings, ['section 8 missing']);
  r = verifyAndRepair(TABS.replace('## 9. Glossary\n', ''), snap);
  assert.deepEqual(r.warnings, ['section 9 missing']);

  // Untouched document: no repairs, no warnings.
  r = verifyAndRepair(TABS, snap);
  assert.deepEqual([r.repairs, r.warnings], [[], []]);
  assert.equal(r.text, TABS);
});

test('ticking in the new grammar leaves §1.1, §1.2, §8 and §9 byte-identical', () => {
  const r = tick(TABS, 'A-1', 'x');
  assert.equal(r.changed, true);
  const cut = s => s.slice(s.indexOf('### 1.1 Meta'), s.indexOf('## 2. Summary'));
  assert.equal(cut(r.text), cut(TABS));
  assert.equal(r.text.slice(r.text.indexOf('## 8. Integrations')), TABS.slice(TABS.indexOf('## 8. Integrations')));
});
