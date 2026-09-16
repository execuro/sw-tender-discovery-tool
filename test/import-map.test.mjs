// The mapping the steering screen proposes, validates and turns into the normalised CSVs.
// The strongest assertion here is against the real tender: the heuristic must land on exactly
// the three requirement tables and the three context tables that `lib/source.mjs` used to name
// by hand, without any hard-coded file name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook, sheetToGrid } from '../lib/xlsx.mjs';
import {
  proposeMap, validateMap, emitCsv, csvCell, csvNameFor, writeTables,
  slugifySheet, contextKind, clientColumnsFromMap,
} from '../lib/import-map.mjs';
import { buildWorkbook } from './helpers/mkxlsx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
import { sampleTenderWorkbook } from './fixtures/sample-tender.mjs';

const SAMPLE = sampleTenderWorkbook();

/** The snapshot shape `bin/cli.mjs import` writes, built here without touching the disk. */
function snapshotOf(buffer, source = 'specs/test.xlsx') {
  const wb = readWorkbook(buffer);
  return {
    source,
    sha256: 'x'.repeat(64),
    epoch1904: wb.epoch1904,
    sheets: wb.sheets.map(sheet => {
      const grid = sheetToGrid(sheet);
      return {
        index: sheet.index, name: sheet.name, state: sheet.state, part: sheet.part,
        width: grid.width, height: grid.height, rows: grid.rows,
        hiddenRows: grid.hiddenRows, hiddenCols: grid.hiddenCols, merges: sheet.merges,
        dropdowns: sheet.validations.filter(v => v.values?.length).map(v => ({ sqref: v.sqref, values: v.values })),
      };
    }),
  };
}

const REQ_HEADER = ['ID', 'Area', 'Title', 'Requirement', 'Priority', 'Acceptance criteria / Notes', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)', 'Vendor: One-off cost (EUR)'];
const reqSheet = (name = 'Requirements', rows = 3) => ({
  name,
  rows: [
    REQ_HEADER,
    ...Array.from({ length: rows }, (_, i) => [`GEN-0${i + 1}`, 'Shop', `Title ${i + 1}`, `Requirement text ${i + 1}`, 'Must', 'Given/when/then', '', '', '', '']),
  ],
  validations: [{ sqref: `E2:E${rows + 1}`, values: ['Must', 'Should', 'Could'] }, { sqref: `G2:G${rows + 1}`, values: ['Stock', 'Config', 'Custom'] }],
});

// ---------------------------------------------------------------- small units

test('slugifySheet drops the leading number and kebab-cases the rest', () => {
  assert.equal(slugifySheet('2 Requirements'), 'requirements');
  assert.equal(slugifySheet('3 Non-functional & Compliance'), 'non-functional-compliance');
  assert.equal(slugifySheet('6 Vendor Response & Evaluation'), 'vendor-response-evaluation');
  assert.equal(slugifySheet('  '), 'sheet');
});

test('contextKind recognises the tables lib/source.mjs used to name by hand', () => {
  assert.equal(contextKind('4 Integrations'), 'integrations');
  assert.equal(contextKind('5 Migration Inventory'), 'migration');
  assert.equal(contextKind('7 Glossary'), 'glossary');
  assert.equal(contextKind('Zeitplan'), 'other');
});

test('csvCell quotes only what RFC4180 requires', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
});

// ---------------------------------------------------------------- proposal

test('proposes a requirement table with its answer columns and dropdown tokens', () => {
  const snap = snapshotOf(buildWorkbook([reqSheet()]));
  const map = proposeMap(snap);
  const t = map.tables[0];
  assert.equal(t.role, 'requirements');
  assert.equal(t.headerRow, 1);
  assert.equal(t.firstDataRow, 2);
  assert.equal(t.lastDataRow, 4);
  assert.equal(t.columns.id, 'A');
  assert.equal(t.columns.compliance, 'G');
  assert.equal(t.columns.comment, 'H');
  assert.equal(t.columns.effort, 'I');
  assert.deepEqual(t.columns.cost, ['J']);
  assert.deepEqual(t.tokens.compliance, ['Stock', 'Config', 'Custom']);
  assert.deepEqual(t.tokens.priority, ['Must', 'Should', 'Could']);
});

test("the client's own 'Acceptance criteria / Notes' is never taken for our comment column", () => {
  const snap = snapshotOf(buildWorkbook([reqSheet()]));
  const t = proposeMap(snap).tables[0];
  assert.equal(t.columns.acceptance, 'F');
  assert.notEqual(t.columns.comment, 'F');   // writing an answer there would corrupt the tender
});

test('a table with ids but no vendor columns is context, not requirements', () => {
  const snap = snapshotOf(buildWorkbook([{
    name: '4 Integrations',
    rows: [['#', 'System', 'Direction', 'Notes'], ['1', 'ERP', 'in', 'nightly'], ['2', 'PIM', 'out', '']],
  }]));
  const t = proposeMap(snap).tables[0];
  assert.equal(t.role, 'context');
  assert.equal(t.kind, 'integrations');
});

test('hidden and _-prefixed sheets are ignored with a reason, never mapped', () => {
  const snap = snapshotOf(buildWorkbook([
    reqSheet(),
    { name: '_answer_key', state: 'hidden', rows: [['ID', 'Expected'], ['GEN-01', 'Custom']] },
    { name: '_scratch', rows: [['x']] },
  ]));
  const map = proposeMap(snap);
  assert.equal(map.tables.length, 1);
  assert.deepEqual(map.ignored.map(i => i.sheet).sort(), ['_answer_key', '_scratch']);
  assert.match(map.ignored.find(i => i.sheet === '_answer_key').why, /hidden/);
});

test('finds a table that starts mid-sheet', () => {
  const rows = [
    ['Vendor response instructions'], [], ['Some prose about the evaluation'], [],
    REQ_HEADER,
    ['PRJ-01', 'Project', 'Method', 'Agile delivery', 'Must', '—', '', '', '', ''],
    ['PRJ-02', 'Project', 'Team', 'Named team', 'Should', '—', '', '', '', ''],
  ];
  const snap = snapshotOf(buildWorkbook([{ name: '6 Vendor Response', rows, validations: [{ sqref: 'G6:G7', values: ['Stock', 'Custom'] }] }]));
  const t = proposeMap(snap).tables[0];
  assert.equal(t.headerRow, 5);
  assert.equal(t.firstDataRow, 6);
  assert.equal(t.lastDataRow, 7);
});

test('numbers the requirement tables in sheet order for the §1.3 source map', () => {
  const snap = snapshotOf(buildWorkbook([
    { name: '0 Cover', rows: [['A tender']] },
    reqSheet('2 Requirements'),
    reqSheet('3 Non-functional'),
  ]));
  const map = proposeMap(snap);
  const req = map.tables.filter(t => t.role === 'requirements');
  assert.deepEqual(req.map(t => t.n), [1, 2]);
});

// ---------------------------------------------------------------- validation

test('validateMap accepts a proposed map and names every problem in a broken one', () => {
  const snap = snapshotOf(buildWorkbook([reqSheet()]));
  const map = proposeMap(snap);
  assert.deepEqual(validateMap(map), []);

  const broken = JSON.parse(JSON.stringify(map));
  broken.tables[0].firstDataRow = 1;             // not below the header
  broken.tables[0].columns.id = null;
  const problems = validateMap(broken);
  assert.equal(problems.length, 2);
  assert.ok(problems.some(p => /firstDataRow/.test(p)));
  assert.ok(problems.some(p => /no id column/.test(p)));

  assert.deepEqual(validateMap({ tables: [{ sheet: 'x', role: 'nonsense' }] }), ['table "x": unknown role "nonsense"']);
  assert.deepEqual(validateMap(null), ['map is not an object']);
});

test('validateMap rejects two tables sharing one slug (they would overwrite one CSV)', () => {
  const snap = snapshotOf(buildWorkbook([reqSheet('2 Requirements'), reqSheet('Requirements')]));
  const map = proposeMap(snap);
  const problems = validateMap(map);
  assert.ok(problems.some(p => /duplicate table slug/.test(p)));
});

// ---------------------------------------------------------------- CSV

test('emitCsv writes the header row and the data rows, BOM + LF, minimal quoting', () => {
  const buf = buildWorkbook([reqSheet()]);
  const wb = readWorkbook(buf);
  const map = proposeMap(snapshotOf(buf));
  const csv = emitCsv(sheetToGrid(wb.sheets[0]), map.tables[0]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(!csv.includes('\r'));
  const lines = csv.replace(/^﻿/, '').trim().split('\n');
  assert.equal(lines.length, 4);
  // QUOTE_MINIMAL, exactly as the retired python writer: a slash is not a reason to quote.
  assert.ok(lines[0].startsWith('ID,Area,Title,Requirement,Priority,Acceptance criteria / Notes,Vendor: Compliance'));
  assert.ok(lines[1].startsWith('GEN-01,'));
});

test('a mid-sheet table emits from its own header row, not from row 1', () => {
  const rows = [['prose'], [], REQ_HEADER, ['GEN-01', 'Shop', 'T', 'R', 'Must', '—', '', '', '', '']];
  const buf = buildWorkbook([{ name: 'Mid', rows }]);
  const wb = readWorkbook(buf);
  const map = proposeMap(snapshotOf(buf));
  const csv = emitCsv(sheetToGrid(wb.sheets[0]), map.tables[0]).replace(/^﻿/, '');
  assert.ok(csv.startsWith('ID,Area,'));
  assert.ok(!csv.includes('prose'));
});

test('writeTables writes one CSV per non-ignored table, deterministically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-map-'));
  try {
    const buf = buildWorkbook([reqSheet('2 Requirements'), { name: '_answer_key', state: 'hidden', rows: [['secret']] }]);
    const wb = readWorkbook(buf);
    const map = proposeMap(snapshotOf(buf));
    const written = writeTables(wb, map, dir);
    assert.deepEqual(written.map(w => w.file), ['01-requirements.csv']);
    assert.equal(written[0].rows, 3);
    assert.deepEqual(fs.readdirSync(dir), ['01-requirements.csv']);      // the hidden sheet never reaches disk

    const once = fs.readFileSync(path.join(dir, '01-requirements.csv'), 'utf8');
    writeTables(wb, map, dir);
    assert.equal(fs.readFileSync(path.join(dir, '01-requirements.csv'), 'utf8'), once);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('csvNameFor keeps the <pos>-<slug>.csv shape the skill already reads', () => {
  assert.equal(csvNameFor({ index: 3, slug: 'requirements' }), '03-requirements.csv');
  assert.equal(csvNameFor({ index: 12, sheet: '12 Extra Sheet' }), '12-extra-sheet.csv');
});

test('clientColumnsFromMap yields the client columns in sheet order, no duplicates', () => {
  const snap = snapshotOf(buildWorkbook([reqSheet('2 Requirements'), reqSheet('3 Non-functional')]));
  const { files, columns, idHeader } = clientColumnsFromMap(proposeMap(snap));
  assert.deepEqual(files, ['01-requirements.csv', '02-non-functional.csv']);
  assert.equal(idHeader, 'ID');
  assert.deepEqual(columns.map(c => c.header), ['Area', 'Title', 'Requirement', 'Priority', 'Acceptance criteria / Notes']);
  assert.equal(columns.find(c => c.header === 'Requirement').long, true);
});

// ------------------------------------------------------------ a whole tender workbook

test('a whole tender maps to exactly the tables lib/source.mjs used to hard-code', () => {
    const map = proposeMap(snapshotOf(readWorkbook(SAMPLE) && SAMPLE, 'specs/rfp-0042-sample-tender.xlsx'));
    assert.deepEqual(validateMap(map), []);

    const req = map.tables.filter(t => t.role === 'requirements');
    assert.deepEqual(req.map(t => csvNameFor(t)), [
      '03-requirements.csv', '04-non-functional-compliance.csv', '07-vendor-response-evaluation.csv',
    ]);

    // …and the context tables lib/source.mjs looked up by name, now derived from the workbook.
    const ctx = Object.fromEntries(map.tables.filter(t => t.role === 'context').map(t => [t.kind, csvNameFor(t)]));
    assert.equal(ctx.integrations, '05-integrations.csv');
    assert.equal(ctx.migration, '06-migration-inventory.csv');
    assert.equal(ctx.glossary, '08-glossary.csv');

    // The hidden answer key is ignored, so no agent can ever read it.
    assert.deepEqual(map.ignored.map(i => i.sheet), ['_answer_key']);

    const requirements = req[0];
    assert.equal(requirements.headerRow, 1);
    assert.equal(requirements.lastDataRow, 92);
    assert.equal(requirements.columns.compliance, 'J');
    assert.equal(requirements.columns.comment, 'K');
    assert.equal(requirements.columns.effort, 'L');
    assert.deepEqual(requirements.columns.cost, ['M', 'N']);
    assert.deepEqual(requirements.tokens.priority, ['Must', 'Should', 'Could']);
    assert.deepEqual(requirements.tokens.compliance, ['Stock', 'Config', 'Plugin', 'Custom', 'Not offered']);

    // The vendor-response sheet's table really does start at row 20.
    const vendor = req[2];
    assert.equal(vendor.headerRow, 20);
    assert.equal(vendor.firstDataRow, 21);
    assert.equal(vendor.lastDataRow, 30);
  });
