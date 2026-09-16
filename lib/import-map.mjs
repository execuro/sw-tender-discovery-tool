// The import map: which sheet is a requirement table, where its header sits, what each column
// means and which tokens the client allows. The user confirms it on the steering screen before
// any agent reads the tender, which replaces the guessing `§EXTRACT` used to do.
//
// Three jobs live here: propose defaults from a grid snapshot (`proposeMap`), validate what the
// page sends back (`validateMap`), and emit the normalised per-table CSVs the skill reads
// (`emitCsv` / `writeTables`) in the exact byte shape the retired python script produced.
import fs from 'node:fs';
import path from 'node:path';
import { numberToCol, colToNumber, parseRange, sheetToGrid } from './xlsx.mjs';

/** Column roles the steering screen offers. `context` and `cost` may repeat; the rest are single. */
export const SINGLE_ROLES = ['id', 'title', 'requirement', 'acceptance', 'priority', 'type', 'reference', 'compliance', 'comment', 'effort'];
export const TABLE_ROLES = ['requirements', 'context', 'ignored'];

// The header words that mark a client's answer columns, in the languages the skill supports
// (`agent-briefs.md` §EXTRACT). Used only to propose a default — the user always decides.
const VENDOR_RE = /^(vendor|bidder|supplier|anbieter|antwort|lieferant)\b/i;
const ID_HEADER_RE = /^(id|#|nr\.?|no\.?|ref|position|pos\.?)$/i;
const ID_VALUE_RE = /^[A-Z][A-Z0-9]{1,9}[-_ ]\d{1,4}$/;
// The three columns we write back into, plus the cost columns we must never touch. These are
// only ever recognised behind a vendor/bidder header: "Acceptance criteria / Notes" is the
// client's own column, not our comment column, and writing an answer into it would corrupt the
// tender. A client who names the column differently fixes it on the steering screen.
const ANSWER_HINTS = [
  ['compliance', /(compliance|erfüllung|erfullung|abdeckung|conformity|antwort)/i],
  ['effort', /(effort|aufwand|pd|person[- ]?day|manntag)/i],
  ['cost', /(cost|kosten|preis|price|eur|€)/i],
  ['comment', /(comment|kommentar|bemerkung|remark|note|begründung|begrundung)/i],
];
// The client's own columns, in the order they are tried.
const CONTEXT_HINTS = [
  ['priority', /(priorit|prio|muss|wichtigkeit)/i],
  ['type', /^(type|typ|kategorie|category)$/i],
  ['title', /^(title|titel|name|kurzbeschreibung|bezeichnung)$/i],
  ['acceptance', /(acceptance|abnahme|kriterium|criteria|notes|hinweis)/i],
  ['requirement', /(requirement|anforderung|beschreibung|description|leistung)/i],
  ['reference', /(reference|referenz|quelle|source|verweis)/i],
];

// What a context table is about, so `lib/source.mjs` can find the integrations / migration /
// glossary tables without the hard-coded `CONTEXT_FILES` names.
const CONTEXT_KINDS = [
  ['integrations', /(integration|schnittstelle|interface)/i],
  ['migration', /(migration|inventory|datenübernahme|datenubernahme)/i],
  ['glossary', /(glossar|glossary|begriff)/i],
  ['company', /(company|context|unternehmen|kontext|profile)/i],
  ['cover', /(cover|deckblatt|titel|intro)/i],
  ['instructions', /(instruction|evaluation|response|hinweis|bewertung)/i],
];

/** `"4 Integrations"` → `"integrations"`; unknown sheets stay `other`. */
export function contextKind(sheetName) {
  for (const [kind, re] of CONTEXT_KINDS) if (re.test(sheetName)) return kind;
  return 'other';
}

/** `"2 Requirements"` → `"requirements"`: the slug the skill's file names and §1.3 map use. */
export function slugifySheet(name) {
  return String(name || '')
    .replace(/^\d+[\s.\-_]*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sheet';
}

/** The tokens a dropdown covering `col` within the table's data rows allows. */
function tokensForColumn(validations, col, firstDataRow, lastDataRow) {
  for (const v of validations || []) {
    if (!v.values || !v.values.length) continue;
    for (const rect of parseRange(v.sqref)) {
      if (col < rect.c1 || col > rect.c2) continue;
      if (rect.r2 < firstDataRow || rect.r1 > lastDataRow) continue;
      return v.values;
    }
  }
  return null;
}

/**
 * Finds the header row: the first row that both looks like a header (an id-like first filled
 * cell, or several short non-empty cells) and is followed by a row carrying an id-like value.
 * Sheet 7 of the sample proves why this cannot assume row 1 — its table starts at row 20.
 */
function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 60);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    const filled = row.filter(c => c !== '');
    if (filled.length < 3) continue;
    const first = row.find(c => c !== '') || '';
    const looksHeader = ID_HEADER_RE.test(first.trim()) || row.some(c => VENDOR_RE.test(c));
    if (!looksHeader) continue;
    const next = rows[i + 1];
    if (!next) continue;
    const nextFirst = (next.find(c => c !== '') || '').trim();
    if (nextFirst && (ID_VALUE_RE.test(nextFirst) || /^\d+$/.test(nextFirst))) return i + 1;   // 1-based
  }
  return null;
}

/** Column index (1-based) of the id column, by header word first, then by value shape. */
function findIdColumn(header, firstDataRowCells) {
  for (let i = 0; i < header.length; i++) if (ID_HEADER_RE.test(String(header[i]).trim())) return i + 1;
  for (let i = 0; i < (firstDataRowCells || []).length; i++) if (ID_VALUE_RE.test(String(firstDataRowCells[i]).trim())) return i + 1;
  return null;
}

function roleForHeader(text) {
  const t = String(text || '').trim();
  if (!t) return 'ignore';
  if (VENDOR_RE.test(t)) {
    const bare = t.replace(VENDOR_RE, '').replace(/^[\s:.\-–]+/, '');
    for (const [role, re] of ANSWER_HINTS) if (re.test(bare)) return role;
    return 'context';                       // a vendor column we have no answer for
  }
  for (const [role, re] of CONTEXT_HINTS) if (re.test(t)) return role;
  return 'context';
}

/**
 * Proposes a mapping from a snapshot. Every value is a suggestion the steering screen shows
 * pre-filled and the user can change; nothing here is authoritative.
 */
export function proposeMap(snapshot) {
  const tables = [];
  const ignored = [];

  for (const sheet of snapshot.sheets) {
    if (sheet.state !== 'visible') { ignored.push({ sheet: sheet.name, why: 'hidden' }); continue; }
    if (sheet.name.startsWith('_')) { ignored.push({ sheet: sheet.name, why: 'name starts with _' }); continue; }

    const rows = sheet.rows || [];
    const headerRow = findHeaderRow(rows);
    const base = {
      sheet: sheet.name,
      index: sheet.index,
      slug: slugifySheet(sheet.name),
      part: sheet.part || null,
      role: 'context',
      kind: contextKind(sheet.name),
      headerRow: null,
      firstDataRow: null,
      lastDataRow: null,
      columns: {},
      tokens: {},
    };

    if (!headerRow) { tables.push(base); continue; }

    const header = rows[headerRow - 1] || [];
    const firstData = rows[headerRow] || [];
    const idCol = findIdColumn(header, firstData);
    if (!idCol) { tables.push({ ...base, headerRow }); continue; }

    let lastDataRow = headerRow;
    for (let r = headerRow; r < rows.length; r++) {
      if ((rows[r][idCol - 1] || '').trim() !== '') lastDataRow = r + 1;
    }

    const columns = { id: numberToCol(idCol), context: [], cost: [] };
    for (let i = 0; i < header.length; i++) {
      const col = numberToCol(i + 1);
      if (i + 1 === idCol) continue;
      const role = roleForHeader(header[i]);
      if (role === 'ignore') continue;
      if (role === 'context' || role === 'cost') columns[role].push(col);
      else if (!columns[role]) columns[role] = col;
      else columns.context.push(col);            // a second "Requirement"-ish column is context
    }

    const tokens = {};
    for (const role of ['priority', 'compliance', 'type']) {
      const col = columns[role];
      if (!col) continue;
      const list = tokensForColumn(sheet.dropdowns, colToNumber(col), headerRow + 1, lastDataRow);
      if (list) tokens[role] = list;
    }

    // §EXTRACT's own definition: a requirement table has an id-like column **and** vendor answer
    // columns. A table with ids but nothing to answer (the sample's Integrations and Migration
    // Inventory sheets, both keyed `#`) is context, which is what `lib/source.mjs` always assumed.
    const answers = ['compliance', 'comment', 'effort'].filter(r => columns[r]);

    tables.push({
      ...base,
      role: answers.length ? 'requirements' : 'context',
      kind: answers.length ? null : contextKind(sheet.name),
      part: sheet.part || null,
      headerRow,
      firstDataRow: headerRow + 1,
      lastDataRow,
      columns,
      tokens,
      headerText: header.slice(),
    });
  }

  // `n` is the client table number used by §1.3 Source map and the response file names.
  let n = 0;
  for (const t of tables) if (t.role === 'requirements') t.n = ++n;

  return { source: snapshot.source, sha256: snapshot.sha256, proposedAt: new Date().toISOString(), tables, ignored };
}

/** Rejects a map the page could not have meant; returns the list of problems (empty = valid). */
export function validateMap(map) {
  const problems = [];
  if (!map || typeof map !== 'object') return ['map is not an object'];
  if (!Array.isArray(map.tables)) return ['map.tables is missing'];

  const seenSlug = new Set();
  for (const t of map.tables) {
    const where = `table "${t.sheet || '?'}"`;
    if (!TABLE_ROLES.includes(t.role)) problems.push(`${where}: unknown role "${t.role}"`);
    if (t.role !== 'requirements') continue;

    if (!Number.isInteger(t.headerRow) || t.headerRow < 1) problems.push(`${where}: headerRow must be a positive integer`);
    if (!Number.isInteger(t.firstDataRow) || t.firstDataRow <= t.headerRow) problems.push(`${where}: firstDataRow must be below the header row`);
    if (!Number.isInteger(t.lastDataRow) || t.lastDataRow < t.firstDataRow) problems.push(`${where}: lastDataRow must not be above firstDataRow`);
    if (!t.columns?.id) problems.push(`${where}: no id column mapped`);

    for (const role of SINGLE_ROLES) {
      const v = t.columns?.[role];
      if (v != null && typeof v !== 'string') problems.push(`${where}: ${role} must be one column`);
    }
    const slug = t.slug || slugifySheet(t.sheet);
    if (seenSlug.has(slug)) problems.push(`${where}: duplicate table slug "${slug}"`);
    seenSlug.add(slug);
  }
  return problems;
}

// ---------------------------------------------------------------- CSV

/** RFC4180 with QUOTE_MINIMAL — the same rule the python script's csv writer applied. */
export function csvCell(value, delimiter = ',') {
  const s = String(value ?? '');
  return s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/**
 * One table as CSV text: the client's header row verbatim, then its data rows in source order.
 * UTF-8 BOM, comma, LF — byte-compatible with `xlsx-to-csv.py`, so the skill's §EXTRACT, §RESP
 * and the frontmatter `source` hashes keep reading the same shape they always did.
 */
export function emitCsv(grid, table, { delimiter = ',', bom = true } = {}) {
  const rows = grid.rows;
  const from = table.role === 'requirements' ? table.headerRow : 1;
  const to = table.role === 'requirements' ? table.lastDataRow : rows.length;
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);

  const lines = [];
  for (let r = from; r <= to; r++) {
    const row = rows[r - 1] || [];
    const cells = [];
    for (let c = 0; c < width; c++) cells.push(csvCell(row[c] ?? '', delimiter));
    while (cells.length && cells[cells.length - 1] === '') cells.pop();   // trim the trailing empties
    lines.push(cells.join(delimiter));
  }
  // The header row defines the width; pad the data rows back out to it so every row has the
  // same column count (an §ASSEMBLE check depends on that).
  return (bom ? '﻿' : '') + lines.join('\n') + (lines.length ? '\n' : '');
}

/** `<pos>-<slug>.csv` — the name the skill already knows from the retired python script. */
export function csvNameFor(table) {
  const pos = String(table.index ?? 0).padStart(2, '0');
  return `${pos}-${table.slug || slugifySheet(table.sheet)}.csv`;
}

/**
 * Writes one CSV per non-ignored table into `<source dir>/<basename>/` and returns what it wrote.
 * Ignored sheets (hidden, `_`-prefixed, or marked ignored by the user) never reach disk — the
 * skill's boundary "never read a hidden sheet" is enforced here, before an agent ever looks.
 */
export function writeTables(workbook, map, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const bySheet = new Map(workbook.sheets.map(s => [s.name, s]));

  for (const table of map.tables) {
    if (table.role === 'ignored') continue;
    const sheet = bySheet.get(table.sheet);
    if (!sheet) continue;
    const grid = sheetToGrid(sheet);
    const name = csvNameFor(table);
    const text = emitCsv(grid, table);
    fs.writeFileSync(path.join(outDir, name), text, 'utf8');
    const rows = table.role === 'requirements' ? Math.max(0, table.lastDataRow - table.headerRow) : Math.max(0, grid.height - 1);
    written.push({ file: name, sheet: table.sheet, role: table.role, rows });
  }
  return written;
}

/**
 * What `lib/source.mjs` needs to show the client's own columns beside our answer: the CSV file
 * names of the requirement tables, the id column header and the context column headers, all
 * taken from the confirmed map instead of the hard-coded sample lists.
 */
export function clientColumnsFromMap(map) {
  const files = [];
  const columns = [];
  let idHeader = 'ID';
  for (const table of map.tables || []) {
    if (table.role !== 'requirements') continue;
    files.push(csvNameFor(table));
    const header = table.headerText || [];
    const at = col => header[colToNumber(col) - 1] || '';
    if (table.columns?.id) idHeader = at(table.columns.id) || idHeader;
    const ordered = [];
    for (const role of ['title', 'requirement', 'priority', 'type', 'acceptance', 'reference']) {
      const col = table.columns?.[role];
      if (col) ordered.push({ role, col, header: at(col) });
    }
    for (const col of table.columns?.context || []) ordered.push({ role: 'context', col, header: at(col) });
    ordered.sort((a, b) => colToNumber(a.col) - colToNumber(b.col));
    for (const o of ordered) {
      if (!o.header) continue;
      if (!columns.some(c => c.header === o.header)) columns.push({ header: o.header, role: o.role, long: o.role === 'requirement' || o.role === 'acceptance' });
    }
  }
  return { files, columns, idHeader };
}

/** The cost columns' headers — rendered greyed and never written into: this tool never states money. */
export function costColumnsFromMap(map) {
  const out = [];
  for (const table of map.tables || []) {
    if (table.role !== 'requirements') continue;
    const header = table.headerText || [];
    for (const col of table.columns?.cost || []) {
      const text = header[colToNumber(col) - 1];
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/**
 * The context tables keyed the way `lib/source.mjs` consumes them (`integrations`, `migration`,
 * `glossary`), each `{file, key}` — replacing the hard-coded `CONTEXT_FILES` names with whatever
 * this client actually called those sheets.
 */
export function contextFilesFromMap(map) {
  const out = {};
  for (const table of map.tables || []) {
    if (table.role !== 'context' || !table.kind) continue;
    if (!['integrations', 'migration', 'glossary'].includes(table.kind)) continue;
    const header = table.headerText || [];
    const key = table.columns?.id ? (header[colToNumber(table.columns.id) - 1] || '#') : (header[0] || '#');
    out[table.kind] = { file: csvNameFor(table), key };
  }
  return out;
}
