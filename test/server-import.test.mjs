// The server side of the own-tabs intake flow (build contract `own-tabs-contract.md` §3, §4, §6):
// an xlsx source imports straight to a digest (no operator mapping step), `intake` builds the
// working document and confirms it itself (no review step, no operator button), and the page's
// move/skip/restore/info endpoints work it at any time, all through the Page API rather than the
// removed steering screen. `intake/confirm` stays only for an old document still at `review` from
// before this change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, Session } from '../lib/server.mjs';
import { main as importExportMain, importSource } from '../lib/import-export.mjs';
import { intake } from '../lib/intake.mjs';
import { parse } from '../lib/parse.mjs';
import { buildWorkbook } from './helpers/mkxlsx.mjs';
import { canBind, HERE } from './helpers.mjs';

// One top-level await, resolved once — see test/server-import.test.mjs's own earlier note (still
// applies): registering several `{ skip: !(await canBind()) }` options further down interleaves
// module evaluation with the test runner, which can silently drop a later test. HERE is unused
// directly but kept imported so a future fixture path has it ready without another import line.
void HERE;
const CAN_BIND = await canBind();

const REQ_HEADER = ['ID', 'Topic', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'];

function workbook() {
  return buildWorkbook([{
    name: '1 Requirements',
    rows: [
      REQ_HEADER,
      ['GEN-01', 'Accounts', 'Customers can create an account.', 'Must', '', '', ''],
      ['GEN-02', 'Accounts', 'Customers can request a quote.', 'Should', '', '', ''],
    ],
    validations: [{ sqref: 'E2:E3', values: ['Stock', 'Config', 'Custom'] }],
  }]);
}

function extraction() {
  return {
    tables: [{
      sheet: '1 Requirements', headerRow: 1, firstDataRow: 2, lastDataRow: 3, tab: 'Functional', topic: null,
      columns: { id: 'A', topic: 'B', requirement: 'C', priority: 'D', compliance: 'E', comment: 'F', effort: 'G', assumptions: null },
    }],
    overrides: [], skip: [], items: [],
    projectInfo: [{ key: 'business-model', value: 'B2B wholesale', source: '1 Requirements r2' }],
  };
}

/** A temp host repo with the workbook imported and its digest built, exactly as the skill's
 * opening `intake` batch would leave it — no operator mapping step (contract §3). */
function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-owntabs-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  const source = path.join(root, 'specs', 'rfp-0301-mini.xlsx');
  fs.writeFileSync(source, workbook());
  importExportMain(['import', '--source', source, '--root', root]);
  const doc = path.join(root, 'specs', 'rfp-0301-mini-analysis.md');
  intake({ root, doc, source, extraction: extraction() });
  return { root, source, doc, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const j = async (url, p, body, method) => {
  const r = await fetch(url.replace(/\/$/, '') + p, body !== undefined
    ? { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : (method ? { method } : undefined));
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

test('import (no --map/--accept-proposed): writes a snapshot and digest, proposes a mapping, never writes per-table CSVs or a confirmed map', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-owntabs-importonly-'));
  try {
    fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
    const source = path.join(root, 'specs', 'rfp-0301-mini.xlsx');
    fs.writeFileSync(source, workbook());
    importExportMain(['import', '--source', source, '--root', root]);
    const dir = path.join(root, 'specs', '.editor', 'rfp-0301-mini');
    assert.ok(fs.existsSync(path.join(dir, 'import-snapshot.json')));
    assert.ok(fs.existsSync(path.join(dir, 'import-digest.md')));
    assert.ok(fs.existsSync(path.join(dir, 'import-map.proposed.json')));
    // The removed wizard/CSV path: `import` alone never confirms the mapping or writes any CSV —
    // only `intake` (called separately, once the extraction exists) writes the fit-back map.
    assert.ok(!fs.existsSync(path.join(root, 'specs', 'rfp-0301-mini', 'import-map.json')));
    assert.ok(!fs.existsSync(path.join(root, 'specs', 'rfp-0301-mini', '1 Requirements.csv')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('importSource (WP-3 export) is what Session.ensureImported calls for an xlsx/csv source with no analysis yet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-ensureimport-'));
  try {
    fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
    const source = path.join(root, 'specs', 'rfp-0302-mini.xlsx');
    fs.writeFileSync(source, workbook());
    const r = await importSource({ root, source });
    assert.ok(r.digestPath || r.digest || r.snapshot, JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(root, 'specs', '.editor', 'rfp-0302-mini', 'import-digest.md')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('intake builds a working document that confirms itself, with §4 grouped Functional · Accounts and a fit-back map', () => {
  const h = host();
  try {
    const model = parse(fs.readFileSync(h.doc, 'utf8'), { path: h.doc });
    assert.deepEqual(model.errors, []);
    // Own-tabs contract §3: the review gate is gone — intake confirms itself.
    assert.equal(model.frontmatter.data.intake, 'confirmed');
    assert.deepEqual(model.items.map(i => i.id), ['GEN-01', 'GEN-02']);
    assert.equal(model.items[0].tab, 'Functional');
    assert.equal(model.items[0].topic, 'Accounts');
    assert.equal(model.projectInfo.find(r => r.key === 'business-model').value, 'B2B wholesale');
    const fitBack = JSON.parse(fs.readFileSync(path.join(h.root, 'specs', 'rfp-0301-mini', 'import-map.json'), 'utf8'));
    assert.ok(fitBack.items['GEN-01'], 'the fit-back map records an export pointer for GEN-01');
    assert.match(fitBack.confirmedAt, /^\d{4}-\d{2}-\d{2}$/, 'intake sets confirmedAt itself, the same run');
  } finally { h.cleanup(); }
});

/** `host()` with its frontmatter forced back to `intake: review` — a document from before intake
 * confirmed itself, for the backward-compatibility tests below (own-tabs contract §3). */
function legacyReviewHost() {
  const h = host();
  fs.writeFileSync(h.doc, fs.readFileSync(h.doc, 'utf8').replace(/^intake: confirmed$/m, 'intake: review'));
  return h;
}

test('server: the own-tabs flow — session intake/fitBack fields, move, skip, restore, project-info patch, backward-compat confirm', { skip: !CAN_BIND && 'cannot bind 127.0.0.1 here' }, async (t) => {
  const h = host();
  const exit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: h.doc, port: 0, grace: 2, agentTimeout: 3, foreground: true, root: h.root });
  const url = session.url;
  const heartbeat = setInterval(() => { j(url, '/api/heartbeat', { tab: 'test' }).catch(() => {}); }, 300);
  t.after(async () => {
    clearInterval(heartbeat);
    try { session.shutdown('test over'); } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 400));
    process.exit = exit;
    h.cleanup();
  });

  // --- /api/session: intake + fitBack replace importState/sourceColumns; intake confirmed itself
  let r = await j(url, '/api/session');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!('importState' in r.body) && !('sourceColumns' in r.body));
  assert.equal(r.body.intake.state, 'confirmed');
  assert.equal(r.body.intake.notTaken, 0);
  assert.ok(r.body.fitBack, 'an xlsx source has a fit-back map');
  assert.ok(r.body.fitBack.tables.some(t => t.sheet === '1 Requirements'));

  // --- analyze is not refused: intake confirms itself, so the session already auto-queued it ----
  r = await j(url, '/api/lock');
  assert.equal(r.body.queue.length, 1, 'analyze auto-queued the moment the session opened the document');
  assert.equal(session.queue[0].kind, 'analyze');

  // --- move: keeps the id, changes the tab ------------------------------------------------------
  r = await j(url, '/api/item/GEN-01/move', { tab: 'Non-functional' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let model = parse(fs.readFileSync(h.doc, 'utf8'), { path: h.doc });
  assert.equal(model.items.find(i => i.id === 'GEN-01').tab, 'Non-functional');
  assert.equal(model.items.find(i => i.id === 'GEN-01').topic, 'Accounts', 'move keeps the topic when none is given');

  // move requires a tab
  r = await j(url, '/api/item/GEN-01/move', {});
  assert.equal(r.status, 400);

  // --- skip: allowed at any time (contract §3), removes the item into Not taken ------------------
  r = await j(url, '/api/item/GEN-02/skip', { why: 'duplicate of GEN-01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  model = parse(fs.readFileSync(h.doc, 'utf8'), { path: h.doc });
  assert.ok(!model.items.some(i => i.id === 'GEN-02'));
  assert.equal(model.notTaken.length, 1);
  const skippedSource = model.notTaken[0].source;

  // skip requires a reason
  r = await j(url, '/api/item/GEN-01/skip', {});
  assert.equal(r.status, 400);

  // --- restore: brings it back from Not taken ----------------------------------------------------
  r = await j(url, '/api/intake/restore', { source: skippedSource });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  model = parse(fs.readFileSync(h.doc, 'utf8'), { path: h.doc });
  assert.ok(model.items.some(i => i.id === 'GEN-02'));
  assert.equal(model.notTaken.length, 0);

  r = await j(url, '/api/intake/restore', {});
  assert.equal(r.status, 400);

  // --- project information: PATCH sets Value, Source becomes operator ----------------------------
  r = await j(url, '/api/project-info/business-model', { value: 'B2B wholesale, updated by the operator' }, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  model = parse(fs.readFileSync(h.doc, 'utf8'), { path: h.doc });
  const row = model.projectInfo.find(x => x.key === 'business-model');
  assert.equal(row.value, 'B2B wholesale, updated by the operator');
  assert.equal(row.source, 'operator');

  r = await j(url, '/api/project-info/business-model', {}, 'PATCH');
  assert.equal(r.status, 400);

  // --- backward compatibility: confirming an already-confirmed document is a harmless no-op ------
  r = await j(url, '/api/intake/confirm', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.already, true);
  const after = await j(url, '/api/session');
  assert.equal(after.body.intake.state, 'confirmed');
});

// --- opening intake, queued automatically (Session#maybeEnqueueIntake) ---------------------------

function xlsxOnlyHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-autointake-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  const source = path.join(root, 'specs', 'rfp-0304-mini.xlsx');
  fs.writeFileSync(source, workbook());
  return { root, source, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Session: opening an xlsx source with no analysis yet queues exactly one intake batch', async () => {
  const h = xlsxOnlyHost();
  try {
    const session = new Session({ root: h.root, doc: h.source, grace: 60, agentTimeout: 60 });
    await session.importReady;
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0].kind, 'intake');
    assert.match(session.queue[0].id, /^i-/);
  } finally { h.cleanup(); }
});

test('Session: reattaching (a fresh instance over the same session dir) does not queue a second intake batch', async () => {
  const h = xlsxOnlyHost();
  try {
    const first = new Session({ root: h.root, doc: h.source, grace: 60, agentTimeout: 60 });
    await first.importReady;
    assert.equal(first.queue.length, 1);
    const second = new Session({ root: h.root, doc: h.source, grace: 60, agentTimeout: 60 });
    await second.importReady;
    assert.equal(second.queue.length, 1, 'reattach must not add a second intake batch');
  } finally { h.cleanup(); }
});

test('Session: with an existing (confirmed) analysis, opening the session queues no intake batch — but auto-queues analyze since the items are still queued', async () => {
  const h = host();
  try {
    const session = new Session({ root: h.root, doc: h.doc, grace: 60, agentTimeout: 60 });
    await session.importReady;
    assert.ok(!session.queue.some(b => b.kind === 'intake'), 'no intake batch for an existing analysis');
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0].kind, 'analyze');
  } finally { h.cleanup(); }
});

test('Session: --no-intake (opts.intake === false) queues nothing', async () => {
  const h = xlsxOnlyHost();
  try {
    const session = new Session({ root: h.root, doc: h.source, grace: 60, agentTimeout: 60, intake: false });
    await session.importReady;
    assert.equal(session.queue.length, 0);
  } finally { h.cleanup(); }
});

// --- backward compatibility: an old document still at `intake: review` (own-tabs contract §3) ---

test('Session: opening a session on an old document still at intake: review auto-confirms it and auto-queues one analyze batch', async () => {
  const h = legacyReviewHost();
  try {
    const session = new Session({ root: h.root, doc: h.doc, grace: 60, agentTimeout: 60 });
    await session.importReady;
    assert.equal(session.model.frontmatter.data.intake, 'confirmed', 'the session auto-confirms an old review document on open');
    assert.equal(session.queue.length, 1, 'no document is left stuck: analyze auto-queues itself');
    assert.equal(session.queue[0].kind, 'analyze');
  } finally { h.cleanup(); }
});

test('Session: intakeConfirm (ops.mjs) is a harmless no-op once intake is already confirmed', async () => {
  const h = host();
  try {
    const session = new Session({ root: h.root, doc: h.doc, grace: 60, agentTimeout: 60 });
    await session.importReady;
    assert.equal(session.queue.length, 1, 'analyze already auto-queued the moment the session opened the document');
    const r = session.directWrite({ type: 'intakeConfirm' });
    assert.equal(r.body.ok, true, JSON.stringify(r));
    assert.equal(r.body.already, true);
    assert.equal(session.queue.length, 1, 'no second analyze batch from the harmless confirm');
  } finally { h.cleanup(); }
});
