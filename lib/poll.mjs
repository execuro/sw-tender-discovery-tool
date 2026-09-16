// `poll` - wait for the page to send something.
//
//   sw-tender-discovery-tool poll [--wait 90] [--doc <path>]
//
// Bounded on purpose. The server can hold a request open for a long time, but
// an agent's Bash call cannot: a poll that outlives the harness default timeout
// is killed, and the agent has no way to tell that from a hang. So the wait is
// capped well under that default and `idle` means "nothing yet, run me again" -
// the loop lives in the agent's turn, where it is visible, instead of inside
// one very long command.
//
// The budget is spent in short server-side waits rather than one long one, so a
// dropped connection costs one leg instead of the whole poll.

import { resolveSession } from './session.mjs';
import { settle } from './paths.mjs';
import * as out from './out.mjs';

export const DEFAULT_WAIT = 90;
const LEG = 25;   // one server-side wait; comfortably inside keepAliveTimeout (65 s)

export function parseArgs(argv) {
  const o = { wait: DEFAULT_WAIT, doc: '', reply: null, rootFlag: '', root: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wait') o.wait = Number(argv[++i]);
    else if (a === '--doc') o.doc = argv[++i];
    else if (a === '--reply') o.reply = argv[++i];
    else if (a === '--root') o.rootFlag = argv[++i];
    else if (!a.startsWith('--')) o.doc = a;
    else out.usage(`unknown flag ${a}`);
  }
  return settle(o);
}

export async function main(argv, { resolveTarget } = {}) {
  const opts = parseArgs(argv);
  if (!Number.isFinite(opts.wait) || opts.wait <= 0) out.usage('usage: sw-tender-discovery-tool poll [--wait <seconds>] [--reply <text>] [--doc <path>]');

  const found = await resolveSession(opts.root, opts.doc, resolveTarget);
  if (found.error) {
    if (found.error.kind === 'usage') out.usage(found.error.message);
    out.unreachable(found.error.message);
  }
  const base = found.lock.url.replace(/\/+$/, '');

  // Closes the run currently open (whichever one that is - the server resolves it from
  // the active run when no batch id is given), then falls straight into the same wait
  // loop below: one command instead of `emit done` followed by a separate `poll`.
  if (opts.reply != null) {
    let res;
    try {
      res = await fetch(`${base}/api/agent/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: opts.reply }),
      });
    } catch (e) {
      out.unreachable(`poll --reply: ${e.message} (is the Tender Discovery Tool running at ${base}?)`);
    }
    if (!res.ok) out.unreachable(`poll --reply: HTTP ${res.status}`);
    const replied = await res.json().catch(() => ({}));
    out.line('replied', replied.batch ?? replied.entry?.batch ?? 'none');
  }

  const stopTicks = out.waitBanner(`waiting for the page (up to ${opts.wait}s) ...`);
  const deadline = Date.now() + opts.wait * 1000;
  try {
    while (Date.now() < deadline) {
      const leg = Math.max(1, Math.min(LEG, Math.ceil((deadline - Date.now()) / 1000)));
      let res;
      try {
        res = await fetch(`${base}/api/next?wait=${leg}`);
      } catch (e) {
        out.unreachable(`poll: ${e.message} (is the Tender Discovery Tool running at ${base}?)`);
      }
      if (!res.ok) out.unreachable(`poll: HTTP ${res.status}`);
      const body = await res.json();

      if (body.event === 'batch') {
        out.line('event', 'batch');
        out.line('batch', body.batch?.id || '');
        // Absolute for the agent to open, relative for a log to keep. The
        // agent's cwd is not this process's cwd, so the machine field is
        // the one that has to resolve from anywhere.
        if (body.batch?.fileAbs || body.batch?.file) {
          out.line('batch_file', body.batch.fileAbs || body.batch.file);
          if (body.batch.file) out.line('batch_file_rel', body.batch.file);
        }
        out.nextStep(`read the batch file, do the work, then\n\`sw-tender-discovery-tool emit done --batch ${body.batch?.id || '<id>'} -\``);
        out.payload(body.batch);
        return;
      }
      if (body.event === 'closed') {
        out.line('event', 'closed');
        out.nextStep('the session is over: stop polling and summarise it for the user');
        return;
      }
    }
    out.line('event', 'idle');
    out.nextStep('nothing yet - run `sw-tender-discovery-tool poll` again');
  } finally {
    stopTicks();
  }
}
