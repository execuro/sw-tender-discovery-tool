// `import` as an agent actually runs it: through bin/cli.mjs, checking the exit codes
// (0 ok · 1 failure · 2 usage), the `next_step:` contract and the refusal messages. `export`'s
// own behaviour (surgical xlsx / built working-sheet workbook) is covered by test/export.test.mjs
// and test/intake.test.mjs — this file is the CLI-argument layer for both commands. Own-tabs
// (build contract `own-tabs-contract.md`): `import` no longer confirms a mapping or writes
// per-table CSVs — it writes a snapshot, a proposed mapping and the digest `sw-tender-editor`
// reads (contract §3/§5); `--map`/`--accept-proposed` are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkbook, buildOleStub, buildEncryptedStub } from './helpers/mkxlsx.mjs';
import { runSync as run } from './helpers.mjs';
import { PROJECT_INFO, renderProjectInfo, renderNotTaken } from '../lib/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPECS = path.join(here, '..', '..', '..', '..', 'specs');

const SLUG = 'rfp-0099-mini';
const HEADER = ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)', 'Vendor: One-off cost (EUR)'];

/** A temp host repo holding one workbook under specs/. */
function host(bytes = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-cli-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  const source = path.join(root, 'specs', `${SLUG}.xlsx`);
  fs.writeFileSync(source, bytes || buildWorkbook([
    {
      name: '1 Requirements',
      rows: [HEADER, ['GEN-01', 'Shop', 'Accounts', 'Must', '', '', '', ''], ['GEN-02', 'Shop', 'Prices', 'Should', '', '', '', '']],
      validations: [{ sqref: 'E2:E3', values: ['Stock', 'Custom'] }],
      styleRow: 1,
    },
    { name: '_answer_key', state: 'hidden', rows: [['ID', 'Expected'], ['GEN-01', 'Custom']] },
  ]));
  return { root, source, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- import: usage

test('import without --source is a usage error', () => {
  const h = host();
  try {
    const r = run(['import'], h.root);
    assert.equal(r.code, 2);
    assert.match(r.err, /--source/);
  } finally { h.cleanup(); }
});

test('import refuses a source that is not xlsx or csv', () => {
  const h = host();
  try {
    fs.writeFileSync(path.join(h.root, 'specs', `${SLUG}.md`), '# not a workbook\n');
    const r = run(['import', '--source', `specs/${SLUG}.md`, '--root', h.root], h.root);
    assert.equal(r.code, 1);
    assert.match(r.err, /\.xlsx or \.csv/);
  } finally { h.cleanup(); }
});

test('import reports a missing file as a usage error, not a crash', () => {
  const h = host();
  try {
    const r = run(['import', '--source', 'specs/nope.xlsx', '--root', h.root], h.root);
    assert.equal(r.code, 2);
    assert.match(r.err, /source not found/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- import: refusals

test('a legacy .xls and an encrypted workbook are refused with advice', () => {
  for (const [bytes, expect] of [[buildOleStub(), /re-save as \.xlsx/i], [buildEncryptedStub(), /password-protected/i]]) {
    const h = host(bytes);
    try {
      const r = run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
      assert.equal(r.code, 1);
      assert.match(r.err, expect);
    } finally { h.cleanup(); }
  }
});

// ---------------------------------------------------------------- import: the happy path (xlsx)

test('import writes the snapshot, the proposed mapping and the digest, and tells the agent what to do next', () => {
  const h = host();
  try {
    const r = run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^sheets: 2 \(1 visible\)$/m);
    assert.match(r.out, /^requirement_tables: 1$/m);
    assert.match(r.out, /^digest: specs\/\.editor\/rfp-0099-mini\/import-digest\.md$/m);
    assert.match(r.out, /^next_step: run the `sw-tender-editor` extract job on the digest/m);
    // the contract: next_step precedes any payload (lib/out.mjs)
    assert.ok(r.out.indexOf('next_step:') > r.out.indexOf('digest:'), 'next_step must be the last line before any payload');

    const dir = path.join(h.root, 'specs', '.editor', SLUG);
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'import-snapshot.json'), 'utf8'));
    assert.equal(snap.sheets.length, 2);
    assert.ok(snap.sha256);
    assert.equal(snap.sheets[0].part, 'xl/worksheets/sheet1.xml');
    const proposed = JSON.parse(fs.readFileSync(path.join(dir, 'import-map.proposed.json'), 'utf8'));
    assert.equal(proposed.tables.filter(t => t.role === 'requirements').length, 1);

    // the digest is visible sheets only — the hidden `_answer_key` sheet is never mentioned.
    const digest = fs.readFileSync(path.join(dir, 'import-digest.md'), 'utf8');
    assert.match(digest, /## Sheet 1: 1 Requirements/);
    assert.doesNotMatch(digest, /_answer_key/);
    assert.doesNotMatch(digest, /Expected/);
    assert.match(digest, /GEN-01/);

    // Nothing is written outside the session folder — there is no wizard to confirm any more.
    assert.equal(fs.existsSync(path.join(h.root, 'specs', SLUG)), false);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- import: CSV source (task 2)

test('import reads a CSV source through the same digest, delimiter auto-detected', () => {
  const h = host();
  try {
    const csvSlug = 'rfp-0099-csv';
    fs.writeFileSync(path.join(h.root, 'specs', `${csvSlug}.csv`),
      'ID;Requirement;Priority;Vendor: Compliance;Vendor: Comment;Vendor: Effort (PD)\nGEN-01;Some requirement;Must;;;\n');
    const r = run(['import', '--source', `specs/${csvSlug}.csv`, '--root', h.root], h.root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^sheets: 1 \(1 visible\)$/m);
    assert.match(r.out, /^requirement_tables: 1$/m);
    const digest = fs.readFileSync(path.join(h.root, 'specs', '.editor', csvSlug, 'import-digest.md'), 'utf8');
    assert.match(digest, /GEN-01/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- import: multi-block sheets

test('import\'s digest lists every block of a multi-block sheet under its own sheet heading (defect E, real sample)', () => {
  const name = 'rfp-0002-b2b-ecommerce-smb.xlsx';
  const real = path.join(SPECS, name);
  if (!fs.existsSync(real)) { console.log(`  (skipped — ${name} not present)`); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-cli-multiblock-'));
  try {
    fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
    const source = path.join(root, 'specs', name);
    fs.copyFileSync(real, source);   // work on a copy, never the tracked file
    const r = run(['import', '--source', source, '--root', root], root);
    assert.equal(r.code, 0, r.err);
    const digest = fs.readFileSync(path.join(root, 'specs', '.editor', 'rfp-0002-b2b-ecommerce-smb', 'import-digest.md'), 'utf8');
    // "3.2 - Technical " has two blocks (IT & HOSTING, SECURITY) sharing one sheet — both blocks'
    // own `Proposed:` line must appear under that one sheet heading.
    const idx = digest.indexOf('## Sheet 5:');
    const nextIdx = digest.indexOf('## Sheet 6:');
    const section = digest.slice(idx, nextIdx < 0 ? undefined : nextIdx);
    assert.match(section, /IT & HOSTING/);
    assert.match(section, /SECURITY/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- export: CLI-argument layer

test('export needs a <doc> argument', () => {
  const h = host();
  try {
    const r = run(['export'], h.root);
    assert.equal(r.code, 2);
    assert.match(r.err, /<doc>/);
  } finally { h.cleanup(); }
});

test('export reports a missing document as a usage error', () => {
  const h = host();
  try {
    const r = run(['export', 'specs/nope-analysis.md', '--root', h.root], h.root);
    assert.equal(r.code, 2);
    assert.match(r.err, /document not found/);
  } finally { h.cleanup(); }
});

test('export refuses a document with no source recorded', () => {
  const h = host();
  try {
    const doc = path.join(h.root, 'specs', 'rfp-0099-empty-analysis.md');
    const projectInfo = PROJECT_INFO.map(({ key, label }) => ({ key, label, value: 'not stated', source: '' }));
    fs.writeFileSync(doc, [
      '---', 'state: In progress', 'regime: T-shirt', 'source-sha256: {}', 'slug: rfp-0099-empty', '---',
      '# Empty', '', '## 1. Context', '', renderProjectInfo(projectInfo), '', renderNotTaken([]), '',
      '## 2. Totals', '', '<!-- totals:begin -->', '<!-- totals:end -->', '',
      '## 3. Global assumptions and exclusions', '', '### Assumptions', '', '### Exclusions', '',
      '## 4. Scope items', '', '## 5. Questions', '', '## 6. Integrations', '', '## 7. Glossary', '', '## 8. Log', '',
    ].join('\n'));
    const r = run(['export', doc, '--root', h.root], h.root);
    assert.equal(r.code, 1);
    assert.match(r.err, /names no source file/);
  } finally { h.cleanup(); }
});
