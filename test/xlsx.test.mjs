// Reader tests. Two kinds of input:
//   * the real Excel-saved workbook in specs/ (inline strings, hidden sheet, dropdowns,
//     a table that starts at row 20) — the only genuine third-party file we have;
//   * synthetic workbooks from test/helpers/mkxlsx.mjs for the shapes other generators
//     produce, which we cannot save here (see the honesty note in that helper).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readWorkbook, sheetToGrid, XlsxError,
  colToNumber, numberToCol, parseRef, parseRange, serialToIso, isDateFormatCode, scanXml, decodeXml,
} from '../lib/xlsx.mjs';
import { buildWorkbook, buildZip, buildOleStub, buildEncryptedStub } from './helpers/mkxlsx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
import { sampleTenderWorkbook } from './fixtures/sample-tender.mjs';

const SAMPLE = sampleTenderWorkbook();

// ---------------------------------------------------------------- units

test('colToNumber / numberToCol round-trip', () => {
  assert.equal(colToNumber('A'), 1);
  assert.equal(colToNumber('Z'), 26);
  assert.equal(colToNumber('AA'), 27);
  assert.equal(colToNumber('XFD'), 16384);
  for (const n of [1, 26, 27, 52, 53, 702, 703, 16384]) assert.equal(colToNumber(numberToCol(n)), n);
});

test('parseRef and parseRange', () => {
  assert.deepEqual(parseRef('C12'), { col: 3, row: 12 });
  assert.deepEqual(parseRef('aa2'), { col: 27, row: 2 });
  assert.equal(parseRef('nonsense'), null);
  assert.deepEqual(parseRange('B2:C3'), [{ c1: 2, c2: 3, r1: 2, r2: 3 }]);
  assert.deepEqual(parseRange('A1'), [{ c1: 1, c2: 1, r1: 1, r2: 1 }]);
  // reversed corners are normalised, and a multi-part sqref yields one rect per part
  assert.deepEqual(parseRange('C3:A1'), [{ c1: 1, c2: 3, r1: 1, r2: 3 }]);
  assert.equal(parseRange('A1:A9 C1:C9').length, 2);
});

test('serialToIso covers the 1900 leap bug and the 1904 epoch', () => {
  assert.equal(serialToIso(1), '1900-01-01');
  assert.equal(serialToIso(59), '1900-02-28');
  assert.equal(serialToIso(61), '1900-03-01');      // 60 is the phantom 1900-02-29
  assert.equal(serialToIso(45000), '2023-03-15');
  assert.equal(serialToIso(0, { epoch1904: true }), '1904-01-01');
  assert.equal(serialToIso(45000 - 1462, { epoch1904: true }), '2023-03-15');   // the two systems differ by 1462 days
  assert.equal(serialToIso(45000.5).startsWith('2023-03-15 12:00'), true);
});

test('isDateFormatCode ignores literals and colour codes', () => {
  assert.equal(isDateFormatCode('yyyy-mm-dd'), true);
  assert.equal(isDateFormatCode('[$-409]d/m/yy'), true);
  assert.equal(isDateFormatCode('0.00'), false);
  assert.equal(isDateFormatCode('#,##0'), false);
  assert.equal(isDateFormatCode('"day" 0'), false);   // the d-like letters are quoted away
  assert.equal(isDateFormatCode(''), false);
});

test('scanXml survives namespace prefixes, attribute order, self-closing tags and CDATA', () => {
  const seen = [];
  scanXml('<x:a p="1" q="2"><x:b/><c><![CDATA[raw<>]]>tail</c></x:a>', {
    open: (n, a, self) => seen.push(['open', n, JSON.stringify(a), self]),
    text: t => seen.push(['text', t]),
    close: n => seen.push(['close', n]),
  });
  assert.deepEqual(seen[0], ['open', 'a', '{"p":"1","q":"2"}', false]);
  assert.deepEqual(seen[1], ['open', 'b', '{}', true]);
  assert.deepEqual(seen[2], ['close', 'b']);
  assert.deepEqual(seen[4], ['text', 'raw<>']);
  assert.deepEqual(seen[5], ['text', 'tail']);
});

test('decodeXml handles named and numeric entities', () => {
  assert.equal(decodeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), `a & b <c> "d" 'e'`);
  assert.equal(decodeXml('&#65;&#x42;'), 'AB');
  assert.equal(decodeXml('plain'), 'plain');
});

// ---------------------------------------------------------------- synthetic workbooks

test('reads inline strings, numbers and sheet order', () => {
  const buf = buildWorkbook([{ name: 'One', rows: [['ID', 'Title'], ['GEN-01', 'Login'], ['GEN-02', 42]] }]);
  const wb = readWorkbook(buf);
  assert.equal(wb.sheets.length, 1);
  assert.equal(wb.sheets[0].name, 'One');
  assert.equal(wb.sheets[0].state, 'visible');
  const grid = sheetToGrid(wb.sheets[0]);
  assert.deepEqual(grid.rows, [['ID', 'Title'], ['GEN-01', 'Login'], ['GEN-02', '42']]);
});

test('reads shared strings', () => {
  const buf = buildWorkbook([{ name: 'S', rows: [['Alpha', 'Beta'], ['Alpha', 'Gamma']] }], { shared: true });
  const grid = sheetToGrid(readWorkbook(buf).sheets[0]);
  assert.deepEqual(grid.rows, [['Alpha', 'Beta'], ['Alpha', 'Gamma']]);
});

test('reads a workbook whose every element carries an x: namespace prefix', () => {
  const buf = buildWorkbook([{ name: 'Pre', rows: [['ID', 'Req'], ['A-1', 'text']] }], { prefix: 'x', shared: true });
  const wb = readWorkbook(buf);
  assert.equal(wb.sheets[0].name, 'Pre');
  assert.deepEqual(sheetToGrid(wb.sheets[0]).rows, [['ID', 'Req'], ['A-1', 'text']]);
});

test('keeps hidden sheets, hidden rows and hidden columns', () => {
  const buf = buildWorkbook([
    { name: 'Visible', rows: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']], hiddenRows: [2], hiddenCols: [3] },
    { name: '_answer_key', state: 'hidden', rows: [['secret']] },
  ]);
  const wb = readWorkbook(buf);
  assert.equal(wb.sheets[1].state, 'hidden');
  const grid = sheetToGrid(wb.sheets[0]);
  assert.deepEqual(grid.hiddenRows, [2]);
  assert.deepEqual(grid.hiddenCols, [3]);
});

test('keeps merges and dropdown token lists', () => {
  const buf = buildWorkbook([{
    name: 'M',
    rows: [['Merged header', '', ''], ['ID', 'Priority', 'x'], ['A-1', 'Must', '']],
    merges: ['A1:C1'],
    validations: [{ sqref: 'B3:B99', values: ['Must', 'Should', 'Could'] }],
  }]);
  const sheet = readWorkbook(buf).sheets[0];
  assert.deepEqual(sheet.merges, ['A1:C1']);
  assert.equal(sheet.validations.length, 1);
  assert.deepEqual(sheet.validations[0].values, ['Must', 'Should', 'Could']);
  assert.equal(sheet.validations[0].sqref, 'B3:B99');
});

test('a dropdown backed by a range reference keeps the reference instead of inventing tokens', () => {
  const xml = `<worksheet><sheetData/><dataValidations><dataValidation sqref="F2:F9" type="list"><formula1>$Z$1:$Z$5</formula1></dataValidation></dataValidations></worksheet>`;
  const buf = buildZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="A" sheetId="1" state="visible" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', content: xml },
  ]);
  const dv = readWorkbook(buf).sheets[0].validations[0];
  assert.deepEqual(dv.values, []);
  assert.equal(dv.ref, '$Z$1:$Z$5');
});

test('date cells become ISO strings, in both epochs', () => {
  const b1900 = buildWorkbook([{ name: 'D', rows: [['when'], [45000]], styleRow: 2 }]);
  assert.deepEqual(sheetToGrid(readWorkbook(b1900).sheets[0]).rows, [['when'], ['2023-03-15']]);
  const b1904 = buildWorkbook([{ name: 'D', rows: [['when'], [45000 - 1462]], styleRow: 2 }], { epoch1904: true });
  assert.equal(readWorkbook(b1904).epoch1904, true);
  assert.deepEqual(sheetToGrid(readWorkbook(b1904).sheets[0]).rows, [['when'], ['2023-03-15']]);
});

test('a formula cell yields its cached value and is never evaluated', () => {
  const xml = `<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>12.5</v></c><c r="B1" t="str"><f>CONCAT("a","b")</f><v>ab</v></c></row></sheetData></worksheet>`;
  const buf = buildZip([
    { name: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="F" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', content: xml },
  ]);
  assert.deepEqual(sheetToGrid(readWorkbook(buf).sheets[0]).rows, [['12.5', 'ab']]);
});

test('booleans and error cells keep a readable value', () => {
  const xml = `<worksheet><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="e"><v>#REF!</v></c></row></sheetData></worksheet>`;
  const buf = buildZip([
    { name: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="B" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', content: xml },
  ]);
  assert.deepEqual(sheetToGrid(readWorkbook(buf).sheets[0]).rows, [['TRUE', 'FALSE', '#REF!']]);
});

test('inline rich text runs are concatenated and whitespace is preserved', () => {
  const xml = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>Hello </t></r><r><t xml:space="preserve">world</t></r></is></c></row></sheetData></worksheet>`;
  const buf = buildZip([
    { name: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="R" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', content: xml },
  ]);
  assert.deepEqual(sheetToGrid(readWorkbook(buf).sheets[0]).rows, [['Hello world']]);
});

test('stored (uncompressed) entries and zip64 headers are read', () => {
  const stored = buildWorkbook([{ name: 'S', rows: [['a', 'b']] }], { store: true });
  assert.deepEqual(sheetToGrid(readWorkbook(stored).sheets[0]).rows, [['a', 'b']]);
  const z64 = buildWorkbook([{ name: 'Z', rows: [['x']] }], { zip64: true });
  assert.deepEqual(sheetToGrid(readWorkbook(z64).sheets[0]).rows, [['x']]);
});

test('absolute and relative relationship targets both resolve', () => {
  const abs = buildWorkbook([{ name: 'A', rows: [['one']] }], { absoluteRels: true });
  assert.deepEqual(sheetToGrid(readWorkbook(abs).sheets[0]).rows, [['one']]);
  const rel = buildWorkbook([{ name: 'A', rows: [['one']] }], { absoluteRels: false });
  assert.deepEqual(sheetToGrid(readWorkbook(rel).sheets[0]).rows, [['one']]);
});

// ---------------------------------------------------------------- rejections

test('rejects an OLE/CFB file (.xls or password-protected) with advice', () => {
  assert.throws(() => readWorkbook(buildOleStub(), { label: 'old.xls' }), err => {
    assert.ok(err instanceof XlsxError);
    assert.equal(err.code, 'ole');
    assert.match(err.message, /old\.xls/);
    assert.match(err.message, /re-save as \.xlsx/i);
    return true;
  });
});

test('rejects an encrypted package', () => {
  assert.throws(() => readWorkbook(buildEncryptedStub(), { label: 'secret.xlsx' }), err => {
    assert.equal(err.code, 'encrypted');
    assert.match(err.message, /password-protected/i);
    return true;
  });
});

test('rejects a binary workbook and a non-spreadsheet zip', () => {
  const xlsb = buildZip([{ name: 'xl/workbook.bin', content: 'binary' }]);
  assert.throws(() => readWorkbook(xlsb, { label: 'book.xlsb' }), err => err.code === 'xlsb');
  const zip = buildZip([{ name: 'readme.txt', content: 'hello' }]);
  assert.throws(() => readWorkbook(zip, { label: 'notes.zip' }), err => err.code === 'no-workbook');
});

test('rejects a file that is not a zip at all', () => {
  assert.throws(() => readWorkbook(Buffer.from('plain text file'), { label: 'notes.txt' }), err => err.code === 'not-zip');
});

// ------------------------------------------------------------ a whole tender workbook

test('reads a complete nine-sheet tender workbook', () => {
  const wb = readWorkbook(SAMPLE);
  assert.equal(wb.sheets.length, 9);
  assert.equal(wb.epoch1904, false);

  const names = wb.sheets.map(s => s.name);
  assert.deepEqual(names, [
    '0 Cover', '1 Company & Context', '2 Requirements', '3 Non-functional & Compliance',
    '4 Integrations', '5 Migration Inventory', '6 Vendor Response & Evaluation', '7 Glossary', '_answer_key',
  ]);
  assert.equal(wb.sheets[8].state, 'hidden');
  assert.equal(wb.sheets.filter(s => s.state === 'visible').length, 8);

  // Requirements sheet: header on row 1, 91 data rows, both dropdowns.
  const req = wb.sheets[2];
  const grid = sheetToGrid(req);
  assert.deepEqual(grid.rows[0].slice(0, 9), ['ID', 'Area', 'Sub-area', 'Title', 'Requirement', 'Priority', 'Type', 'Acceptance criteria / Notes', 'Reference']);
  assert.equal(grid.height, 92);
  assert.equal(grid.rows[1][0], 'GEN-01');
  const tokens = req.validations.map(v => v.values.join(','));
  assert.deepEqual(tokens.sort(), ['Must,Should,Could', 'Stock,Config,Plugin,Custom,Not offered'].sort());

  // The mid-sheet table a per-sheet CSV export cannot express: header at row 20, data from 21.
  const vendor = wb.sheets[6];
  const vg = sheetToGrid(vendor);
  assert.equal(vg.rows[19][0], 'ID');
  assert.equal(vg.rows[20][0], 'PRJ-01');
  assert.equal(vendor.validations[0].sqref, 'J21:J30');

  // Merged cells live on the hidden answer key; the reader keeps them rather than dropping them.
  assert.equal(wb.sheets[8].merges.length, 5);
});
