// Single-line edit primitives on the analysis document plus snapshot / verifyAndRepair.
// Every primitive parses, locates one line and splices it; untouched lines stay byte-identical.
import { parse, findBlock, collect, SUB_ID_RE } from './parse.mjs';

const nl = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

/** Raw split of a table line: cells keep their padding; `\|` and code spans are not split. */
export function splitRaw(line) {
  const lm = /^\s*\|/.exec(line);
  const lead = lm ? lm[0] : '';
  let body = line.slice(lead.length);
  const tm = /(?<!\\)\|\s*$/.exec(body);
  const trail = tm ? tm[0] : '';
  body = body.slice(0, body.length - trail.length);
  const cells = [];
  let cur = '', inCode = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && body[i + 1] === '|') { cur += ch + '|'; i++; continue; }
    if (ch === '|' && !inCode) { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return { lead, cells, trail };
}

export function joinRaw({ lead, cells, trail }) {
  return lead + cells.join('|') + trail;
}

/** Replace cell `idx`, keeping its padding; `|` in the value is escaped. */
export function setCell(line, idx, value) {
  const parts = splitRaw(line);
  while (parts.cells.length <= idx) parts.cells.push(' ');
  const cell = parts.cells[idx];
  const v = String(value ?? '').replace(/\|/g, '\\|');
  const blank = cell.trim() === '';
  const lead = blank ? ' ' : /^\s*/.exec(cell)[0];
  const trail = blank ? ' ' : /\s*$/.exec(cell)[0];
  parts.cells[idx] = v === '' ? (blank ? cell : ' ') : lead + v + trail;
  return joinRaw(parts);
}

function statusIdx(model, b) {
  const t = findBlock(model, b.tableId);
  return t ? t.colIndex.status ?? -1 : -1;
}

function isAssumeLine(b) {
  return !!b && (b.kind === 'assume' || (b.kind === 'global' && b.gkind === 'assume'));
}

/** `value`: ' ' | 'x' | '-'. Frozen lines (`accepted|rejected`) are never touched. */
export function tick(text, id, value, opts = {}) {
  if (![' ', 'x', '-'].includes(value)) return { text, changed: false, id, reason: 'invalid value' };
  const model = parse(text, opts);
  const b = findBlock(model, id);
  if (!b) return { text, changed: false, id, reason: 'not found' };
  if (!isAssumeLine(b)) return { text, changed: false, id, reason: 'not an assumption' };
  if (b.status.state === 'accepted' || b.status.state === 'rejected') return { text, changed: false, id, reason: 'frozen' };
  const idx = statusIdx(model, b);
  if (idx < 0) return { text, changed: false, id, reason: 'no status column' };
  const lines = nl(text);
  const before = lines[b.line - 1];
  lines[b.line - 1] = setCell(before, idx, `[${value}]` + (b.status.suspect ? ' suspect' : ''));
  return { text: lines.join('\n'), changed: lines[b.line - 1] !== before, id, line: b.line };
}

const setBox = (line, on) => line.replace(/^(\s*-\s+\[)( |x|X)(\])/, (_, a, __, c) => a + (on ? 'x' : ' ') + c);

/** Single-select answer: one option letter, or free text in Other, or clear both. */
export function answer(text, qid, { option = null, other = null } = {}, opts = {}) {
  const model = parse(text, opts);
  const q = findBlock(model, qid);
  if (!q || q.kind !== 'question') return { text, changed: false, id: qid, reason: 'not found' };
  const otherText = other == null ? '' : String(other).trim();
  const letter = otherText ? null : (option == null ? null : String(option).toUpperCase());
  if (letter && !q.options.some(o => o.letter === letter)) return { text, changed: false, id: qid, reason: 'option not found' };
  if (otherText && !q.other) return { text, changed: false, id: qid, reason: 'no Other line' };
  const lines = nl(text);
  const orig = lines.slice();
  for (const o of q.options) lines[o.line - 1] = setBox(lines[o.line - 1], o.letter === letter && letter != null);
  if (q.other) {
    const m = /^(\s*-\s+\[)(?: |x|X)(\]\s+Other:)/.exec(lines[q.other.line - 1]);
    if (m) lines[q.other.line - 1] = m[1] + (otherText ? 'x' : ' ') + m[2] + (otherText ? ' ' + otherText.replace(/\s*\n\s*/g, ' ') : '');
  }
  const changed = lines.some((l, i) => l !== orig[i]);
  return { text: lines.join('\n'), changed, id: qid, line: q.line };
}

const cleanText = s => String(s ?? '').trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
const fmtPd = n => String(Math.abs(Number(n)));
const renderRow = cells => '|' + cells.map(c => (c ? ` ${c} ` : ' ')).join('|') + '|';

/**
 * New line: under a req (`<ROW>.a<n>`, assume only) or in the §3 global table
 * (`A-<n>` assume, `X-<n>` exclude). `kind: 'exclude'` is global-only and not tickable.
 */
export function propose(text, { row = null, statement, pdSaved = null, cls = null, riskTo = 'client', rows = null, kind = 'assume' } = {}, opts = {}) {
  if (!['assume', 'exclude'].includes(kind)) return { text, changed: false, reason: 'invalid kind' };
  const st = cleanText(statement);
  if (!st) return { text, changed: false, reason: 'empty statement' };
  const model = parse(text, opts);
  const lines = nl(text);
  const pd = pdSaved == null || pdSaved === '' || Number.isNaN(Number(pdSaved)) ? null : fmtPd(pdSaved);
  const fill = (table, values) => {
    const cells = table.header.map(() => '');
    for (const [key, v] of Object.entries(values)) if (table.colIndex[key] != null) cells[table.colIndex[key]] = v;
    return renderRow(cells);
  };
  if (kind === 'exclude') {
    if (row) return { text, changed: false, reason: 'exclude must be global' };
    const table = collect(model.blocks).find(b => b.kind === 'table' && b.tableKind === 'global');
    if (!table) return { text, changed: false, reason: 'global table not found' };
    const n = Math.max(0, ...table.children.map(r => (/^X-(\d+)$/.exec(r.id) || [])[1]).filter(Boolean).map(Number)) + 1;
    const id = `X-${n}`;
    const named = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const line = fill(table, { id, kind: 'exclude', rows: named.length ? named.join(', ') : 'global', statement: st, status: 'rfp' });
    lines.splice(table.endLine, 0, line);
    return { text: lines.join('\n'), changed: true, id, line: table.endLine + 1 };
  }
  if (row) {
    const req = findBlock(model, row);
    if (!req || req.kind !== 'req') return { text, changed: false, reason: 'row not found' };
    const table = findBlock(model, req.tableId);
    const n = Math.max(0, ...req.children.filter(c => c.kind === 'assume' && c.n != null).map(c => c.n)) + 1;
    const id = `${row}.a${n}`;
    const line = fill(table, { id, kind: 'assume', pd: pd == null ? '' : `−${pd}`, class: cls || '', text: st, 'evidence / risk': `risk to ${riskTo || 'client'}; partner`, status: '[ ]' });
    lines.splice(req.endLine, 0, line);
    return { text: lines.join('\n'), changed: true, id, line: req.endLine + 1 };
  }
  const table = collect(model.blocks).find(b => b.kind === 'table' && b.tableKind === 'global');
  if (!table) return { text, changed: false, reason: 'global table not found' };
  const n = Math.max(0, ...table.children.map(r => (/^A-(\d+)$/.exec(r.id) || [])[1]).filter(Boolean).map(Number)) + 1;
  const id = `A-${n}`;
  const named = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const pdCell = pd == null ? '' : named.length === 1 ? `${named[0]} −${pd}` : pd;
  const line = fill(table, { id, kind: 'assume', rows: named.length ? named.join(', ') : 'global', statement: st, 'pd saved': pdCell, 'risk to': `${riskTo || 'client'} (partner)`, status: '[ ]' });
  lines.splice(table.endLine, 0, line);
  return { text: lines.join('\n'), changed: true, id, line: table.endLine + 1 };
}

// ---------------------------------------------------------------------------

export function snapshot(text, { proposed = [] } = {}, opts = {}) {
  const model = parse(text, opts);
  const all = collect(model.blocks);
  const snap = { frontmatter: model.frontmatter ? model.frontmatter.raw : null, hashes: {}, frozen: {}, ticks: {}, answers: {}, pageProposed: {}, sections: model.blocks.filter(s => s.n != null).map(s => s.n) };
  for (const b of all) {
    snap.hashes[b.id] = b.hash;
    if (isAssumeLine(b)) {
      if (b.status.state === 'accepted' || b.status.state === 'rejected') snap.frozen[b.id] = b.status.raw;
      else if (b.status.state === 'ticked-accept') snap.ticks[b.id] = 'x';
      else if (b.status.state === 'ticked-reject') snap.ticks[b.id] = '-';
    }
    if (b.kind === 'question') {
      const opt = b.options.find(o => o.checked);
      if (opt || (b.other && b.other.checked)) snap.answers[b.id] = { option: opt ? opt.letter : null, other: b.other && b.other.checked ? b.other.text : null };
    }
  }
  for (const id of proposed) { const b = findBlock(model, id); if (b && b.raw) snap.pageProposed[id] = b.raw; }
  return snap;
}

/** Undo what a run must not do (see plan table). Each step re-parses `out` before acting. */
export function verifyAndRepair(text, snap, opts = {}) {
  const repairs = [], warnings = [];
  let out = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!snap) return { text: out, repairs, warnings };

  if (snap.frontmatter && !parse(out, opts).frontmatter) {
    out = snap.frontmatter + '\n' + (out.startsWith('\n') ? '' : '\n') + out;
    repairs.push('restored frontmatter');
  }

  for (const [id, raw] of Object.entries(snap.frozen || {})) {
    const model = parse(out, opts);
    const b = findBlock(model, id);
    if (!b) { warnings.push(`frozen line ${id} removed`); continue; }
    if (!isAssumeLine(b) || b.status.raw.trim() === raw.trim()) continue;
    const idx = statusIdx(model, b);
    if (idx < 0) continue;
    const lines = nl(out);
    lines[b.line - 1] = setCell(lines[b.line - 1], idx, raw.trim());
    out = lines.join('\n');
    repairs.push(`restored frozen status on ${id}`);
  }

  for (const [id, value] of Object.entries(snap.ticks || {})) {
    const b = findBlock(parse(out, opts), id);
    if (!isAssumeLine(b)) continue; // removed, or consumed into accepted/rejected: fine
    if (b.status.state !== 'proposed' && b.status.state !== 'suspect') continue;
    const r = tick(out, id, value, opts);
    if (r.changed) { out = r.text; repairs.push(`restored tick [${value}] on ${id}`); }
  }

  for (const [qid, a] of Object.entries(snap.answers || {})) {
    const q = findBlock(parse(out, opts), qid);
    if (!q || q.kind !== 'question') continue;
    if (q.options.some(o => o.checked) || (q.other && q.other.checked)) continue;
    const r = answer(out, qid, { option: a.option, other: a.other }, opts);
    if (r.changed) { out = r.text; repairs.push(`restored answer on ${qid}`); }
  }

  for (const [id, raw] of Object.entries(snap.pageProposed || {})) {
    const model = parse(out, opts);
    if (findBlock(model, id)) continue;
    const sm = SUB_ID_RE.exec(id);
    let at = -1;
    if (sm) { const req = findBlock(model, sm[1]); if (req && req.kind === 'req') at = req.endLine; }
    else { const t = collect(model.blocks).find(b => b.kind === 'table' && b.tableKind === 'global'); if (t) at = t.endLine; }
    if (at < 0) { warnings.push(`proposed line ${id} removed with its parent`); continue; }
    const lines = nl(out);
    lines.splice(at, 0, raw);
    out = lines.join('\n');
    repairs.push(`re-inserted proposed line ${id}`);
  }

  const present = new Set(parse(out, opts).blocks.map(s => s.n));
  // §8 Integrations and §9 Glossary joined the grammar with the client-tab layout; a document
  // written before that simply has no snapshot entry for them, so nothing warns retroactively.
  for (const n of (snap.sections && snap.sections.length ? snap.sections : [1, 2, 3, 4, 5, 6, 7])) if (n >= 1 && n <= 9 && !present.has(n)) warnings.push(`section ${n} missing`);
  return { text: out, repairs, warnings };
}
