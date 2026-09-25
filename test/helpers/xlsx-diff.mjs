// Automated part-level diff of two xlsx files: which zip entries are byte-identical, which
// changed, and for a changed sheet part, which cell refs actually differ. Used to prove AC-22
// (surgical export touches only the answer cells) without a human opening the file in Excel.
import { openZip } from '../../lib/xlsx.mjs';

/** `{ identical: [name...], changed: [name...] }` over every zip entry in either file. */
export function diffXlsxParts(bufA, bufB) {
  const a = openZip(bufA), b = openZip(bufB);
  const names = new Set([...a.names(), ...b.names()]);
  const identical = [], changed = [];
  for (const name of names) {
    const ra = a.raw(name), rb = b.raw(name);
    if (ra && rb && ra.equals(rb)) identical.push(name);
    else changed.push(name);
  }
  return { identical: identical.sort(), changed: changed.sort() };
}

/** The cell refs whose `<c>` element text differs between two sheet-part XML strings. */
export function diffSheetCells(xmlA, xmlB) {
  const cellsOf = xml => {
    const map = new Map();
    // The trailing `[^>]*` must be lazy: greedy, it swallows the `/` of a self-closing `<c .../>`
    // before the alternation is tried, so the first branch (`\/>`) never gets to match and the
    // second branch matches the bare `>` instead — then lazily runs all the way to the next real
    // `</c>` in the document, folding an unrelated later cell's XML into this one's "text".
    // The trailing `[^>]*` must be lazy: greedy, it swallows the `/` of a self-closing `<c .../>`
    // before the alternation is tried, so the first branch (`\/>`) never gets to match and the
    // second branch matches the bare `>` instead — then lazily runs all the way to the next real
    // `</c>` in the document, folding an unrelated later cell's XML into this one's "text".
    const re = /<(?:\w+:)?c\b[^>]*\br="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?c>)/g;
    let m;
    while ((m = re.exec(xml))) map.set(m[1], m[0]);
    return map;
  };
  const ca = cellsOf(xmlA || ''), cb = cellsOf(xmlB || '');
  const refs = new Set([...ca.keys(), ...cb.keys()]);
  const changed = [];
  for (const ref of refs) if (ca.get(ref) !== cb.get(ref)) changed.push(ref);
  return changed.sort((r1, r2) => r1.localeCompare(r2, undefined, { numeric: true }));
}

/** Convenience: for two whole workbooks, the changed parts plus the changed cells per changed
 * sheet part (parts this helper cannot read as a sheet — styles, workbook.xml, … — are omitted
 * from `cells`, only listed in `changed`). */
export function diffWorkbooks(bufA, bufB) {
  const { identical, changed } = diffXlsxParts(bufA, bufB);
  const a = openZip(bufA), b = openZip(bufB);
  const cells = {};
  for (const name of changed) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    cells[name] = diffSheetCells(a.text(name), b.text(name));
  }
  return { identical, changed, cells };
}
