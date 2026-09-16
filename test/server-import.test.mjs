// The steering screen's server side: the import state the page renders, the draft it saves, and
// what confirming does — write the normalised CSVs, commit the mapping, re-read the client
// columns, and hand the agent one ordinary batch (`kind: batch`, `stage: import`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../lib/server.mjs';
import { buildWorkbook } from './helpers/mkxlsx.mjs';
import { canBind, CLI } from './helpers.mjs';

const SLUG = 'rfp-0099-mini';

const HEADER = ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)'];
function workbook() {
  return buildWorkbook([
    {
      name: '1 Requirements',
      rows: [HEADER, ['GEN-01', 'Shop', 'Customer accounts', 'Must', '', '', ''], ['GEN-02', 'Shop', 'Tiered prices', 'Should', '', '', '']],
      validations: [{ sqref: 'D2:D3', values: ['Must', 'Should', 'Could'] }, { sqref: 'E2:E3', values: ['Stock', 'Custom'] }],
    },
    { name: '2 Glossary', rows: [['Term', 'Meaning'], ['SKU', 'Stock keeping unit']] },
    { name: '_answer_key', state: 'hidden', rows: [['ID', 'Expected'], ['GEN-01', 'Custom']] },
  ]);
}

/** A temp host repo with the workbook imported, exactly as the skill would leave it. */
function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-imp-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  const source = path.join(root, 'specs', `${SLUG}.xlsx`);
  fs.writeFileSync(source, workbook());
  execFileSync(process.execPath, [CLI, 'import', '--source', source, '--root', root], { stdio: 'pipe' });
  return { root, source, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const j = async (url, p, body, method) => {
  const r = await fetch(url.replace(/\/$/, '') + p, body
    ? { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: r.status, body: await r.json() };
};

test('import steering: state, draft, confirm, batch', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 here' }, async (t) => {
  const h = host();
  const exit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: h.source, port: 0, grace: 1, agentTimeout: 3, foreground: true, child: false, root: h.root });
  const url = session.url || `http://127.0.0.1:${session.port}/`;
  // The page beats every 5 s; without one the server exits after `grace`, so the test beats too.
  const heartbeat = setInterval(() => { j(url, '/api/heartbeat', { tab: 'test' }).catch(() => {}); }, 300);
  t.after(async () => {
    clearInterval(heartbeat);
    try { session.shutdown('test over'); } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 400));
    process.exit = exit;
    h.cleanup();
  });

  // The page sees the workbook, its sheets and a proposed mapping — but nothing is confirmed yet.
  const first = await j(url, '/api/session');
  const im = first.body.importState;
  assert.ok(im?.available, 'importState is served');
  assert.equal(im.confirmedAt, null);
  assert.equal(im.stale, false);
  assert.equal(im.sheets.length, 3);
  assert.equal(im.sheets[2].state, 'hidden');
  assert.deepEqual(im.sheets[0].preview[0], HEADER);
  const req = im.map.tables.filter(x => x.role === 'requirements');
  assert.equal(req.length, 1);
  assert.equal(req[0].columns.compliance, 'E');
  assert.deepEqual(im.map.ignored.map(x => x.sheet), ['_answer_key']);

  // One sheet's full grid, for "show every row".
  const sheet = await j(url, '/api/import/sheet/1');
  assert.equal(sheet.status, 200);
  assert.equal(sheet.body.sheet.name, '1 Requirements');
  assert.equal(sheet.body.sheet.rows.length, 3);
  assert.equal((await j(url, '/api/import/sheet/99')).status, 404);

  // Saving a draft persists it and does not write any CSV.
  const edited = JSON.parse(JSON.stringify(im.map));
  edited.tables.find(x => x.sheet === '2 Glossary').role = 'ignored';
  const saved = await j(url, '/api/import/map', { map: edited, tab: 'test' });
  assert.equal(saved.status, 200);
  assert.equal(fs.existsSync(path.join(h.root, 'specs', SLUG)), false, 'no CSV before confirmation');
  const draft = JSON.parse(fs.readFileSync(path.join(h.root, 'specs', '.editor', SLUG, 'import-map.json'), 'utf8'));
  assert.equal(draft.tables.find(x => x.sheet === '2 Glossary').role, 'ignored');

  // A mapping the tool cannot use is refused with the reasons, and still writes nothing.
  const broken = JSON.parse(JSON.stringify(edited));
  broken.tables.find(x => x.role === 'requirements').columns.id = null;
  const bad = await j(url, '/api/import/confirm', { map: broken });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.problems.some(p => /no id column/.test(p)));
  assert.equal(fs.existsSync(path.join(h.root, 'specs', SLUG)), false);

  // Confirming writes the CSVs, commits the mapping and refreshes the client columns.
  const ok = await j(url, '/api/import/confirm', { map: edited });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.written.map(w => w.file), ['01-requirements.csv']);
  const outDir = path.join(h.root, 'specs', SLUG);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['01-requirements.csv', 'import-map.json']);
  const csv = fs.readFileSync(path.join(outDir, '01-requirements.csv'), 'utf8');
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('GEN-01,Shop,Customer accounts,Must'));
  assert.ok(!csv.includes('Stock keeping unit'), 'an ignored sheet is never written');

  const after = await j(url, '/api/session');
  assert.equal(after.body.sourceColumns.fromMap, true);
  assert.deepEqual(after.body.sourceColumns.columns.map(c => c.key), ['Area', 'Requirement', 'Priority']);
  assert.deepEqual(Object.keys(after.body.sourceColumns.byId), ['GEN-01', 'GEN-02']);
  assert.ok(after.body.importState.confirmedAt);

  // The agent is handed one ordinary batch; no new kind, no new protocol.
  const next = await fetch(url.replace(/\/$/, '') + '/api/next?wait=1');
  const batch = await next.json();
  assert.equal(batch.event, 'batch');
  assert.equal(batch.batch.kind, 'batch');
  assert.equal(batch.batch.stage, 'import');
  assert.equal(batch.batch.importMap, `specs/${SLUG}/import-map.json`);
  assert.match(batch.batch.chat, /Mapping confirmed: 1 requirement table \(2 rows\)/);
});
