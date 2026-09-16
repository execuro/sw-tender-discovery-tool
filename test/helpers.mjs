// Shared test plumbing. Not matched by the `test/*.test.mjs` glob, so `node --test`
// never runs this file as a suite.
//
// Model: SpecsEditor/test/helpers.mjs - same problems (an in-process CLI, a sandbox
// that may not permit binding 127.0.0.1, and the `key: value` output contract),
// solved once here instead of once per suite.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG = path.join(HERE, '..');
export const CLI = path.join(PKG, 'bin', 'cli.mjs');

/** Some sandboxes cannot bind loopback; skip rather than fail there. */
export function canBind() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Run the real CLI in `cwd`, async. `input` is written to stdin. */
export function run(args, cwd, input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

/** Same contract as `run`, synchronous - for suites that are not async themselves. */
export function runSync(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/**
 * Like `run`, but hands back the child so a test can kill it mid-flight.
 * `done` resolves with the same `{code, out, err}` shape.
 */
export function spawnCli(args, cwd, input) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, out, err })));
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  return { child, done };
}

/** Run an arbitrary command (e.g. the server re-exec'd as its own child), async. */
export function exec(cmd, args, cwd, input) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

/** The value of a `key: value` result line. */
export const field = (out, key) => (out.match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1];
