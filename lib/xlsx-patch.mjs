// Writes answers back into a COPY of the client's own workbook, zero dependencies.
//
// The rule that keeps Excel from asking to repair the file: every zip entry except the sheets we
// actually touch is copied with its original compressed bytes, CRC and method — not re-compressed
// — so styles, themes, dropdowns, charts and untouched sheets are bit-for-bit the client's own.
// The touched sheet XML is edited textually, keeping each cell's style attribute.
//
// Values are written as inline strings (`t="inlineStr"`), which means `sharedStrings.xml` is never
// touched and its count fields can never go stale.
import zlib from 'node:zlib';
import { openZip, parseRef, colToNumber, decodeXml } from './xlsx.mjs';

const escXml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\r/g, '');

// ---------------------------------------------------------------- sheet xml editing

/** Locates `<row r="N" …>…</row>`; returns its span and inner range, or null. */
function findRow(xml, n) {
  const re = new RegExp(`<(?:\\w+:)?row[^>]*\\sr="${n}"[^>]*>`, '');
  const m = re.exec(xml);
  if (!m) return null;
  const openEnd = m.index + m[0].length;
  // `[^>]*` swallows a trailing slash, so self-closing is decided on the matched text, never on
  // a capture group — otherwise `<row r="3"/>` looks open and the span runs into the next row.
  if (m[0].endsWith('/>')) return { start: m.index, end: openEnd, innerStart: openEnd, innerEnd: openEnd, selfClosing: true };
  const closeRe = /<\/(?:\w+:)?row>/g;
  closeRe.lastIndex = openEnd;
  const close = closeRe.exec(xml);
  if (!close) return null;
  return { start: m.index, end: close.index + close[0].length, innerStart: openEnd, innerEnd: close.index, selfClosing: false };
}

/** Locates `<c r="REF" …>…</c>` inside a span; returns its span and attributes, or null. */
function findCell(xml, ref, from, to) {
  const re = new RegExp(`<(?:\\w+:)?c[^>]*\\sr="${ref}"[^>]*>`, 'g');
  re.lastIndex = from;
  const m = re.exec(xml);
  if (!m || m.index >= to) return null;
  const openEnd = m.index + m[0].length;
  const attrs = {};
  for (const a of m[0].matchAll(/([A-Za-z_:][-.\w:]*)\s*=\s*"([^"]*)"/g)) attrs[a[1].replace(/^\w+:/, '')] = decodeXml(a[2]);
  // Same trap as findRow: `<c r="E2" s="9"/>` must not be read as an open tag, or the
  // replacement would swallow everything up to the next cell's closing tag.
  if (m[0].endsWith('/>')) return { start: m.index, end: openEnd, attrs, selfClosing: true };
  const closeRe = /<\/(?:\w+:)?c>/g;
  closeRe.lastIndex = openEnd;
  const close = closeRe.exec(xml);
  if (!close) return null;
  return { start: m.index, end: close.index + close[0].length, attrs, selfClosing: false, inner: xml.slice(openEnd, close.index) };
}

/** The cell element for one value; `styleId` keeps the client's formatting. */
function cellXml(ref, value, styleId, prefix = '') {
  const p = prefix ? `${prefix}:` : '';
  const s = styleId == null || styleId === '' ? '' : ` s="${styleId}"`;
  if (value === '' || value == null) return `<${p}c r="${ref}"${s}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<${p}c r="${ref}"${s}><${p}v>${value}</${p}v></${p}c>`;
  return `<${p}c r="${ref}"${s} t="inlineStr"><${p}is><${p}t xml:space="preserve">${escXml(value)}</${p}t></${p}is></${p}c>`;
}

/** The element prefix this sheet uses (`x:` for .NET-generated files, empty for Excel's). */
function prefixOf(xml) {
  const m = /<(\w+):worksheet[\s>]/.exec(xml);
  return m ? m[1] : '';
}

/**
 * Applies `[{ref, value}]` to one sheet's XML.
 * A cell that exists is replaced in place, keeping its `s` attribute; a missing cell is inserted
 * in column order; a missing row is inserted in row order. A formula cell loses its `<f>` — the
 * value we write is final — and its reference is reported so calcChain can drop it.
 */
export function applyCellEdits(xml, edits) {
  let out = xml;
  const prefix = prefixOf(xml);
  const p = prefix ? `${prefix}:` : '';
  const droppedFormulas = [];

  // Highest row/column first: every edit then lands behind the offsets we already changed.
  const ordered = [...edits].sort((a, b) => {
    const A = parseRef(a.ref);
    const B = parseRef(b.ref);
    return B.row - A.row || B.col - A.col;
  });

  for (const edit of ordered) {
    const at = parseRef(edit.ref);
    if (!at) continue;
    let row = findRow(out, at.row);

    if (!row) {
      // Insert the row before the first existing row with a higher number, else at the end.
      const rowRe = /<(?:\w+:)?row[^>]*\sr="(\d+)"[^>]*>/g;
      let insertAt = -1;
      let m;
      while ((m = rowRe.exec(out))) { if (Number(m[1]) > at.row) { insertAt = m.index; break; } }
      if (insertAt < 0) {
        const close = out.search(/<\/(?:\w+:)?sheetData>/);
        insertAt = close < 0 ? -1 : close;
      }
      if (insertAt < 0) continue;      // no sheetData: nothing sensible to do
      const rowXml = `<${p}row r="${at.row}">${cellXml(edit.ref, edit.value, edit.styleId, prefix)}</${p}row>`;
      out = out.slice(0, insertAt) + rowXml + out.slice(insertAt);
      continue;
    }

    if (row.selfClosing) {
      // `<row r="7"/>` → give it a body before inserting the cell.
      const opened = out.slice(row.start, row.end).replace(/\/>$/, '>');
      out = out.slice(0, row.start) + opened + `</${p}row>` + out.slice(row.end);
      row = findRow(out, at.row);
    }

    const existing = findCell(out, edit.ref, row.innerStart, row.innerEnd);
    if (existing) {
      const styleId = edit.styleId != null ? edit.styleId : existing.attrs.s;
      if (!existing.selfClosing && /<(?:\w+:)?f[\s/>]/.test(existing.inner || '')) droppedFormulas.push(edit.ref);
      out = out.slice(0, existing.start) + cellXml(edit.ref, edit.value, styleId, prefix) + out.slice(existing.end);
      continue;
    }

    // Insert before the first cell of a higher column in this row.
    const cellRe = new RegExp(`<(?:\\w+:)?c[^>]*\\sr="([A-Z]+)(${at.row})"[^>]*(?:/>|>)`, 'g');
    cellRe.lastIndex = row.innerStart;
    let insertAt = row.innerEnd;
    let m;
    while ((m = cellRe.exec(out)) && m.index < row.innerEnd) {
      if (colToNumber(m[1]) > at.col) { insertAt = m.index; break; }
    }
    out = out.slice(0, insertAt) + cellXml(edit.ref, edit.value, edit.styleId, prefix) + out.slice(insertAt);
  }

  return { xml: out, droppedFormulas };
}

/** Removes the `<c r="…"/>` entries of overwritten formula cells; returns null when it empties. */
export function pruneCalcChain(xml, refs) {
  if (!xml || !refs.length) return xml;
  let out = xml;
  for (const ref of refs) {
    out = out.replace(new RegExp(`<(?:\\w+:)?c[^>]*\\sr="${ref}"[^>]*/>`, 'g'), '');
    out = out.replace(new RegExp(`<(?:\\w+:)?c[^>]*\\sr="${ref}"[^>]*>[\\s\\S]*?</(?:\\w+:)?c>`, 'g'), '');
  }
  return /<(?:\w+:)?c[\s/]/.test(out) ? out : null;
}

// ---------------------------------------------------------------- zip rebuild

/** Deflates a replacement part; everything else is copied compressed, exactly as it was. */
function deflate(text) {
  const data = Buffer.from(text, 'utf8');
  return { data, compressed: zlib.deflateRawSync(data, { level: 6 }), method: 8, crc: zlib.crc32(data) };
}

/**
 * Rebuilds the container. `replacements` is `{partName: string|null}` — a string replaces that
 * part, `null` drops it. Every other entry keeps its original compressed bytes, CRC, method and
 * order, so the output differs from the input only where we meant it to.
 */
export function rebuildZip(srcBuffer, replacements = {}) {
  const zip = openZip(srcBuffer);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const name of zip.names()) {
    if (Object.prototype.hasOwnProperty.call(replacements, name) && replacements[name] === null) continue;
    const src = zip.entry(name);
    const nameBuf = Buffer.from(name, 'utf8');
    let method = src.method;
    let crc = src.crc32;
    let compressed = zip.raw(name);
    let usize = src.usize;

    if (Object.prototype.hasOwnProperty.call(replacements, name)) {
      const made = deflate(replacements[name]);
      method = made.method; crc = made.crc; compressed = made.compressed; usize = made.data.length;
    }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    chunks.push(lh, nameBuf, compressed);
    central.push({ nameBuf, method, crc, csize: compressed.length, usize, offset });
    offset += 30 + nameBuf.length + compressed.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(e.csize, 20);
    ch.writeUInt32LE(e.usize, 24);
    ch.writeUInt16LE(e.nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(e.offset, 42);
    chunks.push(ch, e.nameBuf);
    offset += 46 + e.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/**
 * Writes `edits` into a copy of `srcBuffer` and returns the new workbook.
 * Each edit is `{part, ref, value, styleId?}` — `part` being the sheet's zip entry name, which
 * `readWorkbook` reports per sheet.
 */
/**
 * Tells Excel to recalculate every formula on open (X-4/W5) instead of trusting cached values
 * that a surgical edit may have made stale. A no-op, byte-for-byte, when it is already set.
 */
export function withFullCalcOnLoad(buffer) {
  const zip = openZip(buffer);
  const xml = zip.text('xl/workbook.xml');
  if (!xml) return buffer;
  if (/<calcPr\b[^>]*\bfullCalcOnLoad="1"/.test(xml)) return buffer;
  let next;
  if (/<calcPr\b/.test(xml)) next = xml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1" ');
  else if (xml.includes('</sheets>')) next = xml.replace('</sheets>', '</sheets><calcPr fullCalcOnLoad="1"/>');
  else next = xml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  return rebuildZip(buffer, { 'xl/workbook.xml': next });
}

export function patchWorkbook(srcBuffer, edits) {
  const zip = openZip(srcBuffer);
  const byPart = new Map();
  for (const e of edits) {
    if (!byPart.has(e.part)) byPart.set(e.part, []);
    byPart.get(e.part).push(e);
  }

  const replacements = {};
  const dropped = [];
  for (const [part, list] of byPart) {
    const xml = zip.text(part);
    if (xml == null) throw new Error(`cannot patch ${part}: not in the workbook`);
    const { xml: next, droppedFormulas } = applyCellEdits(xml, list);
    replacements[part] = next;
    dropped.push(...droppedFormulas);
  }

  if (dropped.length && zip.has('xl/calcChain.xml')) {
    const pruned = pruneCalcChain(zip.text('xl/calcChain.xml'), dropped);
    if (pruned === null) {
      // An empty calcChain part makes Excel prompt for repair; drop the part and its references.
      replacements['xl/calcChain.xml'] = null;
      const types = zip.text('[Content_Types].xml');
      if (types) replacements['[Content_Types].xml'] = types.replace(/<Override[^>]*calcChain\.xml[^>]*\/>/g, '');
      const rels = zip.text('xl/_rels/workbook.xml.rels');
      if (rels) replacements['xl/_rels/workbook.xml.rels'] = rels.replace(/<Relationship[^>]*calcChain\.xml[^>]*\/>/g, '');
    } else {
      replacements['xl/calcChain.xml'] = pruned;
    }
  }

  return rebuildZip(srcBuffer, replacements);
}
