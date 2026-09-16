// Zero-dependency xlsx reader: ZIP container + SpreadsheetML, Node stdlib only (`node:zlib`).
// Replaces the former `sw-discover-tender/scripts/xlsx-to-csv.py` (python3 + openpyxl), which
// breaks the packaging rules "no executables in the plugin" and "zero runtime dependencies".
// Read-only: nothing here ever writes a file. Writing back is `lib/xlsx-patch.mjs`.
//
// What it keeps that a CSV export loses: hidden sheets/rows/columns, merged ranges and the
// data-validation dropdown lists that carry the client's allowed compliance tokens.
import fs from 'node:fs';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- zip

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;

/** Thrown for every input we refuse; `code` lets callers branch without matching on prose. */
export class XlsxError extends Error {
  constructor(code, message) { super(message); this.name = 'XlsxError'; this.code = code; }
}

/** Scans backwards for the end-of-central-directory record (it sits behind a variable comment). */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

/**
 * Reads the central directory into `{name -> entry}`. The central directory is the authority:
 * a local header may carry zeroed sizes and a trailing data descriptor instead.
 * ZIP64 is followed when the 32-bit count/offset fields are saturated.
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new XlsxError('not-zip', 'not a zip container (no end-of-central-directory record)');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locOff = eocd - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === EOCD64_LOC_SIG) {
      const eocd64 = Number(buf.readBigUInt64LE(locOff + 8));
      if (buf.readUInt32LE(eocd64) !== EOCD64_SIG) throw new XlsxError('bad-zip', 'zip64 end-of-central-directory record not found');
      count = Number(buf.readBigUInt64LE(eocd64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new XlsxError('bad-zip', `corrupt central directory at entry ${i + 1}`);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // ZIP64 extra field (0x0001): present values replace the saturated 32-bit ones, in this order.
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const size = buf.readUInt16LE(e + 2);
        let q = e + 4;
        if (id === 0x0001) {
          if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + size;
      }
    }

    entries.set(name, { name, method, crc32, csize, usize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The raw (still compressed) bytes of one entry, located through its local header. */
function rawBytes(buf, entry) {
  const lho = entry.localOffset;
  const nameLen = buf.readUInt16LE(lho + 26);
  const extraLen = buf.readUInt16LE(lho + 28);
  const start = lho + 30 + nameLen + extraLen;
  return buf.subarray(start, start + entry.csize);
}

function inflate(buf, entry) {
  const raw = rawBytes(buf, entry);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new XlsxError('bad-zip', `unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/**
 * Opens the container and exposes its entries. Used by the reader and, for byte-identical
 * copying, by `lib/xlsx-patch.mjs`.
 */
export function openZip(buffer) {
  const entries = readCentralDirectory(buffer);
  return {
    buffer,
    entries,
    has: name => entries.has(name),
    names: () => [...entries.keys()],
    raw: name => { const e = entries.get(name); return e ? rawBytes(buffer, e) : null; },
    entry: name => entries.get(name) || null,
    text: name => {
      const e = entries.get(name);
      if (!e) return null;
      return inflate(buffer, e).toString('utf8').replace(/^﻿/, '');
    },
  };
}

// ---------------------------------------------------------------- xml

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the five XML entities plus numeric references; leaves anything else untouched. */
export function decodeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ref] ?? m;
  });
}

/** `x:worksheet` → `worksheet`: generators (notably .NET) prefix every element and attribute. */
const localName = n => { const i = n.indexOf(':'); return i < 0 ? n : n.slice(i + 1); };

/** Attributes into a plain object, keyed by local name, order-independent. */
function parseAttrs(src) {
  const out = {};
  const re = /([A-Za-z_:][-.\w:]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) out[localName(m[1])] = decodeXml(m[3] ?? m[4] ?? '');
  return out;
}

/**
 * Minimal pull parser: calls `on.open(name, attrs, selfClosing)`, `on.text(str)` and
 * `on.close(name)` in document order. No DOM, no dependency; comments, CDATA, the XML
 * declaration, doctypes and processing instructions are skipped.
 */
export function scanXml(xml, on) {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { if (on.text) on.text(xml.slice(i)); break; }
    if (lt > i && on.text) on.text(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt);
      const end = e < 0 ? n : e;
      if (on.text) on.text(xml.slice(lt + 9, end));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) { const e = xml.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }

    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const inner = xml.slice(lt + 1, gt);
    if (inner[0] === '/') {
      if (on.close) on.close(localName(inner.slice(1).trim()));
    } else {
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const sp = body.search(/[\s]/);
      const name = localName(sp < 0 ? body : body.slice(0, sp));
      const attrs = sp < 0 ? {} : parseAttrs(body.slice(sp));
      if (on.open) on.open(name, attrs, selfClosing);
      if (selfClosing && on.close) on.close(name);
    }
    i = gt + 1;
  }
}

// ---------------------------------------------------------------- cell references

/** `"C"` → 3 (1-based, as in the A1 grammar). */
export function colToNumber(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

/** 3 → `"C"`. */
export function numberToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
  return s;
}

/** `"C12"` → `{col: 3, row: 12}`; a malformed reference returns null. */
export function parseRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref || '').trim());
  if (!m) return null;
  return { col: colToNumber(m[1].toUpperCase()), row: Number(m[2]) };
}

/** `"A1:C3"` (or `"A1 C3:D9"`) → the list of rectangles it names. */
export function parseRange(sqref) {
  const out = [];
  for (const part of String(sqref || '').trim().split(/\s+/)) {
    if (!part) continue;
    const [a, b] = part.split(':');
    const from = parseRef(a);
    const to = b ? parseRef(b) : from;
    if (from && to) {
      out.push({
        c1: Math.min(from.col, to.col), c2: Math.max(from.col, to.col),
        r1: Math.min(from.row, to.row), r2: Math.max(from.row, to.row),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- dates and numbers

// Built-in numFmt ids that are dates or times (ECMA-376 §18.8.30).
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** A custom format code is a date format when a date/time token survives outside its literals. */
export function isDateFormatCode(code) {
  if (!code) return false;
  const stripped = String(code)
    .replace(/\[[^\]]*\]/g, '')          // [Red], [h], locale ids
    .replace(/"[^"]*"/g, '')             // quoted literals
    .replace(/\\./g, '');                // escaped characters
  return /[yYmMdDhHsS]/.test(stripped) && !/^[^yYdDhHsS]*$/.test(stripped);
}

/**
 * Excel serial → ISO string. The 1900 system deliberately contains a non-existent
 * 1900-02-29 (serial 60) for Lotus compatibility, so every serial above it is one day late.
 */
export function serialToIso(serial, { epoch1904 = false } = {}) {
  if (!Number.isFinite(serial)) return String(serial);
  let days = Math.floor(serial);
  const frac = serial - days;
  let base;
  if (epoch1904) {
    base = Date.UTC(1904, 0, 1);
  } else {
    base = Date.UTC(1899, 11, 31);
    if (days > 59) days -= 1;     // skip the phantom 1900-02-29
  }
  const ms = base + days * 86400000 + Math.round(frac * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return Math.abs(frac) < 1e-9 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

/** Numbers keep full precision but lose the float tail: 3.0 prints as `3`, not `3.0000000001`. */
function numberToText(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(15)));
}

// ---------------------------------------------------------------- workbook parts

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  let cur = null;
  let take = false;
  scanXml(xml, {
    open(name) {
      if (name === 'si') cur = [];
      else if (name === 't') take = true;
      else if (name === 'rPh') take = false;   // phonetic hints are not content
    },
    text(t) { if (take && cur) cur.push(decodeXml(t)); },
    close(name) {
      if (name === 't') take = false;
      else if (name === 'si') { out.push((cur || []).join('')); cur = null; }
    },
  });
  return out;
}

/** styleId → numFmtId, plus the custom format codes, so a date cell can be recognised. */
function parseStyles(xml) {
  const numFmts = new Map();
  const cellXfs = [];
  if (!xml) return { numFmts, cellXfs };
  let inCellXfs = false;
  scanXml(xml, {
    open(name, a) {
      if (name === 'numFmt') numFmts.set(Number(a.numFmtId), a.formatCode || '');
      else if (name === 'cellXfs') inCellXfs = true;
      else if (name === 'xf' && inCellXfs) cellXfs.push(Number(a.numFmtId || 0));
    },
    close(name) { if (name === 'cellXfs') inCellXfs = false; },
  });
  return { numFmts, cellXfs };
}

/** Sheet order, names, visibility and the r:id that resolves to the part path. */
function parseWorkbook(xml) {
  const sheets = [];
  let epoch1904 = false;
  scanXml(xml, {
    open(name, a) {
      if (name === 'sheet') {
        sheets.push({
          name: a.name || '',
          sheetId: a.sheetId ? Number(a.sheetId) : null,
          rid: a.id || a['r:id'] || null,
          state: a.state || 'visible',
        });
      } else if (name === 'workbookPr') {
        epoch1904 = a.date1904 === '1' || a.date1904 === 'true';
      }
    },
  });
  return { sheets, epoch1904 };
}

/** rId → part path. Targets may be absolute (`/xl/worksheets/sheet1.xml`) or relative. */
function parseRels(xml) {
  const map = new Map();
  if (!xml) return map;
  scanXml(xml, {
    open(name, a) {
      if (name !== 'Relationship') return;
      let target = a.Target || '';
      if (target.startsWith('/')) target = target.slice(1);
      else if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\.\//, '');
      map.set(a.Id, target);
    },
  });
  return map;
}

/**
 * One worksheet: cells with their resolved values, hidden rows/columns, merges and the
 * data-validation lists. `<v>` of a formula cell is its cached value — formulas are never
 * evaluated, which is what the python script's `data_only=True` did.
 */
function parseSheet(xml, ctx) {
  const rows = new Map();
  const cols = [];
  const merges = [];
  const validations = [];

  let row = null;
  let cell = null;
  let buf = [];
  let inV = false;
  let inT = false;
  let inFormula = false;
  let dvOpen = null;
  let inF1 = false;
  let f1 = [];
  let dimension = null;

  const flushCell = () => {
    if (!cell) return;
    const text = buf.join('');
    const type = cell.t || 'n';
    let value = '';
    if (type === 's') {
      const idx = Number(text);
      value = Number.isInteger(idx) ? (ctx.sharedStrings[idx] ?? '') : '';
    } else if (type === 'inlineStr' || type === 'str') {
      value = text;
    } else if (type === 'b') {
      value = text === '1' ? 'TRUE' : 'FALSE';
    } else if (type === 'e') {
      value = text;
    } else if (text !== '') {
      const num = Number(text);
      if (Number.isFinite(num) && ctx.isDateStyle(cell.s)) value = serialToIso(num, { epoch1904: ctx.epoch1904 });
      else value = Number.isFinite(num) ? numberToText(num) : text;
    }
    if (value !== '' || cell.s != null) {
      const at = parseRef(cell.r);
      if (at) {
        const r = rows.get(at.row) || { r: at.row, hidden: false, cells: [] };
        r.cells.push({ ref: cell.r, col: at.col, row: at.row, type, value, raw: text, styleId: cell.s == null ? null : Number(cell.s) });
        rows.set(at.row, r);
      }
    }
    cell = null;
    buf = [];
  };

  scanXml(xml, {
    open(name, a, selfClosing) {
      switch (name) {
        case 'dimension': dimension = a.ref || null; break;
        case 'col':
          cols.push({ min: Number(a.min || 0), max: Number(a.max || 0), hidden: a.hidden === '1' || a.hidden === 'true' });
          break;
        case 'row': {
          const r = Number(a.r || 0);
          const existing = rows.get(r) || { r, hidden: false, cells: [] };
          existing.hidden = a.hidden === '1' || a.hidden === 'true';
          rows.set(r, existing);
          row = existing;
          break;
        }
        case 'c':
          flushCell();
          cell = { r: a.r || (row ? `A${row.r}` : 'A1'), t: a.t || null, s: a.s ?? null };
          buf = [];
          break;
        case 'v': inV = true; break;
        case 'f': inFormula = true; break;
        case 't': if (!inFormula) inT = true; break;
        case 'mergeCell': if (a.ref) merges.push(a.ref); break;
        case 'dataValidation':
          dvOpen = { sqref: a.sqref || '', type: a.type || '', values: [] };
          f1 = [];
          if (selfClosing) { validations.push(dvOpen); dvOpen = null; }
          break;
        case 'formula1': inF1 = true; f1 = []; break;
        default: break;
      }
    },
    text(t) {
      if (inV || inT) buf.push(decodeXml(t));
      else if (inF1) f1.push(decodeXml(t));
    },
    close(name) {
      switch (name) {
        case 'v': inV = false; break;
        case 'f': inFormula = false; break;
        case 't': inT = false; break;
        case 'c': flushCell(); break;
        case 'row': flushCell(); row = null; break;
        case 'formula1': {
          inF1 = false;
          if (dvOpen) {
            const text = f1.join('').trim();
            // An inline list is a quoted, comma-separated literal; a range reference
            // (`$Z$1:$Z$9`) points elsewhere and is kept verbatim for the steering screen.
            if (/^".*"$/.test(text)) dvOpen.values = text.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
            else if (text) dvOpen.ref = text;
          }
          break;
        }
        case 'dataValidation':
          if (dvOpen) { validations.push(dvOpen); dvOpen = null; }
          break;
        default: break;
      }
    },
  });
  flushCell();

  return {
    dimension,
    cols,
    merges,
    validations,
    rows: [...rows.values()].sort((a, b) => a.r - b.r).map(r => ({ ...r, cells: r.cells.sort((a, b) => a.col - b.col) })),
  };
}

// ---------------------------------------------------------------- public API

/** Refuses formats we cannot read, naming the file and what to do about it. */
function assertReadable(buf, label) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    throw new XlsxError('ole', `${label}: this is an OLE/CFB file — a legacy .xls, or a password-protected workbook. Open it and re-save as .xlsx (unprotected).`);
  }
  if (buf.length < 4 || buf.readUInt16LE(0) !== 0x4b50) {
    throw new XlsxError('not-zip', `${label}: not an .xlsx file (no zip container).`);
  }
}

/**
 * Reads a workbook into plain data.
 *
 * @param {Buffer|string} input buffer or path
 * @returns {{sheets: Array, epoch1904: boolean, parts: string[]}}
 */
export function readWorkbook(input, { label = null } = {}) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const name = label || (typeof input === 'string' ? input : 'workbook');
  assertReadable(buf, name);

  const zip = openZip(buf);
  if (zip.has('EncryptedPackage')) {
    throw new XlsxError('encrypted', `${name}: the workbook is password-protected. Remove the protection and re-save it.`);
  }
  if (zip.has('xl/workbook.bin')) {
    throw new XlsxError('xlsb', `${name}: this is a binary workbook (.xlsb). Re-save it as .xlsx.`);
  }
  const workbookXml = zip.text('xl/workbook.xml');
  if (!workbookXml) {
    throw new XlsxError('no-workbook', `${name}: no xl/workbook.xml inside — not a spreadsheet.`);
  }

  const { sheets: sheetRefs, epoch1904 } = parseWorkbook(workbookXml);
  const rels = parseRels(zip.text('xl/_rels/workbook.xml.rels'));
  const sharedStrings = parseSharedStrings(zip.text('xl/sharedStrings.xml'));
  const { numFmts, cellXfs } = parseStyles(zip.text('xl/styles.xml'));

  const isDateStyle = styleId => {
    if (styleId == null) return false;
    const fmtId = cellXfs[Number(styleId)];
    if (fmtId == null) return false;
    if (DATE_FMT_IDS.has(fmtId)) return true;
    return isDateFormatCode(numFmts.get(fmtId));
  };

  const ctx = { sharedStrings, epoch1904, isDateStyle };
  const sheets = sheetRefs.map((ref, i) => {
    // Some generators omit the relationship; the conventional sheetN.xml path is the fallback.
    const part = (ref.rid && rels.get(ref.rid)) || `xl/worksheets/sheet${i + 1}.xml`;
    const xml = zip.text(part);
    const parsed = xml ? parseSheet(xml, ctx) : { dimension: null, cols: [], merges: [], validations: [], rows: [] };
    return { index: i + 1, name: ref.name, state: ref.state, part, ...parsed };
  });

  return { sheets, epoch1904, parts: zip.names() };
}

/**
 * One sheet as a dense string grid — the shape the steering screen renders and the CSV
 * writer emits. Trailing empty rows and columns are trimmed; `hiddenRows`/`hiddenCols`
 * carry 1-based indices so the page can mark them.
 */
export function sheetToGrid(sheet, { maxRows = 5000, maxCols = 200 } = {}) {
  let width = 0;
  let height = 0;
  for (const r of sheet.rows) {
    for (const c of r.cells) if (c.value !== '') { if (c.col > width) width = c.col; if (r.r > height) height = r.r; }
  }
  const truncated = height > maxRows || width > maxCols;
  width = Math.min(width, maxCols);
  height = Math.min(height, maxRows);

  const grid = Array.from({ length: height }, () => Array(width).fill(''));
  for (const r of sheet.rows) {
    if (r.r > height) continue;
    for (const c of r.cells) {
      if (c.col > width) continue;
      grid[r.r - 1][c.col - 1] = c.value;
    }
  }

  const hiddenRows = sheet.rows.filter(r => r.hidden && r.r <= height).map(r => r.r);
  const hiddenCols = [];
  for (const c of sheet.cols) {
    if (!c.hidden) continue;
    for (let n = c.min; n <= Math.min(c.max, width); n++) hiddenCols.push(n);
  }

  return { rows: grid, width, height, truncated, hiddenRows, hiddenCols: [...new Set(hiddenCols)].sort((a, b) => a - b) };
}
