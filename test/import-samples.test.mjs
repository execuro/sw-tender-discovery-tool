// End-to-end proof, on the two real samples, that `import` writes a usable digest and that
// `intake --extraction <json>` (a hand-made extraction fixture, the shape a good extract agent
// would return from that digest) yields every requirement, ids verbatim (sample A) or generated
// and stable (sample B), and that `tokens --suggest`'s own heuristic (`guessCoverageTokenMap`)
// still lands on a full six-value coverage guess from the fit-back map's own recorded compliance
// tokens. Works on tmp copies; the tracked samples are never written to and their sha256 is
// asserted unchanged. Build contract `own-tabs-contract.md` §2/§4/§5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COVERAGE_KEYS, guessCoverageTokenMap, readFitBack } from '../lib/import-map.mjs';
import { importSource } from '../lib/import-export.mjs';
import { intake } from '../lib/intake.mjs';
import { parse } from '../lib/parse.mjs';

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REAL_SPECS = path.join(HERE_DIR, '..', '..', '..', '..', 'specs');
const SAMPLE_A = path.join(REAL_SPECS, 'rfp-0001-hartmann-industriebedarf-replatforming.xlsx');
const SAMPLE_B = path.join(REAL_SPECS, 'rfp-0002-b2b-ecommerce-smb.xlsx');
const EXTRACTION_A = JSON.parse(fs.readFileSync(path.join(HERE_DIR, 'fixtures', 'rfp-0001-extraction.json'), 'utf8'));
const EXTRACTION_B = JSON.parse(fs.readFileSync(path.join(HERE_DIR, 'fixtures', 'rfp-0002-extraction.json'), 'utf8'));

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-samples-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Copies `real` into a tmp host under `specs/`, runs `import`, then `intake --extraction`. Never
 * touches the tracked sample. */
function importAndIntake(root, real, extraction) {
  const sourceAbs = path.join(root, 'specs', path.basename(real));
  fs.copyFileSync(real, sourceAbs);
  const { proposed } = importSource({ root, source: sourceAbs });
  const doc = path.join(root, 'specs', `${path.basename(sourceAbs, '.xlsx')}-analysis.md`);
  const r = intake({ root, doc, source: sourceAbs, extraction });
  return { sourceAbs, doc, r, proposed };
}

function assertAllSixTokensFilled(coverage, where) {
  for (const key of COVERAGE_KEYS) assert.ok(coverage[key], `${where}: coverage token for "${key}" must not be empty`);
}

// ---------------------------------------------------------------- sample sha256 unchanged

test('the tracked samples are never modified by importing or intaking them', () => {
  const beforeA = sha256(SAMPLE_A);
  const beforeB = sha256(SAMPLE_B);
  const h1 = host();
  try { importAndIntake(h1.root, SAMPLE_A, EXTRACTION_A); } finally { h1.cleanup(); }
  const h2 = host();
  try { importAndIntake(h2.root, SAMPLE_B, EXTRACTION_B); } finally { h2.cleanup(); }
  assert.equal(sha256(SAMPLE_A), beforeA);
  assert.equal(sha256(SAMPLE_B), beforeB);
});

// ---------------------------------------------------------------- sample A (defect D)

test('sample A: import -> intake yields 135 items (91/34/10), ids verbatim, no `_answer_key`-style column anywhere', () => {
  if (!fs.existsSync(SAMPLE_A)) { console.log('  (skipped — sample A not present)'); return; }
  const h = host();
  try {
    const { doc, r } = importAndIntake(h.root, SAMPLE_A, EXTRACTION_A);
    assert.equal(r.added.length, 135);
    const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model.errors, []);
    assert.equal(model.items.length, 135);
    assert.equal(model.items.filter(i => i.tab === 'Functional').length, 91);
    assert.equal(model.items.filter(i => i.tab === 'Non-functional').length, 34);
    assert.equal(model.items.filter(i => i.tab === 'Project & services').length, 10);
    // The client's own ids, verbatim (GEN-01, NFR-01, PRJ-01 style) — not the generated
    // `<prefix>-<n>` shape.
    assert.ok(model.items.every(i => /^[A-Z][A-Z0-9]*-\d+$/.test(i.id)));
    assert.equal(model.frontmatter.data.intake, 'confirmed');
    assert.doesNotMatch(fs.readFileSync(doc, 'utf8'), /_answer_key/);
  } finally { h.cleanup(); }
});

test('sample A: every table\'s recorded compliance tokens (fit-back map) guess all six coverage values, none empty', () => {
  if (!fs.existsSync(SAMPLE_A)) { console.log('  (skipped — sample A not present)'); return; }
  const h = host();
  try {
    const { sourceAbs } = importAndIntake(h.root, SAMPLE_A, EXTRACTION_A);
    const map = readFitBack(h.root, sourceAbs);
    assert.equal(map.tables.length, 3);
    for (const t of map.tables) {
      assert.equal(t.tokens.coverage, undefined, 'RC-4 is decided at export time, never written here');
      assertAllSixTokensFilled(guessCoverageTokenMap(t.tokens.compliance || []), t.key);
    }
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- sample B (defect D + E)

const SAMPLE_B_TOPICS = [
  { topic: 'General', tab: 'Functional', items: 4 },
  { topic: 'IT & HOSTING', tab: 'Non-functional', items: 4 },
  { topic: 'SECURITY', tab: 'Non-functional', items: 5 },
  { topic: 'Design & Development', tab: 'Functional', items: 11 },
  { topic: 'Customer Service', tab: 'Functional', items: 4 },
  { topic: 'Marketing & Promotions', tab: 'Functional', items: 6 },
  { topic: 'Products & Categories', tab: 'Functional', items: 14 },
  { topic: 'Administration', tab: 'Functional', items: 15 },
  { topic: 'Services', tab: 'Project & services', items: 10 },
  { topic: 'Company Overview', tab: 'Project & services', items: 11 },
];
const SAMPLE_B_TOTAL = SAMPLE_B_TOPICS.reduce((n, a) => n + a.items, 0);   // 84

test('sample B: import -> intake yields 84 items, one topic per block, ids generated and stable across a second intake', () => {
  if (!fs.existsSync(SAMPLE_B)) { console.log('  (skipped — sample B not present)'); return; }
  const h = host();
  try {
    const { doc, sourceAbs, r: r1 } = importAndIntake(h.root, SAMPLE_B, EXTRACTION_B);
    assert.equal(r1.added.length, SAMPLE_B_TOTAL);
    const model1 = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model1.errors, []);
    assert.equal(model1.items.length, SAMPLE_B_TOTAL);
    for (const { topic, tab, items } of SAMPLE_B_TOPICS) {
      assert.equal(model1.items.filter(i => i.topic === topic && i.tab === tab).length, items, `topic "${topic}"`);
    }
    const ids1 = model1.items.map(i => i.id);
    assert.ok(ids1.every(id => /^[A-Z0-9]+-\d+$/.test(id)), `generated ids must be <prefix>-<n>, got ${ids1.join(', ')}`);
    assert.equal(new Set(ids1).size, ids1.length, 'ids must be unique across the whole document');

    const r2 = intake({ root: h.root, doc, source: sourceAbs, extraction: EXTRACTION_B });
    assert.deepEqual(r2.added, [], 'a second intake of the same file must add nothing');
    const model2 = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
    assert.deepEqual(model2.items.map(i => i.id), ids1, 'ids must be stable across intakes of the same file');
  } finally { h.cleanup(); }
});

test('sample B: every table with a compliance column records the legend, and guessing from it fills all six coverage tokens', () => {
  if (!fs.existsSync(SAMPLE_B)) { console.log('  (skipped — sample B not present)'); return; }
  const h = host();
  try {
    const { sourceAbs } = importAndIntake(h.root, SAMPLE_B, EXTRACTION_B);
    const map = readFitBack(h.root, sourceAbs);
    assert.equal(map.tables.length, SAMPLE_B_TOPICS.length);
    // "Company Overview" (ITEM/RESPONSE) has no compliance column — free text only, nothing to guess.
    const withCompliance = map.tables.filter(t => t.columns.compliance);
    assert.equal(withCompliance.length, SAMPLE_B_TOPICS.length - 1);
    for (const t of withCompliance) {
      assert.deepEqual(t.tokens.compliance, ['Not Supported', 'Roadmap', 'Customization', 'Configuration', 'Standard']);
      assertAllSixTokensFilled(guessCoverageTokenMap(t.tokens.compliance), t.key);
    }
  } finally { h.cleanup(); }
});
