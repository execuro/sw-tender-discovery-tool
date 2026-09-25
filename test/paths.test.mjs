// Path resolution: where the project root comes from.
//
// The bug this suite exists to catch is invisible when everything runs from one
// directory, which is why it survived: the CLI and the agent driving it are
// separate processes, and nothing guarantees their working directories match.
// Before the root was derived from the document, a command issued from a
// subdirectory looked for `specs/.editor/` under *that* directory, found
// nothing, and opened a second session.
//
// So every integration test below deliberately runs the CLI from somewhere
// other than the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonical, findGitRoot, resolveRoot, display, outsideRoot, settle } from '../lib/paths.mjs';
import { canBind, run, field, HERE } from './helpers.mjs';

const FIXTURE = path.join(HERE, 'fixtures', 'rfp-0099-mini-analysis.md');
const SOURCE = path.join(HERE, 'fixtures', 'rfp-0099-mini.csv');
const ANALYSIS = 'specs/rfp-0099-mini-analysis.md';
const SLUG = 'rfp-0099-mini';

/** A host repo that looks like a real checkout, so the walk-up has something to find. */
function gitHostRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tdt-paths-')));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(root, ANALYSIS));
  fs.copyFileSync(SOURCE, path.join(root, 'specs', `${SLUG}.csv`));
  const deep = path.join(root, 'custom', 'plugins', 'SwagExample', 'src');
  fs.mkdirSync(deep, { recursive: true });
  return { root, deep: fs.realpathSync(deep) };
}

async function teardown(root) {
  try { await run(['stop', '--doc', path.join(root, ANALYSIS)], root); } catch { /* already gone */ }
  const lock = path.join(root, 'specs', '.editor', SLUG, 'session.lock');
  for (let i = 0; i < 20 && fs.existsSync(lock); i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 250));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// --- unit

test('canonical resolves a path that does not exist yet', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-canon-')));
  try {
    // `start` legitimately names an analysis that has not been written - the
    // first run on a client's workbook creates it - and that still has to
    // produce a stable session identity.
    const missing = canonical('specs/rfp-0099-mini-analysis.md', root);
    assert.equal(missing, path.join(root, 'specs', 'rfp-0099-mini-analysis.md'));
    assert.equal(canonical('specs/rfp-0099-mini-analysis.md', root), missing, 'must be stable across calls');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical resolves symlinks, so two spellings of one file are one session', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-link-')));
  try {
    fs.mkdirSync(path.join(root, 'specs'));
    fs.writeFileSync(path.join(root, 'specs', 'real.md'), '# x\n');
    fs.symlinkSync(path.join(root, 'specs', 'real.md'), path.join(root, 'link.md'));
    assert.equal(canonical('link.md', root), canonical('specs/real.md', root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findGitRoot accepts .git as a directory and as a worktree file', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-git-')));
  try {
    const clone = path.join(base, 'clone');
    fs.mkdirSync(path.join(clone, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(clone, '.git'));
    assert.equal(findGitRoot(path.join(clone, 'specs', 'x.md')), clone);

    // A worktree or submodule has .git as a FILE holding a gitdir pointer.
    const wt = path.join(base, 'worktree');
    fs.mkdirSync(path.join(wt, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    assert.equal(findGitRoot(path.join(wt, 'specs', 'x.md')), wt);

    assert.equal(findGitRoot(path.join(base, 'nowhere', 'x.md')), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveRoot prefers --root, then the document, then cwd', () => {
  const { root, deep } = gitHostRepo();
  try {
    const doc = path.join(root, ANALYSIS);
    assert.equal(resolveRoot({ docAbs: doc, cwd: deep }), root, 'the document names its own repository');
    assert.equal(resolveRoot({ rootFlag: deep, docAbs: doc, cwd: root }), deep, '--root wins outright');
    assert.equal(resolveRoot({ cwd: deep }), root, 'with no document, walk up from cwd');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('display is project-relative, and stays absolute for anything outside the root', () => {
  assert.equal(display('/a/b', '/a/b/specs/x.md'), 'specs/x.md');
  assert.equal(display('/a/b', '/elsewhere/x.md'), '/elsewhere/x.md');
});

test('outsideRoot refuses a document from another tree rather than opening a second session', () => {
  assert.equal(outsideRoot('/a/b', '/a/b/specs/x.md'), null);
  assert.match(outsideRoot('/a/b', '/other/specs/x.md'), /not inside the project root/);
});

test('settle canonicalises the anchor it is given, and derives the root from it', () => {
  const { root, deep } = gitHostRepo();
  try {
    const doc = settle({ doc: ANALYSIS, rootFlag: '' }, { cwd: root });
    assert.equal(doc.doc, path.join(root, ANALYSIS));
    assert.equal(doc.root, root);

    // `import`/`export` anchor on the workbook, not on --doc.
    const src = settle({ source: `specs/${SLUG}.csv`, rootFlag: '' }, { cwd: root, anchorKey: 'source' });
    assert.equal(src.source, path.join(root, 'specs', `${SLUG}.csv`));
    assert.equal(src.root, root);

    // `emit --doc` is accepted and ignored by this CLI, so emit settles with no
    // anchor at all - nothing it was handed may be turned into a path.
    const emitish = settle({ doc: 'prd', rootFlag: '' }, { cwd: deep, anchorKey: null });
    assert.equal(emitish.doc, 'prd', 'a non-path argument must never become a path');
    assert.equal(emitish.root, root, 'with no anchor, walk up from cwd');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- integration: the CLI run from a directory that is NOT the project root

test('a command run from a subdirectory reaches the session started at the root', async t => {
  if (!(await canBind())) return t.skip('loopback cannot be bound in this sandbox');
  const { root, deep } = gitHostRepo();
  try {
    const started = await run(['start', '--doc', ANALYSIS], root);
    assert.equal(started.code, 0, started.out + started.err);

    // The agent is several directories deep - where a Shopware plugin lives -
    // and names the document by its absolute path, the only spelling that
    // means the same thing from both processes.
    const abs = path.join(root, ANALYSIS);
    const fromDeep = await run(['status', '--doc', abs], deep);
    assert.equal(fromDeep.code, 0, fromDeep.out + fromDeep.err);
    assert.equal(field(fromDeep.out, 'running'), 'true', 'must find the session started at the root');

    // And with no document at all. `emit` finds the one live session by
    // scanning `<root>/specs/.editor/`, so the root it derived from the
    // subdirectory has to be the repository - not the subdirectory itself,
    // which is what it used to be and where nothing would ever be found.
    const noDoc = await run(['emit', 'progress', 'working'], deep);
    assert.equal(noDoc.code, 0, noDoc.out + noDoc.err);

    // The session directory is the one at the root, not a second one created
    // under the subdirectory.
    assert.ok(fs.existsSync(path.join(root, 'specs', '.editor', SLUG)));
    assert.ok(!fs.existsSync(path.join(deep, 'specs')), 'no second session under the subdirectory');
  } finally {
    await teardown(root);
  }
});

test('a batch queued and polled from a subdirectory reaches the same session', async t => {
  if (!(await canBind())) return t.skip('loopback cannot be bound in this sandbox');
  const { root, deep } = gitHostRepo();
  try {
    const started = await run(['start', '--doc', ANALYSIS], root);
    assert.equal(started.code, 0, started.out + started.err);
    await new Promise(r => setTimeout(r, 200));

    const abs = path.join(root, ANALYSIS);
    const queued = await run(['batch', '--kind', 'reestimate', '--doc', abs], deep);
    assert.equal(queued.code, 0, queued.out + queued.err);

    const got = await run(['poll', '--wait', '5', '--doc', abs], deep);
    assert.equal(got.code, 0, got.out + got.err);
    assert.equal(field(got.out, 'event'), 'batch');

    // The whole point: the batch file the agent is handed opens from the
    // agent's own cwd, without it knowing where the CLI ran.
    const batchFile = field(got.out, 'batch_file');
    assert.ok(fs.existsSync(path.resolve(deep, batchFile)), `the batch file must open from the subdirectory: ${batchFile}`);
  } finally {
    await teardown(root);
  }
});

test('start refuses a document from another tree instead of opening a session for it', async t => {
  if (!(await canBind())) return t.skip('loopback cannot be bound in this sandbox');
  const { root } = gitHostRepo();
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-other-')));
  try {
    fs.mkdirSync(path.join(other, 'specs'));
    fs.copyFileSync(path.join(root, ANALYSIS), path.join(other, ANALYSIS));
    const r = await run(['start', '--doc', path.join(other, ANALYSIS), '--root', root], root);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /not inside the project root/);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
    await teardown(root);
  }
});
