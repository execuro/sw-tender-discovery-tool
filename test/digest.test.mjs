// The import digest (`lib/digest.mjs`, build contract §5): the one file `sw-tender-editor`'s
// `extract` job reads. Plain markdown, visible sheets only, in workbook order, cells truncated,
// empty cells and entirely-empty rows omitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDigest } from '../lib/digest.mjs';
import { proposeMap } from '../lib/import-map.mjs';

function snapshot(sheets) {
  return { source: 'x.xlsx', sha256: 'x', sheets };
}

function sheet({ index, name, state = 'visible', rows }) {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return { index, name, state, part: `xl/worksheets/sheet${index}.xml`, width, height: rows.length, rows, hiddenRows: [], hiddenCols: [], merges: [], dropdowns: [] };
}

test('a hidden sheet and a `_`-prefixed sheet are never mentioned', () => {
  const snap = snapshot([
    sheet({ index: 1, name: 'Hidden', state: 'hidden', rows: [['secret']] }),
    sheet({ index: 2, name: '_internal', rows: [['secret2']] }),
    sheet({ index: 3, name: 'Cover', rows: [['Welcome']] }),
  ]);
  const digest = renderDigest(snap, proposeMap(snap));
  assert.doesNotMatch(digest, /Hidden/);
  assert.doesNotMatch(digest, /secret/);
  assert.doesNotMatch(digest, /_internal/);
  assert.match(digest, /## Sheet 3: Cover/);
});

test('empty cells are omitted, entirely-empty rows are omitted, every non-empty row is listed', () => {
  const snap = snapshot([
    sheet({ index: 1, name: 'Requirements', rows: [
      ['ID', 'Area', 'Requirement'],
      ['', '', ''],
      ['GEN-01', '', 'Customers can create an account.'],
    ] }),
  ]);
  const digest = renderDigest(snap, proposeMap(snap));
  assert.match(digest, /r1: A=ID \| B=Area \| C=Requirement/);
  assert.doesNotMatch(digest, /r2:/, 'an entirely-empty row is omitted');
  assert.match(digest, /r3: A=GEN-01 \| C=Customers can create an account\./, 'the empty Area cell (B) is omitted');
});

test('a cell over 160 chars is truncated with a trailing "…"', () => {
  const long = 'x'.repeat(200);
  const snap = snapshot([sheet({ index: 1, name: 'Requirements', rows: [['ID', 'Requirement'], ['GEN-01', long]] })]);
  const digest = renderDigest(snap, proposeMap(snap));
  const line = digest.split('\n').find(l => l.startsWith('r2:'));
  assert.ok(line, 'no r2 line');
  assert.ok(line.includes('…'));
  assert.ok(!line.includes(long), 'the untruncated 200-char cell must not appear');
  const cell = /B=(x+…)/.exec(line)[1];
  assert.equal(cell.length, 161);   // 160 chars + the ellipsis marker
});

test('a requirements table\'s Proposed line names its columns and compliance tokens', () => {
  const snap = snapshot([
    sheet({ index: 1, name: 'Requirements', rows: [
      ['ID', 'Requirement', 'Vendor: Compliance'],
      ['GEN-01', 'Customers can create an account.', 'Stock'],
      ['GEN-02', 'Customers can request a quote.', 'Custom'],
    ] }),
  ]);
  const digest = renderDigest(snap, proposeMap(snap));
  assert.match(digest, /Proposed: requirements table, header r1, data r2-r3; id A, requirement B, compliance C/);
  assert.match(digest, /tokens compliance \[Stock, Custom\]/);
});

test('a context sheet with no table detected still gets its own heading and a Proposed line', () => {
  const snap = snapshot([sheet({ index: 1, name: 'Glossary', rows: [['Term', 'Meaning'], ['SKU', 'Stock keeping unit']] })]);
  const digest = renderDigest(snap, proposeMap(snap));
  assert.match(digest, /## Sheet 1: Glossary/);
  assert.match(digest, /Proposed: context sheet, no table detected/);
});

test('a multi-block sheet lists every block\'s own Proposed line under one sheet heading', () => {
  const rows = [];
  rows[1] = ['', 'IT & HOSTING', 'RATING', 'RESPONSE'];
  rows[2] = ['', 'Describe hosting.', '', ''];
  rows[3] = ['', 'Total', '0', ''];
  rows[5] = ['', 'SECURITY', 'RATING', 'RESPONSE'];
  rows[6] = ['', 'PCI compliant?', '', ''];
  rows[7] = ['', 'Total', '0', ''];
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  const snap = snapshot([sheet({ index: 1, name: '3.2 - Technical', rows })]);
  const digest = renderDigest(snap, proposeMap(snap));
  assert.match(digest, /IT & HOSTING/);
  assert.match(digest, /SECURITY/);
});

test('the rows section lists every non-empty row, no cap below 5000', () => {
  const rows = [['ID', 'Requirement']];
  for (let i = 1; i <= 500; i++) rows.push([`GEN-${i}`, `Requirement number ${i}`]);
  const snap = snapshot([sheet({ index: 1, name: 'Requirements', rows })]);
  const digest = renderDigest(snap, proposeMap(snap));
  assert.match(digest, /r501: A=GEN-500/);
});
