// `lib/source.mjs` driven by a confirmed import map instead of the hard-coded sample lists.
// The fallback path (no map) is covered by test/source.test.mjs and must keep behaving exactly
// as it did — a tender that arrived as CSV, markdown or PDF has no workbook to map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRequirementColumns, loadContextTables, loadImportMap, CLIENT_COLUMNS, COST_COLUMNS } from '../lib/source.mjs';

/** A temp `<specsDir>/<slug>/` holding the files a confirmed import would have written. */
function fixture(files) {
  const specsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-srcmap-'));
  const slug = 'rfp-0099-mini';
  fs.mkdirSync(path.join(specsDir, slug), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(specsDir, slug, name), content, 'utf8');
  }
  return { specsDir, slug, cleanup: () => fs.rmSync(specsDir, { recursive: true, force: true }) };
}

// A client who names everything differently from the sample: German headers, `Nr.` as the id,
// its requirement sheet called "Leistungen". Nothing here matches the hard-coded constants.
const MAP = {
  source: 'specs/rfp-0099-mini.xlsx',
  sha256: 'a'.repeat(64),
  confirmedAt: '2026-09-15T10:00:00.000Z',
  tables: [
    {
      n: 1, sheet: '1 Leistungen', slug: 'leistungen', index: 1, role: 'requirements',
      part: 'xl/worksheets/sheet1.xml',
      headerRow: 1, firstDataRow: 2, lastDataRow: 3,
      headerText: ['Nr.', 'Bereich', 'Anforderung', 'Priorität', 'Anbieter: Erfüllung', 'Anbieter: Kommentar', 'Anbieter: Aufwand (PT)', 'Anbieter: Kosten (EUR)'],
      columns: { id: 'A', context: ['B'], requirement: 'C', priority: 'D', compliance: 'E', comment: 'F', effort: 'G', cost: ['H'] },
      tokens: { compliance: ['Standard', 'Anpassung'] },
    },
    {
      n: null, sheet: '2 Schnittstellen', slug: 'schnittstellen', index: 2, role: 'context', kind: 'integrations',
      headerRow: 1, firstDataRow: 2, lastDataRow: 2,
      headerText: ['Nr.', 'System', 'Richtung'],
      columns: { id: 'A', context: ['B', 'C'] },
      tokens: {},
    },
  ],
  ignored: [{ sheet: '_intern', why: 'name starts with _' }],
};

const LEISTUNGEN_CSV = `Nr.,Bereich,Anforderung,Priorität,Anbieter: Erfüllung,Anbieter: Kommentar,Anbieter: Aufwand (PT),Anbieter: Kosten (EUR)
REQ-01,Shop,Kundenkonto mit Freigabe,Muss,,,,
REQ-02,Shop,Staffelpreise,Soll,,,,
`;
const SCHNITTSTELLEN_CSV = `Nr.,System,Richtung
1,ERP,eingehend
`;

test('a confirmed map drives the file names, the id column and the client columns', () => {
  const f = fixture({ '01-leistungen.csv': LEISTUNGEN_CSV, '02-schnittstellen.csv': SCHNITTSTELLEN_CSV, 'import-map.json': JSON.stringify(MAP) });
  try {
    const cols = loadRequirementColumns(f.specsDir, f.slug);
    assert.equal(cols.fromMap, true);
    assert.deepEqual(cols.files, ['01-leistungen.csv']);          // the context table is not a requirement file
    assert.deepEqual(Object.keys(cols.byId), ['REQ-01', 'REQ-02']);   // keyed on "Nr.", not "ID"
    assert.deepEqual(cols.columns.map(c => c.key), ['Bereich', 'Anforderung', 'Priorität']);
    assert.equal(cols.columns.find(c => c.key === 'Anforderung').long, true);
    assert.deepEqual(cols.costColumns, ['Anbieter: Kosten (EUR)']);
    assert.equal(cols.byId['REQ-01'].Anforderung, 'Kundenkonto mit Freigabe');
    // The answer columns are ours to write, never shown as the client's own wording.
    assert.ok(!Object.keys(cols.byId['REQ-01']).includes('Anbieter: Erfüllung'));
  } finally { f.cleanup(); }
});

test('context tables are found by their mapped kind, not by a hard-coded file name', () => {
  const f = fixture({ '01-leistungen.csv': LEISTUNGEN_CSV, '02-schnittstellen.csv': SCHNITTSTELLEN_CSV, 'import-map.json': JSON.stringify(MAP) });
  try {
    const ctx = loadContextTables(f.specsDir, f.slug);
    assert.equal(ctx.available, true);
    assert.equal(ctx.integrations.file, '02-schnittstellen.csv');
    assert.deepEqual(ctx.integrations.header, ['Nr.', 'System', 'Richtung']);
    assert.equal(ctx.integrations.rows.length, 1);
    assert.equal(ctx.migration, undefined);            // this client has no migration sheet
  } finally { f.cleanup(); }
});

test('without a map the hard-coded sample lists still apply, unchanged', () => {
  const header = `ID,${CLIENT_COLUMNS.join(',')},Vendor: Compliance,${COST_COLUMNS.join(',')}`;
  const f = fixture({ '03-requirements.csv': `${header}\nGEN-01,Shop,Cart,Title,Requirement text,Must,Functional,Given,§1,,,\n` });
  try {
    const cols = loadRequirementColumns(f.specsDir, f.slug);
    assert.equal(cols.fromMap, false);
    assert.deepEqual(cols.files, ['03-requirements.csv']);
    assert.deepEqual(cols.columns.map(c => c.key), CLIENT_COLUMNS);
    assert.deepEqual(cols.costColumns, COST_COLUMNS);
    assert.equal(cols.byId['GEN-01'].Requirement, 'Requirement text');
  } finally { f.cleanup(); }
});

test('a missing or unreadable map is not an error, it is simply absent', () => {
  const f = fixture({ 'import-map.json': '{ broken json' });
  try {
    assert.equal(loadImportMap(f.specsDir, f.slug), null);
    const cols = loadRequirementColumns(f.specsDir, f.slug);
    assert.equal(cols.available, false);
    assert.equal(cols.fromMap, false);
  } finally { f.cleanup(); }
});
