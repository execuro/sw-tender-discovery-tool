// Client CSV join for the §4 grid: parses `03-requirements.csv` / `04-non-functional-compliance.csv`
// under `<specsDir>/<slug>/` and joins them by `ID`; absent folder falls back cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCsv, loadRequirementColumns, loadContextTables, CLIENT_COLUMNS } from '../lib/source.mjs';

const HEADER = 'ID,Area,Sub-area,Title,Requirement,Priority,Type,Acceptance criteria / Notes,Reference,Vendor: Compliance,Vendor: Comment,Vendor: Effort (PD),Vendor: One-off cost (EUR),Vendor: Recurring cost / year (EUR)';

test('parseCsv: quoted fields, embedded commas and BOM', () => {
  const rows = parseCsv('﻿ID,Title,Notes\nGEN-01,"Plain",no comma\nGEN-02,"Has, a comma","Has ""quotes"" too"\n');
  assert.deepEqual(rows, [
    { ID: 'GEN-01', Title: 'Plain', Notes: 'no comma' },
    { ID: 'GEN-02', Title: 'Has, a comma', Notes: 'Has "quotes" too' },
  ]);
});

test('parseCsv: empty input yields no rows', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('ID,Title\n'), []);
});

test('loadRequirementColumns: joins all three source tables by id, including an offset header', () => {
  const root = mktmp();
  const dir = path.join(root, 'rfp-0042-acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '03-requirements.csv'), `${HEADER}\nGEN-01,General,Platform,Title one,Requirement text one,Must,Functional,Accept one,Ref one,,,,,`);
  writeFileSync(path.join(dir, '04-non-functional-compliance.csv'), `${HEADER}\nNFR-01,Performance,Web vitals,Title two,Requirement text two,Should,Non-functional,Accept two,,,,,,`);
  // 07-vendor-response-evaluation.csv carries a title + blank + weights row above the real table,
  // same shape as the real Hartmann export (header lands on line 3, not line 1).
  writeFileSync(path.join(dir, '07-vendor-response-evaluation.csv'), `"Vendor response instructions, evaluation and project requirements",,,,,,,,,,,,,\n,,,,,,,,,,,,,\n${HEADER}\nPRJ-01,Project,Method,Project methodology,Requirement text three,Must,Project,,,,,,,`);
  const cols = loadRequirementColumns(root, 'rfp-0042-acme');
  assert.equal(cols.available, true);
  assert.deepEqual(cols.files, ['03-requirements.csv', '04-non-functional-compliance.csv', '07-vendor-response-evaluation.csv']);
  assert.deepEqual(Object.keys(cols.byId).sort(), ['GEN-01', 'NFR-01', 'PRJ-01']);
  assert.deepEqual(Object.keys(cols.byId['GEN-01']), CLIENT_COLUMNS);
  assert.equal(cols.byId['GEN-01'].Area, 'General');
  assert.equal(cols.byId['GEN-01'].Requirement, 'Requirement text one');
  assert.equal(cols.byId['NFR-01'].Priority, 'Should');
  assert.equal(cols.byId['PRJ-01'].Requirement, 'Requirement text three');
  // the two vendor cost columns are never read into the map, even though the source carries them
  assert.equal('Vendor: One-off cost (EUR)' in cols.byId['GEN-01'], false);
  rmSync(root, { recursive: true, force: true });
});

test('parseCsv: header row is found by scanning for the first "ID" cell, not assumed to be line 1', () => {
  const rows = parseCsv('"Title row, with a comma",,\n,,\nID,Title\nPRJ-01,First\nPRJ-02,Second\n');
  assert.deepEqual(rows, [{ ID: 'PRJ-01', Title: 'First' }, { ID: 'PRJ-02', Title: 'Second' }]);
});

test('parseCsv: no "ID" header row anywhere yields no rows, not garbage', () => {
  assert.deepEqual(parseCsv('Notes,Value\nfoo,bar\n'), []);
});

test('loadRequirementColumns: missing export folder falls back to unavailable, not an error', () => {
  const root = mktmp();
  const cols = loadRequirementColumns(root, 'rfp-0042-no-source');
  assert.equal(cols.available, false);
  assert.deepEqual(cols.files, []);
  assert.deepEqual(cols.byId, {});
  rmSync(root, { recursive: true, force: true });
});

test('loadRequirementColumns: one file present, one absent still joins what exists', () => {
  const root = mktmp();
  const dir = path.join(root, 'rfp-0042-partial');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '03-requirements.csv'), `${HEADER}\nGEN-01,General,Platform,T,R,Must,Functional,A,Ref,,,,,`);
  const cols = loadRequirementColumns(root, 'rfp-0042-partial');
  assert.equal(cols.available, true);
  assert.deepEqual(cols.files, ['03-requirements.csv']);
  assert.deepEqual(Object.keys(cols.byId), ['GEN-01']);
  rmSync(root, { recursive: true, force: true });
});

function mktmp() { return mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'tender-tool-source-')); }

// --- the client's non-requirement exports (Integrations / Migration / Glossary tabs) ---------
test('parseCsv: a non-ID key column finds the header row', () => {
  const rows = parseCsv('#,System,Direction\n1,Business Central,ERP -> Shop\n', '#');
  assert.deepEqual(rows, [{ '#': '1', System: 'Business Central', Direction: 'ERP -> Shop' }]);
  assert.deepEqual(parseCsv('Term,Meaning\nSKU,"Stock keeping unit"\n', 'Term'),
    [{ Term: 'SKU', Meaning: 'Stock keeping unit' }]);
  assert.deepEqual(parseCsv('#,System\n1,BC\n'), [], 'the default key is still ID');
});

test('loadContextTables: reads what exists, keeps every client column verbatim', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tender-ctx-'));
  const dir = path.join(root, 'rfp-0098-tabs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '05-integrations.csv'),
    '﻿#,System,Direction,Objects,Notes\n1,Business Central,ERP -> Shop,"Products, prices",Attachment A7\n');
  writeFileSync(path.join(dir, '08-glossary.csv'), '﻿Term,Meaning\nSKU,"Stock keeping unit"\n');
  const t = loadContextTables(root, 'rfp-0098-tabs');
  assert.equal(t.available, true);
  assert.deepEqual(t.integrations.header, ['#', 'System', 'Direction', 'Objects', 'Notes']);
  assert.equal(t.integrations.rows[0].Objects, 'Products, prices');
  assert.equal(t.glossary.rows[0].Term, 'SKU');
  assert.equal(t.migration, null, 'an absent export is null, not an error');
  rmSync(root, { recursive: true, force: true });
});

test('loadContextTables: no export folder at all is unavailable, not a throw', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tender-ctx-'));
  const t = loadContextTables(root, 'nope');
  assert.equal(t.available, false);
  assert.deepEqual([t.integrations, t.migration, t.glossary], [null, null, null]);
  rmSync(root, { recursive: true, force: true });
});
