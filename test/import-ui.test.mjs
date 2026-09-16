// The steering screen's logic, exercised without a browser: `page/import.js` touches the DOM only
// through the `el` factory the page injects, so a tiny stub is enough to render it here and assert
// what the architect actually does — change a tab's role, move a header row, map a column, edit a
// token list — instead of leaving the whole screen untested. This is mapping logic, not layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderImportPanel, roleOf, setRole, colName, colNum } from '../page/import.js';
import { CLIENT_COLS, COST_HEADERS, clientCols, costCols } from '../page/req-cols.js';

/** Minimal stand-in for the page's `el`: enough structure to find nodes and fire handlers. */
function stubEl(tag, attrs = {}, ...kids) {
  const node = {
    tag, attrs, children: [], classList: new Set(), hidden: false, value: attrs.value ?? '',
    append(...cs) { for (const c of cs.flat()) if (c != null && c !== '') this.children.push(c); },
    querySelectorAll(pred) { return find(this, pred); },
  };
  // `innerHTML = ''` is how the screen clears a list before rebuilding it; in a real DOM that
  // drops the children, so the stub does too — otherwise a rebuild would look like a duplicate.
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; },
    set(v) { if (!v) this.children = []; },
  });
  node.classList = {
    set: new Set(String(attrs.class || '').split(/\s+/).filter(Boolean)),
    add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
    toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
    contains(c) { return this.set.has(c); },
  };
  for (const [k, v] of Object.entries(attrs)) if (typeof v === 'function') node[k] = v;
  node.append(...kids);
  return node;
}

/** Depth-first walk collecting every node that matches. */
function find(node, pred, out = []) {
  if (typeof node !== 'object' || node === null) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) find(c, pred, out);
  return out;
}
const byTag = (root, tag) => find(root, n => n.tag === tag);
const byClass = (root, cls) => find(root, n => n.classList?.contains?.(cls));
const text = node => (node.children || []).filter(c => typeof c === 'string').join('');

/** One requirement table whose data starts mid-sheet, like the sample's vendor-response tab. */
function state() {
  return {
    available: true,
    source: 'specs/rfp-0099-mini.xlsx',
    confirmedAt: null,
    stale: false,
    sheets: [
      {
        index: 1, name: '1 Requirements', state: 'visible', width: 6, height: 4,
        dropdowns: [{ sqref: 'E2:E4', values: ['Stock', 'Custom'] }],
        preview: [
          ['Vendor response instructions', '', '', '', '', ''],
          ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment'],
          ['GEN-01', 'Shop', 'Accounts', 'Must', '', ''],
        ],
      },
      { index: 2, name: '_answer_key', state: 'hidden', width: 2, height: 2, dropdowns: [], preview: [['ID', 'Expected']] },
    ],
    map: {
      tables: [{
        n: 1, sheet: '1 Requirements', index: 1, slug: 'requirements', role: 'requirements',
        headerRow: 2, firstDataRow: 3, lastDataRow: 3,
        columns: { id: 'A', context: ['B'], requirement: 'C', priority: 'D', compliance: 'E', comment: 'F' },
        tokens: { compliance: ['Stock', 'Custom'] },
      }],
      ignored: [{ sheet: '_answer_key', why: 'hidden' }],
    },
  };
}

function render(overrides = {}) {
  const saved = [];
  const confirmed = [];
  const st = overrides.state || state();
  const panel = renderImportPanel({
    el: stubEl, state: st, closed: false,
    save: m => saved.push(m), confirm: m => confirmed.push(m), ...overrides,
  });
  return { panel, st, saved, confirmed };
}

// ---------------------------------------------------------------- pure helpers

test('colName / colNum round-trip', () => {
  assert.equal(colName(1), 'A');
  assert.equal(colName(27), 'AA');
  assert.equal(colNum('AA'), 27);
  for (const n of [1, 26, 27, 200, 16384]) assert.equal(colNum(colName(n)), n);
});

test('setRole keeps single-valued roles single and lets cost/context repeat', () => {
  const t = { columns: {} };
  setRole(t, 'A', 'id');
  setRole(t, 'B', 'requirement');
  assert.equal(roleOf(t, 'A'), 'id');
  assert.equal(roleOf(t, 'B'), 'requirement');

  // Moving `id` to another column releases the first one.
  setRole(t, 'C', 'id');
  assert.equal(t.columns.id, 'C');
  assert.equal(roleOf(t, 'A'), '');

  setRole(t, 'D', 'cost');
  setRole(t, 'E', 'cost');
  assert.deepEqual(t.columns.cost, ['D', 'E']);

  // A column can only hold one role: re-assigning removes it from the old list.
  setRole(t, 'D', 'context');
  assert.deepEqual(t.columns.cost, ['E']);
  assert.deepEqual(t.columns.context, ['D']);

  setRole(t, 'D', 'ignore');
  assert.equal(roleOf(t, 'D'), '');
  assert.deepEqual(t.columns.context, []);
});

// ---------------------------------------------------------------- the screen

test('renders one block per sheet, and never offers to map an ignored one', () => {
  const { panel } = render();
  const blocks = byClass(panel, 'imp-sheet');
  assert.equal(blocks.length, 2);
  // The hidden sheet gets no role select and no column mapping at all.
  assert.equal(byTag(blocks[1], 'select').length, 0);
  assert.ok(byTag(blocks[0], 'select').length > 1);
});

test('the column list is built from the header row, not from row 1', () => {
  const { panel } = render();
  const heads = byClass(panel, 'imp-colhead').map(text);
  assert.deepEqual(heads, ['ID', 'Area', 'Requirement', 'Priority', 'Vendor: Compliance', 'Vendor: Comment']);
  assert.ok(!heads.includes('Vendor response instructions'), 'the title row above the table is not a column list');
});

test('moving the header row rebuilds the column names — the mid-sheet case', () => {
  const { panel, st } = render();
  const headerInput = byTag(panel, 'input').find(i => i.attrs.type === 'number');
  headerInput.value = '1';
  headerInput.oninput();
  assert.equal(st.map.tables[0].headerRow, 1);
  const heads = byClass(panel, 'imp-colhead').map(text);
  assert.deepEqual(heads, ['Vendor response instructions'], 'the columns follow the header row');
});

test('changing a column role updates the mapping and saves a draft', async () => {
  const { panel, st, saved } = render();
  const selects = byTag(panel, 'select');
  const complianceSel = selects.find(s => s.attrs.value === undefined && s.children.some(o => o.attrs?.value === 'compliance'));
  complianceSel.value = 'effort';
  complianceSel.onchange();
  assert.equal(st.map.tables[0].columns.effort, 'A', 'the first mapped column took the new role');
  await new Promise(r => setTimeout(r, 450));
  assert.equal(saved.length, 1, 'the draft is saved, debounced');
});

test('token lists are prefilled from the dropdown and editable', () => {
  const { panel, st } = render();
  const textInputs = byTag(panel, 'input').filter(i => i.attrs.type === 'text');
  const tokenInput = textInputs.find(i => i.attrs.value === 'Stock, Custom');
  assert.ok(tokenInput, `the compliance tokens are prefilled (saw ${JSON.stringify(textInputs.map(i => i.attrs.value))})`);
  tokenInput.value = 'Stock, Config, Custom';
  tokenInput.oninput();
  assert.deepEqual(st.map.tables[0].tokens.compliance, ['Stock', 'Config', 'Custom']);
});

test('confirming hands the mapping back; an unmapped id column blocks it first', () => {
  const st = state();
  delete st.map.tables[0].columns.id;
  const blocked = render({ state: st });
  const btn = byTag(blocked.panel, 'button')[0];
  assert.equal(btn.disabled, true);
  assert.match(text(byClass(blocked.panel, 'imp-summary')[0]) || blocked.panel.summaryText || '', /.*/);

  const ok = render();
  const okBtn = byTag(ok.panel, 'button')[0];
  assert.equal(okBtn.disabled, false);
  okBtn.onclick();
  assert.equal(ok.confirmed.length, 1);
  assert.equal(ok.confirmed[0].tables[0].sheet, '1 Requirements');
});

// ---------------------------------------------------------------- §4 grid columns (page/app.js)

test('clientCols/costCols render the confirmed mapping, not the default constant', () => {
  const mapped = {
    available: true,
    columns: [{ key: 'Client Ref' }, { key: 'Ask', long: true }],
    costColumns: ['Vendor cost one-off', 'Vendor cost recurring'],
  };
  assert.deepEqual(clientCols(mapped), mapped.columns);
  assert.deepEqual(costCols(mapped), mapped.costColumns);
  assert.notDeepEqual(clientCols(mapped), CLIENT_COLS);
});

test('clientCols/costCols fall back to the defaults when no mapping columns are sent', () => {
  assert.deepEqual(clientCols({ available: false, columns: [] }), CLIENT_COLS);
  assert.deepEqual(costCols({ available: false, costColumns: [] }), COST_HEADERS);
  assert.deepEqual(clientCols(null), CLIENT_COLS);
});

test('a stale mapping is called out', () => {
  const st = state();
  st.stale = true;
  const { panel } = render({ state: st });
  assert.equal(byClass(panel, 'imp-stale').length, 1);
});
