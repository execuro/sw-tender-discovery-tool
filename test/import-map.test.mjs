// The mapping `proposeMap` guesses from a grid snapshot and the digest (`lib/digest.mjs`) carries
// forward as its own `Proposed:` line — a first guess only; the extraction job decides the real
// mapping (own-tabs, build contract `own-tabs-contract.md` §2/§5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook, sheetToGrid } from '../lib/xlsx.mjs';
import {
  proposeMap,
  slugifySheet, contextKind,
  guessCoverageTokenMap, coverageMapComplete, detectDelimiter, parseDelimited, snapshotFromCsv,
  isCommercialHeader,
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
  assert.deepEqual(t.columns.commercial, ['J']);
  assert.deepEqual(t.tokens.compliance, ['Stock', 'Config', 'Custom']);
  assert.equal(t.tokens.priority, undefined, 'priority tokens are client pass-through and dropped from the map');
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

// ---------------------------------------------------------------- RC-4 coverage token map

test('guessCoverageTokenMap: a sensible first guess, per coverage-mapping.md', () => {
  const g = guessCoverageTokenMap(['Stock', 'Config', 'Plugin', 'Custom', 'Not offered']);
  assert.equal(g.OOTB, 'Stock');
  assert.equal(g.Configuration, 'Config');
  assert.equal(g.ISV, 'Plugin');
  assert.equal(g.Custom, 'Custom');
  // Extension and Custom deliberately share ONE customisation-/development-style token
  // (coverage-mapping.md) — not a duplicate-avoidance bug, the client's own wording rarely
  // distinguishes the two either.
  assert.equal(g.Extension, 'Custom');
  assert.deepEqual(Object.keys(g).sort(), ['Configuration', 'Custom', 'Extension', 'ISV', 'OOTB', '—'].sort());
});

test('guessCoverageTokenMap: Extension never falls back to the Configuration token — it shares Custom\'s customisation-style token instead, even when nothing in the list reads as "extension" wording', () => {
  // "Configurable" only matches Configuration's own regex; "Bespoke" only matches Custom's. Extension
  // has no direct match of its own here — it must still land on "Bespoke" (customisation-style),
  // never drift onto "Configurable" just because Configuration sits next to it.
  const g = guessCoverageTokenMap(['Standard', 'Configurable', 'Bespoke']);
  assert.equal(g.Configuration, 'Configurable');
  assert.equal(g.Custom, 'Bespoke');
  assert.equal(g.Extension, 'Bespoke', 'Extension must share Custom\'s token, not borrow Configuration\'s');
});

test('guessCoverageTokenMap: an unrecognised token list guesses nothing, never throws', () => {
  assert.deepEqual(guessCoverageTokenMap([]), { OOTB: '', Configuration: '', Extension: '', ISV: '', Custom: '', '—': '' });
  assert.deepEqual(guessCoverageTokenMap(undefined), { OOTB: '', Configuration: '', Extension: '', ISV: '', Custom: '', '—': '' });
});

// ---------------------------------------------------------------- leftover columns (fixed rule)

test('isCommercialHeader: money/cost words, in English and German', () => {
  assert.equal(isCommercialHeader('Vendor: One-off cost (EUR)'), true);
  assert.equal(isCommercialHeader('Kosten'), true);
  assert.equal(isCommercialHeader('Preis'), true);
  assert.equal(isCommercialHeader('Area'), false);
});

test('coverageMapComplete: true only once all six keys carry a non-empty value', () => {
  assert.equal(coverageMapComplete(undefined), false);
  assert.equal(coverageMapComplete({}), false);
  assert.equal(coverageMapComplete({ OOTB: 'Stock', Configuration: 'Config', Extension: 'Config', ISV: '', Custom: 'Custom', '—': 'Stock' }), false);
  assert.equal(coverageMapComplete({ OOTB: 'Stock', Configuration: 'Config', Extension: 'Config', ISV: 'Custom', Custom: 'Custom', '—': 'Stock' }), true);
});

test('proposeMap records the compliance dropdown for later coverage-token mapping, and an assumptions column when named', () => {
  const rows = [
    [...REQ_HEADER, 'Vendor: Assumptions'],
    ...Array.from({ length: 2 }, (_, i) => [`GEN-0${i + 1}`, 'Shop', `Title ${i + 1}`, `Req ${i + 1}`, 'Must', '—', '', '', '', '', '']),
  ];
  const snap = snapshotOf(buildWorkbook([{ name: 'Requirements', rows, validations: [{ sqref: 'G2:G3', values: ['Stock', 'Config', 'Custom'] }] }]));
  const t = proposeMap(snap).tables[0];
  assert.deepEqual(t.tokens.compliance, ['Stock', 'Config', 'Custom']);
  // RC-4: the six-value coverage map itself is no longer guessed/written at propose time — that
  // happens agentically at export (`tokens --suggest`/`--file`).
  assert.equal(t.tokens.coverage, undefined);
  assert.equal(t.columns.assumptions, 'K');
  assert.equal(t.assumptionsColumn, 'K');
});

// ---------------------------------------------------------------- SI-2: no id column

test('proposeMap still finds a requirements table with no id-like column at all (SI-2)', () => {
  const rows = [
    ['Title', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'],
    ['Hosting', 'The bidder recommends a hosting provider.', 'Must', '', '', ''],
    ['Packaging', 'Quantities are multiples of the packaging unit.', 'Should', '', '', ''],
  ];
  const snap = snapshotOf(buildWorkbook([{ name: 'Requirements', rows }]));
  const t = proposeMap(snap).tables[0];
  assert.equal(t.role, 'requirements');
  assert.equal(t.columns.id, null);
  assert.equal(t.headerRow, 1);
  assert.equal(t.lastDataRow, 3);
});

// ---------------------------------------------------------------- CSV source (task 2)

test('detectDelimiter picks comma, semicolon or tab from the first line', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('just one column'), ',');
});

test('parseDelimited: quoted fields, embedded delimiter, any single-char separator', () => {
  assert.deepEqual(parseDelimited('a,b\n"x,y",z\n', ','), [['a', 'b'], ['x,y', 'z']]);
  assert.deepEqual(parseDelimited('a;b\n"x;y";z\n', ';'), [['a', 'b'], ['x;y', 'z']]);
});

test('snapshotFromCsv builds the one-sheet snapshot proposeMap already understands', () => {
  const csv = 'ID,Requirement,Vendor: Compliance,Vendor: Comment,Vendor: Effort (PD)\nGEN-01,Some text,,,\nGEN-02,More text,,,\n';
  const snap = snapshotFromCsv(csv, { source: 'specs/x.csv', sha256: 'a'.repeat(64) });
  assert.equal(snap.delimiter, ',');
  assert.equal(snap.sheets.length, 1);
  const map = proposeMap(snap);
  const t = map.tables[0];
  assert.equal(t.role, 'requirements');
  assert.equal(t.columns.id, 'A');
  assert.equal(t.columns.requirement, 'B');
  assert.equal(t.lastDataRow, 3);
});

// ------------------------------------------------------------ a whole tender workbook

test('a whole tender maps to exactly the tables the digest names', () => {
    const map = proposeMap(snapshotOf(readWorkbook(SAMPLE) && SAMPLE, 'specs/rfp-0042-sample-tender.xlsx'));

    const req = map.tables.filter(t => t.role === 'requirements');
    assert.deepEqual(req.map(t => t.sheet), [
      '2 Requirements', '3 Non-functional & Compliance', '6 Vendor Response & Evaluation',
    ]);

    // …and the context tables, each recognised by kind from its own sheet name.
    const ctx = Object.fromEntries(map.tables.filter(t => t.role === 'context').map(t => [t.kind, t.sheet]));
    assert.equal(ctx.integrations, '4 Integrations');
    assert.equal(ctx.migration, '5 Migration Inventory');
    assert.equal(ctx.glossary, '7 Glossary');

    // The hidden answer key is ignored, so no agent can ever read it.
    assert.deepEqual(map.ignored.map(i => i.sheet), ['_answer_key']);

    const requirements = req[0];
    assert.equal(requirements.headerRow, 1);
    assert.equal(requirements.lastDataRow, 92);
    assert.equal(requirements.columns.compliance, 'J');
    assert.equal(requirements.columns.comment, 'K');
    assert.equal(requirements.columns.effort, 'L');
    assert.deepEqual(requirements.columns.commercial, ['M', 'N']);
    // Leftover columns by fixed rule: the commercial-header heuristic already caught M/N above;
    // every other leftover (Area, Sub-area) lands in context, with no operator "ignore" choice.
    assert.deepEqual(requirements.columns.context, ['B', 'C']);
    assert.equal(requirements.tokens.priority, undefined, 'priority tokens are client pass-through and dropped from the map');
    assert.deepEqual(requirements.tokens.compliance, ['Stock', 'Config', 'Plugin', 'Custom', 'Not offered']);

    // The vendor-response sheet's table really does start at row 20.
    const vendor = req[2];
    assert.equal(vendor.headerRow, 20);
    assert.equal(vendor.firstDataRow, 21);
    assert.equal(vendor.lastDataRow, 30);
  });
