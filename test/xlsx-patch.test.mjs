// Write-back tests. The load-bearing assertion is byte identity: every zip entry we did not
// mean to touch must come out of the patcher with the same compressed bytes it went in with.
// That is what keeps the client's styles, themes and dropdowns exactly as they were, and it is
// the only thing standing between us and Excel's "we found a problem with some content" prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { readWorkbook, sheetToGrid, openZip } from '../lib/xlsx.mjs';
import { patchWorkbook, applyCellEdits, pruneCalcChain, rebuildZip, withFullCalcOnLoad } from '../lib/xlsx-patch.mjs';
import { proposeMap } from '../lib/import-map.mjs';
import { buildWorkbook, buildZip } from './helpers/mkxlsx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
import { sampleTenderWorkbook } from './fixtures/sample-tender.mjs';

const SAMPLE = sampleTenderWorkbook();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const PART = 'xl/worksheets/sheet1.xml';

const REQ_HEADER = ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)', 'Vendor: One-off cost (EUR)'];
const sample = (rows = 2) => buildWorkbook([{
  name: 'Requirements',
  rows: [REQ_HEADER, ...Array.from({ length: rows }, (_, i) => [`GEN-0${i + 1}`, 'Shop', `Requirement ${i + 1}`, 'Must', '', '', '', ''])],
  validations: [{ sqref: `E2:E${rows + 1}`, values: ['Stock', 'Config', 'Custom'] }],
  styleRow: 1,
}]);

/** Entry-by-entry comparison of two containers. */
function entryDiff(a, b) {
  const za = openZip(a);
  const zb = openZip(b);
  const changed = [];
  for (const name of za.names()) {
    const ra = za.raw(name);
    const rb = zb.raw(name);
    if (!rb) { changed.push(`${name} (dropped)`); continue; }
    if (!ra.equals(rb)) changed.push(name);
  }
  for (const name of zb.names()) if (!za.has(name)) changed.push(`${name} (added)`);
  return changed;
}

// ---------------------------------------------------------------- zip rebuild

test('rebuildZip without replacements keeps every entry byte-identical', () => {
  const src = sample();
  const out = rebuildZip(src, {});
  assert.deepEqual(entryDiff(src, out), []);
  assert.deepEqual(openZip(out).names(), openZip(src).names());   // order preserved too
});

test('rebuildZip replaces one part and drops another, leaving the rest untouched', () => {
  const src = buildZip([
    { name: 'a.xml', content: '<a/>' },
    { name: 'b.xml', content: '<b/>' },
    { name: 'c.xml', content: '<c/>' },
  ]);
  const out = rebuildZip(src, { 'b.xml': '<b>changed</b>', 'c.xml': null });
  const zip = openZip(out);
  assert.deepEqual(zip.names(), ['a.xml', 'b.xml']);
  assert.equal(zip.text('b.xml'), '<b>changed</b>');
  assert.ok(openZip(src).raw('a.xml').equals(zip.raw('a.xml')));
});

// ---------------------------------------------------------------- cell surgery

test('replaces an existing cell, keeping its style', () => {
  const xml = '<worksheet><sheetData><row r="2"><c r="A2" t="inlineStr" s="7"><is><t>GEN-01</t></is></c><c r="E2" s="9"/></row></sheetData></worksheet>';
  const { xml: out } = applyCellEdits(xml, [{ ref: 'E2', value: 'Config' }]);
  assert.match(out, /<c r="E2" s="9" t="inlineStr"><is><t xml:space="preserve">Config<\/t><\/is><\/c>/);
  assert.match(out, /<c r="A2" t="inlineStr" s="7">/);     // untouched
});

test('inserts a missing cell in column order and a missing row in row order', () => {
  const xml = '<worksheet><sheetData><row r="1"><c r="A1"/><c r="C1"/></row><row r="3"/></sheetData></worksheet>';
  const { xml: out } = applyCellEdits(xml, [{ ref: 'B1', value: 'mid' }, { ref: 'A2', value: 'new row' }]);
  const order = [...out.matchAll(/<c r="([A-Z]+\d+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['A1', 'B1', 'C1', 'A2']);
  const rows = [...out.matchAll(/<row r="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(rows, [1, 2, 3]);
});

test('writes numbers as numbers and clears a cell without losing its style', () => {
  const xml = '<worksheet><sheetData><row r="2"><c r="G2" s="4"><v>1</v></c><c r="F2" s="5" t="inlineStr"><is><t>old</t></is></c></row></sheetData></worksheet>';
  const { xml: out } = applyCellEdits(xml, [{ ref: 'G2', value: 3.5 }, { ref: 'F2', value: '' }]);
  assert.match(out, /<c r="G2" s="4"><v>3\.5<\/v><\/c>/);
  assert.match(out, /<c r="F2" s="5"\/>/);
});

test('escapes XML metacharacters in a written comment', () => {
  const xml = '<worksheet><sheetData><row r="2"><c r="F2"/></row></sheetData></worksheet>';
  const { xml: out } = applyCellEdits(xml, [{ ref: 'F2', value: 'A & B <tag> "quoted"' }]);
  assert.ok(out.includes('A &amp; B &lt;tag&gt; &quot;quoted&quot;'));
  assert.ok(!out.includes('<tag>'));
});

test('keeps the sheet\'s namespace prefix when it has one', () => {
  const xml = '<x:worksheet xmlns:x="ns"><x:sheetData><x:row r="2"><x:c r="F2" s="3"/></x:row></x:sheetData></x:worksheet>';
  const { xml: out } = applyCellEdits(xml, [{ ref: 'F2', value: 'yes' }, { ref: 'G2', value: 1 }]);
  assert.match(out, /<x:c r="F2" s="3" t="inlineStr"><x:is><x:t xml:space="preserve">yes<\/x:t><\/x:is><\/x:c>/);
  assert.match(out, /<x:c r="G2"><x:v>1<\/x:v><\/x:c>/);
});

test('an overwritten formula cell loses its formula and is reported for calcChain', () => {
  const xml = '<worksheet><sheetData><row r="2"><c r="F2" s="1"><f>SUM(A1:A2)</f><v>3</v></c></row></sheetData></worksheet>';
  const { xml: out, droppedFormulas } = applyCellEdits(xml, [{ ref: 'F2', value: 9 }]);
  assert.ok(!out.includes('<f>'));
  assert.deepEqual(droppedFormulas, ['F2']);
});

test('pruneCalcChain removes the dropped refs and reports an emptied chain', () => {
  const chain = '<calcChain><c r="F2" i="1"/><c r="G2" i="1"/></calcChain>';
  assert.match(pruneCalcChain(chain, ['F2']), /<c r="G2"/);
  assert.ok(!pruneCalcChain(chain, ['F2']).includes('r="F2"'));
  assert.equal(pruneCalcChain(chain, ['F2', 'G2']), null);
});

// ---------------------------------------------------------------- whole workbook

test('patchWorkbook writes the values and leaves every other entry byte-identical', () => {
  const src = sample();
  const out = patchWorkbook(src, [
    { part: PART, ref: 'E2', value: 'Config' },
    { part: PART, ref: 'F2', value: 'Configuration only.' },
    { part: PART, ref: 'G2', value: 2.5 },
  ]);

  assert.deepEqual(entryDiff(src, out), [PART]);          // only the sheet changed

  const wb = readWorkbook(out);
  const grid = sheetToGrid(wb.sheets[0]);
  assert.deepEqual(grid.rows[1].slice(4, 7), ['Config', 'Configuration only.', '2.5']);
  // The dropdown the client defined is still there, verbatim.
  assert.deepEqual(wb.sheets[0].validations[0].values, ['Stock', 'Config', 'Custom']);
});

test('patching never touches the source buffer', () => {
  const src = sample();
  const before = sha(src);
  patchWorkbook(src, [{ part: PART, ref: 'E2', value: 'Custom' }]);
  assert.equal(sha(src), before);
});

test('a dropped formula deregisters calcChain from the package', () => {
  const src = buildZip([
    { name: '[Content_Types].xml', content: '<Types><Override PartName="/xl/calcChain.xml" ContentType="application/x-calcchain"/></Types>' },
    { name: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="calcChain.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', content: '<worksheet><sheetData><row r="2"><c r="F2"><f>SUM(A1:A2)</f><v>3</v></c></row></sheetData></worksheet>' },
    { name: 'xl/calcChain.xml', content: '<calcChain><c r="F2" i="1"/></calcChain>' },
  ]);
  const out = patchWorkbook(src, [{ part: 'xl/worksheets/sheet1.xml', ref: 'F2', value: 'Custom' }]);
  const zip = openZip(out);
  assert.equal(zip.has('xl/calcChain.xml'), false);
  assert.ok(!zip.text('[Content_Types].xml').includes('calcChain'));
  assert.ok(!zip.text('xl/_rels/workbook.xml.rels').includes('calcChain'));
});

// ---------------------------------------------------------------- answer edits (D-1/R-9: no
// response-CSV path any more — `lib/intake.mjs`/`lib/import-export.mjs` build edits straight
// from the analysis, exercised end to end in test/export.test.mjs)

function mapForSample(buf) {
  const wb = readWorkbook(buf);
  const snap = {
    source: 's', sheets: wb.sheets.map(s => {
      const g = sheetToGrid(s);
      return { index: s.index, name: s.name, state: s.state, part: s.part, rows: g.rows, hiddenRows: g.hiddenRows, hiddenCols: g.hiddenCols, merges: s.merges, dropdowns: s.validations.filter(v => v.values?.length).map(v => ({ sqref: v.sqref, values: v.values })) };
    }),
  };
  return proposeMap(snap).tables[0];
}

test('the mapped answer columns land in the workbook, byte-identical elsewhere', () => {
  const src = sample();
  const table = mapForSample(src);
  const edits = [
    { part: table.part, ref: `${table.columns.compliance}2`, value: 'Config' },
    { part: table.part, ref: `${table.columns.comment}2`, value: 'Configuration only.' },
    { part: table.part, ref: `${table.columns.effort}2`, value: 2.5 },
    { part: table.part, ref: `${table.columns.compliance}3`, value: 'Custom' },
    { part: table.part, ref: `${table.columns.comment}3`, value: 'Custom development, two endpoints.' },
    { part: table.part, ref: `${table.columns.effort}3`, value: 8 },
  ];
  const out = patchWorkbook(src, edits);
  const grid = sheetToGrid(readWorkbook(out).sheets[0]);
  assert.deepEqual(grid.rows[1].slice(4, 8), ['Config', 'Configuration only.', '2.5', '']);
  assert.deepEqual(grid.rows[2].slice(4, 8), ['Custom', 'Custom development, two endpoints.', '8', '']);
  assert.deepEqual(entryDiff(src, out), [PART]);
});

test('withFullCalcOnLoad sets calcPr once, and is a byte-for-byte no-op the second time', () => {
  const src = sample();
  const once = withFullCalcOnLoad(src);
  const zip = openZip(once);
  assert.match(zip.text('xl/workbook.xml'), /<calcPr[^>]*fullCalcOnLoad="1"/);
  const twice = withFullCalcOnLoad(once);
  assert.ok(twice.equals(once));
});

// ------------------------------------------------------------ a whole tender workbook

test('patches a whole tender workbook without disturbing anything else', () => {
    const src = Buffer.from(SAMPLE);
    const before = sha(src);
    const wb = readWorkbook(src);
    const part = wb.sheets[2].part;                       // "2 Requirements"

    const out = patchWorkbook(src, [
      { part, ref: 'J2', value: 'Config' },
      { part, ref: 'K2', value: 'Configuration only; standard Shopware feature.' },
      { part, ref: 'L2', value: 1.5 },
    ]);

    assert.equal(sha(src), before);                       // the client's file is untouched
    assert.deepEqual(entryDiff(src, out), [part]);        // exactly one part differs

    const after = readWorkbook(out);
    const grid = sheetToGrid(after.sheets[2]);
    assert.deepEqual(grid.rows[1].slice(9, 12), ['Config', 'Configuration only; standard Shopware feature.', '1.5']);
    assert.equal(grid.rows[1][0], 'GEN-01');              // the client's own cells are as they were
    assert.equal(grid.rows[0][9], 'Vendor: Compliance');

    // Both dropdowns and the other sheets survive.
    assert.equal(after.sheets[2].validations.length, 2);
    assert.deepEqual(after.sheets[2].validations.map(v => v.sqref).sort(), ['F2:F92', 'J2:J92']);
    assert.equal(after.sheets.length, 9);
    assert.equal(after.sheets[8].state, 'hidden');
    assert.equal(after.sheets[8].merges.length, 5);
  });
