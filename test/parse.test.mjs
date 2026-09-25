import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseYaml } from '../lib/yaml.mjs';
import {
  parse, collect, findBlock, splitRow, splitBullets, slugFromPath, analysisPathFor,
  parseEffort, formatEffort, parseStatus, formatStatus, validReference,
  sheetPrefix, stripChapterNumber, generateIds, ITEM_HEADER_LINE, TABS, PROJECT_INFO, splitHeading,
  renderProjectInfo, renderNotTaken,
} from '../lib/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(path.join(here, 'fixtures', name), 'utf8');

const XLSX_IDS = read('rfp-0101-xlsx-ids-analysis.md');
const NOIDS = read('rfp-0102-xlsx-noids-analysis.md');
const PDF = read('rfp-0103-pdf-prose-analysis.md');

const modelA = parse(XLSX_IDS, { path: 'specs/rfp-0101-xlsx-ids-analysis.md' });
const modelB = parse(NOIDS, { path: 'specs/rfp-0102-xlsx-noids-analysis.md' });
const modelC = parse(PDF, { path: 'specs/rfp-0103-pdf-prose-analysis.md' });

test('yaml: scalars, nested maps, inline maps and lists (unchanged)', () => {
  const d = parseYaml('a: 1\nb: text # comment\nm:\n  k: 2\n');
  assert.deepEqual(d, { a: 1, b: 'text', m: { k: 2 } });
});

test('frontmatter and slug', () => {
  assert.equal(modelA.frontmatter.data.state, 'In progress');
  assert.equal(modelA.frontmatter.data.regime, 'T-shirt');
  assert.equal(modelA.frontmatter.data.slug, 'rfp-0101-hartmann');
  assert.equal(modelA.frontmatter.data['source-sha256']['rfp-0101-hartmann.xlsx'].length, 64);
  assert.equal(modelA.slug, 'rfp-0101-xlsx-ids');
  assert.equal(modelA.title, 'RFP-0101 — Hartmann Industriebedarf');
  assert.equal(modelA.errors.length, 0, modelA.errors.join('; '));
});

test('eight sections, fixed order and titles', () => {
  assert.deepEqual(modelA.blocks.map(b => b.id), ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
  assert.deepEqual(modelA.blocks.map(b => b.title), [
    'Context', 'Totals', 'Global assumptions and exclusions', 'Scope items', 'Questions',
    'Integrations', 'Glossary', 'Log',
  ]);
  const bad = parse(XLSX_IDS.replace('## 4. Scope items', '## 4. Scope stuff'));
  assert.ok(bad.errors.some(e => e.includes('§4 title')));
});

test('§4 items: header, area/tab/topic, cells, `\\|` escape and `<br>` lists', () => {
  assert.deepEqual(modelA.items.map(i => i.id), ['HIB-01', 'HIB-02', 'HIB-03', 'CMP-01']);
  assert.equal(modelA.items[0].area, 'Functional · Requirements');
  assert.equal(modelA.items[0].tab, 'Functional');
  assert.equal(modelA.items[0].topic, 'Requirements');
  assert.equal(modelA.items[3].area, 'Non-functional · Compliance');
  assert.equal(modelA.items[3].tab, 'Non-functional');
  assert.equal(modelA.items[3].topic, 'Compliance');
  const hib2 = modelA.items[1];
  assert.equal(hib2.prio, 'Should');
  assert.equal(hib2.coverage, 'Extension');
  assert.equal(hib2.confidence, 'medium');
  assert.deepEqual(hib2.effort, { size: 'M', pd: 4, regime: 'T-shirt' });
  assert.equal(hib2.requirement, 'Show stock per branch on the product page.');
  assert.deepEqual(hib2.assumptions, ['Branch stock comes from the nightly ERP sync']);
  assert.equal(hib2.internalNote, 'Ask sales whether live stock is a hard requirement');
  assert.deepEqual(hib2.references, ['kb: Stock display · Storefront']);
  assert.deepEqual(hib2.status, { kind: 'estimated', date: null, cq: null });

  const escaped = parse(XLSX_IDS.replace('kb: Stock display · Storefront', 'kb: Sync is async \\| display-only<br>- second line'));
  const lines = escaped.items[1].references;
  assert.deepEqual(lines, ['kb: Sync is async | display-only', 'second line']);
});

test('§4 Requirement Coverage: only the six values, else an error', () => {
  assert.deepEqual(modelA.items.map(i => i.coverage), ['OOTB', 'Extension', null, 'Custom']);
  const bad = parse(XLSX_IDS.replace('| Custom | low |', '| Bespoke | low |'));
  assert.ok(bad.errors.some(e => e.includes('invalid Requirement Coverage "Bespoke"')));
});

test('§4 Confidence: high|medium|low or empty', () => {
  const bad = parse(XLSX_IDS.replace('| Custom | low |', '| Custom | urgent |'));
  assert.ok(bad.errors.some(e => e.includes('invalid Confidence "urgent"')));
});

test('§4 Effort cell, both regimes, OOTB, empty', () => {
  assert.deepEqual(modelA.items[0].effort, { size: '—', pd: 0, regime: 'T-shirt' });
  assert.equal(modelA.items[2].effort, null); // not estimated
  assert.deepEqual(modelC.items[0].effort, { size: null, pd: 0, regime: 'profile' });
  assert.deepEqual(modelC.items[1].effort, { size: null, pd: 9.5, regime: 'profile' });
  assert.equal(formatEffort(modelA.items[1].effort), 'M (4 PD)');
  assert.equal(formatEffort(modelA.items[0].effort), '— (0 PD)');
  assert.equal(formatEffort(modelC.items[1].effort), '9.5 PD');
  assert.equal(formatEffort(null), '');
  const bad = parse(XLSX_IDS.replace('M (4 PD)', 'HUGE (4 PD)'));
  assert.ok(bad.errors.some(e => e.includes('invalid Estimation')));
  const bad2 = parse(XLSX_IDS.replace('M (4 PD)', 'M 4 PD'));
  assert.ok(bad2.errors.some(e => e.includes('invalid Estimation cell')));
});

test('§4 Status grammar', () => {
  assert.deepEqual(modelA.items[0].status, { kind: 'confirmed', date: '2026-09-01', cq: null });
  assert.deepEqual(modelA.items[2].status, { kind: 'blocked', date: null, cq: 'CQ-1' });
  assert.equal(formatStatus(modelA.items[0].status), 'confirmed 2026-09-01');
  assert.equal(formatStatus(modelA.items[2].status), 'blocked CQ-1');
  assert.equal(formatStatus({ kind: 'reopened', date: null, cq: null }), 'reopened');
  const bad = parse(XLSX_IDS.replace('| confirmed 2026-09-01 |', '| done |'));
  assert.ok(bad.errors.some(e => e.includes('invalid Status cell')));
});

test('§4 References: prefixes validated', () => {
  assert.equal(validReference('kb: Customer accounts'), true);
  assert.equal(validReference('isv: PIM Connector · Acme Software · 6.5, 6.6 · https://x'), true);
  assert.equal(validReference('reopened 2026-09-12: profile change re-estimated the effort'), true);
  assert.equal(validReference('was 5 PD'), true, 'ops.mjs accept\'s own audit line (effort dropped on accept)');
  assert.equal(validReference('nonsense'), false);
  const bad = parse(XLSX_IDS.replace('kb: Customer accounts', 'not a reference'));
  assert.ok(bad.errors.some(e => e.includes('invalid reference')));
});

test('§4 header must be one of the two known layouts', () => {
  assert.equal(ITEM_HEADER_LINE, '| ID | Prio | Requirement | Requirement Coverage | Confidence | Estimation | Client Response | Assumptions | Internal note | References | Status |');
  const bad = parse(XLSX_IDS.replace(ITEM_HEADER_LINE, '| Id | Prio | Coverage | Confidence | Estimation | Requirement | Client Response | Assumptions | Internal note | References | Status |'));
  assert.ok(bad.errors.some(e => e.includes('§4 header')));
});

test('§4 header: the pre-rename order/label (Effort before Requirement) still parses to the same items (5b backward read)', () => {
  const OLD_HEADER_LINE = '| ID | Prio | Requirement Coverage | Confidence | Effort | Requirement | Client Response | Assumptions | Internal note | References | Status |';
  const oldDoc = XLSX_IDS
    .replaceAll(ITEM_HEADER_LINE, OLD_HEADER_LINE)
    .replace('| HIB-01 | Must | Customers can create an account and log in. | OOTB | high | — (0 PD) | Stock Shopware customer accounts cover this out of the box. |  |  | kb: Customer accounts | confirmed 2026-09-01 |',
      '| HIB-01 | Must | OOTB | high | — (0 PD) | Customers can create an account and log in. | Stock Shopware customer accounts cover this out of the box. |  |  | kb: Customer accounts | confirmed 2026-09-01 |')
    .replace('| HIB-02 | Should | Show stock per branch on the product page. | Extension | medium | M (4 PD) | We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | estimated |',
      '| HIB-02 | Should | Extension | medium | M (4 PD) | Show stock per branch on the product page. | We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | estimated |')
    .replace('| HIB-03 | Could | The client\'s requirement text is too vague to size yet. |  |  |  |  |  |  |  | blocked CQ-1 |',
      '| HIB-03 | Could |  |  |  | The client\'s requirement text is too vague to size yet. |  |  |  |  | blocked CQ-1 |')
    .replace('| CMP-01 | Must | Provide an audit trail of every price change for the last seven years. | Custom | low | XL (25 PD) | We build a dedicated audit-trail module for pricing changes. |  |  | failed: no stock or project feature to extend | failed |',
      '| CMP-01 | Must | Custom | low | XL (25 PD) | Provide an audit trail of every price change for the last seven years. | We build a dedicated audit-trail module for pricing changes. |  |  | failed: no stock or project feature to extend | failed |');
  const old = parse(oldDoc, { path: 'specs/rfp-0101-xlsx-ids-analysis.md' });
  assert.equal(old.errors.length, 0, old.errors.join('; '));
  assert.deepEqual(old.items, modelA.items, 'the old layout parses to the exact same items as the new one');
});

test('§5 CQ block: options, effect, Fallback, Answered', () => {
  const cq = modelC.questions.find(q => q.id === 'CQ-1');
  assert.equal(cq.kind, 'cq');
  assert.deepEqual(cq.items, ['CHK-1']);
  assert.equal(cq.question, 'How many approval steps does the client\'s process require?');
  assert.deepEqual(cq.options, [
    { key: 'A', text: 'two steps', effect: 'smaller workflow engine', checked: false },
    { key: 'B', text: 'up to five steps', effect: 'a configurable step engine', checked: true },
  ]);
  assert.equal(cq.fallback, 'A');
  assert.deepEqual(cq.answered, { date: '2026-09-11', key: 'B' });

  const q1 = modelA.questions.find(q => q.id === 'CQ-1');
  assert.deepEqual(q1.items, ['HIB-03']);
  assert.equal(q1.fallback, 'B');
  assert.equal(q1.answered, null);
});

test('§5 CQ needs at least two options; a fallback must name an option', () => {
  const bad = parse(XLSX_IDS.replace(/- \[ \] B — daily sync.*\n/, ''));
  assert.ok(bad.errors.some(e => e.includes('needs at least two options')));
  const bad2 = parse(XLSX_IDS.replace('Fallback: B', 'Fallback: C'));
  assert.ok(bad2.errors.some(e => e.includes('fallback C is not one of its options')));
});

test('§5 Q block: options optional', () => {
  const q = modelB.questions.find(q => q.id === 'Q-1');
  assert.equal(q.kind, 'q');
  assert.deepEqual(q.options, []);
  assert.equal(q.fallback, null);
});

test('sheetPrefix / generateIds (SI-2)', () => {
  const taken = new Set();
  assert.equal(sheetPrefix('B2B Requirements', taken), 'BR');
  assert.equal(sheetPrefix('Non-functional & Compliance', taken), 'NC');
  assert.equal(sheetPrefix('Requirements', taken), 'REQ');
  const t2 = new Set();
  assert.equal(sheetPrefix('Cover', t2), 'COV');
  assert.equal(sheetPrefix('Cover', t2), 'COV2'); // collision -> 2, 3...
  assert.equal(sheetPrefix('Cover', t2), 'COV3');

  const areas = [
    { name: 'Requirements', items: [{ id: null, text: 'a' }, { id: 'CLIENT-9', text: 'b' }, { id: null, text: 'c' }] },
    { name: 'Requirements', items: [{ id: null, text: 'd' }] }, // second area, same name -> collision
  ];
  generateIds(areas);
  assert.deepEqual(areas[0].items.map(i => i.id), ['REQ-1', 'CLIENT-9', 'REQ-2']);
  assert.deepEqual(areas[1].items.map(i => i.id), ['REQ2-1']);

  // Stable across repeated calls with the same shape.
  const again = [
    { name: 'Requirements', items: [{ id: null }, { id: 'CLIENT-9' }, { id: null }] },
    { name: 'Requirements', items: [{ id: null }] },
  ];
  generateIds(again);
  assert.deepEqual(again.map(a => a.items.map(i => i.id)), areas.map(a => a.items.map(i => i.id)));

  // An area whose items already all carry ids never claims a prefix.
  const withIds = [{ name: 'Cover Page', items: [{ id: 'X-1' }] }];
  generateIds(withIds);
  assert.equal(withIds[0].items[0].id, 'X-1');
});

test('helpers: splitRow, splitBullets, slugFromPath, analysisPathFor, collect/findBlock', () => {
  assert.deepEqual(splitRow('| a \\| b | `c|d` | e |'), ['a | b', '`c|d`', 'e']);
  assert.deepEqual(splitBullets('- one<br>- two<br>three'), ['one', 'two', 'three']);
  assert.deepEqual(splitBullets(''), []);
  assert.equal(slugFromPath('specs/rfp-0001-x-analysis.md'), 'rfp-0001-x');
  assert.equal(slugFromPath('specs/0001-cart.md'), null);
  assert.equal(analysisPathFor('specs/rfp-0001-x.csv'), 'specs/rfp-0001-x-analysis.md');
  assert.equal(findBlock(modelA, 's4').title, 'Scope items');
  assert.equal(collect(modelA.blocks).length, 8);
});

test('parseEffort / parseStatus tolerate bad input without throwing', () => {
  const errs = [];
  assert.equal(parseEffort('', e => errs.push(e)), null);
  assert.equal(parseEffort('garbage', e => errs.push(e)), null);
  assert.ok(errs.length >= 1);
  const errs2 = [];
  assert.deepEqual(parseStatus('nope', e => errs2.push(e)), { kind: null, date: null, cq: null });
  assert.ok(errs2.length === 1);
});

test('splitHeading: `<Tab> · <Topic>`, U+00B7 with spaces', () => {
  assert.deepEqual(splitHeading('Functional · Requirements'), { tab: 'Functional', topic: 'Requirements' });
  assert.deepEqual(splitHeading('Project & services · Training'), { tab: 'Project & services', topic: 'Training' });
  assert.deepEqual(splitHeading('Requirements'), { tab: null, topic: null });
  assert.deepEqual(splitHeading('Functional - Requirements'), { tab: null, topic: null }); // hyphen is not the separator
});

test('§4 heading errors: no separator, tab not in TABS, empty topic', () => {
  assert.deepEqual(TABS, ['Functional', 'Non-functional', 'Project & services']);
  const noSep = parse(XLSX_IDS.replace('### Functional · Requirements', '### Requirements'));
  assert.ok(noSep.errors.some(e => e.includes('must be "<Tab> · <Topic>"')));
  const badTab = parse(XLSX_IDS.replace('### Functional · Requirements', '### Sales · Requirements'));
  assert.ok(badTab.errors.some(e => e.includes('tab "Sales" is not one of')));
  const emptyTopic = parse(XLSX_IDS.replace('### Functional · Requirements', '### Functional ·'));
  assert.ok(emptyTopic.errors.some(e => e.includes('topic is empty')));
});

test('§4: a duplicate item id anywhere in the section is a parse error', () => {
  const dup = parse(XLSX_IDS.replace('| CMP-01 |', '| HIB-01 |'));
  assert.ok(dup.errors.some(e => e.includes('duplicate item id "HIB-01"')));
});

test('§1 Project information: PROJECT_INFO fixed order, 18 rows, model.projectInfo', () => {
  assert.equal(PROJECT_INFO.length, 18);
  assert.equal(PROJECT_INFO[0].key, 'business-model');
  assert.equal(PROJECT_INFO[17].key, 'shopware');
  assert.equal(modelA.projectInfo.length, 18);
  const businessModel = modelA.projectInfo.find(r => r.key === 'business-model');
  assert.equal(businessModel.value, 'B2B wholesale, MRO distributor');
  assert.equal(businessModel.source, '1 Company & Context r4');
});

test('§1 Project information: a missing, unknown or out-of-order row is a parse error naming the row', () => {
  const missing = parse(XLSX_IDS.replace('| Markets | Germany, Austria | 1 Company & Context r5 |\n', ''));
  assert.ok(missing.errors.some(e => e.includes('must be "Markets"')), missing.errors.join('; '));
  const swapped = XLSX_IDS.replace(
    '| Business model | B2B wholesale, MRO distributor | 1 Company & Context r4 |\n| Markets | Germany, Austria | 1 Company & Context r5 |',
    '| Markets | Germany, Austria | 1 Company & Context r5 |\n| Business model | B2B wholesale, MRO distributor | 1 Company & Context r4 |',
  );
  const reordered = parse(swapped);
  assert.ok(reordered.errors.some(e => e.includes('row 1 must be "Business model"')), reordered.errors.join('; '));
});

test('§1 Not taken from the source: model.notTaken', () => {
  assert.deepEqual(modelA.notTaken, []);
  assert.deepEqual(modelC.notTaken, [{ source: 'PDF #7', text: 'Table of contents', why: 'not a requirement' }]);
});

test('renderProjectInfo / renderNotTaken produce the exact markdown the parser reads back', () => {
  const rendered = renderProjectInfo(modelA.projectInfo);
  assert.match(rendered, /^### Project information$/m);
  assert.match(rendered, /\| Business model \| B2B wholesale, MRO distributor \| 1 Company & Context r4 \|/);
  const rebuilt = XLSX_IDS.replace(/### Project information[\s\S]*?(?=\n### Not taken from the source)/, rendered + '\n\n');
  const reparsed = parse(rebuilt);
  assert.deepEqual(reparsed.projectInfo, modelA.projectInfo);

  const renderedNT = renderNotTaken(modelC.notTaken);
  assert.match(renderedNT, /^### Not taken from the source$/m);
  assert.match(renderedNT, /\| PDF #7 \| Table of contents \| not a requirement \|/);
});

test('frontmatter intake: absent means confirmed; only review|confirmed are valid', () => {
  assert.equal(modelA.frontmatter.data.intake, undefined);
  const review = parse(XLSX_IDS.replace('slug: rfp-0101-hartmann', 'slug: rfp-0101-hartmann\nintake: review'));
  assert.equal(review.frontmatter.data.intake, 'review');
  assert.deepEqual(review.errors, []);
  const bad = parse(XLSX_IDS.replace('slug: rfp-0101-hartmann', 'slug: rfp-0101-hartmann\nintake: maybe'));
  assert.ok(bad.errors.some(e => e.includes('intake must be "review" or "confirmed"')));
});

test('a full document parses with no errors for every sample kind', () => {
  for (const [name, m] of [['xlsx-with-ids', modelA], ['xlsx-without-ids', modelB], ['pdf-prose', modelC]]) {
    assert.deepEqual(m.errors, [], `${name}: ${m.errors.join('; ')}`);
    assert.ok(m.items.length > 0, `${name} has items`);
  }
});

test('sheetPrefix: a leading client chapter number is numbering, not a word', () => {
  assert.equal(sheetPrefix('1. GENERAL REQUIREMENTS'), 'GR');
  assert.equal(sheetPrefix('3.3 - Functional'), 'FUN');
  assert.equal(sheetPrefix('2 Requirements'), 'REQ');
  assert.equal(sheetPrefix('B2B Checkout'), 'BC');
});

test('stripChapterNumber: the same chapter-number stripping sheetPrefix uses, exported standalone', () => {
  assert.equal(stripChapterNumber('1. GENERAL REQUIREMENTS'), 'GENERAL REQUIREMENTS');
  assert.equal(stripChapterNumber('3.3 - Functional'), 'Functional');
  assert.equal(stripChapterNumber('2 Requirements'), 'Requirements');
  assert.equal(stripChapterNumber('B2B Checkout'), 'B2B Checkout');
  assert.equal(stripChapterNumber(''), '');
  assert.equal(stripChapterNumber(null), '');
});
