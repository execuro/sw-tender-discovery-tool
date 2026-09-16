// Client source columns for the §4 grid: joins the analysis's `req` rows (by id) against the
// client's own export CSVs, so the page can show the client's wording next to our answer.
// Server-only (fs), not served to the browser.
import fs from 'node:fs';
import path from 'node:path';
import { clientColumnsFromMap, costColumnsFromMap, contextFilesFromMap } from './import-map.mjs';

// The three source tables that carry one row per requirement id, same header shape in every tender
// this tool has seen so far (`03-requirements.csv`, `04-non-functional-compliance.csv`,
// `07-vendor-response-evaluation.csv`); the other exports (cover, integrations, migration,
// glossary) are not row-per-id.
export const REQUIREMENT_FILES = ['03-requirements.csv', '04-non-functional-compliance.csv', '07-vendor-response-evaluation.csv'];

// Verbatim client headers this tool renders; anything past `Reference` (Vendor: …) is either
// re-derived by our own analysis columns or, for the two cost columns, deliberately left blank.
export const CLIENT_COLUMNS = ['Area', 'Sub-area', 'Title', 'Requirement', 'Priority', 'Type', 'Acceptance criteria / Notes', 'Reference'];
export const COST_COLUMNS = ['Vendor: One-off cost (EUR)', 'Vendor: Recurring cost / year (EUR)'];

/** RFC4180-ish tokenizer: quoted fields, doubled quotes, embedded commas/newlines, optional BOM. Every line becomes one row, blank lines included. */
export function parseRows(text) {
  const s = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

/**
 * Rows -> objects keyed by header. The header is not assumed to be line 1: some exports carry a
 * title row (and blank rows) above the real table, so this scans for the first row whose first
 * cell equals `key` (default `ID`) and treats that as the header; rows before it are ignored,
 * blank rows after it are skipped. The context exports key on something else — `#` for the
 * integration register and the migration inventory, `Term` for the glossary. No such row -> no
 * data (not an error: the file just isn't the table we were looking for).
 */
export function parseCsv(text, key = 'ID') {
  const rows = parseRows(text);
  const headerIdx = rows.findIndex(r => String(r[0] ?? '').trim() === key);
  if (headerIdx === -1) return [];
  const header = rows[headerIdx];
  return rows.slice(headerIdx + 1).filter(r => r.some(c => c !== '')).map(r => {
    const o = {};
    header.forEach((h, k) => { o[h] = r[k] ?? ''; });
    return o;
  });
}

/**
 * Reads `<specsDir>/<slug>/` for every file in `REQUIREMENT_FILES` (whichever exist) and joins them
 * into one `id -> client columns` map. Absent folder or files is not an error: a tender that came in
 * as markdown or PDF simply has no client columns to show.
 */
export function loadRequirementColumns(specsDir, slug) {
  const dir = path.join(specsDir, slug);
  const map = loadImportMap(specsDir, slug);
  // With a confirmed mapping the file names, the id column and the client columns all come from
  // the workbook the user steered; the constants above are only the fallback for a tender that
  // arrived as CSV, markdown or PDF, where there is no workbook to map.
  const plan = map
    ? clientColumnsFromMap(map)
    : { files: REQUIREMENT_FILES, idHeader: 'ID', columns: CLIENT_COLUMNS.map(header => ({ header, role: 'context', long: false })) };

  const files = [];
  const byId = {};
  for (const name of plan.files) {
    const file = path.join(dir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    files.push(name);
    for (const row of parseCsv(text, plan.idHeader)) {
      const id = String(row[plan.idHeader] ?? '').trim();
      if (!id) continue;
      byId[id] = Object.fromEntries(plan.columns.map(c => [c.header, row[c.header] ?? '']));
    }
  }
  return {
    available: files.length > 0,
    files,
    byId,
    // The page renders these instead of its own hard-coded list, so one mapping decision drives
    // the CSVs, the grid and the write-back.
    columns: plan.columns.map(c => ({ key: c.header, long: Boolean(c.long), cls: c.long ? 'long-col' : null })),
    costColumns: map ? costColumnsFromMap(map) : COST_COLUMNS,
    fromMap: Boolean(map),
  };
}

// The client's non-requirement exports, behind the Integrations and Glossary tabs and the
// Company & Context tab's migration inventory. Each is `{file, key}`: `key` is the first cell of
// its header row (see `parseCsv`). The analysis's own §8 / §9 / §1.2 tables stay the truth — these
// are shown beside them so the client's untouched wording is one click away.
export const CONTEXT_FILES = {
  integrations: { file: '05-integrations.csv', key: '#' },
  migration: { file: '06-migration-inventory.csv', key: '#' },
  glossary: { file: '08-glossary.csv', key: 'Term' },
};

/**
 * The mapping the user confirmed on the steering screen, committed next to the CSVs it describes.
 * Absent for every tender that did not arrive as a workbook — not an error.
 */
export function loadImportMap(specsDir, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(specsDir, slug, 'import-map.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reads whichever of `CONTEXT_FILES` exist under `<specsDir>/<slug>/` and returns
 * `{integrations, migration, glossary}`, each `{file, header, rows}` or null. Rows keep every
 * client column verbatim, in file order; nothing is renamed, merged or dropped. An absent folder
 * or file is not an error — a tender that came in as markdown or PDF has no such export.
 */
export function loadContextTables(specsDir, slug) {
  const dir = path.join(specsDir, slug);
  const map = loadImportMap(specsDir, slug);
  const wanted = map ? contextFilesFromMap(map) : CONTEXT_FILES;
  const out = {};
  for (const [name, { file, key }] of Object.entries(wanted)) {
    let text;
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { out[name] = null; continue; }
    const rows = parseCsv(text, key);
    out[name] = rows.length ? { file, header: Object.keys(rows[0]), rows } : null;
  }
  out.available = Object.values(out).some(Boolean);
  return out;
}
