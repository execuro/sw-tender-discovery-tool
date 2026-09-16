// lib/emit.mjs: withElapsed (pure), unknown-flag rejection, and text on stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withElapsed } from '../lib/emit.mjs';
import { canBind, run, field, HERE } from './helpers.mjs';

const FIXTURE = path.join(HERE, 'fixtures', 'rfp-0099-mini-analysis.md');
const SOURCE = path.join(HERE, 'fixtures', 'rfp-0099-mini.csv');
const ANALYSIS = 'specs/rfp-0099-mini-analysis.md';

function hostRepo() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tender-tool-emit-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(root, ANALYSIS));
  fs.copyFileSync(SOURCE, path.join(root, 'specs', 'rfp-0099-mini.csv'));
  return root;
}

// ---------------------------------------------------------------- withElapsed (pure)

test('withElapsed prefixes "+m:ss " measured from --since', () => {
  const since = new Date(Date.now() - 75_000).toISOString(); // 1:15 ago
  const prefixed = withElapsed('doing the thing', since);
  assert.match(prefixed, /^\+1:1[4-6] doing the thing$/);
});

test('withElapsed leaves the text untouched when --since is absent or unparseable', () => {
  assert.equal(withElapsed('hello', ''), 'hello');
  assert.equal(withElapsed('hello', undefined), 'hello');
  assert.equal(withElapsed('hello', 'not-a-date'), 'hello');
});

test('withElapsed never goes negative for a --since in the future', () => {
  const since = new Date(Date.now() + 60_000).toISOString();
  assert.match(withElapsed('x', since), /^\+0:00 x$/);
});

// ---------------------------------------------------------------- unknown flags (usage error, no server needed)

test('an unknown flag is a usage error, not folded into the message text', async () => {
  const r = await run(['emit', 'progress', 'hello', '--bogus', 'x'], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown flag --bogus/);
});

test('an unknown emit verb is a usage error', async () => {
  const r = await run(['emit', 'shout', 'hello'], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown emit command shout/);
});

// ---------------------------------------------------------------- text on stdin (needs a running session)

test('"-" reads the message text from stdin', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', ANALYSIS], root);
    const r = await run(['emit', 'chat', '-', '--doc', ANALYSIS], root, 'piped from stdin');
    assert.equal(r.code, 0, r.err);
    assert.equal(field(r.out, 'emitted'), 'chat');
    const chat = fs.readFileSync(path.join(root, 'specs/.editor/rfp-0099-mini/chat.jsonl'), 'utf8');
    assert.match(chat, /piped from stdin/);
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty tty-less run with no text argument also reads stdin', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', ANALYSIS], root);
    const r = await run(['emit', 'progress', '--doc', ANALYSIS], root, 'no dash needed either');
    assert.equal(r.code, 0, r.err);
    const chat = fs.readFileSync(path.join(root, 'specs/.editor/rfp-0099-mini/chat.jsonl'), 'utf8');
    assert.match(chat, /no dash needed either/);
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown flag is rejected, but `--` lets a message start with dashes', async t => {
  if (!(await canBind())) return t.skip('cannot bind 127.0.0.1 in this environment');
  const root = hostRepo();
  try {
    await run(['start', '--doc', ANALYSIS], root);

    // The bug this guards: an unknown flag used to be folded into the message text.
    const bogus = await run(['emit', 'progress', '--bogus', 'hi'], root);
    assert.equal(bogus.code, 2);
    assert.match(bogus.err, /unknown flag --bogus/);

    // ...but a legitimate message may start with `--`, so `--` ends the options.
    const sep = await run(['emit', 'progress', '--', '--force was used'], root);
    assert.equal(sep.code, 0, sep.err);
    const chat = fs.readFileSync(path.join(root, 'specs/.editor/rfp-0099-mini/chat.jsonl'), 'utf8');
    assert.match(chat, /--force was used/);
  } finally {
    await run(['stop', '--doc', ANALYSIS], root).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
