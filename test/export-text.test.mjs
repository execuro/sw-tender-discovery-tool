import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportText, resolveTable } from '../lib/export-text.mjs';

const TOKENS = { OOTB: 'Fully compliant', Configuration: 'Fully compliant', Extension: 'Partially compliant', ISV: 'Partially compliant', Custom: 'Not compliant', '—': 'N/A' };

const confirmed = (overrides = {}) => ({
  id: 'HIB-02', coverage: 'Extension', effort: { size: 'M', pd: 4, regime: 'T-shirt' },
  clientResponse: 'We extend the storefront with a branch-level stock panel.',
  assumptions: ['Branch stock comes from the nightly ERP sync'],
  status: { kind: 'confirmed', date: '2026-09-01', cq: null },
  ...overrides,
});

test('X-1: an unconfirmed item exports with every field empty', () => {
  for (const kind of ['queued', 'estimated', 'blocked', 'failed', 'reopened']) {
    const r = exportText(confirmed({ status: { kind } }), { tokens: TOKENS });
    assert.deepEqual(r, { token: '', response: '', effort: '', assumptions: '', tokenPending: false });
  }
  assert.deepEqual(exportText(null, { tokens: TOKENS }), { token: '', response: '', effort: '', assumptions: '', tokenPending: false });
});

test('E-6: effort is the PD number only, as a string', () => {
  const r = exportText(confirmed(), { tokens: TOKENS });
  assert.equal(r.effort, '4');
  const ootb = exportText(confirmed({ coverage: 'OOTB', effort: { size: '—', pd: 0, regime: 'T-shirt' } }), { tokens: TOKENS });
  assert.equal(ootb.effort, '0');
  const none = exportText(confirmed({ effort: null }), { tokens: TOKENS });
  assert.equal(none.effort, '');
});

test('X-3: the compliance token comes from the mapped coverage; "—" maps too', () => {
  assert.equal(exportText(confirmed(), { tokens: TOKENS }).token, 'Partially compliant');
  assert.equal(exportText(confirmed({ coverage: '—' }), { tokens: TOKENS }).token, 'N/A');
});

test('#7: an unassessed item (Requirement Coverage empty, `null`) exports an empty token — never the "—" token', () => {
  assert.equal(exportText(confirmed({ coverage: null }), { tokens: TOKENS }).token, '');
});

test('X-3/D-11: a mapped assumptions column gets the bullets; the response cell is the Client Response only', () => {
  const r = exportText(confirmed(), { tokens: TOKENS, assumptionsColumn: true });
  assert.equal(r.response, 'We extend the storefront with a branch-level stock panel.');
  assert.equal(r.assumptions, '- Branch stock comes from the nightly ERP sync');
});

test('X-3/D-11: no assumptions column — bullets follow the Client Response in the same cell', () => {
  const r = exportText(confirmed(), { tokens: TOKENS, assumptionsColumn: false });
  assert.equal(r.response, 'We extend the storefront with a branch-level stock panel.\n- Branch stock comes from the nightly ERP sync');
  assert.equal(r.assumptions, '');
});

test('no accepted assumptions: response is the Client Response verbatim, no trailing bullets', () => {
  const r = exportText(confirmed({ assumptions: [] }), { tokens: TOKENS });
  assert.equal(r.response, 'We extend the storefront with a branch-level stock panel.');
});

// ---------------------------------------------------------------- RC-4 preview label (X-6)

test('tokenPending: the preview shows the raw coverage value and flags it pending when the caller says the table\'s tokens are not mapped yet', () => {
  const r = exportText(confirmed(), { tokens: {}, tokenPending: true }, { preview: true });
  assert.equal(r.token, 'Extension', 'the raw six-value coverage, until the client token is mapped');
  assert.equal(r.tokenPending, true);
});

test('tokenPending: never set outside preview — the export itself only ever reaches this point once tokens are mapped', () => {
  const r = exportText(confirmed(), { tokens: {}, tokenPending: true });
  assert.equal(r.tokenPending, false);
});

test('tokenPending: false once the table has a real token map, even in preview', () => {
  const r = exportText(confirmed(), { tokens: TOKENS, tokenPending: true }, { preview: true });
  assert.equal(r.tokenPending, false);
});

test('tokenPending: false for an unassessed item (no coverage value to be pending about)', () => {
  const r = exportText(confirmed({ coverage: null }), { tokens: {}, tokenPending: true }, { preview: true });
  assert.equal(r.tokenPending, false);
});

// ---------------------------------------------------------------- resolveTable (contract §4: pointer -> tables[].key)

test('resolveTable: resolves via the fit-back map pointer (map.items[id].table -> tables[].key), not by area/sheet', () => {
  const item = { id: 'GEN-01', area: 'Requirements' };
  const table = { key: '2 Requirements r1', sheet: 'Requirements', columns: { compliance: 'E' }, tokens: {} };
  const map = { tables: [table], items: { 'GEN-01': { table: '2 Requirements r1', sheet: 'Requirements', row: 2 } } };
  assert.equal(resolveTable(map, item).tokenPending, true);

  table.tokens.coverage = { OOTB: 'Stock', Configuration: 'Config', Extension: 'Config', ISV: 'Custom', Custom: 'Custom', '—': 'Stock' };
  assert.equal(resolveTable(map, item).tokenPending, false, 'a real token map is no longer pending');

  const noCompliance = { key: 'Requirements r1', sheet: 'Requirements', columns: {}, tokens: {} };
  const map2 = { tables: [noCompliance], items: { 'GEN-01': { table: 'Requirements r1', sheet: 'Requirements', row: 2 } } };
  assert.equal(resolveTable(map2, item).tokenPending, false, 'no compliance column, nothing to map');

  // CSV/PDF: no fit-back map at all — `resolveTable(null/undefined, item)` is exactly what the
  // page and `exportWorkbook`'s working-sheet path see.
  assert.equal(resolveTable(null, item).tokenPending, false);
});

test('resolveTable: an item with no pointer resolves to the empty defaults (contract §4: "not written" case)', () => {
  const item = { id: 'GEN-99' };
  const map = { tables: [{ key: 'Requirements r1', sheet: 'Requirements', columns: { compliance: 'E' }, tokens: {} }], items: {} };
  assert.deepEqual(resolveTable(map, item), { tokens: {}, assumptionsColumn: false, complianceLegend: null, tokenPending: false });
});

test('resolveTable: two items pointing at different tables (by key) each get their own table, never the map\'s first one', () => {
  const itemA = { id: 'GEN-01' }, itemB = { id: 'GEN-02' };
  const tableA = { key: 'Sheet A r1', sheet: 'Sheet A', columns: { compliance: 'E' }, tokens: { coverage: { OOTB: 'Erfuellt' } } };
  const tableB = { key: 'Sheet B r1', sheet: 'Sheet B', columns: { compliance: 'E' }, tokens: { coverage: { OOTB: 'Ja' } } };
  const map = {
    tables: [tableA, tableB],
    items: { 'GEN-01': { table: 'Sheet A r1', sheet: 'Sheet A', row: 2 }, 'GEN-02': { table: 'Sheet B r1', sheet: 'Sheet B', row: 2 } },
  };
  assert.equal(resolveTable(map, itemA).tokens.OOTB, 'Erfuellt');
  assert.equal(resolveTable(map, itemB).tokens.OOTB, 'Ja');
});
