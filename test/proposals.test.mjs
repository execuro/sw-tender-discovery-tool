import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as proposals from '../lib/proposals.mjs';

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-proposals-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('add: assigns sequential P-n ids and defaults to waiting', () => {
  const { root, cleanup } = tmpRoot();
  try {
    const p1 = proposals.add(root, 'slug', { item: 'HIB-01', statement: 'Assume X' });
    const p2 = proposals.add(root, 'slug', { item: 'HIB-01', statement: 'Assume Y', pdSaved: 2 });
    assert.equal(p1.id, 'P-1');
    assert.equal(p2.id, 'P-2');
    assert.equal(p1.status, 'waiting');
    assert.deepEqual(proposals.list(root, 'slug').map(p => p.id), ['P-1', 'P-2']);
  } finally { cleanup(); }
});

test('AC-7: a proposal lives under specs/.rfp/<slug>/, never in the working document', () => {
  const { root, cleanup } = tmpRoot();
  try {
    proposals.add(root, 'my-slug', { item: 'X-1', statement: 'stmt', pdSaved: 3 });
    const file = path.join(root, 'specs', '.rfp', 'my-slug', 'proposals.json');
    assert.ok(fs.existsSync(file));
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data[0].pdSaved, 3);
  } finally { cleanup(); }
});

test('AQ-4 / AC-9: a rejected proposal is never proposed again (normalised match)', () => {
  const { root, cleanup } = tmpRoot();
  try {
    const p = proposals.add(root, 'slug', { item: 'HIB-01', statement: 'The client accepts a 30-day SLA.' });
    proposals.reject(root, 'slug', p.id);
    const again = proposals.add(root, 'slug', { item: 'HIB-01', statement: 'the client accepts a 30-day sla' });
    assert.equal(again, null, 'same normalised statement must be dropped');
    const differentItem = proposals.add(root, 'slug', { item: 'HIB-02', statement: 'The client accepts a 30-day SLA.' });
    assert.ok(differentItem, 'a different item is not covered by another item\'s rejection');
  } finally { cleanup(); }
});

test('rejectWaitingFor: only waiting proposals of the given item are rejected', () => {
  const { root, cleanup } = tmpRoot();
  try {
    const p1 = proposals.add(root, 'slug', { item: 'A-1', statement: 's1' });
    proposals.add(root, 'slug', { item: 'A-2', statement: 's2' });
    const p3 = proposals.add(root, 'slug', { item: 'A-1', statement: 's3' });
    proposals.accept(root, 'slug', p3.id);
    const rejected = proposals.rejectWaitingFor(root, 'slug', 'A-1');
    assert.deepEqual(rejected.map(p => p.id), [p1.id]);
    const all = proposals.list(root, 'slug');
    assert.equal(all.find(p => p.id === p1.id).status, 'rejected');
    assert.equal(all.find(p => p.item === 'A-2').status, 'waiting');
    assert.equal(all.find(p => p.id === p3.id).status, 'accepted');
  } finally { cleanup(); }
});

test('reestimate: mark, list, isMarked, clear', () => {
  const { root, cleanup } = tmpRoot();
  try {
    proposals.markReestimate(root, 'slug', 'HIB-01', 'cause 1');
    proposals.markReestimate(root, 'slug', '*', 'profile changed');
    assert.equal(proposals.isMarked(root, 'slug', 'HIB-01'), true);
    assert.equal(proposals.isMarked(root, 'slug', 'ANY-ID'), true, '"*" marks every item');
    proposals.clearReestimate(root, 'slug', ['HIB-01']);
    const remaining = proposals.reestimateList(root, 'slug');
    assert.ok(remaining.some(r => r.item === '*'), 'the "*" (global) entry is never cleared by item id');
    assert.ok(!remaining.some(r => r.item === 'HIB-01'));
  } finally { cleanup(); }
});

test('N-6: the "*" mark clears once TWO applies, each re-estimating a different half of the items, together cover all of them', () => {
  const { root, cleanup } = tmpRoot();
  try {
    proposals.markReestimate(root, 'slug', '*', 'profile changed');
    // First apply only re-estimates HIB-01 — "*" must survive.
    proposals.clearReestimate(root, 'slug', ['HIB-01'], ['HIB-01', 'HIB-02']);
    assert.ok(proposals.reestimateList(root, 'slug').some(r => r.item === '*'), 'still open after the first apply');
    // Second apply re-estimates only the other half (HIB-02) — together the two applies cover
    // every item the "*" mark was set for, so it must clear now, on this call alone.
    proposals.clearReestimate(root, 'slug', ['HIB-02'], ['HIB-01', 'HIB-02']);
    assert.ok(!proposals.reestimateList(root, 'slug').some(r => r.item === '*'), '"*" cleared once both halves are covered, across the two applies');
  } finally { cleanup(); }
});

test('clearReestimate: the "*" mark clears once a single apply has re-estimated every item it covers', () => {
  const { root, cleanup } = tmpRoot();
  try {
    proposals.markReestimate(root, 'slug', '*', 'profile changed');
    // A partial apply (not every item written yet) leaves "*" in place.
    proposals.clearReestimate(root, 'slug', ['HIB-01'], ['HIB-01', 'HIB-02']);
    assert.ok(proposals.reestimateList(root, 'slug').some(r => r.item === '*'), 'still open: HIB-02 not yet re-estimated');
    // The next apply covers every remaining item -> "*" clears.
    proposals.clearReestimate(root, 'slug', ['HIB-01', 'HIB-02'], ['HIB-01', 'HIB-02']);
    assert.ok(!proposals.reestimateList(root, 'slug').some(r => r.item === '*'));
  } finally { cleanup(); }
});
