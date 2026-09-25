// `batch` - queue a batch for the agent, replacing the raw `POST api/batch` curl.
//
//   sw-tender-discovery-tool batch --kind intake|analyze|reestimate|notes|export [--stage "<label>"] [--force] [--doc <path>]
//
// The five kinds are the server's own (build contract §4): `intake` extracts scope items from a
// PDF, `analyze` assesses queued items, `reestimate` re-runs items `reestimate.json` marked,
// `notes` carries the operator's annotations/chat only, `export` maps the Requirement Coverage ->
// client-token map (`tokens --suggest`/`--file`, RC-4) then exports — the server enqueues this one
// itself from `POST /api/export` when coverage tokens are missing and an agent is present; queuing
// it directly here works the same way. The server refuses a kind that
// does not apply (analyze over an existing analysis without --force) and its reason is passed
// straight through.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveSession } from './session.mjs';
import { settle } from './paths.mjs';
import { parse } from './parse.mjs';
import { hasAnalyzeWork } from './calc.mjs';
import { reestimateList } from './proposals.mjs';
import * as out from './out.mjs';

const KINDS = ['intake', 'analyze', 'reestimate', 'notes', 'export'];
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

  // Own-tabs (contract §3): `analyze` is refused while the document is still under review — the
  // server refuses it too (WP-5), but a local pre-check saves the round trip and gives the same
  // reason without a live session's cooperation. Best-effort: when the analysis path cannot be
  // derived (no `--doc`, a session found by scanning), the server's own refusal is what fires.
  if (opts.kind === 'analyze') {
    const analysisAbs = found.target?.analysis
      ? path.resolve(opts.root || found.sessionDir, found.target.analysis)
      : path.join(path.dirname(path.dirname(found.sessionDir)), `${found.slug}-analysis.md`);
    if (existsSync(analysisAbs)) {
      let model;
      try { model = parse(readFileSync(analysisAbs, 'utf8'), { path: analysisAbs }); } catch { model = null; }
      if (model?.frontmatter?.data?.intake === 'review') {
        out.line('reason', 'analyze is refused while intake is under review — run `intake-confirm` first');
        out.nextStep('review the intake (Overview banner), fix it with `move`/`skip`/`restore`/`info`, then `intake-confirm <doc>`');
        process.exit(out.EXIT_USAGE);
      }
      // Same rule as the server (WP-5): once intake is confirmed, analyze is accepted whenever
      // there is work to do (items still queued/reopened, or items reestimate.json marks);
      // otherwise --force is required.
      if (model && !opts.force && !hasAnalyzeWork(model.items, reestimateList(opts.root, found.slug))) {
        out.line('reason', `${found.target?.analysis || analysisAbs} already exists; send --force to re-analyse`);
        out.nextStep('re-run with --force, or wait until there is work to analyse');
        process.exit(out.EXIT_USAGE);
      }
    }
  }

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
    // SI-4/IN-11: the server computes `items` (up to ~15 ids, page order) when the body sends
    // none of its own — visible here so a `batch --kind analyze` run from the terminal sees
    // exactly what the page's auto-queued chunk would.
    if (Array.isArray(json.items) && json.items.length) out.line('items', json.items.join(', '));
    out.line('queued', String(Boolean(json.queued)));
    out.nextStep('run `sw-tender-discovery-tool poll` to pick it up');
  } catch (e) {
    out.unreachable(`batch: ${e.message} (is the Tender Discovery Tool running at ${base}?)`);
  }
}
