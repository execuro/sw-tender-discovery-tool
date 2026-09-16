// §4 grid client/cost columns - pure, DOM-free, so it can be unit tested without a browser.
//
// The server sends the confirmed mapping's own client columns and cost columns
// (lib/source.mjs:loadRequirementColumns -> sourceColumns on /api/session). These constants are
// only the fallback for a tender that has not confirmed a mapping yet (CSV/markdown/PDF source).
export const CLIENT_COLS = [
  { key: 'Area' }, { key: 'Sub-area' }, { key: 'Title', cls: 'mid-col' }, { key: 'Requirement', long: true },
  { key: 'Priority' }, { key: 'Type' }, { key: 'Acceptance criteria / Notes', long: true }, { key: 'Reference', cls: 'mid-col' },
];
export const COST_HEADERS = ['Vendor: One-off cost (EUR)', 'Vendor: Recurring cost / year (EUR)'];

/** The columns to render: the mapping-derived list when the session has one, else the fallback. */
export function clientCols(sourceCols) {
  return sourceCols?.columns?.length ? sourceCols.columns : CLIENT_COLS;
}

/** Same rule for the two vendor cost headers. */
export function costCols(sourceCols) {
  return sourceCols?.costColumns?.length ? sourceCols.costColumns : COST_HEADERS;
}
