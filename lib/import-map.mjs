// The import map: which sheet is a requirement table, where its header sits, what each column
// means and which tokens the client allows — a first guess only (`proposeMap`); the extraction
// job (`sw-tender-editor`) reads the digest built from it and decides the real mapping (own-tabs,
// build contract `own-tabs-contract.md` §2/§5). The committed fit-back map (`readFitBack`, §4) is
// what `intake` writes and `export`/`tokens` read afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { numberToCol, colToNumber, parseRange, sheetToGrid } from './xlsx.mjs';

/** Column roles the steering screen offers. `context` and `commercial` may repeat; the rest are single. */
export const SINGLE_ROLES = ['id', 'title', 'requirement', 'acceptance', 'priority', 'type', 'reference', 'compliance', 'comment', 'effort', 'assumptions'];

// The six Requirement Coverage values a client's compliance token is mapped to (RC-4, contract §2).
export const COVERAGE_KEYS = ['OOTB', 'Configuration', 'Extension', 'ISV', 'Custom', '—'];

// The header words that mark a client's answer columns, in the languages the skill supports
// (`agent-briefs.md` §EXTRACT). Used only to propose a default — the user always decides.
const VENDOR_RE = /^(vendor|bidder|supplier|anbieter|antwort|lieferant)\b/i;
const ID_HEADER_RE = /^(id|#|nr\.?|no\.?|ref|position|pos\.?)$/i;
// A bare (no "Vendor:"/"Bidder:" prefix) "Rating" or "Response" column is itself the vendor's
// answer slot in a client template that never names a vendor at all (rfp-0002 sample: "ITEM /
// RATING / RESPONSE / NOTES"). Its presence is the signal that this row is a header at all
// (findHeaderRow) and that a bare "Notes" alongside it is also an answer column, not the
// client's own acceptance notes.
const BARE_ANSWER_TRIGGER_RE = /^(rating|response)$/i;
const BARE_ANSWER_HINTS = [
  ['compliance', /^rating$/i],
  ['comment', /^response$/i],
  ['assumptions', /^notes?$/i],
];
const ID_VALUE_RE = /^[A-Z][A-Z0-9]{1,9}[-_ ]\d{1,4}$/;
// A block's own "Total"/"Subtotal" roll-up row, and the sheet-wide/section-wide score recap a
// bare-answer template prints after its real blocks ("CATEGEORIES", a typo for "categories", and
// the whole "4 - Vendor Score" tab): neither is a scope item (defect E).
const TOTAL_ROW_RE = /^(total|subtotal)s?\.?$/i;
const SCORE_HEADING_RE = /^categ(e)?or(y|ies)$|vendor.?score|scorecard/i;
// The money/cost header words — the commercial-header heuristic `roleForHeader` uses for a
// vendor/bidder-prefixed column at propose time — a single source of truth for "this is a cost column".
const COMMERCIAL_HEADER_RE = /(cost|kosten|preis|price|eur|€)/i;

/** Whether `text` reads as a money/cost column header — the fixed rule that keeps a client's own
 * cost columns out of `context` (never written, never shown as one of our fields' options). */
export function isCommercialHeader(text) {
  return COMMERCIAL_HEADER_RE.test(String(text ?? ''));
}

// The three columns we write back into, plus the commercial (money) columns we must never touch. These are
// only ever recognised behind a vendor/bidder header: "Acceptance criteria / Notes" is the
// client's own column, not our comment column, and writing an answer into it would corrupt the
// tender. A client who names the column differently fixes it on the steering screen.
const ANSWER_HINTS = [
  ['compliance', /(compliance|erfüllung|erfullung|abdeckung|conformity|antwort)/i],
  ['effort', /(effort|aufwand|pd|person[- ]?day|manntag)/i],
  ['commercial', COMMERCIAL_HEADER_RE],
  ['assumptions', /(assumption|annahme)/i],
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

// What a context table is about — the digest's own label for the integrations / migration /
// glossary tables, read by the extraction job, not the runtime.
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

/** The tokens a dropdown covering `col` within the table's data rows allows. Exported for
 * `lib/intake.mjs`, which re-detects a fit-back table's tokens the same way `proposeMap` does when
 * there is no matching table in `import-map.proposed.json` to carry them from (contract §4). */
export function tokensForColumn(validations, col, firstDataRow, lastDataRow) {
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
    const hasVendorCol = row.some(c => VENDOR_RE.test(c));
    const hasBareAnswerCol = row.some(c => BARE_ANSWER_TRIGGER_RE.test(String(c).trim()));
    const looksHeader = ID_HEADER_RE.test(first.trim()) || hasVendorCol || hasBareAnswerCol;
    if (!looksHeader) continue;
    const next = rows[i + 1];
    if (!next) continue;
    const nextFirst = (next.find(c => c !== '') || '').trim();
    const nextLooksData = nextFirst && (ID_VALUE_RE.test(nextFirst) || /^\d+$/.test(nextFirst));
    // A client sheet with no id column at all (SI-2) still starts a table here when its own
    // vendor/answer columns say so — the id shape test alone would never fire for one.
    if (nextLooksData || hasVendorCol || hasBareAnswerCol) return i + 1;   // 1-based
  }
  return null;
}

/** Column index (1-based) of the id column, by header word first, then by value shape. */
function findIdColumn(header, firstDataRowCells) {
  for (let i = 0; i < header.length; i++) if (ID_HEADER_RE.test(String(header[i]).trim())) return i + 1;
  for (let i = 0; i < (firstDataRowCells || []).length; i++) if (ID_VALUE_RE.test(String(firstDataRowCells[i]).trim())) return i + 1;
  return null;
}

/** Distinct, ordered, non-empty values of `col` across a table's data rows — the client's own
 * tokens when there is no dropdown to read them from (a CSV, or an unvalidated xlsx column).
 * Exported for `lib/intake.mjs` (see `tokensForColumn` above). */
export function distinctColumnValues(rows, col, firstDataRow, lastDataRow, limit = 12) {
  if (!col) return [];
  const idx = colToNumber(col) - 1;
  const seen = [];
  for (let r = firstDataRow; r <= lastDataRow && r <= rows.length; r++) {
    const v = String((rows[r - 1] || [])[idx] ?? '').trim();
    if (v && !seen.includes(v)) seen.push(v);
    if (seen.length >= limit) break;
  }
  return seen;
}

/**
 * A small numeric-key/short-label list printed somewhere on the sheet — the compliance column's
 * token source (RC-4) when the column itself has no dropdown and no filled cells yet, because the
 * client shipped an unanswered template (rfp-0002 sample: a 0-4 "RATING"/"VENDOR SCORE" legend in
 * two columns beside the table). Returns `{ key, label }` entries in ascending key order, or `[]`
 * — the numeric key is what a numeric-key legend's own formulas (e.g. `=SUM`) expect the
 * compliance cell to hold, not the label text (T2).
 */
function findLegend(rows, { minRun = 3, maxRun = 12, maxLabelLen = 60 } = {}) {
  const height = rows.length;
  const width = rows.reduce((w, r) => Math.max(w, (r || []).length), 0);
  let best = null;
  for (let c = 0; c < width - 1; c++) {
    let run = [];
    for (let r = 0; r <= height; r++) {
      const row = r < height ? (rows[r] || []) : [];
      const key = String(row[c] ?? '').trim();
      const label = String(row[c + 1] ?? '').trim();
      const isKey = /^\d{1,2}$/.test(key);
      if (isKey && label && label.length <= maxLabelLen) { run.push({ key: Number(key), label }); continue; }
      if (run.length >= minRun && run.length <= maxRun && (!best || run.length > best.length)) best = run;
      run = [];
    }
  }
  return best ? best.sort((a, b) => a.key - b.key) : [];
}

// Sensible first guesses only (RC-4): the agent confirms or corrects every one, at export
// (`tokens --suggest`/`--file`), before any client-facing file carries it. None of these patterns
// matches a negative client token ("not offered", "not supported", "roadmap", "planned", "n/a",
// "no", "gap" …) — a negative token must never be suggested for any of the six (coverage-mapping.md
// — `—` is delivered work too, never "we don't offer this").
const OOTB_TOKEN_RE = /^(yes|standard|full|complete|stock|out.?of.?the.?box|ootb|ja|erfüllt|std|fully.?supported)\b/i;
const CONFIGURATION_TOKEN_RE = /(config|anpassbar|einstellbar)/i;
const ISV_TOKEN_RE = /(plugin|isv|3rd|third.?party|app|marketplace|add.?on|partner)/i;
// Extension AND Custom (coverage-mapping.md: "the customisation- or development-style token" for
// both) deliberately share ONE match here — the client's own wording rarely tells the two apart,
// and picking the SAME token for both is the documented rule, not a fallback to avoid.
const CUSTOMISATION_TOKEN_RE = /(extend|extension|erweiter|customi[sz]|partial|teilweise|custom|bespoke|bau|individual|develop)/i;

// `—` names non-Shopware work the partner still delivers (e.g. training) — an explicit
// "not applicable"-style client token, never a negative ("not supported"/"roadmap") one.
const NA_TOKEN_RE = /^(n\/?a\.?|n\.v\.t?\.?|—|-|none|not applicable|nicht zutreffend)$/i;

/** A first guess at `{OOTB, Configuration, Extension, ISV, Custom, "—"}` from the client's own
 * compliance tokens, per coverage-mapping.md's own pick-by-meaning rule for each value. Every
 * value is a suggestion; `tokens --file` is what actually decides it, at export (RC-4). */
export function guessCoverageTokenMap(clientTokens = []) {
  const tokens = clientTokens || [];
  const map = Object.fromEntries(COVERAGE_KEYS.map(k => [k, '']));
  if (!tokens.length) return map;

  const pick = re => tokens.find(v => re.test(String(v).trim())) || '';

  map.OOTB = pick(OOTB_TOKEN_RE);
  // "The configuration-style token, or the next best after OOTB."
  map.Configuration = pick(CONFIGURATION_TOKEN_RE) || map.OOTB;
  // "The customisation- or development-style token" — for BOTH Extension and Custom, the same one.
  const customisation = pick(CUSTOMISATION_TOKEN_RE) || map.Configuration || map.OOTB;
  map.Extension = customisation;
  map.Custom = customisation;
  // "The third-party/partner/add-on-style token when the list has one; otherwise the same
  // customisation-style token as Extension/Custom."
  map.ISV = pick(ISV_TOKEN_RE) || customisation;
  // "An N/A-style token when the list has one; otherwise the OOTB token — never a negative token."
  map['—'] = tokens.find(t => NA_TOKEN_RE.test(String(t).trim())) || map.OOTB || customisation;

  return map;
}

/** Whether a table's `tokens.coverage` carries a non-empty value for all six Requirement Coverage
 * keys — what `tokens --file` guarantees once it writes one. `export` gates on this: RC-4 is
 * decided agentically at export time, not confirmed at intake. */
export function coverageMapComplete(coverage) {
  return Boolean(coverage) && COVERAGE_KEYS.every(k => String(coverage[k] ?? '').trim() !== '');
}

function roleForHeader(text, { bareAnswersAllowed = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return 'ignore';
  if (VENDOR_RE.test(t)) {
    const bare = t.replace(VENDOR_RE, '').replace(/^[\s:.\-–]+/, '');
    for (const [role, re] of ANSWER_HINTS) if (re.test(bare)) return role;
    return 'context';                       // a vendor column we have no answer for
  }
  // A template with no "Vendor:"/"Bidder:" prefix at all, where "Rating"/"Response" bare are
  // themselves the answer slots (rfp-0002 sample) — only once that shape is established for the
  // row (BARE_ANSWER_TRIGGER_RE matched somewhere in it), so a client's own unrelated "Notes"
  // column elsewhere is not swept up (see "a table with ids but no vendor columns is context").
  if (bareAnswersAllowed) {
    for (const [role, re] of BARE_ANSWER_HINTS) if (re.test(t)) return role;
  }
  for (const [role, re] of CONTEXT_HINTS) if (re.test(t)) return role;
  return 'context';
}

/**
 * Column index (0-based) of the header cell that made `header` look like a bare-answer header
 * (`findHeaderRow`'s `hasBareAnswerCol`), so a repeat of that same shape at the same column,
 * further down the sheet, can be recognised as another block's header row (defect E).
 */
function bareAnswerTriggerCol(header) {
  for (let i = 0; i < header.length; i++) if (BARE_ANSWER_TRIGGER_RE.test(String(header[i]).trim())) return i;
  return -1;
}

/**
 * Every header-shaped row in the sheet that repeats the first one's bare-answer column — the
 * "IT & HOSTING" / "SECURITY" block headers in a RATING/RESPONSE/NOTES template (defect E). Only
 * looked for behind the bare-answer convention: a "Vendor:"-prefixed template never repeats its
 * header mid-sheet in the samples this rule is built from. Returns 1-based row numbers, sorted,
 * `firstHeaderRow` always first.
 */
function findBlockHeaderRows(rows, firstHeaderRow, triggerCol) {
  const found = [firstHeaderRow];
  for (let r = firstHeaderRow; r < rows.length; r++) {
    const cell = String((rows[r] || [])[triggerCol] ?? '').trim();
    if (BARE_ANSWER_TRIGGER_RE.test(cell)) found.push(r + 1);
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

/**
 * One block's table fields from its own header row, bounded above by `boundaryRow` (the next
 * block's header, or `Infinity` for the sheet's last/only block) — the per-sheet body `proposeMap`
 * used to run once now runs once per block. Returns `null` when the block carries no data rows at
 * all (a header with nothing under it before the boundary).
 */
function buildBlock(sheet, rows, headerRow, boundaryRow) {
  const header = rows[headerRow - 1] || [];
  const firstData = rows[headerRow] || [];
  const idCol = findIdColumn(header, firstData);

  // SI-2: the client's sheet may carry no id-like column at all. Without one, a data row is any
  // row with content under the header, and the block ends at the first fully blank row. Either
  // way it also ends at `boundaryRow` (the next block's own header) and never counts a "Total" /
  // "Subtotal" roll-up row as a scope item (defect E).
  let lastDataRow = headerRow;
  if (idCol) {
    for (let r = headerRow; r < rows.length && r + 1 < boundaryRow; r++) {
      const first = (rows[r] || []).find(c => String(c ?? '').trim() !== '') ?? '';
      if (TOTAL_ROW_RE.test(String(first).trim())) break;
      if ((rows[r][idCol - 1] || '').trim() !== '') lastDataRow = r + 1;
    }
  } else {
    for (let r = headerRow; r < rows.length && r + 1 < boundaryRow; r++) {
      const row = rows[r] || [];
      const first = row.find(c => String(c ?? '').trim() !== '') ?? '';
      if (TOTAL_ROW_RE.test(String(first).trim())) break;
      const hasContent = row.slice(0, header.length).some(c => String(c ?? '').trim() !== '');
      if (!hasContent) break;
      lastDataRow = r + 1;
    }
  }
  if (lastDataRow === headerRow) return null;   // no data rows at all

  const bareAnswersAllowed = header.some(h => BARE_ANSWER_TRIGGER_RE.test(String(h).trim()));
  const columns = { id: idCol ? numberToCol(idCol) : null, context: [], commercial: [] };
  for (let i = 0; i < header.length; i++) {
    const col = numberToCol(i + 1);
    if (idCol && i + 1 === idCol) continue;
    const role = roleForHeader(header[i], { bareAnswersAllowed });
    if (role === 'ignore') continue;
    if (role === 'context' || role === 'commercial') columns[role].push(col);
    else if (!columns[role]) columns[role] = col;
    else columns.context.push(col);            // a second "Requirement"-ish column is context
  }
  // A bare-answer template names its first column after the section, not "Requirement"
  // ("ITEM", "SECURITY", "IT & HOSTING") — it fell into `context` above (no CONTEXT_HINTS word
  // matches it either); the first such column, in header order, is the requirement text, and its
  // own header cell is the block's heading (used for the area name when the sheet has more than
  // one block, and to recognise a pure scoring block/sheet — defect E).
  let heading = null;
  if (bareAnswersAllowed && !columns.requirement && columns.context.length) {
    columns.requirement = columns.context.shift();
    heading = String(header[colToNumber(columns.requirement) - 1] ?? '').trim();
  }

  // Priority tokens are client pass-through, never analysed or shown — dropped from the map
  // . Compliance tokens are still recorded, silently, as export input.
  const tokens = {};
  for (const role of ['compliance', 'type']) {
    const col = columns[role];
    if (!col) continue;
    const list = tokensForColumn(sheet.dropdowns, colToNumber(col), headerRow + 1, lastDataRow)
      || distinctColumnValues(rows, col, headerRow + 1, lastDataRow);
    if (list.length) tokens[role] = list;
  }
  // RC-4: an answer column with no dropdown and nothing filled in yet (an unanswered vendor
  // template) still names its tokens somewhere on the sheet — a small key/label legend printed
  // beside the table (defect D, rfp-0002 sample).
  if (columns.compliance && (!tokens.compliance || !tokens.compliance.length)) {
    const legend = findLegend(rows);
    if (legend.length) {
      tokens.compliance = legend.map(e => e.label);
      // T2: a numeric-key legend's column feeds a `=SUM`-style formula elsewhere on the sheet —
      // the export must write the legend's NUMBER for the mapped token, not its label text.
      tokens.complianceLegend = Object.fromEntries(legend.map(e => [e.label, e.key]));
    }
  }
  // RC-4: the six-value roll-up used to be guessed and confirmed here; it is now decided
  // agentically at export time instead (`tokens --suggest`/`--file`) —
  // `guessCoverageTokenMap` stays as that command's own suggestion, not written into the map here.

  // §EXTRACT's own definition: a requirement table has an id-like column **and** vendor answer
  // columns. A table with ids but nothing to answer (the sample's Integrations and Migration
  // Inventory sheets, both keyed `#`) is context.
  // A pure scoring block/sheet ("CATEGEORIES", "4 - Vendor Score") is context too, whatever
  // columns it happens to carry — it recaps other blocks' ratings, it does not ask anything
  // (defect E).
  const isScore = heading != null && SCORE_HEADING_RE.test(heading);
  const answers = isScore ? [] : ['compliance', 'comment', 'effort'].filter(r => columns[r]);

  return {
    role: answers.length ? 'requirements' : 'context',
    kind: answers.length ? null : (isScore ? 'score' : contextKind(sheet.name)),
    headerRow,
    firstDataRow: headerRow + 1,
    lastDataRow,
    columns,
    tokens,
    assumptionsColumn: columns.assumptions || null,
    headerText: header.slice(),
    heading,
  };
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
    const firstHeaderRow = findHeaderRow(rows);
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

    if (!firstHeaderRow) { tables.push(base); continue; }

    // Multi-block sheets (defect E): a bare-answer header ("ITEM"/"RATING"/"RESPONSE"/"NOTES")
    // repeated further down the sheet starts another block, sharing the same column shape — the
    // "IT & HOSTING" then "SECURITY" tables on one tab. A "Vendor:"-prefixed header never repeats
    // this way, so only the bare-answer convention is searched.
    const firstHeader = rows[firstHeaderRow - 1] || [];
    const triggerCol = bareAnswerTriggerCol(firstHeader);
    const headerRows = triggerCol >= 0 ? findBlockHeaderRows(rows, firstHeaderRow, triggerCol) : [firstHeaderRow];

    const blocks = [];
    for (let i = 0; i < headerRows.length; i++) {
      const boundary = headerRows[i + 1] ?? Infinity;
      const block = buildBlock(sheet, rows, headerRows[i], boundary);
      if (block) blocks.push(block);
    }

    if (!blocks.length) { tables.push({ ...base, headerRow: firstHeaderRow }); continue; }

    // Area = the sheet name when its blocks share one (generic) heading; `<sheet> · <heading>`
    // when they carry their own distinct one — so "3.2 - Technical" stays one area for a
    // single-block sheet, but splits into "3.2 - Technical · IT & HOSTING" and "… · SECURITY"
    // (defect E). Ids stay stable (§1 id rule): each area name is still whatever
    // `generateIds`/`parse.mjs` key off, computed once here, never re-derived per row.
    const multiBlock = blocks.length > 1;
    for (const block of blocks) {
      const sheetName = multiBlock && block.heading ? `${sheet.name.trim()} · ${block.heading}` : sheet.name;
      tables.push({
        ...base,
        sheet: sheetName,
        slug: multiBlock ? slugifySheet(sheetName) : base.slug,
        role: block.role,
        kind: block.kind,
        headerRow: block.headerRow,
        firstDataRow: block.firstDataRow,
        lastDataRow: block.lastDataRow,
        columns: block.columns,
        tokens: block.tokens,
        assumptionsColumn: block.assumptionsColumn,
        headerText: block.headerText,
      });
    }
  }

  // `n` is the client table number used by §1.3 Source map and the response file names.
  let n = 0;
  for (const t of tables) if (t.role === 'requirements') t.n = ++n;

  return { source: snapshot.source, sha256: snapshot.sha256, proposedAt: new Date().toISOString(), tables, ignored };
}

// ---------------------------------------------------------------- CSV source (task 2)

/** RFC4180-ish reader: quoted fields, doubled quotes, embedded newlines, any single-char delimiter. */
export function parseDelimited(text, delimiter = ',') {
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
    if (c === delimiter) { pushField(); i++; continue; }
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

/** Picks `,` `;` or tab by counting occurrences on the first non-blank line — the client's own
 * convention (a semicolon file is usually a German-locale export with a decimal comma). */
export function detectDelimiter(text) {
  const firstLine = String(text ?? '').replace(/^﻿/, '').split(/\r\n?|\n/).find(l => l.trim() !== '') || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch]++;
  const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return counts[best] > 0 ? best : ',';
}

/**
 * A CSV file as the one-sheet snapshot `proposeMap` expects, so a CSV tender goes through the
 * exact same steering screen as an xlsx one (task 2). No dropdowns: `proposeMap` falls back to
 * the column's own distinct values for the compliance/priority token lists.
 */
export function snapshotFromCsv(text, { source, sha256, name = 'CSV' } = {}) {
  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter).filter(r => r.some(c => String(c).trim() !== ''));
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const padded = rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return {
    source, sha256, readAt: new Date().toISOString(), epoch1904: false, delimiter,
    sheets: [{
      index: 1, name, state: 'visible', part: null,
      width, height: padded.length, truncated: false, rows: padded,
      hiddenRows: [], hiddenCols: [], merges: [], dropdowns: [],
    }],
  };
}

// ---------------------------------------------------------------- fit-back map (own-tabs, contract §4)

/**
 * Reads the committed fit-back map for an xlsx source — `<srcdir>/<base>/import-map.json`
 * (contract §4), the export target `intake` writes and `export`/`tokens` read. `source` may be
 * absolute, or relative to `root`. Returns `null` when there is none, or it does not parse — a CSV
 * or PDF source has no fit-back map at all (contract §4), so a caller with one of those never
 * finds a file here either.
 */
export function readFitBack(root, source) {
  if (!source) return null;
  const sourceAbs = path.isAbsolute(source) ? source : path.join(root || '.', source);
  const dir = path.dirname(sourceAbs);
  const base = path.basename(sourceAbs, path.extname(sourceAbs));
  const file = path.join(dir, base, 'import-map.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
