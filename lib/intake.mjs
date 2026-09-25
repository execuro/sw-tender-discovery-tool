// `intake <doc> --source <file> --extraction <json>` — builds or merges the working document's
// §4 (own tabs) from the skill's `extract` job result. Contract `own-tabs-contract.md` §1, §2, §4.
//
// Deterministic by design (R-8): the id rule, the merge rule and the document grammar all live
// here so the acceptance criteria are testable without an agent in the loop. Agents write
// judgement (Requirement Coverage, effort, Client Response, …) through `apply` (WP-4); intake
// only ever touches the Requirement, ID, Prio, Status, References, §1 Project information and
// §1 Not taken of the working document.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readWorkbook, sheetToGrid, colToNumber } from './xlsx.mjs';
import { tokensForColumn, distinctColumnValues, parseDelimited, detectDelimiter } from './import-map.mjs';
import {
  parse, TABS, PROJECT_INFO, SECTION_TITLES, generateIds, normalize,
  renderProjectInfo, renderNotTaken, stripChapterNumber,
} from './parse.mjs';
import { renderItemsSection } from './edit.mjs';
import { regime as regimeOf } from './profile.mjs';
import { isReady } from './calc.mjs';
import { canonical, resolveRoot } from './paths.mjs';
import * as out from './out.mjs';

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const PROJECT_INFO_KEYS = new Set(PROJECT_INFO.map(p => p.key));

// A brand-new document starts life as this skeleton, parsed once so every downstream step works
// off the same `blocks`/`items` shape whether the document already existed or not. §1's two
// subsections are rendered fresh every intake (`renderContext`), so the skeleton only needs the
// heading; §3/§5/§6/§7/§8 are other jobs' territory and start empty.
function emptyTemplate() {
  const sections = SECTION_TITLES.map((title, i) => `## ${i + 1}. ${title}`).join('\n\n');
  return `---\nstate: In progress\nregime: T-shirt\nsource-sha256: {}\nslug: x\nintake: review\n---\n# x\n\n${sections}\n`;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- internal paths

function slugFor(doc) { return path.basename(doc).replace(/-analysis\.md$/i, ''); }
function rfpDir(root, slug) { return path.join(root || '.', 'specs', '.rfp', slug); }
export function extractionPathFor(root, slug) { return path.join(rfpDir(root, slug), 'extraction.json'); }
/** `specs/.rfp/<slug>/item-pointers.json`: `{ [id]: "<sheet> r<row>" | "PDF #<n>" }` — never
 * committed (`specs/.rfp/` is gitignored). The one place every current item's own source pointer
 * lives, so `ops.mjs` `skip` can put it in a Not-taken row without re-deriving it. Exported: `ops.mjs`
 * reads and (on `restore`) extends it. */
export function pointersPathFor(root, slug) { return path.join(rfpDir(root, slug), 'item-pointers.json'); }
export function readPointers(root, slug) { return readJsonSafe(pointersPathFor(root, slug)) || {}; }
export function writePointers(root, slug, pointers) { writeJson(pointersPathFor(root, slug), pointers); }

function sessionDirFor(sourceAbs) {
  return path.join(path.dirname(sourceAbs), '.editor', path.basename(sourceAbs, path.extname(sourceAbs)));
}
function proposedMapPathFor(sourceAbs) { return path.join(sessionDirFor(sourceAbs), 'import-map.proposed.json'); }
/** The committed fit-back map for an xlsx source: `<srcdir>/<base>/import-map.json` (contract §4).
 * Exported: `ops.mjs` `intakeConfirm` sets `confirmedAt` on the same file. */
export function fitBackPathFor(sourceAbs) {
  const dir = path.dirname(sourceAbs);
  const base = path.basename(sourceAbs, path.extname(sourceAbs));
  return path.join(dir, base, 'import-map.json');
}

// ---------------------------------------------------------------- extraction validation (contract §2)

function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/** IN-2: a hidden/veryHidden sheet, or one whose name starts with `_`, is never read. */
function isHiddenSheet(name, sheetIndex) {
  if (String(name ?? '').startsWith('_')) return true;
  const info = sheetIndex?.get(name);
  return info ? info.state !== 'visible' : false;
}

/** `{ reason }` lines the extraction fails on, empty when it is usable. Contract §2. */
function validateExtraction(extraction, { ext, sheetIndex } = {}) {
  const reasons = [];
  if (!isPlainObject(extraction)) return ['extraction.json must be a JSON object'];

  const isPdf = ext === '.pdf';
  const tables = extraction.tables || [];
  const overrides = extraction.overrides || [];
  const skip = extraction.skip || [];
  const items = extraction.items || [];
  const projectInfo = extraction.projectInfo || [];

  if (isPdf) {
    if (tables.length) reasons.push('a pdf extraction must not carry tables (it has no cells to point at)');
    for (const [i, it] of items.entries()) {
      const where = `items[${i}]`;
      if (!String(it.text ?? '').trim()) reasons.push(`${where}: text is required`);
      if (!TABS.includes(it.tab)) reasons.push(`${where}: tab "${it.tab}" is not one of ${TABS.join(', ')}`);
      if (!String(it.topic ?? '').trim()) reasons.push(`${where}: topic is required`);
    }
  } else {
    if (items.length) reasons.push('an xlsx/csv extraction must not carry items (read the rows from the cells instead)');
    if (!tables.length) reasons.push('extraction.tables is empty — nothing to intake');
    for (const [i, t] of tables.entries()) {
      const where = `tables[${i}] "${t.sheet || '?'}"`;
      if (!Number.isInteger(t.headerRow) || t.headerRow < 1) reasons.push(`${where}: headerRow must be a positive integer`);
      if (!Number.isInteger(t.firstDataRow) || t.firstDataRow <= t.headerRow) reasons.push(`${where}: firstDataRow must be below the header row`);
      if (!Number.isInteger(t.lastDataRow) || t.lastDataRow < t.firstDataRow) reasons.push(`${where}: lastDataRow must not be above firstDataRow`);
      if (!TABS.includes(t.tab)) reasons.push(`${where}: tab "${t.tab}" is not one of ${TABS.join(', ')}`);
      const cols = t.columns || {};
      if (!cols.requirement) reasons.push(`${where}: columns.requirement is required`);
      if (!cols.compliance && !cols.comment) reasons.push(`${where}: needs at least one of columns.compliance or columns.comment (nowhere to answer otherwise)`);
      for (const role of ['id', 'priority', 'requirement', 'topic', 'compliance', 'comment', 'effort', 'assumptions']) {
        const v = cols[role];
        if (v != null && typeof v !== 'string') reasons.push(`${where}: columns.${role} must be a column letter`);
      }
      if (isHiddenSheet(t.sheet, sheetIndex)) reasons.push(`${where}: sheet "${t.sheet}" is hidden or internal (IN-2) and must not be read`);
      const info = sheetIndex?.get(t.sheet);
      if (info) {
        for (const role of Object.keys(cols)) {
          const v = cols[role];
          if (v && colToNumber(v) > info.width) reasons.push(`${where}: column ${role} "${v}" lies outside the sheet (width ${info.width})`);
        }
      }
    }
    const within = (sheet, row) => tables.some(t => t.sheet === sheet && row >= t.firstDataRow && row <= t.lastDataRow);
    for (const [i, o] of overrides.entries()) {
      const where = `overrides[${i}]`;
      if (o.tab != null && !TABS.includes(o.tab)) reasons.push(`${where}: tab "${o.tab}" is not one of ${TABS.join(', ')}`);
      if (isHiddenSheet(o.sheet, sheetIndex)) reasons.push(`${where}: sheet "${o.sheet}" is hidden or internal (IN-2) and must not be read`);
      if (!within(o.sheet, o.row)) reasons.push(`${where}: ${o.sheet} r${o.row} does not lie inside a declared table`);
    }
    for (const [i, s] of skip.entries()) {
      const where = `skip[${i}]`;
      if (!String(s.why ?? '').trim()) reasons.push(`${where}: why is required`);
      if (isHiddenSheet(s.sheet, sheetIndex)) reasons.push(`${where}: sheet "${s.sheet}" is hidden or internal (IN-2) and must not be read`);
      if (!within(s.sheet, s.row)) reasons.push(`${where}: ${s.sheet} r${s.row} does not lie inside a declared table`);
    }
  }

  for (const [i, pi] of projectInfo.entries()) {
    const where = `projectInfo[${i}]`;
    if (!PROJECT_INFO_KEYS.has(pi.key)) { reasons.push(`${where}: unknown key "${pi.key}"`); continue; }
    const src = parsePointer(pi.source);
    if (src && src.kind === 'cell' && isHiddenSheet(src.sheet, sheetIndex)) {
      reasons.push(`${where}: source "${pi.source}" is a hidden or internal sheet (IN-2) and must not be read`);
    }
  }

  return reasons;
}

// ---------------------------------------------------------------- §1 Project information / Not taken

/** `PROJECT_INFO` rows for §1, from the extraction's own `projectInfo[]` (contract §1/§2): a
 * missing key becomes `not stated` with an empty Source; a row whose existing Source is `operator`
 * is kept untouched (re-intake never overwrites an operator-typed value). */
function mergeProjectInfo(existingRows, extractionRows) {
  const byKey = new Map((extractionRows || []).map(r => [r.key, r]));
  const existingByKey = new Map((existingRows || []).map(r => [r.key, r]));
  return PROJECT_INFO.map(({ key, label }) => {
    const existing = existingByKey.get(key);
    if (existing && existing.source === 'operator') return { key, label, value: existing.value, source: existing.source };
    const fresh = byKey.get(key);
    return fresh ? { key, label, value: fresh.value ?? '', source: fresh.source || '' } : { key, label, value: 'not stated', source: '' };
  });
}

/** `<sheet> r<row>` / `PDF #<n>` — the one pointer format shared by §1 Not taken's Source column,
 * the fit-back map's row targeting, and `ops.mjs` `skip`/`restore` (contract §1/§3). */
function pointerFor(sheet, row) { return `${sheet} r${row}`; }
function pdfPointerFor(index1) { return `PDF #${index1}`; }
function parsePointer(p) {
  const pdf = /^PDF #(\d+)$/.exec(String(p ?? '').trim());
  if (pdf) return { kind: 'pdf', index: Number(pdf[1]) };
  const cell = /^(.*) r(\d+)$/.exec(String(p ?? '').trim());
  if (cell) return { kind: 'cell', sheet: cell[1], row: Number(cell[2]) };
  return null;
}

// ---------------------------------------------------------------- xlsx/csv row reading

function openGrid(sourceAbs, ext) {
  if (ext === '.xlsx') {
    const wb = readWorkbook(fs.readFileSync(sourceAbs), { label: path.basename(sourceAbs) });
    return { wb, gridFor: sheetName => { const s = wb.sheets.find(x => x.name === sheetName); return s ? sheetToGrid(s).rows : []; } };
  }
  const text = fs.readFileSync(sourceAbs, 'utf8');
  const rows = parseDelimited(text, detectDelimiter(text)).filter(r => r.some(c => String(c).trim() !== ''));
  return { wb: null, gridFor: () => rows };
}

/** One row's `{ id, prio, requirement, tab, topic }`, applying `overrides` and `table.columns` per
 * contract §2 — `columns.topic`, else `table.topic`, else the sheet name trimmed. Returns `null`
 * when the requirement cell is empty (ignored silently) or the row is not covered by any table. */
function readTableRow(tables, overrides, grid, sheet, row) {
  const table = tables.find(t => t.sheet === sheet && row >= t.firstDataRow && row <= t.lastDataRow);
  if (!table) return null;
  const cells = grid[row - 1] || [];
  const at = col => (col ? String(cells[colToNumber(col) - 1] ?? '').trim() : '');
  const requirement = at(table.columns.requirement);
  if (!requirement) return null;
  const override = overrides.find(o => o.sheet === sheet && o.row === row);
  // A Topic-column cell is the client's own text, taken verbatim; `table.topic`, the sheet name
  // fallback and an override's own `topic` are all the operator's/agent's own chapter labelling and
  // may carry a leading chapter number ("3.3 - Functional", "1. GENERAL REQUIREMENTS") that is
  // stripped there, never off a client cell.
  const topic = at(table.columns.topic) || stripChapterNumber(table.topic || sheet).trim();
  return {
    id: at(table.columns.id) || null,
    prio: at(table.columns.priority),
    requirement,
    tab: override?.tab || table.tab,
    topic: (override?.topic ? stripChapterNumber(override.topic) : topic).trim(),
    pointer: pointerFor(sheet, row),
    table,
  };
}

/** Every source row, in table/row order, minus the ones `skip[]` or `excludePointers` remove. */
function readSourceItems(extraction, grid, excludePointers) {
  const items = [];
  for (const table of extraction.tables) {
    const rows = grid(table.sheet);
    for (let r = table.firstDataRow; r <= table.lastDataRow; r++) {
      const pointer = pointerFor(table.sheet, r);
      if (excludePointers.has(pointer)) continue;
      const row = readTableRow(extraction.tables, extraction.overrides || [], rows, table.sheet, r);
      if (row) items.push(row);
    }
  }
  return items;
}

/** The same shape from a pdf extraction's `items[]` (contract §2): no cells, no pointer beyond the
 * item's own 1-based position, no skip. */
function readPdfItems(extraction, excludePointers) {
  const out = [];
  (extraction.items || []).forEach((it, i) => {
    const pointer = pdfPointerFor(i + 1);
    if (excludePointers.has(pointer)) return;
    const requirement = String(it.text ?? '').trim();
    if (!requirement) return;
    out.push({ id: it.id ? String(it.id).trim() : null, prio: String(it.prio ?? '').trim(), requirement, tab: it.tab, topic: String(it.topic).trim(), pointer });
  });
  return out;
}

const NO_EXCLUDE = new Set();

// ---------------------------------------------------------------- id generation, grouping

/** Groups `sourceItems` by topic (SI-2: `generateIds` is keyed by topic, not by tab — contract §1)
 * and fills every missing id, in client order within each topic. Mutates and returns the flat list. */
function assignIds(sourceItems) {
  const order = [];
  const byTopic = new Map();
  for (const it of sourceItems) {
    if (!byTopic.has(it.topic)) { byTopic.set(it.topic, []); order.push(it.topic); }
    byTopic.get(it.topic).push(it);
  }
  generateIds(order.map(topic => ({ name: topic, items: byTopic.get(topic) })));
  return sourceItems;
}

// ---------------------------------------------------------------- §1 Not taken merge (contract §3)

/**
 * Fresh skip rows (from `extraction.skip`/pdf — there is none for pdf) plus operator-added Not
 * taken rows carried over from the existing document while their source row still exists (contract
 * §3). Returns `{ notTaken, excludePointers }` — `excludePointers` is every pointer (fresh skip or
 * carried operator skip) that must not become a §4 item this run.
 */
function mergeNotTaken(existingNotTaken, extraction, ext, grid) {
  const freshRows = [];
  const freshPointers = new Set();
  if (ext !== '.pdf') {
    for (const s of extraction.skip || []) {
      const pointer = pointerFor(s.sheet, s.row);
      const rows = grid(s.sheet);
      const table = (extraction.tables || []).find(t => t.sheet === s.sheet && s.row >= t.firstDataRow && s.row <= t.lastDataRow);
      const cells = rows[s.row - 1] || [];
      const fallback = cells.find(c => String(c ?? '').trim() !== '') ?? '';
      const text = table ? (String(cells[colToNumber(table.columns.requirement) - 1] ?? '').trim() || String(fallback)) : '';
      freshRows.push({ source: pointer, text, why: s.why });
      freshPointers.add(pointer);
    }
  }

  const rowStillExists = pointer => {
    const p = parsePointer(pointer);
    if (!p) return false;
    if (p.kind === 'pdf') return Boolean((extraction.items || [])[p.index - 1]);
    return (extraction.tables || []).some(t => t.sheet === p.sheet && p.row >= t.firstDataRow && p.row <= t.lastDataRow);
  };

  const carried = (existingNotTaken || []).filter(row => !freshPointers.has(row.source) && rowStillExists(row.source));
  for (const row of carried) freshPointers.add(row.source);

  return { notTaken: [...freshRows, ...carried], excludePointers: freshPointers };
}

// ---------------------------------------------------------------- §4 merge (SI-2, L-5)

function newItem(s) {
  return {
    id: s.id, area: `${s.tab} · ${s.topic}`, tab: s.tab, topic: s.topic, prio: s.prio || '',
    coverage: null, confidence: null, effort: null, requirement: s.requirement, clientResponse: '',
    assumptions: [], internalNote: '', references: [], status: { kind: 'queued', date: null, cq: null },
    pointer: s.pointer,
  };
}

/**
 * Matches `sourceItems` (already id-assigned, contract SI-2 stability) against the document's
 * existing items by id, across the whole document (contract §3). A known id keeps its current tab,
 * topic and every answer field; L-5 reopens it when the requirement text changed. Returns the
 * merged, canonically-ordered item list plus the three id lists `intake()` reports, plus `removed`
 * — ids no longer matched to any current source row, whose stale pointer must not survive into the
 * fit-back map or item-pointers.json (a later row shift would otherwise point them at another
 * item's row).
 */
/**
 * `remainder` (an id or topic list already in the wanted order) extended with every key
 * `removedSet` names that `remainder` does not carry, each inserted directly after the key that
 * preceded it in `oldOrder` (contract SI-4) — at the front when it had no predecessor there.
 * Removed keys are visited in `oldOrder` so a run of several removed neighbours chains correctly:
 * once the first is placed, it becomes the anchor the next one is found after.
 */
function reinsertByAnchor(remainder, oldOrder, removedSet) {
  const result = remainder.slice();
  const present = new Set(result);
  for (const key of oldOrder) {
    if (!removedSet.has(key)) continue;
    const idx = oldOrder.indexOf(key);
    let anchor = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (present.has(oldOrder[i])) { anchor = oldOrder[i]; break; }
    }
    if (anchor) result.splice(result.indexOf(anchor) + 1, 0, key);
    else result.unshift(key);
    present.add(key);
  }
  return result;
}

function mergeItems(existingItems, sourceItems, sourceFile, dateStr) {
  const added = [], reopened = [], unchanged = [], removed = [];
  const sourceById = new Map(sourceItems.filter(s => s.id).map(s => [s.id, s]));
  const claimed = new Set();
  const byId = new Map();

  for (const ex of existingItems) {
    const match = sourceById.get(ex.id);
    if (!match) {
      const refText = `removed from ${sourceFile}`;
      removed.push(ex.id);
      byId.set(ex.id, ex.references.includes(refText) ? ex : { ...ex, references: [...ex.references, refText] });
      continue;
    }
    claimed.add(ex.id);
    if (normalize(match.requirement) !== normalize(ex.requirement)) {
      byId.set(ex.id, {
        ...ex, requirement: match.requirement, status: { kind: 'reopened', date: null, cq: null },
        references: [...ex.references, `reopened ${dateStr}: requirement text changed in ${sourceFile}`],
        pointer: match.pointer,
      });
      reopened.push(ex.id);
    } else {
      byId.set(ex.id, { ...ex, pointer: match.pointer });
      unchanged.push(ex.id);
    }
  }

  for (const s of sourceItems) {
    if (s.id && claimed.has(s.id)) continue;
    byId.set(s.id, newItem(s));
    added.push(s.id);
  }

  // SI-4: items in client order within a topic — the current extraction's own row/item order —
  // with a removed item (no source row any more) staying directly after the item that preceded it
  // in the previous document.
  // A topic is keyed by tab+topic, not topic name alone: the same topic name can occur under two
  // different tabs (e.g. a client chapter reused across the questionnaire's own tabs), and each
  // occurrence must keep its own client order within its own tab rather than being merged into one.
  const topicKeyOf = id => { const it = byId.get(id); return `${it.tab}\u0000${it.topic}`; };
  const sourceOrderIds = sourceItems.map(s => s.id);
  const oldOrderIds = existingItems.map(ex => ex.id);
  const removedSet = new Set(removed);
  const fullOrder = reinsertByAnchor(sourceOrderIds, oldOrderIds, removedSet);

  // SI-4: topics in client first-seen order within a tab — a topic the source no longer carries
  // at all reinserted the same way, after the topic that preceded it before, keeping its old tab
  // (its key already carries the tab it had, live or extinct).
  const topicSourceOrder = [];
  for (const id of sourceOrderIds) { const t = topicKeyOf(id); if (!topicSourceOrder.includes(t)) topicSourceOrder.push(t); }
  const topicOldOrder = [];
  for (const id of oldOrderIds) { const t = topicKeyOf(id); if (!topicOldOrder.includes(t)) topicOldOrder.push(t); }
  const extinctTopics = new Set(topicOldOrder.filter(t => !topicSourceOrder.includes(t)));
  const topicOrder = reinsertByAnchor(topicSourceOrder, topicOldOrder, extinctTopics);

  const byTopic = new Map();
  for (const id of fullOrder) {
    const it = byId.get(id);
    const key = topicKeyOf(id);
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(it);
  }
  const orderedTopics = [...topicOrder].sort((a, b) => TABS.indexOf(byTopic.get(a)?.[0]?.tab) - TABS.indexOf(byTopic.get(b)?.[0]?.tab));
  const items = orderedTopics.flatMap(t => byTopic.get(t) || []);

  return { items, added, reopened, unchanged, removed };
}

// ---------------------------------------------------------------- render

/** §4 body in canonical order (contract §1) — the one renderer `apply`/`ops` also use. */
export function renderScopeItems(items) {
  return renderItemsSection(items);
}

function withMarkedBlock(raw, begin, end, content) {
  const b = raw.indexOf(begin), e = raw.indexOf(end);
  if (b >= 0 && e >= 0 && e > b) return raw.slice(0, b + begin.length) + '\n' + content + '\n' + raw.slice(e);
  const sep = raw.trim() ? '\n\n' : '';
  return `${raw.trim()}${sep}${begin}\n${content}\n${end}`;
}

/** §1's free prose (everything before `### Project information`), kept across intakes — the
 * editor's own words, never generated (contract §1). Exported: `ops.mjs` reuses it for `skip`/
 * `restore`/`info`, which rewrite §1 without going through a full `intake()` run. */
export function proseBefore(raw) {
  const idx = (raw || '').indexOf('### Project information');
  return idx < 0 ? (raw || '').trim() : raw.slice(0, idx).trim();
}

export function renderContext(prose, projectInfo, notTaken) {
  const parts = [prose, renderProjectInfo(projectInfo), renderNotTaken(notTaken)].filter(Boolean);
  return parts.join('\n\n');
}

function yamlScalar(v) { return v == null ? '' : String(v); }

function renderFrontmatter(data) {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v);
      lines.push(`${k}:${entries.length ? '' : ' {}'}`);
      for (const [k2, v2] of entries) lines.push(`  ${k2}: ${yamlScalar(v2)}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  return lines.join('\n');
}

function defaultTitle(slug) {
  const m = /^rfp-(\d+)-(.*)$/i.exec(slug || '');
  if (!m) return slug || 'Tender';
  const words = m[2].split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `RFP-${m[1]} — ${words}`;
}

function renderDocument({ frontmatterData, title, sections }) {
  let text = `---\n${renderFrontmatter(frontmatterData)}\n---\n`;
  text += `# ${title}\n`;
  for (const s of sections) {
    text += `\n## ${s.n}. ${s.title}\n`;
    if (s.raw && s.raw.trim()) text += `\n${s.raw.trim()}\n`;
  }
  return text.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------- fit-back map (xlsx only, contract §4)

function detectTokens(wb, table) {
  const sheet = wb.sheets.find(s => s.name === table.sheet);
  const rows = sheet ? sheetToGrid(sheet).rows : [];
  const priority = table.columns.priority
    ? (sheet && tokensForColumn(sheet.validations, colToNumber(table.columns.priority), table.firstDataRow, table.lastDataRow))
      || distinctColumnValues(rows, table.columns.priority, table.firstDataRow, table.lastDataRow)
    : [];
  const compliance = table.columns.compliance
    ? (sheet && tokensForColumn(sheet.validations, colToNumber(table.columns.compliance), table.firstDataRow, table.lastDataRow))
      || distinctColumnValues(rows, table.columns.compliance, table.firstDataRow, table.lastDataRow)
    : [];
  return { priority: priority || [], compliance: compliance || [], complianceLegend: null, coverage: {} };
}

/**
 * Builds/updates the committed fit-back map (contract §4). `tokens.*` is carried from the proposed
 * map for the same sheet+headerRow when there is one; otherwise re-detected the same way
 * `proposeMap` would. Whatever the PREVIOUS committed map already decided for that table's own
 * `key` — `tokens.coverage`, set by `tokens --file` (`ops.mjs` `tokensApply`), and any other
 * operator-decided token data — survives on top of that, so a re-intake never wipes an
 * already-confirmed Requirement Coverage mapping. `items` merges on top of whatever the previous
 * map already recorded, EXCEPT `removedIds` — an item this run's source no longer covers has no
 * pointer here: its old row may now belong to a different item once rows shift, so carrying its
 * stale pointer forward would make `export` write this id's answer into that other item's cell
 * instead of reporting it not written.
 */
function buildFitBackMap({ root, sourceAbs, wb, extraction, previous, finalItems, removedIds = new Set() }) {
  const proposed = readJsonSafe(proposedMapPathFor(sourceAbs));
  // `proposeMap` names a multi-block sheet's own tables `<real sheet name> · <block heading>`, which
  // never equals the extraction's own `sheet` (always the real name, contract §2) — matched instead
  // by sheet INDEX (shared by every block of one sheet) + headerRow, unique per block either way.
  const proposedByIndexRow = new Map((proposed?.tables || []).map(t => [`${t.index} r${t.headerRow}`, t]));
  const previousByKey = new Map((previous?.tables || []).map(t => [t.key, t]));

  const tables = extraction.tables.map(t => {
    const sheet = wb.sheets.find(s => s.name === t.sheet);
    const grid = sheet ? sheetToGrid(sheet).rows : [];
    const key = `${t.sheet} r${t.headerRow}`;
    const fromProposed = sheet && proposedByIndexRow.get(`${sheet.index} r${t.headerRow}`);
    const fromPrevious = previousByKey.get(key);
    const tokens = { ...(fromProposed?.tokens || detectTokens(wb, t)) };
    if (fromPrevious?.tokens?.coverage) tokens.coverage = fromPrevious.tokens.coverage;
    return {
      key, sheet: t.sheet, part: sheet?.part || null,
      headerRow: t.headerRow, firstDataRow: t.firstDataRow, lastDataRow: t.lastDataRow,
      columns: t.columns, tokens,
      assumptionsColumn: t.columns.assumptions || null,
      headerText: grid[t.headerRow - 1] || [],
    };
  });

  const usedSheets = new Set(extraction.tables.map(t => t.sheet));
  const unusedSheets = wb.sheets.filter(s => s.state === 'visible' && !s.name.startsWith('_') && !usedSheets.has(s.name)).map(s => s.name);

  const items = { ...(previous?.items || {}) };
  for (const id of removedIds) delete items[id];
  for (const it of finalItems) {
    if (removedIds.has(it.id)) continue;
    const p = parsePointer(it.pointer);
    if (p && p.kind === 'cell') {
      const table = tables.find(t => t.sheet === p.sheet && p.row >= t.firstDataRow && p.row <= t.lastDataRow);
      if (table) items[it.id] = { table: table.key, sheet: table.sheet, row: p.row };
    }
  }

  return {
    source: path.relative(root, sourceAbs).split(path.sep).join('/'),
    sha256: sha256(fs.readFileSync(sourceAbs)),
    extractedAt: new Date().toISOString(),
    confirmedAt: null,
    tables, unusedSheets, items,
  };
}

// ---------------------------------------------------------------- intake()

/**
 * `intake({ root, doc, source, extraction }) → { added, reopened, unchanged, doc }`.
 *
 * `doc` and `source` are absolute paths (the CLI resolves them; a library caller does the same).
 * `extraction` is the skill's extraction result (contract §2) — a parsed object, or a path to its
 * JSON file.
 */
export function intake({ root, doc, source, extraction }) {
  if (!doc) throw new Error('doc is required');
  if (!source) throw new Error('source is required');
  if (!fs.existsSync(source)) throw new Error(`source not found: ${source}`);
  if (extraction == null) throw new Error('extraction is required (--extraction <json>)');

  let extractionData = extraction;
  if (typeof extraction === 'string') {
    const asFile = fs.existsSync(extraction) ? extraction : null;
    try { extractionData = JSON.parse(asFile ? fs.readFileSync(asFile, 'utf8') : extraction); }
    catch (e) { throw new Error(`extraction is not valid JSON: ${e.message}`); }
  }

  const ext = path.extname(source).toLowerCase();
  const sourceFile = path.basename(source);
  const sourceHash = sha256(fs.readFileSync(source));
  if (!['.xlsx', '.csv', '.pdf'].includes(ext)) throw new Error(`intake does not read ${ext || 'this'} sources`);

  let wb = null, gridFor = null;
  let sheetIndex = null;
  if (ext !== '.pdf') {
    const opened = openGrid(source, ext);
    wb = opened.wb; gridFor = opened.gridFor;
    if (wb) sheetIndex = new Map(wb.sheets.map(s => [s.name, { width: sheetToGrid(s).width, state: s.state }]));
  }

  const problems = validateExtraction(extractionData, { ext, sheetIndex });
  if (problems.length) throw new Error(`extraction.json is not usable:\n  - ${problems.join('\n  - ')}`);

  const exists = fs.existsSync(doc);
  const existingText = exists ? fs.readFileSync(doc, 'utf8') : emptyTemplate();
  const existingModel = parse(existingText, { path: exists ? doc : null });
  if (exists && existingModel.errors.length) {
    throw new Error(`cannot intake into a document with errors:\n  - ${existingModel.errors.join('\n  - ')}`);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const { notTaken, excludePointers } = mergeNotTaken(existingModel.notTaken, extractionData, ext, gridFor || (() => []));

  let sourceItems = ext === '.pdf'
    ? readPdfItems(extractionData, NO_EXCLUDE)
    : readSourceItems(extractionData, gridFor, NO_EXCLUDE);
  // SI-2: generated ids are numbered over every source row, skipped ones included, so a skip,
  // a restore or a re-intake never renumbers the rows after it.
  assignIds(sourceItems);
  sourceItems = sourceItems.filter(it => !excludePointers.has(it.pointer));

  const { items: mergedItems, added, reopened, unchanged, removed } = mergeItems(existingModel.items, sourceItems, sourceFile, dateStr);
  const projectInfo = mergeProjectInfo(existingModel.projectInfo, extractionData.projectInfo);

  // Frontmatter.
  const frontmatterData = { ...(exists ? existingModel.frontmatter?.data : null) };
  frontmatterData.state = isReady(mergedItems) ? 'Ready' : 'In progress';
  frontmatterData.regime = regimeOf(root || '.');
  frontmatterData['source-sha256'] = { ...(frontmatterData['source-sha256'] || {}), [sourceFile]: sourceHash };
  if (!frontmatterData.slug) frontmatterData.slug = slugFor(doc);
  // The review gate is gone (own-tabs contract §3): a successful intake confirms itself — no
  // operator action sits between extraction and analysis any more. `confirmFitBack` (below) makes
  // the matching write on the fit-back map, the same one `ops.mjs`'s `intakeConfirm` makes for an
  // old document still at `review` (backward compatibility).
  frontmatterData.intake = 'confirmed';
  const ordered = {};
  for (const k of ['state', 'regime', 'source-sha256', 'slug', 'intake']) ordered[k] = frontmatterData[k];
  for (const k of Object.keys(frontmatterData)) if (!(k in ordered)) ordered[k] = frontmatterData[k];

  const title = exists && existingModel.title ? existingModel.title : defaultTitle(ordered.slug);

  const sections = existingModel.blocks.map(b => ({ n: b.n, title: b.title, raw: b.raw }));
  const s1 = sections.find(s => s.n === 1);
  s1.raw = renderContext(proseBefore(s1.raw), projectInfo, notTaken);
  const s2 = sections.find(s => s.n === 2);
  s2.raw = '<!-- totals:begin -->\n<!-- totals:end -->';
  const s4 = sections.find(s => s.n === 4);
  s4.raw = renderScopeItems(mergedItems);

  const text = renderDocument({ frontmatterData: ordered, title, sections });
  atomicWrite(doc, text);

  // Internal bookkeeping (never committed, `specs/.rfp/` is gitignored): the extraction this run
  // used, and every current item's source pointer — `ops.mjs` `skip`/`restore` read both.
  // An id `removed` this run (no longer matched to a source row) drops its pointer here too: its
  // OLD row may now belong to a different item once rows shift, so carrying it forward would let
  // `export` write this id's answer into that other item's cell (contract §4).
  const slug = ordered.slug;
  writeJson(extractionPathFor(root, slug), extractionData);
  const removedIds = new Set(removed);
  const pointers = { ...(readJsonSafe(pointersPathFor(root, slug)) || {}) };
  for (const id of removedIds) delete pointers[id];
  for (const it of mergedItems) if (it.pointer && !removedIds.has(it.id)) pointers[it.id] = it.pointer;
  writeJson(pointersPathFor(root, slug), pointers);

  if (ext === '.xlsx') {
    const previous = readJsonSafe(fitBackPathFor(source));
    const fitBack = buildFitBackMap({ root, sourceAbs: source, wb, extraction: extractionData, previous, finalItems: mergedItems, removedIds });
    writeJson(fitBackPathFor(source), fitBack);
    confirmFitBack(source, dateStr);
  }

  return { added, reopened, unchanged, removed, doc };
}

/** Sets `confirmedAt` on an xlsx source's own fit-back map (own-tabs contract §3/§4) — the one
 * step `intake()`'s own auto-confirm and `ops.mjs`'s `intakeConfirm` (backward compatibility for a
 * document still at `review` from before intake confirmed itself) both make, so neither
 * reimplements it. A no-op when there is no fit-back map yet (a csv/pdf source, contract §4). */
export function confirmFitBack(sourceAbs, dateStr = new Date().toISOString().slice(0, 10)) {
  if (!sourceAbs) return;
  const map = readJsonSafe(fitBackPathFor(sourceAbs));
  if (map) { map.confirmedAt = dateStr; writeJson(fitBackPathFor(sourceAbs), map); }
}

// ---------------------------------------------------------------- restore() (contract §3, ops.mjs)

/**
 * Rebuilds one item from `extraction.json` (the last one `intake` used for this document) plus the
 * source's own snapshot (xlsx/csv) or `extraction.json`'s `items` (pdf) — `ops.mjs`'s `restore`.
 * `source` is the Not-taken row's own Source pointer (`<sheet> r<row>` or `PDF #<n>`). Returns the
 * rebuilt row plus `order`, every source id in client order, so the caller can put it back in place.
 */
export function restoreFromSource({ root, doc, source: sourcePointer }) {
  const slug = slugFor(doc);
  const extraction = readJsonSafe(extractionPathFor(root, slug));
  if (!extraction) throw new Error(`no recorded extraction for this document; re-run intake`);
  const p = parsePointer(sourcePointer);
  if (!p) throw new Error(`"${sourcePointer}" is not a recognised source pointer`);

  if (p.kind === 'pdf') {
    const all = assignIds(readPdfItems(extraction, NO_EXCLUDE));
    const found = all.find(it => it.pointer === sourcePointer);
    if (!found) throw new Error(`no such source: ${sourcePointer}`);
    return { ...found, order: all.map(it => it.id) };
  }

  const table = (extraction.tables || []).find(t => t.sheet === p.sheet && p.row >= t.firstDataRow && p.row <= t.lastDataRow);
  if (!table) throw new Error(`no such source: ${sourcePointer}`);
  const model = parse(fs.readFileSync(doc, 'utf8'), { path: doc });
  const sourceFile = Object.keys(model.frontmatter?.data?.['source-sha256'] || {}).pop();
  if (!sourceFile) throw new Error('the document names no source file');
  const sourceAbs = path.join(path.dirname(doc), sourceFile);
  const ext = path.extname(sourceAbs).toLowerCase();
  const { gridFor } = openGrid(sourceAbs, ext);
  // The same generation `intake` runs (all rows, skipped ones included), so the restored item gets
  // back exactly the id it had — never a fresh one.
  const all = assignIds(readSourceItems(extraction, gridFor, NO_EXCLUDE));
  const row = all.find(it => it.pointer === sourcePointer);
  if (!row) throw new Error(`source ${sourcePointer} has no requirement text (or is outside its table)`);
  return { ...row, order: all.map(it => it.id) };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') { opts.source = argv[++i]; continue; }
    if (a === '--extraction') { opts.extraction = argv[++i]; continue; }
    if (a === '--root') { opts.root = argv[++i]; continue; }
    if (!a.startsWith('--')) opts._.push(a);
  }
  return opts;
}

export function main(argv = []) {
  const opts = parseArgs(argv);
  const docArg = opts._[0];
  if (!docArg || !opts.source || !opts.extraction) {
    out.line('reason', 'usage: intake <doc> --source <file> --extraction <json>');
    process.exitCode = out.EXIT_USAGE;
    return;
  }
  const docAbs = canonical(docArg);
  const root = resolveRoot({ rootFlag: opts.root || '', docAbs });
  const sourceAbs = canonical(opts.source);
  if (!fs.existsSync(sourceAbs)) {
    out.line('reason', `source not found: ${opts.source}`);
    process.exitCode = out.EXIT_UNREACHABLE;
    return;
  }

  let extractionRaw = opts.extraction;
  const asFile = canonical(opts.extraction);
  if (fs.existsSync(asFile)) extractionRaw = fs.readFileSync(asFile, 'utf8');
  let extractionData;
  try { extractionData = JSON.parse(extractionRaw); } catch (e) {
    out.line('reason', `--extraction is not valid JSON: ${e.message}`);
    process.exitCode = out.EXIT_USAGE;
    return;
  }

  try {
    const result = intake({ root, doc: docAbs, source: sourceAbs, extraction: extractionData });
    out.line('doc', path.relative(root, result.doc) || path.basename(result.doc));
    out.line('added', result.added.length);
    out.line('reopened', result.reopened.length);
    out.line('unchanged', result.unchanged.length);
    if (result.removed.length) out.line('removed', result.removed.length);
    out.nextStep('run `check <doc> --write` then `report <doc>` — analysis queued');
  } catch (e) {
    out.line('reason', e.message);
    process.exitCode = out.EXIT_UNREACHABLE;
  }
}
