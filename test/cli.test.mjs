// CLI acceptance tests - black box, through bin/cli.mjs in a temp host repo.
//
// Covers the whole command tree. Everything runs against the real CLI so the
// entry-point wiring itself is under test - that is the bug this suite exists
// to catch. The parsers and the server internals are covered by the other suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canBind, run, spawnCli, exec, field, HERE, PKG } from './helpers.mjs';

const FIXTURE = path.join(HERE, 'fixtures', 'rfp-0099-mini-analysis.md');
const SOURCE = path.join(HERE, 'fixtures', 'rfp-0099-mini.csv');
const ANALYSIS = 'specs/rfp-0099-mini-analysis.md';
const SESSION_DIR = 'specs/.editor/rfp-0099-mini';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hostRepo() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tender-tool-cli-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(root, ANALYSIS));
  fs.copyFileSync(SOURCE, path.join(root, 'specs', 'rfp-0099-mini.csv'));
  return root;
}

test('guide prints the protocol and the poll rules', async () => {
  const r = await run(['guide'], os.tmpdir());
  assert.equal(r.code, 0);
  assert.match(r.out, /Tender Discovery Tool - session protocol/);
  assert.match(r.out, /Never background it with/);
  assert.match(r.out, /Exit codes: 0 success, 1 server unreachable, 2 usage error/);
  // guide is the single source of the protocol, so it must itself carry the
  // next_step line every other command carries, before the payload.
  assert.equal((r.out.match(/^next_step: /gm) || []).length, 1);
  assert.ok(r.out.indexOf('next_step:') < r.out.indexOf('Tender Discovery Tool - session protocol'), 'next_step must come before the payload');
});

test('an unknown command is a usage error', async () => {
  const r = await run(['bogus'], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command bogus/);
});

test('an unknown batch kind is a usage error', async () => {
  const root = hostRepo();
  try {
    const r = await run(['batch', '--kind', 'nonsense', '--doc', ANALYSIS], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown batch kind nonsense/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a command against a server that is not running exits 1', async () => {
  const root = hostRepo();
  try {
    const r = await run(['poll', '--doc', ANALYSIS], root);
    assert.equal(r.code, 1);
    assert.match(r.err, /no running Tender Discovery Tool/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a document whose name is not rfp-NNNN- is a usage error', async () => {
  const root = hostRepo();
  try {
    const r = await run(['status', '--doc', 'specs/not-a-tender.md'], root);
    assert.equal(r.code, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start / status / reattach / poll / batch / stop', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    const start = await run(['start', '--doc', ANALYSIS], root);
    assert.equal(start.code, 0);
    const url = (start.out.match(/^TENDER_TOOL_URL=(.*)$/m) || [])[1];
    assert.ok(url, `start printed no URL: ${start.out}${start.err}`);

    // status reports what the skills used to read from GET /api/session
    const status = await run(['status', '--doc', ANALYSIS], root);
    assert.equal(status.code, 0);
    assert.equal(field(status.out, 'running'), 'true');
    assert.equal(field(status.out, 'url'), url);
    assert.equal(field(status.out, 'status'), 'Draft');
    assert.equal(field(status.out, 'confidence'), '64');
    assert.match(field(status.out, 'pending'), /ticks/);

    // starting again reattaches instead of binding a second port
    const again = await run(['start', '--doc', ANALYSIS], root);
    assert.equal(again.code, 0);
    assert.match(again.out, new RegExp(`^TENDER_TOOL_URL=${url}$`, 'm'));
    assert.match(again.out, /^reattached: /m);

    const idle = await run(['poll', '--wait', '2', '--doc', ANALYSIS], root);
    assert.equal(idle.code, 0);
    assert.equal(field(idle.out, 'event'), 'idle');

    // `batch --kind` replaces the raw POST api/batch curl
    const queued = await run(['batch', '--kind', 'reconcile', '--stage', 'checking ticks', '--doc', ANALYSIS], root);
    assert.equal(queued.code, 0);
    const id = field(queued.out, 'batch');
    assert.match(id, /^r-\d+$/);

    const got = await run(['poll', '--wait', '5', '--doc', ANALYSIS], root);
    assert.equal(got.code, 0);
    assert.equal(field(got.out, 'event'), 'batch');
    assert.equal(field(got.out, 'batch'), id);
    // batch_file is absolute: the agent opens it without sharing our cwd.
    // batch_file_rel is its display twin, for logs and fixtures.
    const batchFile = field(got.out, 'batch_file');
    assert.ok(path.isAbsolute(batchFile), `batch_file must be absolute, got ${batchFile}`);
    assert.ok(fs.existsSync(batchFile));
    assert.equal(field(got.out, 'batch_file_rel'), path.relative(fs.realpathSync(root), batchFile));
    // next_step must precede the payload, so a truncated read still works
    assert.ok(got.out.indexOf('next_step:') < got.out.indexOf('"id"'), 'next_step must come before the payload');

    // the server's refusal of an inapplicable kind survives the CLI intact
    const refused = await run(['batch', '--kind', 'export', '--doc', ANALYSIS], root);
    assert.equal(refused.code, 2);
    assert.equal(field(refused.out, 'refused'), '409');

    const emit = await run(['emit', 'progress', 'reconciling', '--batch', id], root);
    assert.equal(emit.code, 0);
    const chat = fs.readFileSync(path.join(root, 'specs/.editor/rfp-0099-mini/chat.jsonl'), 'utf8');
    assert.match(chat, /reconciling/);

    const stop = await run(['stop', '--doc', ANALYSIS], root);
    assert.equal(stop.code, 0);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(root, 'specs/.editor/rfp-0099-mini/session.lock')), false);
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('emit accepts --doc for symmetry with the Specs Editor and ignores it', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', ANALYSIS], root);
    const r = await run(['emit', 'progress', 'step one', '--doc', 'analysis'], root);
    assert.equal(r.code, 0, r.err);
    assert.equal(field(r.out, 'emitted'), 'progress');
    const chat = fs.readFileSync(path.join(root, 'specs/.editor/rfp-0099-mini/chat.jsonl'), 'utf8');
    assert.match(chat, /step one/);
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed poll redelivers the same batch', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', ANALYSIS], root);
    const queued = await run(['batch', '--kind', 'reconcile', '--doc', ANALYSIS], root);
    const id = field(queued.out, 'batch');

    // Kill the poll while the batch is in flight: it was never delivered, so it
    // must go back to the front of the queue rather than being lost with the run
    // left locked behind it.
    const doomed = spawnCli(['poll', '--wait', '2', '--doc', ANALYSIS], root);
    await sleep(150);
    doomed.child.kill('SIGKILL');
    await doomed.done;

    const retry = await run(['poll', '--wait', '2', '--doc', ANALYSIS], root);
    assert.equal(field(retry.out, 'event'), 'batch');
    assert.equal(field(retry.out, 'batch'), id, 'the same batch comes back, not "idle"');
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the batch queue survives a server restart', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', ANALYSIS], root);
    const id = field((await run(['batch', '--kind', 'reconcile', '--doc', ANALYSIS], root)).out, 'batch');

    await run(['stop', '--doc', ANALYSIS], root);
    await sleep(300);
    await run(['start', '--doc', ANALYSIS], root);

    const r = await run(['poll', '--wait', '2', '--doc', ANALYSIS], root);
    assert.equal(field(r.out, 'event'), 'batch');
    assert.equal(field(r.out, 'batch'), id, 'an undelivered batch outlives the server that took it');
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('poll --reply posts the reply and waits again in one call', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', ANALYSIS], root);
    const id = field((await run(['batch', '--kind', 'reconcile', '--doc', ANALYSIS], root)).out, 'batch');
    await run(['poll', '--wait', '2', '--doc', ANALYSIS], root);

    // One command closes the finished batch and parks for the next one.
    const replying = run(['poll', '--wait', '2', '--reply', 'done with ' + id, '--doc', ANALYSIS], root);
    await sleep(300);
    await run(['batch', '--kind', 'reconcile', '--doc', ANALYSIS], root);

    const r = await replying;
    assert.equal(r.code, 0);
    assert.equal(field(r.out, 'event'), 'batch');
    assert.notEqual(field(r.out, 'batch'), id, 'the reply released the first run and the next batch arrived');
    assert.match(fs.readFileSync(path.join(root, SESSION_DIR, 'chat.jsonl'), 'utf8'), new RegExp(`done with ${id}`));
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed poll redelivers the same batch, repeatedly - not a race', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  for (let i = 0; i < 5; i++) {
    const root = hostRepo();
    try {
      await run(['start', '--doc', ANALYSIS], root);
      const queued = await run(['batch', '--kind', 'reconcile', '--doc', ANALYSIS], root);
      const id = field(queued.out, 'batch');

      const doomed = spawnCli(['poll', '--wait', '2', '--doc', ANALYSIS], root);
      await sleep(150);
      doomed.child.kill('SIGKILL');
      await doomed.done;

      const retry = await run(['poll', '--wait', '2', '--doc', ANALYSIS], root);
      assert.equal(field(retry.out, 'event'), 'batch', `run ${i}: expected batch, got ${retry.out}`);
      assert.equal(field(retry.out, 'batch'), id, `run ${i}: the same batch must come back`);
    } finally {
      await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('GET /health reports the package version', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    const start = await run(['start', '--doc', ANALYSIS], root);
    const url = (start.out.match(/^TENDER_TOOL_URL=(.*)$/m) || [])[1];
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    const health = await (await fetch(url + 'health')).json();
    assert.equal(health.name, pkg.name);
    assert.equal(health.version, pkg.version);
    assert.equal(typeof health.pid, 'number');
    assert.equal(health.slug, 'rfp-0099-mini');
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start against a running server with a different version restarts instead of reattaching', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  const sessionDir = path.join(root, SESSION_DIR);
  fs.mkdirSync(sessionDir, { recursive: true });
  let closed = false;
  const http = await import('node:http');
  const fake = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'tender-discovery-tool', version: '0.0.0-old', pid: 999999, slug: 'rfp-0099-mini', url: '', started: '' })); return; }
    if (req.url === '/api/lock') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ lock: null })); return; }
    if (req.url === '/api/close') {
      closed = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      res.on('finish', () => fake.close());
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}/`;
  fs.writeFileSync(path.join(sessionDir, 'session.lock'), JSON.stringify({ pid: 999999, port: fake.address().port, url: fakeUrl, started: new Date().toISOString(), analysis: ANALYSIS }, null, 2));

  try {
    const r = await run(['start', '--doc', ANALYSIS], root);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /reattached/);
    const url = (r.out.match(/^TENDER_TOOL_URL=(.*)$/m) || [])[1];
    assert.ok(url && url !== fakeUrl, `a fresh server must start on a new port, got ${r.out}${r.err}`);
    assert.equal(closed, true, 'the old, differing-version server must be asked to close');
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    try { fake.close(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the packed file list stays inside the files allow-list', async () => {
  const r = await exec('npm', ['pack', '--dry-run', '--json'], PKG);
  if (r.code !== 0) return; // npm unavailable; the release gate covers this too
  // Read from the manifest rather than restated here: a second copy is a
  // second thing to forget when the allow-list changes.
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const allowed = [...manifest.files, 'package.json'];
  const files = JSON.parse(r.out)[0].files.map(f => f.path);
  const outside = files.filter(f => !allowed.some(a => (a.endsWith('/') ? f.startsWith(a) : f === a)));
  assert.deepEqual(outside, [], `these would ship outside the allow-list: ${outside.join(', ')}`);
  assert.ok(files.includes('bin/cli.mjs') && files.includes('lib/server.mjs'), 'the entry point and the server must ship');
  assert.ok(files.includes('skills/sw-tender-discovery-tool/SKILL.md'), 'the skill install-skill installs must ship');
  assert.ok(!files.some(f => f.startsWith('test/')), 'tests must not ship');
});

test('every command works through the installed .bin symlink', async t => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tender-tool-pack-'));
  try {
    const packed = await exec('npm', ['pack', '--json', '--pack-destination', tmp], PKG);
    if (packed.code !== 0) return t.skip('npm unavailable; the release gate covers this');
    const tarball = path.join(tmp, JSON.parse(packed.out)[0].filename);

    const host = path.join(tmp, 'host');
    fs.mkdirSync(path.join(host, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(host, 'package.json'), '{"name":"host","private":true}');
    const install = await exec('npm', ['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts'], host);
    if (install.code !== 0) return t.skip(`npm install failed in this environment: ${install.err.slice(0, 200)}`);

    // This is the whole point: reached through the symlink, not by its real path.
    const bin = path.join(host, 'node_modules', '.bin', 'sw-tender-discovery-tool');
    assert.ok(fs.existsSync(bin), 'the package must expose its bin');

    // Paths resolve from cwd, not from the package directory it was installed into.
    fs.copyFileSync(FIXTURE, path.join(host, ANALYSIS));
    fs.copyFileSync(SOURCE, path.join(host, 'specs', 'rfp-0099-mini.csv'));

    // Every command in the tree, with arguments that need no running server.
    // Each must produce output and its documented exit code: a command that
    // exits 0 in silence is indistinguishable from one that worked.
    const cases = [
      { args: ['guide'], code: 0, expect: /Tender Discovery Tool - session protocol/ },
      { args: ['status', '--doc', ANALYSIS], code: 0, expect: /^running: false$/m },
      // stopping an already-stopped session is not an error, it is a no-op.
      { args: ['stop', '--doc', ANALYSIS], code: 0, expect: /^next_step: nothing to stop$/m },
      { args: ['poll', '--doc', ANALYSIS], code: 1, expect: /no running Tender Discovery Tool/ },
      { args: ['emit', 'progress', 'x'], code: 1, expect: /no running Tender Discovery Tool/ },
      { args: ['batch', '--kind', 'bogus', '--doc', ANALYSIS], code: 2, expect: /unknown batch kind/ },
      { args: ['import'], code: 2, expect: /import needs --source/ },
      { args: ['export'], code: 2, expect: /export needs --xlsx/ },
      { args: ['bogus'], code: 2, expect: /unknown command bogus/ },
    ];
    for (const c of cases) {
      const r = await exec(bin, c.args, host);
      const both = r.out + r.err;
      assert.equal(r.code, c.code, `${c.args[0]} exited ${r.code}: ${both}`);
      assert.ok(both.trim().length > 0, `${c.args[0]} printed nothing - it did not run`);
      assert.match(both, c.expect, `${c.args[0]} output: ${both}`);
    }
    // Derived from bin/cli.mjs's own COMMANDS table, so a newly added verb that
    // gets no case here fails the test instead of shipping untested.
    const cliSrc = fs.readFileSync(path.join(PKG, 'bin', 'cli.mjs'), 'utf8');
    const commandNames = [...cliSrc.matchAll(/^\s{2}(\w[\w-]*):\s*\(\)\s*=>\s*import/gm)].map(m => m[1]);
    const covered = cases.filter(c => c.args[0] !== 'bogus').map(c => c.args[0]);
    assert.deepEqual(covered.sort(), commandNames.filter(n => n !== 'start').sort(), 'every command in bin/cli.mjs must have a case here, except start, which needs a server');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
