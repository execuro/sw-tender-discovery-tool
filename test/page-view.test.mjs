// Pure page logic (page/view.mjs), exercised against a real parsed working document so the
// filters and state markers are proven against the 0.2.0 grammar, not a hand-rolled shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../lib/parse.mjs';
import { isNotDecomposed } from '../lib/calc.mjs';
import {
  COVERAGE_VALUES, SIZES, TABS, effortBucket, emptyFilters, matchesFilters, itemMarkers,
  bulkConfirmPlan, waitingProposalIds, tabProposalSummary, openQuestionItemIds, parseRunReport, REPORT_FIELDS,
  emptyProfileForm, profileToForm, formToProfile, splitHeading, topicsOf, groupByTopic,
  parseGlossary, markGlossary, isNegativeToken, changedIdsFromReply, lastRunChangedIds,
  queuedRows, panelState, canSend, toggleDecision, decisionFor, decisionCount, tabDecisionCount,
} from '../page/view.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), 'utf8');
const model = parse(FIXTURE, { path: 'specs/rfp-0101-hartmann-analysis.md' });

test('fixture parses clean and carries the four item statuses this suite needs', () => {
  assert.deepEqual(model.errors, []);
  const kinds = model.items.map(i => i.status.kind).sort();
  assert.deepEqual(kinds, ['blocked', 'confirmed', 'estimated', 'failed']);
});

function byId(id) { return model.items.find(i => i.id === id); }

// ---------------------------------------------------------------- fixed tabs / topics (own-tabs contract §1, §6)

test('TABS is the three fixed §4 tabs, in canonical render order', () => {
  assert.deepEqual(TABS, ['Functional', 'Non-functional', 'Project & services']);
});

test('splitHeading reads "<Tab> · <Topic>", and refuses a heading with no separator', () => {
  assert.deepEqual(splitHeading('Functional · Requirements'), { tab: 'Functional', topic: 'Requirements' });
  assert.deepEqual(splitHeading('Non-functional · Compliance'), { tab: 'Non-functional', topic: 'Compliance' });
  assert.deepEqual(splitHeading('Requirements'), { tab: null, topic: null });
  assert.deepEqual(splitHeading(''), { tab: null, topic: null });
});

test('topicsOf lists a tab\'s topics in client first-seen order, ignoring items on other tabs', () => {
  assert.deepEqual(topicsOf(model.items, 'Functional'), ['Requirements']);
  assert.deepEqual(topicsOf(model.items, 'Non-functional'), ['Compliance']);
  assert.deepEqual(topicsOf(model.items, 'Project & services'), []);
});

test('groupByTopic groups one tab\'s items by topic, in first-seen order; an empty tab yields []', () => {
  const groups = groupByTopic(model.items, 'Functional');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].topic, 'Requirements');
  assert.deepEqual(groups[0].items.map(i => i.id), ['HIB-01', 'HIB-02', 'HIB-03']);
  assert.deepEqual(groupByTopic(model.items, 'Project & services'), []);
});

// ---------------------------------------------------------------- coverage token check (RC-4/T1)

test('isNegativeToken: flags an outright refusal, in English and German — never an n/a-style token, the legitimate "—" answer', () => {
  assert.equal(isNegativeToken('Not Supported'), true);
  assert.equal(isNegativeToken('No'), true);
  assert.equal(isNegativeToken('None'), true);
  assert.equal(isNegativeToken('Nicht erfüllt'), true);
  assert.equal(isNegativeToken('n/a'), false, 'n/a is the legitimate answer for "—", not a refusal');
  assert.equal(isNegativeToken('Not Applicable'), false, 'same — "not applicable" is not "not offered"');
  assert.equal(isNegativeToken('Standard'), false);
  assert.equal(isNegativeToken(''), false);
  assert.equal(isNegativeToken(undefined), false);
});

// ---------------------------------------------------------------- effort buckets

test('effortBucket reads the T-shirt size straight off the item', () => {
  assert.equal(effortBucket(byId('HIB-02')), 'M');
  assert.equal(effortBucket(byId('CMP-01')), 'XL');
  assert.equal(effortBucket(byId('HIB-03')), null, 'not estimated yet');
});

test('effortBucket derives a size band from PD in the profile regime (no size on the item)', () => {
  assert.equal(effortBucket({ effort: { size: null, pd: 3, regime: 'profile' } }), 'M');
  assert.equal(effortBucket({ effort: { size: null, pd: 0, regime: 'profile' } }), '—');
  assert.equal(effortBucket({ effort: { size: null, pd: 40, regime: 'profile' } }), 'XXL');
});

// ---------------------------------------------------------------- filters (P-2, AC-28)

test('matchesFilters: unconfirmed excludes the confirmed item', () => {
  assert.equal(matchesFilters(byId('HIB-01'), { unconfirmed: true }), false);
  assert.equal(matchesFilters(byId('HIB-02'), { unconfirmed: true }), true);
});

test('matchesFilters: Requirement Coverage, including the empty (not assessed) bucket', () => {
  assert.equal(matchesFilters(byId('HIB-02'), { coverage: 'Extension' }), true);
  assert.equal(matchesFilters(byId('HIB-02'), { coverage: 'Custom' }), false);
  assert.equal(matchesFilters(byId('HIB-03'), { coverage: '(empty)' }), true);
  assert.equal(matchesFilters(byId('HIB-01'), { coverage: '(empty)' }), false);
});

test('matchesFilters: effort bucket, open question, failed, waiting proposals, free text', () => {
  assert.equal(matchesFilters(byId('HIB-02'), { effort: 'M' }), true);
  assert.equal(matchesFilters(byId('HIB-02'), { effort: 'XL' }), false);
  assert.equal(matchesFilters(byId('HIB-03'), { openQuestion: true }), true);
  assert.equal(matchesFilters(byId('HIB-01'), { openQuestion: true }), false);
  assert.equal(matchesFilters(byId('CMP-01'), { failed: true }), true);
  const waiting = waitingProposalIds([{ item: 'HIB-02', status: 'waiting' }, { item: 'HIB-01', status: 'accepted' }]);
  assert.equal(matchesFilters(byId('HIB-02'), { waitingProposals: true }, waiting), true);
  assert.equal(matchesFilters(byId('HIB-01'), { waitingProposals: true }, waiting), false);
  assert.equal(matchesFilters(byId('HIB-02'), { q: 'branch-level stock' }), true);
  assert.equal(matchesFilters(byId('HIB-02'), { q: 'nonexistent phrase' }), false);
});

test('matchesFilters: filters combine (AND)', () => {
  assert.equal(matchesFilters(byId('CMP-01'), { failed: true, coverage: 'Custom' }), true);
  assert.equal(matchesFilters(byId('CMP-01'), { failed: true, coverage: 'OOTB' }), false);
});

test('emptyFilters has every P-2 key, all off', () => {
  const f = emptyFilters();
  for (const k of ['unconfirmed', 'coverage', 'effort', 'openQuestion', 'failed', 'waitingProposals', 'q']) assert.ok(k in f);
});

// ---------------------------------------------------------------- state markers (P-7, AC-28)

test('itemMarkers: confirmed', () => {
  const m = itemMarkers(byId('HIB-01'), { isNotDecomposed });
  assert.equal(m.confirmed, true);
  assert.equal(m.confirmedDate, '2026-09-01');
  assert.equal(m.reopened, false);
});

test('itemMarkers: blocked names the CQ', () => {
  const m = itemMarkers(byId('HIB-03'), { isNotDecomposed });
  assert.equal(m.blockedCq, 'CQ-1');
});

test('itemMarkers: failed names the reason from References', () => {
  const m = itemMarkers(byId('CMP-01'), { isNotDecomposed });
  assert.equal(m.failed, true);
  assert.equal(m.failedReason, 'no stock or project feature to extend');
});

test('itemMarkers: not decomposed via calc.isNotDecomposed (XL under an XL cap is not; XXL always is)', () => {
  assert.equal(itemMarkers(byId('CMP-01'), { isNotDecomposed }).notDecomposed, false);
  const xxl = { effort: { size: 'XXL', pd: 50, regime: 'T-shirt' } };
  assert.equal(itemMarkers(xxl, { isNotDecomposed }).notDecomposed, true);
});

test('itemMarkers: D-33 cost line, shown as a badge with the line as its title', () => {
  const noCost = itemMarkers(byId('HIB-02'), { isNotDecomposed });
  assert.equal(noCost.cost, false);
  assert.equal(noCost.costLine, null);

  const withCost = { references: ['kb: Stock display · Storefront', 'cost: recurring subscription fee for the connector licence'] };
  const m = itemMarkers(withCost, { isNotDecomposed });
  assert.equal(m.cost, true);
  assert.equal(m.costLine, 'cost: recurring subscription fee for the connector licence');
});

test('itemMarkers: reopened names its cause', () => {
  const it = { status: { kind: 'reopened' }, references: ['kb: Stock display', 'reopened 2026-09-10: requirement text changed in rfp-0101-hartmann.xlsx'] };
  assert.equal(itemMarkers(it, { isNotDecomposed }).reopenedCause, 'requirement text changed in rfp-0101-hartmann.xlsx');
});

// ---------------------------------------------------------------- bulk confirm (P-3, L-2, AC-17)

test('bulkConfirmPlan counts the unconfirmed items and their waiting proposals', () => {
  const items = model.items.filter(i => i.status.kind !== 'confirmed');
  const proposals = [{ item: 'HIB-02', status: 'waiting' }, { item: 'HIB-02', status: 'accepted' }, { item: 'CMP-01', status: 'waiting' }, { item: null, status: 'waiting' }];
  const plan = bulkConfirmPlan(items, proposals);
  assert.equal(plan.count, 3); // HIB-02, HIB-03, CMP-01
  assert.equal(plan.waitingCount, 2); // HIB-02 + CMP-01; global proposal (item: null) never counted
  assert.ok(plan.ids.includes('HIB-02') && !plan.ids.includes('HIB-01'));
});

test('tabProposalSummary: counts only waiting proposals on the given items, and sums their pdSaved', () => {
  const items = model.items.filter(i => ['HIB-02', 'CMP-01'].includes(i.id));
  const proposals = [
    { item: 'HIB-02', status: 'waiting', pdSaved: 1.5 },
    { item: 'CMP-01', status: 'waiting', pdSaved: 2 },
    { item: 'HIB-01', status: 'waiting', pdSaved: 5 }, // not one of `items` — excluded
    { item: 'HIB-02', status: 'accepted', pdSaved: 3 }, // not waiting — excluded
    { item: null, status: 'waiting', pdSaved: 4 }, // global — excluded
  ];
  const s = tabProposalSummary(items, proposals);
  assert.equal(s.count, 2);
  assert.equal(s.pdSaved, 3.5);
  assert.deepEqual(s.proposals.map(p => p.item).sort(), ['CMP-01', 'HIB-02']);
});

test('openQuestionItemIds: items named by an unanswered CQ, not only status:blocked (AC-28)', () => {
  const ids = openQuestionItemIds(model.questions);
  assert.deepEqual([...ids], ['HIB-03']);
  assert.equal(matchesFilters(byId('HIB-03'), { openQuestion: true }, new Set(), ids), true);
  assert.equal(matchesFilters(byId('HIB-01'), { openQuestion: true }, new Set(), ids), false);
});

test('openQuestionItemIds ignores answered CQs and operator (Q) questions', () => {
  const qs = [
    { id: 'CQ-2', kind: 'cq', items: ['X-1'], answered: { date: '2026-09-01', key: 'A' } },
    { id: 'Q-1', kind: 'q', items: ['X-2'], answered: null },
    { id: 'CQ-3', kind: 'cq', items: ['X-3'], answered: null },
  ];
  assert.deepEqual([...openQuestionItemIds(qs)], ['X-3']);
});

// ---------------------------------------------------------------- "changed since last run" (P-0)

test('changedIdsFromReply reads an id array, an older object-of-arrays shape, and nothing when absent', () => {
  assert.deepEqual(changedIdsFromReply({ changed: ['HIB-02', 'HIB-03'] }), ['HIB-02', 'HIB-03']);
  assert.deepEqual(changedIdsFromReply({ changed: { estimated: ['HIB-02'], confirmed: ['HIB-01'] } }).sort(), ['HIB-01', 'HIB-02']);
  assert.deepEqual(changedIdsFromReply({}), []);
  assert.deepEqual(changedIdsFromReply(null), []);
});

test('lastRunChangedIds takes only the most recent reply, not every run ever', () => {
  const chat = [
    { type: 'reply', batch: 'b1', changed: ['HIB-01'] },
    { type: 'progress', text: 'working' },
    { type: 'reply', batch: 'b2', changed: ['HIB-02', 'HIB-03'] },
  ];
  assert.deepEqual([...lastRunChangedIds(chat)].sort(), ['HIB-02', 'HIB-03']);
  assert.deepEqual([...lastRunChangedIds([])], []);
});

test('matchesFilters: changed matches the last run\'s changed ids and a reopened item even without them', () => {
  const changedIds = new Set(['HIB-02']);
  assert.equal(matchesFilters(byId('HIB-02'), { changed: true }, new Set(), null, changedIds), true);
  assert.equal(matchesFilters(byId('HIB-01'), { changed: true }, new Set(), null, changedIds), false);
  assert.equal(matchesFilters({ id: 'X-1', status: { kind: 'reopened' } }, { changed: true }, new Set(), null, new Set()), true);
});

test('matchesFilters: sinceExport matches ids named in the last export\'s changed set, and nothing before the first export (D-34)', () => {
  const sinceExportIds = new Set(['HIB-02']);
  assert.equal(matchesFilters(byId('HIB-02'), { sinceExport: true }, new Set(), null, null, sinceExportIds), true);
  assert.equal(matchesFilters(byId('HIB-01'), { sinceExport: true }, new Set(), null, null, sinceExportIds), false);
  assert.equal(matchesFilters(byId('HIB-02'), { sinceExport: true }, new Set(), null, null, null), false, 'no export yet — nothing matches');
});

test('matchesFilters: prio (restored 0.1.x filter)', () => {
  assert.equal(matchesFilters(byId('HIB-01'), { prio: 'Must' }), true);
  assert.equal(matchesFilters(byId('HIB-02'), { prio: 'Must' }), false);
});

// ---------------------------------------------------------------- glossary tooltips (P-6, §9)

test('parseGlossary reads a markdown table, a bullet list, and folds "A / B" aliases', () => {
  const raw = [
    '| Term | Meaning | Maps to |',
    '| --- | --- | --- |',
    '| PU / Packaging unit | The smallest sellable pack size | Shopware unit price |',
    '- **ERP** — Enterprise resource planning system',
  ].join('\n');
  const g = parseGlossary(raw);
  assert.equal(g['pu'].term, 'PU / Packaging unit');
  assert.equal(g['packaging unit'].meaning, 'The smallest sellable pack size');
  assert.equal(g['packaging unit'].mapsTo, 'Shopware unit price');
  assert.equal(g['erp'].meaning, 'Enterprise resource planning system');
});

test('parseGlossary skips the table separator row and an empty section', () => {
  assert.deepEqual(parseGlossary(''), {});
  assert.deepEqual(parseGlossary('| --- | --- |\n| Term | Meaning |'), {});
});

test('markGlossary wraps a term with its tooltip and leaves tag markup (attributes) untouched', () => {
  const gloss = parseGlossary('- **ERP** — Enterprise resource planning system');
  const html = markGlossary('<a href="#erp-integration" data-goto="erp-integration">See it</a> and the ERP system.', gloss);
  assert.match(html, /href="#erp-integration"/, 'the attribute text is untouched');
  assert.match(html, /<span class="gloss" title="Enterprise resource planning system">ERP<\/span> system/);
});

// ---------------------------------------------------------------- run report (P-9)

test('REPORT_FIELDS has all nine P-9 labels', () => {
  assert.equal(REPORT_FIELDS.length, 9);
});

// `lib/report.mjs`'s actual stdout for this suite's own fixture (rfp-0101), run through
// `check --write` then `report` — the literal snake_case shape the skill posts as the batch
// reply (SKILL.md §6), not a hand-typed rewording of it.
const REAL_REPORT_MD = [
  'state: In progress', 'confirmed: 1 of 4', 'failed: 1', 'open_client_questions: CQ-1',
  'not_decomposed: none', 'low_confidence: 1',
  'estimation_by_priority: Must: 0 PD · Should: 4 PD · Could: 0 PD (T-shirt, default scale, before overhead and buffer)',
  'waiting_proposals: 0', 'changed: added 4 · changed 0 · reopened none',
  'next_step: confirm items under the current filter, or export',
].join('\n');

test('parseRunReport reads the runtime\'s snake_case report into its nine fields', () => {
  const fields = parseRunReport(REAL_REPORT_MD);
  assert.ok(fields);
  assert.equal(fields.length, 9);
  assert.equal(fields.find(f => f.key === 'state').value, 'In progress');
  assert.equal(fields.find(f => f.key === 'confirmed').value, '1 of 4');
  assert.equal(fields.find(f => f.key === 'openCQ').value, 'CQ-1');
  assert.equal(fields.find(f => f.key === 'notDecomposed').value, 'none');
  assert.equal(fields.find(f => f.key === 'lowConfidence').value, '1');
  assert.match(fields.find(f => f.key === 'effort').value, /^Must: 0 PD/);
  assert.equal(fields.find(f => f.key === 'waitingProposals').value, '0');
  assert.equal(fields.find(f => f.key === 'changed').value, 'added 4 · changed 0 · reopened none');
});

test('parseRunReport returns null for ordinary chat prose', () => {
  assert.equal(parseRunReport('Analysed 3 items, all estimated.'), null);
});

// ---------------------------------------------------------------- partner profile wizard (P-8)

test('emptyProfileForm / profileToForm round-trip with no licence field ever produced (R-6)', () => {
  assert.deepEqual(profileToForm(null), emptyProfileForm());
  const profile = { calibration: { small: 1.5, big: 25 }, overhead: 15, buffer: { percent: 10, mode: 'separate' },
    isv: [{ name: 'Foo', vendor: 'Acme', versions: ['6.5', '6.6'] }], assets: [{ name: 'Search module', covers: 'faceted search', pdSaved: 4 }] };
  const form = profileToForm(profile);
  assert.equal(form.bufferMode, 'separate');
  assert.equal(form.isv[0].versions, '6.5, 6.6');
  const back = formToProfile(form);
  assert.deepEqual(back.profile, profile);
  assert.ok(!('licence' in back.profile.isv[0]));
});

test('formToProfile refuses a non-numeric calibration point', () => {
  const form = { ...emptyProfileForm(), calibrationSmall: 'a lot', calibrationBig: '25', overhead: '15', bufferPercent: '10' };
  const r = formToProfile(form);
  assert.ok(r.errors.length);
});

test('formToProfile drops blank ISV/asset rows', () => {
  const form = { ...emptyProfileForm(), calibrationSmall: '1', calibrationBig: '25', overhead: '15', bufferPercent: '10', isv: [{ name: '', vendor: '', versions: '' }] };
  const r = formToProfile(form);
  assert.deepEqual(r.profile.isv, []);
});

// ---------------------------------------------------------------- Queued (n) block (replaces the Notes panel)

test('queuedRows: a block-bound entry against the loaded model is not missing and carries its ref', () => {
  const rows = queuedRows([{ id: 'n1', kind: 'comment', block: 'HIB-01', text: 'check this', quote: 'the requirement text' }], model);
  assert.deepEqual(rows, [{ id: 'n1', missing: false, ref: 'HIB-01', kind: null, text: 'check this', title: '“the requirement text”' }]);
});

test('queuedRows: a block the model no longer carries is missing', () => {
  const rows = queuedRows([{ id: 'n2', kind: 'comment', block: 'GONE-99', text: 'x' }], model);
  assert.equal(rows[0].missing, true);
  assert.equal(rows[0].ref, 'GONE-99');
});

test('queuedRows: no model loaded yet means every block-bound entry is missing', () => {
  const rows = queuedRows([{ id: 'n3', kind: 'comment', block: 'HIB-01', text: 'x' }], null);
  assert.equal(rows[0].missing, true);
});

test('queuedRows: a free (chat-only) entry has no ref, is never missing, and shows its kind as the label', () => {
  const rows = queuedRows([{ id: 'n4', kind: 'free', text: 'general note' }], model);
  assert.deepEqual(rows[0], { id: 'n4', missing: false, ref: null, kind: 'free', text: 'general note', title: '' });
});

test('queuedRows: selection is appended to the tooltip after the quote', () => {
  const rows = queuedRows([{ id: 'n5', kind: 'comment', block: 'HIB-01', text: 'x', quote: 'q', selection: 'sel' }], model);
  assert.equal(rows[0].title, '“q”\nsel');
});

test('queuedRows: a selection promoted to the quote (openNoteEditor) is shown once, not twice', () => {
  const rows = queuedRows([{ id: 'n6', kind: 'comment', block: 'HIB-01', text: 'x', quote: 'same text', selection: 'same text' }], model);
  assert.equal(rows[0].title, '“same text”');
});

test('canSend: queued entries or non-empty chat text enable Send; whitespace-only text does not', () => {
  assert.equal(canSend(0, ''), false);
  assert.equal(canSend(0, '   '), false);
  assert.equal(canSend(0, 'hi'), true);
  assert.equal(canSend(2, ''), true);
  assert.equal(canSend(0, undefined), false);
});

test('panelState defaults open, keeps a persisted "closed", and treats garbage as open', () => {
  assert.equal(panelState(undefined), 'open');
  assert.equal(panelState(null), 'open');
  assert.equal(panelState('closed'), 'closed');
  assert.equal(panelState('open'), 'open');
  assert.equal(panelState('nonsense'), 'open');
});

// ---------------------------------------------------------------- P-2: accept/reject decision queue

test('toggleDecision: queues an accept, changes it to reject in place, then undoes on a repeat click', () => {
  const p = { id: 'P-3', item: 'GEN-04', statement: 'A statement.', pdSaved: 2 };
  let notes = toggleDecision([], p, 'accept');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, 'decision');
  assert.equal(notes[0].proposal, 'P-3');
  assert.equal(notes[0].action, 'accept');
  // Clicking the other action on the same proposal replaces the entry, never adds a second one.
  notes = toggleDecision(notes, p, 'reject');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].action, 'reject');
  // Clicking the same action again undoes it.
  notes = toggleDecision(notes, p, 'reject');
  assert.equal(notes.length, 0);
});

test('toggleDecision: leaves other queued entries (notes, other decisions) untouched', () => {
  const note = { id: 'n1', kind: 'comment', block: 'HIB-01', text: 'x' };
  const other = toggleDecision([note], { id: 'P-1', item: 'HIB-02', statement: 's', pdSaved: 1 }, 'accept');
  assert.equal(other.length, 2);
  assert.equal(other[0], note);
});

test('decisionFor / decisionCount / tabDecisionCount', () => {
  const notes = [
    { id: 'd1', type: 'decision', proposal: 'P-1', item: 'HIB-01', action: 'accept' },
    { id: 'd2', type: 'decision', proposal: 'P-2', item: 'HIB-02', action: 'reject' },
    { id: 'n1', kind: 'comment', block: 'HIB-01', text: 'x' },
  ];
  assert.equal(decisionFor(notes, 'P-1').action, 'accept');
  assert.equal(decisionFor(notes, 'P-9'), null);
  assert.equal(decisionCount(notes), 2);
  assert.equal(tabDecisionCount([{ id: 'HIB-01' }], notes), 1);
  assert.equal(tabDecisionCount([{ id: 'HIB-01' }, { id: 'HIB-02' }], notes), 2);
});

test('queuedRows: a decision entry reads "Accept P-3 · GEN-04 · −2 PD"', () => {
  const rows = queuedRows([{ id: 'd1', type: 'decision', proposal: 'P-3', item: 'HIB-01', action: 'accept', statement: 'x', pdSaved: 2 }], model);
  assert.equal(rows[0].text, 'Accept P-3 · HIB-01 · −2 PD');
  assert.equal(rows[0].ref, 'HIB-01');
  assert.equal(rows[0].missing, false);
});

// ---------------------------------------------------------------- consistency with lib/parse.mjs

test('COVERAGE_VALUES / SIZES match the parser\'s own sets', () => {
  assert.deepEqual(COVERAGE_VALUES, ['OOTB', 'Configuration', 'Extension', 'ISV', 'Custom', '—']);
  assert.deepEqual(SIZES, ['XS', 'S', 'M', 'L', 'XL', 'XXL']);
});
