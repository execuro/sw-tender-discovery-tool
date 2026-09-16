// `emit` - the only channel from the agent back to the Tender Discovery Tool page.
//
//   sw-tender-discovery-tool emit progress "<text>"  [--batch b-17] [--since <iso>]
//   sw-tender-discovery-tool emit chat "<markdown>"  [--batch b-17] [--since <iso>]
//   sw-tender-discovery-tool emit done "<markdown>"   --batch b-17  [--since <iso>]
//   sw-tender-discovery-tool emit reply ...           alias of done
//
// `done` is the final reply and releases the lock; `chat` is interim and leaves
// the run active.
//
// --since <ISO-8601> prefixes the text with "+m:ss" (elapsed since that
// instant). An unparseable or missing --since is ignored rather than an error,
// because a missing timestamp must never cost the agent its message.
//
// --doc is accepted and ignored: a session here covers one analysis, so there
// is no tab to address. It exists so the two editors take the same arguments
// and the skills can describe them once.
//
// The text may be piped on stdin, with "-" as the text argument.

import { readFileSync } from 'node:fs';
import { resolveSession } from './session.mjs';
import { settle } from './paths.mjs';
import * as out from './out.mjs';

const ENDPOINTS = {
  progress: '/api/agent/progress',
  chat: '/api/agent/chat',
  done: '/api/agent/reply',
  reply: '/api/agent/reply',
};

const USAGE = 'usage: sw-tender-discovery-tool emit progress|chat|done "<text>" [--batch <id>] [--since <iso>]';
const KNOWN_FLAGS = ['--batch', '--since', '--root', '--doc'];

export function parseArgs(argv) {
  const o = { batch: '', since: '', rootFlag: '', root: '', rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--batch') o.batch = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--root') o.rootFlag = argv[++i];
    else if (a === '--doc') i++;   // accepted for symmetry with the Specs Editor
    else if (a === '--') { o.rest.push(...argv.slice(i + 1)); break; }   // end of options: the rest is message text
    else if (a.startsWith('--') && !KNOWN_FLAGS.includes(a)) out.usage(`unknown flag ${a}\n${USAGE}\n(a message that starts with -- goes after a bare --, or on stdin with -)`);
    else o.rest.push(a);
  }
  // `--doc` here names nothing on disk, so there is no anchor to canonicalise.
  return settle(o, { anchorKey: null });
}

/** "+m:ss " prefix, or the text untouched when --since is absent or unparseable. */
export function withElapsed(text, since) {
  if (!since) return text;
  const started = Date.parse(since);
  if (Number.isNaN(started)) return text;
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  return `+${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} ${text}`;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, ...textParts] = opts.rest;
  if (!cmd) out.usage(USAGE);

  const endpoint = ENDPOINTS[cmd];
  if (!endpoint) out.usage(`unknown emit command ${cmd}\n${USAGE}`);

  let text = textParts.join(' ');
  if (text === '-' || (!text && !process.stdin.isTTY)) text = readFileSync(0, 'utf8');
  text = withElapsed(text, opts.since);

  const found = await resolveSession(opts.root, '', null);
  if (found.error) {
    if (found.error.kind === 'usage') out.usage(found.error.message);
    out.unreachable(found.error.message);
  }
  const base = found.lock.url.replace(/\/+$/, '');

  try {
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, markdown: text, batch: opts.batch || undefined }),
    });
    const body = await res.text();
    if (!res.ok) out.unreachable(`emit ${cmd}: HTTP ${res.status} ${body}`);
    out.line('emitted', cmd);
    if (cmd === 'done' || cmd === 'reply') out.nextStep('run `sw-tender-discovery-tool poll` to wait for the next batch');
    else out.nextStep('continue the work, then `sw-tender-discovery-tool emit done` when the batch is finished');
    if (body.trim() && body.trim() !== '{"ok":true}') out.payload(body.trim());
  } catch (e) {
    out.unreachable(`emit ${cmd}: ${e.message} (is the Tender Discovery Tool running at ${base}?)`);
  }
}
