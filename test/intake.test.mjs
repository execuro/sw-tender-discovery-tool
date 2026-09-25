// `intake` builds/updates the working document from the skill's extraction (contract §2/§3/§4):
// xlsx/csv read their rows from the source's own cells (`extraction.tables`), a pdf source reads
// `extraction.items` verbatim. SI-1, SI-2, L-5, contract §1 (Project information / Not taken).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { intake, main as intakeMain } from '../lib/intake.mjs';
import { move, confirm, tokensApply } from '../lib/ops.mjs';
import { readFitBack } from '../lib/import-map.mjs';
import { parse } from '../lib/parse.mjs';
import { buildWorkbook } from './helpers/mkxlsx.mjs';
import { exportWorkbook, sinceExportIds } from '../lib/import-export.mjs';

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REAL_SPECS = path.join(HERE_DIR, '..', '..', '..', '..', 'specs');

function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-intake-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const REQ_HEADER = ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'];

function xlsxExtraction({ sheet = 'Requirements', headerRow = 1, firstDataRow = 2, lastDataRow, tab = 'Functional', topic = null, columns = {}, projectInfo = [] } = {}) {
  return {
    tables: [{
      sheet, headerRow, firstDataRow, lastDataRow, tab, topic,
      columns: { id: 'A', priority: 'D', requirement: 'C', topic: null, compliance: 'E', comment: 'F', effort: 'G', assumptions: null, ...columns },
    }],
    overrides: [], skip: [], items: [], projectInfo,
  };
}

test('one queued item per client row, in client order, requirement and id verbatim', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0202-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: [
        REQ_HEADER,
        ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
        ['GEN-02', 'Shop', 'Customers can request a quote.', 'Should', '', '', ''],
      ],
      validations: [{ sqref: 'E2:E3', values: ['Stock', 'Config', 'Custom'] }],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0202-mini-analysis.md');
    const extraction = xlsxExtraction({ lastDataRow: 3 });
    const r = intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(r.added, ['GEN-01', 'GEN-02']);
    assert.deepEqual(r.reopened, []);
    assert.deepEqual(r.unchanged, []);

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    assert.equal(model.items.length, 2);
    assert.deepEqual(model.items.map(i => i.id), ['GEN-01', 'GEN-02']);
    assert.deepEqual(model.items.map(i => i.status.kind), ['queued', 'queued']);
    assert.equal(model.items[0].requirement, 'Customers can create an account.');
    assert.equal(model.items[0].tab, 'Functional');
    assert.equal(model.items[0].topic, 'Requirements');   // no `columns.topic`, no `table.topic` — sheet name
    assert.equal(model.items[1].requirement, 'Customers can request a quote.');
    assert.equal(model.frontmatter.data['source-sha256']['rfp-0202-mini.xlsx'].length, 64);
    assert.equal(model.frontmatter.data.intake, 'confirmed');
  } finally { h.cleanup(); }
});

test('the fit-back map is written for an xlsx source, keyed `<sheet> r<headerRow>`, one export target per item', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0210-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: [REQ_HEADER, ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', '']],
      validations: [{ sqref: 'E2:E2', values: ['Stock', 'Custom'] }],
    }, { name: 'Glossary', rows: [['Term', 'Meaning'], ['SKU', 'Stock keeping unit']] }]));
    const doc = path.join(h.root, 'specs', 'rfp-0210-mini-analysis.md');
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction: xlsxExtraction({ lastDataRow: 2 }) });

    const map = readFitBack(h.root, path.join(h.root, rel));
    assert.ok(map, 'no fit-back map written');
    // Intake confirms itself (own-tabs contract §3): `confirmedAt` is set the same run, not left
    // `null` for a later operator confirm.
    assert.match(map.confirmedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(map.tables.length, 1);
    assert.equal(map.tables[0].key, 'Requirements r1');
    assert.deepEqual(map.unusedSheets, ['Glossary']);
    assert.deepEqual(map.items['GEN-01'], { table: 'Requirements r1', sheet: 'Requirements', row: 2 });
  } finally { h.cleanup(); }
});

test('no id column — ids are `<sheet prefix>-<n>`, stable on a second intake of the same file', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0203-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'B2B Requirements',
      rows: [
        ['Title', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'],
        ['Hosting', 'The bidder recommends a hosting provider.', 'Must', '', '', ''],
        ['Packaging', 'Quantities are multiples of the packaging unit.', 'Should', '', '', ''],
      ],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0203-mini-analysis.md');
    const extraction = xlsxExtraction({ sheet: 'B2B Requirements', lastDataRow: 3, columns: { id: null, priority: 'C', requirement: 'B', compliance: 'D', comment: 'E', effort: 'F' } });
    const r1 = intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(r1.added, ['BR-1', 'BR-2']);
    const model1 = parse(fs.readFileSync(doc, 'utf8'));
    assert.deepEqual(model1.items.map(i => i.id), ['BR-1', 'BR-2']);

    const r2 = intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(r2.unchanged, ['BR-1', 'BR-2']);
    assert.deepEqual(r2.added, []);
    assert.deepEqual(r2.reopened, []);
    const model2 = parse(fs.readFileSync(doc, 'utf8'));
    assert.deepEqual(model2.items.map(i => i.id), ['BR-1', 'BR-2']);   // identical ids
  } finally { h.cleanup(); }
});

test('a pdf extraction JSON yields exactly the expected ids, tabs, topics and texts', () => {
  const h = host();
  try {
    const extraction = {
      tables: [], overrides: [], skip: [], projectInfo: [],
      items: [
        { tab: 'Functional', topic: 'Catalogue & Search', prio: 'Must', text: 'Products that vary by dimension must offer their variants in a selectable table.', id: null },
        { tab: 'Functional', topic: 'Catalogue & Search', prio: 'Should', text: 'Search should understand synonyms and common typos.', id: null },
        { tab: 'Project & services', topic: 'B2B Checkout', prio: 'Must', text: 'Logged-in customers must be able to order quickly by entering SKUs.', id: null },
        { tab: 'Non-functional', topic: 'Integrations', prio: 'Must', text: 'Products and prices must be synchronised from the ERP to the shop.', id: null },
      ],
    };
    const pdf = path.join(h.root, 'specs', 'rfp-0003-sample-prose.pdf');
    fs.writeFileSync(pdf, 'not a real pdf — intake never parses it, --extraction carries the extraction');
    const doc = path.join(h.root, 'specs', 'rfp-0003-sample-prose-analysis.md');
    const r = intake({ root: h.root, doc, source: pdf, extraction });
    assert.deepEqual(r.added.sort(), ['BC-1', 'CS-1', 'CS-2', 'INT-1'].sort());

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    assert.equal(model.items.length, 4);
    // Canonical render order: TABS order (Functional, Non-functional, Project & services).
    assert.deepEqual(model.items.map(i => i.tab), ['Functional', 'Functional', 'Non-functional', 'Project & services']);
    const bc1 = model.items.find(i => i.topic === 'B2B Checkout');
    assert.equal(bc1.id, 'BC-1');
    assert.equal(bc1.requirement, extraction.items[2].text);
    assert.equal(bc1.prio, 'Must');
    assert.equal(model.frontmatter.data['source-sha256']['rfp-0003-sample-prose.pdf'].length, 64);
  } finally { h.cleanup(); }
});

test('L-5: only the item whose requirement text changed is reopened; assumptions kept; unchanged confirmed items stay confirmed', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0204-mini.xlsx';
    const rows = req => [REQ_HEADER, ...req];
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: rows([
        ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
        ['GEN-02', 'Shop', 'Customers can request a quote.', 'Should', '', '', ''],
      ]),
      validations: [{ sqref: 'E2:E3', values: ['Stock', 'Custom'] }],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0204-mini-analysis.md');
    const extraction = xlsxExtraction({ lastDataRow: 3 });
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });

    // The operator confirms GEN-01, with an assumption, by hand (this WP does not own confirm).
    let text = fs.readFileSync(doc, 'utf8');
    text = text.replace(
      '| GEN-01 | Must | Customers can create an account. |  |  |  |  |  |  |  | queued |',
      '| GEN-01 | Must | Customers can create an account. | OOTB | high | — (0 PD) | Stock accounts cover this. | - Nothing more to add |  | kb: Customer accounts | confirmed 2026-09-01 |',
    );
    fs.writeFileSync(doc, text, 'utf8');

    // A new file version: GEN-01's text changes, GEN-02 is untouched.
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: rows([
        ['GEN-01', 'Shop', 'Customers can create an account and log in.', 'Must', '', '', ''],
        ['GEN-02', 'Shop', 'Customers can request a quote.', 'Should', '', '', ''],
      ]),
      validations: [{ sqref: 'E2:E3', values: ['Stock', 'Custom'] }],
    }]));
    const r = intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(r.reopened, ['GEN-01']);
    assert.deepEqual(r.unchanged, ['GEN-02']);
    assert.deepEqual(r.added, []);

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    const gen1 = model.items.find(i => i.id === 'GEN-01');
    assert.equal(gen1.status.kind, 'reopened');
    assert.equal(gen1.requirement, 'Customers can create an account and log in.');
    assert.deepEqual(gen1.assumptions, ['Nothing more to add']);
    assert.ok(gen1.references.some(r2 => /reopened \d{4}-\d{2}-\d{2}: requirement text changed in rfp-0204-mini\.xlsx/.test(r2)));
    const gen2 = model.items.find(i => i.id === 'GEN-02');
    assert.equal(gen2.status.kind, 'queued');   // never touched
  } finally { h.cleanup(); }
});

test('a row dropped from a new file version gets a `removed from <file>` reference, which is a valid reference prefix, never duplicated', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0209-mini.xlsx';
    const build = req => buildWorkbook([{ name: 'Requirements', rows: [REQ_HEADER, ...req], validations: [{ sqref: `E2:E${req.length + 1}`, values: ['Stock', 'Custom'] }] }]);
    fs.writeFileSync(path.join(h.root, rel), build([
      ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
      ['GEN-02', 'Shop', 'Customers can request a quote.', 'Should', '', '', ''],
    ]));
    const doc = path.join(h.root, 'specs', 'rfp-0209-mini-analysis.md');
    const extraction = lastDataRow => xlsxExtraction({ lastDataRow });
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction: extraction(3) });

    // A new file version drops GEN-02 entirely.
    fs.writeFileSync(path.join(h.root, rel), build([
      ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
    ]));
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction: extraction(2) });

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    const gen2 = model.items.find(i => i.id === 'GEN-02');
    assert.ok(gen2, 'the removed item stays in the document');
    assert.ok(gen2.references.includes('removed from rfp-0209-mini.xlsx'));

    // Re-intaking the same short file again does not duplicate the reference.
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction: extraction(2) });
    const model2 = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    const gen2Again = model2.items.find(i => i.id === 'GEN-02');
    assert.deepEqual(gen2Again.references.filter(r => r === 'removed from rfp-0209-mini.xlsx'), ['removed from rfp-0209-mini.xlsx']);
  } finally { h.cleanup(); }
});

test('a row deleted from a new file version, with later rows shifting up, drops its old pointer instead of handing it to the shifted-in item', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0211-mini.xlsx';
    const build = req => buildWorkbook([{ name: 'Requirements', rows: [REQ_HEADER, ...req], validations: [{ sqref: `E2:E${req.length + 1}`, values: ['Stock', 'Custom'] }] }]);
    fs.writeFileSync(path.join(h.root, rel), build([
      ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
      ['GEN-02', 'Shop', 'Customers can request a quote.', 'Should', '', '', ''],
      ['GEN-03', 'Shop', 'Customers can track an order.', 'Should', '', '', ''],
    ]));
    const doc = path.join(h.root, 'specs', 'rfp-0211-mini-analysis.md');
    const src = path.join(h.root, rel);
    intake({ root: h.root, doc, source: src, extraction: xlsxExtraction({ lastDataRow: 4 }) });

    const before = readFitBack(h.root, src);
    assert.deepEqual(before.items['GEN-01'], { table: 'Requirements r1', sheet: 'Requirements', row: 2 });
    assert.deepEqual(before.items['GEN-02'], { table: 'Requirements r1', sheet: 'Requirements', row: 3 });
    assert.deepEqual(before.items['GEN-03'], { table: 'Requirements r1', sheet: 'Requirements', row: 4 });

    // GEN-01 (row 2) is dropped from the new file version: GEN-02 and GEN-03 shift up one row,
    // GEN-02 now sitting where GEN-01's stale pointer used to point.
    fs.writeFileSync(path.join(h.root, rel), build([
      ['GEN-02', 'Shop', 'Customers can request a quote.', 'Should', '', '', ''],
      ['GEN-03', 'Shop', 'Customers can track an order.', 'Should', '', '', ''],
    ]));
    intake({ root: h.root, doc, source: src, extraction: xlsxExtraction({ lastDataRow: 3 }) });

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    const gen1 = model.items.find(i => i.id === 'GEN-01');
    assert.ok(gen1.references.includes('removed from rfp-0211-mini.xlsx'));

    const after = readFitBack(h.root, src);
    assert.equal(after.items['GEN-01'], undefined, 'the removed item has no pointer in the new fit-back map');
    assert.deepEqual(after.items['GEN-02'], { table: 'Requirements r1', sheet: 'Requirements', row: 2 }, 'GEN-02 lands on its new (shifted) row');
    assert.deepEqual(after.items['GEN-03'], { table: 'Requirements r1', sheet: 'Requirements', row: 3 }, 'GEN-03 lands on its new (shifted) row');
  } finally { h.cleanup(); }
});

test('same file again: no change, ids identical, nothing added/reopened', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0205-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: [REQ_HEADER, ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', '']],
      validations: [{ sqref: 'E2:E2', values: ['Stock', 'Custom'] }],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0205-mini-analysis.md');
    const extraction = xlsxExtraction({ lastDataRow: 2 });
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    const before = fs.readFileSync(doc, 'utf8');
    const r = intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.reopened, []);
    assert.deepEqual(r.unchanged, ['GEN-01']);
    const after = fs.readFileSync(doc, 'utf8');
    assert.equal(after, before);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- §1 Project information / Not taken

test('projectInfo fills the 18-row table; a missing key is `not stated`; an operator-set value survives re-intake', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0211-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: [REQ_HEADER, ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', '']],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0211-mini-analysis.md');
    const extraction = xlsxExtraction({ lastDataRow: 2, projectInfo: [{ key: 'markets', value: 'DACH', source: '1 Company r4' }] });
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.equal(model.projectInfo.length, 18);
    const markets = model.projectInfo.find(r => r.key === 'markets');
    assert.equal(markets.value, 'DACH');
    assert.equal(markets.source, '1 Company r4');
    const goLive = model.projectInfo.find(r => r.key === 'go-live');
    assert.equal(goLive.value, 'not stated');
    assert.equal(goLive.source, '');

    // The operator types a value by hand (`ops.info`'s own shape: Source `operator`) — simulated
    // here by editing the row directly, since `ops.info` is this WP's own code under test elsewhere
    // (test/ops.test.mjs would cover it once ops.info lands; here only the merge rule matters).
    const opText = fs.readFileSync(doc, 'utf8').replace(
      '| Target go-live | not stated |  |',
      '| Target go-live | Q3 2027 | operator |',
    );
    fs.writeFileSync(doc, opText, 'utf8');

    // Re-intake with a fresh extraction that also names `go-live` — the operator's value wins.
    const extraction2 = xlsxExtraction({ lastDataRow: 2, projectInfo: [{ key: 'markets', value: 'DACH + AT', source: '1 Company r4' }, { key: 'go-live', value: 'Q1 2028', source: '1 Company r9' }] });
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction: extraction2 });
    const model2 = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    const goLive2 = model2.projectInfo.find(r => r.key === 'go-live');
    assert.equal(goLive2.value, 'Q3 2027', 'an operator-sourced value survives re-intake untouched');
    assert.equal(goLive2.source, 'operator');
    assert.equal(model2.projectInfo.find(r => r.key === 'markets').value, 'DACH + AT', 'a non-operator row is overwritten by the fresh extraction');
  } finally { h.cleanup(); }
});

test('a skip[] row is recorded in Not taken with the client cell text, and never becomes a §4 item', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0212-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: [
        REQ_HEADER,
        ['', 'Shop', 'Catalogue', '', '', '', ''],
        ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
      ],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0212-mini-analysis.md');
    const extraction = xlsxExtraction({ lastDataRow: 3 });
    extraction.skip = [{ sheet: 'Requirements', row: 2, why: 'sub-heading, not a requirement' }];
    const r = intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(r.added, ['GEN-01']);

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.equal(model.items.length, 1);
    assert.equal(model.notTaken.length, 1);
    assert.equal(model.notTaken[0].source, 'Requirements r2');
    assert.equal(model.notTaken[0].text, 'Catalogue');
    assert.equal(model.notTaken[0].why, 'sub-heading, not a requirement');
  } finally { h.cleanup(); }
});

test('an override moves one row to a different tab/topic than its table\'s default', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0213-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: [
        REQ_HEADER,
        ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
        ['GEN-02', 'Ops', 'Backups run nightly.', 'Must', '', '', ''],
      ],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0213-mini-analysis.md');
    const extraction = xlsxExtraction({ lastDataRow: 3 });
    extraction.overrides = [{ sheet: 'Requirements', row: 3, tab: 'Non-functional', topic: 'Operations' }];
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    const gen1 = model.items.find(i => i.id === 'GEN-01');
    const gen2 = model.items.find(i => i.id === 'GEN-02');
    assert.equal(gen1.tab, 'Functional');
    assert.equal(gen2.tab, 'Non-functional');
    assert.equal(gen2.topic, 'Operations');
  } finally { h.cleanup(); }
});

test('an override topic keeps its leading chapter number stripped, same as the table default', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0214-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: [
        REQ_HEADER,
        ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
        ['GEN-02', 'Shop', 'Backups run nightly.', 'Must', '', '', ''],
      ],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0214-mini-analysis.md');
    const extraction = xlsxExtraction({ lastDataRow: 3, topic: '1. GENERAL REQUIREMENTS' });
    extraction.overrides = [{ sheet: 'Requirements', row: 3, topic: '1. GENERAL REQUIREMENTS' }];
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    const gen1 = model.items.find(i => i.id === 'GEN-01');
    const gen2 = model.items.find(i => i.id === 'GEN-02');
    assert.equal(gen1.topic, 'GENERAL REQUIREMENTS');
    assert.equal(gen2.topic, 'GENERAL REQUIREMENTS');
  } finally { h.cleanup(); }
});

test('a re-intake carries the previous fit-back map\'s tokens.coverage forward, so it never needs `tokens --file` again', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0215-mini.xlsx';
    const src = path.join(h.root, rel);
    fs.writeFileSync(src, buildWorkbook([{
      name: 'Requirements',
      rows: [REQ_HEADER, ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', '']],
      validations: [{ sqref: 'E2:E2', values: ['Stock', 'Config', 'Custom'] }],
    }]));
    const doc = path.join(h.root, 'specs', 'rfp-0215-mini-analysis.md');
    const extraction = xlsxExtraction({ lastDataRow: 2 });

    intake({ root: h.root, doc, source: src, extraction });
    confirm({ root: h.root, doc, ids: ['GEN-01'] });
    const coverage = { OOTB: 'Stock', Configuration: 'Config', Extension: 'Config', ISV: 'Custom', Custom: 'Custom', '—': 'Stock' };
    const tokenResult = tokensApply({ root: h.root, doc, data: { 'Requirements r1': coverage } });
    assert.equal(tokenResult.ok, true, JSON.stringify(tokenResult));

    const beforeExport = exportWorkbook(doc, {});
    assert.equal(beforeExport.written, 1);

    // Re-intake (e.g. a corrected extraction on the same source) rebuilds the fit-back map from
    // scratch — the previously confirmed coverage tokens must survive it.
    intake({ root: h.root, doc, source: src, extraction });
    const mapAfter = readFitBack(h.root, src);
    assert.deepEqual(mapAfter.tables[0].tokens.coverage, coverage);

    // Export must succeed without calling `tokens --file` again.
    const afterExport = exportWorkbook(doc, {});
    assert.equal(afterExport.written, 1);

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(sinceExportIds(h.root, 'rfp-0215-mini', model.items, mapAfter), []);
  } finally { h.cleanup(); }
});

test('the real rfp-0002 sample: generated ids, stable on re-intake', () => {
  const real = path.join(REAL_SPECS, 'rfp-0002-b2b-ecommerce-smb.xlsx');
  if (!fs.existsSync(real)) { console.log('  (skipped — rfp-0002-b2b-ecommerce-smb.xlsx not present)'); return; }
  const h = host();
  try {
    const sourceAbs = path.join(h.root, 'specs', 'rfp-0002-b2b-ecommerce-smb.xlsx');
    fs.copyFileSync(real, sourceAbs);   // work on a copy, never the tracked file
    const doc = path.join(h.root, 'specs', 'rfp-0002-b2b-ecommerce-smb-analysis.md');
    const col = (id, prio, req, tab) => ({ id, priority: prio, requirement: req, topic: null, compliance: 'C', comment: 'D', effort: null, assumptions: 'E' });
    const table = (sheet, headerRow, firstDataRow, lastDataRow, tab, topic) => ({
      sheet, headerRow, firstDataRow, lastDataRow, tab, topic,
      columns: { id: null, priority: null, requirement: 'B', topic: null, compliance: 'C', comment: 'D', effort: null, assumptions: 'E' },
    });
    const extraction = {
      tables: [
        table('3.1 General', 5, 6, 9, 'Functional', 'General'),
        table('3.2 - Technical ', 5, 6, 9, 'Non-functional', 'IT & HOSTING'),
        table('3.2 - Technical ', 12, 13, 17, 'Non-functional', 'SECURITY'),
        table('3.3 - Functional', 5, 6, 16, 'Functional', 'Design & Development'),
        table('3.3 - Functional', 19, 20, 23, 'Functional', 'Customer Service'),
        table('3.3 - Functional', 26, 27, 32, 'Functional', 'Marketing & Promotions'),
        table('3.3 - Functional', 35, 36, 49, 'Functional', 'Products & Categories'),
        table('3.4 - Administration', 5, 6, 20, 'Functional', 'Administration'),
        table('3.5 - Services', 5, 6, 15, 'Project & services', 'Services'),
      ],
      overrides: [], skip: [], items: [], projectInfo: [],
    };
    const TOTAL = 4 + 4 + 5 + 11 + 4 + 6 + 14 + 15 + 10;

    const r1 = intake({ root: h.root, doc, source: sourceAbs, extraction });
    assert.equal(r1.added.length, TOTAL);
    const model1 = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model1.errors, []);
    assert.equal(model1.items.length, TOTAL);
    const ids1 = model1.items.map(i => i.id);
    assert.ok(ids1.every(id => /^[A-Z0-9]+-\d+$/.test(id)), `generated ids must be <prefix>-<n>, got ${ids1.join(', ')}`);
    assert.equal(new Set(ids1).size, ids1.length, 'ids must be unique across every topic');

    const r2 = intake({ root: h.root, doc, source: sourceAbs, extraction });
    assert.deepEqual(r2.added, [], 'a second intake of the same file must add nothing');
    const model2 = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model2.items.map(i => i.id), ids1, 'ids must be stable across intakes of the same file');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- CSV source (task 2)

test('a CSV source goes through the same intake as xlsx, delimiter auto-detected', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0206-mini.csv';
    fs.writeFileSync(path.join(h.root, rel),
      'ID;Requirement;Priority;Vendor: Compliance;Vendor: Comment;Vendor: Effort (PD)\nGEN-01;Customers can create an account.;Must;;;\n');
    const doc = path.join(h.root, 'specs', 'rfp-0206-mini-analysis.md');
    const extraction = {
      tables: [{ sheet: 'rfp-0206-mini', headerRow: 1, firstDataRow: 2, lastDataRow: 2, tab: 'Functional', topic: null, columns: { id: 'A', priority: 'C', requirement: 'B', topic: null, compliance: 'D', comment: 'E', effort: 'F', assumptions: null } }],
      overrides: [], skip: [], items: [], projectInfo: [],
    };
    const r = intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(r.added, ['GEN-01']);
    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    assert.equal(model.items[0].requirement, 'Customers can create an account.');
    // No fit-back map for a CSV source (contract §4).
    assert.equal(readFitBack(h.root, path.join(h.root, rel)), null);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- refusals (contract §2)

test('intake refuses a pdf source with no --extraction', () => {
  const h = host();
  const pdf = path.join(h.root, 'specs', 'rfp-0207-mini.pdf');
  fs.writeFileSync(pdf, 'x');
  try {
    assert.throws(
      () => intake({ root: h.root, doc: path.join(h.root, 'specs', 'rfp-0207-mini-analysis.md'), source: pdf }),
      /extraction is required/,
    );
  } finally { h.cleanup(); }
});

test('intake refuses an extraction with no requirement column', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0208-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{
      name: 'Requirements',
      rows: [['ID', 'Vendor: Compliance', 'Vendor: Comment'], ['GEN-01', '', '']],
    }]));
    const extraction = { tables: [{ sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2, tab: 'Functional', topic: null, columns: { id: 'A', compliance: 'B', comment: 'C' } }], overrides: [], skip: [], items: [], projectInfo: [] };
    assert.throws(
      () => intake({ root: h.root, doc: path.join(h.root, 'specs', 'rfp-0208-mini-analysis.md'), source: path.join(h.root, rel), extraction }),
      /columns\.requirement is required/,
    );
  } finally { h.cleanup(); }
});

test('intake refuses a table with neither compliance nor comment (nowhere to answer)', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0214-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{ name: 'Requirements', rows: [['ID', 'Requirement'], ['GEN-01', 'x']] }]));
    const extraction = { tables: [{ sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2, tab: 'Functional', topic: null, columns: { id: 'A', requirement: 'B' } }], overrides: [], skip: [], items: [], projectInfo: [] };
    assert.throws(
      () => intake({ root: h.root, doc: path.join(h.root, 'specs', 'rfp-0214-mini-analysis.md'), source: path.join(h.root, rel), extraction }),
      /needs at least one of columns\.compliance or columns\.comment/,
    );
  } finally { h.cleanup(); }
});

test('intake refuses a tab that is not one of TABS', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0215-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{ name: 'Requirements', rows: [REQ_HEADER, ['GEN-01', 'Shop', 'x', 'Must', '', '', '']] }]));
    const extraction = xlsxExtraction({ lastDataRow: 2, tab: 'Approach' });
    assert.throws(
      () => intake({ root: h.root, doc: path.join(h.root, 'specs', 'rfp-0215-mini-analysis.md'), source: path.join(h.root, rel), extraction }),
      /tab "Approach" is not one of/,
    );
  } finally { h.cleanup(); }
});

test('intake accepts a projectInfo value with a money amount — it is the client\'s own fact (2026-09-24 decision)', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0216-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{ name: 'Requirements', rows: [REQ_HEADER, ['GEN-01', 'Shop', 'x', 'Must', '', '', '']] }]));
    const extraction = xlsxExtraction({ lastDataRow: 2, projectInfo: [{ key: 'products', value: '25,000 SKUs at 10 EUR each', source: '1 Company r1' }] });
    const doc = path.join(h.root, 'specs', 'rfp-0216-mini-analysis.md');
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    const row = model.projectInfo.find(r => r.key === 'products');
    assert.equal(row.value, '25,000 SKUs at 10 EUR each');
  } finally { h.cleanup(); }
});

test('an override inside a topic yields one heading per tab and topic, tabs in canonical order', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0217-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{ name: 'Requirements', rows: [
      REQ_HEADER,
      ['GEN-01', 'General', 'Shop on Shopware 6.7', 'Must', '', '', ''],
      ['GEN-02', 'General', 'Two-week sprints', 'Must', '', '', ''],
      ['GEN-03', 'General', 'Languages DE and EN', 'Must', '', '', ''],
      ['GEN-04', 'General', 'Pages load under 2 s', 'Must', '', '', ''],
      ['GEN-05', 'General', 'Currency EUR', 'Must', '', '', ''],
    ] }]));
    const extraction = xlsxExtraction({ lastDataRow: 6, columns: { topic: 'B' } });
    extraction.overrides = [
      { sheet: 'Requirements', row: 3, tab: 'Project & services' },
      { sheet: 'Requirements', row: 5, tab: 'Non-functional' },
    ];
    const doc = path.join(h.root, 'specs', 'rfp-0217-mini-analysis.md');
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    const headings = fs.readFileSync(doc, 'utf8').split('\n').filter(l => /^### (Functional|Non-functional|Project & services) · /.test(l));
    assert.deepEqual(headings, ['### Functional · General', '### Non-functional · General', '### Project & services · General']);
    const ids = parse(fs.readFileSync(doc, 'utf8')).items.map(it => it.id);
    assert.deepEqual(ids, ['GEN-01', 'GEN-03', 'GEN-05', 'GEN-04', 'GEN-02']);
  } finally { h.cleanup(); }
});

test('SI-2: generated ids survive skip, restore and re-intake — nothing is renumbered, restore puts the row back in place', async () => {
  const { skip, restore } = await import('../lib/ops.mjs');
  const h = host();
  try {
    const rel = 'specs/rfp-0218-mini.xlsx';
    const header = ['Item', 'Rating', 'Response'];
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([{ name: '1. General', rows: [header, ['Shop A', '', ''], ['Shop B', '', ''], ['Shop C', '', '']] }]));
    const extraction = {
      tables: [{ sheet: '1. General', headerRow: 1, firstDataRow: 2, lastDataRow: 4, tab: 'Functional', topic: '1. GENERAL REQUIREMENTS',
        columns: { id: null, priority: null, requirement: 'A', topic: null, compliance: 'B', comment: 'C', effort: null, assumptions: null } }],
      overrides: [], skip: [], items: [], projectInfo: [],
    };
    const doc = path.join(h.root, 'specs', 'rfp-0218-mini-analysis.md');
    const ids = () => parse(fs.readFileSync(doc, 'utf8')).items.map(it => it.id);
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(ids(), ['GR-1', 'GR-2', 'GR-3']);
    assert.equal(skip({ root: h.root, doc, id: 'GR-2', why: 'test' }).ok, true);
    intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.deepEqual(ids(), ['GR-1', 'GR-3'], 'a re-intake keeps the operator skip and renumbers nothing');
    assert.equal(restore({ root: h.root, doc, source: '1. General r3' }).ok, true);
    assert.deepEqual(ids(), ['GR-1', 'GR-2', 'GR-3'], 'restore gives back the same id, in client order');
    const again = intake({ root: h.root, doc, source: path.join(h.root, rel), extraction });
    assert.equal(again.added.length, 0);
    assert.deepEqual(ids(), ['GR-1', 'GR-2', 'GR-3']);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- SI-4 (client order across re-intake)

test('SI-4: a row inserted mid-topic and a new topic inserted between two existing ones both land in client order; a removed item keeps its neighbourhood', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0219-mini.xlsx';
    const header = ['ID', 'Topic', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'];
    const table = lastDataRow => ({
      tables: [{ sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow, tab: 'Functional', topic: null,
        columns: { id: 'A', topic: 'B', priority: 'D', requirement: 'C', compliance: 'E', comment: 'F', effort: 'G', assumptions: null } }],
      overrides: [], skip: [], items: [], projectInfo: [],
    });
    const doc = path.join(h.root, 'specs', 'rfp-0219-mini-analysis.md');
    const src = path.join(h.root, rel);

    fs.writeFileSync(src, buildWorkbook([{
      name: 'Requirements',
      rows: [
        header,
        ['GEN-01', 'Topic A', 'a1', 'Must', '', '', ''],
        ['GEN-02', 'Topic A', 'a2', 'Must', '', '', ''],
        ['GEN-03', 'Topic B', 'b1', 'Must', '', '', ''],
        ['GEN-04', 'Topic C', 'c1', 'Must', '', '', ''],
        ['GEN-05', 'Topic C', 'c2', 'Must', '', '', ''],
        ['GEN-06', 'Topic C', 'c3', 'Must', '', '', ''],
      ],
    }]));
    intake({ root: h.root, doc, source: src, extraction: table(7) });

    // New version: a row inserted mid-topic A, a new topic M inserted between B and C, c2 dropped.
    fs.writeFileSync(src, buildWorkbook([{
      name: 'Requirements',
      rows: [
        header,
        ['GEN-01', 'Topic A', 'a1', 'Must', '', '', ''],
        ['GEN-07', 'Topic A', 'aNew', 'Must', '', '', ''],
        ['GEN-02', 'Topic A', 'a2', 'Must', '', '', ''],
        ['GEN-03', 'Topic B', 'b1', 'Must', '', '', ''],
        ['GEN-08', 'Topic M', 'm1', 'Must', '', '', ''],
        ['GEN-04', 'Topic C', 'c1', 'Must', '', '', ''],
        ['GEN-06', 'Topic C', 'c3', 'Must', '', '', ''],
      ],
    }]));
    intake({ root: h.root, doc, source: src, extraction: table(8) });

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    assert.deepEqual(model.items.map(i => i.id), ['GEN-01', 'GEN-07', 'GEN-02', 'GEN-03', 'GEN-08', 'GEN-04', 'GEN-05', 'GEN-06']);
    assert.deepEqual(model.items.map(i => i.topic), ['Topic A', 'Topic A', 'Topic A', 'Topic B', 'Topic M', 'Topic C', 'Topic C', 'Topic C']);
    const gen5 = model.items.find(i => i.id === 'GEN-05');
    assert.ok(gen5.references.includes('removed from rfp-0219-mini.xlsx'));
  } finally { h.cleanup(); }
});

test('a topic name shared by two tabs keeps each tab in its own client order; surviving that across a re-intake after `move`', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0221-mini.xlsx';
    const src = path.join(h.root, rel);
    const doc = path.join(h.root, 'specs', 'rfp-0221-mini-analysis.md');
    const header = ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'];
    const cols = { id: 'A', priority: 'D', requirement: 'C', topic: null, compliance: 'E', comment: 'F', effort: 'G', assumptions: null };
    fs.writeFileSync(src, buildWorkbook([{
      name: 'Requirements',
      rows: [
        header,
        ['PRJ-01', 'Area', 'p1', 'Must', '', '', ''],
        ['GEN-01', 'Area', 'f1', 'Must', '', '', ''],
        ['GEN-02', 'Area', 'x', 'Must', '', '', ''],
      ],
    }]));
    // Table declaration order (not row order) is the client's own order: the Project & services
    // "Overview" table is declared first, then the Functional "Overview" table, then Functional
    // "Other" — the same topic name occurring under two different tabs.
    const extraction = {
      tables: [
        { sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2, tab: 'Project & services', topic: 'Overview', columns: cols },
        { sheet: 'Requirements', headerRow: 1, firstDataRow: 3, lastDataRow: 3, tab: 'Functional', topic: 'Overview', columns: cols },
        { sheet: 'Requirements', headerRow: 1, firstDataRow: 4, lastDataRow: 4, tab: 'Functional', topic: 'Other', columns: cols },
      ],
      overrides: [], skip: [], items: [], projectInfo: [],
    };
    intake({ root: h.root, doc, source: src, extraction });

    let model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    // Within the Functional tab, "Overview" (GEN-01, declared 2nd) must stay ahead of "Other"
    // (GEN-02, declared 3rd) — the shared topic name "Overview" with Project & services must not
    // pull Functional's own topic order out of client order.
    assert.deepEqual(model.items.map(i => i.id), ['GEN-01', 'GEN-02', 'PRJ-01']);
    assert.deepEqual(model.items.map(i => `${i.tab} · ${i.topic}`), [
      'Functional · Overview', 'Functional · Other', 'Project & services · Overview',
    ]);

    // Move GEN-01 into the same tab+topic as PRJ-01 ("Project & services · Overview") and re-intake
    // the unchanged source: the merged topic must still list its items in client (table) order.
    const moveResult = move({ root: h.root, doc, id: 'GEN-01', tab: 'Project & services' });
    assert.equal(moveResult.ok, true);
    intake({ root: h.root, doc, source: src, extraction });

    model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    assert.deepEqual(model.items.map(i => i.id), ['GEN-02', 'PRJ-01', 'GEN-01']);
    assert.deepEqual(model.items.map(i => `${i.tab} · ${i.topic}`), [
      'Functional · Other', 'Project & services · Overview', 'Project & services · Overview',
    ]);
  } finally { h.cleanup(); }
});

test('a leading client chapter number is stripped from table.topic and the sheet-name fallback, never from a Topic-column cell', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0222-mini.xlsx';
    const src = path.join(h.root, rel);
    const doc = path.join(h.root, 'specs', 'rfp-0222-mini-analysis.md');
    const header = ['ID', 'Topic', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'];
    fs.writeFileSync(src, buildWorkbook([{
      name: '3.3 - Functional',
      rows: [
        header,
        ['GEN-01', '2. Checkout', 'chapter-numbered topic cell kept verbatim', 'Must', '', '', ''],
        ['GEN-02', '', 'falls back to table.topic, chapter number stripped', 'Must', '', '', ''],
        ['GEN-03', '', 'falls back to the sheet name, chapter number stripped', 'Must', '', '', ''],
      ],
    }]));
    const extraction = {
      tables: [
        { sheet: '3.3 - Functional', headerRow: 1, firstDataRow: 2, lastDataRow: 2, tab: 'Functional', topic: null,
          columns: { id: 'A', topic: 'B', priority: 'D', requirement: 'C', compliance: 'E', comment: 'F', effort: 'G', assumptions: null } },
        { sheet: '3.3 - Functional', headerRow: 1, firstDataRow: 3, lastDataRow: 3, tab: 'Functional', topic: '1. General',
          columns: { id: 'A', topic: null, priority: 'D', requirement: 'C', compliance: 'E', comment: 'F', effort: 'G', assumptions: null } },
        { sheet: '3.3 - Functional', headerRow: 1, firstDataRow: 4, lastDataRow: 4, tab: 'Functional', topic: null,
          columns: { id: 'A', topic: null, priority: 'D', requirement: 'C', compliance: 'E', comment: 'F', effort: 'G', assumptions: null } },
      ],
      overrides: [], skip: [], items: [], projectInfo: [],
    };
    intake({ root: h.root, doc, source: src, extraction });

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    const byId = new Map(model.items.map(i => [i.id, i]));
    assert.equal(byId.get('GEN-01').topic, '2. Checkout'); // Topic-column cell: kept verbatim
    assert.equal(byId.get('GEN-02').topic, 'General'); // table.topic: chapter number stripped
    assert.equal(byId.get('GEN-03').topic, 'Functional'); // sheet name: chapter number stripped
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- IN-2 (hidden / `_` sheets never read)

test('IN-2: a table, override, skip or Project information source on a hidden or `_` sheet is refused', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0220-mini.xlsx';
    fs.writeFileSync(path.join(h.root, rel), buildWorkbook([
      { name: 'Requirements', rows: [REQ_HEADER, ['GEN-01', 'Shop', 'x', 'Must', '', '', '']] },
      { name: '_answer_key', state: 'hidden', rows: [['Answer'], ['Stock']] },
    ]));
    const doc = path.join(h.root, 'specs', 'rfp-0220-mini-analysis.md');
    const src = path.join(h.root, rel);

    const table = xlsxExtraction({ lastDataRow: 2 });
    table.tables.push({ sheet: '_answer_key', headerRow: 1, firstDataRow: 2, lastDataRow: 2, tab: 'Functional', topic: null,
      columns: { requirement: 'A', comment: 'A' } });
    assert.throws(
      () => intake({ root: h.root, doc, source: src, extraction: table }),
      /sheet "_answer_key" is hidden or internal/,
    );

    const override = xlsxExtraction({ lastDataRow: 2 });
    override.overrides = [{ sheet: '_answer_key', row: 2, tab: 'Functional' }];
    assert.throws(
      () => intake({ root: h.root, doc, source: src, extraction: override }),
      /sheet "_answer_key" is hidden or internal/,
    );

    const skip = xlsxExtraction({ lastDataRow: 2 });
    skip.skip = [{ sheet: '_answer_key', row: 2, why: 'not a requirement' }];
    assert.throws(
      () => intake({ root: h.root, doc, source: src, extraction: skip }),
      /sheet "_answer_key" is hidden or internal/,
    );

    const info = xlsxExtraction({ lastDataRow: 2, projectInfo: [{ key: 'markets', value: 'DACH', source: '_answer_key r2' }] });
    assert.throws(
      () => intake({ root: h.root, doc, source: src, extraction: info }),
      /source "_answer_key r2" is a hidden or internal sheet/,
    );
  } finally { h.cleanup(); }
});

test('CLI: intake prints a removed line when a re-intake marks items removed, and omits it otherwise', () => {
  const h = host();
  try {
    const rel = 'specs/rfp-0230-mini.xlsx';
    const build = req => buildWorkbook([{ name: 'Requirements', rows: [REQ_HEADER, ...req], validations: [{ sqref: `E2:E${req.length + 1}`, values: ['Stock', 'Custom'] }] }]);
    fs.writeFileSync(path.join(h.root, rel), build([
      ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
      ['GEN-02', 'Shop', 'Customers can request a quote.', 'Should', '', '', ''],
    ]));
    const doc = path.join(h.root, 'specs', 'rfp-0230-mini-analysis.md');
    const src = path.join(h.root, rel);

    const runIntake = (extraction) => {
      const chunks = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = c => { chunks.push(String(c)); return true; };
      try {
        intakeMain([doc, '--source', src, '--extraction', JSON.stringify(extraction), '--root', h.root]);
      } finally { process.stdout.write = orig; }
      return chunks.join('');
    };

    // First intake: nothing removed yet - no `removed:` line at all.
    const firstOut = runIntake(xlsxExtraction({ lastDataRow: 3 }));
    assert.doesNotMatch(firstOut, /^removed:/m, 'no removed line when nothing was removed');

    // A new file version drops GEN-02.
    fs.writeFileSync(path.join(h.root, rel), build([
      ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
    ]));
    const secondOut = runIntake(xlsxExtraction({ lastDataRow: 2 }));
    assert.match(secondOut, /^removed: 1$/m, 're-intake must report the removed count');
  } finally { h.cleanup(); }
});
