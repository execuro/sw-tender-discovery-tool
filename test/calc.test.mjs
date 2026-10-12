import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../lib/calc.mjs';
import { parse } from '../lib/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(path.join(here, 'fixtures', name), 'utf8');
const modelA = parse(read('rfp-0101-xlsx-ids-analysis.md'));
const modelC = parse(read('rfp-0103-pdf-prose-analysis.md'));

test('SCALE and round025', () => {
  assert.deepEqual(C.SCALE, { '—': 0, XS: 0.5, S: 1.5, M: 4, L: 10, XL: 25, XXL: 50 });
  assert.equal(C.round025(15.375), 15.5);
  assert.equal(C.round025(15.125), 15.25);
  assert.ok(Object.is(C.round025(0), 0));
  assert.ok(Object.is(C.round025(-0.1), 0));
  assert.equal(C.round025(null), null);
});

test('profileFigure: round0.25(pd × (1+overhead/100) × (1+buffer/100 if folded))', () => {
  const folded = { overhead: 10, buffer: { percent: 5, mode: 'folded' } };
  assert.equal(C.profileFigure(10, folded), C.round025(10 * 1.1 * 1.05));
  const separate = { overhead: 10, buffer: { percent: 5, mode: 'separate' } };
  assert.equal(C.profileFigure(10, separate), C.round025(10 * 1.1));
  assert.equal(C.profileFigure(10, null), 10);
  assert.equal(C.profileFigure(null, folded), null);
});

test('isNotDecomposed: XXL, or a profile figure above the big calibration point (E-2)', () => {
  assert.equal(C.isNotDecomposed({ effort: { size: 'XXL', pd: 50, regime: 'T-shirt' } }), true);
  assert.equal(C.isNotDecomposed({ effort: { size: 'L', pd: 10, regime: 'T-shirt' } }), false);
  const profile = { calibration: { small: 2, big: 20 } };
  assert.equal(C.isNotDecomposed({ effort: { size: null, pd: 25, regime: 'profile' } }, profile), true);
  assert.equal(C.isNotDecomposed({ effort: { size: null, pd: 15, regime: 'profile' } }, profile), false);
  assert.equal(C.isNotDecomposed({ effort: null }), false);
});

test('#5/T4: after a regime change, a stale profile figure is judged by the T-shirt XXL ceiling (50 PD), not blanket-flagged — a small stale figure is not "not decomposed"', () => {
  // Regime reverted to T-shirt (no profile) — a `pd: 15` figure that used to be well under the
  // old `calibration.big` cannot be re-checked against it any more; it is NOT flagged just for
  // lacking a live calibration point (that buried every small stale figure under the same flag
  // as huge ones) — only a figure at or above the T-shirt regime's own `XXL` ceiling still is.
  assert.equal(C.isNotDecomposed({ effort: { size: null, pd: 15, regime: 'profile' } }, null), false);
  assert.equal(C.isNotDecomposed({ effort: { size: null, pd: 49.75, regime: 'profile' } }, null), false);
  assert.equal(C.isNotDecomposed({ effort: { size: null, pd: 50, regime: 'profile' } }, null), true);
  assert.equal(C.isNotDecomposed({ effort: { size: null, pd: 120, regime: 'profile' } }, null), true);
});

test('#5: isStale/staleCount — an item whose Effort was produced in a different regime than the one live now', () => {
  const tshirt = { effort: { size: 'L', pd: 10, regime: 'T-shirt' } };
  const profileItem = { effort: { size: null, pd: 15, regime: 'profile' } };
  const notEstimated = { effort: null };
  assert.equal(C.isStale(tshirt, 'T-shirt'), false);
  assert.equal(C.isStale(tshirt, 'profile'), true);
  assert.equal(C.isStale(profileItem, 'profile'), false);
  assert.equal(C.isStale(profileItem, 'T-shirt'), true);
  assert.equal(C.isStale(notEstimated, 'T-shirt'), false);
  assert.equal(C.staleCount([tshirt, profileItem, notEstimated], 'T-shirt'), 1);
  assert.equal(C.staleCount([tshirt, profileItem, notEstimated], 'profile'), 1);
});

test('isEstimated / isBlocked / isNotEstimated', () => {
  const est = { effort: { pd: 4 }, status: { kind: 'estimated' } };
  const blocked = { effort: { pd: 0.5 }, status: { kind: 'blocked' } };
  const queued = { effort: null, status: { kind: 'queued' } };
  assert.equal(C.isEstimated(est), true);
  assert.equal(C.isBlocked(blocked), true);
  assert.equal(C.isNotEstimated(queued), true);
  assert.equal(C.isNotEstimated(est), false);
});

test('totals: by priority and by tab, client priority verbatim, empty bucket named "—" (E-3, E-4)', () => {
  const t = C.totals(modelA.items);
  const prios = Object.fromEntries(t.byPriority.map(r => [r.key, r]));
  assert.deepEqual(Object.keys(prios).sort(), ['Could', 'Must', 'Should']);
  // HIB-01 Must OOTB 0 PD confirmed, CMP-01 Must Custom 25 PD failed(not estimated)
  assert.equal(prios.Must.items, 2);
  assert.equal(prios.Must.estimatedPd, 0);
  assert.equal(prios.Must.notEstimated, 1); // CMP-01 failed
  assert.equal(prios.Should.estimatedPd, 4);
  assert.equal(prios.Could.notEstimated, 1); // HIB-03 blocked with no effort cell at all
  assert.equal(prios.Could.blocked, 0); // no effort recorded yet -> not-estimated, not "blocked at fallback"

  // By tab: TABS order, a tab with 0 items omitted.
  assert.deepEqual(t.byTab.map(r => r.key), ['Functional', 'Non-functional']);
  const tabs = Object.fromEntries(t.byTab.map(r => [r.key, r]));
  assert.equal(tabs.Functional.items, 3);
  assert.equal(tabs['Non-functional'].items, 1);
  assert.equal(t.total.items, 4);
  assert.equal(t.total.estimatedPd, prios.Must.estimatedPd + prios.Should.estimatedPd + prios.Could.estimatedPd);
});

test('totals: byTab keeps TABS order regardless of item order, and never lists a tab with 0 items', () => {
  const items = [
    { prio: 'Must', tab: 'Project & services', effort: null, status: { kind: 'queued' } },
    { prio: 'Must', tab: 'Functional', effort: { pd: 1, regime: 'T-shirt' }, status: { kind: 'estimated' } },
  ];
  const t = C.totals(items);
  assert.deepEqual(t.byTab.map(r => r.key), ['Functional', 'Project & services']);
});

test('totals: a blocked item WITH a fallback effort counts in Estimated PD and is marked Blocked', () => {
  const items = [
    { prio: 'Must', area: 'A', effort: { size: 'S', pd: 1.5, regime: 'T-shirt' }, status: { kind: 'blocked', cq: 'CQ-1' } },
    { prio: 'Must', area: 'A', effort: null, status: { kind: 'queued' } },
    { prio: 'Must', area: 'A', effort: null, status: { kind: 'failed' } },
    { prio: '', area: 'A', effort: { size: 'XS', pd: 0.5, regime: 'T-shirt' }, status: { kind: 'estimated' } },
  ];
  const t = C.totals(items);
  const must = t.byPriority.find(r => r.key === 'Must');
  assert.equal(must.items, 3);
  assert.equal(must.estimatedPd, 1.5);
  assert.equal(must.blocked, 1);
  assert.equal(must.notEstimated, 2);
  const empty = t.byPriority.find(r => r.key === '—');
  assert.equal(empty.items, 1);
  assert.equal(t.total.items, 4);
  assert.equal(t.total.estimatedPd, 2);
});

test('readiness: confirmed, reopened, failed, open CQ, low confidence, waiting proposals', () => {
  const r = C.readiness(modelA.items, { proposals: [{ status: 'waiting' }, { status: 'accepted' }, { status: 'waiting' }], questions: modelA.questions });
  assert.equal(r.total, 4);
  assert.equal(r.confirmed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.openCQ, 1);
  assert.equal(r.waitingProposals, 2);
  const rc = C.readiness(modelC.items);
  assert.equal(rc.reopened, 1);
});

test('openQuestions: a CQ counts as open until it has an Answered line; an answered or operator Q-n never does', () => {
  const questions = [
    { id: 'CQ-1', kind: 'cq', answered: null },
    { id: 'CQ-2', kind: 'cq', answered: { date: '2026-01-01', key: 'A' } },
    { id: 'Q-1', kind: 'q', answered: null },
  ];
  assert.deepEqual(C.openQuestions(questions).map(q => q.id), ['CQ-1']);
  assert.equal(C.readiness([], { questions }).openCQ, 1);
});

test('pageOrder: tabs in TABS order, topics in first-seen order within a tab, items in client order (contract §4/SI-4)', () => {
  const items = [
    { id: 'A1', tab: 'Non-functional', topic: 'Compliance' },
    { id: 'F2', tab: 'Functional', topic: 'Requirements' },
    { id: 'F1', tab: 'Functional', topic: 'Requirements' },
    { id: 'F3', tab: 'Functional', topic: 'Checkout' },
    { id: 'A2', tab: 'Non-functional', topic: 'Compliance' },
  ];
  assert.deepEqual(C.pageOrder(items).map(i => i.id), ['F2', 'F1', 'F3', 'A1', 'A2']);
});

test('pageOrder: a group whose tab is not one of TABS sorts after them, in first-seen order', () => {
  const items = [
    { id: 'X1', area: 'Legacy', tab: null, topic: null },
    { id: 'F1', tab: 'Functional', topic: 'Requirements' },
  ];
  assert.deepEqual(C.pageOrder(items).map(i => i.id), ['F1', 'X1']);
});

test('nextAnalyzeItems: queued/reopened items, in page order, capped at the limit', () => {
  const items = [
    { id: 'F1', tab: 'Functional', topic: 'Requirements', status: { kind: 'confirmed' } },
    { id: 'F2', tab: 'Functional', topic: 'Requirements', status: { kind: 'queued' } },
    { id: 'F3', tab: 'Functional', topic: 'Requirements', status: { kind: 'reopened' } },
    { id: 'A1', tab: 'Non-functional', topic: 'Compliance', status: { kind: 'queued' } },
  ];
  assert.deepEqual(C.nextAnalyzeItems(items), ['F2', 'F3', 'A1']);
  assert.deepEqual(C.nextAnalyzeItems(items, [], 2), ['F2', 'F3'], 'capped at the limit');
});

test('nextAnalyzeItems: a per-item reestimate.json mark includes an otherwise-confirmed item; a "*" mark includes every item', () => {
  const items = [
    { id: 'F1', tab: 'Functional', topic: 'Requirements', status: { kind: 'confirmed' } },
    { id: 'F2', tab: 'Functional', topic: 'Requirements', status: { kind: 'confirmed' } },
  ];
  assert.deepEqual(C.nextAnalyzeItems(items, [{ item: 'F2' }]), ['F2']);
  assert.deepEqual(C.nextAnalyzeItems(items, [{ item: '*' }]), ['F1', 'F2']);
});

test('isReady (L-7): Ready iff every item confirmed', () => {
  assert.equal(C.isReady(modelA.items), false);
  const allConfirmed = [{ status: { kind: 'confirmed' } }, { status: { kind: 'confirmed' } }];
  assert.equal(C.isReady(allConfirmed), true);
  assert.equal(C.isReady([]), false);
});

test('nextAnalyzeItems: the default cap is 45', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `F${i + 1}`, tab: 'Functional', topic: 'R', status: { kind: 'queued' } }));
  assert.equal(C.ANALYZE_CHUNK, 45);
  assert.equal(C.nextAnalyzeItems(items).length, 45);
});

test('nextAnalyzeItems: a "*" mark walks the document in chunks via the star-progress set and ends empty', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `F${i + 1}`, tab: 'Functional', topic: 'R', status: { kind: 'confirmed' } }));
  const star = [{ item: '*' }];
  const first = C.nextAnalyzeItems(items, star, 2, { starProgress: new Set() });
  assert.deepEqual(first, ['F1', 'F2']);
  const second = C.nextAnalyzeItems(items, star, 2, { starProgress: new Set(first) });
  assert.deepEqual(second, ['F3', 'F4']);
  assert.deepEqual(C.nextAnalyzeItems(items, star, 2, { starProgress: new Set(['F1', 'F2', 'F3', 'F4', 'F5']) }), []);
});

test('nextAnalyzeItems: applied-and-unchanged reopened items are skipped unless individually marked', () => {
  const items = [
    { id: 'F1', tab: 'Functional', topic: 'R', status: { kind: 'reopened' } },
    { id: 'F2', tab: 'Functional', topic: 'R', status: { kind: 'reopened' } },
  ];
  const skip = new Set(['F1', 'F2']);
  assert.deepEqual(C.nextAnalyzeItems(items, [], undefined, { skip }), []);
  assert.deepEqual(C.nextAnalyzeItems(items, [{ item: 'F2' }], undefined, { skip }), ['F2']);
});
