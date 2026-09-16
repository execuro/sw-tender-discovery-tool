// The server's view of the workbook import: what the steering screen reads, and what confirming
// it writes. Kept out of server.mjs so the session file stays about sessions.
//
// Two copies of the mapping exist on purpose:
//   * `specs/.editor/<slug>/import-map.json` — the draft, saved on every change, gitignored;
//   * `<source dir>/<basename>/import-map.json` — the confirmed one, committed next to the CSVs
//     it describes, hashed into the analysis frontmatter and read by `export --xlsx`.
import fs from 'node:fs';
import path from 'node:path';
import { readWorkbook } from './xlsx.mjs';
import { proposeMap, validateMap, writeTables } from './import-map.mjs';

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/**
 * Where the three import files live for one session target.
 *
 * `target.source` is repo-relative (see `resolveTarget`), while `specsDir` is absolute — so the
 * workbook is resolved against the directory the document lives in, never against the server's
 * current working directory, which is not the host repo when the server was started detached.
 */
export function importPaths(target) {
  const base = path.basename(target.source || '', path.extname(target.source || ''));
  const workbook = path.resolve(target.specsDir, path.basename(target.source || ''));
  const outDir = path.join(target.specsDir, base);
  return {
    workbook,
    snapshot: path.join(target.sessionDir, 'import-snapshot.json'),
    draft: path.join(target.sessionDir, 'import-map.json'),
    proposed: path.join(target.sessionDir, 'import-map.proposed.json'),
    outDir,
    confirmed: path.join(outDir, 'import-map.json'),
  };
}

/**
 * What the page needs to render the steering screen: the sheet grids, the mapping in whatever
 * state it is in (confirmed, drafted, or freshly proposed), and whether the workbook has changed
 * under a mapping that was already confirmed.
 *
 * Returns null when this tender is not a workbook — every CSV, markdown and PDF tender.
 */
export function readImportState(target) {
  if (!target?.source || path.extname(target.source).toLowerCase() !== '.xlsx') return null;
  const p = importPaths(target);
  const snapshot = readJson(p.snapshot);
  if (!snapshot) return null;

  const confirmed = readJson(p.confirmed);
  const map = readJson(p.draft) || confirmed || readJson(p.proposed) || proposeMap(snapshot);

  let stale = false;
  if (confirmed?.sha256 && snapshot.sha256 && confirmed.sha256 !== snapshot.sha256) stale = true;

  return {
    available: true,
    source: snapshot.source,
    sha256: snapshot.sha256,
    readAt: snapshot.readAt,
    confirmedAt: confirmed?.confirmedAt || null,
    stale,
    map,
    // The grids stay out of this payload: `/api/session` already ships the whole document model.
    // The page asks for one sheet at a time through `/api/import/sheet/<index>`.
    sheets: snapshot.sheets.map(s => ({
      index: s.index, name: s.name, state: s.state, width: s.width, height: s.height,
      truncated: Boolean(s.truncated), merges: s.merges, dropdowns: s.dropdowns,
      hiddenRows: s.hiddenRows, hiddenCols: s.hiddenCols,
      // Enough rows to recognise a header and steer it, not the whole sheet.
      preview: s.rows.slice(0, 30).map(row => row.slice(0, 40).map(cell => String(cell).slice(0, 200))),
    })),
  };
}

/** One sheet's full grid, for the steering screen's "show every row". */
export function readImportSheet(target, index) {
  const snapshot = readJson(importPaths(target).snapshot);
  if (!snapshot) return null;
  return snapshot.sheets.find(s => s.index === Number(index)) || null;
}

/**
 * Writes the normalised CSVs and the committed mapping. The workbook is re-read here rather than
 * taken from the snapshot: the CSVs must come from the client's actual file, not from a cached
 * grid that could be stale.
 */
export function confirmImportMap(target, map) {
  const problems = validateMap(map);
  if (problems.length) return { problems };

  const p = importPaths(target);
  const buf = fs.readFileSync(p.workbook);
  const wb = readWorkbook(buf, { label: path.basename(p.workbook) });
  const written = writeTables(wb, map, p.outDir);

  const confirmed = { ...map, confirmedAt: new Date().toISOString(), confirmedBy: 'page' };
  fs.mkdirSync(p.outDir, { recursive: true });
  fs.writeFileSync(p.confirmed, JSON.stringify(confirmed, null, 2) + '\n', 'utf8');

  const req = (map.tables || []).filter(t => t.role === 'requirements');
  const ctx = (map.tables || []).filter(t => t.role === 'context');
  const ignored = (map.tables || []).filter(t => t.role === 'ignored').length + (map.ignored?.length || 0);
  const rows = req.reduce((n, t) => n + Math.max(0, t.lastDataRow - t.headerRow), 0);

  return {
    problems: [],
    map: confirmed,
    written,
    mapPath: p.confirmed,
    summary: `${req.length} requirement table${req.length === 1 ? '' : 's'} (${rows} rows), ${ctx.length} context table${ctx.length === 1 ? '' : 's'}, ${ignored} sheet${ignored === 1 ? '' : 's'} ignored`,
  };
}

// The server validates a draft without writing anything; same rules, one entry point.
confirmImportMap.validate = validateMap;
