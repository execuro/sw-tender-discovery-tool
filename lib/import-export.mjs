// `import` / `export` - the client's workbook in, the answers out.
//
// `import` reads an xlsx or CSV source into a grid snapshot and proposes the mapping the
// operator confirms on the page (task 1/2); `export` writes the answers back — into a COPY of
// the client's own xlsx (surgical, X-2..X-4), or into a fresh working-sheet workbook built from
// the analysis when the source was CSV or PDF (X-5).
//
// Entry point is bin/cli.mjs. This module exports main(argv) and never reads
// process.argv itself, so it works the same through an npx `.bin` symlink.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readWorkbook, sheetToGrid, XlsxError } from './xlsx.mjs';
import { proposeMap, snapshotFromCsv, coverageMapComplete, readFitBack } from './import-map.mjs';
import { renderDigest } from './digest.mjs';
import { patchWorkbook, withFullCalcOnLoad } from './xlsx-patch.mjs';
import { buildResponseWorkbook, scanMoneyBeforeBuild } from './xlsx-build.mjs';
import { parse } from './parse.mjs';
import { exportText, resolveTable } from './export-text.mjs';
import { readProfile, regime as regimeOf } from './profile.mjs';
import { regimeLabel } from './check.mjs';
import * as proposalsMod from './proposals.mjs';
import * as out from './out.mjs';
import { resolveRoot, canonical } from './paths.mjs';
import { appendLogLine } from './report.mjs';
import { atomicWrite } from './edit.mjs';

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));

// bin/cli.mjs owns the canonical multi-command USAGE; this is only the
// detail an import/export argument error needs.
const USAGE = `usage:
  sw-tender-discovery-tool import --source <file.xlsx|file.csv> [--root <dir>]
  sw-tender-discovery-tool export <doc> [--out <file>] [--root <dir>]`;

const KNOWN_FLAGS = ['source', 'doc', 'root', 'out'];

/** Delegates to the output contract, keyed by exit code. */
function fail(code, message) {
  if (code === out.EXIT_USAGE) out.usage(message);
  else out.unreachable(message);
}

/** `export` takes one positional `<doc>`; `import` takes none (a path is never mistaken for a
 * command). Positionals collect into `opts._`; flags parse the same way for both. */
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    if (!KNOWN_FLAGS.includes(key)) fail(out.EXIT_USAGE, `unknown flag --${key}\n\n${USAGE}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Atomic write, same `.tmp` + rename rule the server uses so a watcher never sees a half file. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * `specs/.rfp/<slug>/exports.json` — this tool's own previous exports for this document (#1),
 * `[{version, file, at, items}]` (D-34): `items` snapshots each confirmed item's export text
 * (`itemExportText` below) at that version — the baseline `changedSinceLast`/`sinceExportIds`
 * diff against. An install that wrote the old shape (a bare absolute-path string per entry, no
 * numbering) is read back as `{version: null, file: e, at: null, items: {}}`: enough to keep
 * naming previously-written files, not enough to diff against.
 */
function exportsFile(root, slug) { return path.join(root, 'specs', '.rfp', slug, 'exports.json'); }

function normalizeExportEntry(e) {
  if (typeof e === 'string') return { version: null, file: e, at: null, items: {} };
  return { version: typeof e.version === 'number' ? e.version : null, file: e.file, at: e.at ?? null, items: e.items || {} };
}

function loadExports(root, slug) {
  try {
    const parsed = JSON.parse(fs.readFileSync(exportsFile(root, slug), 'utf8'));
    return Array.isArray(parsed) ? parsed.map(normalizeExportEntry) : [];
  } catch { return []; }
}

/** The most recently written entry (highest `version`); `null` before any export exists. An entry
 * with no version (the pre-D-34 shape) never wins this — it carries no usable snapshot anyway. */
function lastExportEntry(entries) {
  return entries.reduce((best, e) => (typeof e.version === 'number' && (!best || e.version > best.version) ? e : best), null);
}

/** The next free version number for this document's exports: one past the highest version
 * recorded in `exports.json`, OR already present as a `<base>-response-v<n>.xlsx` file on disk if
 * that is higher (the two can disagree if `exports.json` was ever lost or hand-edited) — so a
 * numbered export is never reused either way. */
function nextVersion(dir, base, entries) {
  let max = 0;
  for (const e of entries) if (typeof e.version === 'number' && e.version > max) max = e.version;
  const re = new RegExp(`^${escapeRegExp(base)}-response-v(\\d+)\\.xlsx$`, 'i');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { files = []; }
  for (const f of files) { const m = re.exec(f); if (m && Number(m[1]) > max) max = Number(m[1]); }
  return max + 1;
}

function recordExport(root, slug, file, version, items) {
  const known = loadExports(root, slug);
  known.push({ version, file: path.resolve(file), at: new Date().toISOString(), items });
  writeJson(exportsFile(root, slug), known);
}

/** What `export` would write for one confirmed item right now (token/response/effort/assumptions,
 * folded into one comparable string) — the baseline `changedSinceLast`/`sinceExportIds` diff
 * against. `map` is the fit-back map for an xlsx source, `null` for a CSV/PDF source (no per-item
 * pointer or token map at all, N-5). */
function itemExportText(item, map) {
  const table = map ? resolveTable(map, item) : {};
  const t = exportText(item, table);
  return JSON.stringify([t.token, t.response, t.effort, t.assumptions]);
}

/** Ids whose current export text differs from `previous`'s snapshot, or that are newly confirmed
 * (absent from `previous` altogether) — "changed since last export" (D-34), shared by
 * `exportWorkbook` (against the entry it is about to supersede) and `sinceExportIds` (against the
 * last entry recorded, read-only). */
function changedIds(current, previous) {
  const ids = [];
  for (const [id, text] of Object.entries(current)) if (!(id in previous) || previous[id] !== text) ids.push(id);
  return ids;
}

/**
 * Ids changed since the last export was written, for the page's "changed since last export"
 * filter and `/api/session`'s `sinceExport` (D-34): `null` before this document has ever been
 * exported, an id array (possibly empty) after. Read-only — never records anything.
 */
export function sinceExportIds(root, slug, items, map = null) {
  const last = lastExportEntry(loadExports(root, slug));
  if (!last) return null;
  const current = {};
  for (const it of items || []) if (it.status?.kind === 'confirmed') current[it.id] = itemExportText(it, map);
  return changedIds(current, last.items || {});
}

/**
 * Refuses an `--out` that (#3): does not end in `.xlsx`; resolves to the source file itself; or
 * resolves to the working document (`docAbs`, when the caller has it). The `.xlsx` requirement
 * also means `--out` never lands on an existing non-xlsx file: the path itself already carries
 * the wrong name for that.
 *
 * D-34: also refuses an `--out` (or the default numbered path) that already exists on disk, full
 * stop — export never overwrites a file, its own previous export included; every export gets its
 * own `-response-v<n>.xlsx` name, so a genuine re-export never needs to collide with one.
 */
function resolveOutFile(dir, outArg, defaultName, sourceAbs, docAbs = null) {
  const outFile = outArg ? path.resolve(dir, outArg) : path.join(dir, defaultName);
  if (!/\.xlsx$/i.test(outFile)) {
    throw new Error(`refusing to export: --out must end in .xlsx (got: ${path.basename(outFile)})`);
  }
  if (path.resolve(outFile) === path.resolve(sourceAbs)) {
    throw new Error(`refusing to export: --out resolves to the source file (${sourceAbs})`);
  }
  if (docAbs && path.resolve(outFile) === path.resolve(docAbs)) {
    throw new Error(`refusing to export: --out resolves to the working document (${docAbs})`);
  }
  if (fs.existsSync(outFile)) {
    throw new Error(`refusing to export: ${outFile} already exists — export never overwrites a file`);
  }
  return outFile;
}

/**
 * Session paths for a source file, matching `server.mjs:resolveTarget`: the slug is the file
 * name without its extension, session state lives in `<specs>/.editor/<slug>/`.
 */
function targetFor(sourceArg, rootArg) {
  // The workbook is the anchor: it names its own repository by sitting inside
  // it, so the root does not depend on where the command was run.
  const source = canonical(sourceArg);
  if (!fs.existsSync(source)) fail(2, `source not found: ${sourceArg}`);
  const real = fs.realpathSync(source);
  const root = resolveRoot({ rootFlag: rootArg && rootArg !== true ? rootArg : '', docAbs: real });
  const dir = path.dirname(real);
  const base = path.basename(real, path.extname(real));
  return {
    root,
    source: real,
    rel: path.relative(root, real) || path.basename(real),
    slug: base,
    dir,
    outDir: path.join(dir, base),
    sessionDir: path.join(dir, '.editor', base),
  };
}

// ---------------------------------------------------------------- import (contract §3, §5, §8)

/**
 * `importSource({ root, source }) → { snapshot, proposed, digestPath }` (contract §8). Reads an
 * xlsx or CSV source into a grid snapshot, proposes a mapping from it (`proposeMap`'s own
 * heuristics, kept only as the digest's own `Proposed:` line — nothing here is confirmed any
 * more, there is no wizard), and writes `import-snapshot.json`, `import-map.proposed.json` and the
 * digest `sw-tender-editor`'s `extract` job reads (contract §5). `source` is an absolute path.
 */
export function importSource({ root, source }) {
  const t = targetFor(source, root);
  const ext = path.extname(t.source).toLowerCase();
  if (!['.xlsx', '.csv'].includes(ext)) {
    throw new Error(`import reads .xlsx or .csv sources; ${path.basename(t.source)} is not one. Markdown and PDF sources go straight into the skill.`);
  }

  let snapshot;
  if (ext === '.xlsx') {
    const buf = fs.readFileSync(t.source);
    let wb;
    try {
      wb = readWorkbook(buf, { label: path.basename(t.source) });
    } catch (err) {
      if (err instanceof XlsxError) throw err;
      throw err;
    }
    snapshot = {
      source: t.rel,
      sha256: sha256(buf),
      readAt: new Date().toISOString(),
      epoch1904: wb.epoch1904,
      sheets: wb.sheets.map(sheet => {
        const grid = sheetToGrid(sheet);
        return {
          index: sheet.index,
          name: sheet.name,
          state: sheet.state,
          part: sheet.part,
          width: grid.width,
          height: grid.height,
          truncated: grid.truncated,
          rows: grid.rows,
          hiddenRows: grid.hiddenRows,
          hiddenCols: grid.hiddenCols,
          merges: sheet.merges,
          dropdowns: sheet.validations.filter(v => v.values?.length).map(v => ({ sqref: v.sqref, values: v.values })),
        };
      }),
    };
  } else {
    // CSV goes through the same digest (task 2): one "sheet", its own delimiter detected from
    // the file itself, no dropdown metadata to guess tokens from.
    const text = fs.readFileSync(t.source, 'utf8');
    snapshot = snapshotFromCsv(text, { source: t.rel, sha256: sha256(Buffer.from(text, 'utf8')), name: t.slug });
  }
  writeJson(path.join(t.sessionDir, 'import-snapshot.json'), snapshot);

  const proposed = proposeMap(snapshot);
  writeJson(path.join(t.sessionDir, 'import-map.proposed.json'), proposed);

  const digestPath = path.join(t.sessionDir, 'import-digest.md');
  fs.mkdirSync(path.dirname(digestPath), { recursive: true });
  fs.writeFileSync(digestPath, renderDigest(snapshot, proposed), 'utf8');

  return { snapshot, proposed, digestPath, root: t.root, rel: t.rel };
}

function cmdImport(args) {
  const sourceArg = args.source || args.doc;
  if (!sourceArg || sourceArg === true) fail(2, `import needs --source <file.xlsx|file.csv>\n\n${USAGE}`);
  const sourceAbs = canonical(sourceArg);
  if (!fs.existsSync(sourceAbs)) fail(2, `source not found: ${sourceArg}`);

  let result;
  try {
    result = importSource({ root: args.root && args.root !== true ? args.root : undefined, source: sourceAbs });
  } catch (e) {
    if (e instanceof XlsxError) fail(1, e.message);
    fail(1, e.message);
    return;
  }
  const { snapshot, proposed, digestPath, root } = result;

  const visible = snapshot.sheets.filter(s => s.state === 'visible').length;
  const dropdowns = snapshot.sheets.reduce((n, s) => n + s.dropdowns.length, 0);
  const reqTables = (proposed.tables || []).filter(x => x.role === 'requirements');

  out.line('source', path.basename(sourceAbs));
  out.line('sheets', `${snapshot.sheets.length} (${visible} visible)`);
  out.line('dropdowns', String(dropdowns));
  out.line('requirement_tables', String(reqTables.length));
  out.line('digest', path.relative(root, digestPath));
  out.nextStep(`run the \`sw-tender-editor\` extract job on the digest, then \`intake <doc> --source ${path.relative(root, sourceAbs)} --extraction <json>\``);
}

// ---------------------------------------------------------------- export (X-1..X-8)

/**
 * The fit-back map path for a document's xlsx source, resolved from its own frontmatter
 * `source-sha256` — shared with the `tokens` command (`lib/ops.mjs`'s `tokensSuggest`/
 * `tokensApply`) so both agree on which map is "the" map, exactly as `exportWorkbook` does. Throws
 * when the document names no source, or the source is not xlsx (RC-4 tokens only ever apply to a
 * surgical xlsx export).
 */
export function confirmedMapFileForDoc(model, docPath) {
  const sources = Object.keys(model.frontmatter?.data?.['source-sha256'] || {});
  if (!sources.length) throw new Error('the document names no source file (frontmatter source-sha256 is empty)');
  const sourceFile = sources[sources.length - 1];
  const ext = path.extname(sourceFile).toLowerCase();
  if (ext !== '.xlsx') throw new Error(`coverage tokens only apply to an xlsx source (this document's source is ${ext || 'unknown'})`);
  const dir = path.dirname(docPath);
  return path.join(dir, path.basename(sourceFile, ext), 'import-map.json');
}

/**
 * Appends the §8 Log line D-34 requires (`report.mjs`'s `appendLogLine`, the same section writer
 * `report` uses) and records the new entry in `exports.json`, then returns `changedSinceLast` —
 * ids whose export text differs from the entry this export supersedes, or that are newly
 * confirmed (D-34); computed against the last entry BEFORE this one is recorded, so an export
 * never counts as "changed since" itself.
 */
function finishExport(root, slug, docPath, text, model, outFile, version, written, skipped, notWritten, itemsSnapshot) {
  const last = lastExportEntry(loadExports(root, slug));
  const changedSinceLast = changedIds(itemsSnapshot, last?.items || {});
  recordExport(root, slug, outFile, version, itemsSnapshot);
  const prevLabel = version > 1 ? `v${version - 1}` : '—';
  const totalItems = written + skipped + notWritten.length;
  const line = `- ${today()} · export v${version} · ${path.relative(root, outFile)} · confirmed ${written}/${totalItems} · changed since ${prevLabel}: ${changedSinceLast.length}`;
  const nextText = appendLogLine(text, model.blocks, line);
  if (nextText !== text) atomicWrite(docPath, nextText);
  return changedSinceLast;
}

/**
 * `exportWorkbook(docPath, { out }) → { file, written, skipped, notWritten, version,
 * changedSinceLast }`. Anytime (X-1); intake state never gates it. Unconfirmed scope items export
 * with empty answer cells. An xlsx source is answered surgically, in a copy — the original is
 * read, never written (X-2/X-4), and each item is targeted by the fit-back map's own pointer
 * (contract §4), never by an id-column join or a positional count. A CSV or PDF source gets a
 * fresh working-sheet workbook built from the analysis itself (X-5). `notWritten` lists, one
 * string per item, `not written: <id> (no source row)` for every scope item the fit-back map has
 * no pointer for — never silently dropped.
 *
 * D-34: every export writes a fresh `<base>-response-v<n>.xlsx`, `n` the next free version — an
 * existing file (an explicit `--out` included) is never overwritten. `version` is `n`;
 * `changedSinceLast` lists the ids whose export text differs from the previous version's snapshot,
 * or that are newly confirmed. A §8 Log line records the same numbers in the working document.
 */
export function exportWorkbook(docPath, { out: outArg } = {}) {
  const text = fs.readFileSync(docPath, 'utf8');
  const model = parse(text, { path: docPath });
  if (model.errors.length) throw new Error(`cannot export a document with errors:\n  - ${model.errors.join('\n  - ')}`);

  const sources = Object.keys(model.frontmatter?.data?.['source-sha256'] || {});
  if (!sources.length) throw new Error('the document names no source file (frontmatter source-sha256 is empty)');
  const sourceFile = sources[sources.length - 1];
  const dir = path.dirname(docPath);
  const sourceAbs = path.join(dir, sourceFile);
  const ext = path.extname(sourceFile).toLowerCase();
  const root = resolveRoot({ docAbs: docPath });
  const { profile } = readProfile(root);
  const regimeStr = regimeOf(root);
  const regimeLbl = regimeLabel(regimeStr, profile);
  const slug = model.frontmatter?.data?.slug || path.basename(docPath).replace(/-analysis\.md$/i, '');
  const base = path.basename(sourceFile, ext);
  const version = nextVersion(dir, base, loadExports(root, slug));
  const defaultName = `${base}-response-v${version}.xlsx`;

  if (ext === '.xlsx') {
    if (!fs.existsSync(sourceAbs)) throw new Error(`source workbook not found: ${sourceFile}`);
    const map = readFitBack(root, sourceAbs);
    if (!map) throw new Error(`no fit-back map for ${sourceFile}; run intake to build the working document from this source first`);

    // RC-4, decided agentically at export time: every table with a compliance column needs its
    // six-value coverage -> client-token map (`tokens --file`) before a surgical export can write
    // real client tokens instead of our own words.
    const missingTokens = (map.tables || [])
      .filter(t => t.columns?.compliance && !coverageMapComplete(t.tokens?.coverage))
      .map(t => t.key);
    if (missingTokens.length) {
      const err = new Error(`refusing to export: coverage tokens not mapped — the export step maps them: ${missingTokens.join(', ')}`);
      err.reason = 'coverage tokens not mapped — the export step maps them';
      err.missingCoverageTables = missingTokens;
      throw err;
    }

    // X-7/R-7: scan tool-authored text before writing anything, never the client's own cells.
    const hits = scanMoneyBeforeBuild(model.items);
    if (hits.length) { const err = new Error(`refusing to export: money terms in tool-written text\n  - ${hits.join('\n  - ')}`); err.moneyHits = hits; throw err; }

    const before = fs.readFileSync(sourceAbs);
    const beforeHash = sha256(before);
    const wb = readWorkbook(before, { label: sourceFile });
    const sheetByPart = new Map(wb.sheets.map(s => [s.part, s]));
    const sheetByName = new Map(wb.sheets.map(s => [s.name, s]));
    const tableByKey = new Map((map.tables || []).map(t => [t.key, t]));

    const edits = [];
    let written = 0, skipped = 0;
    const notWritten = [];
    const itemsSnapshot = {};
    for (const item of model.items) {
      const pointer = map.items?.[item.id];
      const table = pointer && tableByKey.get(pointer.table);
      const sheet = table && (sheetByPart.get(table.part) || sheetByName.get(table.sheet));
      if (!pointer || !table || !sheet) { notWritten.push(`not written: ${item.id} (no source row)`); continue; }
      if (item.status?.kind !== 'confirmed') { skipped++; continue; }
      written++;
      const row = pointer.row;
      const text2 = exportText(item, resolveTable(map, item));
      itemsSnapshot[item.id] = JSON.stringify([text2.token, text2.response, text2.effort, text2.assumptions]);
      if (table.columns?.compliance) edits.push({ part: sheet.part, ref: `${table.columns.compliance}${row}`, value: text2.token });
      if (table.columns?.comment) edits.push({ part: sheet.part, ref: `${table.columns.comment}${row}`, value: text2.response });
      if (table.columns?.effort) edits.push({ part: sheet.part, ref: `${table.columns.effort}${row}`, value: text2.effort === '' ? '' : Number(text2.effort) });
      if (table.assumptionsColumn && text2.assumptions) edits.push({ part: sheet.part, ref: `${table.assumptionsColumn}${row}`, value: text2.assumptions });
    }

    const patched = withFullCalcOnLoad(patchWorkbook(before, edits));
    const outFile = resolveOutFile(dir, outArg, defaultName, sourceAbs, docPath);
    fs.writeFileSync(outFile, patched);
    if (sha256(fs.readFileSync(sourceAbs)) !== beforeHash) throw new Error('refusing to continue: the source workbook changed during export');
    const changedSinceLast = finishExport(root, slug, docPath, text, model, outFile, version, written, skipped, notWritten, itemsSnapshot);
    return { file: outFile, written, skipped, notWritten, version, changedSinceLast };

  } else if (ext === '.csv' || ext === '.pdf') {
    let hits;
    let buf;
    try {
      buf = buildResponseWorkbook(model, { regimeLabel: regimeLbl, profile, proposals: proposalsMod.list(root, slug) });
    } catch (e) {
      if (e.moneyHits) { hits = e.moneyHits; }
      else throw e;
    }
    if (hits) { const err = new Error(`refusing to export: money terms in tool-written text\n  - ${hits.join('\n  - ')}`); err.moneyHits = hits; throw err; }
    const outFile = resolveOutFile(dir, outArg, defaultName, sourceAbs, docPath);
    fs.writeFileSync(outFile, buf);
    const written = model.items.filter(it => it.status?.kind === 'confirmed').length;
    const skipped = model.items.length - written;
    const itemsSnapshot = {};
    for (const item of model.items) if (item.status?.kind === 'confirmed') itemsSnapshot[item.id] = itemExportText(item, null);
    const changedSinceLast = finishExport(root, slug, docPath, text, model, outFile, version, written, skipped, [], itemsSnapshot);
    return { file: outFile, written, skipped, notWritten: [], version, changedSinceLast };

  } else {
    throw new Error(`export does not know how to answer a ${ext || 'unknown'} source`);
  }
}

function cmdExport(args) {
  const docArg = (args._ || [])[0];
  if (!docArg) fail(2, `export needs <doc>\n\n${USAGE}`);
  const docAbs = canonical(docArg);
  if (!fs.existsSync(docAbs)) fail(2, `document not found: ${docArg}`);
  const root = resolveRoot({ rootFlag: args.root && args.root !== true ? args.root : '', docAbs });

  // #3: a relative --out resolves against the current directory (bin/cli.mjs's help text: "Relative
  // paths ... resolve against the current directory"), same as --doc/--source, not against the
  // document's own directory.
  const outArg = args.out && args.out !== true ? canonical(args.out) : undefined;

  let result;
  try {
    result = exportWorkbook(docAbs, { out: outArg });
  } catch (e) {
    fail(1, e.message);
    return;
  }

  out.line('wrote', `${path.relative(root, result.file)} (${result.written} confirmed, ${result.skipped} unconfirmed)`);
  out.line('version', `v${result.version}`);
  const changedIdsList = result.changedSinceLast;
  out.line('changed_since_last', `${changedIdsList.length}${changedIdsList.length ? ` (${changedIdsList.slice(0, 50).join(', ')}${changedIdsList.length > 50 ? ', …' : ''})` : ''}`);
  for (const m of result.notWritten || []) out.line('warning', m);
  out.nextStep('send the client the response workbook');
}

// ---------------------------------------------------------------- dispatch

const COMMANDS = { import: cmdImport, export: cmdExport };

// bin/cli.mjs only ever calls this module with argv[0] of 'import' or
// 'export' (it owns --help and unknown-command handling itself).
export function main(argv) {
  const run = COMMANDS[argv[0]];
  try {
    run(parseArgs(argv.slice(1)));
  } catch (err) {
    // #3: a clean { reason }, never a raw stack trace — e.g. an ENOENT from a bad --out directory.
    if (err instanceof XlsxError) fail(1, err.message);
    fail(1, err?.message || String(err));
  }
}


