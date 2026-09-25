// The exact text `export` writes for one scope item — the same helper drives the
// page's X-6 preview, so what the operator sees is what gets written. Contract §4.
//
// Unconfirmed scope items export with empty answer cells (X-1): this helper implements
// that rule too, so the preview and the export can never disagree.

/**
 * `exportText(item, { tokens, assumptionsColumn, regime, tokenPending }, { preview })` →
 * `{ token, response, effort, assumptions, tokenPending }`.
 * - Unconfirmed item: every field is `''` — unless `preview` is set (X-6/R-4): the preview shows
 *   the exact text the export WILL write once the item is confirmed; the export itself (no
 *   `preview`) always keeps an unconfirmed item's fields empty.
 * - No client token map (`tokens` empty — CSV/PDF source, contract §4 N-5; or an xlsx table whose
 *   coverage tokens are not mapped yet, RC-4): the token is the six-value Requirement Coverage
 *   as-is, the same value `xlsx-build.mjs`'s working-sheet export writes into its Requirement
 *   Coverage column — preview and export must never disagree there.
 * - `tokenPending` (X-6, preview only): true when the caller flags the table as unmapped AND
 *   there genuinely is no token map (`hasTokenMap` below is the ground truth) — the page labels
 *   the raw coverage value "(client token set at export)" until `tokens --file` maps it; always
 *   false for a CSV/PDF source (no mapping ever happens there) and for the export itself (export
 *   refuses first, see `exportWorkbook`).
 * - `effort`: the PD number only, as a string (E-6); `''` when not estimated.
 * - With a mapped assumptions column: assumptions go there, one bullet per line.
 * - Without one: assumptions follow the Client Response in `response`, as `\n- ` bullets (D-11).
 * - `complianceLegend` (T2): when the client's compliance column comes from a numeric-key legend
 *   (e.g. a 0-4 RATING legend a `=SUM` elsewhere on the sheet reads), `token` is the legend's
 *   NUMBER for the mapped token, not its label text, so the client's formulas keep computing.
 */
export function exportText(item, { tokens = {}, assumptionsColumn = false, complianceLegend = null, tokenPending = false } = {}, { preview = false } = {}) {
  const empty = { token: '', response: '', effort: '', assumptions: '', tokenPending: false };
  if (!item) return empty;
  if (!preview && item.status?.kind !== 'confirmed') return empty;

  // #7: `null` means not assessed (parse.mjs's empty Requirement Coverage cell) — distinct from
  // `—`, one of the six values in its own right ("non-Shopware work"). An unassessed item exports
  // an empty token, never the `—` token.
  const coverageKey = item.coverage;
  // No client token map: `import-map.mjs`'s `guessCoverageTokenMap` always returns the six keys,
  // empty string when nothing was guessed (a CSV/PDF source has no dropdown to guess from at
  // all) — so "there is a map" means at least one of its values is non-empty, not "the object
  // has keys".
  const hasTokenMap = tokens && Object.values(tokens).some(v => v);
  const tokenText = coverageKey == null ? '' : (hasTokenMap ? (tokens[coverageKey] ?? '') : coverageKey);
  const token = complianceLegend && Object.prototype.hasOwnProperty.call(complianceLegend, tokenText)
    ? complianceLegend[tokenText]
    : tokenText;
  const effort = item.effort && typeof item.effort.pd === 'number' ? String(item.effort.pd) : '';
  const bullets = (item.assumptions || []).map(a => `- ${a}`);
  // `hasTokenMap` is the ground truth (a real token already resolved above beats a caller's own
  // `tokenPending` guess) — `tokenPending` only adds the CSV/PDF-vs-xlsx distinction `tokens`
  // alone cannot make (both read as "no map" once flattened to this function's own inputs).
  const pending = Boolean(preview && tokenPending && !hasTokenMap && coverageKey != null);

  if (assumptionsColumn) {
    return { token, response: item.clientResponse || '', effort, assumptions: bullets.join('\n'), tokenPending: pending };
  }
  const response = bullets.length
    ? `${item.clientResponse || ''}${bullets.map(b => `\n${b}`).join('')}`
    : (item.clientResponse || '');
  return { token, response, effort, assumptions: '', tokenPending: pending };
}

/**
 * One item's requirement table, resolved via the fit-back map's pointer (contract §4):
 * `map.items[item.id].table` names a `tables[].key`, not an area/sheet — the single resolver
 * `exportText`'s three callers (the page preview, the surgical xlsx export and the working-sheet
 * export) share, so an item is never matched against the wrong table by a coincidentally equal
 * sheet name. Returns `{ tokens, assumptionsColumn, complianceLegend, tokenPending }`,
 * empty/false/null when the item has no pointer or the map has no matching table. `tokenPending`:
 * this IS a confirmed xlsx requirements table with a compliance column, but `tokens --file` has
 * not written its coverage map yet (RC-4) — false for a CSV/PDF source, which has no fit-back map
 * at all.
 */
export function resolveTable(map, item) {
  const pointer = map?.items?.[item?.id];
  const table = pointer && (map.tables || []).find(t => t.key === pointer.table);
  const coverage = table?.tokens?.coverage || {};
  return {
    tokens: coverage,
    assumptionsColumn: Boolean(table?.assumptionsColumn),
    complianceLegend: table?.tokens?.complianceLegend || null,
    tokenPending: Boolean(table?.columns?.compliance) && !Object.values(coverage).some(v => v),
  };
}
