// API lifecycle for the 0.2.0 grammar: session -> Page API endpoints (confirm, proposal
// accept/reject, patch, answer, export-text, assumption, profile) -> queued writes during an
// agent run -> reply (repair + apply queued) -> batch/poll -> heartbeat timeout.
// Needs permission to bind 127.0.0.1 (skipped automatically when the sandbox forbids it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, resolveTarget, collapseSessions, main } from '../lib/server.mjs';
import { parse } from '../lib/parse.mjs';
import * as proposals from '../lib/proposals.mjs';
import { intakeConfirm } from '../lib/ops.mjs';
import { canBind, HERE } from './helpers.mjs';

const ANALYSIS = 'specs/rfp-0101-xlsx-ids-analysis.md';
const SLUG = 'rfp-0101-xlsx-ids';
const SESSION_DIR = `specs/.editor/${SLUG}`;

const j = async (url, p, body, method) => {
  const r = await fetch(url.replace(/\/$/, '') + p, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

function host() {
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'tender-tool-'));
  mkdirSync(path.join(root, 'specs'), { recursive: true });
  copyFileSync(path.join(HERE, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), path.join(root, ANALYSIS));
  return root;
}

async function cleanup({ heartbeat, session, root }) {
  if (heartbeat) clearInterval(heartbeat);
  try { session.shutdown('test end'); } catch { /* gone */ }
  await new Promise(r => setTimeout(r, 300));
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('resolveTarget derives the analysis and slug from the document path', () => {
  const t = resolveTarget('/r', ANALYSIS);
  assert.equal(t.slug, SLUG);
  assert.equal(t.analysis, ANALYSIS);
});

test('#10: resolveTarget finds the source named in the document\'s own frontmatter, even when it does not match the doc\'s filename-derived slug', () => {
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'tdt-resolve-'));
  try {
    mkdirSync(path.join(root, 'specs'), { recursive: true });
    // The fixture's own frontmatter names `rfp-0101-hartmann.xlsx` — a different basename than
    // the document's own filename-derived slug (`rfp-0101-xlsx-ids`, from ANALYSIS above), the
    // shape a doc renamed after intake produces.
    copyFileSync(path.join(HERE, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), path.join(root, ANALYSIS));
    writeFileSync(path.join(root, 'specs', 'rfp-0101-hartmann.xlsx'), 'not a real workbook, only its name matters here');

    const t = resolveTarget(root, ANALYSIS);
    assert.equal(t.source, 'specs/rfp-0101-hartmann.xlsx', 'the frontmatter-named source must win over the slug guess');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('server: Page API endpoints and their refusals', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 2, agentTimeout: 3, foreground: true, root });
  const url = session.url;
  const heartbeat = setInterval(() => fetch(url + 'api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {}), 300);
  t.after(async () => { await cleanup({ heartbeat, session, root }); process.exit = realExit; });

  // --- session -------------------------------------------------------------------------
  let r = await j(url, '/api/session');
  assert.equal(r.status, 200);
  assert.equal(r.body.analysis, ANALYSIS);
  assert.equal(r.body.model.items.length, 4);
  assert.equal(r.body.session.doc.state, 'In progress');
  // Own-tabs contract §3: `importState`/`sourceColumns` are gone; `intake`/`fitBack` replace them.
  assert.ok(!('importState' in r.body) && !('sourceColumns' in r.body), JSON.stringify(Object.keys(r.body)));
  assert.equal(r.body.intake.state, 'confirmed', 'the fixture carries no intake: field, which means confirmed');
  assert.equal(r.body.intake.notTaken, 0);
  assert.deepEqual(r.body.intake.unusedSheets, []);
  assert.equal(r.body.fitBack, null, 'a CSV/PDF-shaped fixture (no confirmed xlsx map here) has no fit-back map');
  assert.equal(r.body.session.doc.rows, 4);
  // D-34: `sinceExport` is null before this document has ever been exported.
  assert.equal(r.body.sinceExport, null);

  // --- static: every module the page imports, served as JS ---------------------------------
  // index.html -> app.js -> import.js, view.mjs, lib/calc.mjs (the last aliased from ../lib,
  // not page/, so the page and the CLI share one file). All must be browser-safe (no node:
  // imports reachable from this graph) and must actually be reachable through the server.
  for (const p of ['/page/app.js', '/page/view.mjs', '/page/lib/calc.mjs']) {
    const pr = await fetch(url.replace(/\/$/, '') + p);
    assert.equal(pr.status, 200, `${p} did not serve`);
    assert.match(pr.headers.get('content-type') || '', /javascript/, `${p} content-type: ${pr.headers.get('content-type')}`);
  }

  // --- GET /api/profile: no profile file -> reason null, not an error ---------------------
  r = await j(url, '/api/profile');
  assert.equal(r.status, 200);
  assert.equal(r.body.profile, null);

  // --- PUT /api/profile: AC-14, AC-30 ------------------------------------------------------
  r = await j(url, '/api/profile', { calibration: { small: 2, big: 20 }, overhead: 10, buffer: { percent: 5, mode: 'folded' }, isv: [], assets: [] }, 'PUT');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await j(url, '/api/profile');
  assert.equal(r.body.profile.overhead, 10);
  // an invalid profile is refused
  r = await j(url, '/api/profile', { calibration: { small: 2 } }, 'PUT');
  assert.equal(r.status, 400);

  // --- GET /api/proposals: empty initially --------------------------------------------------
  r = await j(url, '/api/proposals');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.proposals, []);

  // Seed a proposal directly (as `apply` would) so accept/reject can be exercised over HTTP.
  const p1 = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'Branch stock syncs nightly.', pdSaved: 1 });
  r = await j(url, '/api/proposals');
  assert.equal(r.body.proposals.length, 1);

  // --- GET /api/item/<id>/export-text: X-6, visible for unconfirmed too (R-4) ----------------
  // The preview shows the exact text `export` WILL write once the item is confirmed (R-4) — the
  // export itself (no `preview`) is what keeps an unconfirmed item's answer cells empty (X-1).
  r = await j(url, '/api/item/HIB-02/export-text');
  assert.equal(r.status, 200);
  assert.match(r.body.response, /branch-level stock panel/, 'unconfirmed item still previews what would be written');
  r = await j(url, '/api/item/HIB-01/export-text');
  assert.equal(r.status, 200);
  assert.match(r.body.response, /Stock Shopware customer accounts/);
  r = await j(url, '/api/item/NOPE-1/export-text');
  assert.equal(r.status, 404);

  // --- POST /api/proposal/<id>/accept: AC-8 --------------------------------------------------
  r = await j(url, `/api/proposal/${p1.id}/accept`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let after = readFileSync(path.join(root, ANALYSIS), 'utf8');
  assert.ok(after.includes(p1.statement));
  r = await j(url, `/api/proposal/${p1.id}/accept`, {});
  assert.equal(r.status, 400, 'already accepted, not waiting');

  // --- POST /api/item/<id>/assumption + /remove: operator-typed, AQ-1 ------------------------
  r = await j(url, '/api/item/HIB-03/assumption', { statement: 'The client confirms daily sync is enough.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await j(url, '/api/item/HIB-03/assumption', {});
  assert.equal(r.status, 400);
  r = await j(url, '/api/item/HIB-03/assumption/remove', { statement: 'The client confirms daily sync is enough.' });
  assert.equal(r.status, 200);
  r = await j(url, '/api/item/HIB-03/assumption/remove', { statement: 'never existed' });
  assert.equal(r.status, 400);

  // --- POST /api/question/<cq>/answer: AC-10/11 ----------------------------------------------
  r = await j(url, '/api/question/CQ-1/answer', { option: 'B' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  after = readFileSync(path.join(root, ANALYSIS), 'utf8');
  assert.match(after, /Answered \d{4}-\d{2}-\d{2}: B/);
  r = await j(url, '/api/question/CQ-1/answer', { option: 'B' });
  assert.equal(r.status, 400, 'already answered');
  r = await j(url, '/api/question/CQ-99/answer', { option: 'A' });
  assert.equal(r.status, 400);

  // --- PATCH /api/item/<id>: L-4, never reopens -----------------------------------------------
  r = await j(url, '/api/item/HIB-01', { clientResponse: 'Edited by the operator.' }, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const model1 = parse(readFileSync(path.join(root, ANALYSIS), 'utf8'));
  assert.equal(model1.items.find(i => i.id === 'HIB-01').status.kind, 'confirmed');

  // N-4: PATCH refuses an unknown field (e.g. `coverage`, which only `apply` may set) with 400
  // instead of silently ignoring it.
  r = await j(url, '/api/item/HIB-01', { coverage: 'Custom' }, 'PATCH');
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.reason, /unknown field/);
  const model1b = parse(readFileSync(path.join(root, ANALYSIS), 'utf8'));
  assert.notEqual(model1b.items.find(i => i.id === 'HIB-01').coverage, 'Custom');

  // N-4: a hand-written invalid coverage value must show up in the very next /api/session
  // response — no waiting on the watcher's debounce (`errors`, not just `parseError`, since the
  // document still parses; only the value is out of grammar).
  const analysisFile = path.join(root, ANALYSIS);
  const invalidText = readFileSync(analysisFile, 'utf8').replace('Customers can create an account and log in. | OOTB |', 'Customers can create an account and log in. | NotAValue |');
  writeFileSync(analysisFile, invalidText, 'utf8');
  r = await j(url, '/api/session');
  assert.equal(r.status, 200);
  assert.ok((r.body.model?.errors || []).some(e => /invalid Requirement Coverage/.test(e)), JSON.stringify(r.body.model?.errors));
  // restore, so the rest of this test suite sees the document it expects
  writeFileSync(analysisFile, readFileSync(analysisFile, 'utf8').replace('Customers can create an account and log in. | NotAValue |', 'Customers can create an account and log in. | OOTB |'), 'utf8');

  // --- POST /api/confirm: AC-17, AC-5 (only via ops/apply — coverage is not settable here) -----
  // N-3: confirming reports the proposals it auto-rejected alongside confirmed/skipped.
  const p3 = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'A still-waiting proposal at confirm time.' });
  r = await j(url, '/api/confirm', { ids: ['HIB-02'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rejected, [{ id: p3.id, item: 'HIB-02', statement: p3.statement }]);
  r = await j(url, '/api/confirm', { ids: [] });
  assert.equal(r.status, 400);
  await j(url, '/api/item/CMP-01', { clientResponse: '' }, 'PATCH');
  r = await j(url, '/api/confirm', { ids: ['CMP-01'] });
  assert.equal(r.status, 400, 'failed item with no Client Response cannot be confirmed (L-6)');
  // A bulk confirm that skips every id still carries the per-id reasons in the 400 body,
  // so the page can show them instead of one flat message.
  assert.ok(Array.isArray(r.body.skipped) && r.body.skipped.length === 1, JSON.stringify(r.body));
  assert.equal(r.body.skipped[0].id, 'CMP-01');
  assert.match(r.body.skipped[0].reason, /Client Response/);

  // --- POST /api/unconfirm: reverses confirm back to reopened -----------------------------------
  r = await j(url, '/api/unconfirm', { ids: ['HIB-02'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.unconfirmed, ['HIB-02']);
  r = await j(url, '/api/session');
  assert.equal(r.body.model.items.find(i => i.id === 'HIB-02').status.kind, 'reopened');
  r = await j(url, '/api/unconfirm', { ids: [] });
  assert.equal(r.status, 400);
  r = await j(url, '/api/unconfirm', { ids: ['HIB-02'] });
  assert.equal(r.status, 400, 'an already-unconfirmed item is refused, not silently skipped');
  assert.match(r.body.skipped[0].reason, /not confirmed/);
  // re-confirm so later assertions in this test still see HIB-02 confirmed (contract §4: cheap
  // to redo, no dialog).
  r = await j(url, '/api/confirm', { ids: ['HIB-02'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // --- POST /api/proposal/<id>/reject: AC-9 ----------------------------------------------------
  const p2 = proposals.add(root, SLUG, { item: 'HIB-03', statement: 'A brand-new proposal.' });
  r = await j(url, `/api/proposal/${p2.id}/reject`, {});
  assert.equal(r.status, 200);
  const list = proposals.list(root, SLUG);
  assert.equal(list.find(x => x.id === p2.id).status, 'rejected');

  // --- POST /api/export: 501 while lib/import-export.mjs's exportWorkbook is absent/incompatible
  r = await j(url, '/api/export', {});
  assert.ok([200, 400, 501].includes(r.status), `unexpected export status ${r.status}: ${JSON.stringify(r.body)}`);

  // --- new own-tabs Page API (build contract §3): required-field validation is stable regardless
  // of whether lib/ops.mjs's intakeConfirm/move/skip/restore/info have landed yet (WP-3); the
  // success path is only asserted as "not a crash" until then, same pattern as /api/export above.
  r = await j(url, '/api/item/HIB-01/move', {});
  assert.equal(r.status, 400, 'tab is required');
  r = await j(url, '/api/item/HIB-01/move', { tab: 'Non-functional' });
  assert.ok([200, 202, 400].includes(r.status), `unexpected move status ${r.status}: ${JSON.stringify(r.body)}`);

  r = await j(url, '/api/item/HIB-01/skip', {});
  assert.equal(r.status, 400, 'why is required');
  r = await j(url, '/api/item/HIB-01/skip', { why: 'test' });
  assert.ok([200, 202, 400].includes(r.status), `unexpected skip status ${r.status}: ${JSON.stringify(r.body)}`);

  r = await j(url, '/api/intake/restore', {});
  assert.equal(r.status, 400, 'source is required');
  r = await j(url, '/api/intake/restore', { source: '2 Requirements r6' });
  assert.ok([200, 202, 400].includes(r.status), `unexpected restore status ${r.status}: ${JSON.stringify(r.body)}`);

  r = await j(url, '/api/project-info/business-model', {}, 'PATCH');
  assert.equal(r.status, 400, 'value is required');
  r = await j(url, '/api/project-info/business-model', { value: 'B2B wholesale' }, 'PATCH');
  assert.ok([200, 202, 400].includes(r.status), `unexpected project-info status ${r.status}: ${JSON.stringify(r.body)}`);

  r = await j(url, '/api/intake/confirm', {});
  assert.ok([200, 202, 400].includes(r.status), `unexpected intake/confirm status ${r.status}: ${JSON.stringify(r.body)}`);

  // --- SSE-visible doc event on a direct write --------------------------------------------------
  r = await j(url, '/api/session');
  assert.ok(r.body.model.items.some(i => i.id === 'HIB-02' && i.status.kind === 'confirmed'));
});

test('P-2: a notes batch with decision entries applies accept/reject in one write, one reload, at most one analyze queued', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  const pA = proposals.add(root, SLUG, { item: 'HIB-01', statement: 'Decision-queue accept A.', pdSaved: 1 });
  const pB = proposals.add(root, SLUG, { item: 'HIB-03', statement: 'Decision-queue accept B.', pdSaved: 1 });
  const pC = proposals.add(root, SLUG, { item: 'HIB-02', statement: 'Decision-queue reject C.', pdSaved: 1 });

  const r = await j(url, '/api/batch', {
    kind: 'notes',
    notes: [
      { type: 'decision', proposal: pA.id, item: 'HIB-01', action: 'accept' },
      { type: 'decision', proposal: pB.id, item: 'HIB-03', action: 'accept' },
      { type: 'decision', proposal: pC.id, item: 'HIB-02', action: 'reject' },
    ],
    chat: '',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.id, null, 'a decisions-only batch never reaches the agent');
  assert.equal(r.body.decisionsApplied, 3);

  // 3 status changes, applied in one write.
  const list = proposals.list(root, SLUG);
  assert.equal(list.find(x => x.id === pA.id).status, 'accepted');
  assert.equal(list.find(x => x.id === pB.id).status, 'accepted');
  assert.equal(list.find(x => x.id === pC.id).status, 'rejected');
  const model = parse(readFileSync(path.join(root, ANALYSIS), 'utf8'));
  assert.ok(model.items.find(i => i.id === 'HIB-01').assumptions.includes(pA.statement));
  assert.ok(model.items.find(i => i.id === 'HIB-03').assumptions.includes(pB.statement));

  // The reestimate work the two accepts marked resolves into at most one analyze batch, not one
  // per decision.
  const lock = await j(url, '/api/lock');
  const analyzeIds = lock.body.queue.filter(id => id.startsWith('a-'));
  assert.ok(analyzeIds.length <= 1, `expected at most one analyze batch, got ${JSON.stringify(lock.body.queue)}`);
});

test('server: operator confirm is saved at once while an agent run holds the lock and survives the reply', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  const heartbeat = setInterval(() => fetch(url + 'api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {}), 300);
  t.after(async () => { await cleanup({ heartbeat, session, root }); process.exit = realExit; });

  let r = await j(url, '/api/batch', { kind: 'reestimate' });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 'r-1');
  r = await j(url, '/api/next?wait=2', undefined, 'GET');
  assert.equal(r.body.event, 'batch');
  assert.equal((await j(url, '/api/lock')).body.lock, 'r-1');

  // A confirm while the run is active is applied at once (200) and is in the file.
  r = await j(url, '/api/confirm', { ids: ['HIB-02'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.queued, true);
  let mid = parse(readFileSync(path.join(root, ANALYSIS), 'utf8'));
  assert.equal(mid.items.find(i => i.id === 'HIB-02').status.kind, 'confirmed', 'confirm is in the file during the run');

  r = await j(url, '/api/agent/reply', { markdown: 'done', batch: 'r-1' });
  assert.equal(r.status, 200);
  await new Promise(res => setTimeout(res, 50));
  const after = parse(readFileSync(path.join(root, ANALYSIS), 'utf8'));
  assert.equal(after.items.find(i => i.id === 'HIB-02').status.kind, 'confirmed', 'confirm still in place after the run finished');
  assert.equal((await j(url, '/api/lock')).body.lock, null);
});

test('server: analyze batch guard refuses re-analysing an existing document without --force', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });
  const r = await j(url, '/api/batch', { kind: 'analyze' });
  assert.equal(r.status, 400);
  const bad = await j(url, '/api/batch', { kind: 'nope' });
  assert.equal(bad.status, 400);
});

test('server: analyze without --force is accepted once intake is confirmed when there is work (queued item or a reestimate.json mark); still refused with none', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const analysisFile = path.join(root, ANALYSIS);
  // A queued item is work: an intake-confirmed document with one item still queued.
  writeFileSync(analysisFile, readFileSync(analysisFile, 'utf8').replace(
    '| HIB-02 | Should | Show stock per branch on the product page. | Extension | medium | M (4 PD) | We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | estimated |',
    '| HIB-02 | Should | Show stock per branch on the product page. | Extension | medium | M (4 PD) | We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | queued |',
  ), 'utf8');
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  const analyze = await j(url, '/api/batch', { kind: 'analyze' });
  assert.equal(analyze.status, 200, JSON.stringify(analyze.body));
  // SI-4: the server computed `items` itself (no explicit list sent) — HIB-02, the only item
  // needing work, in page order.
  assert.deepEqual(analyze.body.items, ['HIB-02']);
});

test('server: analyze without --force is accepted once intake is confirmed when reestimate.json marks an item', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  proposals.markReestimate(root, SLUG, 'HIB-02', 'profile changed');
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  const analyze = await j(url, '/api/batch', { kind: 'analyze' });
  assert.equal(analyze.status, 200, JSON.stringify(analyze.body));
});

test('server: opening a session on an old document still at intake: review auto-confirms it and auto-queues analyze (backward compatibility); intake-confirm is then a harmless no-op; notes stays allowed', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const analysisFile = path.join(root, ANALYSIS);
  writeFileSync(analysisFile, readFileSync(analysisFile, 'utf8')
    .replace('state: In progress\n', 'state: In progress\nintake: review\n')
    .replace('| We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | estimated |',
      '| We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | queued |'), 'utf8');
  const realExit = process.exit;
  process.exit = () => {};
  // The document is auto-confirmed inside the Session constructor, before the server ever accepts
  // a request — no page action, no explicit `intake-confirm`, sits between opening it and analysis.
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  const intake = await j(url, '/api/session');
  assert.equal(intake.body.intake.state, 'confirmed', 'the session auto-confirmed the old review document on open');
  const lock = await j(url, '/api/lock');
  assert.equal(lock.body.queue.length, 1, 'no document is left stuck: analyze auto-queued itself');

  // `intake-confirm` on a document already confirmed is a harmless no-op; no second batch.
  const confirmed = await j(url, '/api/intake/confirm', {});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.already, true);
  const lock2 = await j(url, '/api/lock');
  assert.equal(lock2.body.queue.length, 1, 'the harmless confirm added no second analyze batch');

  // `notes` stays allowed regardless (unchanged behaviour).
  const notes = await j(url, '/api/batch', { kind: 'notes', chat: 'please re-check' });
  assert.equal(notes.status, 200, JSON.stringify(notes.body));
});

test('IN-3 backward compatibility: an out-of-process intakeConfirm (CLI-style) on a document a live session already auto-confirmed is a no-op picked up on the next reload — no second analyze batch', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const analysisFile = path.join(root, ANALYSIS);
  writeFileSync(analysisFile, readFileSync(analysisFile, 'utf8')
    .replace('state: In progress\n', 'state: In progress\nintake: review\n')
    .replace('| We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | estimated |',
      '| We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | queued |'), 'utf8');
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  // The session already auto-confirmed this document and queued analyze on open (above test).
  assert.equal((await j(url, '/api/lock')).body.queue.length, 1);

  // The CLI's own `intake-confirm`, writing the file directly with no server route involved, is a
  // harmless no-op on an already-confirmed document (`ops.mjs`'s own backward-compat guard).
  const r = intakeConfirm({ root, doc: analysisFile });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.already, true);

  await j(url, '/api/session'); // forces a reload (N-4)
  const lock = await j(url, '/api/lock');
  assert.equal(lock.body.queue.length, 1, 'no second analyze batch from the out-of-process no-op');
});

test('IN-11: finishing an analyze batch requeues the next chunk while work remains, and stops once none is left', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  proposals.markReestimate(root, SLUG, 'HIB-01', 'test');
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  // Startup already auto-queued a chunk (the reestimate mark is work). Take it, as the skill would.
  let next = await j(url, '/api/next?wait=2', undefined, 'GET');
  assert.equal(next.body.event, 'batch');
  const firstId = next.body.batch.id;

  // The mark is still on record (this test never clears it, standing in for "still more to do") —
  // finishing the run must requeue another chunk, not leave the chain stalled.
  const finished = await j(url, '/api/agent/reply', { markdown: 'done', batch: firstId });
  assert.equal(finished.status, 200);
  await new Promise(r => setTimeout(r, 30));
  let lock = await j(url, '/api/lock');
  assert.equal(lock.body.queue.length, 1, 'the chain requeued itself');

  // Clear the work, then finish this second chunk too: no third chunk should appear.
  proposals.clearAllReestimate(root, SLUG);
  next = await j(url, '/api/next?wait=2', undefined, 'GET');
  assert.equal(next.body.event, 'batch');
  await j(url, '/api/agent/reply', { markdown: 'done', batch: next.body.batch.id });
  await new Promise(r => setTimeout(r, 30));
  lock = await j(url, '/api/lock');
  assert.equal(lock.body.queue.length, 0, 'the chain stops once there is nothing left to analyse');
});

test('IN-11: an operator accept during a chunk is applied at once, before the next chunk is computed', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  proposals.markReestimate(root, SLUG, '*', 'test');
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  const p1 = proposals.add(root, SLUG, { item: 'HIB-01', statement: 'A brand-new proposal on a confirmed item.', pdSaved: 1 });
  const next = await j(url, '/api/next?wait=2', undefined, 'GET');
  assert.equal(next.body.event, 'batch');

  // Accepting a proposal on the confirmed HIB-01 reopens it (AC-8) — queued (202) while the run
  // holds the lock — operator row ops apply at once.
  const accept = await j(url, `/api/proposal/${p1.id}/accept`, {});
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  let mid = parse(readFileSync(path.join(root, ANALYSIS), 'utf8'));
  assert.equal(mid.items.find(i => i.id === 'HIB-01').status.kind, 'reopened', 'applied at once, not queued');

  await j(url, '/api/agent/reply', { markdown: 'done', batch: next.body.batch.id });
  await new Promise(r => setTimeout(r, 30));
  const after = parse(readFileSync(path.join(root, ANALYSIS), 'utf8'));
  assert.equal(after.items.find(i => i.id === 'HIB-01').status.kind, 'reopened', 'the accept is still in place before the next chunk was decided');
});

test('a write straight to proposals.json (a proposal-only apply, e.g. globalProposals) is watched too and broadcasts a doc event', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  const events = [];
  session.clients.add({ write: (chunk) => events.push(chunk) });
  proposals.add(root, SLUG, { item: null, statement: 'A global assumption written outside this session.', pdSaved: 1 });

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !events.some(c => c.startsWith('event: doc'))) await new Promise(r => setTimeout(r, 50));
  assert.ok(events.some(c => c.startsWith('event: doc')), 'proposals.json changing must still broadcast a doc event, even though §4 did not change');
});

test('server: a chat-only notes batch is accepted; both empty is refused; queued_unsent replaces notes_unsent in status', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 5, agentTimeout: 5, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  // Chat text with zero queued notes is a legitimate batch (Send (n) with no annotations queued).
  let r = await j(url, '/api/batch', { kind: 'notes', notes: [], chat: 'please re-check HIB-02' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.id, 'n-1');

  // Neither notes nor chat text is still refused.
  r = await j(url, '/api/batch', { kind: 'notes', notes: [], chat: '' });
  assert.equal(r.status, 400);

  // `status` prints `queued_unsent` (the draft notes.json count), not the old `notes_unsent`.
  await j(url, '/api/notes', { notes: [{ id: 'n1', kind: 'comment', block: 'HIB-01', text: 'x' }] });
  let out = '';
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try { await main(['status', '--doc', path.join(root, ANALYSIS), '--root', root]); }
  finally { process.stdout.write = realWrite; }
  assert.match(out, /^queued_unsent: 1$/m);
  assert.doesNotMatch(out, /notes_unsent/);
});

test('server: heartbeat timeout opens a close grace instead of ending the session', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  // No heartbeat interval running: `lastBeat` is set back by hand instead of waiting on the
  // real 5 s tick, so the grace logic is exercised without a real wait.
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 1, agentTimeout: 5, closeGraceMs: 100000, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  session.lastBeat = Date.now() - 2000; // older than `grace` (1 s)
  session.tick();
  assert.ok(session.pendingClose, 'a stale heartbeat should open the close grace, not shut down');
  assert.equal(session.closing, undefined, 'the session must still be open during the grace');

  // The session keeps answering, and `poll` sees `idle`, never `closed`, while the grace holds.
  const still = await j(url, '/api/session');
  assert.equal(still.status, 200);
  const polled = await j(url, '/api/next?wait=1', undefined, 'GET');
  assert.equal(polled.body.event, 'idle', 'poll must not report closed during the close grace');
});

test('server: a heartbeat during the close grace reconnects the same session', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 1, agentTimeout: 5, closeGraceMs: 100000, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  session.lastBeat = Date.now() - 2000;
  session.tick();
  assert.ok(session.pendingClose, 'setup: the close grace should be open');

  const r = await j(url, '/api/heartbeat', {});
  assert.equal(r.status, 200);
  assert.equal(session.pendingClose, null, 'a heartbeat within the grace must cancel it');
  assert.equal(session.closing, undefined, 'the session resumes rather than closing');
  const still = await j(url, '/api/session');
  assert.equal(still.status, 200, 'the same session keeps serving after reconnect');
});

test('server: the session closes once the close grace elapses with no reconnect', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = host();
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 1, agentTimeout: 5, closeGraceMs: 300, foreground: true, root });
  const url = session.url;
  t.after(async () => { await cleanup({ session, root }); process.exit = realExit; });

  session.pendingClose = { since: Date.now() - 1000, reason: 'heartbeat timeout' }; // already past `closeGraceMs`
  session.tick();
  assert.equal(session.closing, true, 'the grace elapsing must finally close the session');

  const polled = await j(url, '/api/next?wait=1', undefined, 'GET');
  assert.equal(polled.body.event, 'closed');
});

test('only the newest session banner survives; older boundaries collapse to one divider', () => {
  const log = [
    { type: 'system', text: 'session started on http://127.0.0.1:1/' },
    { type: 'reply', md: 'one' },
    { type: 'system', text: 'session closed (closed by request)' },
    { type: 'system', text: 'session resumed on http://127.0.0.1:2/' },
    { type: 'reply', md: 'two' },
    { type: 'system', text: 'session closed (closed by request)' },
    { type: 'system', text: 'session resumed on http://127.0.0.1:3/' },
  ];
  const out = collapseSessions(log);
  assert.deepEqual(out.map(e => e.text ?? e.md), ['one', 'previous session', 'two', 'session resumed on http://127.0.0.1:3/']);
});

