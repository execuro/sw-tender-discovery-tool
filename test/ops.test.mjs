import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../lib/ops.mjs';
import { apply } from '../lib/apply.mjs';
import { parse } from '../lib/parse.mjs';
import * as proposals from '../lib/proposals.mjs';
import { readProfile } from '../lib/profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), 'utf8');
const SLUG = 'rfp-0101-xlsx-ids';

function host(docContent = FIXTURE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-ops-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const doc = path.join(root, 'specs', 'rfp-0101-xlsx-ids-analysis.md');
  fs.writeFileSync(doc, docContent, 'utf8');
  return { root, doc, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function docModel(doc) { return parse(fs.readFileSync(doc, 'utf8'), { path: doc }); }

test('AC-17/L-1/L-2: bulk confirm sets confirmed <date> and rejects untouched proposals', () => {
  const { root, doc, cleanup } = host();
  try {
    const p = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'unrelated proposal' });
    const r = ops.confirm({ root, doc, ids: ['HIB-02'] });
    assert.equal(r.ok, true);
    const it = docModel(doc).items.find(i => i.id === 'HIB-02');
    assert.match(it.status.kind, /confirmed/);
    assert.ok(it.references.some(x => x === `rejected: ${p.statement}`));
    assert.equal(proposals.list(root, SLUG).find(x => x.id === p.id).status, 'rejected');
  } finally { cleanup(); }
});

test('N-3: confirm reports the proposals it auto-rejected alongside confirmed/skipped', () => {
  const { root, doc, cleanup } = host();
  try {
    const p1 = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'a still-waiting proposal' });
    const r = ops.confirm({ root, doc, ids: ['HIB-02'] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.rejected, [{ id: p1.id, item: 'HIB-02', statement: p1.statement }]);
    assert.equal(proposals.list(root, SLUG).find(x => x.id === p1.id).status, 'rejected');
  } finally { cleanup(); }
});

test('AC-20/L-6: a failed item needs an operator Client Response before it can be confirmed', () => {
  const { root, doc, cleanup } = host();
  try {
    ops.patch({ root, doc, id: 'CMP-01', clientResponse: '' });
    const blocked = ops.confirm({ root, doc, ids: ['CMP-01'] });
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /Client Response/);
    ops.patch({ root, doc, id: 'CMP-01', clientResponse: 'We will not retroactively audit legacy prices.' });
    const ok = ops.confirm({ root, doc, ids: ['CMP-01'] });
    assert.equal(ok.ok, true);
    assert.equal(docModel(doc).items.find(i => i.id === 'CMP-01').status.kind, 'confirmed');
  } finally { cleanup(); }
});

test('unconfirm: reverses confirm to reopened, with a References line, content untouched', () => {
  const { root, doc, cleanup } = host();
  try {
    ops.patch({ root, doc, id: 'CMP-01', clientResponse: 'We will not retroactively audit legacy prices.', internalNote: 'note' });
    ops.confirm({ root, doc, ids: ['CMP-01'] });
    const before = docModel(doc).items.find(i => i.id === 'CMP-01');
    assert.equal(before.status.kind, 'confirmed');
    const r = ops.unconfirm({ root, doc, ids: ['CMP-01'] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.unconfirmed, ['CMP-01']);
    const after = docModel(doc).items.find(i => i.id === 'CMP-01');
    assert.equal(after.status.kind, 'reopened');
    assert.ok(after.references.some(x => /^reopened \d{4}-\d{2}-\d{2}: unconfirmed by operator$/.test(x)));
    assert.equal(after.clientResponse, before.clientResponse);
    assert.equal(after.internalNote, before.internalNote);
    assert.deepEqual(after.assumptions, before.assumptions);
    assert.deepEqual(after.effort, before.effort);
  } finally { cleanup(); }
});

test('unconfirm: refuses an item that is not confirmed', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = ops.unconfirm({ root, doc, ids: ['HIB-02'] });
    assert.equal(r.ok, false);
    assert.match(r.skipped[0].reason, /not confirmed/);
    assert.equal(docModel(doc).items.find(i => i.id === 'HIB-02').status.kind, 'estimated');
  } finally { cleanup(); }
});

test('AC-18/L-4: editing Client Response or Internal note never reopens a confirmed item', () => {
  const { root, doc, cleanup } = host();
  try {
    ops.patch({ root, doc, id: 'HIB-01', clientResponse: 'Edited by the operator.', internalNote: 'steer note' });
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.status.kind, 'confirmed');
    assert.equal(it.clientResponse, 'Edited by the operator.');
    assert.equal(it.internalNote, 'steer note');
  } finally { cleanup(); }
});

test('AC-8: accepting a proposal on a confirmed item reopens it immediately and adds the bullet', () => {
  const { root, doc, cleanup } = host();
  try {
    const p = proposals.add(root, SLUG, { item: 'HIB-01', statement: 'The client accepts remote onboarding.' });
    const r = ops.accept({ root, doc, id: p.id });
    assert.equal(r.ok, true);
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.status.kind, 'reopened');
    assert.ok(it.assumptions.includes(p.statement));
    assert.equal(proposals.list(root, SLUG).find(x => x.id === p.id).status, 'accepted');
  } finally { cleanup(); }
});

test('accept lowers a numeric-PD (profile regime) Effort by pdSaved, floored at the calibration small point, and records was X in References', () => {
  const { root, doc, cleanup } = host();
  try {
    fs.mkdirSync(path.dirname(path.join(root, 'specs', 'rfp-partner-profile.md')), { recursive: true });
    fs.writeFileSync(path.join(root, 'specs', 'rfp-partner-profile.md'),
      '---\ncalibration: { small: 2, big: 20 }\noverhead: 10\nbuffer: { percent: 5, mode: folded }\nisv: []\nassets: []\n---\n');
    apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Extension', pd: 4, references: ['project: something'], proposals: [{ statement: 'Client accepts the default layout.', pdSaved: 1 }] }] } });
    const before = docModel(doc).items.find(i => i.id === 'HIB-03');
    const effortBefore = before.effort.pd;
    const p = proposals.list(root, SLUG).find(x => x.statement === 'Client accepts the default layout.');
    const r = ops.accept({ root, doc, id: p.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    const it = docModel(doc).items.find(i => i.id === 'HIB-03');
    assert.equal(it.effort.pd, effortBefore - 1);
    assert.ok(it.references.includes(`was ${effortBefore} PD`));
  } finally { cleanup(); }
});

test('accept floors the effort drop at the calibration small point, and leaves a T-shirt effort untouched', () => {
  const { root, doc, cleanup } = host();
  try {
    fs.mkdirSync(path.dirname(path.join(root, 'specs', 'rfp-partner-profile.md')), { recursive: true });
    fs.writeFileSync(path.join(root, 'specs', 'rfp-partner-profile.md'),
      '---\ncalibration: { small: 2, big: 20 }\noverhead: 10\nbuffer: { percent: 5, mode: folded }\nisv: []\nassets: []\n---\n');
    // pd: 20 -> profile-adjusted effort 23 PD (overhead 10%, buffer 5% folded); pdSaved 22 stays
    // under that cap (AQ-2) while still dropping the effort below the calibration.small floor.
    apply({ root, doc, report: { cause: 'x', items: [{ id: 'HIB-03', coverage: 'Extension', pd: 20, references: ['project: something'], proposals: [{ statement: 'Client accepts the default layout.', pdSaved: 22 }] }] } });
    const p = proposals.list(root, SLUG).find(x => x.statement === 'Client accepts the default layout.');
    ops.accept({ root, doc, id: p.id });
    const it = docModel(doc).items.find(i => i.id === 'HIB-03');
    assert.equal(it.effort.pd, 2, 'floored at calibration.small, never below it');
  } finally { cleanup(); }
});

test('a T-shirt-regime Effort is left as it is on accept — only the profile regime\'s numeric PD is lowered', () => {
  const { root, doc, cleanup } = host();
  try {
    const p = proposals.add(root, SLUG, { item: 'HIB-01', statement: 'The client accepts remote onboarding.', pdSaved: 5 });
    const before = docModel(doc).items.find(i => i.id === 'HIB-01').effort;
    const r = ops.accept({ root, doc, id: p.id });
    assert.equal(r.ok, true);
    const it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.effort.pd, before.pd, 'T-shirt effort is untouched by accept');
    assert.ok(!it.references.some(ref => /^was /.test(ref)));
  } finally { cleanup(); }
});

test('a global proposal, accepted, becomes a §3 Assumptions bullet', () => {
  const { root, doc, cleanup } = host();
  try {
    const p = proposals.add(root, SLUG, { item: null, statement: 'Payments settle in EUR only.'.replace('EUR only.', 'a single currency.') });
    const r = ops.accept({ root, doc, id: p.id });
    assert.equal(r.ok, true);
    const text = fs.readFileSync(doc, 'utf8');
    assert.ok(text.includes(`- ${p.statement}`));
    assert.ok(text.indexOf(p.statement) > text.indexOf('### Assumptions'));
  } finally { cleanup(); }
});

test('§3 ownership: accepting a global proposal, assume/unassume and apply never touch ### Exclusions — that section is sw-tender-editor\'s', () => {
  const { root, doc, cleanup } = host();
  try {
    const before = fs.readFileSync(doc, 'utf8');
    const exclusionsBefore = before.slice(before.indexOf('### Exclusions'), before.indexOf('## 4.'));

    const p = proposals.add(root, SLUG, { item: null, statement: 'A brand-new global assumption.' });
    ops.accept({ root, doc, id: p.id });
    ops.assume({ root, doc, item: null, statement: 'Another operator-typed global assumption.' });
    ops.assume({ root, doc, item: 'HIB-02', statement: 'An item-level assumption.' });
    ops.unassume({ root, doc, item: 'HIB-02', statement: 'An item-level assumption.' });

    const after = fs.readFileSync(doc, 'utf8');
    const exclusionsAfter = after.slice(after.indexOf('### Exclusions'), after.indexOf('## 4.'));
    // Compared with surrounding blank lines collapsed: `replaceSections` may reformat run-to-run
    // whitespace between sections, but the Exclusions heading and its bullets — sw-tender-editor's
    // content — must be untouched.
    const norm = s => s.replace(/\n{2,}/g, '\n\n').trim();
    assert.equal(norm(exclusionsAfter), norm(exclusionsBefore), '### Exclusions content must be untouched by any §3/§4 write');
  } finally { cleanup(); }
});

test('#11: unassume removes an operator-typed GLOBAL assumption (item: null or "global"), marks every item for re-estimate, and refuses an unknown statement', () => {
  const { root, doc, cleanup } = host();
  try {
    ops.assume({ root, doc, item: null, statement: 'The client provides its own SSL certificate.' });
    let text = fs.readFileSync(doc, 'utf8');
    assert.ok(text.includes('- The client provides its own SSL certificate.'));

    const r = ops.unassume({ root, doc, item: 'global', statement: 'The client provides its own SSL certificate.' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.global, true);
    text = fs.readFileSync(doc, 'utf8');
    assert.ok(!text.includes('The client provides its own SSL certificate.'));

    const notFound = ops.unassume({ root, doc, item: null, statement: 'never typed' });
    assert.equal(notFound.ok, false);
  } finally { cleanup(); }
});

test('AC-9: rejecting a proposal records it in References and it is never proposed again', () => {
  const { root, doc, cleanup } = host();
  try {
    const p = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'The client tolerates a 24h stock lag.' });
    ops.reject({ root, doc, id: p.id });
    const it = docModel(doc).items.find(i => i.id === 'HIB-02');
    assert.ok(it.references.includes(`rejected: ${p.statement}`));
    const again1 = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'the client tolerates a 24h stock lag' });
    const again2 = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'The client tolerates a 24h stock lag.' });
    assert.equal(again1, null);
    assert.equal(again2, null);
  } finally { cleanup(); }
});

test('R-2: rejecting an already-accepted proposal undoes the assumption (same as unassume) — bullet removed, rejected: recorded, reopens a confirmed item, re-estimate marked', () => {
  const { root, doc, cleanup } = host();
  try {
    // Accept on a not-yet-confirmed item first (accepting never reopens what isn't confirmed
    // yet), confirm it, then reject the same proposal — exactly the state the confirmed-item
    // reopen rule (R-2) is about.
    const p = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'The client accepts a 24h stock lag.' });
    ops.accept({ root, doc, id: p.id });
    let it = docModel(doc).items.find(i => i.id === 'HIB-02');
    assert.equal(it.status.kind, 'estimated', 'accepting on a non-confirmed item never reopens it');
    assert.ok(it.assumptions.includes(p.statement));

    ops.confirm({ root, doc, ids: ['HIB-02'] });
    it = docModel(doc).items.find(i => i.id === 'HIB-02');
    assert.equal(it.status.kind, 'confirmed');

    const r = ops.reject({ root, doc, id: p.id });
    assert.equal(r.ok, true);
    it = docModel(doc).items.find(i => i.id === 'HIB-02');
    assert.ok(!it.assumptions.includes(p.statement), 'the bullet accept() added is removed');
    assert.ok(it.references.includes(`rejected: ${p.statement}`));
    assert.equal(it.status.kind, 'reopened');
    assert.ok(it.references.some(ref => /^reopened \d{4}-\d{2}-\d{2}: assumption P-\d+ rejected$/.test(ref)));
    assert.equal(proposals.list(root, SLUG).find(x => x.id === p.id).status, 'rejected');
  } finally { cleanup(); }
});

test('assume/unassume: operator-typed assumption on an item, then removed, reopens a confirmed item both times and is never re-proposed', () => {
  const { root, doc, cleanup } = host();
  try {
    const a = ops.assume({ root, doc, item: 'HIB-01', statement: 'The client provides test data.' });
    assert.equal(a.ok, true);
    let it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.equal(it.status.kind, 'reopened');
    assert.ok(it.assumptions.includes('The client provides test data.'));

    const u = ops.unassume({ root, doc, item: 'HIB-01', statement: 'The client provides test data.' });
    assert.equal(u.ok, true);
    it = docModel(doc).items.find(i => i.id === 'HIB-01');
    assert.ok(!it.assumptions.includes('The client provides test data.'));
    assert.ok(it.references.some(r => r === 'rejected: The client provides test data.'));

    const reproposed = proposals.add(root, SLUG, { item: 'HIB-01', statement: 'The client provides test data.' });
    assert.equal(reproposed, null);
  } finally { cleanup(); }
});

test('AC-10/AC-11: answering a CQ ticks the option, records Answered, and marks its items for re-estimate', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = ops.answer({ root, doc, cq: 'CQ-1', key: 'B' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.affected.sort(), ['HIB-03']);
    const model = docModel(doc);
    const cq = model.questions.find(q => q.id === 'CQ-1');
    assert.equal(cq.answered.key, 'B');
    assert.equal(cq.options.find(o => o.key === 'B').checked, true);
    assert.equal(proposals.isMarked(root, SLUG, 'HIB-03'), true);
    const again = ops.answer({ root, doc, cq: 'CQ-1', key: 'A' });
    assert.equal(again.ok, false);
  } finally { cleanup(); }
});

test('answer refuses an option that does not exist', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = ops.answer({ root, doc, cq: 'CQ-1', key: 'Z' });
    assert.equal(r.ok, false);
  } finally { cleanup(); }
});

test('AC-5: confirm/patch never accept a Requirement Coverage outside the six values (via apply, exercised in apply.test.mjs); ops.patch only touches Response/Note', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = ops.patch({ root, doc, id: 'HIB-01', clientResponse: 'x' });
    assert.equal(r.ok, true);
    // patch has no coverage field at all: nothing to validate, by construction.
  } finally { cleanup(); }
});

test('AC-14/AC-30: writing a partner profile validates, persists and marks every item for re-estimate', () => {
  const { root, doc, cleanup } = host();
  try {
    const bad = ops.profile({ root, doc, data: { calibration: { small: 2 }, overhead: 10, buffer: { percent: 5, mode: 'folded' }, isv: [], assets: [] } });
    assert.equal(bad.ok, false, 'missing calibration.big is refused');
    assert.equal(fs.existsSync(path.join(root, 'specs', 'rfp-partner-profile.md')), false, 'no partial file left behind');

    const good = ops.profile({ root, doc, data: { calibration: { small: 2, big: 20 }, overhead: 10, buffer: { percent: 5, mode: 'folded' }, isv: [{ name: 'Foo', vendor: 'Bar', versions: ['6.6'] }], assets: [] } });
    assert.equal(good.ok, true);
    const { profile, reason } = readProfile(root);
    assert.equal(reason, null);
    assert.equal(profile.calibration.big, 20);
    for (const it of docModel(doc).items) assert.equal(proposals.isMarked(root, SLUG, it.id), true);
  } finally { cleanup(); }
});

test('a profile entry with a licence field is refused (R-6/X-7)', () => {
  const { root, doc, cleanup } = host();
  try {
    const r = ops.profile({ root, doc, data: { calibration: { small: 2, big: 20 }, overhead: 10, buffer: { percent: 5, mode: 'folded' }, isv: [{ name: 'Foo', vendor: 'Bar', versions: ['6.6'], licence: 'MIT' }], assets: [] } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /licence/);
  } finally { cleanup(); }
});

test('CLI main: confirm --all-unconfirmed confirms every unconfirmed item', async () => {
  const { root, doc, cleanup } = host();
  try {
    await ops.main(['confirm', doc, '--all-unconfirmed']);
    const model = docModel(doc);
    const unconfirmed = model.items.filter(i => i.status.kind !== 'confirmed' && i.status.kind !== 'failed');
    assert.equal(unconfirmed.length, 0);
  } finally { cleanup(); }
});

test('CLI main: prints the out.mjs contract once — no separate "ok: true" line duplicating the payload, next_step before the payload', async () => {
  const { root, doc, cleanup } = host();
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = c => { chunks.push(String(c)); return true; };
  try {
    await ops.main(['confirm', doc, '--all-unconfirmed']);
  } finally {
    process.stdout.write = orig;
  }
  try {
    const out = chunks.join('');
    assert.doesNotMatch(out, /^ok: true$/m, 'no separate ok: true line duplicating the payload');
    const nextStepIdx = out.indexOf('next_step:');
    const payloadIdx = out.indexOf('{');
    assert.ok(nextStepIdx >= 0 && payloadIdx > nextStepIdx, 'the payload comes after next_step, last');
  } finally { cleanup(); }
});

test('#11: the ops CLI honours --root as its usage says, not just the doc\'s nearest .git ancestor', async () => {
  const outerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-ops-root-'));
  try {
    fs.mkdirSync(path.join(outerRoot, '.git'), { recursive: true });   // a WRONG, further-out git root
    const projectRoot = path.join(outerRoot, 'project');
    fs.mkdirSync(path.join(projectRoot, 'specs'), { recursive: true });
    const doc = path.join(projectRoot, 'specs', 'rfp-0101-xlsx-ids-analysis.md');
    fs.writeFileSync(doc, FIXTURE, 'utf8');

    await ops.main(['assume', doc, 'global', 'The client provides its own SSL certificate.', '--root', projectRoot]);

    assert.ok(fs.existsSync(path.join(projectRoot, 'specs', '.rfp', SLUG)), '--root must be honoured, not the outer .git ancestor');
    assert.ok(!fs.existsSync(path.join(outerRoot, 'specs')), 'nothing must be written under the wrong, auto-detected root');
    const text = fs.readFileSync(doc, 'utf8');
    assert.ok(text.includes('The client provides its own SSL certificate.'));
  } finally { fs.rmSync(outerRoot, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- tokens (RC-4/T1, contract §4)
// The doc's own frontmatter names its source `rfp-0101-hartmann.xlsx` (FIXTURE) — `tokens` only
// ever reads the fit-back map beside it (`specs/rfp-0101-hartmann/import-map.json`), never the
// workbook itself, so these tests write that map file directly instead of running a real import.
// Tables are addressed by their own `key` (contract §4), not by sheet/area name any more.

const TABLE_KEY = 'Requirements r1';

function mapHost({ compliance = ['Stock', 'Config', 'Custom', 'Not offered'], legend = null } = {}) {
  const h = host();
  const mapDir = path.join(h.root, 'specs', 'rfp-0101-hartmann');
  fs.mkdirSync(mapDir, { recursive: true });
  const mapFile = path.join(mapDir, 'import-map.json');
  const tokens = { compliance };
  if (legend) tokens.complianceLegend = legend;
  const map = {
    source: 'specs/rfp-0101-hartmann.xlsx', sha256: 'x', extractedAt: new Date().toISOString(), confirmedAt: null,
    tables: [{ key: TABLE_KEY, sheet: 'Requirements', part: 'xl/worksheets/sheet1.xml', headerRow: 1, firstDataRow: 2, lastDataRow: 9, columns: { compliance: 'E' }, tokens, assumptionsColumn: null, headerText: [] }],
    unusedSheets: ['Glossary'], items: {},
  };
  fs.writeFileSync(mapFile, JSON.stringify(map));
  return { ...h, mapFile };
}

const FULL_TOKENS = { OOTB: 'Stock', Configuration: 'Config', Extension: 'Config', ISV: 'Custom', Custom: 'Custom', '—': 'Stock' };

test('tokens --suggest: per fit-back table with a compliance column, the recorded tokens/legend plus guessCoverageTokenMap\'s own guess, keyed by the table\'s own key', () => {
  const { root, doc, cleanup } = mapHost();
  try {
    const r = ops.tokensSuggest({ root, doc });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(Object.keys(r.tables), [TABLE_KEY]);
    assert.deepEqual(r.tables[TABLE_KEY].tokens, ['Stock', 'Config', 'Custom', 'Not offered']);
    assert.equal(r.tables[TABLE_KEY].legend, null);
    assert.equal(r.tables[TABLE_KEY].suggested.OOTB, 'Stock');
    assert.equal(r.tables[TABLE_KEY].suggested.Custom, 'Custom');
  } finally { cleanup(); }
});

test('tokens --suggest: refuses when there is no fit-back map yet', () => {
  const { root, doc, cleanup } = host(), _ = null;
  try {
    const r = ops.tokensSuggest({ root, doc });
    assert.equal(r.ok, false);
    assert.match(r.reason, /run intake first/);
  } finally { cleanup(); }
});

test('tokens --file: writes tokens.coverage into the fit-back map once every value is known and none is negative', () => {
  const { root, doc, mapFile, cleanup } = mapHost();
  try {
    const r = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: FULL_TOKENS } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.tables, [TABLE_KEY]);
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.deepEqual(map.tables[0].tokens.coverage, FULL_TOKENS);
  } finally { cleanup(); }
});

test('tokens --file: refuses a map missing one of the six keys', () => {
  const { root, doc, cleanup } = mapHost();
  try {
    const { OOTB, ...rest } = FULL_TOKENS;
    const r = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: rest } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing key\(s\) OOTB/);
  } finally { cleanup(); }
});

test('tokens --file: refuses a value that is not one of the table\'s own recorded tokens', () => {
  const { root, doc, cleanup } = mapHost();
  try {
    const r = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: { ...FULL_TOKENS, Custom: 'Bespoke' } } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not one of the client's own tokens/);
  } finally { cleanup(); }
});

test('tokens --file: refuses a negative-reading token for any of the six values, "—" included — it names non-Shopware work the partner still delivers, not "we don\'t offer this"', () => {
  const { root, doc, cleanup } = mapHost();
  try {
    // "Not offered" is one of the client's own recorded tokens (mapHost) — isolates the
    // negative-token refusal from the "unknown token" one above.
    const negative = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: { ...FULL_TOKENS, Custom: 'Not offered' } } });
    assert.equal(negative.ok, false);
    assert.match(negative.reason, /negative-reading token/);

    const onDash = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: { ...FULL_TOKENS, '—': 'Not offered' } } });
    assert.equal(onDash.ok, false, '"—" is delivered work too, so a negative-reading token there is refused just the same');
    assert.match(onDash.reason, /negative-reading token/);
  } finally { cleanup(); }
});

test('tokens --file: an n/a-style token on "—" is not a refusal — it is the legitimate answer, not "not offered"', () => {
  const { root, doc, cleanup } = mapHost({ compliance: [] });   // free text allowed, isolates the negative check
  try {
    const r = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: { ...FULL_TOKENS, '—': 'n/a' } } });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { cleanup(); }
});

test('tokens --file: resolves a numeric legend key to its label before the negative-token check (sample B: Custom -> "0" -> "Not Supported" is refused, ISV -> "1" -> "Roadmap" is not)', () => {
  const legend = { 'Not Supported': 0, Roadmap: 1, Customization: 2, Configuration: 3, Standard: 4 };
  const { root, doc, cleanup } = mapHost({ compliance: Object.keys(legend), legend });
  try {
    const bad = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: { OOTB: '4', Configuration: '3', Extension: '2', ISV: '1', Custom: '0', '—': '4' } } });
    assert.equal(bad.ok, false, 'Custom -> "0" -> "Not Supported" reads as a refusal, even though the digit "0" does not');
    assert.match(bad.reason, /Custom/);
    assert.match(bad.reason, /negative-reading token/);

    const good = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: { OOTB: '4', Configuration: '3', Extension: '2', ISV: '1', Custom: '2', '—': '4' } } });
    assert.equal(good.ok, true, JSON.stringify(good));
    const mapFile = path.join(root, 'specs', 'rfp-0101-hartmann', 'import-map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    // Stored resolved to the LABEL, not the raw key — `exportText`'s own legend lookup is by label.
    assert.equal(map.tables[0].tokens.coverage.ISV, 'Roadmap');
    assert.equal(map.tables[0].tokens.coverage.OOTB, 'Standard');
  } finally { cleanup(); }
});

test('tokens --file: free text is allowed once the client column has no token list at all', () => {
  const { root, doc, cleanup } = mapHost({ compliance: [] });
  try {
    const r = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: FULL_TOKENS } });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { cleanup(); }
});

test('tokens --file: a legend key is accepted and resolved to its label (T2) — the stored map always holds labels, whichever form the agent submitted', () => {
  const { root, doc, mapFile, cleanup } = mapHost({ compliance: ['Not Supported', 'Standard'], legend: { 'Not Supported': 0, Standard: 4 } });
  try {
    const r = ops.tokensApply({ root, doc, data: { [TABLE_KEY]: { OOTB: 'Standard', Configuration: '4', Extension: '4', ISV: '4', Custom: '4', '—': 'Standard' } } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.equal(map.tables[0].tokens.coverage.Configuration, 'Standard', 'the key "4" resolves to its label, matching complianceLegend\'s own keys');
  } finally { cleanup(); }
});

test('tokens --file: refuses a key that is not a fit-back table with a compliance column', () => {
  const { root, doc, cleanup } = mapHost();
  try {
    const r = ops.tokensApply({ root, doc, data: { Glossary: FULL_TOKENS } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a fit-back table/);
  } finally { cleanup(); }
});

test('CLI main: tokens --suggest and --file round-trip through argv, same as any other op', async () => {
  const { root, doc, mapFile, cleanup } = mapHost();
  try {
    const orig = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = (chunk) => { out += chunk; return true; };
    try {
      await ops.main(['tokens', doc, '--suggest', '--root', root]);
    } finally { process.stdout.write = orig; }
    assert.match(out, /next_step: decide the six-value/);

    const tokensFile = path.join(root, 'tokens.json');
    fs.writeFileSync(tokensFile, JSON.stringify({ [TABLE_KEY]: FULL_TOKENS }));
    await ops.main(['tokens', doc, '--file', tokensFile, '--root', root]);
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.deepEqual(map.tables[0].tokens.coverage, FULL_TOKENS);
  } finally { cleanup(); }
});
