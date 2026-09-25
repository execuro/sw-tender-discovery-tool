// `-analysis.md` → model. Grammar: build contract `own-tabs-contract.md` §1.
// D-19: the old (0.1.x) grammar is not read; this parser knows only the new one.
import { parseYaml } from './yaml.mjs';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SECTION_RE = /^##\s+(\d+)\.\s+(.*?)\s*$/;
const TITLE_RE = /^#\s+(.*?)\s*$/;
const AREA_RE = /^###\s+(.*?)\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const PROJECT_INFO_HEADING = '### Project information';
const NOT_TAKEN_HEADING = '### Not taken from the source';
const INTAKE_SET = new Set(['review', 'confirmed']);

export const SECTION_TITLES = [
  'Context', 'Totals', 'Global assumptions and exclusions', 'Scope items', 'Questions',
  'Integrations', 'Glossary', 'Log',
];

/** §4 tabs, fixed, in canonical render order. Contract §1. */
export const TABS = ['Functional', 'Non-functional', 'Project & services'];

/** §1 `### Project information`, fixed order, 18 rows. Contract §1. */
export const PROJECT_INFO = [
  { key: 'business-model', label: 'Business model' },
  { key: 'markets', label: 'Markets' },
  { key: 'languages', label: 'Languages' },
  { key: 'currencies', label: 'Currencies' },
  { key: 'sales-channels', label: 'Sales channels' },
  { key: 'customers', label: 'Customers & groups' },
  { key: 'products', label: 'Products / SKUs' },
  { key: 'catalogue-structure', label: 'Categories & attributes' },
  { key: 'media', label: 'Media volume' },
  { key: 'catalogue-updates', label: 'Catalogue update frequency & master system' },
  { key: 'price-model', label: 'Price model' },
  { key: 'orders', label: 'Orders per day (avg / peak)' },
  { key: 'traffic', label: 'Traffic & peak users' },
  { key: 'current-platform', label: 'Current platform' },
  { key: 'leading-systems', label: 'Leading systems (ERP / PIM / CRM)' },
  { key: 'data-migration', label: 'Data to migrate' },
  { key: 'go-live', label: 'Target go-live' },
  { key: 'shopware', label: 'Shopware version / edition / plan' },
];

// §4 column order (contract §1): client inputs first (ID, Prio, Requirement), then the working
// fields. `Effort` is renamed `Estimation` (user-facing only; the report JSON key stays `effort`,
// contract §3) — the renderers always emit this order and this label; `OLD_ITEM_HEADER` below is
// what the parser still accepts on read, for a document written before the rename.
export const ITEM_HEADER = ['ID', 'Prio', 'Requirement', 'Requirement Coverage', 'Confidence', 'Estimation', 'Client Response', 'Assumptions', 'Internal note', 'References', 'Status'];
export const ITEM_HEADER_LINE = `| ${ITEM_HEADER.join(' | ')} |`;
/** The pre-rename header and column order (`Effort` before `Requirement`, no `Requirement`-first
 * client-input grouping) — accepted on read; never written. */
const OLD_ITEM_HEADER = ['ID', 'Prio', 'Requirement Coverage', 'Confidence', 'Effort', 'Requirement', 'Client Response', 'Assumptions', 'Internal note', 'References', 'Status'];
const NEW_ITEM_COLS = { id: 0, prio: 1, requirement: 2, coverage: 3, confidence: 4, effort: 5, clientResponse: 6, assumptions: 7, internalNote: 8, references: 9, status: 10 };
const OLD_ITEM_COLS = { id: 0, prio: 1, coverage: 2, confidence: 3, effort: 4, requirement: 5, clientResponse: 6, assumptions: 7, internalNote: 8, references: 9, status: 10 };

/** Which of the two known §4 header layouts a table's own header row matches (contract §1's
 * backward read) — the column-index map to build items from, or `null` when it matches neither
 * (a parse error the caller reports, naming the canonical `ITEM_HEADER_LINE`). */
function matchItemHeader(header) {
  if (header.length === ITEM_HEADER.length && header.every((h, k) => h === ITEM_HEADER[k])) return NEW_ITEM_COLS;
  if (header.length === OLD_ITEM_HEADER.length && header.every((h, k) => h === OLD_ITEM_HEADER[k])) return OLD_ITEM_COLS;
  return null;
}

export const COVERAGE_VALUES = ['OOTB', 'Configuration', 'Extension', 'ISV', 'Custom', '—'];
const COVERAGE_SET = new Set(COVERAGE_VALUES);
const CONFIDENCE_SET = new Set(['high', 'medium', 'low']);
export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SIZE_SET = new Set(SIZES);

const STATUS_SIMPLE_RE = /^(queued|estimated|failed|reopened)$/;
const STATUS_BLOCKED_RE = /^blocked\s+(CQ-\d+)$/;
const STATUS_CONFIRMED_RE = /^confirmed\s+(\d{4}-\d{2}-\d{2})$/;

// `was <PD> PD` (no colon, like `removed from`) is `ops.mjs accept`'s own audit line: the Effort
// figure before a proposal's `pdSaved` was applied against it (contract §3, accept).
const REF_PREFIX_RE = /^(?:(kb|project|isv|cost|rejected|failed|draft):\s*.+|reopened\s+\d{4}-\d{2}-\d{2}:\s*.+|removed from\s+.+|was\s+.+)$/;

const CQ_HEAD_RE = /^###\s+(CQ|Q)-(\d+)\s+·\s+(.*?)\s*$/;
const OPTION_RE = /^-\s+\[( |x|X)\]\s+([A-Z])\s+—\s+(.*?)\s+—\s+effect:\s*(.*?)\s*$/;
const FALLBACK_RE = /^Fallback:\s*([A-Z])\s*$/;
const ANSWERED_RE = /^Answered\s+(\d{4}-\d{2}-\d{2}):\s*([A-Z])\s*$/;

export function normalize(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
}

/** 12-hex content hash (cyrb53) of the normalised text. */
export function hash(text) {
  const s = normalize(text);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
}

export function slugFromPath(p) {
  const base = String(p ?? '').split(/[\\/]/).pop();
  const slug = base.replace(/-analysis\.md$/i, '').replace(/\.(xlsx|csv|md|pdf)$/i, '');
  return /^rfp-\d{4}-/.test(slug) ? slug : null;
}

export function analysisPathFor(p) {
  const s = String(p ?? '');
  if (/-analysis\.md$/i.test(s)) return s;
  return s.replace(/\.(xlsx|csv|md|pdf)$/i, '') + '-analysis.md';
}

/** Split a markdown table row into trimmed cells (`\|` unescaped, code spans respected). */
export function splitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '', inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** `<br>`-joined cell → array of bullet texts (leading `- ` stripped). */
export function splitBullets(cell) {
  return String(cell ?? '')
    .split(/<br\s*\/?>/i)
    .map(s => s.trim().replace(/^-\s+/, '').trim())
    .filter(Boolean);
}

export function collect(blocks, out = []) {
  for (const b of blocks || []) {
    out.push(b);
    if (b.children) collect(b.children, out);
  }
  return out;
}

export function findBlock(model, id) {
  return collect(model.blocks).find(b => b.id === id) || null;
}

// --- Estimation / Status / References ---------------------------------------------------------
// `effort` stays the internal name (the report JSON key, contract §3) — only the column label and
// its error text are user-facing "Estimation" (§4/5b).

/** Estimation cell → `{ size, pd, regime }`, or `null` when not estimated / unparseable. */
export function parseEffort(raw, onError = () => {}) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^—\s*\(\s*0\s*PD\s*\)$/.test(s)) return { size: '—', pd: 0, regime: 'T-shirt' };
  let m = /^([A-Z]{1,3})\s*\(\s*([\d.]+)\s*PD\s*\)$/.exec(s);
  if (m) {
    if (!SIZE_SET.has(m[1])) { onError(`invalid Estimation size "${m[1]}"`); return null; }
    return { size: m[1], pd: Number(m[2]), regime: 'T-shirt' };
  }
  m = /^([\d.]+)\s*PD$/.exec(s);
  if (m) return { size: null, pd: Number(m[1]), regime: 'profile' };
  onError(`invalid Estimation cell "${raw}"`);
  return null;
}

/** Estimation `{size,pd,regime}` (or null) → the exact cell text for that regime. */
export function formatEffort(effort) {
  if (!effort) return '';
  if (effort.regime === 'profile') return `${effort.pd} PD`;
  if (effort.size === '—') return '— (0 PD)';
  return `${effort.size} (${effort.pd} PD)`;
}

/** Status cell → `{ kind, date, cq }`. */
export function parseStatus(raw, onError = () => {}) {
  const s = String(raw ?? '').trim();
  if (STATUS_SIMPLE_RE.test(s)) return { kind: s, date: null, cq: null };
  let m = STATUS_BLOCKED_RE.exec(s);
  if (m) return { kind: 'blocked', date: null, cq: m[1] };
  m = STATUS_CONFIRMED_RE.exec(s);
  if (m) return { kind: 'confirmed', date: m[1], cq: null };
  onError(`invalid Status cell "${raw}"`);
  return { kind: null, date: null, cq: null };
}

export function formatStatus(status) {
  if (!status || !status.kind) return '';
  if (status.kind === 'blocked') return `blocked ${status.cq}`;
  if (status.kind === 'confirmed') return `confirmed ${status.date}`;
  return status.kind;
}

export function validReference(entry) {
  return REF_PREFIX_RE.test(String(entry ?? '').trim());
}

// --- §1 Project information / Not taken -----------------------------------------------------

/** `### <Tab> · <Topic>` (§4) → `{ tab, topic }`, or `{ tab: null, topic: null }` when the
 * heading has no `·` (U+00B7) preceded by a space — the separator contract §1 requires. A
 * present separator with nothing (or only whitespace) after it yields `topic: ''`, distinct from
 * no separator at all, so the caller can tell "malformed heading" from "empty Topic". */
export function splitHeading(text) {
  const s = String(text ?? '');
  const idx = s.indexOf('·');
  if (idx < 0 || s[idx - 1] !== ' ') return { tab: null, topic: null };
  return { tab: s.slice(0, idx - 1).trim(), topic: s.slice(idx + 1).trim() };
}

/** Exact markdown for §1 `### Project information`, from `model.projectInfo`-shaped rows
 * (`{ label, value, source }`). Shared by the parser's own round-trip tests and by `intake`/`ops`
 * so the tool renders this subsection identically everywhere (contract §1). */
export function renderProjectInfo(rows) {
  const lines = [PROJECT_INFO_HEADING, '', '| Parameter | Value | Source |', '| --- | --- | --- |'];
  for (const r of rows || []) lines.push(`| ${r.label} | ${r.value || ''} | ${r.source || ''} |`);
  return lines.join('\n');
}

/** Exact markdown for §1 `### Not taken from the source`, from `model.notTaken`-shaped rows
 * (`{ source, text, why }`). Contract §1. */
export function renderNotTaken(rows) {
  const lines = [NOT_TAKEN_HEADING, '', '| Source | Text | Why |', '| --- | --- | --- |'];
  for (const r of rows || []) lines.push(`| ${r.source || ''} | ${r.text || ''} | ${r.why || ''} |`);
  return lines.join('\n');
}

/** Scan `[from, to)` for the first markdown table (header + separator row), returning
 * `{ header, rows }` cell arrays, or `null` if none is found before `to`. */
function findTable(lines, from, to) {
  for (let i = from; i < to; i++) {
    if (isTableRow(lines[i]) && isSepRow(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < to && isTableRow(lines[j])) { rows.push(splitRow(lines[j])); j++; }
      return { header, rows };
    }
  }
  return null;
}

/** `### Project information` rows, validated row-by-row against `PROJECT_INFO`'s fixed order
 * (contract §1) — a missing, unknown or out-of-order row is a parse error that names the row. */
function parseProjectInfoRows(rows, push) {
  const items = [];
  const n = Math.max(rows.length, PROJECT_INFO.length);
  for (let i = 0; i < n; i++) {
    const want = PROJECT_INFO[i];
    const got = rows[i];
    if (!want) { push(`§1 Project information: unexpected row "${(got && got[0]) || ''}"`); continue; }
    if (!got) { push(`§1 Project information: missing row "${want.label}"`); continue; }
    if (got[0] !== want.label) { push(`§1 Project information: row ${i + 1} must be "${want.label}", got "${got[0]}"`); continue; }
    items.push({ key: want.key, label: want.label, value: got[1] || '', source: got[2] || '' });
  }
  return items;
}

/** §1 Context: the free prose meta, then `### Project information` and
 * `### Not taken from the source`, both always present, in that order (contract §1). */
function parseContext(lines, push, model) {
  const piIdx = lines.findIndex(l => l.trim() === PROJECT_INFO_HEADING);
  const ntIdx = lines.findIndex(l => l.trim() === NOT_TAKEN_HEADING);
  if (piIdx < 0) push('§1 is missing "### Project information"');
  if (ntIdx < 0) push('§1 is missing "### Not taken from the source"');
  if (piIdx >= 0 && ntIdx >= 0 && ntIdx < piIdx) push('§1 "### Not taken from the source" must come after "### Project information"');

  if (piIdx >= 0) {
    const end = ntIdx > piIdx ? ntIdx : lines.length;
    const t = findTable(lines, piIdx + 1, end);
    if (!t) push('§1 Project information: missing table');
    else {
      if (!(t.header.length === 3 && t.header[0] === 'Parameter' && t.header[1] === 'Value' && t.header[2] === 'Source')) {
        push('§1 Project information header must be exactly: | Parameter | Value | Source |');
      }
      model.projectInfo = parseProjectInfoRows(t.rows, push);
    }
  }
  if (ntIdx >= 0) {
    const t = findTable(lines, ntIdx + 1, lines.length);
    if (!t) push('§1 Not taken from the source: missing table');
    else {
      if (!(t.header.length === 3 && t.header[0] === 'Source' && t.header[1] === 'Text' && t.header[2] === 'Why')) {
        push('§1 Not taken from the source header must be exactly: | Source | Text | Why |');
      }
      model.notTaken = t.rows.map(r => ({ source: r[0] || '', text: r[1] || '', why: r[2] || '' }));
    }
  }
}

// --- Sheet-prefix ids (SI-2) --------------------------------------------------------------------

const STOPWORDS = new Set(['and', 'und']);
const CHAPTER_NUMBER_RE = /^\s*\d+(?:\.\d+)*\.?\s*(?:[-–—:]\s*)?/;

/** Strips a leading client chapter number ("1. GENERAL REQUIREMENTS", "3.3 - Functional") — it is
 * numbering, not a word, and never belongs in a topic name or a sheet-prefix id (contract §1). */
export function stripChapterNumber(text) {
  return String(text ?? '').replace(CHAPTER_NUMBER_RE, '');
}

/** `<sheet prefix>` for an area name, unique against `taken` (mutated). Contract §1. */
export function sheetPrefix(areaName, taken = new Set()) {
  const words = stripChapterNumber(areaName)
    .split(/[\s/&]+/)
    .map(w => w.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(w => w && !STOPWORDS.has(w.toLowerCase()));
  let base;
  if (words.length <= 1) base = (words[0] || 'X').slice(0, 3).toUpperCase();
  else base = words.map(w => w[0]).join('').slice(0, 4).toUpperCase();
  if (!base) base = 'X';
  let prefix = base, n = 2;
  while (taken.has(prefix)) prefix = `${base}${n++}`;
  taken.add(prefix);
  return prefix;
}

/**
 * Fill missing ids on `areas` (`[{ name, items: [{ id, ... }] }]`) with `<prefix>-<n>`,
 * in source order within the area. Mutates and returns `areas`. Stable across calls with
 * the same area names/order (SI-2).
 */
export function generateIds(areas) {
  const taken = new Set();
  for (const area of areas || []) {
    const items = area.items || [];
    if (!items.some(it => !it.id)) continue;
    const prefix = sheetPrefix(area.name, taken);
    let n = 1;
    for (const item of items) {
      if (!item.id) item.id = `${prefix}-${n++}`;
    }
  }
  return areas;
}

// --- §4 Scope items ------------------------------------------------------------------------------

function isTableRow(line) { return line != null && TABLE_ROW_RE.test(line); }
function isSepRow(line) { return line != null && TABLE_SEP_RE.test(line); }

function unescapeCell(cell) {
  return String(cell ?? '').replace(/<br\s*\/?>/gi, '\n').trim();
}

function buildItem(cells, area, tab, topic, push, cols) {
  const idRaw = cells[cols.id], prioRaw = cells[cols.prio], coverageRaw = cells[cols.coverage],
    confidenceRaw = cells[cols.confidence], effortRaw = cells[cols.effort], reqRaw = cells[cols.requirement],
    respRaw = cells[cols.clientResponse], assumeRaw = cells[cols.assumptions], noteRaw = cells[cols.internalNote],
    refRaw = cells[cols.references], statusRaw = cells[cols.status];
  const id = unescapeCell(idRaw);
  const err = m => push(`item ${id || '?'}: ${m}`);
  const coverage = unescapeCell(coverageRaw);
  if (coverage && !COVERAGE_SET.has(coverage)) err(`invalid Requirement Coverage "${coverage}"`);
  const confidence = unescapeCell(confidenceRaw);
  if (confidence && !CONFIDENCE_SET.has(confidence)) err(`invalid Confidence "${confidence}"`);
  const effort = parseEffort(effortRaw, err);
  const status = parseStatus(statusRaw, err);
  const assumptions = splitBullets(assumeRaw);
  const references = splitBullets(refRaw);
  for (const r of references) if (!validReference(r)) err(`invalid reference "${r}"`);
  return {
    id, area, tab, topic, prio: unescapeCell(prioRaw),
    coverage: coverage || null, confidence: confidence || null, effort,
    requirement: unescapeCell(reqRaw), clientResponse: unescapeCell(respRaw),
    assumptions, internalNote: unescapeCell(noteRaw), references, status,
  };
}

/** §4 headings, `### <Tab> · <Topic>` (contract §1): a heading with no ` · ` separator, a Tab
 * not in `TABS`, or an empty Topic is a parse error naming the heading. */
function parseItems(lines, push, out) {
  let area = null, tab = null, topic = null;
  for (let i = 0; i < lines.length; i++) {
    const am = AREA_RE.exec(lines[i]);
    if (am) {
      area = am[1].trim();
      const split = splitHeading(area);
      tab = split.tab; topic = split.topic;
      if (tab == null) push(`§4 heading "${area}" must be "<Tab> · <Topic>"`);
      else {
        if (!TABS.includes(tab)) push(`§4 heading "${area}": tab "${tab}" is not one of ${TABS.join(', ')}`);
        if (!topic) push(`§4 heading "${area}": topic is empty`);
      }
      continue;
    }
    if (isTableRow(lines[i]) && isSepRow(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const cols = matchItemHeader(header);
      if (!cols) push(`§4 header under area "${area ?? ''}" must be exactly: ${ITEM_HEADER_LINE}`);
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        out.push(buildItem(splitRow(lines[j]), area, tab, topic, push, cols || NEW_ITEM_COLS));
        j++;
      }
      i = j - 1;
      continue;
    }
  }
  const seen = new Set();
  for (const it of out) {
    if (!it.id) continue;
    if (seen.has(it.id)) push(`duplicate item id "${it.id}" in §4`);
    seen.add(it.id);
  }
}

// --- §5 Questions ----------------------------------------------------------------------------

function parseQuestions(lines, push, out) {
  let i = 0;
  while (i < lines.length) {
    const hm = CQ_HEAD_RE.exec(lines[i]);
    if (!hm) { i++; continue; }
    const kind = hm[1] === 'CQ' ? 'cq' : 'q';
    const id = `${hm[1]}-${hm[2]}`;
    const items = hm[3].split(',').map(s => s.trim()).filter(Boolean);
    let j = i + 1;
    const skipBlank = () => { while (j < lines.length && lines[j].trim() === '') j++; };
    skipBlank();
    const qLines = [];
    while (j < lines.length && lines[j].trim() !== '' && !/^-\s+\[/.test(lines[j].trim()) && !/^Fallback:/.test(lines[j].trim())) { qLines.push(lines[j]); j++; }
    const question = qLines.join('\n').trim();
    skipBlank();
    const options = [];
    while (j < lines.length && /^-\s+\[/.test(lines[j].trim())) {
      const om = OPTION_RE.exec(lines[j].trim());
      if (om) options.push({ key: om[2], text: om[3], effect: om[4], checked: om[1].toLowerCase() === 'x' });
      else push(`${id}: invalid option line "${lines[j].trim()}"`);
      j++;
    }
    skipBlank();
    let fallback = null;
    const fm = j < lines.length ? FALLBACK_RE.exec(lines[j].trim()) : null;
    if (fm) { fallback = fm[1]; j++; }
    else if (options.length) push(`${id}: missing Fallback line`);
    skipBlank();
    let answered = null;
    const anm = j < lines.length ? ANSWERED_RE.exec(lines[j].trim()) : null;
    if (anm) { answered = { date: anm[1], key: anm[2] }; j++; }
    if (kind === 'cq' && options.length < 2) push(`${id}: needs at least two options`);
    if (fallback && options.length && !options.some(o => o.key === fallback)) push(`${id}: fallback ${fallback} is not one of its options`);
    out.push({ id, kind, items, question, options, fallback, answered });
    i = j;
  }
}

// ---------------------------------------------------------------------------

export function parse(text, { path = null } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const errors = [];
  const model = { path, slug: path ? slugFromPath(path) : null, frontmatter: null, title: '', blocks: [], items: [], questions: [], projectInfo: [], notTaken: [], errors };

  const fm = FM_RE.exec(src);
  let bodyStart = 0;
  if (fm) {
    let data = {};
    try { data = parseYaml(fm[1]); } catch (e) { errors.push(`frontmatter: ${e.message}`); }
    const raw = src.slice(0, fm[0].length).replace(/\n$/, '');
    model.frontmatter = { raw, line: 1, endLine: raw.split('\n').length, data };
    bodyStart = model.frontmatter.endLine;
    // `intake: review|confirmed` (contract §1); absent means confirmed.
    if (data.intake != null && !INTAKE_SET.has(data.intake)) errors.push(`frontmatter intake must be "review" or "confirmed", got "${data.intake}"`);
  } else {
    errors.push('missing frontmatter');
  }

  const lines = src.split('\n');
  const sections = [];
  let cur = null, sawTitle = false;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (!sawTitle && !cur) { const tm = TITLE_RE.exec(line); if (tm) { model.title = tm[1].trim(); sawTitle = true; continue; } }
    const sm = SECTION_RE.exec(line);
    if (sm) {
      cur = { id: `s${sm[1]}`, kind: 'section', n: Number(sm[1]), title: sm[2].trim(), line: i + 1, endLine: i + 1, lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }

  const wantOrder = sections.every((s, i) => s.n === i + 1);
  if (sections.length !== 8 || !wantOrder) errors.push(`expected 8 sections numbered 1..8 in order, got ${sections.map(s => s.n).join(',')}`);
  for (const [i, sec] of sections.entries()) {
    const wanted = SECTION_TITLES[i];
    if (wanted && sec.title !== wanted) errors.push(`§${sec.n} title must be "${wanted}", got "${sec.title}"`);
  }

  for (const sec of sections) {
    let last = sec.lines.length;
    while (last > 0 && sec.lines[last - 1].trim() === '') last--;
    sec.endLine = last ? sec.line + last : sec.line;
    model.blocks.push({ id: sec.id, kind: 'section', n: sec.n, title: sec.title, line: sec.line, endLine: sec.endLine, raw: sec.lines.slice(0, last).join('\n') });
  }

  const s1 = sections.find(s => s.n === 1);
  if (s1) parseContext(s1.lines, errors.push.bind(errors), model);
  const s4 = sections.find(s => s.n === 4);
  if (s4) parseItems(s4.lines, errors.push.bind(errors), model.items);
  const s5 = sections.find(s => s.n === 5);
  if (s5) parseQuestions(s5.lines, errors.push.bind(errors), model.questions);

  return model;
}
