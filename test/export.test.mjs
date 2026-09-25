// `exportWorkbook` — X-1..X-8, contract §4 (fit-back map, own tabs). AC-21 (unconfirmed empty
// cells), AC-22 (surgical, byte-identical elsewhere, on copies of the real samples), AC-23/AC-24
// (assumptions column vs. appended to the Response), AC-26 (own-tabs workbook for csv/pdf
// sources), AC-27 (money refusal).
//
// These tests build the fit-back map and the working document directly (`test/helpers/
// analysis-doc.mjs`) instead of going through `intake`/`import` — WP-4's write scope is the export
// side only, and `lib/intake.mjs` is mid-rewrite under a concurrent work package (contract §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exportWorkbook } from '../lib/import-export.mjs';
import { readWorkbook, sheetToGrid, openZip } from '../lib/xlsx.mjs';
import { parse } from '../lib/parse.mjs';
import { exportText, resolveTable } from '../lib/export-text.mjs';
import { buildWorkbook } from './helpers/mkxlsx.mjs';
import { buildAnalysisDoc, writeFitBackMap } from './helpers/analysis-doc.mjs';
import { diffWorkbooks } from './helpers/xlsx-diff.mjs';
import { scanMoneyBeforeBuild } from '../lib/xlsx-build.mjs';
import { main as checkMain, renderTotals } from '../lib/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPECS = path.join(here, '..', '..', '..', '..', 'specs');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-export-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Same fixture-doc host `check.test.mjs` uses, so `checkMain` resolves the same root/doc shape. */
function checkHost(docContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-export-check-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const doc = path.join(root, 'specs', 'rfp-0101-xlsx-ids-analysis.md');
  fs.writeFileSync(doc, docContent, 'utf8');
  return { root, doc, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The zip part a `buildWorkbook(sheets)` fixture gives its `name`d sheet, by position. */
function partFor(sheets, name) { return `xl/worksheets/sheet${sheets.findIndex(s => s.name === name) + 1}.xml`; }

/**
 * Writes an xlsx source (`sheets`, `mkxlsx.mjs` shape), its fit-back map (`tables`, `items` —
 * contract §4 shape, `part` filled in from `sheets` automatically) and the working document
 * (`groups` — `analysis-doc.mjs` shape) into a fresh host. Returns `{ sourceAbs, doc, map }`.
 */
function xlsxCase(h, { rel, sheets, tables, items, groups, projectInfo, unusedSheets = [] }) {
  const sourceAbs = path.join(h.root, rel);
  fs.writeFileSync(sourceAbs, buildWorkbook(sheets));
  const filledTables = tables.map(t => ({ ...t, part: t.part || partFor(sheets, t.sheet) }));
  const map = writeFitBackMap(sourceAbs, { tables: filledTables, items, unusedSheets });
  const doc = path.join(h.root, 'specs', `${path.basename(rel, path.extname(rel))}-analysis.md`);
  const sourceHash = sha256(fs.readFileSync(sourceAbs));
  fs.writeFileSync(doc, buildAnalysisDoc({
    slug: path.basename(rel, path.extname(rel)),
    sourceFile: path.basename(rel), sourceHash, groups, projectInfo,
  }), 'utf8');
  return { sourceAbs, doc, map };
}

const item = (overrides = {}) => ({ prio: 'Must', status: { kind: 'confirmed', date: '2026-09-20', cq: null }, ...overrides });

// ---------------------------------------------------------------- AC-21 / X-1

test('AC-21/X-1: export succeeds with unconfirmed items exporting empty answer cells', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'],
      ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0301-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'C', compliance: 'E', comment: 'F', effort: 'G' }, tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', status: { kind: 'queued' } })] }],
    });

    const result = exportWorkbook(doc, {});
    assert.equal(result.written, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.notWritten, []);
    const wb = readWorkbook(fs.readFileSync(result.file));
    const grid = sheetToGrid(wb.sheets[0]);
    assert.deepEqual(grid.rows[1].slice(4, 7), ['', '', '']);   // compliance/comment/effort all empty
    assert.equal(grid.rows[1][0], 'GEN-01');                     // the client's own cell, untouched
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- RC-4: coverage tokens at export

test('RC-4: an xlsx export refuses when a table\'s compliance column has no full coverage-token map yet, and lists the table by its fit-back key', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'],
      ['GEN-01', 'Shop', 'Customers can create an account.', 'Must', '', '', ''],
    ] }];
    const { doc, sourceAbs } = xlsxCase(h, {
      rel: 'specs/rfp-0313-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'C', compliance: 'E', comment: 'F', effort: 'G' }, tokens: {} }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' })] }],
    });

    assert.throws(() => exportWorkbook(doc, {}), /coverage tokens not mapped.*Requirements r1/s);

    const mapFile = path.join(h.root, 'specs', 'rfp-0313-mini', 'import-map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    map.tables[0].tokens.coverage = { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' };
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2) + '\n');
    const result = exportWorkbook(doc, {});
    assert.equal(result.written, 1);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- pointer targeting (contract §4)

test('pointer targeting: a blank row between items does not shift the answers — each item lands exactly at its pointer\'s row', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['Requirement', 'Rating', 'Response', 'Notes'],
      ['Customers can create an account.', '', '', ''],
      ['', '', '', ''],   // blank row in the client's own sheet, between two real ones
      ['Customers can request a quote.', '', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0304-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 4,
        columns: { requirement: 'A', comment: 'C' }, tokens: {} }],
      items: {
        'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 },
        'GEN-02': { table: 'Requirements r1', sheet: 'Requirements', row: 4 },
      },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', clientResponse: 'Covered.' }),
        item({ id: 'GEN-02', requirement: 'Customers can request a quote.', clientResponse: 'Covered.' }),
      ] }],
    });

    const result = exportWorkbook(doc, {});
    assert.equal(result.written, 2);
    const wb = readWorkbook(fs.readFileSync(result.file));
    const grid = sheetToGrid(wb.sheets[0]);
    assert.equal(grid.rows[1][2], 'Covered.', 'first item, row 2');
    assert.equal(grid.rows[3][2], 'Covered.', 'second item, row 4 — the blank row (3) did not shift it');
    assert.equal(grid.rows[2][2], '', 'the blank row itself stays untouched');
  } finally { h.cleanup(); }
});

test('pointer targeting: an item moved to another tab in the working document still lands on its source row', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Rating', 'Response'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0320-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', comment: 'D' }, tokens: {} }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      // Moved to Non-functional in the working document — the pointer, not the item's current
      // tab/topic, decides where the answer lands.
      groups: [{ tab: 'Non-functional', topic: 'Moved items', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', clientResponse: 'Covered after the move.' }),
      ] }],
    });

    const result = exportWorkbook(doc, {});
    assert.equal(result.written, 1);
    const wb = readWorkbook(fs.readFileSync(result.file));
    const grid = sheetToGrid(wb.sheets[0]);
    assert.equal(grid.rows[1][3], 'Covered after the move.');
  } finally { h.cleanup(); }
});

test('pointer-less item: reported "not written: <id> (no source row)", never silently dropped, and does not count as written or skipped', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Rating', 'Response'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0321-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', comment: 'D' }, tokens: {} }],
      items: {},   // GEN-02 has no pointer at all
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-02', requirement: 'A requirement the fit-back map never recorded.', clientResponse: 'Covered.' }),
      ] }],
    });

    const result = exportWorkbook(doc, {});
    assert.equal(result.written, 0);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.notWritten, ['not written: GEN-02 (no source row)']);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- AC-22 / X-2 / X-4, real samples

test('AC-22: rfp-0001 (sample A) — surgical export, original hash unchanged, only answer cells differ', () => {
  const name = 'rfp-0001-hartmann-industriebedarf-replatforming.xlsx';
  const real = path.join(SPECS, name);
  if (!fs.existsSync(real)) { console.log(`  (skipped — ${name} not present)`); return; }
  const h = host();
  try {
    const before = fs.readFileSync(real);
    const beforeHash = sha256(before);
    const sourceAbs = path.join(h.root, 'specs', name);
    fs.writeFileSync(sourceAbs, before);   // work on a copy, never the tracked file

    const map = writeFitBackMap(sourceAbs, {
      tables: [{ key: '2 Requirements r1', sheet: '2 Requirements', part: 'xl/worksheets/sheet3.xml',
        headerRow: 1, firstDataRow: 2, lastDataRow: 92,
        columns: { id: 'A', requirement: 'E', compliance: 'J', comment: 'K', effort: 'L' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: '2 Requirements r1', sheet: '2 Requirements', row: 2 } },
    });
    const doc = path.join(h.root, 'specs', `${path.basename(name, '.xlsx')}-analysis.md`);
    const sourceHash = sha256(fs.readFileSync(sourceAbs));
    fs.writeFileSync(doc, buildAnalysisDoc({
      slug: path.basename(name, '.xlsx'), sourceFile: name, sourceHash,
      groups: [{ tab: 'Functional', topic: 'General', items: [
        item({ id: 'GEN-01', requirement: 'The new shop must be built on Shopware 6.7.', coverage: 'OOTB', clientResponse: 'Confirmed.' }),
      ] }],
    }), 'utf8');

    const result = exportWorkbook(doc, {});
    assert.equal(result.written, 1);
    assert.deepEqual(result.notWritten, []);

    assert.equal(sha256(fs.readFileSync(real)), beforeHash, 'the real, git-tracked file is untouched');
    assert.equal(sha256(fs.readFileSync(sourceAbs)), beforeHash, 'nor the working copy export read from');

    const diff = diffWorkbooks(before, fs.readFileSync(result.file));
    const unexpected = diff.changed.filter(n => n !== 'xl/workbook.xml' && !/^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    assert.deepEqual(unexpected, [], `unexpected parts changed: ${unexpected.join(', ')}`);
    assert.deepEqual(diff.changed.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)), ['xl/worksheets/sheet3.xml']);
  } finally { h.cleanup(); }
});

test('AC-22: rfp-0002 (sample B) — surgical export on its own sheet, part-level diff shows only that sheet changed', () => {
  const name = 'rfp-0002-b2b-ecommerce-smb.xlsx';
  const real = path.join(SPECS, name);
  if (!fs.existsSync(real)) { console.log(`  (skipped — ${name} not present)`); return; }
  const h = host();
  try {
    const before = fs.readFileSync(real);
    const beforeHash = sha256(before);
    const sourceAbs = path.join(h.root, 'specs', name);
    fs.writeFileSync(sourceAbs, before);

    // "3.1 General": header row 5, first data row 6, ITEM=B, RATING=C, RESPONSE=D — no id column.
    writeFitBackMap(sourceAbs, {
      tables: [{ key: '3.1 General r5', sheet: '3.1 General', part: 'xl/worksheets/sheet4.xml',
        headerRow: 5, firstDataRow: 6, lastDataRow: 6,
        columns: { requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'ITM-01': { table: '3.1 General r5', sheet: '3.1 General', row: 6 } },
    });
    const doc = path.join(h.root, 'specs', `${path.basename(name, '.xlsx')}-analysis.md`);
    const sourceHash = sha256(fs.readFileSync(sourceAbs));
    fs.writeFileSync(doc, buildAnalysisDoc({
      slug: path.basename(name, '.xlsx'), sourceFile: name, sourceHash,
      groups: [{ tab: 'Functional', topic: 'General', items: [
        item({ id: 'ITM-01', requirement: 'Is your software designed for B2B market requirements?', coverage: 'OOTB', clientResponse: 'Yes.' }),
      ] }],
    }), 'utf8');

    const result = exportWorkbook(doc, {});
    assert.equal(result.written, 1);

    assert.equal(sha256(fs.readFileSync(real)), beforeHash);
    assert.equal(sha256(fs.readFileSync(sourceAbs)), beforeHash);

    const diff = diffWorkbooks(before, fs.readFileSync(result.file));
    const unexpected = diff.changed.filter(n => n !== 'xl/workbook.xml' && !/^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    assert.deepEqual(unexpected, []);
    assert.deepEqual(diff.changed.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)), ['xl/worksheets/sheet4.xml']);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- AC-23 / AC-24 (assumptions)

test('AC-23: a mapped assumptions column gets the bullets; the Response cell is the Client Response only', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment', 'Assumptions'],
      ['GEN-01', 'Customers can create an account.', '', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0302-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' }, assumptionsColumn: 'E',
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.', assumptions: ['Email verification is not required'] }),
      ] }],
    });

    const result = exportWorkbook(doc, {});
    const wb = readWorkbook(fs.readFileSync(result.file));
    const grid = sheetToGrid(wb.sheets[0]);
    assert.equal(grid.rows[1][3], 'Stock accounts cover this.');
    assert.equal(grid.rows[1][4], '- Email verification is not required');
  } finally { h.cleanup(); }
});

test('AC-24: no assumptions column — the Response cell holds the Client Response followed by the bullets, no column added', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc, sourceAbs } = xlsxCase(h, {
      rel: 'specs/rfp-0303-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.', assumptions: ['Email verification is not required'] }),
      ] }],
    });

    const result = exportWorkbook(doc, {});
    const before = readWorkbook(fs.readFileSync(sourceAbs));
    const after = readWorkbook(fs.readFileSync(result.file));
    const grid = sheetToGrid(after.sheets[0]);
    assert.equal(grid.rows[1][3], 'Stock accounts cover this.\n- Email verification is not required');
    assert.equal(grid.width, sheetToGrid(before.sheets[0]).width);   // no column appended
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- AC-26 (csv/pdf -> own-tabs workbook)

test('AC-26: a CSV source exports the tool\'s own workbook — Overview, Project information, all three scope tabs (always present), Integrations, Glossary, in that order', () => {
  const h = host();
  try {
    const sourceFile = 'rfp-0304-mini.csv';
    const doc = path.join(h.root, 'specs', 'rfp-0304-mini-analysis.md');
    fs.writeFileSync(doc, buildAnalysisDoc({
      slug: 'rfp-0304-mini', sourceFile, sourceHash: 'deadbeef',
      projectInfo: [{ key: 'business-model', value: 'B2B wholesale', source: 'operator' }],
      groups: [
        { tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' })] },
        { tab: 'Project & services', topic: 'Go-live', items: [item({ id: 'PRJ-01', requirement: 'A go-live checklist.', status: { kind: 'queued' } })] },
      ],
      integrations: '| System | Direction |\n| --- | --- |\n| ERP | Inbound |',
      glossary: '- SKU: stock keeping unit',
    }), 'utf8');

    const result = exportWorkbook(doc, {});
    const wb = readWorkbook(fs.readFileSync(result.file));
    const names = wb.sheets.map(s => s.name);
    assert.deepEqual(names, ['Overview', 'Project information', 'Functional', 'Non-functional', 'Project & services', 'Integrations', 'Glossary']);

    const pi = sheetToGrid(wb.sheets.find(s => s.name === 'Project information'));
    assert.deepEqual(pi.rows[0], ['Parameter', 'Value', 'Source']);
    const biz = pi.rows.find(r => r[0] === 'Business model');
    assert.deepEqual(biz, ['Business model', 'B2B wholesale', 'operator']);
    const notStatedRow = pi.rows.find(r => r[0] === 'Markets');
    assert.equal(notStatedRow[1], 'not stated');

    const functional = sheetToGrid(wb.sheets.find(s => s.name === 'Functional'));
    assert.deepEqual(functional.rows[0], ['ID', 'Topic', 'Requirement', 'Requirement Coverage', 'Estimation', 'Client Response', 'Assumptions']);
    assert.equal(functional.rows[1][0], 'GEN-01');
    assert.equal(functional.rows[1][1], 'Requirements');
    assert.equal(functional.rows[1][3], 'OOTB');

    // Non-functional has no items, but the tab is present with its header row only.
    const nonFunctional = sheetToGrid(wb.sheets.find(s => s.name === 'Non-functional'));
    assert.deepEqual(nonFunctional.rows, [['ID', 'Topic', 'Requirement', 'Requirement Coverage', 'Estimation', 'Client Response', 'Assumptions']]);

    const svcTab = sheetToGrid(wb.sheets.find(s => s.name === 'Project & services'));
    assert.equal(svcTab.rows[1][0], 'PRJ-01');
    assert.equal(svcTab.rows[1][3], '', 'unconfirmed item — empty answer cells (X-1)');

    // §6 Integrations: a markdown table becomes rows with its header, separator dropped.
    const integrations = sheetToGrid(wb.sheets.find(s => s.name === 'Integrations'));
    assert.deepEqual(integrations.rows, [['System', 'Direction'], ['ERP', 'Inbound']]);

    // §7 Glossary: prose (a bullet list here) becomes one row per bullet.
    const glossary = sheetToGrid(wb.sheets.find(s => s.name === 'Glossary'));
    assert.deepEqual(glossary.rows, [['SKU: stock keeping unit']]);

    // Overview holds what the working sheet's Totals tab holds, plus the readiness line.
    const overview = sheetToGrid(wb.sheets.find(s => s.name === 'Overview'));
    assert.equal(overview.rows[0][0], 'Regime: T-shirt, default scale, before overhead and buffer');
    assert.ok(overview.rows.some(r => /^Confirmed \d+ of \d+ · Reopened/.test(r[0] || '')), 'readiness counts line present');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- AC-27 (money refusal)

test('AC-27: export refuses when tool-written text carries a money term', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0305-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'A fixed price applies for this.' }),
      ] }],
    });

    assert.throws(() => exportWorkbook(doc, {}), /money/);
    assert.equal(fs.existsSync(path.join(h.root, 'specs', 'rfp-0305-mini-response-v1.xlsx')), false);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- T3 (export/check money scan agree)

const T3_FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), 'utf8');

function docWithClientResponse(newResponse) {
  const doc0 = T3_FIXTURE
    .replace('We build a dedicated audit-trail module for pricing changes.', newResponse)
    .replace('| failed: no stock or project feature to extend | failed |', '|  | confirmed 2026-09-20 |');
  const model = parse(doc0);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  return { doc: doc0.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`), items: model.items };
}

test('T3: the export scan and `check`\'s money scan agree on the same document — both accept "prices" exempted by the Requirement\'s "price" (R-7a stem)', async () => {
  const { doc, items } = docWithClientResponse('We build a dedicated audit-trail module that tracks prices over time.');
  const exportHits = scanMoneyBeforeBuild(items);
  assert.deepEqual(exportHits, [], 'the export scan must exempt "prices" the same way check does');

  const h = checkHost(doc);
  try {
    await checkMain([h.doc]);
    assert.equal(process.exitCode ?? 0, 0, 'check must not flag the same text the export scan accepted');
  } finally { process.exitCode = 0; h.cleanup(); }
});

test('T3: the export scan and `check`\'s money scan agree on the same document — both refuse "budget", never mentioned in the Requirement', async () => {
  const { doc, items } = docWithClientResponse('We build a dedicated audit-trail module; the budget is fixed.');
  const exportHits = scanMoneyBeforeBuild(items);
  assert.ok(exportHits.length, 'the export scan must flag "budget"');

  const h = checkHost(doc);
  try {
    await checkMain([h.doc]);
    assert.notEqual(process.exitCode ?? 0, 0, 'check must flag the same text the export scan refused');
  } finally { process.exitCode = 0; h.cleanup(); }
});

// ---------------------------------------------------------------- refusing to overwrite the source (D-10)

test('export refuses an --out that resolves to the source workbook itself', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0306-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' })] }],
    });
    const sourceAbs = path.join(h.root, 'specs', 'rfp-0306-mini.xlsx');

    const before = fs.readFileSync(sourceAbs);
    assert.throws(() => exportWorkbook(doc, { out: 'rfp-0306-mini.xlsx' }), /resolves to the source file/);
    assert.deepEqual(fs.readFileSync(sourceAbs), before, 'the source file must be untouched');
  } finally { h.cleanup(); }
});

test('export refuses a non-.xlsx --out (e.g. naming the CSV/PDF source itself) for a working-sheet export too (#3)', () => {
  const h = host();
  try {
    const doc = path.join(h.root, 'specs', 'rfp-0307-mini-analysis.md');
    fs.writeFileSync(doc, buildAnalysisDoc({
      slug: 'rfp-0307-mini', sourceFile: 'rfp-0307-mini.csv', sourceHash: 'deadbeef',
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' })] }],
    }), 'utf8');

    assert.throws(() => exportWorkbook(doc, { out: 'rfp-0307-mini.csv' }), /--out must end in \.xlsx/);
  } finally { h.cleanup(); }
});

test('#3: export refuses an --out that does not end in .xlsx, or that resolves to the working document', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0311-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' })] }],
    });

    assert.throws(() => exportWorkbook(doc, { out: 'response.txt' }), /--out must end in \.xlsx/);
    const rewrittenDoc = doc.replace(/\.md$/, '.xlsx');
    fs.renameSync(doc, rewrittenDoc);
    assert.throws(() => exportWorkbook(rewrittenDoc, { out: rewrittenDoc }), /resolves to the working document/);
  } finally { h.cleanup(); }
});

test('D-34: an explicit --out that already exists is refused, even a file this tool wrote for this document itself', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0312-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' })] }],
    });

    const otherClientsWorkbook = path.join(h.root, 'specs', 'someone-elses-workbook.xlsx');
    fs.writeFileSync(otherClientsWorkbook, 'not actually xlsx, just needs to exist');
    assert.throws(() => exportWorkbook(doc, { out: otherClientsWorkbook }), /already exists/);
    assert.equal(fs.readFileSync(otherClientsWorkbook, 'utf8'), 'not actually xlsx, just needs to exist', 'untouched');

    const first = exportWorkbook(doc, {});
    assert.ok(fs.existsSync(first.file));
    assert.throws(() => exportWorkbook(doc, { out: first.file }), /already exists/, 'even its own previous export file is refused as an explicit --out');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- D-34 (numbered exports)

test('D-34: every export writes a new, numbered file — v1 then v2 both exist, neither overwritten', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc, sourceAbs } = xlsxCase(h, {
      rel: 'specs/rfp-0340-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' })] }],
    });

    const first = exportWorkbook(doc, {});
    assert.equal(path.basename(first.file), 'rfp-0340-mini-response-v1.xlsx');
    assert.equal(first.version, 1);
    assert.ok(fs.existsSync(first.file));

    const before1 = fs.readFileSync(first.file);
    const second = exportWorkbook(doc, {});
    assert.equal(path.basename(second.file), 'rfp-0340-mini-response-v2.xlsx');
    assert.equal(second.version, 2);
    assert.ok(fs.existsSync(second.file), 'v1 stays in place');
    assert.deepEqual(fs.readFileSync(first.file), before1, 'v1 is untouched by the second export');
    void sourceAbs;
  } finally { h.cleanup(); }
});

test('D-34: `changedSinceLast` names the item whose Client Response changed, and is empty on an unchanged re-export', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
      ['GEN-02', 'Customers can request a quote.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0341-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 3,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: {
        'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 },
        'GEN-02': { table: 'Requirements r1', sheet: 'Requirements', row: 3 },
      },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' }),
        item({ id: 'GEN-02', requirement: 'Customers can request a quote.', coverage: 'OOTB', clientResponse: 'Quotes are supported.' }),
      ] }],
    });

    const first = exportWorkbook(doc, {});
    assert.equal(first.version, 1);
    assert.deepEqual([...first.changedSinceLast].sort(), ['GEN-01', 'GEN-02'], 'first export: every confirmed item is newly confirmed');

    const unchanged = exportWorkbook(doc, {});
    assert.equal(unchanged.version, 2);
    assert.deepEqual(unchanged.changedSinceLast, [], 'nothing edited since v1 — nothing changed');

    const text = fs.readFileSync(doc, 'utf8');
    fs.writeFileSync(doc, text.replace('Quotes are supported.', 'Quotes are supported, with a discount schedule.'));
    const third = exportWorkbook(doc, {});
    assert.equal(third.version, 3);
    assert.deepEqual(third.changedSinceLast, ['GEN-02'], 'only the item whose Client Response changed');
  } finally { h.cleanup(); }
});

test('D-34: each export appends one §8 Log line naming its version, file, confirmed count and changed-since count', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0342-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'x', Configuration: 'x', Extension: 'x', ISV: 'x', Custom: 'x', '—': 'x' } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Stock accounts cover this.' })] }],
    });

    exportWorkbook(doc, {});
    let text = fs.readFileSync(doc, 'utf8');
    assert.match(text, /- \d{4}-\d{2}-\d{2} · export v1 · .*rfp-0342-mini-response-v1\.xlsx · confirmed 1\/1 · changed since —: 1/);

    exportWorkbook(doc, {});
    text = fs.readFileSync(doc, 'utf8');
    assert.match(text, /- \d{4}-\d{2}-\d{2} · export v2 · .*rfp-0342-mini-response-v2\.xlsx · confirmed 1\/1 · changed since v1: 0/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- profile regime in the own-tabs workbook

test('a CSV/PDF own-tabs export in the profile regime names the actual regime, and marks an over-calibration item not decomposed, in the By tab totals', () => {
  const h = host();
  try {
    fs.writeFileSync(path.join(h.root, 'specs', 'rfp-partner-profile.md'),
      '---\ncalibration: { small: 2, big: 5 }\noverhead: 10\nbuffer: { percent: 5, mode: folded }\nisv: []\nassets: []\n---\n');
    const doc = path.join(h.root, 'specs', 'rfp-0308-mini-analysis.md');
    fs.writeFileSync(doc, buildAnalysisDoc({
      slug: 'rfp-0308-mini', sourceFile: 'rfp-0308-mini.csv', sourceHash: 'deadbeef',
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'Custom', effort: { size: null, pd: 12, regime: 'profile' }, clientResponse: 'A dedicated module.' }),
      ] }],
    }), 'utf8');

    const result = exportWorkbook(doc, {});
    const wb = readWorkbook(fs.readFileSync(result.file));
    const totals = wb.sheets.find(s => s.name === 'Overview');
    const grid = sheetToGrid(totals);
    assert.equal(grid.rows[0][0], 'Regime: profile (overhead 10%, buffer 5% folded)');
    const byTabHeader = grid.rows.findIndex(r => r[0] === 'By tab');
    const tabRow = grid.rows[byTabHeader + 2]; // heading row, then TOTALS_HEADER, then the one tab
    assert.equal(tabRow[0], 'Functional');
    assert.equal(Number(tabRow[5]), 1, 'GEN-01 (12 PD, over the 5 PD big calibration) counts as not decomposed');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- N-5 (preview == export, no client token map)

test('N-5: for a CSV/PDF source with no fit-back map, the export-text preview token equals the own-tabs Requirement Coverage cell', () => {
  const h = host();
  try {
    const doc = path.join(h.root, 'specs', 'rfp-0310-mini-analysis.md');
    fs.writeFileSync(doc, buildAnalysisDoc({
      slug: 'rfp-0310-mini', sourceFile: 'rfp-0310-mini.csv', sourceHash: 'deadbeef',
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'Extension', clientResponse: 'A small extension covers this.' }),
      ] }],
    }), 'utf8');

    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    const modelItem = model.items.find(i => i.id === 'GEN-01');
    const preview = exportText(modelItem, resolveTable(null, modelItem), { preview: true });
    assert.equal(preview.token, 'Extension', 'preview shows the six value as-is, no client token map');

    const result = exportWorkbook(doc, {});
    const wb = readWorkbook(fs.readFileSync(result.file));
    const grid = sheetToGrid(wb.sheets.find(s => s.name === 'Functional'));
    assert.equal(grid.rows[1][3], preview.token, 'the exported Requirement Coverage cell matches the preview exactly');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- shared table resolver (D-2)

test('the surgical xlsx export resolves each item\'s coverage token and assumptions column from its OWN table (by fit-back key), not the map\'s first table', () => {
  const h = host();
  try {
    const sheets = [
      { name: 'Sheet A', rows: [
        ['ID', 'Requirement', 'Compliance', 'Comment'],
        ['GEN-01', 'Customers can create an account.', '', ''],
      ] },
      { name: 'Sheet B', rows: [
        ['ID', 'Requirement', 'Compliance', 'Comment'],
        ['GEN-02', 'Customers can pay by invoice.', '', ''],
      ] },
    ];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0309-mini.xlsx', sheets,
      tables: [
        { key: 'Sheet A r1', sheet: 'Sheet A', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
          columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
          tokens: { coverage: { OOTB: 'Erfuellt', Custom: 'Nicht erfuellt', Configuration: 'x', Extension: 'x', ISV: 'x', '—': 'x' } } },
        { key: 'Sheet B r1', sheet: 'Sheet B', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
          columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
          tokens: { coverage: { OOTB: 'Ja', Custom: 'Nein', Configuration: 'x', Extension: 'x', ISV: 'x', '—': 'x' } } },
      ],
      items: {
        'GEN-01': { table: 'Sheet A r1', sheet: 'Sheet A', row: 2 },
        'GEN-02': { table: 'Sheet B r1', sheet: 'Sheet B', row: 2 },
      },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'OOTB', clientResponse: 'Covered.' }),
        item({ id: 'GEN-02', requirement: 'Customers can pay by invoice.', coverage: 'OOTB', clientResponse: 'Covered.' }),
      ] }],
    });

    const result = exportWorkbook(doc, {});
    const wb = readWorkbook(fs.readFileSync(result.file));
    const sheetA = sheetToGrid(wb.sheets.find(s => s.name === 'Sheet A'));
    const sheetB = sheetToGrid(wb.sheets.find(s => s.name === 'Sheet B'));
    assert.equal(sheetA.rows[1][2], 'Erfuellt', 'Sheet A item uses Sheet A\'s own token map');
    assert.equal(sheetB.rows[1][2], 'Ja', 'Sheet B item uses Sheet B\'s own token map, not Sheet A\'s');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- T2: numeric-key legends

test('T2: a numeric-key legend writes the NUMBER, not the label, into the compliance cell', () => {
  const h = host();
  try {
    const sheets = [{ name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Compliance', 'Comment'],
      ['GEN-01', 'Customers can create an account.', '', ''],
    ] }];
    const { doc } = xlsxCase(h, {
      rel: 'specs/rfp-0330-mini.xlsx', sheets,
      tables: [{ key: 'Requirements r1', sheet: 'Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
        columns: { id: 'A', requirement: 'B', compliance: 'C', comment: 'D' },
        tokens: { coverage: { OOTB: 'Standard', Custom: 'Customization', Configuration: 'Configuration', Extension: 'x', ISV: 'x', '—': 'x' },
          complianceLegend: { 'Not Supported': 0, Roadmap: 1, Customization: 2, Configuration: 3, Standard: 4 } } }],
      items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } },
      groups: [{ tab: 'Functional', topic: 'Requirements', items: [
        item({ id: 'GEN-01', requirement: 'Customers can create an account.', coverage: 'Custom', clientResponse: 'A dedicated development covers this.' }),
      ] }],
    });

    const result = exportWorkbook(doc, {});
    const zip = openZip(fs.readFileSync(result.file));
    const sheetXml = zip.text('xl/worksheets/sheet1.xml');
    const m = /<c r="C2"[^>]*>(.*?)<\/c>/s.exec(sheetXml);
    assert.ok(m, 'no <c> element found for C2');
    assert.ok(!/t="s"/.test(m[0]) && !/t="inlineStr"/.test(m[0]), `C2 must be a numeric cell, got: ${m[0]}`);
    assert.match(m[0], /<v>2<\/v>/, `C2 must hold the legend number 2 for "Customization", got: ${m[0]}`);

    const workbookXml = zip.text('xl/workbook.xml');
    assert.match(workbookXml, /fullCalcOnLoad="1"/);
  } finally { h.cleanup(); }
});
