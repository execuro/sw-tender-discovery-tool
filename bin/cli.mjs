#!/usr/bin/env node
// sw-tender-discovery-tool - the single entry point.
//
// Every other file in this package exports main(argv) and never looks at
// process.argv. That is the whole point: the previous entry points gated their
// main() on comparing process.argv[1] to their own module path, which does not
// match when the package is reached through npx's node_modules/.bin symlink, so
// the command exited 0 having silently done nothing.
//
// Two groups of commands share this table: the editor session, and the
// client's workbook in and out (lib/import-export.mjs).
//
// Output contract: a compact summary, then one `next_step:` line telling the
// agent what to run next, before any large payload.
// Exit codes: 0 ok · 1 server unreachable / runtime failure · 2 usage error.

import * as out from '../lib/out.mjs';

// A consumer that stops reading (`| head`, a truncating harness) closes our
// stdout, and the next write raises EPIPE. That is the reader's choice, not an
// error of ours, so exit quietly instead of dumping a stack over the output.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', e => { if (e?.code === 'EPIPE') process.exit(out.EXIT_OK); throw e; });
}

const COMMANDS = {
  start: () => import('../lib/server.mjs'),
  status: () => import('../lib/server.mjs'),
  stop: () => import('../lib/server.mjs'),
  poll: () => import('../lib/poll.mjs'),
  emit: () => import('../lib/emit.mjs'),
  batch: () => import('../lib/batch.mjs'),
  guide: () => import('../lib/guide.mjs'),
  'install-skill': () => import('../lib/install-skill.mjs'),
  'uninstall-skill': () => import('../lib/uninstall-skill.mjs'),
  import: () => import('../lib/import-export.mjs'),
  export: () => import('../lib/import-export.mjs'),
  check: () => import('../lib/check.mjs'),
  report: () => import('../lib/report.mjs'),
  intake: () => import('../lib/intake.mjs'),
  apply: () => import('../lib/apply.mjs'),
  confirm: () => import('../lib/ops.mjs'),
  accept: () => import('../lib/ops.mjs'),
  reject: () => import('../lib/ops.mjs'),
  assume: () => import('../lib/ops.mjs'),
  unassume: () => import('../lib/ops.mjs'),
  answer: () => import('../lib/ops.mjs'),
  patch: () => import('../lib/ops.mjs'),
  profile: () => import('../lib/ops.mjs'),
  tokens: () => import('../lib/ops.mjs'),
  'intake-confirm': () => import('../lib/ops.mjs'),
  move: () => import('../lib/ops.mjs'),
  skip: () => import('../lib/ops.mjs'),
  restore: () => import('../lib/ops.mjs'),
  info: () => import('../lib/ops.mjs'),
};

const USAGE = `usage: sw-tender-discovery-tool <command> [options]

  start    --doc <path> [--port N] [--grace S] [--agent-timeout S] [--idle S] [--foreground] [--no-intake] [--root <dir>]
  status   [--doc <path>] [--json] [--root <dir>]
  stop     [--doc <path>] [--root <dir>]
  poll     [--wait 90] [--reply "<text>"] [--doc <path>] [--root <dir>]
  emit     progress|chat|done "<text>" [--batch <id>] [--since <iso>] [--root <dir>]
  batch    --kind intake|analyze|reestimate|notes|export [--stage "<label>"] [--force] [--root <dir>]
  import   --source <file.xlsx|file.csv> [--root <dir>]
  intake   <doc> --source <file> --extraction <json> [--root <dir>]
  apply    <doc> --report <json> [--root <dir>]
  check    <doc> [--write] [--root <dir>]
  report   <doc> [--root <dir>]
  confirm  <doc> <id>... | --all-unconfirmed [--root <dir>]
  accept   <doc> <P-n> [--root <dir>]
  reject   <doc> <P-n> [--root <dir>]
  assume   <doc> <item|global> "<statement>" [--root <dir>]
  unassume <doc> <item|global> "<statement>" [--root <dir>]
  answer   <doc> <CQ-n> <key> [--root <dir>]
  patch    <doc> <id> [--response "<text>"] [--note "<text>"] [--root <dir>]
  profile  <doc> --file <json> [--root <dir>]
  tokens   <doc> --suggest | --file <json> [--root <dir>]
  intake-confirm <doc> [--root <dir>]
  move     <doc> <id> <tab> [--topic "<t>"] [--root <dir>]
  skip     <doc> <id> "<why>" [--root <dir>]
  restore  <doc> "<source>" [--root <dir>]
  info     <doc> <key> "<value>" [--root <dir>]
  export   <doc> [--out <file>] [--root <dir>]
  guide    print the session protocol
  install-skill    [--target <dir>] [--root <path>] [--print] [--force]
  uninstall-skill  [--target <dir>] [--root <path>]

Relative paths (--doc, --source, --out) resolve against the current directory. The project
root - where specs/.editor/ and specs/.rfp/ live - is --root, else the nearest
ancestor of that file holding .git, else the current directory. It never depends
on where you ran this.

A command whose module is missing fails with exit 1, naming the missing module -
only that command, nothing else.

Run \`sw-tender-discovery-tool guide\` first: it is the current session protocol.`;

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(cmd ? out.EXIT_OK : out.EXIT_USAGE);
}

const load = COMMANDS[cmd];
if (!load) {
  process.stderr.write(`unknown command ${cmd}\n${USAGE}\n`);
  process.exit(out.EXIT_USAGE);
}

// server.mjs, import-export.mjs and ops.mjs all re-read the verb from their argv:
// ops.mjs dispatches confirm/accept/reject/assume/unassume/answer/patch/profile
// on argv[0], the same way import-export.mjs dispatches import/export.
const KEEPS_VERB = ['start', 'status', 'stop', 'import', 'export',
  'confirm', 'accept', 'reject', 'assume', 'unassume', 'answer', 'patch', 'profile', 'tokens',
  'intake-confirm', 'move', 'skip', 'restore', 'info'];
// Only the commands that take a --doc need to turn one into a session
// directory, and only they pay for loading the server module.
const NEEDS_RESOLVE = ['poll', 'batch'];

try {
  let mod;
  try {
    mod = await load();
  } catch (e) {
    // A command whose module is missing fails alone - the rest of the CLI,
    // and every other command, is unaffected.
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      const missing = /Cannot find module '([^']+)'/.exec(e.message)?.[1] || e.message;
      process.stderr.write(`${cmd}: missing module ${missing}\n`);
      process.exit(1);
    }
    throw e;
  }
  const args = KEEPS_VERB.includes(cmd) ? argv : argv.slice(1);
  const ctx = NEEDS_RESOLVE.includes(cmd) ? { resolveTarget: (await import('../lib/server.mjs')).resolveTarget } : {};
  await mod.main(args, ctx);
} catch (e) {
  process.stderr.write(`${e?.stack || e?.message || e}\n`);
  process.exit(1);
}
