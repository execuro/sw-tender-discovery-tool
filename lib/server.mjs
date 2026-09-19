// Tender Discovery Tool server - zero-dependency Node http server.
//
//   sw-tender-discovery-tool start  --doc specs/rfp-NNNN-slug-analysis.md | specs/rfp-NNNN-slug.csv [--port N] [--grace 60] [--agent-timeout 180] [--foreground]
//   sw-tender-discovery-tool status --doc <analysis or source path> [--json]
//   sw-tender-discovery-tool stop   --doc <analysis or source path>
//
// Entry point is bin/cli.mjs. This module exports main(argv) and never reads
// process.argv itself, so it works the same through an npx `.bin` symlink.
//
// `start` prints `TENDER_TOOL_URL=<url>` and returns; the server itself runs detached
// (unless --foreground) and exits on heartbeat timeout or POST /api/close.
// Direct writes (tick / answer / propose) rewrite one line of the analysis sidecar; while an
// agent run holds the lock they are queued and applied after the agent's reply.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, findBlock, collect, slugFromPath, analysisPathFor } from './parse.mjs';
import { diff } from './diff.mjs';
import { tick as tickLine, answer as answerQuestion, propose as proposeLine, snapshot, verifyAndRepair } from './edit.mjs';
import { pending } from './calc.mjs';
import { loadRequirementColumns } from './source.mjs';
import { readImportState, readImportSheet, confirmImportMap } from './import-state.mjs';
import { readLock, liveLock } from './session.mjs';
import { settle, outsideRoot } from './paths.mjs';
import * as out from './out.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.join(HERE, '..', 'page');

/** Backoff between attempts to re-establish the file watcher after it errors. */
const WATCH_RETRY = [2000, 5000, 15000];
const CALC_FILE = path.join(HERE, 'calc.mjs');
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
/**
 * Real path of the CLI entry point, for re-exec of the detached server child.
 * Resolved through realpath so the child is spawned with a true path even when
 * the package is reached through an npx `.bin` symlink or --preserve-symlinks.
 */
function cliPath() {
  const p = path.join(HERE, '..', 'bin', 'cli.mjs');
  try { return fs.realpathSync(p); } catch { return p; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const KINDS = { batch: 'b', reconcile: 'r', analyze: 'a', export: 'x' };
const SOURCE_EXT = ['csv', 'md', 'txt', 'pdf', 'xlsx'];
const TICKS = [' ', 'x', '-'];

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const o = { cmd: argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'start', doc: null, port: Number(process.env.TENDER_TOOL_PORT || 0), grace: 60, agentTimeout: 180, idle: 14400, foreground: false, json: false, rootFlag: '', root: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doc') o.doc = argv[++i];
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--grace') o.grace = Number(argv[++i]);
    else if (a === '--agent-timeout') o.agentTimeout = Number(argv[++i]);
    else if (a === '--idle') o.idle = Number(argv[++i]);
    else if (a === '--root') o.rootFlag = argv[++i];
    else if (a === '--foreground') o.foreground = true;
    else if (a === '--json') o.json = true;
    else if (!a.startsWith('--')) o.doc = a;
    else out.usage(`unknown flag ${a}`);
  }
  // The root comes from the document, not from wherever the agent ran this.
  return settle(o);
}

/** `--doc` may be the analysis sidecar or the client's source file; both map to one slug. */
export function resolveTarget(root, arg) {
  if (!arg) return null;
  const rel = path.relative(root, path.resolve(root, arg)).split(path.sep).join('/');
  let slug = null;
  try { slug = slugFromPath(rel) || null; } catch { slug = null; }
  if (!slug) return null;
  const dir = path.posix.dirname(rel);
  let analysis = analysisPathFor(rel);
  if (!analysis.includes('/') && dir !== '.') analysis = path.posix.join(dir, analysis);
  let source = rel !== analysis ? rel : null;
  if (!source) {
    for (const ext of SOURCE_EXT) {
      const c = path.posix.join(dir, `${slug}.${ext}`);
      if (fs.existsSync(path.resolve(root, c))) { source = c; break; }
    }
  }
  const specsDir = path.dirname(path.resolve(root, rel));
  return { rel, slug, analysis, source, specsDir, sessionDir: path.join(specsDir, '.editor', slug) };
}

// ---------------------------------------------------------------------------
// Helpers

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function now() { return new Date().toISOString(); }
function httpError(status, message, extra) { const e = new Error(message); e.status = status; e.extra = extra; return e; }
function uniq(list) { return [...new Set(list)]; }
/** id -> status text for every line whose status can change without its `id|text` hash changing. */
function statusMap(model) {
  const out = {};
  if (!model) return out;
  for (const b of collect(model.blocks)) {
    if (typeof b.status?.raw === 'string') out[b.id] = b.status.raw.trim();
    else if (b.kind === 'question') out[b.id] = (b.options || []).filter(o => o.checked).map(o => o.letter).join(',') + (b.other?.checked ? `|other:${b.other.text || ''}` : '');
  }
  return out;
}
function writeTarget(q) { return q.id || q.qid || (q.row ? `${q.row}` : 'global'); }

// ---------------------------------------------------------------------------
// Session

export class Session {
  constructor(opts) {
    this.opts = opts;
    this.root = opts.root;
    this.target = resolveTarget(this.root, opts.doc);
    if (!this.target) throw new Error(`cannot derive the slug from ${opts.doc}`);
    this.dir = this.target.sessionDir;
    fs.mkdirSync(path.join(this.dir, 'batches'), { recursive: true });
    this.file = path.resolve(this.root, this.target.analysis);
    this.text = null;
    this.model = null;
    this.lastReadText = undefined; // last raw read, whether or not it parsed; distinct from `text` (last good)
    this.parseError = null; // { message, at } while the file on disk fails to parse; last good text/model stay live
    this.clients = new Set();
    this.waiters = [];
    this.queue = [];
    // Durable batch queue: `queue.json` records the order and which id (if any) was
    // handed to an agent but never finished. An `inFlight` id was never acked or
    // replied to when the server died, so it is not lost work - it goes back at the
    // FRONT of the rehydrated queue, ahead of everything still merely `pending`.
    const queueManifest = readJson(path.join(this.dir, 'queue.json'), { pending: [], inFlight: null });
    for (const id of [...(queueManifest.inFlight ? [queueManifest.inFlight] : []), ...(queueManifest.pending || [])]) {
      const batch = readJson(path.join(this.dir, 'batches', `${id}.json`), null);
      if (batch) this.queue.push(batch);
    }
    this.run = null; // { id, kind, startedAt, changed: Set, warned, acked, batch, redelivered }
    this.lock = null; // batch id while an agent run owns the document
    this.lastBeat = Date.now();
    this.lastActivity = Date.now(); // last batch enqueue / poll / agent reply / page write - heartbeats do not count
    this.lastPoll = 0;
    this.everPolled = false;
    this.agentPresent = false;
    this.queued = readJson(path.join(this.dir, 'queued.json'), []);
    this.proposed = readJson(path.join(this.dir, 'proposed.json'), []);
    this.snapshots = readJson(path.join(this.dir, 'snapshot.json'), null);
    // Client source columns for the §4 grid; the export folder is static once the tender lands, so
    // one read at startup is enough (unlike `this.text`, there is no watcher on it).
    this.sourceCols = loadRequirementColumns(this.target.specsDir, this.target.slug);
    // The client's workbook, as `import` read it: the sheet grids the steering screen shows and
    // the mapping the user is confirming. Null for every tender that did not arrive as xlsx.
    this.importState = readImportState(this.target);
    const prev = readJson(path.join(this.dir, 'session.json'), {});
    this.batchSeq = Number(prev.lastBatchSeq || 0);
    this.state = { slug: this.target.slug, started: now(), ended: null, lastBatch: prev.lastBatch || null, lastBatchSeq: this.batchSeq, batches: Number(prev.batches || 0), resumed: Boolean(prev.started) };
    this.pendingWatch = new Map();
    this.watchAttempt = 0;
    this.reload('load', { silent: true });
  }

  // Diagnostics only, not the output contract's result - stderr (server.log captures both
  // stdout and stderr of the detached child; --foreground must not mix this into stdout).
  log(...a) { out.note([new Date().toISOString().slice(11, 19), ...a].join(' ')); }
  rel(abs) { return path.relative(this.root, abs).split(path.sep).join('/'); }
  /**
   * The machine form of a project-relative path.
   *
   * The page, the chat log and every field the page reads keep the relative
   * form - they are display, and a transcript carrying this machine's directory
   * layout is not portable. The batch is the other half: the agent opens what it
   * names, from a working directory this process cannot know, so those fields
   * get an absolute twin alongside the relative one.
   */
  abs(rel) { return rel ? path.resolve(this.root, rel) : rel; }

  /** Seam for tests: instance-overridable so a run can be made to fail without touching lib/parse.mjs. */
  parseText(text) { return parse(text, { path: this.target.analysis }); }

  /**
   * Re-read the analysis from disk; parse, diff against the previous model and push a `doc` event.
   * Typed rows hash `id|text`, so a status-only edit is invisible to `diff()`: callers pass the ids
   * they touched in `extra` and they are merged into the event. `force` broadcasts even when the text
   * is unchanged (the watcher may already have reloaded it).
   *
   * A parse error (e.g. mid-write from staged edits) never clobbers `this.text` / `this.model`: the
   * page keeps showing the last good version. The system chat line and `doc` broadcast only fire on
   * the transition into (or out of) the error state, so a watcher re-triggering on the same broken
   * bytes does not spam identical lines.
   */
  reload(reason, { silent = false, extra = null, force = false } = {}) {
    const text = readText(this.file);
    const textChanged = text !== this.lastReadText;
    this.lastReadText = text;
    if (!textChanged && !force) return null;

    let model = null;
    if (text != null) {
      try { model = this.parseText(text); } catch (e) {
        const wasError = Boolean(this.parseError);
        this.parseError = { message: e.message, at: now() };
        if (!wasError) this.chatAppend({ type: 'system', text: `${this.target.analysis} does not parse: ${e.message}` });
        if (!silent) this.broadcast('doc', { model: this.model, meta: this.model?.meta ?? null, changed: [], added: [], removed: [], reason, parseError: this.parseError });
        return null;
      }
    }
    const recovered = Boolean(this.parseError);
    this.parseError = null;
    if (recovered) this.chatAppend({ type: 'system', text: `${this.target.analysis} parses again` });

    const old = this.model;
    this.text = text;
    this.model = model;
    if (silent) return null;
    const d = diff(old, model);
    if (extra) {
      const has = id => model && findBlock(model, id);
      d.changed = uniq([...d.changed, ...(extra.changed || []).filter(id => has(id) && !d.added.includes(id))]);
      d.added = uniq([...d.added, ...(extra.added || []).filter(has)]);
      d.removed = uniq([...d.removed, ...(extra.removed || []).filter(id => !has(id))]);
    }
    if (this.run && reason === 'reload') for (const id of [...d.changed, ...d.added]) this.run.changed.add(id);
    this.broadcast('doc', { model, meta: model?.meta ?? null, changed: d.changed, added: d.added, removed: d.removed, reason, parseError: null });
    return d;
  }

  // --- persistence
  saveState() {
    atomicWrite(path.join(this.dir, 'session.json'), JSON.stringify({ ...this.state, port: this.port, url: this.url, analysis: this.target.analysis, source: this.target.source, lastBatchSeq: this.batchSeq, agent: { present: this.agentPresent, lastPoll: this.lastPoll ? new Date(this.lastPoll).toISOString() : null }, lock: this.lock, run: this.run ? { id: this.run.id, kind: this.run.kind, stage: this.run.stage || null, startedAt: new Date(this.run.startedAt).toISOString() } : null }, null, 2));
  }
  chatAppend(entry) {
    entry.t = entry.t || now();
    fs.appendFileSync(path.join(this.dir, 'chat.jsonl'), JSON.stringify(entry) + '\n');
    this.broadcast('chat', entry);
    return entry;
  }
  chatHistory(limit = 0) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(this.dir, 'chat.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* none */ }
    return limit ? lines.slice(-limit) : lines;
  }
  notes() { return readJson(path.join(this.dir, 'notes.json'), []); }
  saveNotes(notes) { atomicWrite(path.join(this.dir, 'notes.json'), JSON.stringify(notes, null, 2)); }

  /** Persists the steering screen's draft mapping; returns the refreshed import state. */
  saveImportMap(map) {
    const problems = confirmImportMap.validate(map);
    if (problems.length) return { ...this.importState, problems };
    atomicWrite(path.join(this.dir, 'import-map.json'), JSON.stringify(map, null, 2));
    this.importState = readImportState(this.target);
    return this.importState;
  }

  /**
   * The user confirmed: write the per-table CSVs and the committed map next to them, then re-read
   * the client columns so the §4 grid shows this client's own wording straight away.
   */
  confirmImport(map) {
    const result = confirmImportMap(this.target, map ?? this.importState?.map);
    if (result.problems?.length) return result;
    atomicWrite(path.join(this.dir, 'import-map.json'), JSON.stringify(result.map, null, 2));
    this.importState = readImportState(this.target);
    this.sourceCols = loadRequirementColumns(this.target.specsDir, this.target.slug);
    return result;
  }
  saveQueued() { atomicWrite(path.join(this.dir, 'queued.json'), JSON.stringify(this.queued, null, 2)); }
  saveProposed() { atomicWrite(path.join(this.dir, 'proposed.json'), JSON.stringify(this.proposed, null, 2)); }
  saveSnapshots() { atomicWrite(path.join(this.dir, 'snapshot.json'), JSON.stringify(this.snapshots)); }
  /** Durable manifest for the agent batch queue - independent of `queued.json` (deferred page writes). */
  saveQueue() { atomicWrite(path.join(this.dir, 'queue.json'), JSON.stringify({ pending: this.queue.map(b => b.id), inFlight: this.run ? this.run.id : null }, null, 2)); }
  /** Idle-shutdown clock: batch enqueue, poll, agent reply, page write. Heartbeats never touch this. */
  touch() { this.lastActivity = Date.now(); }

  // --- SSE
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) { try { c.write(payload); } catch { this.clients.delete(c); } }
  }

  pendingOf(model) {
    if (!model) return { ticks: [], answers: [], count: 0 };
    try { const p = pending(model) || {}; return { ticks: p.ticks || [], answers: p.answers || [], count: Number(p.count || 0) }; } catch { return { ticks: [], answers: [], count: 0 }; }
  }

  info() {
    const meta = this.model?.meta || null;
    return {
      slug: this.target.slug, dir: this.rel(this.dir), port: this.port, url: this.url,
      started: this.state.started, resumed: this.state.resumed, batches: this.state.batches, lastBatch: this.state.lastBatch,
      agent: { present: this.agentPresent, everPolled: this.everPolled, lastPoll: this.lastPoll ? new Date(this.lastPoll).toISOString() : null, timeout: this.opts.agentTimeout },
      lock: this.lock, run: this.run ? { id: this.run.id, kind: this.run.kind, stage: this.run.stage || null } : null, queue: this.queue.map(b => b.id),
      grace: this.opts.grace, queuedWrites: this.queued.length,
      analysis: this.target.analysis, source: this.target.source, exists: this.text != null,
      parseError: this.parseError,
      doc: { status: meta?.status ?? null, confidence: meta?.confidence ?? null, updated: meta?.updated ?? null, rows: meta?.counts?.rows ?? null, pending: this.model ? this.pendingOf(this.model).count : null, gateNow: meta ? Boolean(meta.exportState?.gateNow) : null },
    };
  }

  runEvent(state, extra = {}) {
    this.broadcast('run', { state, batch: extra.batch ?? this.run?.id ?? null, kind: extra.kind ?? this.run?.kind ?? null, stage: extra.stage ?? this.run?.stage ?? null, lock: this.lock, queue: this.queue.map(b => b.id), active: this.run?.id || null, ...extra });
  }

  // --- batches
  enqueue(body) {
    const kind = body.kind;
    if (!KINDS[kind]) throw httpError(400, 'invalid kind');
    const notes = Array.isArray(body.notes) ? body.notes : [];
    const chat = String(body.chat || '').trim();
    if (kind === 'batch' && !notes.length && !chat) throw httpError(400, 'batch is empty');
    if (kind === 'analyze' && this.model && !body.force) throw httpError(400, `${this.target.analysis} already exists; send force to re-analyse`);
    if (kind === 'analyze' && !this.target.source && !this.model) throw httpError(400, 'no source file to analyse');
    if (kind === 'export') {
      const gate = this.model?.meta?.exportState;
      if (!gate?.gateNow) throw httpError(409, 'not ready to submit', { reasons: this.model?.meta?.readyGate?.reasons || (this.model ? ['gate not met'] : ['analysis missing']) });
    }
    const stage = typeof body.stage === 'string' ? body.stage.trim().slice(0, 120) : null;
    const p = this.pendingOf(this.model);
    const id = `${KINDS[kind]}-${++this.batchSeq}`;
    const file = path.join(this.dir, 'batches', `${id}.json`);
    const batch = { id, kind, sentAt: now(), session: this.url, analysis: this.target.analysis, source: this.target.source, slug: this.target.slug, notes, chat, stage: stage || null, pending: { ticks: p.ticks, answers: p.answers, proposals: [...this.proposed] }, context: this.rel(path.join(this.dir, 'chat.jsonl')), file: this.rel(file) };
    // Absolute twins for the agent, which has no reason to share our cwd.
    batch.root = this.root;
    batch.fileAbs = this.abs(batch.file);
    batch.contextAbs = this.abs(batch.context);
    batch.analysisAbs = this.abs(batch.analysis);
    if (batch.source) batch.sourceAbs = this.abs(batch.source);
    if (body.force) batch.force = true;
    // Only an import batch carries this, so every other batch descriptor is unchanged.
    if (body.importMap) batch.importMap = this.rel(body.importMap);
    atomicWrite(file, JSON.stringify(batch, null, 2));
    this.queue.push(batch);
    this.saveQueue();
    this.touch();
    this.state.lastBatch = id; this.state.batches++;
    this.chatAppend({ type: 'batch', id, kind, notes, chat, pending: { ticks: p.ticks.length, answers: p.answers.length, proposals: this.proposed.length }, queued: Boolean(this.run) });
    this.runEvent('queued', { batch: id, kind });
    this.saveState();
    this.wakeWaiters();
    return batch;
  }

  wakeWaiters() {
    if (!this.waiters.length) return;
    const next = this.reserveForAgent();
    if (!next) return;
    const w = this.waiters.shift();
    clearTimeout(w.timer);
    w.resolve(next);
  }

  /**
   * Dequeue the next batch if no run is active; starts the run (lock + snapshot) as an
   * unacknowledged reservation. If a run is already active but was never acked (the agent
   * that took it never reached one of the `/api/agent/*` endpoints - killed, disconnected,
   * whatever) the SAME batch is handed out again instead of `null`, so a poll can never see
   * `idle` while work is silently stuck behind a run nobody is working on. A run that IS
   * acked falls through to the waiter/idle path exactly as before.
   */
  reserveForAgent() {
    if (this.closing) return { event: 'closed' };
    if (this.run) {
      if (this.run.acked === true) return null;
      if (!this.run.redelivered) {
        this.run.redelivered = true;
        this.chatAppend({ type: 'system', text: `run ${this.run.id} redelivered: the previous delivery was never acknowledged`, batch: this.run.id });
      }
      return { event: 'batch', batch: this.run.batch };
    }
    if (!this.queue.length) return null;
    const batch = this.queue.shift();
    this.reload('reload');
    this.run = { id: batch.id, kind: batch.kind, stage: batch.stage || null, startedAt: Date.now(), changed: new Set(), warned: false, acked: false, batch, redelivered: false };
    this.lock = batch.id;
    this.snapshots = this.text != null ? { ...snapshot(this.text, { proposed: [...this.proposed] }), status: statusMap(this.model) } : null;
    this.saveSnapshots();
    this.saveQueue();
    this.runEvent('started', { batch: batch.id, kind: batch.kind, stage: batch.stage || null });
    this.saveState();
    return { event: 'batch', batch };
  }

  /** Undoes a reservation the agent never received: puts the batch back at the front of the queue. */
  releaseReservation() {
    // An acked run is being worked on by an agent that did receive the batch: a second,
    // redelivered poll dropping its socket must not wipe the live run and release its lock.
    if (!this.run || this.run.acked === true) return;
    const batch = this.run.batch;
    this.queue.unshift(batch);
    this.run = null;
    this.lock = null;
    this.snapshots = null;
    this.saveSnapshots();
    this.saveQueue();
    this.runEvent('queued', { batch: batch.id, kind: batch.kind });
    this.saveState();
  }

  /** Marks the active run as received; called only from the `/api/agent/*` endpoints. */
  ackRun() { if (this.run) this.run.acked = true; }

  waitForAgent(waitSec) {
    const immediate = this.reserveForAgent();
    if (immediate) return Promise.resolve(immediate);
    return new Promise(resolve => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve({ event: this.closing ? 'closed' : 'idle' }); }, Math.max(1, Math.min(waitSec, 3600)) * 1000);
      this.waiters.push(w);
    });
  }

  /** Common tail of reply and abort: unlock, apply queued writes, prune consumed proposals, wake the loop. */
  finishRun(extra = {}) {
    const finished = this.run.id;
    const kind = this.run.kind;
    this.run = null;
    this.lock = null;
    this.snapshots = null;
    this.saveSnapshots();
    this.saveQueue();
    this.runEvent('finished', { batch: finished, kind, ...extra });
    this.saveState();
    this.applyQueued();
    this.pruneProposed();
    setTimeout(() => this.wakeWaiters(), 10);
    return finished;
  }

  abortRun(reason) {
    if (!this.run) return null;
    const id = this.run.id;
    this.chatAppend({ type: 'system', text: `run ${id} aborted: ${reason}`, batch: id });
    this.reload('abort');
    this.finishRun({ aborted: true });
    return id;
  }

  /** Final agent reply: verify + repair the file against the run snapshot, diff, unlock. */
  reply(body) {
    this.touch();
    const batchId = body.batch || this.run?.id;
    const md = body.markdown || body.text || '';
    if (!this.run || (batchId && batchId !== this.run.id)) {
      const entry = this.chatAppend({ type: 'reply', batch: batchId || null, md, changed: [], orphan: true });
      return { ok: true, orphan: true, entry };
    }
    if (body.abort) return { ok: true, aborted: true, batch: this.abortRun(md || 'aborted by agent') };
    const kind = this.run.kind;
    let repairs = [], warnings = [], changed = [], added = [], removed = [];
    let text = readText(this.file);
    if (text != null && this.snapshots) {
      const r = verifyAndRepair(text, this.snapshots);
      repairs = r.repairs || []; warnings = r.warnings || [];
      if (repairs.length && r.text !== text) { atomicWrite(this.file, r.text); text = r.text; }
      const before = this.snapshots.hashes instanceof Map ? Object.fromEntries(this.snapshots.hashes) : (this.snapshots.hashes || {});
      const model = parse(text, { path: this.target.analysis });
      for (const b of collect(model.blocks)) {
        if (!(b.id in before)) added.push(b.id);
        else if (before[b.id] !== b.hash) changed.push(b.id);
      }
      for (const id of Object.keys(before)) if (!findBlock(model, id)) removed.push(id);
      const after = statusMap(model), was = this.snapshots.status || {};
      for (const [id, st] of Object.entries(was)) if (id in after && after[id] !== st && !changed.includes(id)) changed.push(id);
    }
    for (const id of this.run.changed) if (!changed.includes(id) && !added.includes(id)) changed.push(id);
    const d = this.reload('reply', { force: true, extra: { changed, added, removed } }) || { changed, added, removed };
    changed = d.changed; added = d.added; removed = d.removed;
    const entry = this.chatAppend({ type: 'reply', batch: batchId, kind, md, changed: [...changed, ...added], removed, repairs, warnings });
    this.finishRun();
    return { ok: true, batch: batchId, kind, changed, added, removed, repairs, warnings, entry };
  }

  /** Drop page-proposed ids whose line was consumed by a reconcile (no longer `[ ]`) or removed. */
  pruneProposed() {
    if (!this.proposed.length) return;
    const keep = this.proposed.filter(id => {
      const b = this.model ? findBlock(this.model, id) : null;
      if (!b) return false;
      if (typeof b.status?.state === 'string') return b.status.state === 'proposed';
      const cells = Array.isArray(b.cells) ? b.cells : [];
      return cells.length > 0 && String(cells[cells.length - 1]).trim() === '[ ]';
    });
    if (keep.length !== this.proposed.length) { this.proposed = keep; this.saveProposed(); }
  }

  // --- direct writes (no agent)
  validateWrite(q) {
    if (q.type === 'tick') {
      if (!q.id || typeof q.id !== 'string') throw httpError(400, 'id required');
      if (!TICKS.includes(q.value)) throw httpError(400, "value must be ' ', 'x' or '-'");
    } else if (q.type === 'answer') {
      if (!q.qid || typeof q.qid !== 'string') throw httpError(400, 'qid required');
      if (q.option != null && !/^[A-Z]$/.test(String(q.option))) throw httpError(400, 'option must be a single letter');
    } else if (q.type === 'propose') {
      if (!q.statement || !String(q.statement).trim()) throw httpError(400, 'statement required');
      if (q.kind != null && !['assume', 'exclude'].includes(q.kind)) throw httpError(400, "kind must be 'assume' or 'exclude'");
    } else throw httpError(400, 'unknown write type');
  }

  /** Re-reads the file, applies one primitive, writes atomically and reloads. */
  applyWrite(q) {
    const text = readText(this.file);
    if (text == null) return { changed: false, reason: 'analysis missing' };
    let r;
    if (q.type === 'tick') r = tickLine(text, q.id, q.value);
    else if (q.type === 'answer') r = answerQuestion(text, q.qid, { option: q.option ?? null, other: q.other ?? null });
    else r = proposeLine(text, { row: q.row || null, statement: String(q.statement).trim(), pdSaved: q.pdSaved ?? null, cls: q.cls ?? null, riskTo: q.riskTo ?? null, rows: q.rows ?? null, kind: q.kind || 'assume' });
    if (!r || !r.changed) return { changed: false, reason: r?.reason || 'not changed' };
    this.touch();
    atomicWrite(this.file, r.text);
    // page-proposed tracking (repair-on-run-abort, pruning) is for tickable `[ ]` lines only; an
    // exclude X-n line is a settled fact the moment it lands, not something pending reconciliation.
    if (q.type === 'propose' && r.id && (q.kind || 'assume') !== 'exclude') { this.proposed.push(r.id); this.saveProposed(); }
    this.reload(q.type, { extra: q.type === 'propose' ? { added: [r.id] } : { changed: [r.id || q.id || q.qid] } });
    return { changed: true, id: r.id, line: r.line };
  }

  /** HTTP entry: 202 while locked, 200 when applied, 409 when the primitive refused (frozen / not found). */
  directWrite(q) {
    this.validateWrite(q);
    if (this.lock) {
      if (q.type === 'tick') this.queued = this.queued.filter(x => !(x.type === 'tick' && x.id === q.id));
      if (q.type === 'answer') this.queued = this.queued.filter(x => !(x.type === 'answer' && x.qid === q.qid));
      this.queued.push({ ...q, t: now() });
      this.saveQueued();
      this.broadcast('queued', { count: this.queued.length });
      return { status: 202, body: { queued: true, lockedBy: this.lock } };
    }
    const r = this.applyWrite(q);
    if (!r.changed) return { status: /missing|not found|unknown/i.test(r.reason) || r.reason === 'frozen' ? 409 : 400, body: { error: r.reason, reason: r.reason } };
    return { status: 200, body: { changed: true, id: r.id, line: r.line } };
  }

  applyQueued() {
    if (!this.queued.length) { this.broadcast('queued', { count: 0 }); return; }
    const mine = this.queued;
    this.queued = [];
    this.saveQueued();
    let applied = 0;
    for (const q of mine) {
      try {
        const r = this.applyWrite(q);
        if (r.changed) applied++;
        else this.chatAppend({ type: 'system', text: `queued ${q.type} on ${writeTarget(q)} dropped: ${r.reason}` });
      } catch (e) { this.chatAppend({ type: 'system', text: `queued ${q.type} on ${writeTarget(q)} dropped: ${e.message}` }); }
    }
    if (applied) this.chatAppend({ type: 'system', text: `applied ${applied} queued change(s)` });
    this.broadcast('queued', { count: 0 });
  }

  // --- lifecycle
  beat() { this.lastBeat = Date.now(); }
  tick() {
    const t = Date.now();
    if (t - this.lastBeat > this.opts.grace * 1000) { this.shutdown('heartbeat timeout'); return; }
    if (this.opts.idle && t - this.lastActivity > this.opts.idle * 1000) { this.shutdown('idle'); return; }
    const present = this.lastPoll > 0 && t - this.lastPoll < this.opts.agentTimeout * 1000;
    if (present !== this.agentPresent) {
      this.agentPresent = present;
      this.broadcast('agent', { present, everPolled: this.everPolled });
      this.saveState();
      if (!present && this.run && !this.run.warned) {
        this.run.warned = true;
        this.chatAppend({ type: 'system', text: `agent disconnected during run ${this.run.id}; the run stays open until its reply or Stop`, batch: this.run.id });
      }
    }
  }
  polled() {
    this.touch();
    this.lastPoll = Date.now(); this.everPolled = true;
    if (!this.agentPresent) { this.agentPresent = true; this.broadcast('agent', { present: true, everPolled: true }); this.saveState(); }
  }

  shutdown(reason) {
    if (this.closing) return;
    this.closing = true;
    this.log(`closing: ${reason}`);
    this.state.ended = now(); this.state.endReason = reason;
    try { this.chatAppend({ type: 'system', text: `session closed (${reason})` }); this.saveState(); } catch (e) { this.log('shutdown: cannot persist', e.message); }
    this.broadcast('closing', { reason });
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve({ event: 'closed' }); }
    this.waiters = [];
    try { fs.unlinkSync(path.join(this.dir, 'session.lock')); } catch { /* gone */ }
    for (const c of this.clients) { try { c.end(); } catch { /* ignore */ } }
    if (this.watcher) try { this.watcher.close(); } catch { /* ignore */ }
    clearTimeout(this.watchTimer);
    clearInterval(this.timer); clearInterval(this.keepalive);
    setTimeout(() => { this.server?.close(); this.server?.closeAllConnections?.(); setTimeout(() => process.exit(0), 200).unref(); }, 150);
  }

  watch() {
    const mine = path.basename(this.file);
    try {
      this.watcher = fs.watch(this.target.specsDir, { persistent: true }, (ev, name) => {
        if (!name) return;
        const base = String(name);
        if (base.endsWith('.tmp') || base !== mine) return;
        clearTimeout(this.pendingWatch.get(base));
        this.pendingWatch.set(base, setTimeout(() => { this.pendingWatch.delete(base); this.reload('reload'); }, 150));
      });
      this.watcher.on('error', e => this.watchFailed(e));
      if (this.watchAttempt) { this.watchAttempt = 0; this.chatAppend({ type: 'system', text: 'file watching resumed' }); }
    } catch (e) { this.watchFailed(e); }
  }

  /**
   * A watch error - EMFILE under file-descriptor pressure is the one seen in the
   * wild - arrives asynchronously on the FSWatcher, where an unhandled 'error'
   * event would kill the process. Degrade instead: drop the dead watcher, say so
   * once on the page, and try again a few times. Agent replies reload the
   * analysis explicitly, so only edits made outside the page go stale meanwhile.
   */
  watchFailed(e) {
    if (this.closing) return;
    this.log('watch error', e.message);
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } this.watcher = null; }
    const delays = this.opts.watchRetry || WATCH_RETRY;
    const delay = delays[this.watchAttempt++];
    if (delay == null) { this.chatAppend({ type: 'system', text: `file watching gave up after ${delays.length} attempts (${e.message}); reload the page after editing the analysis outside it` }); return; }
    if (this.watchAttempt === 1) this.chatAppend({ type: 'system', text: `file watching stopped (${e.message}); edits made outside the page are not picked up while it retries` });
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => this.watch(), delay);
    this.watchTimer.unref?.();
  }
}

// ---------------------------------------------------------------------------
// HTTP

/** `cb`, when given, fires once the response has actually flushed - see GET /api/next. */
function send(res, status, body, type = 'application/json; charset=utf-8', cb) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data, cb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 5 * 1024 * 1024) { reject(httpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(httpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}

function serveStatic(res, file) {
  let data;
  try { data = fs.readFileSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

async function handle(session, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/{2,}/g, '/');
  const m = req.method;
  try {
    if (m === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, path.join(PAGE_DIR, 'index.html'));
    if (m === 'GET' && p === '/page/lib/calc.mjs') return serveStatic(res, CALC_FILE);
    if (m === 'GET' && p.startsWith('/page/')) {
      const f = path.resolve(PAGE_DIR, '.' + p.slice(5));
      if (!f.startsWith(PAGE_DIR)) return send(res, 403, { error: 'forbidden' });
      return serveStatic(res, f);
    }
    if (m === 'GET' && p === '/health') {
      return send(res, 200, { name: PKG_JSON.name, version: PKG_JSON.version, pid: process.pid, slug: session.target.slug, url: session.url, started: session.state.started });
    }
    if (m === 'GET' && p === '/api/session') {
      return send(res, 200, { session: session.info(), analysis: session.target.analysis, source: session.target.source, model: session.model, meta: session.model?.meta ?? null, parseError: session.parseError, notes: session.notes(), chat: session.chatHistory(), queued: session.queued, proposed: session.proposed, sourceColumns: session.sourceCols, importState: session.importState });
    }
    if (m === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ session: session.info() })}\n\n`);
      session.clients.add(res);
      session.beat();
      req.on('close', () => session.clients.delete(res));
      return;
    }
    if (m === 'POST' && p === '/api/heartbeat') { await readBody(req).catch(() => ({})); session.beat(); return send(res, 200, { ok: true, agent: { present: session.agentPresent }, run: session.info().run, lock: session.lock }); }
    if (m === 'POST' && p === '/api/notes') {
      const body = await readBody(req);
      session.touch();
      session.saveNotes(Array.isArray(body.notes) ? body.notes : []);
      session.broadcast('notes', { notes: body.notes || [], tab: body.tab || null });
      return send(res, 200, { ok: true });
    }
    // One sheet's full grid, for the steering screen's "show every row".
    if (m === 'GET' && p.startsWith('/api/import/sheet/')) {
      const sheet = readImportSheet(session.target, p.slice('/api/import/sheet/'.length));
      if (!sheet) throw httpError(404, 'no such sheet in the import snapshot');
      return send(res, 200, { sheet });
    }
    // The steering screen's draft: saved on every change, so a reload never loses the mapping.
    if (m === 'POST' && p === '/api/import/map') {
      const body = await readBody(req);
      const state = session.saveImportMap(body.map);
      if (state.problems?.length) return send(res, 400, { error: 'the mapping is not usable', problems: state.problems });
      session.broadcast('import', { importState: state, tab: body.tab || null });
      return send(res, 200, { ok: true, importState: state });
    }
    // Confirming writes the normalised CSVs and the committed map, then hands the agent one
    // ordinary batch: `kind: batch`, `stage: import`. No new batch kind, no new protocol.
    if (m === 'POST' && p === '/api/import/confirm') {
      const body = await readBody(req);
      let result;
      try {
        result = session.confirmImport(body.map);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      if (result.problems?.length) return send(res, 400, { error: 'the mapping is not usable', problems: result.problems });
      const batch = session.enqueue({
        kind: 'batch',
        stage: 'import',
        chat: [`Mapping confirmed: ${result.summary}`],
        importMap: result.mapPath,
      });
      session.broadcast('import', { importState: session.importState });
      session.broadcast('doc', { reason: 'reload', model: session.model, meta: session.model?.meta ?? null });
      return send(res, 200, { ok: true, written: result.written, batch });
    }
    if (m === 'POST' && (p === '/api/tick' || p === '/api/answer' || p === '/api/propose')) {
      const body = await readBody(req);
      const r = session.directWrite({ ...body, type: p.slice(5) });
      return send(res, r.status, r.body);
    }
    if (m === 'POST' && p === '/api/batch') {
      const body = await readBody(req);
      const batch = session.enqueue(body);
      if (body.kind === 'batch') session.saveNotes(Array.isArray(body.remaining) ? body.remaining : []);
      return send(res, 200, { id: batch.id, file: batch.file, queued: Boolean(session.run) && session.run.id !== batch.id });
    }
    if (m === 'POST' && p === '/api/run/abort') {
      const body = await readBody(req);
      const id = session.abortRun(body.reason || 'aborted from the page');
      return send(res, 200, { ok: true, aborted: id });
    }
    if (m === 'POST' && p === '/api/close') { send(res, 200, { ok: true }); session.shutdown('closed by request'); return; }
    if (m === 'GET' && p === '/api/lock') return send(res, 200, { lock: session.lock, run: session.info().run, agent: session.info().agent, queue: session.queue.map(b => b.id) });
    // --- agent endpoints
    if (m === 'GET' && p === '/api/next') {
      session.polled();
      const wait = Number(url.searchParams.get('wait') || 30);
      // A reservation is only committed once the agent actually received it - not once the
      // socket accepted our bytes. If the connection closes before that, the batch goes back
      // to the front of the queue; if it closes AFTER (but the agent never reached one of the
      // /api/agent/* endpoints to ack it), reserveForAgent() redelivers the same run instead.
      let flushed = false;
      req.on('close', () => { if (!flushed) session.releaseReservation(); });
      const r = await session.waitForAgent(wait);
      session.polled();
      return send(res, 200, r, undefined, () => { flushed = true; });
    }
    if (m === 'POST' && p === '/api/agent/progress') {
      const body = await readBody(req);
      session.polled();
      session.ackRun();
      const entry = session.chatAppend({ type: 'progress', batch: body.batch || session.run?.id || null, text: body.text || body.markdown || '' });
      session.broadcast('progress', entry);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/agent/chat') {
      const body = await readBody(req);
      session.polled();
      session.ackRun();
      session.chatAppend({ type: 'reply', batch: body.batch || session.run?.id || null, md: body.markdown || body.text || '', changed: [], interim: true });
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/agent/reply') {
      const body = await readBody(req);
      session.polled();
      session.ackRun();
      return send(res, 200, session.reply(body));
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) session.log('error', e.stack || e.message);
    return send(res, status, { error: e.message, ...(e.extra || {}) });
  }
}

export function startServer(opts) {
  const session = new Session(opts);
  const server = http.createServer((req, res) => handle(session, req, res));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      session.server = server;
      session.port = server.address().port;
      session.url = `http://127.0.0.1:${session.port}/`;
      atomicWrite(path.join(session.dir, 'session.lock'), JSON.stringify({ pid: process.pid, port: session.port, url: session.url, started: session.state.started, analysis: session.target.analysis }, null, 2));
      session.saveState();
      session.watch();
      session.timer = setInterval(() => session.tick(), 5000);
      session.keepalive = setInterval(() => { for (const c of session.clients) { try { c.write(': ka\n\n'); } catch { /* ignore */ } } }, 15000);
      session.chatAppend({ type: 'system', text: session.state.resumed ? `session resumed on ${session.url}` : `session started on ${session.url}` });
      process.on('SIGINT', () => session.shutdown('SIGINT'));
      process.on('SIGTERM', () => session.shutdown('SIGTERM'));
      resolve(session);
    });
  });
}

// ---------------------------------------------------------------------------

/**
 * `status` - what the skills used to read from `GET /api/session`.
 *
 * Compact lines first, the whole session model only behind --json, so the
 * common case costs an agent a few lines instead of the entire analysis.
 */
async function status(opts, target, analysisExists) {
  const lock = await liveLock(target.sessionDir);
  out.line('running', String(Boolean(lock)));
  out.line('slug', target.slug);
  out.line('analysis', `${target.analysis} (${analysisExists ? 'found' : 'missing'})`);
  out.line('source', target.source || 'none');
  out.line('session_dir', path.relative(opts.root, target.sessionDir).split(path.sep).join('/'));
  if (!lock) {
    out.nextStep(`run \`sw-tender-discovery-tool start --doc ${opts.doc}\``);
    return;
  }
  out.line('url', lock.url);
  out.line('pid', String(lock.pid));

  let session = null;
  try {
    const res = await fetch(lock.url + 'api/session');
    if (res.ok) session = await res.json();
  } catch { /* answered api/lock a moment ago; treat a failure here as "no detail" */ }

  if (session) {
    out.line('status', session.meta?.status || 'unknown');
    out.line('confidence', String(session.meta?.confidence ?? 'n/a'));
    const p = session.meta?.pending || {};
    out.line('pending', `${p.ticks ?? 0} ticks, ${p.answers ?? 0} answers, ${p.proposals ?? 0} proposals`);
    out.line('notes_unsent', String((session.notes || []).length));
    out.line('queued', String(Object.values(session.queued || {}).flat().length));
    out.line('agent_present', String(Boolean(session.session?.agent?.present)));
    out.line('run_active', String(session.session?.run?.id || 'none'));
    if (session.parseError) out.line('parse_error', session.parseError);
  }
  out.nextStep('run `sw-tender-discovery-tool poll` to wait for the next batch');
  if (opts.json && session) out.payload(session);
}

export async function main(argv) {
  const opts = parseArgs([...argv]);
  if (!opts.doc) out.usage('usage: sw-tender-discovery-tool start|status|stop --doc specs/rfp-NNNN-slug-analysis.md | specs/rfp-NNNN-slug.csv [--port N] [--grace S] [--agent-timeout S] [--foreground]');
  // A document from another tree would otherwise open a second session whose
  // state lands outside the root every other command will look in.
  const strayDoc = outsideRoot(opts.root, opts.doc);
  if (strayDoc) out.usage(strayDoc);
  const target = resolveTarget(opts.root, opts.doc);
  if (!target) out.usage(`cannot derive the slug from ${opts.doc}: the file name must start with rfp-NNNN-`);
  const analysisExists = fs.existsSync(path.resolve(opts.root, target.analysis));
  const sourceExists = Boolean(target.source) && fs.existsSync(path.resolve(opts.root, target.source));

  if (opts.cmd === 'status') return status(opts, target, analysisExists);
  if (opts.cmd === 'stop') {
    const lock = await liveLock(target.sessionDir);
    if (!lock) { out.line('running', 'false'); out.nextStep('nothing to stop'); return; }
    await fetch(lock.url + 'api/close', { method: 'POST' }).catch(() => {});
    out.line('stopped', lock.url);
    out.nextStep('the session is closed; summarise it for the user');
    return;
  }
  if (!analysisExists && !sourceExists) out.usage(`neither ${target.analysis} nor ${target.source || `${target.slug}.{${SOURCE_EXT.join(',')}}`} exists`);

  const live = await liveLock(target.sessionDir);
  if (live) {
    // A matching version (or an older server with no /health at all) reattaches exactly as
    // before. A differing version is stopped first, so an upgraded harness never reattaches
    // to a stale process running the old contract.
    let health = null;
    try {
      const r = await fetch(live.url + 'health');
      if (r.ok) health = await r.json();
    } catch { /* no /health: treat like a matching version below */ }
    if (health && health.version && health.version !== PKG_JSON.version) {
      await fetch(live.url + 'api/close', { method: 'POST' }).catch(() => {});
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await liveLock(target.sessionDir))) await new Promise(r => setTimeout(r, 100));
      // fall through: start a fresh server below
    } else {
      console.log(`TENDER_TOOL_URL=${live.url}`);
      out.line('reattached', `pid ${live.pid}`);
      out.nextStep('run `sw-tender-discovery-tool guide` if you have not yet, then `sw-tender-discovery-tool poll`');
      return;
    }
  }
  if (opts.foreground) {
    const s = await startServer(opts);
    console.log(`TENDER_TOOL_URL=${s.url}`);
    out.line('analysis', `${target.analysis} (${analysisExists ? 'found' : 'missing'})`);
    out.line('source', `${target.source || 'none'}${target.source ? ` (${sourceExists ? 'found' : 'missing'})` : ''}`);
    out.nextStep('run `sw-tender-discovery-tool guide` if you have not yet, then `sw-tender-discovery-tool poll`');
    return;
  }
  // detach
  fs.mkdirSync(target.sessionDir, { recursive: true });
  try { fs.unlinkSync(path.join(target.sessionDir, 'session.lock')); } catch { /* none */ }
  const logFile = fs.openSync(path.join(target.sessionDir, 'server.log'), 'a');
  const args = [cliPath(), 'start', '--foreground', '--root', opts.root, '--doc', opts.doc, '--grace', String(opts.grace), '--agent-timeout', String(opts.agentTimeout), '--idle', String(opts.idle)];
  if (opts.port) args.push('--port', String(opts.port));
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFile, logFile], cwd: opts.root });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const lock = readLock(target.sessionDir);
    if (lock && lock.pid === child.pid && lock.url) {
      console.log(`TENDER_TOOL_URL=${lock.url}`);
      out.line('pid', String(child.pid));
      out.line('log', path.relative(opts.root, path.join(target.sessionDir, 'server.log')));
      out.nextStep(`open ${lock.url} for the user, then run \`sw-tender-discovery-tool guide\` and follow it`);
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  out.unreachable('server did not start within 8 s; see server.log');
}
