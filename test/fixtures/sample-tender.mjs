// A complete, fictional tender workbook, built byte-by-byte.
//
// The suite used to reach outside the package for one real client's workbook.
// That made four tests silently skip in any clone that did not have it, put a
// real client's name in the repository, and tied the package to a directory
// above its own root. This builds the same *shapes* from nothing:
//
//   - nine sheets, the last one hidden and carrying merges
//   - a requirements table with its header on row 1 and 91 data rows
//   - a second requirements table whose header sits on row 20, which is the
//     case a per-sheet CSV export cannot express
//   - dropdown (data-validation) token lists that exist nowhere else
//   - vendor answer columns, and cost columns that must never be written into
//
// Everything in it is invented. "Nordwind Handel" is not a real company.

import { buildWorkbook } from '../helpers/mkxlsx.mjs';

const REQ_HEADER = [
  'ID', 'Area', 'Sub-area', 'Title', 'Requirement', 'Priority', 'Type',
  'Acceptance criteria / Notes', 'Reference',
  'Vendor: Compliance', 'Vendor: Comment', 'Vendor: Effort (PD)',
  'Vendor: One-off cost (EUR)', 'Vendor: Recurring cost (EUR)',
];

const PRIORITIES = ['Must', 'Should', 'Could'];
const AREAS = ['Catalogue', 'Checkout', 'Account', 'Search', 'Integration'];

/** `n` invented requirement rows, ids `<prefix>-01`, `<prefix>-02`, … */
function requirementRows(prefix, n, startIndex = 1) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const num = String(startIndex + i).padStart(2, '0');
    rows.push([
      `${prefix}-${num}`,
      AREAS[i % AREAS.length],
      `Sub-area ${(i % 4) + 1}`,
      `Requirement ${prefix}-${num}`,
      `The system shall satisfy invented requirement ${prefix}-${num}.`,
      PRIORITIES[i % PRIORITIES.length],
      i % 5 === 0 ? 'Non-functional' : 'Functional',
      `Acceptance note for ${prefix}-${num}.`,
      `§${(i % 9) + 1}.${(i % 3) + 1}`,
    ]);
  }
  return rows;
}

/** Rows of a plain context table: a header and `n` rows, no vendor columns. */
function contextRows(header, n, cell) {
  const rows = [header];
  for (let i = 1; i <= n; i++) rows.push(header.map((_, c) => cell(i, c)));
  return rows;
}

export function sampleTenderWorkbook() {
  // --- 2 Requirements: header row 1, 91 data rows (grid height 92).
  const requirements = {
    name: '2 Requirements',
    rows: [REQ_HEADER, ...requirementRows('GEN', 91)],
    validations: [
      { sqref: 'F2:F92', values: PRIORITIES },
      { sqref: 'J2:J92', values: ['Stock', 'Config', 'Plugin', 'Custom', 'Not offered'] },
    ],
  };

  // --- 3 Non-functional & Compliance: a second answerable table.
  const nonFunctional = {
    name: '3 Non-functional & Compliance',
    rows: [REQ_HEADER, ...requirementRows('NFR', 24)],
    validations: [{ sqref: 'J2:J25', values: ['Stock', 'Config', 'Plugin', 'Custom', 'Not offered'] }],
  };

  // --- 6 Vendor Response & Evaluation: the mid-sheet table. Nineteen rows of
  //     preamble, the header on row 20, data from row 21.
  const preamble = [];
  for (let r = 1; r <= 19; r++) {
    preamble.push(r === 1 ? ['Vendor response and evaluation'] : [r === 3 ? 'Complete the table below.' : '']);
  }
  const vendorEval = {
    name: '6 Vendor Response & Evaluation',
    rows: [...preamble, REQ_HEADER, ...requirementRows('PRJ', 10)],
    validations: [{ sqref: 'J21:J30', values: ['Stock', 'Config', 'Plugin', 'Custom', 'Not offered'] }],
  };

  // --- the hidden answer key: merges live here, and nothing may ever read it.
  const answerKey = {
    name: '_answer_key',
    state: 'hidden',
    rows: [
      ['Internal scoring — do not share'],
      ['ID', 'Expected class', 'Expected PD'],
      ['GEN-01', 'Config', 1.5],
      ['GEN-02', 'Custom', 8],
      ['GEN-03', 'Stock', 0],
    ],
    merges: ['A1:C1', 'E1:F1', 'E2:F2', 'E3:F3', 'E4:F4'],
  };

  return buildWorkbook([
    {
      name: '0 Cover',
      rows: [['Request for Proposal'], ['Nordwind Handel GmbH'], ['Replatforming to Shopware 6'], ['Response due', '2026-12-01']],
    },
    {
      name: '1 Company & Context',
      rows: contextRows(['Topic', 'Value'], 12, (r, c) => (c === 0 ? `Topic ${r}` : `Value ${r}`)),
    },
    requirements,
    nonFunctional,
    {
      name: '4 Integrations',
      rows: contextRows(['System', 'Direction', 'Protocol', 'Notes'], 9,
        (r, c) => ['ERP', 'PIM', 'CRM'][r % 3] + (c === 0 ? ` ${r}` : ` detail ${c}`)),
    },
    {
      name: '5 Migration Inventory',
      rows: contextRows(['Object', 'Source', 'Volume', 'Notes'], 11,
        (r, c) => (c === 2 ? String(r * 1000) : `Object ${r} field ${c}`)),
    },
    vendorEval,
    {
      name: '7 Glossary',
      rows: contextRows(['Term', 'Definition'], 14, (r, c) => (c === 0 ? `Term ${r}` : `Definition of term ${r}`)),
    },
    answerKey,
  ], { shared: true });
}
