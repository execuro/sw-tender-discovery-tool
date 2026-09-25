// `diffSheetCells` self-test: a self-closing `<c .../>` must never be read as running to the
// next `</c>` in the document — that would fold an unrelated later cell's content into this
// cell's "text" and hide a real difference (or invent one) in AC-22's surgical-export diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSheetCells } from './helpers/xlsx-diff.mjs';

const row = (cells) => `<row r="1">${cells}</row>`;

test('diffSheetCells: a self-closing cell does not swallow a later cell into its match', () => {
  // A1 is self-closing (empty/blank cell, as openpyxl and Excel both write), B1 has a value.
  const xml = `<worksheet><sheetData>${row('<c r="A1" s="3"/><c r="B1"><v>42</v></c>')}</sheetData></worksheet>`;
  const changed = diffSheetCells(xml, xml.replace('s="3"', 's="9"'));
  assert.deepEqual(changed, ['A1'], 'only A1 (the style attribute) changed — B1 must not appear');
});

test('diffSheetCells: a self-closing cell followed by an unrelated later change is not falsely reported for both', () => {
  const before = `<worksheet><sheetData>${row('<c r="A1" s="3"/><c r="B1"><v>1</v></c>')}</sheetData></worksheet>`;
  const after = `<worksheet><sheetData>${row('<c r="A1" s="3"/><c r="B1"><v>2</v></c>')}</sheetData></worksheet>`;
  const changed = diffSheetCells(before, after);
  assert.deepEqual(changed, ['B1'], 'A1 (self-closing, unchanged) must not be reported as changed');
});

test('diffSheetCells: an ordinary open/close cell still diffs correctly (no regression)', () => {
  const before = `<worksheet><sheetData>${row('<c r="A1"><v>1</v></c>')}</sheetData></worksheet>`;
  const after = `<worksheet><sheetData>${row('<c r="A1"><v>2</v></c>')}</sheetData></worksheet>`;
  assert.deepEqual(diffSheetCells(before, after), ['A1']);
});
