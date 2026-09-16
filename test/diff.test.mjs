// lib/diff.mjs: old vs new document model -> changed/added/removed block ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '../lib/parse.mjs';
import { diff } from '../lib/diff.mjs';
import { HERE } from './helpers.mjs';

const FIX = readFileSync(path.join(HERE, 'fixtures/rfp-0099-mini-analysis.md'), 'utf8');

test('diff reports no changes for an unmodified document', () => {
  const before = parse(FIX);
  const after = parse(FIX);
  assert.deepEqual(diff(before, after), { changed: [], added: [], removed: [] });
});

// A tick alone does not change a block's hash (the hash covers content, not tick state - the
// page diffs status separately); editing the assumption's own statement text does.
test('diff reports an edited statement as changed and nothing else', () => {
  const before = parse(FIX);
  const editedText = FIX.replace(
    'Availability is display-only from the async sync, no live ERP call',
    'Availability is display-only from the async sync, no live ERP call, confirmed with the client',
  );
  assert.notEqual(editedText, FIX, 'the fixture text must contain the statement being edited');
  const after = parse(editedText);
  const d = diff(before, after);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, ['STF-01.a1'], `only the edited row's block id should change (saw ${d.changed})`);
});

test('diff reports a removed id against an empty document, and vice versa for added', () => {
  const before = parse(FIX);
  const empty = parse('');
  const removedAway = diff(before, empty);
  assert.ok(removedAway.removed.includes('STF-01.a1'));
  assert.deepEqual(removedAway.changed, []);
  assert.deepEqual(removedAway.added, []);

  const addedBack = diff(empty, before);
  assert.ok(addedBack.added.includes('STF-01.a1'));
  assert.deepEqual(addedBack.changed, []);
  assert.deepEqual(addedBack.removed, []);
});

test('diff treats a missing model as an empty one, on either side', () => {
  const before = parse(FIX);
  assert.deepEqual(diff(null, null), { changed: [], added: [], removed: [] });
  assert.ok(diff(null, before).added.length > 0);
  assert.ok(diff(before, null).removed.length > 0);
});
