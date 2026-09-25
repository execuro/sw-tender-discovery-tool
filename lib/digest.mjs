// The import digest: `specs/.editor/<base>/import-digest.md` — the one file `sw-tender-editor`'s
// `extract` job reads (no Glob or Grep, build contract §5). Plain markdown, visible sheets only,
// in workbook order, with `proposeMap`'s own guess printed per table so the extraction job starts
// from something rather than a blank grid.
import { numberToCol } from './xlsx.mjs';

const CELL_LIMIT = 160;

/** One cell, truncated to `CELL_LIMIT` chars with `…` marking the cut (contract §5). */
function truncateCell(v) {
  const s = String(v ?? '');
  return s.length > CELL_LIMIT ? `${s.slice(0, CELL_LIMIT)}…` : s;
}

/** `A=ID | B=Area | …` — empty cells omitted (contract §5). */
function renderRow(row, width) {
  const cells = [];
  for (let c = 0; c < width; c++) {
    const v = row[c];
    if (v == null || String(v).trim() === '') continue;
    cells.push(`${numberToCol(c + 1)}=${truncateCell(v)}`);
  }
  return cells.join(' | ');
}

/** One table's `Proposed:` line — a requirements table names its columns and compliance tokens; a
 * context table (or a sheet with no table at all) states only its kind. */
function renderProposedLine(table) {
  if (!table || table.headerRow == null) return 'Proposed: context sheet, no table detected';
  const label = table.heading ? `${table.role} table "${table.heading}"` : `${table.role} table`;
  if (table.role !== 'requirements') {
    return `Proposed: ${label}, header r${table.headerRow}, data r${table.firstDataRow}-r${table.lastDataRow}`;
  }
  const cols = table.columns || {};
  const parts = [];
  for (const role of ['id', 'priority', 'requirement', 'topic', 'compliance', 'comment', 'effort', 'assumptions']) {
    if (cols[role]) parts.push(`${role} ${cols[role]}`);
  }
  let line = `Proposed: ${label}, header r${table.headerRow}, data r${table.firstDataRow}-r${table.lastDataRow}; ${parts.join(', ')}`;
  const tokens = table.tokens?.compliance;
  if (tokens && tokens.length) line += `; tokens compliance [${tokens.join(', ')}]`;
  return line;
}

/**
 * `renderDigest(snapshot, proposed)` → the digest's markdown text. `snapshot` is `import-snapshot.json`'s
 * shape (`{ sheets: [...] }`); `proposed` is `proposeMap`'s own result (`{ tables, ignored }`).
 * Hidden sheets and `_`-prefixed sheets are never mentioned (contract §1/§5).
 */
export function renderDigest(snapshot, proposed) {
  const tablesBySheetIndex = new Map();
  for (const t of proposed?.tables || []) {
    const idx = t.index;
    if (!tablesBySheetIndex.has(idx)) tablesBySheetIndex.set(idx, []);
    tablesBySheetIndex.get(idx).push(t);
  }

  const parts = [];
  for (const sheet of snapshot.sheets || []) {
    if (sheet.state !== 'visible') continue;
    if (String(sheet.name).startsWith('_')) continue;

    const rows = sheet.rows || [];
    const width = sheet.width ?? rows.reduce((w, r) => Math.max(w, (r || []).length), 0);
    const lastCol = numberToCol(Math.max(width, 1));
    const lines = [`## Sheet ${sheet.index}: ${sheet.name}   (rows 1-${rows.length}, cols A-${lastCol})`];

    const tables = tablesBySheetIndex.get(sheet.index) || [];
    if (tables.length) for (const t of tables) lines.push(renderProposedLine(t));
    else lines.push('Proposed: context sheet, no table detected');

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!row.some(c => c != null && String(c).trim() !== '')) continue;
      lines.push(`r${r + 1}: ${renderRow(row, width)}`);
    }

    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n') + '\n';
}
