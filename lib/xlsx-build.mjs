// Builds a fresh, minimal working-sheet workbook for a CSV or PDF source (X-5, contract §4
// `export`), mirroring the working sheet's own tabs, in page order: `Overview` (what the working
// sheet's `Totals` tab holds: regime, by priority, by tab, readiness counts), `Project
// information`, then all three `TABS` scope tabs — always present, even with no items (header row
// only) — then `Integrations` (§6) and `Glossary` (§7), each a transcription of the client's own
// document (a markdown table becomes rows with its header; prose becomes one row per paragraph or
// bullet). The `Log` tab (§8, the internal run trail) is never exported; References are never
// exported. Zero dependencies — a small, valid-OOXML zip writer, not a general xlsx library.
// Read back by `lib/xlsx.mjs` in the round-trip tests.
import zlib from 'node:zlib';
import { totals as calcTotals, readiness as calcReadiness } from './calc.mjs';
import { itemFieldMoneyHits } from './check.mjs';
import { TABS } from './parse.mjs';

const escXml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = n => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };

// ---------------------------------------------------------------- zip (no zip64: this workbook
// is small by construction — a handful of sheets, never more than a few thousand rows).

function zipEntry(name, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { name: Buffer.from(name, 'utf8'), data, compressed: zlib.deflateRawSync(data, { level: 6 }), method: 8, crc: zlib.crc32(data) };
}

function buildZip(files) {
  const entries = files.map(f => zipEntry(f.name, f.content));
  const chunks = [];
  const locals = [];
  let offset = 0;
  for (const e of entries) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0, 6);
    h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.compressed.length, 18);
    h.writeUInt32LE(e.data.length, 22);
    h.writeUInt16LE(e.name.length, 26);
    h.writeUInt16LE(0, 28);
    chunks.push(h, e.name, e.compressed);
    locals.push(offset);
    offset += 30 + e.name.length + e.compressed.length;
  }
  const cdStart = offset;
  entries.forEach((e, i) => {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt16LE(0x21, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.compressed.length, 20);
    h.writeUInt32LE(e.data.length, 24);
    h.writeUInt16LE(e.name.length, 28);
    h.writeUInt16LE(0, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE(0, 38);
    h.writeUInt32LE(locals[i], 42);
    chunks.push(h, e.name);
    offset += 46 + e.name.length;
  });
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- sheet xml

function cellXml(ref, value) {
  if (value === '' || value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(String(value))}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows.map((row, ri) => {
    const r = ri + 1;
    const cells = row.map((v, ci) => cellXml(`${colName(ci + 1)}${r}`, v)).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** Excel sheet names: max 31 chars, no `: \ / ? * [ ]`, unique. */
function safeSheetName(name, used) {
  let base = String(name || 'Sheet').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base, n = 2;
  while (used.has(out)) { const suffix = ` ${n++}`; out = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(out);
  return out;
}

const REQ_HEADER = ['ID', 'Topic', 'Requirement', 'Requirement Coverage', 'Estimation', 'Client Response', 'Assumptions'];
const PROJECT_INFO_HEADER = ['Parameter', 'Value', 'Source'];
const TOTALS_HEADER = ['Key', 'Items', 'Estimated PD', 'Blocked (at fallback)', 'Not estimated', 'Not decomposed'];

/** X-1: unconfirmed scope items export with empty answer cells — Coverage, Effort, Client
 * Response and Assumptions are all "answer" fields here (there is no client cell to leave
 * untouched, unlike the surgical xlsx path — this whole sheet is our own). */
function answerCells(item) {
  if (!item || item.status?.kind !== 'confirmed') return { coverage: '', effort: '', response: '', assumptions: '' };
  const effort = item.effort && typeof item.effort.pd === 'number' ? item.effort.pd : '';
  const assumptions = (item.assumptions || []).map(a => `- ${a}`).join('\n');
  return { coverage: item.coverage || '', effort, response: item.clientResponse || '', assumptions };
}

/**
 * Scans every field this function is about to write for money terms (X-7/R-7), the same scan and
 * R-7a exemptions `check.mjs`'s money gate applies (`itemFieldMoneyHits`) — so a document that
 * passes `check` is never refused here for a different reason, and vice versa. The tool's own
 * authored text only, never the client's verbatim Requirement. Returns the list of hits (empty
 * when clean); the caller refuses the export when it is non-empty.
 */
export function scanMoneyBeforeBuild(items) {
  const hits = [];
  for (const it of items || []) {
    if (it.status?.kind !== 'confirmed') continue;
    for (const { field, hits: h, val } of itemFieldMoneyHits(it)) hits.push(`item ${it.id} ${field}: ${h.join(', ')} in "${val}"`);
  }
  return hits;
}

const SEPARATOR_ROW_RE = /^\|[\s:|-]+\|$/;

/** One paragraph or bullet per row (§6/§7 prose, when the section is not a markdown table):
 * blank-line-separated paragraphs, each a single row; a paragraph whose every line is a `-`/`*`
 * bullet instead yields one row per bullet. */
function proseToRows(text) {
  const paragraphs = text.split(/\n\s*\n/);
  const rows = [];
  for (const para of paragraphs) {
    const lines = para.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.every(l => /^[-*]\s+/.test(l))) {
      for (const l of lines) rows.push([l.replace(/^[-*]\s+/, '')]);
    } else {
      rows.push([lines.join(' ')]);
    }
  }
  return rows;
}

/** §6/§7 section body → sheet rows: a markdown table (client's own §6/§7 content, transcribed
 * verbatim) becomes rows with its header row, its `| --- |` separator dropped; anything else is
 * treated as prose (`proseToRows`). Empty section → no rows (an empty tab, header row only from
 * the caller if it wants one — §6/§7 have none, unlike the always-present scope tabs). */
function sectionToRows(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines[0]?.startsWith('|') && lines[1] && SEPARATOR_ROW_RE.test(lines[1])) {
    return lines.filter(l => !SEPARATOR_ROW_RE.test(l)).map(l => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  }
  return proseToRows(text);
}

/**
 * Builds a working-sheet workbook from the parsed analysis (`parse.mjs` model), mirroring the
 * working sheet's own tabs in page order (module doc comment above). `proposals` (parsed
 * `proposals.json`, optional) feeds the Overview readiness line's Waiting proposals count, the
 * same way the working sheet's own Totals tab does. Throws `{ moneyHits: [...] }` rather than
 * writing when a hit is found.
 */
export function buildResponseWorkbook(model, { regimeLabel = '', profile = null, proposals = [] } = {}) {
  const items = model.items || [];
  // §1 Project information is the client's or operator's own facts, verbatim, amounts included
  // (2026-09-24 decision) — never scanned here.
  const hits = scanMoneyBeforeBuild(items);
  if (hits.length) { const err = new Error('refusing to export: money terms in tool-written text'); err.moneyHits = hits; throw err; }

  const used = new Set();
  const sheetNames = [];
  const sheetRowSets = [];

  // Overview — what the working sheet's own Totals tab holds: regime, by priority, by tab, the
  // readiness counts line.
  const t = calcTotals(items, { profile });
  const r = calcReadiness(items, { proposals, questions: model.questions || [] });
  const overviewRows = [[`Regime: ${regimeLabel}`], [], ['By priority'], TOTALS_HEADER,
    ...t.byPriority.map(row => [row.key, row.items, row.estimatedPd, row.blocked, row.notEstimated, row.notDecomposed]),
    ['Total', t.total.items, t.total.estimatedPd, t.total.blocked, t.total.notEstimated, t.total.notDecomposed],
    [], ['By tab'], TOTALS_HEADER,
    ...t.byTab.map(row => [row.key, row.items, row.estimatedPd, row.blocked, row.notEstimated, row.notDecomposed]),
    [], [`Confirmed ${r.confirmed} of ${r.total} · Reopened ${r.reopened} · Failed ${r.failed} · Open CQ ${r.openCQ} · Low confidence ${r.lowConfidence} · Waiting proposals ${r.waitingProposals}`],
  ];
  sheetNames.push(safeSheetName('Overview', used));
  sheetRowSets.push(overviewRows);

  sheetNames.push(safeSheetName('Project information', used));
  sheetRowSets.push([PROJECT_INFO_HEADER, ...(model.projectInfo || []).map(row => [row.label, row.value ?? '', row.source ?? ''])]);

  // The three scope tabs are always present, even with no items (header row only) — a client
  // reading the workbook sees the tool's full tab set, not just the tabs it happened to use.
  for (const tab of TABS) {
    const tabItems = items.filter(it => it.tab === tab);
    sheetNames.push(safeSheetName(tab, used));
    const rows = [REQ_HEADER];
    for (const it of tabItems) {
      const a = answerCells(it);
      rows.push([it.id, it.topic || '', it.requirement, a.coverage, a.effort, a.response, a.assumptions]);
    }
    sheetRowSets.push(rows);
  }

  // §6 Integrations, §7 Glossary: transcriptions of the client's own document.
  const s6 = (model.blocks || []).find(b => b.n === 6);
  sheetNames.push(safeSheetName('Integrations', used));
  sheetRowSets.push(sectionToRows(s6?.raw));

  const s7 = (model.blocks || []).find(b => b.n === 7);
  sheetNames.push(safeSheetName('Glossary', used));
  sheetRowSets.push(sectionToRows(s7?.raw));

  return assembleWorkbook(sheetNames, sheetRowSets);
}

/** The zip container: workbook.xml, its rels, styles, content types and one part per sheet. */
function assembleWorkbook(sheetNames, sheetRowSets) {
  const sheetParts = sheetNames.map((_, i) => `worksheets/sheet${i + 1}.xml`);
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetParts.map((p, i) => `<Override PartName="/xl/${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbSheets = sheetNames.map((name, i) => `<sheet name="${escXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><calcPr fullCalcOnLoad="1"/><sheets>${wbSheets}</sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetParts.map((p, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${p}"/>`).join('')}</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`;

  const files = [
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: wbRels },
    { name: 'xl/styles.xml', content: styles },
    ...sheetParts.map((p, i) => ({ name: `xl/${p}`, content: sheetXml(sheetRowSets[i]) })),
  ];
  return buildZip(files);
}
