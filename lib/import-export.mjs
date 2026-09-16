// `import` / `export` - the client's xlsx workbook in and out.
//
// `import` reads the workbook into a grid snapshot and proposes the mapping the
// architect confirms on the page; `export` writes the answers back into a COPY,
// leaving the client's original byte-identical.
//
// Entry point is bin/cli.mjs. This module exports main(argv) and never reads
// process.argv itself, so it works the same through an npx `.bin` symlink.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readWorkbook, sheetToGrid, XlsxError } from './xlsx.mjs';
import { proposeMap, validateMap, writeTables, csvNameFor } from './import-map.mjs';
import { patchWorkbook, editsFromResponseCsv } from './xlsx-patch.mjs';
import * as out from './out.mjs';
import { resolveRoot, canonical } from './paths.mjs';

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));

// bin/cli.mjs owns the canonical multi-command USAGE; this is only the
// detail an import/export argument error needs.
const USAGE = `usage:
  sw-tender-discovery-tool import --source <file.xlsx> [--root <dir>] [--map] [--accept-proposed]
  sw-tender-discovery-tool export --xlsx --source <file.xlsx> [--root <dir>]`;

const KNOWN_FLAGS = ['source', 'doc', 'root', 'map', 'accept-proposed', 'xlsx'];

/** Delegates to the output contract, keyed by exit code. */
function fail(code, message) {
  if (code === out.EXIT_USAGE) out.usage(message);
  else out.unreachable(message);
}

/** Flags only; no positional arguments, so a path is never mistaken for a command. */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (!KNOWN_FLAGS.includes(key)) fail(out.EXIT_USAGE, `unknown flag --${key}\n\n${USAGE}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Atomic write, same `.tmp` + rename rule the server uses so a watcher never sees a half file. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
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

// ---------------------------------------------------------------- import

function cmdImport(args) {
  const sourceArg = args.source || args.doc;
  if (!sourceArg || sourceArg === true) fail(2, `import needs --source <file.xlsx>\n\n${USAGE}`);
  const t = targetFor(sourceArg, args.root);
  if (path.extname(t.source).toLowerCase() !== '.xlsx') {
    fail(2, `import reads .xlsx workbooks; ${path.basename(t.source)} is not one. CSV, markdown and PDF sources go straight into the skill.`);
  }

  const buf = fs.readFileSync(t.source);
  let wb;
  try {
    wb = readWorkbook(buf, { label: path.basename(t.source) });
  } catch (err) {
    if (err instanceof XlsxError) fail(1, err.message);
    throw err;
  }

  const snapshot = {
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
  writeJson(path.join(t.sessionDir, 'import-snapshot.json'), snapshot);

  const mapFile = path.join(t.sessionDir, 'import-map.json');
  let map = null;
  if (fs.existsSync(mapFile)) {
    try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch { map = null; }
  }
  if (!map) {
    map = proposeMap(snapshot);
    writeJson(path.join(t.sessionDir, 'import-map.proposed.json'), map);
  }

  const visible = snapshot.sheets.filter(s => s.state === 'visible').length;
  const dropdowns = snapshot.sheets.reduce((n, s) => n + s.dropdowns.length, 0);
  const reqTables = (map.tables || []).filter(x => x.role === 'requirements');

  // The per-sheet table is the payload, and the output contract puts `next_step`
  // before it - so the outcome has to be decided before anything is printed.
  // A workbook can carry a lot of sheets; an agent that reads only the head of
  // this output still has to learn what to run next.
  const sheetTable = snapshot.sheets.map(s => {
    const t2 = reqTables.find(x => x.sheet === s.name);
    const note = s.state !== 'visible' ? 'ignored (hidden)'
      : s.name.startsWith('_') ? 'ignored (name starts with _)'
        : t2 ? `requirements · header row ${t2.headerRow} · rows ${t2.firstDataRow}-${t2.lastDataRow} · id ${t2.columns.id}`
          : 'context';
    return `  ${String(s.index).padStart(2)} ${s.name} — ${s.height}x${s.width} — ${note}`;
  }).join('\n');

  // Without the editor page there is no steering screen, so a plain run accepts the proposal
  // explicitly — the agent shows the table above and the user says yes. The mapping is still a
  // human decision, and it is committed exactly as the page's confirm would commit it.
  if (args['accept-proposed'] && !map.confirmedAt) {
    const problems = validateMap(map);
    if (problems.length) fail(1, `the proposed mapping needs steering on the page:\n  - ${problems.join('\n  - ')}`);
    map = { ...map, confirmedAt: new Date().toISOString(), confirmedBy: 'cli --accept-proposed' };
    writeJson(path.join(t.sessionDir, 'import-map.json'), map);
    fs.mkdirSync(t.outDir, { recursive: true });
    fs.writeFileSync(path.join(t.outDir, 'import-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
    args.map = true;
  }

  let written = null;
  if (map.confirmedAt && args.map) {
    const problems = validateMap(map);
    if (problems.length) fail(1, `the confirmed mapping is not usable:\n  - ${problems.join('\n  - ')}`);
    written = writeTables(wb, map, t.outDir);
  }

  out.line('source', path.basename(t.source));
  out.line('sheets', `${snapshot.sheets.length} (${visible} visible)`);
  out.line('dropdowns', String(dropdowns));
  out.line('requirement_tables', String(reqTables.length));
  if (written) for (const w of written) out.line('wrote', `${path.join(path.relative(t.root, t.outDir), w.file)} (${w.rows} rows)`);
  else out.line('snapshot', path.relative(t.root, path.join(t.sessionDir, 'import-snapshot.json')));

  if (written) out.nextStep(`continue the analysis; the normalised CSVs under ${path.relative(t.root, t.outDir)}/ are the source the skill reads`);
  else out.nextStep('confirm the mapping — on the tender page (--editor), or, if the sheet table below is already right, re-run this command with --map --accept-proposed');

  out.payload(sheetTable);
}

// ---------------------------------------------------------------- export

function cmdExport(args) {
  if (!args.xlsx) fail(2, `export needs --xlsx (the response CSVs are written by the skill)\n\n${USAGE}`);
  const sourceArg = args.source || args.doc;
  if (!sourceArg || sourceArg === true) fail(2, `export needs --source <file.xlsx>\n\n${USAGE}`);
  const t = targetFor(sourceArg, args.root);

  const mapFile = path.join(t.sessionDir, 'import-map.json');
  if (!fs.existsSync(mapFile)) fail(1, `no confirmed import mapping for ${t.slug}; run import and confirm the mapping on the page first`);
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

  const edits = [];
  const tables = [];
  for (const table of map.tables || []) {
    if (table.role !== 'requirements') continue;
    const file = path.join(t.dir, `${t.slug}-response-${table.n}-${table.slug}.csv`);
    if (!fs.existsSync(file)) fail(1, `missing response CSV for table ${table.n} (${table.sheet}): ${path.relative(t.root, file)}`);
    const result = editsFromResponseCsv(fs.readFileSync(file, 'utf8'), table);
    if (result.problems.length) fail(1, `response CSV for table ${table.n} does not match the mapping:\n  - ${result.problems.join('\n  - ')}`);
    edits.push(...result.edits);
    tables.push({ n: table.n, sheet: table.sheet, rows: result.rows });
  }
  if (!tables.length) fail(1, 'the mapping has no requirement table to write back');

  const src = fs.readFileSync(t.source);
  const before = sha256(src);
  const patched = patchWorkbook(src, edits);
  const outFile = path.join(t.dir, `${t.slug}-response.xlsx`);
  fs.writeFileSync(outFile, patched);

  // The client's original is opened read-only; prove it rather than assert it.
  if (sha256(fs.readFileSync(t.source)) !== before) fail(1, 'refusing to continue: the source workbook changed during export');

  out.line('wrote', `${path.relative(t.root, outFile)} (${edits.length} cells across ${tables.length} table${tables.length === 1 ? '' : 's'})`);
  out.line('original_untouched', `${path.basename(t.source)} ${before.slice(0, 12)}…`);
  out.nextStep('send the client the response workbook alongside the per-table response CSVs');
  out.payload(tables.map(x => `  table ${x.n} ${x.sheet}: ${x.rows} rows`).join('\n'));
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
    if (err instanceof XlsxError) fail(1, err.message);
    fail(1, err?.stack || String(err));
  }
}


