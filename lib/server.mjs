// Tender Discovery Tool server - zero-dependency Node http server. Build contract §4 (Page API).
//
//   sw-tender-discovery-tool start  --doc specs/rfp-NNNN-slug-analysis.md | specs/rfp-NNNN-slug.csv|.xlsx|.pdf [--port N] [--grace 60] [--agent-timeout 180] [--foreground] [--no-intake]
//   sw-tender-discovery-tool status --doc <analysis or source path> [--json]
//   sw-tender-discovery-tool stop   --doc <analysis or source path>
//
// Entry point is bin/cli.mjs. This module exports main(argv) and never reads
// process.argv itself, so it works the same through an npx `.bin` symlink.
//
// `start` prints `TENDER_TOOL_URL=<url>` and returns; the server itself runs detached
// (unless --foreground) and exits on heartbeat timeout or POST /api/close. Opening a source with
// no working document yet queues the opening `intake` batch itself (Session#maybeEnqueueIntake),
// once per session (a reattach or restart never adds a second one); `--no-intake` opts out and
// leaves the page's "Start intake" button as the only way to start it.
// Operator writes (confirm / proposal accept-reject / patch / answer / assumption / profile)
// go through lib/ops.mjs; while an agent run holds the lock they are queued and applied after
// the agent's reply, exactly as before (D-19: the mechanism is unchanged, only what it writes).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, slugFromPath, analysisPathFor } from './parse.mjs';
import { diff } from './diff.mjs';
import { snapshot, verifyAndRepair } from './edit.mjs';
import { totals as calcTotals, readiness as calcReadiness, isReady, hasAnalyzeWork as calcHasAnalyzeWork, nextAnalyzeItems } from './calc.mjs';
import { exportText, resolveTable } from './export-text.mjs';
import { readProfile, regime as regimeOf, PROFILE_REL_PATH } from './profile.mjs';
import * as proposals from './proposals.mjs';
import * as ops from './ops.mjs';
import * as importMapMod from './import-map.mjs';
import { readLock, liveLock } from './session.mjs';
import { settle, outsideRoot } from './paths.mjs';
import * as out from './out.mjs';

// `lib/import-map.mjs`'s `readFitBack` and `lib/import-export.mjs`'s `importSource` are WP-3
// (in-flight alongside this change): every call into them is guarded so a shape they have not
// landed yet degrades instead of crashing this session. `import-map.mjs` itself is stable (WP-1/2
// already landed it), so it is imported statically; `import-export.mjs` is being edited on both
// its import and export sides right now, so it is only ever reached through a lazy `import()`,
// exactly as the existing `/api/export` route already does.
function safeReadFitBack(root, source) {
  if (typeof importMapMod.readFitBack !== 'function' || !source) return null;
  try { return importMapMod.readFitBack(root, source) || null; } catch { return null; }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.join(HERE, '..', 'page');

/** Backoff between attempts to re-establish the file watcher after it errors. */
const WATCH_RETRY = [2000, 5000, 15000];
const LIB_FILES = { 'parse.mjs': 'parse.mjs', 'calc.mjs': 'calc.mjs', 'export-text.mjs': 'export-text.mjs', 'profile.mjs': 'profile.mjs' };
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
const KINDS = { intake: 'i', analyze: 'a', reestimate: 'r', notes: 'n', export: 'e' };
const SOURCE_EXT = ['csv', 'md', 'txt', 'pdf', 'xlsx'];

// ---------------------------------------------------------------------------
// CLI

/** How long the session stays reconnectable after the page's heartbeat stops arriving, before
 * `poll` finally reports `closed` and the process exits: a closed tab, a reload or a laptop
 * sleep gets this long to come back to the same port, lock, queue and chat. Overridable, like
 * `TENDER_TOOL_PORT`, so a test can shorten it instead of waiting minutes. */
const DEFAULT_CLOSE_GRACE_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const o = { cmd: argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'start', doc: null, port: Number(process.env.TENDER_TOOL_PORT || 0), grace: 60, agentTimeout: 180, idle: 14400, closeGraceMs: Number(process.env.TENDER_TOOL_CLOSE_GRACE_MS || DEFAULT_CLOSE_GRACE_MS), foreground: false, json: false, rootFlag: '', root: '', intake: true };
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
    else if (a === '--no-intake') o.intake = false;
    else if (!a.startsWith('--')) o.doc = a;
    else out.usage(`unknown flag ${a}`);
  }
  // The root comes from the document, not from wherever the agent ran this.
  return settle(o);
}

/** #10: the analysis document's own frontmatter `source-sha256` (contract §1, the same list
 * `import-export.mjs:exportWorkbook` reads) names the actual source file — the authority, when
 * the document exists and parses. `<slug>.<ext>` guessing below is only the fallback for a
 * session that has no document yet (before the first `intake`), or one that fails to parse. */
function sourceFromFrontmatter(root, dir, analysisAbs) {
  if (!fs.existsSync(analysisAbs)) return null;
  let model;
  try { model = parse(fs.readFileSync(analysisAbs, 'utf8'), { path: analysisAbs }); } catch { return null; }
  const sources = Object.keys(model.frontmatter?.data?.['source-sha256'] || {});
  if (!sources.length) return null;
  return path.posix.join(dir, sources[sources.length - 1]);
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
    const named = sourceFromFrontmatter(root, dir, path.resolve(root, analysis));
    if (named && fs.existsSync(path.resolve(root, named))) source = named;
  }
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

const LIFECYCLE = /^session (started|resumed) on |^session closed \(/;

/**
 * The chat log is append-only and shared by every session on a document, so a
 * restarted document carries one start/close banner per past run, all pointing at
 * dead ports. Keep the conversation itself, keep the newest banner, and mark each
 * older boundary with a single divider.
 */
export function collapseSessions(lines) {
  const last = lines.findLastIndex(e => e.type === 'system' && LIFECYCLE.test(e.text || ''));
  const out = [];
  lines.forEach((e, i) => {
    if (i === last || e.type !== 'system' || !LIFECYCLE.test(e.text || '')) { out.push(e); return; }
    if (e.text.startsWith('session closed')) return;
    if (!out.length || out[out.length - 1].type === 'divider') return;
    out.push({ type: 'divider', text: 'previous session', t: e.t });
  });
  return out;
}
function httpError(status, message, extra) { const e = new Error(message); e.status = status; e.extra = extra; return e; }

// ---------------------------------------------------------------------------
// Session

const DIRECT_OPS = new Set(['confirm', 'unconfirm', 'proposalAccept', 'proposalReject']);

export class Session {
  constructor(opts) {
    this.opts = opts;
    this.closeGraceMs = Number.isFinite(opts.closeGraceMs) ? opts.closeGraceMs : DEFAULT_CLOSE_GRACE_MS;
    this.pendingClose = null; // { since, reason } while the page is gone but still inside the close grace
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
    const queueManifest = readJson(path.join(this.dir, 'queue.json'), { pending: [], inFlight: null });
    for (const id of [...(queueManifest.inFlight ? [queueManifest.inFlight] : []), ...(queueManifest.pending || [])]) {
      const batch = readJson(path.join(this.dir, 'batches', `${id}.json`), null);
      if (batch) this.queue.push(batch);
    }
    this.settled = new Set(); // ids applied by an analyze run and still `reopened` (unchanged): not re-queued
    this.run = null; // { id, kind, startedAt, changed: Set, warned, acked, batch, redelivered }
    this.lock = null; // batch id while an agent run owns the document
    this.lastBeat = Date.now();
    this.lastActivity = Date.now(); // last batch enqueue / poll / agent reply / page write - heartbeats do not count
    this.lastPoll = 0;
    this.everPolled = false;
    this.agentPresent = false;
    this.queued = readJson(path.join(this.dir, 'queued.json'), []);
    this.snapshots = readJson(path.join(this.dir, 'snapshot.json'), null);
    const prev = readJson(path.join(this.dir, 'session.json'), {});
    this.batchSeq = Number(prev.lastBatchSeq || 0);
    this.state = { slug: this.target.slug, started: now(), ended: null, lastBatch: prev.lastBatch || null, lastBatchSeq: this.batchSeq, batches: Number(prev.batches || 0), resumed: Boolean(prev.started) };
    this.pendingWatch = new Map();
    this.watchAttempt = 0;
    this.importExportMod = null;
    // Loaded once, up front (not only for an xlsx/csv source): every `doc` broadcast needs
    // `sinceExportIds` synchronously (see `sinceExportSync`), so the module must already be cached
    // before the first write, not fetched on demand mid-reload. Fire-and-forget; kept on the
    // instance only so a test can await it.
    this.importExportReady = this.loadImportExportMod();
    this.reload('load', { silent: true });
    this.importFailed = false;
    // Contract §3: an xlsx/csv source with no analysis yet gets its digest built at `start`, the
    // same moment a PDF source is already ready for the agent to read straight away — the page
    // never again waits on an operator mapping step first. Fire-and-forget; kept on the instance
    // only so a test can await it. Chained with `maybeEnqueueIntake` (below): the opening intake
    // batch is queued only once the import has had its chance to run (or degrade), never before.
    this.importReady = this.ensureImported().then(r => { this.maybeEnqueueIntake(); return r; });
    // Backward compatibility (own-tabs contract §3): a document still at `intake: review` from
    // before intake confirmed itself gets auto-confirmed right here, the moment a session opens it
    // — no document is left stuck with no page action to unblock it.
    this.maybeAutoConfirmReview();
    // IN-3/IN-11: a session that (re)starts with intake already confirmed and work still pending
    // (a queued/reopened item, or a reestimate.json mark left over from a previous chunk) queues
    // its next analyze chunk itself — the operator has no button to press any more (#5).
    this.maybeEnqueueAnalyze();
  }

  /** Backward compatibility only (own-tabs contract §3): confirms an old document still at
   * `intake: review` from before intake confirmed itself, reusing `ops.mjs`'s `intakeConfirm`
   * (already a no-op on a document that is not at `review`) — never a second implementation of
   * what confirming means. The reload it triggers is what lets `maybeEnqueueAnalyze` queue the
   * next chunk right after, same as any other out-of-process confirm. */
  maybeAutoConfirmReview() {
    if (!this.model || this.model.frontmatter?.data?.intake !== 'review') return;
    try { ops.intakeConfirm({ root: this.root, doc: this.file }); this.reload('intake-confirm-auto', { silent: true }); }
    catch (e) { this.log('auto intake-confirm failed', e.message); }
  }

  /** The next analyze chunk's ids: star walks via the write-progress set; applied-and-unchanged
   * `reopened` items are skipped unless individually marked. */
  nextChunk() {
    return nextAnalyzeItems(this.model?.items, proposals.reestimateList(this.root, this.slug), undefined,
      { starProgress: proposals.starProgress(this.root, this.slug), skip: this.settled });
  }

  /** Auto-enqueue the next analyze chunk (IN-3/IN-11). Idempotent: does nothing while intake is
   * under review (a legacy document `maybeAutoConfirmReview` has not yet caught up with), while an
   * analyze batch is already queued or running, or when there is no work (`calcHasAnalyzeWork`) —
   * so it is safe to call after every reload (the page's confirm, a CLI `intake-confirm`, a profile
   * save, an answer, an assume/unassume) and at the end of every run. */
  maybeEnqueueAnalyze() {
    if (!this.model) return;
    if (this.model.frontmatter?.data?.intake === 'review') return;
    if (this.run?.kind === 'analyze' || this.queue.some(b => b.kind === 'analyze')) return;
    if (!this.nextChunk().length) return;
    try { this.enqueue({ kind: 'analyze', stage: 'assessing scope items…' }); }
    catch (e) { this.log('maybeEnqueueAnalyze failed', e.message); }
  }

  /** Opening a source with no working document yet starts intake automatically — no skill has to
   * remember to send the batch, and the button on the page stays only as the fallback. Idempotent:
   * a reattach or a restart must never queue a second intake batch, so this is skipped whenever an
   * analysis already exists (`this.model`), an intake batch is already queued or running, or
   * `--no-intake` (`opts.intake === false`) opted out for this session. Also skipped when
   * `ensureImported` itself failed — a broken workbook gets the operator's "Start intake" button
   * and its error, not a batch that would only fail the same way. */
  maybeEnqueueIntake() {
    if (this.opts.intake === false) return;
    if (this.model || this.importFailed) return;
    if (this.run?.kind === 'intake' || this.queue.some(b => b.kind === 'intake')) return;
    try { this.enqueue({ kind: 'intake', stage: 'extracting requirements…' }); }
    catch (e) { this.log('maybeEnqueueIntake failed', e.message); }
  }

  /** `./import-export.mjs`, imported once and cached on the instance: `ensureImported`,
   * `sinceExport` (async, `/api/session`) and `sinceExportSync` (sync, every `doc` broadcast) all
   * share this one load instead of each re-importing. `null` until the file exists at all —
   * degraded call sites keep working exactly as before it landed. */
  async loadImportExportMod() {
    if (this.importExportMod) return this.importExportMod;
    try { this.importExportMod = await import('./import-export.mjs'); } catch { return null; }
    return this.importExportMod;
  }

  log(...a) { out.note([new Date().toISOString().slice(11, 19), ...a].join(' ')); }
  rel(abs) { return path.relative(this.root, abs).split(path.sep).join('/'); }
  abs(rel) { return rel ? path.resolve(this.root, rel) : rel; }

  /** Seam for tests: instance-overridable so a run can be made to fail without touching lib/parse.mjs. */
  parseText(text) { return parse(text, { path: this.target.analysis }); }

  get slug() { return this.model?.slug || this.target.slug; }

  proposalsList() { return proposals.list(this.root, this.slug); }
  readProfileHere() { return { ...readProfile(this.root), path: PROFILE_REL_PATH }; }
  regimeHere() { return regimeOf(this.root); }

  /** `lib/import-map.mjs`'s `readFitBack`, read fresh on every call (never cached on the
   * instance): a `tokens --file` run by the agent out-of-process while this session keeps running
   * must be visible on the very next request, exactly as the confirmed map used to be. `null` for
   * a CSV/PDF source (no fit-back map at all) or before WP-3 lands `readFitBack` itself. */
  fitBack() { return safeReadFitBack(this.root, this.target.source ? this.abs(this.target.source) : null); }

  /** `/api/session`'s `sinceExport` (D-34): ids changed since the last export, `null` before this
   * document has ever been exported. Uses the shared `loadImportExportMod` cache and degrades to
   * `null` until the module lands. */
  async sinceExport() {
    if (!this.model) return null;
    const mod = await this.loadImportExportMod();
    if (!mod || typeof mod.sinceExportIds !== 'function') return null;
    try { return mod.sinceExportIds(this.root, this.slug, this.model.items, this.fitBack()); }
    catch { return null; }
  }

  /** Same as `sinceExport` but synchronous, for every `doc` broadcast (page's "changed since last
   * export" filter, D-34): a page-visible edit — an in-place Client Response/Internal note write,
   * an agent's applied batch — must refresh the filter's baseline the moment the `doc` event
   * arrives, not only on the next full `/api/session` reload. `null` when `loadImportExportMod`
   * has not resolved yet (never awaited here — this must never block a broadcast) or before the
   * document has ever been exported, same as `sinceExport`. */
  sinceExportSync() {
    if (!this.model || !this.importExportMod) return null;
    if (typeof this.importExportMod.sinceExportIds !== 'function') return null;
    try { return this.importExportMod.sinceExportIds(this.root, this.slug, this.model.items, this.fitBack()); }
    catch { return null; }
  }

  /** `/api/session`'s `intake` field (contract §3): review/confirmed state, how many rows the
   * extraction did not take, and which visible sheets the fit-back map never used. */
  intakeInfo() {
    if (!this.model) return { state: null, notTaken: 0, unusedSheets: [] };
    const fitBack = this.fitBack();
    return {
      state: this.model.frontmatter?.data?.intake === 'review' ? 'review' : 'confirmed',
      notTaken: (this.model.notTaken || []).length,
      unusedSheets: fitBack?.unusedSheets || [],
    };
  }

  /** Contract §3: for an xlsx/csv source with no analysis document yet, run the import so the
   * snapshot and digest exist before the agent's opening `intake` batch reads them — mirroring a
   * PDF source, which needs no such pre-processing. Uses the shared `loadImportExportMod` cache and
   * degrades to a no-op until the module lands. */
  async ensureImported() {
    if (this.model || !this.target.source || !/\.(xlsx|csv)$/i.test(this.target.source)) return null;
    const mod = await this.loadImportExportMod();
    if (!mod || typeof mod.importSource !== 'function') return null;
    try { return await mod.importSource({ root: this.root, source: this.abs(this.target.source) }); }
    catch (e) { this.log('ensureImported failed', e.message); this.importFailed = true; return null; }
  }

  /**
   * Re-read the analysis from disk; parse, diff against the previous model and push a `doc` event.
   * A parse error never clobbers `this.text` / `this.model`: the page keeps showing the last good
   * version. The system chat line and `doc` broadcast only fire on the transition into (or out of)
   * the error state.
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
        if (!silent) this.broadcast('doc', { model: this.model, changed: [], added: [], removed: [], reason, parseError: this.parseError, sinceExport: this.sinceExportSync() });
        return null;
      }
    }
    const recovered = Boolean(this.parseError);
    this.parseError = null;
    if (recovered) this.chatAppend({ type: 'system', text: `${this.target.analysis} parses again` });

    const old = this.model;
    this.text = text;
    this.model = model;
    // IN-3: detected here, not in a specific route, so both the page's confirm and a CLI
    // `intake-confirm` (an out-of-process write this session only ever learns about through a
    // reload) queue the next analyze chunk the same way.
    if (model) this.maybeEnqueueAnalyze();
    if (silent) return null;
    const d = diff(old?.items, model?.items);
    let changed = d.changed.map(c => c.id), added = d.added.slice(), removed = d.removed.slice();
    if (extra) {
      const has = id => model && model.items.some(it => it.id === id);
      changed = [...new Set([...changed, ...(extra.changed || []).filter(id => has(id) && !added.includes(id))])];
      added = [...new Set([...added, ...(extra.added || []).filter(has)])];
      removed = [...new Set([...removed, ...(extra.removed || []).filter(id => !has(id))])];
    }
    // An operator change (anything outside an agent run) makes an item eligible again.
    if (!this.run) for (const id of [...changed, ...added]) this.settled.delete(id);
    if (this.run && reason === 'reload') for (const id of [...changed, ...added]) this.run.changed.add(id);
    this.broadcast('doc', { model, changed, added, removed, reason, parseError: null, sinceExport: this.sinceExportSync() });
    return { changed, added, removed };
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
    lines = collapseSessions(lines);
    return limit ? lines.slice(-limit) : lines;
  }
  notes() { return readJson(path.join(this.dir, 'notes.json'), []); }
  saveNotes(notes) { atomicWrite(path.join(this.dir, 'notes.json'), JSON.stringify(notes, null, 2)); }

  saveQueued() { atomicWrite(path.join(this.dir, 'queued.json'), JSON.stringify(this.queued, null, 2)); }
  saveSnapshots() { atomicWrite(path.join(this.dir, 'snapshot.json'), JSON.stringify(this.snapshots)); }
  saveQueue() { atomicWrite(path.join(this.dir, 'queue.json'), JSON.stringify({ pending: this.queue.map(b => b.id), inFlight: this.run ? this.run.id : null }, null, 2)); }
  touch() { this.lastActivity = Date.now(); }

  // --- SSE
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) { try { c.write(payload); } catch { this.clients.delete(c); } }
  }

  pendingOf(model) {
    if (!model) return { openCQ: 0, waitingProposals: 0 };
    const r = calcReadiness(model.items, { proposals: this.proposalsList() });
    return { openCQ: r.openCQ, waitingProposals: r.waitingProposals };
  }

  info() {
    const p = this.model ? this.pendingOf(this.model) : { openCQ: 0, waitingProposals: 0 };
    return {
      slug: this.slug, dir: this.rel(this.dir), port: this.port, url: this.url,
      started: this.state.started, resumed: this.state.resumed, batches: this.state.batches, lastBatch: this.state.lastBatch,
      agent: { present: this.agentPresent, everPolled: this.everPolled, lastPoll: this.lastPoll ? new Date(this.lastPoll).toISOString() : null, timeout: this.opts.agentTimeout },
      lock: this.lock, run: this.run ? { id: this.run.id, kind: this.run.kind, stage: this.run.stage || null, startedAt: new Date(this.run.startedAt).toISOString() } : null, queue: this.queue.map(b => b.id),
      grace: this.opts.grace, queuedWrites: this.queued.length,
      analysis: this.target.analysis, source: this.target.source, exists: this.text != null,
      parseError: this.parseError,
      doc: {
        state: this.model ? (isReady(this.model.items) ? 'Ready' : 'In progress') : null,
        rows: this.model ? this.model.items.length : null,
        pending: p,
        regime: this.regimeHere(),
      },
    };
  }

  runEvent(state, extra = {}) {
    this.broadcast('run', { state, batch: extra.batch ?? this.run?.id ?? null, kind: extra.kind ?? this.run?.kind ?? null, stage: extra.stage ?? this.run?.stage ?? null, startedAt: this.run ? new Date(this.run.startedAt).toISOString() : null, lock: this.lock, queue: this.queue.map(b => b.id), active: this.run?.id || null, ...extra });
  }

  // --- batches (agent queue)
  /**
   * Applies queued accept/reject decisions from a `notes` batch's `type:'decision'` entries
   * (page's suggestion queue) as one write, through the same `ops.accept`/`ops.reject` and lock
   * behaviour as the direct `/api/proposal/:id/accept|reject` endpoints (`directWrite`): queued
   * behind an active run (picked up later by `applyQueued`), applied and reloaded once otherwise —
   * never once per decision, so a run this unblocks (`maybeEnqueueAnalyze`, inside `reload`) starts
   * a single chain instead of one per click. Returns the count actually written now (0 while
   * queued behind a lock).
   */
  applyDecisions(decisions) {
    if (!decisions.length) return 0;
    const writes = decisions.map(d => d.action === 'answer'
      ? { type: 'answer', cq: d.cq, key: d.key }
      : { type: d.action === 'reject' ? 'proposalReject' : 'proposalAccept', id: d.proposal });
    if (this.lock) {
      for (const op of writes) this.queued.push({ ...op, t: now() });
      this.saveQueued();
      this.broadcast('queued', { count: this.queued.length });
      return 0;
    }
    if (!fs.existsSync(this.file)) return 0;
    let applied = 0;
    for (const op of writes) {
      const fail = (why) => {
        this.log('decision apply failed', why);
        this.chatAppend({ type: 'system', text: `${op.type === 'answer' ? `answer ${op.cq} (${op.key})` : 'decision'} not applied: ${why}` });
      };
      try { const r = this.applyOpWrite(op); if (r.ok) applied++; else fail(r.reason || 'refused'); }
      catch (e) { fail(e.message); }
    }
    if (applied) { this.touch(); this.reload('decisions', { force: true }); }
    return applied;
  }
  enqueue(body) {
    const kind = body.kind;
    if (!KINDS[kind]) throw httpError(400, 'invalid kind');
    let notes = Array.isArray(body.notes) ? body.notes : [];
    const chat = String(body.chat || '').trim();
    let decisionsApplied = 0;
    if (kind === 'notes') {
      const decisions = notes.filter(n => n && n.type === 'decision');
      if (decisions.length) {
        notes = notes.filter(n => !decisions.includes(n));
        decisionsApplied = this.applyDecisions(decisions);
      }
      if (!notes.length && !chat) {
        // A batch with only decisions never reaches the agent (Send accept/reject changes 2.).
        if (decisions.length) return { id: null, kind, decisionsApplied };
        throw httpError(400, 'notes batch is empty');
      }
    }
    // Contract §3: analysis reads the extraction as final; while it is still under review nothing
    // has been confirmed yet. `intake` and `notes` batches stay allowed (a `notes` batch in review
    // re-runs the extraction).
    if (kind === 'analyze' && this.model?.frontmatter?.data?.intake === 'review') throw httpError(400, `${this.target.analysis} is in intake review; confirm the extraction first`);
    // Once intake is confirmed, analyze is accepted whenever there is work to do: items still
    // queued/reopened, or items reestimate.json marks. Otherwise (nothing to analyse) `force`
    // stays the override, same as before.
    if (kind === 'analyze' && this.model && !body.force) {
      const work = calcHasAnalyzeWork(this.model.items, proposals.reestimateList(this.root, this.slug));
      if (!work) throw httpError(400, `${this.target.analysis} already exists; send force to re-analyse`);
    }
    if (kind === 'analyze' && !this.target.source && !this.model) throw httpError(400, 'no source file to analyse');
    const stage = typeof body.stage === 'string' ? body.stage.trim().slice(0, 120) : null;
    const p = this.pendingOf(this.model);
    const id = `${KINDS[kind]}-${++this.batchSeq}`;
    const file = path.join(this.dir, 'batches', `${id}.json`);
    const batch = { id, kind, sentAt: now(), session: this.url, analysis: this.target.analysis, source: this.target.source, slug: this.slug, notes, chat, stage: stage || null, pending: p, context: this.rel(path.join(this.dir, 'chat.jsonl')), file: this.rel(file) };
    batch.root = this.root;
    batch.fileAbs = this.abs(batch.file);
    batch.contextAbs = this.abs(batch.context);
    batch.analysisAbs = this.abs(batch.analysis);
    if (batch.source) batch.sourceAbs = this.abs(batch.source);
    if (body.force) batch.force = true;
    if (body.importMap) batch.importMap = this.rel(body.importMap);
    // SI-4/IN-11: an analyze batch's `items` — up to 45 ids, in page order, that still need
    // work — explicit `items` (the CLI/API) wins; otherwise computed from the live document, so
    // the top of the first tab fills first and a chained chunk always reflects the latest writes.
    if (kind === 'analyze') {
      batch.items = Array.isArray(body.items) && body.items.length
        ? body.items.slice()
        : this.nextChunk();
    }
    atomicWrite(file, JSON.stringify(batch, null, 2));
    this.queue.push(batch);
    this.saveQueue();
    this.touch();
    this.state.lastBatch = id; this.state.batches++;
    this.chatAppend({ type: 'batch', id, kind, notes, chat, pending: p, queued: Boolean(this.run) });
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
    this.snapshots = this.text != null ? snapshot(this.text) : null;
    this.saveSnapshots();
    this.saveQueue();
    this.runEvent('started', { batch: batch.id, kind: batch.kind, stage: batch.stage || null });
    this.saveState();
    return { event: 'batch', batch };
  }

  releaseReservation() {
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

  finishRun(extra = {}) {
    const finished = this.run.id;
    const kind = this.run.kind;
    if (kind === 'analyze') for (const id of this.run.batch?.items || []) if (this.model?.items.find(it => it.id === id)?.status?.kind === 'reopened') this.settled.add(id);
    this.run = null;
    this.lock = null;
    this.snapshots = null;
    this.saveSnapshots();
    this.saveQueue();
    this.runEvent('finished', { batch: finished, kind, ...extra });
    this.saveState();
    // IN-11: the operator's Accept/Reject/Confirm clicks queued during this run land before the
    // next chunk is decided, so the next chunk's item list (and whether there is one at all) is
    // computed against the state the operator just left it in, not a stale one.
    this.applyQueued();
    this.maybeEnqueueAnalyze();
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
    let repairs = [];
    let text = readText(this.file);
    const beforeItems = this.snapshots ? null : null; // (kept for symmetry; comparison below uses reload's own diff)
    if (text != null && this.snapshots) {
      const r = verifyAndRepair(text, this.snapshots);
      repairs = r.repairs || [];
      if (repairs.length && r.text !== text) { atomicWrite(this.file, r.text); text = r.text; }
    }
    const d = this.reload('reply', { force: true, extra: { changed: [...this.run.changed] } }) || { changed: [...this.run.changed], added: [], removed: [] };
    const entry = this.chatAppend({ type: 'reply', batch: batchId, kind, md, changed: [...d.changed, ...d.added], removed: d.removed, repairs });
    this.finishRun();
    return { ok: true, batch: batchId, kind, changed: d.changed, added: d.added, removed: d.removed, repairs, entry };
  }

  // --- operator writes (direct, or queued while an agent run holds the lock)
  /** Dispatch table: op.type -> ops.mjs function, called with (root, doc, ...op). */
  applyOpWrite(op) {
    const root = this.root, doc = this.file;
    if (op.type === 'confirm') return ops.confirm({ root, doc, ids: op.ids });
    if (op.type === 'unconfirm') return ops.unconfirm({ root, doc, ids: op.ids });
    if (op.type === 'proposalAccept') return ops.accept({ root, doc, id: op.id });
    if (op.type === 'proposalReject') return ops.reject({ root, doc, id: op.id });
    if (op.type === 'patch') return ops.patch({ root, doc, id: op.id, clientResponse: op.clientResponse, internalNote: op.internalNote });
    if (op.type === 'answer') return ops.answer({ root, doc, cq: op.cq, key: op.key });
    // #11: the item route doubles as the global route with the literal segment `global`
    // (`/api/item/global/assumption[/remove]`) — never an item actually named "global".
    if (op.type === 'assume') return ops.assume({ root, doc, item: op.item == null || op.item === 'global' ? null : op.item, statement: op.statement });
    if (op.type === 'unassume') return ops.unassume({ root, doc, item: op.item, statement: op.statement });
    if (op.type === 'profile') return ops.profile({ root, doc, data: op.data });
    // Contract §8: `lib/ops.mjs`'s `intakeConfirm`/`move`/`skip`/`restore`/`info` are WP-3, in
    // flight alongside this change — `ops` is a live ES module namespace, so each becomes callable
    // the moment WP-3 lands it, with no further change here.
    if (op.type === 'intakeConfirm') return typeof ops.intakeConfirm === 'function' ? ops.intakeConfirm({ root, doc }) : { ok: false, reason: 'intake confirm is not available yet' };
    if (op.type === 'move') return typeof ops.move === 'function' ? ops.move({ root, doc, id: op.id, tab: op.tab, topic: op.topic }) : { ok: false, reason: 'move is not available yet' };
    if (op.type === 'skip') return typeof ops.skip === 'function' ? ops.skip({ root, doc, id: op.id, why: op.why }) : { ok: false, reason: 'skip is not available yet' };
    if (op.type === 'restore') return typeof ops.restore === 'function' ? ops.restore({ root, doc, source: op.source }) : { ok: false, reason: 'restore is not available yet' };
    if (op.type === 'info') return typeof ops.info === 'function' ? ops.info({ root, doc, key: op.key, value: op.value }) : { ok: false, reason: 'info is not available yet' };
    return { ok: false, reason: `unknown write type ${op.type}` };
  }

  /** Re-reads the file, applies one operator write and reloads. */
  applyWrite(op) {
    if (!fs.existsSync(this.file)) return { ok: false, reason: 'analysis missing' };
    const r = this.applyOpWrite(op);
    if (!r.ok) return r;
    this.touch();
    this.reload(op.type, { force: true });
    return r;
  }

  /** HTTP entry: 202 while locked, 200 when applied, 400 when the write refused. */
  directWrite(op) {
    // Operator row ops apply at once, even while a run holds the lock: the agent's `apply` treats
    // a confirmed row as wasConfirmed, so the run never overwrites it. The write is synchronous
    // (one event-loop turn), so it cannot interleave with another in-process write.
    if (this.lock && !DIRECT_OPS.has(op.type)) {
      this.queued.push({ ...op, t: now() });
      this.saveQueued();
      this.broadcast('queued', { count: this.queued.length });
      return { status: 202, body: { queued: true, lockedBy: this.lock } };
    }
    const r = this.applyWrite(op);
    // A bulk confirm that skips every id is still `ok: false` (nothing to confirm), but the
    // per-id reasons that made it a no-op must survive into the refusal, not just the top line.
    if (!r.ok) return { status: 400, body: { error: r.reason, reason: r.reason, ...(r.skipped ? { skipped: r.skipped } : {}) } };
    return { status: 200, body: r };
  }

  dropped(op, reason) {
    const row = op.ids ? op.ids.join(', ') : (op.id || op.item || op.cq || '');
    const text = `queued ${op.type}${row ? ' for ' + row : ''} dropped: ${reason}`;
    this.chatAppend({ type: 'system', text });
    this.broadcast('progress', { text, dropped: true, rows: op.ids || (row ? [row] : []) });
  }

  applyQueued() {
    if (!this.queued.length) { this.broadcast('queued', { count: 0 }); return; }
    const mine = this.queued;
    this.queued = [];
    this.saveQueued();
    let applied = 0;
    for (const op of mine) {
      try {
        const r = this.applyOpWrite(op);
        if (r.ok) applied++;
        else this.dropped(op, r.reason);
      } catch (e) { this.dropped(op, e.message); }
    }
    if (applied) { this.reload('queued', { force: true }); this.chatAppend({ type: 'system', text: `applied ${applied} queued change(s)` }); }
    this.broadcast('queued', { count: 0 });
  }

  // --- lifecycle
  beat() {
    this.lastBeat = Date.now();
    if (this.pendingClose) { this.log('page reconnected during close grace'); this.pendingClose = null; }
  }
  tick() {
    const t = Date.now();
    if (this.pendingClose) {
      if (t - this.pendingClose.since > this.closeGraceMs) this.shutdown(this.pendingClose.reason);
      return;
    }
    if (t - this.lastBeat > this.opts.grace * 1000) {
      // The page is gone, not necessarily for good: a closed tab, a reload or a laptop sleep
      // gets `closeGraceMs` to reconnect (a fresh heartbeat, via `beat()` above) before this
      // becomes a real `shutdown`. `poll` keeps returning `idle` for the whole grace.
      this.pendingClose = { since: t, reason: 'heartbeat timeout' };
      this.log('page gone; holding the session for the close grace');
      return;
    }
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
    if (this.proposalsWatcher) try { this.proposalsWatcher.close(); } catch { /* ignore */ }
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
    this.watchProposals();
  }

  /** `specs/.rfp/<slug>/proposals.json`, watched separately from the analysis file (a different
   * directory): a proposal-only apply (e.g. `globalProposals`, with no §4 row changed) still needs
   * to refresh the page's proposals panel — `reload(..., { force: true })` broadcasts `doc` even
   * though the document text itself has not changed, and the page's `doc` handler already
   * re-fetches proposals on every such event. Best-effort: a failure here never aborts the
   * session, since the primary analysis-file watcher already covers reconnect/retry. */
  watchProposals() {
    const dir = path.join(this.root, 'specs', '.rfp', this.slug);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (this.proposalsWatcher) try { this.proposalsWatcher.close(); } catch { /* ignore */ }
      this.proposalsWatcher = fs.watch(dir, { persistent: true }, (ev, name) => {
        if (String(name) !== 'proposals.json') return;
        clearTimeout(this.pendingWatch.get('proposals.json'));
        this.pendingWatch.set('proposals.json', setTimeout(() => { this.pendingWatch.delete('proposals.json'); this.reload('reload', { force: true }); }, 150));
      });
      this.proposalsWatcher.on('error', e => { this.log('proposals watch error', e.message); try { this.proposalsWatcher.close(); } catch { /* ignore */ } this.proposalsWatcher = null; });
    } catch (e) { this.log('proposals watch error', e.message); }
  }

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

function findItem(session, id) { return session.model?.items.find(it => it.id === id) || null; }

async function handle(session, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/{2,}/g, '/');
  const m = req.method;
  try {
    if (m === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, path.join(PAGE_DIR, 'index.html'));
    const libMatch = /^\/page\/lib\/([\w-]+\.mjs)$/.exec(p);
    if (m === 'GET' && libMatch && LIB_FILES[libMatch[1]]) return serveStatic(res, path.join(HERE, LIB_FILES[libMatch[1]]));
    if (m === 'GET' && p.startsWith('/page/')) {
      const f = path.resolve(PAGE_DIR, '.' + p.slice(5));
      if (!f.startsWith(PAGE_DIR)) return send(res, 403, { error: 'forbidden' });
      return serveStatic(res, f);
    }
    if (m === 'GET' && p === '/health') {
      return send(res, 200, { name: PKG_JSON.name, version: PKG_JSON.version, pid: process.pid, slug: session.slug, url: session.url, started: session.state.started });
    }
    if (m === 'GET' && p === '/api/session') {
      // N-4: re-read the file before answering, instead of trusting whatever the watcher's
      // 150ms debounce has landed so far — a change made just before this request (e.g. an
      // invalid coverage value written by hand) must show up in `model`/`parseError` here, not
      // only once the next `doc` broadcast happens to fire.
      session.reload('session', { silent: true });
      const sinceExport = await session.sinceExport();
      return send(res, 200, { session: session.info(), analysis: session.target.analysis, source: session.target.source, model: session.model, parseError: session.parseError, notes: session.notes(), chat: session.chatHistory(), queued: session.queued, intake: session.intakeInfo(), fitBack: session.fitBack(), proposals: session.model ? session.proposalsList() : [], sinceExport });
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
    if (m === 'POST' && p === '/api/batch') {
      const body = await readBody(req);
      const batch = session.enqueue(body);
      if (!batch.id) return send(res, 200, { id: null, decisionsApplied: batch.decisionsApplied || 0 });
      return send(res, 200, { id: batch.id, file: batch.file, queued: Boolean(session.run) && session.run.id !== batch.id, ...(batch.items ? { items: batch.items } : {}) });
    }
    if (m === 'POST' && p === '/api/run/abort') {
      const body = await readBody(req);
      const id = session.abortRun(body.reason || 'aborted from the page');
      return send(res, 200, { ok: true, aborted: id });
    }
    if (m === 'POST' && p === '/api/close') { send(res, 200, { ok: true }); session.shutdown('closed by request'); return; }
    if (m === 'GET' && p === '/api/lock') return send(res, 200, { lock: session.lock, run: session.info().run, agent: session.info().agent, queue: session.queue.map(b => b.id) });

    // --- Page API (build contract §4) ---------------------------------------------------
    if (m === 'POST' && p === '/api/confirm') {
      const body = await readBody(req);
      if (!Array.isArray(body.ids) || !body.ids.length) return send(res, 400, { error: 'ids required', reason: 'ids required' });
      const r = session.directWrite({ type: 'confirm', ids: body.ids });
      return send(res, r.status, r.body);
    }
    if (m === 'POST' && p === '/api/unconfirm') {
      const body = await readBody(req);
      if (!Array.isArray(body.ids) || !body.ids.length) return send(res, 400, { error: 'ids required', reason: 'ids required' });
      const r = session.directWrite({ type: 'unconfirm', ids: body.ids });
      return send(res, r.status, r.body);
    }
    if (m === 'POST' && p === '/api/intake/confirm') {
      const r = session.directWrite({ type: 'intakeConfirm' });
      return send(res, r.status, r.body);
    }
    if (m === 'POST' && p === '/api/intake/restore') {
      const body = await readBody(req);
      if (!body.source) return send(res, 400, { error: 'source required', reason: 'source required' });
      const r = session.directWrite({ type: 'restore', source: body.source });
      return send(res, r.status, r.body);
    }
    const moveMatch = /^\/api\/item\/([^/]+)\/move$/.exec(p);
    if (m === 'POST' && moveMatch) {
      const body = await readBody(req);
      if (!body.tab) return send(res, 400, { error: 'tab required', reason: 'tab required' });
      const r = session.directWrite({ type: 'move', id: moveMatch[1], tab: body.tab, topic: body.topic });
      return send(res, r.status, r.body);
    }
    const skipMatch = /^\/api\/item\/([^/]+)\/skip$/.exec(p);
    if (m === 'POST' && skipMatch) {
      const body = await readBody(req);
      if (!body.why) return send(res, 400, { error: 'why required', reason: 'why required' });
      const r = session.directWrite({ type: 'skip', id: skipMatch[1], why: body.why });
      return send(res, r.status, r.body);
    }
    const infoMatch = /^\/api\/project-info\/([^/]+)$/.exec(p);
    if (m === 'PATCH' && infoMatch) {
      const body = await readBody(req);
      if (body.value == null) return send(res, 400, { error: 'value required', reason: 'value required' });
      const r = session.directWrite({ type: 'info', key: infoMatch[1], value: body.value });
      return send(res, r.status, r.body);
    }
    const proposalMatch = /^\/api\/proposal\/([^/]+)\/(accept|reject)$/.exec(p);
    if (m === 'POST' && proposalMatch) {
      const r = session.directWrite({ type: proposalMatch[2] === 'accept' ? 'proposalAccept' : 'proposalReject', id: proposalMatch[1] });
      return send(res, r.status, r.body);
    }
    if (m === 'GET' && p === '/api/proposals') return send(res, 200, { proposals: session.model ? session.proposalsList() : [] });
    const itemMatch = /^\/api\/item\/([^/]+)$/.exec(p);
    if (m === 'PATCH' && itemMatch) {
      const body = await readBody(req);
      // N-4: `patch` only ever writes Client Response / Internal note (L-4) — an unknown field
      // (e.g. `coverage`, which only `apply` may set) is refused instead of silently ignored.
      const unknown = Object.keys(body || {}).filter(k => k !== 'clientResponse' && k !== 'internalNote');
      if (unknown.length) return send(res, 400, { error: `unknown field(s): ${unknown.join(', ')}`, reason: `unknown field(s): ${unknown.join(', ')}` });
      const r = session.directWrite({ type: 'patch', id: itemMatch[1], clientResponse: body.clientResponse, internalNote: body.internalNote });
      return send(res, r.status, r.body);
    }
    const exportTextMatch = /^\/api\/item\/([^/]+)\/export-text$/.exec(p);
    if (m === 'GET' && exportTextMatch) {
      const item = findItem(session, exportTextMatch[1]);
      if (!item) return send(res, 404, { error: 'item not found', reason: 'item not found' });
      // The fit-back map, read fresh (`session.fitBack()`, never cached) — a `tokens --file` run
      // by the agent out-of-process while this session keeps up must be visible on the very next
      // request. `null` for a CSV/PDF source (no fit-back map at all); `resolveTable` degrades to
      // its empty shape then.
      const liveMap = session.fitBack();
      const { tokens, assumptionsColumn, complianceLegend, tokenPending } = resolveTable(liveMap, item);
      return send(res, 200, exportText(item, { tokens, assumptionsColumn, complianceLegend, tokenPending, regime: session.regimeHere() }, { preview: true }));
    }
    const assumeMatch = /^\/api\/item\/([^/]+)\/assumption$/.exec(p);
    if (m === 'POST' && assumeMatch) {
      const body = await readBody(req);
      if (!body.statement) return send(res, 400, { error: 'statement required', reason: 'statement required' });
      const r = session.directWrite({ type: 'assume', item: assumeMatch[1], statement: body.statement });
      return send(res, r.status, r.body);
    }
    const unassumeMatch = /^\/api\/item\/([^/]+)\/assumption\/remove$/.exec(p);
    if (m === 'POST' && unassumeMatch) {
      const body = await readBody(req);
      if (!body.statement) return send(res, 400, { error: 'statement required', reason: 'statement required' });
      const r = session.directWrite({ type: 'unassume', item: unassumeMatch[1], statement: body.statement });
      return send(res, r.status, r.body);
    }
    const answerMatch = /^\/api\/question\/([^/]+)\/answer$/.exec(p);
    if (m === 'POST' && answerMatch) {
      const body = await readBody(req);
      if (!body.option) return send(res, 400, { error: 'option required', reason: 'option required' });
      const r = session.directWrite({ type: 'answer', cq: answerMatch[1], key: body.option });
      return send(res, r.status, r.body);
    }
    if (m === 'GET' && p === '/api/profile') return send(res, 200, session.readProfileHere());
    if (m === 'PUT' && p === '/api/profile') {
      const body = await readBody(req);
      const r = session.directWrite({ type: 'profile', data: body });
      return send(res, r.status, r.body);
    }
    if (m === 'POST' && p === '/api/export') {
      const mod = await session.loadImportExportMod();
      if (!mod || typeof mod.exportWorkbook !== 'function') return send(res, 501, { error: 'export not available yet', reason: 'export not available yet' });
      const body = await readBody(req).catch(() => ({}));
      try {
        const r = await mod.exportWorkbook(session.file, { out: body.out, root: session.root });
        return send(res, 200, { ok: true, ...r });
      } catch (e) {
        // Coverage tokens not mapped yet and an agent is present: queue the `export` batch
        // instead of just refusing — the agent maps the tokens then exports itself (§3).
        if (e.missingCoverageTables && session.agentPresent) {
          const batch = session.enqueue({ kind: 'export', stage: 'map coverage tokens, then export' });
          return send(res, 202, { queued: true, batch: batch.id, tables: e.missingCoverageTables });
        }
        return send(res, 400, { error: e.message, reason: e.reason || e.message });
      }
    }
    // -------------------------------------------------------------------------------------

    if (m === 'GET' && p === '/api/next') {
      session.polled();
      const wait = Number(url.searchParams.get('wait') || 30);
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
    return send(res, status, { error: e.message, reason: e.message, ...(e.extra || {}) });
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
    out.line('state', session.session?.doc?.state || 'unknown');
    out.line('rows', String(session.session?.doc?.rows ?? 'n/a'));
    const p = session.session?.doc?.pending || {};
    out.line('pending', `${p.openCQ ?? 0} open questions, ${p.waitingProposals ?? 0} waiting proposals`);
    out.line('queued_unsent', String((session.notes || []).length));
    out.line('agent_present', String(Boolean(session.session?.agent?.present)));
    out.line('run_active', String(session.session?.run?.id || 'none'));
    if (session.parseError) out.line('parse_error', session.parseError);
  }
  out.nextStep('run `sw-tender-discovery-tool poll` to wait for the next batch');
  if (opts.json && session) out.payload(session);
}

export async function main(argv) {
  const opts = parseArgs([...argv]);
  if (!opts.doc) out.usage('usage: sw-tender-discovery-tool start|status|stop --doc specs/rfp-NNNN-slug-analysis.md | specs/rfp-NNNN-slug.csv [--port N] [--grace S] [--agent-timeout S] [--foreground] [--no-intake]');
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
    let health = null;
    try {
      const r = await fetch(live.url + 'health');
      if (r.ok) health = await r.json();
    } catch { /* no /health: treat like a matching version below */ }
    if (health && health.version && health.version !== PKG_JSON.version) {
      await fetch(live.url + 'api/close', { method: 'POST' }).catch(() => {});
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await liveLock(target.sessionDir))) await new Promise(r => setTimeout(r, 100));
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
  fs.mkdirSync(target.sessionDir, { recursive: true });
  try { fs.unlinkSync(path.join(target.sessionDir, 'session.lock')); } catch { /* none */ }
  const logFile = fs.openSync(path.join(target.sessionDir, 'server.log'), 'a');
  const args = [cliPath(), 'start', '--foreground', '--root', opts.root, '--doc', opts.doc, '--grace', String(opts.grace), '--agent-timeout', String(opts.agentTimeout), '--idle', String(opts.idle)];
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.intake === false) args.push('--no-intake');
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
