// lib/diff.mjs: added / removed / changed scope item ids between two item arrays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '../lib/parse.mjs';
import { diff } from '../lib/diff.mjs';
import { HERE } from './helpers.mjs';

const FIX = readFileSync(path.join(HERE, 'fixtures/rfp-0101-xlsx-ids-analysis.md'), 'utf8');

test('diff reports no changes for an unmodified document', () => {
  const items = parse(FIX).items;
  assert.deepEqual(diff(items, items), { added: [], removed: [], changed: [] });
});

test('diff reports the changed field(s) on an edited item and nothing else', () => {
  const before = parse(FIX).items;
  const edited = FIX.replace('medium | M (4 PD)', 'high | M (4 PD)');
  assert.notEqual(edited, FIX);
  const after = parse(edited).items;
  const d = diff(before, after);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].id, 'HIB-02');
  assert.deepEqual(d.changed[0].fields, ['confidence']);
});

test('diff reports several changed fields on the same item', () => {
  const before = parse(FIX).items;
  const edited = FIX
    .replace('medium | M (4 PD)', 'high | L (10 PD)')
    .replace('estimated |', 'confirmed 2026-09-23 |');
  const after = parse(edited).items;
  const d = diff(before, after);
  const row = d.changed.find(c => c.id === 'HIB-02');
  assert.ok(row);
  assert.deepEqual(row.fields.sort(), ['confidence', 'effort', 'status']);
});

test('diff reports removed and added ids', () => {
  const before = parse(FIX).items;
  const removedAway = diff(before, before.filter(it => it.id !== 'CMP-01'));
  assert.deepEqual(removedAway.removed, ['CMP-01']);
  assert.deepEqual(removedAway.added, []);

  const addedBack = diff(before.filter(it => it.id !== 'CMP-01'), before);
  assert.deepEqual(addedBack.added, ['CMP-01']);
  assert.deepEqual(addedBack.removed, []);
});

test('diff treats a missing array as empty, on either side', () => {
  assert.deepEqual(diff(null, null), { added: [], removed: [], changed: [] });
  const items = parse(FIX).items;
  assert.ok(diff(null, items).added.length > 0);
  assert.ok(diff(items, null).removed.length > 0);
});
