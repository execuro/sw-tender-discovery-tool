// Projection math for the Tender Discovery Tool. No imports: served to the browser as /page/lib/calc.mjs.
// Fold (estimation-model.md): mid' = mid − Σ PD saved of applied lines; PD = mid' × (1 + level buffer) × overhead × risk → nearest 0.25.

export const LADDER = ['stock', 'config', 'plugin', 'extension', 'custom'];
export const OFF = ['commitment', 'service', 'not-offered', 'blocked'];
export const LEVEL_BUFFER = { detailed: 0, medium: 0.10, vague: 0.25 };

export function ladderOf(cls) {
  if (cls == null) return null;
  if (cls === 'stock' || cls === 'config') return 'ootb';
  if (LADDER.includes(cls)) return cls;
  return OFF.includes(cls) ? 'off' : null;
}
export const rank = cls => LADDER.indexOf(cls);
export function round025(x) { const r = Math.round(x * 4) / 4; return r === 0 ? 0 : r; }

const pct = f => (f && !f.tbd && typeof f.pct === 'number') ? 1 + f.pct / 100 : 1;
export function factors(meta) {
  const m = meta || {};
  return { overhead: pct(m.overhead), risk: m.buffer?.mode === 'folded' ? pct(m.buffer) : 1 };
}

function* walk(nodes) {
  for (const n of nodes || []) { yield n; if (Array.isArray(n.children)) yield* walk(n.children); }
}
const collect = (model, pred) => { const out = []; for (const n of walk(model?.blocks)) if (pred(n)) out.push(n); return out; };

export const reqRows = model => collect(model, n => n.kind === 'req');
export const globalLines = model => collect(model, n => n.kind === 'global' && n.gkind === 'assume');
const findLine = (model, id) => collect(model, n => n.id === id && (n.kind === 'assume' || n.kind === 'global'))[0] || null;
const findReq = (model, id) => reqRows(model).find(r => r.id === id) || null;

export function linesFor(req, model) {
  const own = (req.children || []).filter(c => c.kind === 'assume');
  const glob = globalLines(model).filter(g => (g.rowsNamed || []).includes(req.id));
  return own.concat(glob);
}

export function applied(lines, mode, force = {}) {
  return lines.filter(l => {
    const forced = Object.hasOwn(force, l.id);
    const st = forced ? force[l.id] : l.status?.state;
    if (!forced && (l.status?.suspect || st === 'suspect')) return false;
    return st === 'accepted' || (mode === 'projected' && st === 'ticked-accept');
  });
}

export function pdSavedFor(line, rowId) {
  if (line.kind !== 'global') return { value: line.pdSaved ?? null, unknown: false };
  const ps = line.pdSaved || {};
  const v = ps.perRow?.[rowId] ?? ((line.rowsNamed || []).length === 1 ? ps.total ?? null : null);
  return { value: v, unknown: v == null };
}

export function computeRow(req, model, mode, opts = {}) {
  const { overhead, risk } = factors(model?.meta);
  const lines = applied(linesFor(req, model), mode, opts.force || {});
  let saved = 0; const unknownSaved = [];
  for (const l of lines) {
    const s = pdSavedFor(l, req.id);
    if (s.unknown) unknownSaved.push(l.id); else saved += s.value;
  }
  const stated = lines.filter(l => l.cls && rank(l.cls) >= 0);
  const cls = stated.length ? stated.reduce((a, b) => (rank(b.cls) < rank(a.cls) ? b : a)).cls : (req.cls ?? null);
  const lvl = lines.length ? 'detailed' : (req.lvl || 'detailed');
  const buffer = LEVEL_BUFFER[lvl] ?? 0;
  const mid = (req.lmh && req.lmh !== 'blocked' && typeof req.lmh.mid === 'number') ? req.lmh.mid : null;
  const commitment = cls === 'commitment';
  const stKind = req.status?.kind;
  // `queued` / `analysing` rows carry no estimate yet: no PD contribution, same as blocked.
  const blocked = !commitment && (stKind === 'blocked' || stKind === 'queued' || stKind === 'analysing' || req.lmh === 'blocked' || mid == null);
  const mid2 = mid == null ? null : Math.max(mid - saved, 0);
  const final = commitment ? 0 : blocked ? null : round025(mid2 * (1 + buffer) * overhead * risk);
  const docPd = typeof req.pd === 'number' ? req.pd : null;
  const drift = (mode === 'doc' && docPd != null && final != null) ? Math.round((docPd - final) * 1000) / 1000 : null;
  return { id: req.id, cls, ladder: ladderOf(cls), lvl, mid, mid2, saved, buffer, final, blocked, commitment,
    unknownSaved, docPd, drift, applied: lines.map(l => l.id) };
}

export function computeAll(model, mode) {
  const out = {};
  for (const r of reqRows(model)) out[r.id] = computeRow(r, model, mode);
  return out;
}

export function totals(model, computed) {
  const t = { must: 0, should: 0, could: 0, services: 0, total: 0, blocked: [], queued: [], analysing: [], rows: 0 };
  for (const r of reqRows(model)) {
    const c = computed[r.id]; t.rows++;
    if (!c || c.final == null) {
      const kind = r.status?.kind;
      if (kind === 'queued') t.queued.push(r.id);
      else if (kind === 'analysing') t.analysing.push(r.id);
      else t.blocked.push(r.id);
      continue;
    }
    const p = String(r.prio || '').toLowerCase();
    if (p in t && ['must', 'should', 'could'].includes(p)) t[p] += c.final;
    if (c.cls === 'service') t.services += c.final;
  }
  t.total = t.must + t.should + t.could;
  return t;
}

export function delta(model) {
  // Effect of the unreconciled ticks only: projected minus the document-mode recomputation,
  // so rounding drift between the skill's figures and this fold never shows as a delta.
  const base = totals(model, computeAll(model, 'doc'));
  const p = totals(model, computeAll(model, 'projected'));
  const d = k => Math.round((p[k] - base[k]) * 1000) / 1000;
  return { must: d('must'), should: d('should'), could: d('could'), total: d('total') };
}

export function impact(model, lineId) {
  const line = findLine(model, lineId);
  if (!line) return { pd: 0, rows: [], unknown: false };
  const ids = line.kind === 'global' ? (line.rowsNamed || []) : [line.parent];
  const rows = []; let pd = 0, unknown = false;
  for (const id of ids) {
    const req = findReq(model, id); if (!req) continue;
    const a = computeRow(req, model, 'projected');
    const b = computeRow(req, model, 'projected', { force: { [lineId]: 'accepted' } });
    if (b.unknownSaved.includes(lineId)) unknown = true;
    if (a.final != null && b.final != null) pd += a.final - b.final;
    rows.push({ id, from: a.final, to: b.final, fromCls: a.cls, toCls: b.cls });
  }
  return { pd: Math.round(pd * 1000) / 1000, rows, unknown };
}

// ---------------------------------------------------------------------------
// §1 Source map → §4 tab grouping. The Locator cell names the id range a source
// table owns, e.g. `` `03-requirements.csv` rows 2–92 (`GEN-01`…`ADM-05`) ``.
const SOURCE_RANGE_RE = /\(\s*`([A-Z][A-Z0-9]{0,5}-\d+)`[^`)]*`([A-Z][A-Z0-9]{0,5}-\d+)`\s*\)/;
const strip = s => String(s ?? '').replace(/[`*]/g, '').trim();

/** One entry per §1 source-map row: `{num, name, first, last}`; `first`/`last` are null with no parseable range. */
export function sourceTables(model) {
  const t = collect(model, n => n.kind === 'table' && n.tableKind === 'source')[0];
  if (!t) return [];
  const ci = t.colIndex || {};
  const idxNum = ci['#'], idxName = ci['table (sheet / section)'], idxLoc = ci['locator'];
  return (t.children || []).map(r => {
    const cells = r.cells || [];
    const num = idxNum != null ? Number(strip(cells[idxNum])) : null;
    const name = idxName != null ? strip(cells[idxName]) : '';
    const m = idxLoc != null ? SOURCE_RANGE_RE.exec(String(cells[idxLoc] ?? '')) : null;
    return { num: Number.isFinite(num) ? num : null, name, first: m ? m[1] : null, last: m ? m[2] : null };
  });
}

/**
 * §4 req rows grouped by the source table whose id range owns them, in document order.
 * A req row before the first range, or once no range parses at all, lands in a catch-all tab
 * (`other` alongside real tabs, or `all` on its own when the source map carries no range at all).
 */
export function reqTabs(model) {
  const tables = sourceTables(model).filter(t => t.first && t.last);
  const rows = reqRows(model);
  if (!tables.length) return [{ key: 'all', num: null, name: null, rows }];
  const tabs = tables.map(t => ({ key: `src-${t.num}`, num: t.num, name: t.name, rows: [] }));
  const other = { key: 'other', num: null, name: 'Other', rows: [] };
  let cur = -1, open = false;
  for (const r of rows) {
    if (cur + 1 < tables.length && r.id === tables[cur + 1].first) { cur++; open = true; }
    if (open) { tabs[cur].rows.push(r); if (r.id === tables[cur].last) open = false; }
    else other.rows.push(r);
  }
  return other.rows.length ? [...tabs, other] : tabs;
}

// ---------------------------------------------------------------------------
// Page tabs. The primary navigation mirrors the client's own document (the sheet tabs of the
// tender), not our section numbering: Overview · Meta · Company & Context · Requirements ·
// Non-functional & Compliance · Integrations · Glossary. Every analysis section lands in exactly
// one tab, so nothing in the document becomes unreachable.

/** A source table is the non-functional/compliance one when the client named it so. */
const NFR_NAME_RE = /non-?functional|compliance/i;

/** Sections by number, `null` when the document does not carry one (older analyses). */
function sectionsByNum(model) {
  const by = {};
  for (const b of model?.blocks || []) if (b.kind === 'section' && b.n != null) by[b.n] = b;
  return by;
}

/** `## 1. Context` subsections, keyed by their `1.1`-style number when they carry one. */
export function subsections(section) {
  const out = {};
  for (const c of section?.children || []) {
    if (c.kind !== 'section') continue;
    const m = /^(\d+\.\d+)\s+/.exec(c.title || '');
    if (m) out[m[1]] = c; else out[c.title] = c;
  }
  return out;
}

/**
 * The tab model: `{key, label, sections, groups, empty}` per tab, in navigation order.
 * `sections` are the section (or §1 subsection) blocks the tab renders; `groups` are `reqTabs`
 * entries for the two requirement tabs. `empty` marks a tab whose content the analysis does not
 * carry yet — a document written before this grammar — so the page can say so instead of
 * rendering a blank card.
 */
export function pageTabs(model) {
  const s = sectionsByNum(model);
  const sub = subsections(s[1]);
  const groups = reqTabs(model);
  // A group belongs to the NFR tab when its source table says so; everything else — including the
  // project/contract rows of a vendor-response sheet — is a requirement group.
  const nfr = groups.filter(g => NFR_NAME_RE.test(g.name || ''));
  const req = groups.filter(g => !NFR_NAME_RE.test(g.name || ''));

  const tab = (key, label, sections, extra = {}) => {
    const kept = sections.filter(Boolean);
    return { key, label, sections: kept, groups: [], empty: !kept.length, ...extra };
  };
  const tabs = [
    tab('overview', 'Overview', [s[2]]),
    tab('meta', 'Meta', [sub['1.1'], sub['1.3'], sub['1.4'], s[7]]),
    tab('company', 'Company & Context', [sub['1.2'], s[3], s[6]]),
    { key: 'req', label: 'Requirements', sections: [], groups: req, empty: !req.length },
    { key: 'nfr', label: 'Non-functional & Compliance', sections: [], groups: nfr, empty: !nfr.length },
    tab('integrations', 'Integrations', [s[8]]),
    tab('glossary', 'Glossary', [s[9]]),
  ];
  // §1 without the fixed subsections (an analysis written before this grammar): its loose blocks
  // still have to be reachable, so they ride along on Meta rather than disappearing.
  if (!sub['1.1'] && !sub['1.3'] && s[1]) {
    const meta = tabs.find(t => t.key === 'meta');
    meta.sections = [s[1], s[7]].filter(Boolean);
    meta.legacySection1 = true;
    meta.empty = !meta.sections.length;
  }
  return tabs;
}

/** The tab that owns a req row id, for note anchors and deep links. */
export function tabOfRow(tabs, id) {
  for (const t of tabs) for (const g of t.groups) if (g.rows.some(r => r.id === id)) return t.key;
  return null;
}

/** The tab that owns a section/subsection block id. */
export function tabOfSection(tabs, secId) {
  for (const t of tabs) if (t.sections.some(s => s.id === secId)) return t.key;
  return null;
}

/**
 * §9 Glossary as a lookup: `term (lower) -> {term, meaning, mapsTo}`. Terms shorter than three
 * characters and pure numbers are skipped — highlighting "PU" everywhere it appears inside a word
 * is noise, and the page matches on word boundaries anyway.
 */
export function glossary(model) {
  const sec = sectionsByNum(model)[9];
  const out = {};
  if (!sec) return out;
  for (const t of collect({ blocks: [sec] }, n => n.kind === 'table' && n.tableKind === 'glossary')) {
    const ci = t.colIndex || {};
    for (const r of t.children || []) {
      const cells = r.cells || [];
      const term = String(cells[ci['term'] ?? 0] ?? '').replace(/[`*]/g, '').trim();
      if (term.length < 3 || /^\d+$/.test(term)) continue;
      // `PU / Packaging unit` defines two spellings of one term.
      for (const alias of term.split(/\s+\/\s+/).map(x => x.trim()).filter(x => x.length >= 3)) {
        out[alias.toLowerCase()] = {
          term,
          meaning: String(cells[ci['meaning'] ?? 1] ?? '').trim(),
          mapsTo: String(cells[ci['maps to'] ?? 2] ?? '').trim(),
        };
      }
    }
  }
  return out;
}

export function pending(model) {
  const ticks = collect(model, n => (n.kind === 'assume' || n.kind === 'global') &&
    (n.status?.state === 'ticked-accept' || n.status?.state === 'ticked-reject')).map(n => n.id);
  const answers = collect(model, n => n.kind === 'question' &&
    ((n.options || []).some(o => o.checked) || !!n.other?.checked)).map(n => n.id);
  return { ticks, answers, count: ticks.length + answers.length };
}
