// D-34: the page's "changed since last export" filter (`S.sinceExport`) must never go stale. The
// `doc` SSE event (Session#reload's `broadcast('doc', ...)`) now carries a freshly computed
// `sinceExport` on every write, not just the payload returned by `/api/export` itself — an
// in-place Client Response/Internal note edit or an agent's applied batch must refresh the page's
// baseline the same way a fresh `/api/session` fetch would, with no drift between the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Session } from '../lib/server.mjs';
import { exportText, resolveTable } from '../lib/export-text.mjs';
import { HERE } from './helpers.mjs';

function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-sinceexport-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'fixtures', 'rfp-0101-xlsx-ids-analysis.md'), path.join(root, 'specs', 'rfp-0101-xlsx-ids-analysis.md'));
  return root;
}

/** Same shape `import-export.mjs`'s private `itemExportText` snapshots for the no-map case
 * (CSV/PDF, or an xlsx source with no fit-back map yet — this fixture's case). */
function snapshotText(item) {
  const t = exportText(item, resolveTable(null, item));
  return JSON.stringify([t.token, t.response, t.effort, t.assumptions]);
}

test('doc SSE event carries a freshly computed sinceExport on a direct write, matching /api/session', async () => {
  const root = host();
  const session = new Session({ root, doc: 'specs/rfp-0101-xlsx-ids-analysis.md', grace: 60, agentTimeout: 60 });
  try {
    await session.importExportReady;
    await session.importReady;

    const before = session.model.items.find(i => i.id === 'HIB-01');
    assert.equal(before.status?.kind, 'confirmed', 'HIB-01 is the fixture\'s only confirmed item');

    // Fabricate one prior export whose snapshot matches the document's current state exactly, so
    // the baseline starts in sync (empty) before the write below.
    const exportsDir = path.join(root, 'specs', '.rfp', session.slug);
    fs.mkdirSync(exportsDir, { recursive: true });
    fs.writeFileSync(path.join(exportsDir, 'exports.json'), JSON.stringify([
      { version: 1, file: path.join(root, 'specs', 'rfp-0101-hartmann-response-v1.xlsx'), at: new Date().toISOString(), items: { 'HIB-01': snapshotText(before) } },
    ], null, 2));

    assert.deepEqual(await session.sinceExport(), [], 'baseline starts in sync with the fabricated export');

    const events = [];
    session.clients.add({ write: (chunk) => events.push(chunk) });

    const r = session.applyWrite({ type: 'patch', id: 'HIB-01', clientResponse: 'Updated after export.' });
    assert.equal(r.ok, true);

    const docChunks = events.filter(c => c.startsWith('event: doc'));
    assert.ok(docChunks.length, 'expected at least one doc SSE event on the direct write');
    const payload = JSON.parse(docChunks[docChunks.length - 1].split('data: ')[1]);
    assert.deepEqual(payload.sinceExport, ['HIB-01'], 'the doc event must carry the freshly computed sinceExport, not the stale pre-write baseline');

    // /api/session's own computation must agree - no drift between the SSE path and a full reload.
    assert.deepEqual(await session.sinceExport(), payload.sinceExport);
  } finally {
    try { session.shutdown('test end'); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
