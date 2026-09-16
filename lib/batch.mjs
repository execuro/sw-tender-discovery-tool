// `batch` - queue a batch for the agent, replacing the raw `POST api/batch` curl.
//
//   sw-tender-discovery-tool batch --kind batch|reconcile|analyze|export [--stage "<label>"] [--force] [--doc <path>]
//
// The four kinds are the server's own: `analyze` builds the analysis from the
// client's source, `reconcile` re-reads ticks, `batch` carries the user's notes,
// `export` writes the response files. The server refuses a kind that does not
// apply (export before the ready gate, analyze over an existing analysis
// without --force) and its reason is passed straight through.

import { readFileSync } from 'node:fs';
import { resolveSession } from './session.mjs';
import { settle } from './paths.mjs';
import * as out from './out.mjs';

const KINDS = ['batch', 'reconcile', 'analyze', 'export'];
const USAGE = `usage: sw-tender-discovery-tool batch --kind ${KINDS.join('|')} [--stage "<label>"] [--force] [--doc <path>]`;

export function parseArgs(argv) {
  const o = { kind: '', stage: '', force: false, doc: '', rootFlag: '', root: '', stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') o.kind = argv[++i];
    else if (a === '--stage') o.stage = argv[++i];
    else if (a === '--doc') o.doc = argv[++i];
    else if (a === '--root') o.rootFlag = argv[++i];
    else if (a === '--force') o.force = true;
    else if (a === '-') o.stdin = true;
    else out.usage(`unknown flag ${a}\n${USAGE}`);
  }
  return settle(o);
}

export async function main(argv, { resolveTarget } = {}) {
  const opts = parseArgs(argv);
  if (!KINDS.includes(opts.kind)) out.usage(`${opts.kind ? `unknown batch kind ${opts.kind}` : 'missing --kind'}\n${USAGE}`);

  // A body on stdin is optional here: it only carries notes/chat for `batch`.
  let body = { kind: opts.kind };
  if (opts.stdin) {
    const raw = readFileSync(0, 'utf8').trim();
    if (raw) {
      try { body = { ...JSON.parse(raw), kind: opts.kind }; } catch (e) { out.usage(`batch: body is not valid JSON (${e.message})`); }
    }
  }
  if (opts.stage) body.stage = opts.stage;
  if (opts.force) body.force = true;

  const found = await resolveSession(opts.root, opts.doc, resolveTarget);
  if (found.error) {
    if (found.error.kind === 'usage') out.usage(found.error.message);
    out.unreachable(found.error.message);
  }
  const base = found.lock.url.replace(/\/+$/, '');

  try {
    const res = await fetch(`${base}/api/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = JSON.parse(text || '{}');
    if (!res.ok) {
      // The server's refusal is the useful part; keep its reasons intact.
      out.line('refused', String(res.status));
      out.line('reason', json.error || text);
      out.nextStep('fix the refusal reason, then retry `sw-tender-discovery-tool batch`');
      if (json.reasons) out.payload(json.reasons);
      process.exit(out.EXIT_USAGE);
    }
    out.line('batch', json.id || '');
    if (json.file) out.line('batch_file', json.file);
    out.line('queued', String(Boolean(json.queued)));
    out.nextStep('run `sw-tender-discovery-tool poll` to pick it up');
  } catch (e) {
    out.unreachable(`batch: ${e.message} (is the Tender Discovery Tool running at ${base}?)`);
  }
}
