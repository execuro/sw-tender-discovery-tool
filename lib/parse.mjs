// `-analysis.md` → block model with id/line/endLine/hash/path. Node-free
// (served to the page as well). Grammar: sw-discover-tender/reference/analysis-template.md.
import { parseYaml } from './yaml.mjs';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SECTION_RE = /^##\s+(?:(\d+)[.)]\s+)?(.*?)\s*$/;
// Prefix may carry digits (B2B-01); sub-lines `.a<n>` / `.c<n>`.
// Exported: used by edit.mjs to validate/parse block ids outside this module.
export const ID_RE = /^[A-Z][A-Z0-9]{0,5}-\d+(?:\.[ac]\d+)?$/;
export const SUB_ID_RE = /^([A-Z][A-Z0-9]{0,5}-\d+)\.([ac])(\d+)$/;
const Q_HEAD_RE = /^###\s+((?:CQ|Q)-\d+)\s+·\s+(.*)$/;
const OPTION_RE = /^-\s+\[( |x|X)\]\s+(?:([A-Z])\s+[—–-]\s+)?(.*?)\s*$/;
const OTHER_RE = /^-\s+\[( |x|X)\]\s+Other:\s*(.*?)\s*$/;
const UNTIL_RE = /^Until answered we assume\s+(.*?)\.?\s*$/;
const NOTSENT_RE = /^Not sent\s+[—–-]\s+cap:\s*(.*)$/;
const ASSUME_STATUS_RE = /^\[( |x|X|-)\](?:\s+(suspect))?\s*$|^(accepted|rejected)\s+(\d{4}-\d{2}-\d{2})\s*$/;
// `provisional` is retired in the skill grammar; still parsed so older documents render.
const REQ_STATUS_RE = /^(estimated|prefilled|provisional|blocked|queued|analysing)((?:\s*,\s*C?Q-\d+)*)\s*$/;
const LMH_RE = /^(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)$/;
const PD_PER_ROW_RE = /([A-Z][A-Z0-9]{0,5}-\d+)\s*[−–-]\s*(\d+(?:[.,]\d+)?)/g;
const ROW_REF_RE = /^([A-Z][A-Z0-9]{0,5})-(\d+)\.\.(?:([A-Z][A-Z0-9]{0,5})-)?(\d+)$/;
const OVB_LINE_RE = /overhead\s*\/\s*buffer/i;
const OVERHEAD_RE = /overhead[^0-9_]{0,12}(_TBD_|\d+(?:[.,]\d+)?\s*%)(?:[^.·]*?\b(folded|separate)\b)?/i;
const BUFFER_RE = /(?:risk\s+)?buffer[^0-9_]{0,12}(_TBD_|\d+(?:[.,]\d+)?\s*%)(?:[^.·]*?\b(folded|separate)\b)?/i;

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const BULLET_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TYPED = new Set(['req', 'assume', 'clarify', 'global', 'question']);

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

/** `−5`, `-5`, `15,5 PD`, `` `_TBD_` `` → number | null. */
export function toNum(s) {
  if (s == null) return null;
  let t = String(s).replace(/[`*]/g, '').replace(/\s*PD$/i, '').trim();
  if (!t || /^_?tbd_?$/i.test(t)) return null;
  t = t.replace(/[−–]/g, '-').replace(',', '.');
  return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

function firstNum(s) {
  const m = /-?\d+(?:[.,]\d+)?/.exec(String(s ?? '').replace(/[`*]/g, '').replace(/[−–]/g, '-'));
  return m ? Number(m[0].replace(',', '.')) : null;
}

/** `STF-01..STF-03, B2B-02..06 · GEN-06` → ids; non-ids ignored. */
export function expandRows(s) {
  const out = [];
  for (const part of String(s ?? '').replace(/\([^)]*\)/g, '').split(/[,·;]/)) {
    const t = part.replace(/[`*]/g, '').trim();
    if (!t) continue;
    const r = ROW_REF_RE.exec(t);
    if (r) {
      const from = Number(r[2]), to = Number(r[4]), width = r[2].length;
      for (let n = from; n <= to && n - from < 500; n++) out.push(`${r[1]}-${String(n).padStart(width, '0')}`);
    } else if (ID_RE.test(t)) out.push(t);
  }
  return out;
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

export function tableKind(header) {
  const h = header.map(c => c.toLowerCase().replace(/[`*]/g, '').trim());
  const has = (...k) => k.every(x => h.includes(x));
  if (has('id', 'kind', 'prio', 'class')) return 'analysis';
  if (has('id', 'kind', 'rows', 'statement')) return 'global';
  if (has('id', 'date', 'topic', 'decision')) return 'log';
  if (h.some(x => x.startsWith('table')) && h.includes('locator')) return 'source';
  if (h[0] === 'scope' && h.includes('pd')) return 'scope';
  if (has('dimension', 'weight')) return 'confidence';
  // The client's own material, §1.1/§1.2/§8/§9 (analysis-template.md). Typed so the page can
  // tab and style them; none of them is a response table.
  if (has('field', 'value', 'source')) return 'meta';
  if (has('parameter', 'value', 'drives')) return 'params';
  if (h.some(x => x === 'object' || x === 'data object') && h.some(x => x.includes('volume'))) return 'migration';
  if (has('system', 'direction', 'objects')) return 'integration';
  if (has('term', 'meaning')) return 'glossary';
  return 'generic';
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

// ---------------------------------------------------------------------------

export function parse(text, { path = null } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const model = { path, slug: path ? slugFromPath(path) : null, title: '', rfp: null, client: null, project: null, frontmatter: null, blocks: [], meta: null };

  const fm = FM_RE.exec(src);
  let bodyStart = 0;
  if (fm) {
    let data = {};
    try { data = parseYaml(fm[1]); } catch { data = {}; }
    const raw = src.slice(0, fm[0].length).replace(/\n$/, '');
    model.frontmatter = { raw, line: 1, endLine: raw.split('\n').length, data };
    bodyStart = model.frontmatter.endLine;
  }
  const lines = src.split('\n');

  // Sections (## headings), fence-aware; the preamble only yields the title.
  const sections = [];
  let cur = null, inFence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    const hm = !inFence && HEADING_RE.exec(line);
    if (hm && hm[1].length === 1 && !model.title) { model.title = hm[2].trim(); continue; }
    if (hm && hm[1].length === 2) {
      const sm = SECTION_RE.exec(line);
      const n = sm && sm[1] ? Number(sm[1]) : null;
      const title = (sm ? sm[2] : hm[2]).trim();
      cur = { id: n != null ? `s${n}` : 's-' + slugify(title), kind: 'section', n, title, line: i + 1, endLine: i + 1, hash: hash(title), lines: [], children: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  const tparts = model.title.split(/\s+—\s+/);
  model.rfp = tparts[0] || model.frontmatter?.data?.rfp || null;
  model.client = tparts[1] || model.frontmatter?.data?.client || null;
  model.project = tparts.slice(2).join(' — ') || null;

  const used = new Set();
  for (const sec of sections) {
    while (used.has(sec.id)) sec.id += 'x';
    used.add(sec.id);
    sec.children = parseBlocks(sec.lines, sec.line + 1, sec.id, sec.n, 0);
    let last = sec.lines.length;
    while (last > 0 && sec.lines[last - 1].trim() === '') last--;
    sec.endLine = last ? sec.line + last : sec.line;
    delete sec.lines;
    model.blocks.push(sec);
  }

  const seen = new Set();
  for (const b of collect(model.blocks)) {
    if (seen.has(b.id)) { let k = 2; while (seen.has(`${b.id}~${k}`)) k++; b.id = `${b.id}~${k}`; }
    seen.add(b.id);
  }
  annotateAncestry(model.blocks, []);
  model.meta = deriveMeta(model);
  return model;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'x';
}

/** Breadcrumb `path` for every block; containers get an endLine covering their last descendant. */
export function annotateAncestry(blocks, path) {
  let last = 0;
  for (const b of blocks || []) {
    b.path = path;
    const label = b.kind === 'section' ? b.title : b.kind === 'req' || b.kind === 'question' ? b.id : b.kind === 'table' ? `table (${(b.header || []).slice(0, 3).join(' | ')})` : null;
    const childPath = label != null ? [...path, label] : path;
    let end = b.endLine ?? b.line ?? 0;
    if (b.children) end = Math.max(end, annotateAncestry(b.children, childPath));
    if (b.endLine == null || end > b.endLine) b.endLine = end;
    last = Math.max(last, end);
  }
  return last;
}

function parseBlocks(lines, startLine, secId, secN, depth) {
  const blocks = [];
  const counters = { p: 0, b: 0, c: 0, t: 0, h: 0 };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const ln = startLine + i;
    if (line.trim() === '') { i++; continue; }

    const hm = HEADING_RE.exec(line);
    if (hm && hm[1].length >= 3) {
      const qm = Q_HEAD_RE.exec(line);
      if (qm) { const q = parseQuestion(lines, i, startLine, qm); blocks.push(q.block); i = q.next; continue; }
      let j = i + 1;
      while (j < lines.length && !(HEADING_RE.test(lines[j]) && HEADING_RE.exec(lines[j])[1].length <= hm[1].length)) j++;
      counters.h++;
      const id = `${secId}.h${counters.h}`;
      const title = hm[2].trim();
      blocks.push({ id, kind: 'section', n: null, title, line: ln, endLine: startLine + j - 1, hash: hash(title), children: parseBlocks(lines.slice(i + 1, j), ln + 1, id, null, depth + 1) });
      i = j;
      continue;
    }

    if (FENCE_RE.test(line)) {
      let j = i + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j])) j++;
      counters.c++;
      const md = lines.slice(i, Math.min(j + 1, lines.length)).join('\n');
      blocks.push({ id: `${secId}.c${counters.c}`, kind: 'code', md, line: ln, endLine: startLine + Math.min(j, lines.length - 1), hash: hash(md) });
      i = j + 1;
      continue;
    }

    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && TABLE_ROW_RE.test(lines[j])) { rows.push({ cells: splitRow(lines[j]), raw: lines[j], line: startLine + j }); j++; }
      counters.t++;
      const id = counters.t === 1 && depth === 0 && secN != null ? `t${secN}` : `${secId}.t${counters.t}`;
      const table = { id, kind: 'table', tableKind: tableKind(header), header, colIndex: {}, line: ln, endLine: startLine + j - 1, hash: hash(header.join('|')), children: [] };
      header.forEach((h, k) => { const key = h.toLowerCase().replace(/[`*]/g, '').trim(); if (!(key in table.colIndex)) table.colIndex[key] = k; });
      buildRows(table, rows);
      blocks.push(table);
      i = j;
      continue;
    }

    const bm = BULLET_RE.exec(line);
    if (bm && bm[1].length <= 1) {
      let j = i + 1;
      while (j < lines.length && /^\s{2,}\S/.test(lines[j])) j++;
      counters.b++;
      const md = [bm[3], ...lines.slice(i + 1, j).map(l => l.replace(/^\s{2}/, ''))].join('\n');
      blocks.push({ id: `${secId}.b${counters.b}`, kind: 'bullet', md, line: ln, endLine: startLine + j - 1, hash: hash(md) });
      i = j;
      continue;
    }

    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '' && !HEADING_RE.test(lines[j]) && !FENCE_RE.test(lines[j]) && !BULLET_RE.test(lines[j]) && !TABLE_ROW_RE.test(lines[j])) j++;
    counters.p++;
    const md = lines.slice(i, j).join('\n');
    const p = { id: `${secId}.p${counters.p}`, kind: 'paragraph', md, line: ln, endLine: startLine + j - 1, hash: hash(md) };
    const ns = NOTSENT_RE.exec(md.trim());
    if (ns) p.notSent = expandRows(ns[1]);
    blocks.push(p);
    i = j;
  }
  return blocks;
}

// A question block: heading, question paragraph, options, Other, `Until answered…`.
// Contiguous lines; a blank is tolerated before the option list.
function parseQuestion(lines, i, startLine, qm) {
  const id = qm[1];
  const block = { id, kind: 'question', qkind: id.startsWith('CQ') ? 'cq' : 'q', rows: [], blocking: null, priority: null, question: '', options: [], other: null, assume: null, line: startLine + i, endLine: startLine + i, hash: '', path: [] };
  for (const part of qm[2].split(/\s+·\s+/)) {
    const t = part.trim();
    const bm = /^blocking:\s*(yes|no)$/i.exec(t);
    if (bm) block.blocking = bm[1].toLowerCase() === 'yes';
    else if (/^(high|medium|low)$/i.test(t)) block.priority = t.toLowerCase();
    else block.rows.push(...expandRows(t));
  }
  const q = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') { if (j + 1 < lines.length && /^-\s+\[|^Until answered/.test(lines[j + 1].trim())) continue; break; }
    if (HEADING_RE.test(l)) break;
    const ln = startLine + j;
    const om = OTHER_RE.exec(l.trim());
    if (om) { block.other = { text: om[2], checked: om[1] !== ' ', line: ln }; continue; }
    const pm = OPTION_RE.exec(l.trim());
    if (pm) { block.options.push({ letter: pm[2] || null, text: pm[3], checked: pm[1] !== ' ', line: ln }); continue; }
    const um = UNTIL_RE.exec(l.trim());
    if (um) { block.assume = um[1]; continue; }
    if (!block.options.length && !block.other) q.push(l.trim());
  }
  block.question = q.join('\n');
  block.endLine = startLine + j - 1;
  while (block.endLine > block.line && lines[block.endLine - startLine].trim() === '') block.endLine--;
  block.hash = hash(id + '|' + block.question);
  return { block, next: j };
}

function assumeStatus(cell) {
  const m = ASSUME_STATUS_RE.exec(cell.trim());
  if (!m) return { state: null, date: null, suspect: false, raw: cell };
  if (m[3]) return { state: m[3], date: m[4], suspect: false, raw: cell };
  const box = m[1].toLowerCase();
  const suspect = !!m[2];
  const state = box === 'x' ? 'ticked-accept' : box === '-' ? 'ticked-reject' : suspect ? 'suspect' : 'proposed';
  return { state, date: null, suspect, raw: cell };
}

function riskTarget(cell) {
  const m = /risk\s+to\s+([^;(]+)/i.exec(cell);
  return m ? m[1].trim() : cell.trim();
}

function buildRows(table, rows) {
  const ci = table.colIndex;
  const cell = (r, key) => (ci[key] != null ? r.cells[ci[key]] ?? '' : '');
  const strip = s => s.replace(/[`*]/g, '').trim();
  let lastReq = null;
  rows.forEach((r, k) => {
    const idCell = r.cells.map(strip).find(c => ID_RE.test(c));
    const b = { id: idCell || `${table.id}.r${k + 1}`, kind: 'row', tableId: table.id, cells: r.cells, raw: r.raw, line: r.line, endLine: r.line, hash: '', path: [] };
    let text = null;
    if (table.tableKind === 'analysis') {
      const kind = strip(cell(r, 'kind')).toLowerCase();
      text = cell(r, 'text');
      if (kind === 'req') {
        const lmhCell = strip(cell(r, 'l/m/h'));
        const lm = LMH_RE.exec(lmhCell);
        const st = REQ_STATUS_RE.exec(strip(cell(r, 'status')));
        Object.assign(b, {
          kind: 'req', prio: strip(cell(r, 'prio')), cls: strip(cell(r, 'class')).toLowerCase() || null,
          lmh: lm ? { low: toNum(lm[1]), mid: toNum(lm[2]), high: toNum(lm[3]) } : /^blocked$/i.test(lmhCell) ? 'blocked' : null,
          lvl: strip(cell(r, 'lvl')).toLowerCase() || null, pd: toNum(cell(r, 'pd')), pdRaw: cell(r, 'pd'), text, evidence: cell(r, 'evidence / risk'),
          status: { kind: st ? st[1] : null, cq: st ? (st[2].match(/C?Q-\d+/g) || []) : [] }, children: [],
        });
        lastReq = b;
        table.children.push(b);
      } else if (kind === 'assume' || kind === 'clarify') {
        const sm = SUB_ID_RE.exec(b.id);
        b.kind = kind;
        b.parent = sm ? sm[1] : null;
        b.n = sm ? Number(sm[3]) : null;
        if (kind === 'assume') {
          const pdRaw = cell(r, 'pd');
          const n = toNum(pdRaw);
          Object.assign(b, { pdSaved: n == null ? null : Math.abs(n), pdSavedRaw: pdRaw, cls: strip(cell(r, 'class')).toLowerCase() || null, statement: text, evidence: cell(r, 'evidence / risk'), riskTo: riskTarget(cell(r, 'evidence / risk')), status: assumeStatus(cell(r, 'status')) });
        } else {
          Object.assign(b, { decision: text, source: cell(r, 'evidence / risk'), date: strip(cell(r, 'status')) || null });
        }
        if (lastReq && lastReq.id === b.parent) { lastReq.children.push(b); lastReq.endLine = b.line; }
        else { b.orphan = true; table.children.push(b); }
      } else { b.tableKind = table.tableKind; table.children.push(b); }
    } else if (table.tableKind === 'global') {
      const gkind = strip(cell(r, 'kind')).toLowerCase();
      const pdRaw = cell(r, 'pd saved');
      const perRow = {};
      for (const m of pdRaw.matchAll(PD_PER_ROW_RE)) perRow[m[1]] = Number(m[2].replace(',', '.'));
      const hasPer = Object.keys(perRow).length > 0;
      text = cell(r, 'statement');
      const status = gkind === 'assume' ? assumeStatus(cell(r, 'status')) : { state: null, raw: cell(r, 'status') };
      Object.assign(b, {
        kind: 'global', gkind, rowsNamed: expandRows(cell(r, 'rows')), statement: text,
        pdSaved: { total: hasPer ? Object.values(perRow).reduce((a, x) => a + x, 0) : (firstNum(pdRaw) == null ? null : Math.abs(firstNum(pdRaw))), perRow: hasPer ? perRow : null, raw: pdRaw },
        riskTo: cell(r, 'risk to'), status,
      });
      table.children.push(b);
    } else if (table.tableKind === 'log') {
      Object.assign(b, { kind: 'log', date: cell(r, 'date'), topic: cell(r, 'topic'), decision: cell(r, 'decision') });
      table.children.push(b);
    } else { b.tableKind = table.tableKind; table.children.push(b); }
    b.hash = TYPED.has(b.kind) ? hash(b.id + '|' + (text ?? '')) : hash(r.cells.join('|'));
  });
}

// ---------------------------------------------------------------------------

export function deriveMeta(model) {
  const fm = model.frontmatter?.data || {};
  const all = collect(model.blocks);
  const reqs = all.filter(b => b.kind === 'req');
  const assumes = all.filter(b => b.kind === 'assume' || (b.kind === 'global' && b.gkind === 'assume'));
  const questions = all.filter(b => b.kind === 'question');
  const clar = all.filter(b => b.kind === 'clarify' || (b.kind === 'global' && b.gkind === 'clarify'));
  const byState = s => assumes.filter(a => a.status.state === s).length;
  const answered = q => q.options.some(o => o.checked) || !!(q.other && q.other.checked);
  const mustIds = new Set(reqs.filter(r => /^must/i.test(r.prio || '')).map(r => r.id));
  const cqs = questions.filter(q => q.qkind === 'cq'), qs = questions.filter(q => q.qkind === 'q');
  const blockingOnMust = cqs.filter(q => q.blocking && q.rows.some(r => mustIds.has(r)));

  const counts = {
    rows: reqs.length,
    req: { estimated: 0, provisional: 0, blocked: 0, prefilled: 0, queued: 0, analysing: 0, unknown: 0 },
    assume: { proposed: byState('proposed'), tickedAccept: byState('ticked-accept'), tickedReject: byState('ticked-reject'), accepted: byState('accepted'), rejected: byState('rejected'), suspect: assumes.filter(a => a.status.suspect).length },
    questions: { client: cqs.length, blocking: cqs.filter(q => q.blocking).length, blockingOnMust: blockingOnMust.length, partner: qs.length, high: qs.filter(q => q.priority === 'high').length },
    clarifications: clar.length,
  };
  for (const r of reqs) counts.req[r.status.kind || 'unknown']++;

  const s2 = model.blocks.find(b => b.n === 2) || null;
  let totals = null;
  const scope = s2 && s2.children.find(b => b.kind === 'table' && b.tableKind === 'scope');
  if (scope) {
    totals = { must: null, should: null, could: null, services: null, total: null };
    const map = [['must', /^must/i], ['should', /^should/i], ['could', /^could/i], ['services', /^of which services/i], ['total', /^total/i]];
    for (const r of scope.children) {
      const label = (r.cells[0] || '').replace(/[`*]/g, '').trim();
      const hit = map.find(([, re]) => re.test(label));
      if (hit && totals[hit[0]] == null) totals[hit[0]] = firstNum(r.cells[scope.colIndex.pd] ?? r.cells[1]);
    }
  }
  const overhead = { pct: null, mode: null, tbd: false }, buffer = { pct: null, mode: null, tbd: false };
  const ovp = s2 && s2.children.find(b => b.kind === 'paragraph' && OVB_LINE_RE.test(b.md));
  if (ovp) {
    const ovl = ovp.md.split('\n').find(l => OVB_LINE_RE.test(l)) || ovp.md;
    const om = OVERHEAD_RE.exec(ovl);
    if (om) { overhead.tbd = /tbd/i.test(om[1]); overhead.pct = overhead.tbd ? null : toNum(om[1].replace('%', '')); overhead.mode = om[2] ? om[2].toLowerCase() : null; }
    const bm = BUFFER_RE.exec(om ? ovl.slice(om.index + om[0].length) : ovl);
    if (bm) { buffer.tbd = /tbd/i.test(bm[1]); buffer.pct = buffer.tbd ? null : toNum(bm[1].replace('%', '')); buffer.mode = bm[2] ? bm[2].toLowerCase() : null; }
  }

  const confidence = fm.confidence == null ? null : Number(fm.confidence);
  const reasons = [];
  if (confidence == null || !(confidence > 90)) reasons.push(`confidence ${confidence ?? 'unknown'} ≤ 90`);
  for (const q of qs) if (q.priority === 'high' && !answered(q)) reasons.push(`open high ${q.id}`);
  for (const q of blockingOnMust) reasons.push(`blocking ${q.id} on Must ${q.rows.filter(r => mustIds.has(r)).join(', ')}`);
  if (counts.assume.suspect) reasons.push(`${counts.assume.suspect} suspect line${counts.assume.suspect === 1 ? '' : 's'}`);
  const ticks = counts.assume.tickedAccept + counts.assume.tickedReject + questions.filter(answered).length;
  if (ticks) reasons.push(`${ticks} unreconciled tick${ticks === 1 ? '' : 's'}`);
  const readyGate = { ready: reasons.length === 0, reasons };
  const ex = fm.export && typeof fm.export === 'object' ? fm.export : {};
  const status = fm.status ?? null;
  const exportState = { exported: !!ex.date, date: ex.date ?? null, files: Array.isArray(ex.files) ? ex.files : [], stale: !!ex.stale, gateNow: readyGate.ready && status === 'Ready to submit' };

  const fmMismatch = [];
  const fc = fm.counts && typeof fm.counts === 'object' ? fm.counts : null;
  if (fc) {
    const cmp = (label, a, b) => { if (a != null && Number(a) !== b) fmMismatch.push(`${label}: frontmatter ${a}, document ${b}`); };
    cmp('counts.rows', fc.rows, counts.rows);
    for (const k of ['proposed', 'accepted', 'rejected', 'suspect']) cmp(`counts.assumptions.${k}`, fc.assumptions?.[k], counts.assume[k]);
    for (const k of ['client', 'blocking', 'partner', 'high']) cmp(`counts.questions.${k}`, fc.questions?.[k], counts.questions[k]);
    cmp('counts.clarifications', fc.clarifications, counts.clarifications);
  }

  return {
    rfp: fm.rfp ?? model.rfp, kind: fm.kind ?? null, client: fm.client ?? model.client, status, confidence, updated: fm.updated ?? null, shopware: fm.shopware ?? null,
    source: Array.isArray(fm.source) ? fm.source : [], export: { date: ex.date ?? null, files: exportState.files, source_sha256: ex.source_sha256 ?? null, stale: !!ex.stale },
    counts, totals, overhead, buffer, readyGate, exportState, fmMismatch,
  };
}
