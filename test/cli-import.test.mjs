// `import` and `export --xlsx` as an agent actually runs them: through bin/cli.mjs, checking the
// exit codes (0 ok · 1 failure · 2 usage), the `next_step:` contract and the refusal messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildWorkbook, buildOleStub, buildEncryptedStub } from './helpers/mkxlsx.mjs';
import { readWorkbook, sheetToGrid, openZip } from '../lib/xlsx.mjs';
import { runSync as run } from './helpers.mjs';

const SLUG = 'rfp-0099-mini';
const HEADER = ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)', 'Vendor: One-off cost (EUR)'];

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

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

/** Confirms the proposed mapping the way the page's confirm button would. */
function confirm(h) {
  const dir = path.join(h.root, 'specs', '.editor', SLUG);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'import-map.proposed.json'), 'utf8'));
  map.confirmedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'import-map.json'), JSON.stringify(map, null, 2));
  return map;
}

/** The response CSV §ASSEMBLE would have written for one table. */
function responseCsv(h, table, answers) {
  const csvPath = path.join(h.root, 'specs', SLUG, `${String(table.index).padStart(2, '0')}-${table.slug}.csv`);
  const lines = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '').trim().split('\n');
  const colIdx = c => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    cells[colIdx(table.columns.compliance)] = answers.compliance;
    cells[colIdx(table.columns.comment)] = answers.comment;
    cells[colIdx(table.columns.effort)] = answers.effort;
    out.push(cells.join(','));
  }
  const file = path.join(h.root, 'specs', `${SLUG}-response-${table.n}-${table.slug}.csv`);
  fs.writeFileSync(file, `﻿${out.join('\n')}\n`);
  return file;
}

// ---------------------------------------------------------------- usage

test('import without --source is a usage error', () => {
  const h = host();
  try {
    const r = run(['import'], h.root);
    assert.equal(r.code, 2);
    assert.match(r.err, /--source/);
  } finally { h.cleanup(); }
});

test('import refuses a source that is not a workbook', () => {
  const h = host();
  try {
    fs.writeFileSync(path.join(h.root, 'specs', `${SLUG}.csv`), 'ID,Requirement\n');
    const r = run(['import', '--source', `specs/${SLUG}.csv`, '--root', h.root], h.root);
    assert.equal(r.code, 2);
    assert.match(r.err, /\.xlsx/);
    assert.match(r.err, /CSV, markdown and PDF/);
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

test('export without --xlsx, and without a confirmed mapping, both refuse clearly', () => {
  const h = host();
  try {
    const noFlag = run(['export', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.equal(noFlag.code, 2);

    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    const noMap = run(['export', '--xlsx', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.equal(noMap.code, 1);
    assert.match(noMap.err, /no confirmed import mapping/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- refusals

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

// ---------------------------------------------------------------- the happy path

test('import writes the snapshot and tells the agent what to do next', () => {
  const h = host();
  try {
    const r = run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.equal(r.code, 0);
    assert.match(r.out, /^sheets: 2 \(1 visible\)$/m);
    assert.match(r.out, /ignored \(hidden\)/);
    assert.match(r.out, /^next_step: confirm the mapping/m);
    // the contract: next_step precedes the per-sheet payload (lib/out.mjs)
    assert.ok(r.out.indexOf('next_step:') < r.out.indexOf('ignored (hidden)'),
      'next_step must come before the sheet table');
    const snap = JSON.parse(fs.readFileSync(path.join(h.root, 'specs', '.editor', SLUG, 'import-snapshot.json'), 'utf8'));
    assert.equal(snap.sheets.length, 2);
    assert.ok(snap.sha256);
    assert.equal(snap.sheets[0].part, 'xl/worksheets/sheet1.xml');
    // Nothing is written outside the session folder until the mapping is confirmed.
    assert.equal(fs.existsSync(path.join(h.root, 'specs', SLUG)), false);
  } finally { h.cleanup(); }
});

test('import --map emits the per-table CSVs of a confirmed mapping', () => {
  const h = host();
  try {
    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    confirm(h);
    const r = run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root, '--map'], h.root);
    assert.equal(r.code, 0);
    assert.match(r.out, /^wrote: specs\/rfp-0099-mini\/01-requirements\.csv \(2 rows\)$/m);
    assert.match(r.out, /^next_step: continue the analysis/m);
    const csv = fs.readFileSync(path.join(h.root, 'specs', SLUG, '01-requirements.csv'), 'utf8');
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.ok(csv.includes('GEN-01,Shop,Accounts,Must'));
    assert.ok(!csv.includes('Expected'), 'the hidden answer key is never emitted');
  } finally { h.cleanup(); }
});

test('export --xlsx writes a copy with the answers and leaves the original untouched', () => {
  const h = host();
  try {
    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    const map = confirm(h);
    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root, '--map'], h.root);
    const table = map.tables.find(t => t.role === 'requirements');
    responseCsv(h, table, { compliance: 'Stock', comment: 'Standard feature.', effort: '2' });

    const before = sha(h.source);
    const r = run(['export', '--xlsx', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.equal(r.code, 0);
    assert.match(r.out, /^wrote: specs\/rfp-0099-mini-response\.xlsx/m);
    assert.match(r.out, /^original_untouched: /m);
    assert.match(r.out, /^next_step: /m);
    assert.equal(sha(h.source), before, "the client's own file is never written");

    const out = path.join(h.root, 'specs', `${SLUG}-response.xlsx`);
    const wb = readWorkbook(out);
    const grid = sheetToGrid(wb.sheets[0]);
    assert.deepEqual(grid.rows[1].slice(4, 8), ['Stock', 'Standard feature.', '2', '']);
    assert.deepEqual(grid.rows[2].slice(4, 8), ['Stock', 'Standard feature.', '2', '']);
    assert.equal(grid.rows[1][0], 'GEN-01');                        // client cells intact
    assert.deepEqual(wb.sheets[0].validations[0].values, ['Stock', 'Custom']);   // dropdown intact
    assert.equal(wb.sheets[1].state, 'hidden');                     // hidden sheet still there

    // Only the one sheet we wrote into differs from the client's file.
    const zin = openZip(fs.readFileSync(h.source));
    const zout = openZip(fs.readFileSync(out));
    const differing = zin.names().filter(n => !zin.raw(n).equals(zout.raw(n) || Buffer.alloc(0)));
    assert.deepEqual(differing, ['xl/worksheets/sheet1.xml']);
  } finally { h.cleanup(); }
});

test('export refuses when a response CSV no longer matches the mapping', () => {
  const h = host();
  try {
    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    const map = confirm(h);
    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root, '--map'], h.root);
    const table = map.tables.find(t => t.role === 'requirements');
    const file = responseCsv(h, table, { compliance: 'Stock', comment: 'ok', effort: '2' });

    // Someone deleted a row from the response CSV: the workbook must not be written half-filled.
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n`);
    const r = run(['export', '--xlsx', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.equal(r.code, 1);
    assert.match(r.err, /row count 1 does not match/);
    assert.equal(fs.existsSync(path.join(h.root, 'specs', `${SLUG}-response.xlsx`)), false);
  } finally { h.cleanup(); }
});

test('export names the missing response CSV instead of writing a partial workbook', () => {
  const h = host();
  try {
    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    confirm(h);
    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root, '--map'], h.root);
    const r = run(['export', '--xlsx', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.equal(r.code, 1);
    assert.match(r.err, /missing response CSV for table 1/);
  } finally { h.cleanup(); }
});

test('--accept-proposed confirms the mapping for a run without the editor page', () => {
  const h = host();
  try {
    const first = run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.match(first.out, /^next_step: confirm the mapping.*--accept-proposed/m);

    const r = run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root, '--map', '--accept-proposed'], h.root);
    assert.equal(r.code, 0);
    assert.match(r.out, /^wrote: specs\/rfp-0099-mini\/01-requirements\.csv/m);
    // The mapping is committed next to the CSVs, exactly as the page's confirm commits it.
    const committed = JSON.parse(fs.readFileSync(path.join(h.root, 'specs', SLUG, 'import-map.json'), 'utf8'));
    assert.ok(committed.confirmedAt);
    assert.equal(committed.confirmedBy, 'cli --accept-proposed');

    // And it is a real confirmation: export now works off it.
    const table = committed.tables.find(t => t.role === 'requirements');
    responseCsv(h, table, { compliance: 'Custom', comment: 'Built.', effort: '3' });
    const exported = run(['export', '--xlsx', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    assert.equal(exported.code, 0);
  } finally { h.cleanup(); }
});

test('--accept-proposed refuses a proposal that is not usable, instead of guessing', () => {
  // A sheet with no id-like column: the tool must send the user to the page, not invent a mapping.
  const bytes = buildWorkbook([{ name: 'Notes', rows: [['Topic', 'Vendor: Comment'], ['Hosting', '']] }]);
  const h = host(bytes);
  try {
    run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root], h.root);
    const r = run(['import', '--source', `specs/${SLUG}.xlsx`, '--root', h.root, '--map', '--accept-proposed'], h.root);
    // No requirement table was proposed, so nothing is written and nothing is claimed.
    assert.equal(r.code, 0);
    const dir = path.join(h.root, 'specs', SLUG);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.ok(!files.includes('01-requirements.csv'));
  } finally { h.cleanup(); }
});
