import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, moneyHits, amountHits, renderTotals, setFrontmatterField } from '../lib/check.mjs';
import { parse } from '../lib/parse.mjs';
import { reestimateList } from '../lib/proposals.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), 'utf8');
const PROFILE_REGIME_FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'rfp-0103-pdf-prose-analysis.md'), 'utf8');

function host(docContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-check-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // so path resolution finds this as the root
  const doc = path.join(root, 'specs', 'rfp-0101-xlsx-ids-analysis.md');
  fs.writeFileSync(doc, docContent, 'utf8');
  return { root, doc, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Capture out.mjs stdout lines from a `main()` call, restoring process state after. */
async function runMain(argv) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = c => { chunks.push(String(c)); return true; };
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(argv);
    return { out: chunks.join(''), code: process.exitCode ?? 0 };
  } finally {
    process.stdout.write = orig;
    process.exitCode = origExit;
  }
}

test('moneyHits: word, symbol and ISO code, case-insensitive, word boundaries', () => {
  assert.deepEqual(moneyHits('a fixed price applies'), ['money term']);
  assert.deepEqual(moneyHits('PRICING information'), []); // "pricing" does not match \bprice\b
  assert.deepEqual(moneyHits('please integrate the feedback'), []); // R-7 examples
  assert.deepEqual(moneyHits('costs €500'), ['money term', 'currency symbol']);
  assert.deepEqual(moneyHits('billed in EUR'), ['currency code']);
  assert.deepEqual(moneyHits('a rate limit on the API'), ['money term']);
  assert.deepEqual(moneyHits('nothing here'), []);
});

test('renderTotals: T-shirt regime line, tables by priority/tab, readiness line', () => {
  const model = parse(FIXTURE);
  const text = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  assert.match(text, /^Regime: T-shirt, default scale, before overhead and buffer$/m);
  assert.match(text, /Confirmed 1 of 4 · Reopened 0 · Failed 1 · Open CQ 1 · Low confidence 1 · Waiting proposals 0/);
  assert.match(text, /\| Total \|/);
});

test('renderTotals: profile regime names overhead/buffer', () => {
  const text = renderTotals([], { regime: 'profile', profile: { overhead: 10, buffer: { percent: 5, mode: 'folded' } } });
  assert.match(text, /^Regime: profile \(overhead 10%, buffer 5% folded\)$/m);
});

test('setFrontmatterField adds or replaces a key without touching the rest', () => {
  const text = '---\nslug: x\nstate: In progress\n---\nbody\n';
  const updated = setFrontmatterField(text, 'state', 'Ready');
  assert.match(updated, /state: Ready/);
  assert.doesNotMatch(updated, /In progress/);
  assert.match(updated, /slug: x/);
  const added = setFrontmatterField('---\nslug: x\n---\nbody\n', 'state', 'Ready');
  assert.match(added, /slug: x\nstate: Ready/);
});

test('a clean document with matching §2 totals passes', async () => {
  // Give it correct, pre-computed totals so `check` (without --write) agrees.
  const model = parse(FIXTURE);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const withTotals = FIXTURE.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(withTotals);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /state: In progress/);
  } finally { h.cleanup(); }
});

test('E-3: mismatched §2 totals fail, naming the reason', async () => {
  const model = parse(FIXTURE);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions }).replace('Confirmed 1 of 4', 'Confirmed 4 of 4');
  const withTotals = FIXTURE.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(withTotals);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 1);
    assert.match(r.out, /do not match the recomputed totals/);
  } finally { h.cleanup(); }
});

test('--write regenerates §2 and sets frontmatter state', async () => {
  const h = host(FIXTURE);
  try {
    const r = await runMain([h.doc, '--write']);
    assert.equal(r.code, 0, r.out);
    const written = fs.readFileSync(h.doc, 'utf8');
    assert.match(written, /Regime: T-shirt, default scale, before overhead and buffer/);
    assert.match(written, /state: In progress/); // not every item confirmed yet
  } finally { h.cleanup(); }
});

test('L-7: --write sets state Ready once every item is confirmed', async () => {
  const allConfirmed = FIXTURE
    .replace('| estimated |', '| confirmed 2026-09-02 |')
    .replace('| blocked CQ-1 |', '| confirmed 2026-09-02 |')
    .replace('| failed |', '| confirmed 2026-09-02 |');
  const h = host(allConfirmed);
  try {
    const r = await runMain([h.doc, '--write']);
    assert.equal(r.code, 0, r.out);
    const written = fs.readFileSync(h.doc, 'utf8');
    assert.match(written, /state: Ready/);
  } finally { h.cleanup(); }
});

test('X-7/R-7: a money term in the Client Response fails the scan', async () => {
  // "budget" is not in CMP-01's Requirement text, so R-7a's exemption does not apply.
  const priced = FIXTURE.replace('We build a dedicated audit-trail module for pricing changes.', 'We build a dedicated audit-trail module; the budget is fixed.');
  const model = parse(priced);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = priced.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 1);
    assert.match(r.out, /money term/);
  } finally { h.cleanup(); }
});

test('R-7a: a money word quoted back from the client\'s own Requirement is exempt in Client Response/Assumptions; a currency symbol or ISO code never is', async () => {
  // CMP-01's Requirement itself reads "...every price change for the last seven years." —
  // reusing the word "price" in the Client Response is the client's own vocabulary, not the
  // tool stating a price.
  const priced = FIXTURE.replace('We build a dedicated audit-trail module for pricing changes.', 'We build a dedicated audit-trail module to track every price change.');
  const model = parse(priced);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = priced.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
  } finally { h.cleanup(); }

  // The same Response with a currency symbol added is never exempt.
  const withSymbol = priced.replace('every price change.', 'every price change; costs €500.');
  const model2 = parse(withSymbol);
  const totals2 = renderTotals(model2.items, { regime: 'T-shirt', questions: model2.questions });
  const doc2 = withSymbol.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals2}\n<!-- totals:end -->`);
  const h2 = host(doc2);
  try {
    const r2 = await runMain([h2.doc]);
    assert.equal(r2.code, 1);
    assert.match(r2.out, /currency symbol/);
  } finally { h2.cleanup(); }
});

test('R-7a: the exemption matches word stems — "prices"/"priced" in the response is exempt when the Requirement says "price"', async () => {
  // CMP-01's Requirement reads "...every price change for the last seven years." (singular);
  // the Client Response below quotes it back inflected differently.
  for (const word of ['prices', 'priced']) {
    const doc0 = FIXTURE.replace('We build a dedicated audit-trail module for pricing changes.', `We build a dedicated audit-trail module that tracks ${word} over time.`);
    const model = parse(doc0);
    const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
    const doc = doc0.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
    const h = host(doc);
    try {
      const r = await runMain([h.doc]);
      assert.equal(r.code, 0, `"${word}": ${r.out}`);
    } finally { h.cleanup(); }
  }
});

test('R-7a: a kb:/project: reference is exempt from the money scan', async () => {
  const withRefs = FIXTURE.replace('kb: Stock display · Storefront', 'kb: Stock display price guide · Storefront');
  const model = parse(withRefs);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = withRefs.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
  } finally { h.cleanup(); }
});

test('D-33: a cost: reference is exempt from money words but not from the amount check', async () => {
  const worded = FIXTURE.replace('kb: Stock display · Storefront', 'kb: Stock display · Storefront<br>cost: recurring subscription fee for the connector licence');
  const model = parse(worded);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = worded.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
  } finally { h.cleanup(); }

  const priced = FIXTURE.replace('kb: Stock display · Storefront', 'kb: Stock display · Storefront<br>cost: EUR 500 per month');
  const modelP = parse(priced);
  const totalsP = renderTotals(modelP.items, { regime: 'T-shirt', questions: modelP.questions });
  const docP = priced.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totalsP}\n<!-- totals:end -->`);
  const hP = host(docP);
  try {
    const r = await runMain([hP.doc]);
    assert.equal(r.code, 1);
    assert.match(r.out, /amount/);
  } finally { hP.cleanup(); }
});

test('§1 Project information: an amount in a Value is the client\'s or operator\'s own fact, not refused (2026-09-24 decision)', async () => {
  const priced = FIXTURE.replace('| Business model | B2B wholesale, MRO distributor | 1 Company & Context r4 |', '| Business model | B2B wholesale, average order EUR 380 | 1 Company & Context r4 |');
  const model = parse(priced);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = priced.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Project information/);
  } finally { h.cleanup(); }
});

test('§1 Project information: money words and a bare currency are the client\'s own facts, not amounts', async () => {
  const worded = FIXTURE.replace('| Business model | B2B wholesale, MRO distributor | 1 Company & Context r4 |', '| Business model | B2B wholesale, customer-specific prices, EUR only | 1 Company & Context r4 |');
  const model = parse(worded);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = worded.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const r = await runMain([h.doc]);
    assert.doesNotMatch(r.out, /Project information/);
  } finally { h.cleanup(); }
});

test('R-7 scope: §7 Glossary is a transcription of the client\'s own document, never scanned — "Price list" passes', async () => {
  const withGlossary = FIXTURE.replace('## 7. Glossary\n', '## 7. Glossary\n\n| Term | Meaning |\n| --- | --- |\n| Price list | The client\'s published catalogue prices. |\n');
  const model = parse(withGlossary);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = withGlossary.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
  } finally { h.cleanup(); }
});

test('R-7 scope: the fit-back map is the client\'s own sheet/column text, never scanned — a sheet named "Pricing" passes', async () => {
  const model = parse(FIXTURE);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = FIXTURE.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const mapDir = path.join(h.root, 'specs', 'rfp-0101-hartmann');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(path.join(mapDir, 'import-map.json'), JSON.stringify({
      tables: [{ key: 'Pricing r1', sheet: 'Pricing', headerText: ['Item', 'Price'] }],
      unusedSheets: ['Pricing overview'], items: { 'CMP-01': { table: 'Pricing r1', sheet: 'Pricing', row: 2 } },
    }));
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
  } finally { h.cleanup(); }
});

test('R-7 scope: §1 tool-written prose (before "### Project information") is scanned — "budget" fails', async () => {
  const withBudget = FIXTURE.replace(
    'Detected: Shopware 6.6, Beyond Edition, no existing project.',
    'Detected: Shopware 6.6, Beyond Edition, no existing project. The budget for this phase is fixed.',
  );
  const model = parse(withBudget);
  const totals = renderTotals(model.items, { regime: 'T-shirt', questions: model.questions });
  const doc = withBudget.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 1);
    assert.match(r.out, /§1: money term/);
  } finally { h.cleanup(); }
});

test('R-7a on proposals: a proposal\'s money word is exempt when its item\'s Requirement uses it', async () => {
  // One waiting proposal, whichever it is — the readiness line's "Waiting proposals" count must
  // match it, or the §2 totals check fails first.
  const oneWaiting = [{ id: 'P-1', item: 'CMP-01', statement: 'x', pdSaved: 2, status: 'waiting' }];
  const model = parse(FIXTURE);
  const totals = renderTotals(model.items, { regime: 'T-shirt', proposals: oneWaiting, questions: model.questions });
  const doc = FIXTURE.replace('<!-- totals:begin -->\n<!-- totals:end -->', `<!-- totals:begin -->\n${totals}\n<!-- totals:end -->`);
  const h = host(doc);
  try {
    // CMP-01's Requirement reads "...every price change for the last seven years." — a proposal
    // against CMP-01 that says "fixed price" quotes the client's own vocabulary back.
    const rfpDir = path.join(h.root, 'specs', '.rfp', 'rfp-0101-xlsx-ids');
    fs.mkdirSync(rfpDir, { recursive: true });
    fs.writeFileSync(path.join(rfpDir, 'proposals.json'), JSON.stringify([
      { id: 'P-1', item: 'CMP-01', statement: 'fixed price for the audit trail module', pdSaved: 2, status: 'waiting' },
    ]));
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);

    // A global proposal (no item) has no requirement to exempt against — the same word fails.
    fs.writeFileSync(path.join(rfpDir, 'proposals.json'), JSON.stringify([
      { id: 'P-2', item: null, statement: 'fixed price across the whole scope', pdSaved: 2, status: 'waiting' },
    ]));
    const r2 = await runMain([h.doc]);
    assert.equal(r2.code, 1);
    assert.match(r2.out, /proposal P-2: money term/);
  } finally { h.cleanup(); }
});

test('amountHits: a number with a currency either side is an amount; words and bare codes are not', () => {
  for (const s of ['EUR 380', '€120k', '160,000 EUR', '1.5 m €', '$20']) assert.deepEqual(amountHits(s), ['amount'], s);
  for (const s of ['EUR', 'Euro only', 'customer-specific prices', '25,000 SKUs', 'tier prices for 70% of SKUs', 'Currencies: EUR, CHF']) assert.deepEqual(amountHits(s), [], s);
});

test('a grammar error (bad Requirement Coverage) fails with a reason, exit 1', async () => {
  const bad = FIXTURE.replace('| Custom | low |', '| Bespoke | low |');
  const h = host(bad);
  try {
    const r = await runMain([h.doc]);
    assert.equal(r.code, 1);
    assert.match(r.out, /invalid Requirement Coverage/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- T4: regime change on --write

test('T4: `check --write` follows a regime that no longer matches the document (profile removed) — updates the regime, queues every item for re-estimate, and reports it', async () => {
  const h = host(PROFILE_REGIME_FIXTURE);   // frontmatter says `regime: profile`; no profile file exists in this host
  try {
    const r = await runMain([h.doc, '--write']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /regime changed — every item queued for re-estimate/);

    const written = fs.readFileSync(h.doc, 'utf8');
    assert.match(written, /regime: T-shirt/);

    const marks = reestimateList(h.root, 'rfp-0101-xlsx-ids');
    assert.ok(marks.some(m => m.item === '*'), 'every item must be queued for re-estimate');
  } finally { h.cleanup(); }
});

test('T4: an Effort cell in the other regime\'s format is accepted, not a failure, and flagged in the check output', async () => {
  const h = host(PROFILE_REGIME_FIXTURE);
  try {
    // First --write follows the document to the live (T-shirt) regime; its items still carry
    // `profile`-regime Effort cells (`9.5 PD`, `0 PD`) until re-estimated.
    await runMain([h.doc, '--write']);
    const r = await runMain([h.doc]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /other regime's format, pending re-estimate/);
  } finally { h.cleanup(); }
});

test('#5: §2 marks stale (regime-changed) figures with a footnote, and a small stale figure is not counted "not decomposed"', async () => {
  const h = host(PROFILE_REGIME_FIXTURE);
  try {
    // Regime reverts to T-shirt on this --write; the items' Effort cells stay in the profile
    // format (small PDs, well under the T-shirt XXL ceiling) until the next apply re-estimates
    // them — stale, but not "not decomposed" just for being stale (#5).
    await runMain([h.doc, '--write']);
    const written = fs.readFileSync(h.doc, 'utf8');
    assert.match(written, /Stale \(regime changed\): \d+ — pending re-estimate/);
    assert.doesNotMatch(written.split('Stale')[0], /\| Total \| \d+ \| [\d.]+ \| \d+ \| \d+ \| [1-9]/,
      'the small stale figures must not inflate the Not decomposed total column');
  } finally { h.cleanup(); }
});
