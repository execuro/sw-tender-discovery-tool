// API lifecycle: start on the source path -> session -> tick -> batch/lock -> queued writes -> reply (repair + apply queued)
// -> propose -> answer -> export gate -> analyze guard -> abort -> heartbeat timeout.
// Needs permission to bind 127.0.0.1 (skipped automatically when the sandbox forbids it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, resolveTarget, collapseSessions } from '../lib/server.mjs';
import { collect } from '../lib/parse.mjs';
import { canBind, exec, field, HERE, CLI } from './helpers.mjs';

// Both entry points are subcommands of the one bin.
const SERVER = CLI;
const EMIT = CLI;

/** The JSON payload a command prints after its next_step line. */
const jsonPayload = out => JSON.parse(out.slice(out.indexOf('{', out.indexOf('next_step:'))));
const SOURCE = 'specs/rfp-0099-mini.csv';
const ANALYSIS = 'specs/rfp-0099-mini-analysis.md';
const SESSION_DIR = 'specs/.editor/rfp-0099-mini';

const j = async (url, body, method) => {
  const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function sseReader(url) {
  const res = await fetch(url + 'api/events');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  const waiters = [];
  let buf = '', cursor = 0;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk), data = /^data: (.*)$/m.exec(chunk);
        if (!ev) continue;
        const e = { event: ev[1], data: data ? JSON.parse(data[1]) : null };
        events.push(e);
        for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
      }
    }
  })().catch(() => {});
  return {
    events,
    wait(pred, ms = 3000) {
      for (; cursor < events.length; cursor++) if (pred(events[cursor])) return Promise.resolve(events[cursor++]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: e => { cursor = events.length; resolve(e); } };
        waiters.push(w);
        setTimeout(() => reject(new Error('sse timeout waiting for ' + pred.toString())), ms);
      });
    },
    close() { reader.cancel().catch(() => {}); },
  };
}

async function cleanup({ heartbeat, sse, session, realExit, root }) {
  if (heartbeat) clearInterval(heartbeat);
  try { sse.close(); } catch { /* ignore */ }
  try { session.shutdown('test end'); } catch { /* gone */ }
  await new Promise(r => setTimeout(r, 400));
  process.exit = realExit;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

const lines = text => text.split('\n');
const diffLines = (a, b) => { const x = lines(a), y = lines(b); const out = []; for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(i); return out; };
const findLine = (text, re) => lines(text).find(l => re.test(l));

test('resolveTarget derives the analysis from either path', () => {
  const t = resolveTarget('/r', 'specs/rfp-0099-mini.csv');
  assert.equal(t.slug, 'rfp-0099-mini');
  assert.equal(t.analysis, ANALYSIS);
  assert.equal(t.source, SOURCE);
  const a = resolveTarget('/r', 'specs/rfp-0099-mini-analysis.md');
  assert.equal(a.analysis, ANALYSIS);
  assert.equal(a.source, null, 'no sibling on disk under /r');
  assert.equal(resolveTarget('/r', 'specs/0007-delivery-date.md'), null);
});

test('server lifecycle', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'tender-tool-'));
  mkdirSync(path.join(root, 'specs'));
  const file = path.join(root, ANALYSIS);
  const readDoc = () => readFileSync(file, 'utf8');

  // CLI guards: no rfp- prefix -> 2; neither analysis nor source -> 2
  let cli = await exec(process.execPath, [SERVER, 'start', '--doc', 'specs/0007-x.md'], root);
  assert.equal(cli.code, 2); assert.match(cli.err, /rfp-NNNN-/);
  cli = await exec(process.execPath, [SERVER, 'start', '--doc', SOURCE], root);
  assert.equal(cli.code, 2); assert.match(cli.err, /neither .* exists/);

  copyFileSync(path.join(HERE, 'fixtures', 'rfp-0099-mini-analysis.md'), file);
  copyFileSync(path.join(HERE, 'fixtures', 'rfp-0099-mini.csv'), path.join(root, SOURCE));
  const original = readDoc();

  const realExit = process.exit;
  process.exit = () => {};
  // start on the SOURCE path: the analysis is derived
  const session = await startServer({ cmd: 'start', doc: SOURCE, port: 0, grace: 1, agentTimeout: 3, foreground: true, child: false, root });
  const url = session.url;
  const heartbeat = setInterval(() => fetch(url + 'api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tab":"t1"}' }).catch(() => {}), 300);
  const sse = await sseReader(url);
  // one cleanup hook, in this order: a failed assertion must still stop the server and the watcher
  t.after(() => cleanup({ heartbeat, sse, session, realExit, root }));
  await sse.wait(e => e.event === 'hello');

  // session
  let s = await j(url + 'api/session');
  assert.equal(s.status, 200);
  assert.equal(s.body.analysis, ANALYSIS); assert.equal(s.body.source, SOURCE);
  assert.ok(s.body.model, 'model parsed');
  assert.equal(collect(s.body.model.blocks).filter(b => b.kind === 'req').length, 3);
  assert.equal(s.body.meta.totals.must, 15.5);
  assert.equal(s.body.session.exists, true);
  assert.equal(s.body.session.doc.rows, 3);
  assert.equal(s.body.session.lock, null);
  assert.deepEqual(s.body.proposed, []);
  const lock = JSON.parse(readFileSync(path.join(root, SESSION_DIR, 'session.lock'), 'utf8'));
  assert.equal(lock.analysis, ANALYSIS); assert.equal(lock.url, url);

  // reattach + status via the CLI (analysis path this time)
  const re = await exec(process.execPath, [SERVER, 'start', '--doc', ANALYSIS], root);
  assert.match(re.out, new RegExp('TENDER_TOOL_URL=' + url.replace(/[/.]/g, '\\$&')));
  assert.match(re.out, /reattached/);
  const st = await exec(process.execPath, [SERVER, 'status', '--doc', ANALYSIS], root);
  assert.equal(field(st.out, 'running'), 'true');
  assert.equal(field(st.out, 'source'), SOURCE);
  assert.match(field(st.out, 'analysis'), /\(found\)$/);

  // direct tick: exactly one line differs, doc event carries the id
  let r = await j(url + 'api/tick', { id: 'STF-01.a1', value: 'x' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.changed, true);
  let after = readDoc();
  assert.equal(diffLines(original, after).length, 1);
  assert.match(findLine(after, /^\| STF-01\.a1 /), /\| \[x\] \|$/);
  let ev = await sse.wait(e => e.event === 'doc' && e.data.reason === 'tick');
  assert.ok(ev.data.changed.includes('STF-01.a1'));
  assert.ok(ev.data.meta, 'doc event carries meta');
  // frozen line -> 409; bad value -> 400
  r = await j(url + 'api/tick', { id: 'STF-01.a2', value: 'x' });
  assert.equal(r.status, 409); assert.equal(r.body.reason, 'frozen');
  r = await j(url + 'api/tick', { id: 'STF-01.a1', value: 'y' });
  assert.equal(r.status, 400);
  r = await j(url + 'api/tick', { id: 'NOPE-9.a1', value: 'x' });
  assert.equal(r.status, 409);

  // reconcile batch -> next -> lock + snapshot; `stage` round-trips onto the batch file and the run
  r = await j(url + 'api/batch', { kind: 'reconcile', stage: '  reconciling STF rows  ' });
  assert.equal(r.status, 200); assert.equal(r.body.id, 'r-1'); assert.equal(r.body.queued, false);
  const batch = JSON.parse(readFileSync(path.join(root, SESSION_DIR, 'batches', 'r-1.json'), 'utf8'));
  assert.equal(batch.analysis, ANALYSIS); assert.equal(batch.source, SOURCE); assert.equal(batch.slug, 'rfp-0099-mini');
  assert.equal(batch.stage, 'reconciling STF rows');
  assert.ok(batch.pending.ticks.length >= 1, 'pending ticks reach the batch');
  assert.deepEqual(batch.pending.proposals, []);
  r = await j(url + 'api/next?wait=2');
  assert.equal(r.body.event, 'batch'); assert.equal(r.body.batch.id, 'r-1'); assert.equal(r.body.batch.stage, 'reconciling STF rows');
  await sse.wait(e => e.event === 'run' && e.data.state === 'started' && e.data.batch === 'r-1' && e.data.stage === 'reconciling STF rows');
  r = await j(url + 'api/lock');
  assert.equal(r.body.lock, 'r-1'); assert.equal(r.body.run.id, 'r-1'); assert.equal(r.body.agent.present, true);
  assert.ok(existsSync(path.join(root, SESSION_DIR, 'snapshot.json')));
  r = await j(url + 'api/session');
  assert.equal(r.body.session.run.stage, 'reconciling STF rows');

  // locked: tick and propose are queued (202)
  r = await j(url + 'api/tick', { id: 'STF-01.a1', value: ' ' });
  assert.equal(r.status, 202); assert.equal(r.body.queued, true); assert.equal(r.body.lockedBy, 'r-1');
  ev = await sse.wait(e => e.event === 'queued');
  assert.equal(ev.data.count, 1);
  r = await j(url + 'api/propose', { row: 'CAT-03', statement: 'Pack units come from the ERP feed', pdSaved: 0.5, riskTo: 'client' });
  assert.equal(r.status, 202);
  assert.equal((await j(url + 'api/session')).body.queued.length, 2);

  // the agent edits the file during the run: un-freezes a line (repaired on reply) and rewords a req (reported)
  writeFileSync(file, readDoc().replace('| accepted 2026-09-01 |', '| [ ] |').replace('cart rounding message via snippet', 'cart rounding message via snippet (checked)').replace('| [ ] suspect |', '| rejected 2026-09-05 |'));
  let e = await exec(process.execPath, [EMIT, 'emit', 'progress', 'reconciling', '--batch', 'r-1'], root);
  assert.equal(e.code, 0, e.err);
  e = await exec(process.execPath, [EMIT, 'emit', 'done', 'Reconciled **1** tick.', '--batch', 'r-1'], root);
  assert.equal(e.code, 0, e.err);
  const reply = jsonPayload(e.out);
  assert.equal(reply.batch, 'r-1');
  assert.ok(reply.repairs.length >= 1, 'frozen status cell restored: ' + JSON.stringify(reply));
  assert.ok(reply.changed.includes('CAT-03'), 'reworded row reported: ' + JSON.stringify(reply.changed));
  assert.ok(reply.changed.includes('CAT-03.a1'), 'status-only change (tick consumed) reported: ' + JSON.stringify(reply.changed));
  assert.ok(!reply.changed.includes('STF-01.a2'), 'a repaired line is back to its snapshot state, not changed');
  ev = await sse.wait(e => e.event === 'doc' && e.data.reason === 'reply');
  assert.ok(ev.data.changed.includes('CAT-03') && ev.data.changed.includes('CAT-03.a1'), 'reply doc event lists the reworded row and the consumed tick: ' + JSON.stringify(ev.data.changed));
  await sse.wait(e => e.event === 'run' && e.data.state === 'finished' && e.data.batch === 'r-1');
  after = readDoc();
  assert.match(findLine(after, /^\| STF-01\.a2 /), /\| accepted 2026-09-01 \|$/, 'frozen line repaired');
  assert.match(findLine(after, /^\| STF-01\.a1 /), /\| \[ \] \|$/, 'queued tick applied after unlock');
  assert.match(findLine(after, /^\| CAT-03\.a2 /), /Pack units come from the ERP feed/, 'queued propose applied after unlock');
  ev = await sse.wait(e => e.event === 'queued' && e.data.count === 0);
  r = await j(url + 'api/lock');
  assert.equal(r.body.lock, null); assert.equal(r.body.run, null);
  s = await j(url + 'api/session');
  assert.equal(s.body.session.lock, null); assert.equal(s.body.session.queuedWrites, 0);
  assert.deepEqual(s.body.proposed, ['CAT-03.a2']);
  const types = s.body.chat.map(c => c.type);
  assert.ok(types.indexOf('system') < types.indexOf('batch') && types.indexOf('batch') < types.indexOf('progress') && types.indexOf('progress') < types.indexOf('reply'), types.join(','));
  const replyEntry = s.body.chat.find(c => c.type === 'reply');
  assert.equal(replyEntry.kind, 'reconcile'); assert.ok(Array.isArray(replyEntry.repairs));
  r = await j(url + 'api/next?wait=1');
  assert.equal(r.body.event, 'idle');

  // propose unlocked -> STF-01.a3 inserted after the last STF-01 sub-line
  r = await j(url + 'api/propose', { row: 'STF-01', statement: 'Search stays stock Elasticsearch', pdSaved: 1, cls: 'config', riskTo: 'client' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.id, 'STF-01.a3');
  after = readDoc();
  const idx = lines(after).findIndex(l => l.startsWith('| STF-01.a3 '));
  assert.ok(idx > 0); assert.match(lines(after)[idx], /Search stays stock Elasticsearch/);
  assert.match(lines(after)[idx - 1], /^\| STF-01\.c1 /);
  assert.deepEqual((await j(url + 'api/session')).body.proposed, ['CAT-03.a2', 'STF-01.a3']);
  r = await j(url + 'api/propose', { row: 'STF-01', statement: '' });
  assert.equal(r.status, 400);

  // answer a client question: single select
  r = await j(url + 'api/answer', { qid: 'CQ-1', option: 'B' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  after = readDoc();
  assert.match(after, /- \[x\] B — no, quantities are corrected silently/);
  assert.match(after, /- \[ \] A — yes, a correction list/);
  ev = await sse.wait(e => e.event === 'doc' && e.data.reason === 'answer');
  assert.ok(ev.data.changed.includes('CQ-1'));

  // propose an exclusion: a non-tickable §3 X-n line, wired through kind
  r = await j(url + 'api/propose', { statement: 'Hosting is provided by the client (RFP section 4)', rows: ['GEN-02'], kind: 'exclude' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.id, 'X-2');
  assert.match(readDoc(), /\| X-2 \| exclude \| GEN-02 \| Hosting is provided by the client \(RFP section 4\) \| \| \| rfp \|/);
  r = await j(url + 'api/propose', { statement: 'x', kind: 'bogus' });
  assert.equal(r.status, 400);

  // export gate closed -> 409 with reasons; analyze refused while the model exists
  r = await j(url + 'api/batch', { kind: 'export' });
  assert.equal(r.status, 409); assert.ok(Array.isArray(r.body.reasons) && r.body.reasons.length, JSON.stringify(r.body));
  r = await j(url + 'api/batch', { kind: 'analyze' });
  assert.equal(r.status, 400);
  r = await j(url + 'api/batch', { kind: 'batch', notes: [], chat: '' });
  assert.equal(r.status, 400);
  r = await j(url + 'api/batch', { kind: 'nope' });
  assert.equal(r.status, 400);

  // note batch -> abort path: unlock, queued tick applied, run event aborted
  r = await j(url + 'api/batch', { kind: 'batch', notes: [{ id: 'n1', block: 'STF-01', blockKind: 'req', text: 'too high' }], chat: '', remaining: [] });
  assert.equal(r.status, 200); assert.equal(r.body.id, 'b-2');
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, SESSION_DIR, 'batches', 'b-2.json'), 'utf8')).pending.proposals, ['CAT-03.a2', 'STF-01.a3']);
  r = await j(url + 'api/next?wait=2');
  assert.equal(r.body.batch.id, 'b-2');
  r = await j(url + 'api/tick', { id: 'STF-01.a3', value: 'x' });
  assert.equal(r.status, 202);
  r = await j(url + 'api/run/abort', { reason: 'user stopped' });
  assert.equal(r.status, 200); assert.equal(r.body.aborted, 'b-2');
  ev = await sse.wait(e => e.event === 'run' && e.data.state === 'finished' && e.data.batch === 'b-2');
  assert.equal(ev.data.aborted, true); assert.equal(ev.data.lock, null);
  assert.match(findLine(readDoc(), /^\| STF-01\.a3 /), /\| \[x\] \|$/, 'queued tick applied after abort');
  assert.equal((await j(url + 'api/lock')).body.lock, null);

  // orphan reply is kept as chat; external edit through the watcher reloads
  r = await j(url + 'api/agent/reply', { markdown: 'late' });
  assert.equal(r.body.orphan, true);
  writeFileSync(file, readDoc().replace('Which plan is offered?', 'Which plan is offered by the partner?'));
  ev = await sse.wait(e => e.event === 'doc' && e.data.reason === 'reload', 4000);
  assert.ok(ev.data.changed.includes('Q-1'), JSON.stringify(ev.data.changed));

  // heartbeat timeout -> shutdown, lock removed
  clearInterval(heartbeat);
  await new Promise(res => setTimeout(res, 1200));
  session.tick();
  assert.equal(session.closing, true);
  assert.equal(existsSync(path.join(root, SESSION_DIR, 'session.lock')), false);
  const state = JSON.parse(readFileSync(path.join(root, SESSION_DIR, 'session.json'), 'utf8'));
  assert.equal(state.endReason, 'heartbeat timeout');
  assert.equal(state.lastBatchSeq, 2);
  await new Promise(res => setTimeout(res, 500));
});

test('start on a source without analysis serves model: null', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'tender-tool-'));
  mkdirSync(path.join(root, 'specs'));
  copyFileSync(path.join(HERE, 'fixtures', 'rfp-0099-mini.csv'), path.join(root, SOURCE));
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: SOURCE, port: 0, grace: 60, agentTimeout: 3, foreground: true, child: false, root });
  const url = session.url;
  const sse = await sseReader(url);
  t.after(() => cleanup({ sse, session, realExit, root }));
  let s = await j(url + 'api/session');
  assert.equal(s.body.model, null); assert.equal(s.body.meta, null);
  assert.equal(s.body.session.exists, false); assert.equal(s.body.session.doc.status, null);
  let r = await j(url + 'api/tick', { id: 'STF-01.a1', value: 'x' });
  assert.equal(r.status, 409);
  r = await j(url + 'api/batch', { kind: 'export' });
  assert.equal(r.status, 409);
  r = await j(url + 'api/batch', { kind: 'analyze' });
  assert.equal(r.status, 200); assert.equal(r.body.id, 'a-1');
  r = await j(url + 'api/next?wait=2');
  assert.equal(r.body.batch.kind, 'analyze'); assert.equal(r.body.batch.source, SOURCE);
  // the agent writes the analysis: the watcher turns model null -> parsed
  copyFileSync(path.join(HERE, 'fixtures', 'rfp-0099-mini-analysis.md'), path.join(root, ANALYSIS));
  const ev = await sse.wait(e => e.event === 'doc' && e.data.reason === 'reload', 4000);
  assert.ok(ev.data.model); assert.ok(ev.data.added.includes('STF-01'));
  r = await j(url + 'api/agent/reply', { markdown: 'Analysed.', batch: 'a-1' });
  assert.equal(r.status, 200); assert.equal(r.body.batch, 'a-1');
  s = await j(url + 'api/session');
  assert.ok(s.body.model); assert.equal(s.body.session.exists, true); assert.equal(s.body.session.lock, null);
  await new Promise(res => setTimeout(res, 200));
});

test('reload survives a bad parse: keeps the last good model, logs once, recovers', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'tender-tool-'));
  mkdirSync(path.join(root, 'specs'));
  const file = path.join(root, ANALYSIS);
  copyFileSync(path.join(HERE, 'fixtures', 'rfp-0099-mini-analysis.md'), file);
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 60, agentTimeout: 3, foreground: true, child: false, root });
  const url = session.url;
  t.after(() => cleanup({ sse: { close() {} }, session, realExit, root }));
  const goodModel = session.model;
  assert.ok(goodModel);
  assert.equal(session.parseError, null);

  // a staged/half-written write that fails to parse: model and text stay on the last good version
  session.parseText = () => { throw new Error('boom'); };
  writeFileSync(file, readFileSync(file, 'utf8') + '\nx');
  let d = session.reload('reload');
  assert.equal(d, null);
  assert.equal(session.parseError && session.parseError.message, 'boom');
  assert.equal(session.model, goodModel);
  const s1 = await j(url + 'api/session');
  assert.equal(s1.body.parseError.message, 'boom');
  assert.ok(s1.body.model, 'last good model still served');
  let errLines = session.chatHistory().filter(c => c.type === 'system' && /does not parse/.test(c.text));
  assert.equal(errLines.length, 1, 'logged once on the transition into the error state');

  // the watcher re-triggering on the same broken bytes must not spam the same line again
  d = session.reload('reload');
  assert.equal(d, null);
  errLines = session.chatHistory().filter(c => c.type === 'system' && /does not parse/.test(c.text));
  assert.equal(errLines.length, 1, 'not re-logged for unchanged content');

  // a following good write clears the flag and logs a recovery line
  delete session.parseText;
  writeFileSync(file, readFileSync(file, 'utf8') + '\ny');
  d = session.reload('reload');
  assert.ok(d);
  assert.equal(session.parseError, null);
  const recovered = session.chatHistory().filter(c => c.type === 'system' && /parses again/.test(c.text));
  assert.equal(recovered.length, 1);
  const s2 = await j(url + 'api/session');
  assert.equal(s2.body.parseError, null);
});

test('a watch error degrades live reload instead of killing the process', { skip: !(await canBind()) && 'cannot bind 127.0.0.1 in this environment' }, async (t) => {
  // fs.watch reports EMFILE and friends asynchronously on the FSWatcher; without
  // a listener that unhandled 'error' event takes the whole server down.
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'tender-tool-'));
  mkdirSync(path.join(root, 'specs'));
  copyFileSync(path.join(HERE, 'fixtures', 'rfp-0099-mini-analysis.md'), path.join(root, ANALYSIS));
  const realExit = process.exit;
  process.exit = () => {};
  const session = await startServer({ cmd: 'start', doc: ANALYSIS, port: 0, grace: 60, agentTimeout: 3, foreground: true, child: false, root, watchRetry: [30, 30] });
  const url = session.url;
  t.after(() => cleanup({ sse: { close() {} }, session, realExit, root }));

  const dead = session.watcher;
  assert.ok(dead, 'the session watches the specs directory');
  dead.emit('error', new Error('EMFILE: too many open files, watch'));
  assert.notEqual(session.watcher, dead, 'the dead watcher is dropped');
  assert.ok(((await j(url + 'api/session')).body.chat || []).some(e => /file watching stopped .*EMFILE/.test(e.text || '')), 'the page is told once');

  await new Promise(r => setTimeout(r, 200));
  assert.ok(session.watcher, 'the watch is re-established on the retry');
  assert.equal(session.watchAttempt, 0, 'a successful retry resets the backoff');

  // a watch that never recovers gives up rather than retrying forever
  session.watch = () => session.watchFailed(new Error('EMFILE: too many open files, watch'));
  session.watcher.emit('error', new Error('EMFILE: too many open files, watch'));
  await new Promise(r => setTimeout(r, 200));
  const chat = (await j(url + 'api/session')).body.chat || [];
  assert.ok(chat.some(e => /file watching gave up after 2 attempts/.test(e.text || '')), 'the give-up is reported');
  assert.equal((await j(url + 'api/session')).status, 200, 'the server is still serving');
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
  assert.deepEqual(collapseSessions(log.slice(-1)), log.slice(-1));
  assert.equal(collapseSessions([{ type: 'system', text: 'file watching resumed' }])[0].text, 'file watching resumed');
});
