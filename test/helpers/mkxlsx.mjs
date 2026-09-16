// Builds minimal .xlsx files byte-by-byte for the reader tests — zero dependencies, so the
// fixture corpus needs neither Excel nor LibreOffice (neither is installable on the dev host).
//
// Honesty note: these are OUR renderings of the shapes those generators produce (shared strings,
// `x:` namespace prefixes, 1904 epoch, stored entries, ZIP64 headers). They are faithful to
// ECMA-376 and to the zip format, but they are not files those applications saved. No workbook
// written by Excel or LibreOffice is committed here, so opening a produced response workbook in
// both applications stays a manual check before a release.
import zlib from 'node:zlib';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One zip entry; `store: true` writes it uncompressed (method 0). */
function entryBytes(name, content, { store = false } = {}) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const compressed = store ? data : zlib.deflateRawSync(data, { level: 6 });
  return { name: Buffer.from(name, 'utf8'), data, compressed, method: store ? 0 : 8, crc: zlib.crc32(data) };
}

/**
 * Assembles a zip. `zip64: true` saturates the 32-bit end-of-central-directory fields and
 * writes the ZIP64 records, which is the path a >4 GB or >65535-entry archive takes.
 */
export function buildZip(files, { zip64 = false } = {}) {
  const entries = files.map(f => entryBytes(f.name, f.content, { store: f.store }));
  const chunks = [];
  let offset = 0;
  const locals = [];

  for (const e of entries) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);              // version needed
    h.writeUInt16LE(0, 6);               // flags
    h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(0, 10);              // time
    h.writeUInt16LE(0x21, 12);           // date (1996-01-01, fixed → deterministic output)
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
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
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
  }
  const cdSize = offset - cdStart;

  if (zip64) {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(BigInt(44), 4);          // size of this record - 12
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeUInt32LE(0, 16);
    z64.writeUInt32LE(0, 20);
    z64.writeBigUInt64LE(BigInt(entries.length), 24);
    z64.writeBigUInt64LE(BigInt(entries.length), 32);
    z64.writeBigUInt64LE(BigInt(cdSize), 40);
    z64.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(offset), 8);
    loc.writeUInt32LE(1, 16);
    chunks.push(z64, loc);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdSize, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

/**
 * A workbook from a tiny description.
 *
 * sheets: [{ name, state?, rows: [[value, …]], merges?, validations?, hiddenRows?, hiddenCols?,
 *            styleRow?: n (cells in that row get the date style) }]
 * options: { shared: use sharedStrings instead of inline strings, prefix: emit `x:` namespace
 *            prefixes, epoch1904, store: uncompressed entries, zip64, absoluteRels }
 */
export function buildWorkbook(sheets, opts = {}) {
  const { shared = false, prefix = '', epoch1904 = false, store = false, zip64 = false, absoluteRels = false } = opts;
  const p = prefix ? `${prefix}:` : '';
  const strings = [];
  const stringIndex = new Map();
  const internStr = s => {
    if (!stringIndex.has(s)) { stringIndex.set(s, strings.length); strings.push(s); }
    return stringIndex.get(s);
  };

  const col = n => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };

  const sheetXml = sheet => {
    const rows = [];
    (sheet.rows || []).forEach((cells, ri) => {
      const r = ri + 1;
      const tds = [];
      cells.forEach((value, ci) => {
        if (value === null || value === undefined || value === '') return;
        const ref = `${col(ci + 1)}${r}`;
        const style = sheet.styleRow === r ? ' s="1"' : '';
        if (typeof value === 'number') {
          tds.push(`<${p}c r="${ref}"${style}><${p}v>${value}</${p}v></${p}c>`);
        } else if (shared) {
          tds.push(`<${p}c r="${ref}"${style} t="s"><${p}v>${internStr(String(value))}</${p}v></${p}c>`);
        } else {
          tds.push(`<${p}c r="${ref}"${style} t="inlineStr"><${p}is><${p}t>${esc(value)}</${p}t></${p}is></${p}c>`);
        }
      });
      const hidden = (sheet.hiddenRows || []).includes(r) ? ' hidden="1"' : '';
      rows.push(`<${p}row r="${r}"${hidden}>${tds.join('')}</${p}row>`);
    });
    const cols = (sheet.hiddenCols || []).map(n => `<${p}col min="${n}" max="${n}" hidden="1"/>`).join('');
    const merges = (sheet.merges || []).length
      ? `<${p}mergeCells count="${sheet.merges.length}">${sheet.merges.map(m => `<${p}mergeCell ref="${m}"/>`).join('')}</${p}mergeCells>`
      : '';
    const dvs = (sheet.validations || []).length
      ? `<${p}dataValidations count="${sheet.validations.length}">${sheet.validations.map(v =>
        `<${p}dataValidation sqref="${v.sqref}" type="list"><${p}formula1>"${v.values.join(',')}"</${p}formula1></${p}dataValidation>`).join('')}</${p}dataValidations>`
      : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}worksheet xmlns${prefix ? `:${prefix}` : ''}="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<${p}cols>${cols}</${p}cols>` : ''}<${p}sheetData>${rows.join('')}</${p}sheetData>${merges}${dvs}</${p}worksheet>`;
  };

  const sheetParts = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s), store }));

  const wbSheets = sheets.map((s, i) =>
    `<${p}sheet name="${esc(s.name)}" sheetId="${i + 1}" state="${s.state || 'visible'}" r:id="rId${i + 1}"/>`).join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}workbook xmlns${prefix ? `:${prefix}` : ''}="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${epoch1904 ? `<${p}workbookPr date1904="1"/>` : ''}<${p}sheets>${wbSheets}</${p}sheets></${p}workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${absoluteRels ? '/xl/' : ''}worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;

  // numFmtId 14 is the built-in short date; style index 1 uses it.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}styleSheet xmlns${prefix ? `:${prefix}` : ''}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><${p}cellXfs count="2"><${p}xf numFmtId="0"/><${p}xf numFmtId="14" applyNumberFormat="1"/></${p}cellXfs></${p}styleSheet>`;

  const files = [
    { name: '[Content_Types].xml', content: CONTENT_TYPES, store },
    { name: '_rels/.rels', content: ROOT_RELS, store },
    { name: 'xl/workbook.xml', content: workbook, store },
    { name: 'xl/_rels/workbook.xml.rels', content: rels, store },
    { name: 'xl/styles.xml', content: styles, store },
    ...sheetParts,
  ];
  if (shared) {
    files.push({
      name: 'xl/sharedStrings.xml',
      store,
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}sst xmlns${prefix ? `:${prefix}` : ''}="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<${p}si><${p}t>${esc(s)}</${p}t></${p}si>`).join('')}</${p}sst>`,
    });
  }
  return buildZip(files, { zip64 });
}

/** An OLE/CFB header — what a legacy .xls or an encrypted workbook starts with. */
export function buildOleStub() {
  const b = Buffer.alloc(512);
  b.writeUInt32BE(0xd0cf11e0, 0);
  b.writeUInt32BE(0xa1b11ae1, 4);
  return b;
}

/** A zip that carries the OOXML encryption package instead of readable parts. */
export function buildEncryptedStub() {
  return buildZip([
    { name: 'EncryptionInfo', content: 'x' },
    { name: 'EncryptedPackage', content: 'y' },
  ]);
}
