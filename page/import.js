// The steering screen: the architect tells the tool what the client's workbook actually contains,
// before any agent reads it. Until this is confirmed, extraction would be guesswork — which tab is
// a requirement table, where its header sits, which column is the id, which columns we answer in.
//
// Rendered in place of the "No analysis yet" card, because that is exactly the moment it belongs
// to: the workbook is imported, the analysis does not exist yet, and confirming is what starts it.
// Plain DOM like the rest of page/, no framework, no build.

/** Column roles offered per column, in the order they appear in the select. */
const ROLES = [
  ['', '—'],
  ['id', 'Id'],
  ['title', 'Title'],
  ['requirement', 'Requirement text'],
  ['acceptance', 'Acceptance / notes'],
  ['priority', 'Priority'],
  ['type', 'Type'],
  ['reference', 'Reference'],
  ['compliance', 'Answer: compliance'],
  ['comment', 'Answer: comment'],
  ['effort', 'Answer: effort'],
  ['cost', 'Cost (never written)'],
  ['context', 'Other client column'],
  ['ignore', 'Ignore'],
];
const SINGLE = ['id', 'title', 'requirement', 'acceptance', 'priority', 'type', 'reference', 'compliance', 'comment', 'effort'];
const MULTI = ['cost', 'context'];

export const colName = n => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };
export const colNum = s => { let n = 0; for (const ch of String(s)) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };

/** The role a column currently has in this table's mapping. */
export function roleOf(table, col) {
  for (const role of SINGLE) if (table.columns?.[role] === col) return role;
  for (const role of MULTI) if ((table.columns?.[role] || []).includes(col)) return role;
  return '';
}

/** Sets one column's role, keeping the single-valued roles single. */
export function setRole(table, col, role) {
  table.columns = table.columns || {};
  for (const r of SINGLE) if (table.columns[r] === col) delete table.columns[r];
  for (const r of MULTI) if (Array.isArray(table.columns[r])) table.columns[r] = table.columns[r].filter(c => c !== col);
  if (!role || role === 'ignore') return;
  if (MULTI.includes(role)) (table.columns[role] = table.columns[role] || []).push(col);
  else table.columns[role] = col;
}

/**
 * Builds the screen. `ctx` supplies what the page already has: `el` for DOM, `state` for the
 * import state from /api/session, `save` to persist a draft, `confirm` to write the CSVs.
 */
export function renderImportPanel(ctx) {
  const { el, state, save, confirm: confirmMap, closed } = ctx;
  const map = state.map;
  const wrap = el('div', { class: 'card import' });

  wrap.append(el('h2', {}, 'What is in this workbook?'));
  wrap.append(el('p', {}, 'Imported ', el('code', {}, state.source || ''),
    ' — ', String(state.sheets.length), ' sheet', state.sheets.length === 1 ? '' : 's',
    '. Confirm what each tab is before the analysis reads it; nothing is extracted until you do.'));
  if (state.stale) {
    wrap.append(el('p', { class: 'imp-stale' }, 'The workbook changed since this mapping was confirmed. Re-run import, then confirm again.'));
  }

  const summary = el('div', { class: 'imp-summary muted' });
  const confirmBtn = el('button', { class: 'btn primary', disabled: closed ? '' : null }, 'Confirm mapping & start the analysis');

  /** Keeps the footer honest about what confirming will do, and blocks an unusable mapping. */
  function refreshSummary() {
    const req = map.tables.filter(t => t.role === 'requirements');
    const ctxT = map.tables.filter(t => t.role === 'context');
    const ign = map.tables.filter(t => t.role === 'ignored').length + (map.ignored?.length || 0);
    const bad = req.filter(t => !t.columns?.id || !t.headerRow);
    summary.textContent = bad.length
      ? `${bad.map(t => t.sheet).join(', ')}: mark an id column and a header row, or set the tab to context.`
      : `${req.length} requirement table${req.length === 1 ? '' : 's'} · ${ctxT.length} context · ${ign} ignored`;
    summary.classList.toggle('imp-bad', bad.length > 0);
    confirmBtn.disabled = Boolean(bad.length) || closed;
  }

  let saveTimer = null;
  const touch = () => {
    refreshSummary();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(map), 400);
  };

  for (const sheet of state.sheets) {
    const table = map.tables.find(t => t.sheet === sheet.name)
      || { sheet: sheet.name, index: sheet.index, role: 'ignored', columns: {}, tokens: {} };
    const ignoredHere = map.ignored?.find(i => i.sheet === sheet.name);
    wrap.append(renderSheet({ el, sheet, table, ignoredHere, touch }));
  }

  refreshSummary();
  confirmBtn.onclick = () => confirmMap(map);
  wrap.append(el('div', { class: 'imp-footer' }, summary, confirmBtn));
  return wrap;
}

function renderSheet({ el, sheet, table, ignoredHere, touch }) {
  const box = el('details', { class: 'imp-sheet', open: table.role === 'requirements' ? '' : null });
  const head = el('summary', {},
    el('span', { class: 'imp-name' }, sheet.name),
    el('span', { class: 'muted' }, ` ${sheet.height}×${sheet.width}`));
  if (sheet.state !== 'visible') head.append(el('span', { class: 'badge suspect' }, sheet.state));
  if (sheet.dropdowns?.length) head.append(el('span', { class: 'badge' }, `${sheet.dropdowns.length} dropdown${sheet.dropdowns.length === 1 ? '' : 's'}`));
  head.append(el('span', { class: 'imp-role-tag' }, ignoredHere ? `ignored — ${ignoredHere.why}` : table.role));
  box.append(head);

  if (ignoredHere) {
    box.append(el('p', { class: 'muted' }, 'Hidden and `_`-prefixed sheets are never read, never written to a CSV and never shown to an agent.'));
    return box;
  }

  // Role.
  const roleSel = el('select', {},
    ...['requirements', 'context', 'ignored'].map(r => el('option', { value: r, selected: table.role === r ? '' : null },
      r === 'requirements' ? 'Requirement table' : r === 'context' ? 'Context' : 'Ignore this tab')));
  roleSel.onchange = () => { table.role = roleSel.value; box.classList.toggle('is-req', table.role === 'requirements'); rows.hidden = table.role !== 'requirements'; touch(); };
  box.append(el('div', { class: 'imp-row' }, el('label', {}, 'This tab is'), roleSel));

  // Header row and data range.
  // Assigned once the column list exists; changing the header row re-runs it.
  let onHeaderRowChange = () => {};
  const num = (label, key, min = 1) => {
    const input = el('input', { type: 'number', min: String(min), value: table[key] == null ? '' : String(table[key]) });
    input.oninput = () => {
      table[key] = input.value === '' ? null : Number(input.value);
      if (key === 'headerRow') onHeaderRowChange();
      touch();
    };
    return el('label', { class: 'imp-num' }, label, input);
  };
  const rows = el('div', { class: 'imp-rows', hidden: table.role === 'requirements' ? null : '' },
    el('div', { class: 'imp-row' }, num('Header row', 'headerRow'), num('First data row', 'firstDataRow'), num('Last data row', 'lastDataRow')));

  // Columns, named by their own header text. The header row decides which row those names come
  // from, so moving it rebuilds this list and re-marks the preview — without that, a table that
  // starts mid-sheet (the case this screen exists for) would be mapped against row 1's names.
  const grid = el('div', { class: 'imp-cols' });
  const preview = el('div', { class: 'imp-previewhost' });
  function renderColumns() {
    grid.innerHTML = '';
    const header = sheet.preview[(table.headerRow || 1) - 1] || [];
    header.forEach((text, i) => {
      if (!String(text).trim()) return;
      const col = colName(i + 1);
      const sel = el('select', {}, ...ROLES.map(([v, label]) => el('option', { value: v, selected: roleOf(table, col) === v ? '' : null }, label)));
      sel.onchange = () => { setRole(table, col, sel.value); touch(); };
      grid.append(el('div', { class: 'imp-col' }, el('span', { class: 'imp-colref' }, col), el('span', { class: 'imp-colhead' }, String(text)), sel));
    });
    preview.innerHTML = '';
    preview.append(renderPreview({ el, sheet, table }));
  }
  onHeaderRowChange = renderColumns;
  rows.append(grid);

  // Token lists, prefilled from the sheet's own dropdowns.
  for (const role of ['priority', 'compliance']) {
    const col = table.columns?.[role];
    if (!col) continue;
    const dd = (sheet.dropdowns || []).find(d => {
      const m = /^([A-Z]+)\d+(?::([A-Z]+)\d+)?/.exec(d.sqref || '');
      if (!m) return false;
      const c = colNum(col);
      return c >= colNum(m[1]) && c <= colNum(m[2] || m[1]);
    });
    const input = el('input', { type: 'text', value: (table.tokens?.[role] || []).join(', ') });
    input.oninput = () => {
      table.tokens = table.tokens || {};
      table.tokens[role] = input.value.split(',').map(s => s.trim()).filter(Boolean);
      touch();
    };
    rows.append(el('div', { class: 'imp-row' },
      el('label', {}, `${role === 'priority' ? 'Priority' : 'Compliance'} values`), input,
      el('span', { class: 'muted' }, dd ? `from the dropdown on ${dd.sqref}` : 'typed')));
  }

  box.append(rows);
  renderColumns();
  box.append(preview);
  return box;
}

/** The first rows as the workbook has them, so the header row can be recognised at a glance. */
function renderPreview({ el, sheet, table }) {
  const t = el('table', { class: 'imp-preview' });
  const body = el('tbody');
  sheet.preview.slice(0, 12).forEach((row, i) => {
    const n = i + 1;
    const tr = el('tr', { class: n === table.headerRow ? 'is-header' : null },
      el('td', { class: 'imp-rownum' }, String(n)),
      ...row.slice(0, 12).map(cell => el('td', {}, String(cell).slice(0, 60))));
    body.append(tr);
  });
  t.append(body);
  return el('div', { class: 'grid-wrap' }, t);
}
