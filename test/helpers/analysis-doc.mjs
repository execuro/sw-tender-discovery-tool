// A hand-built `-analysis.md` document, conforming to the own-tabs grammar (contract §1), for the
// export-side tests (WP-4). Built directly against `parse.mjs`'s own render helpers instead of
// going through `intake` — WP-4's write scope never touches `lib/intake.mjs`, and this decouples
// the export tests from that module's own concurrent rewrite (WP-3).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TABS, PROJECT_INFO, ITEM_HEADER, ITEM_HEADER_LINE, formatEffort, formatStatus, renderProjectInfo, renderNotTaken } from '../../lib/parse.mjs';

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

const escapeCell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
const bulletCell = list => (list || []).map(x => `- ${escapeCell(x)}`).join('<br>');

function renderItemRow(item) {
  const cells = [
    escapeCell(item.id), escapeCell(item.prio || ''), escapeCell(item.requirement), item.coverage || '', item.confidence || '',
    formatEffort(item.effort || null), escapeCell(item.clientResponse || ''),
    bulletCell(item.assumptions), escapeCell(item.internalNote || ''), bulletCell(item.references || []),
    formatStatus(item.status || { kind: 'queued' }),
  ];
  return `| ${cells.join(' | ')} |`;
}

/**
 * `groups`: `[{ tab, topic, items: [{ id, prio, requirement, status, coverage, effort,
 * clientResponse, assumptions, references }] }]`, one heading per group, rendered in `TABS` order
 * then given order within a tab (matching the contract's canonical render order for a document
 * this helper already builds pre-ordered).
 *
 * `projectInfo`: `[{ key, value, source }]`, sparse — any `PROJECT_INFO` key not given defaults to
 * `not stated` with an empty Source, exactly as an xlsx/csv intake would leave an untouched row.
 */
export function buildAnalysisDoc({
  slug = 'rfp-0900-mini', title = 'Test', sourceFile, sourceHash,
  intake = null, projectInfo = [], notTaken = [], groups = [],
  integrations = '', glossary = '',
} = {}) {
  const piByKey = new Map(projectInfo.map(p => [p.key, p]));
  const piRows = PROJECT_INFO.map(pi => {
    const found = piByKey.get(pi.key);
    return { label: pi.label, value: found?.value ?? 'not stated', source: found?.source ?? '' };
  });

  const fmLines = ['state: In progress', 'regime: T-shirt', 'source-sha256:', `  ${sourceFile}: ${sourceHash}`, `slug: ${slug}`];
  if (intake) fmLines.push(`intake: ${intake}`);

  const sep = `| ${ITEM_HEADER.map(() => '---').join(' | ')} |`;
  const scopeBlocks = [];
  for (const tab of TABS) {
    for (const g of groups.filter(x => x.tab === tab)) {
      scopeBlocks.push([`### ${tab} · ${g.topic}`, '', ITEM_HEADER_LINE, sep, ...g.items.map(renderItemRow)].join('\n'));
    }
  }

  return `---
${fmLines.join('\n')}
---
# ${title}

## 1. Context

${renderProjectInfo(piRows)}

${renderNotTaken(notTaken)}

## 2. Totals

<!-- totals:begin -->
<!-- totals:end -->

## 3. Global assumptions and exclusions

### Assumptions

### Exclusions

## 4. Scope items

${scopeBlocks.join('\n\n')}

## 5. Questions

## 6. Integrations

${integrations}

## 7. Glossary

${glossary}

## 8. Log
`;
}

/**
 * Writes the committed fit-back map (contract §4) at `<dir>/<base>/import-map.json` for an xlsx
 * source, the shape `readFitBack` (WP-3, `lib/import-map.mjs`) will also read once it lands — this
 * helper writes the file directly so WP-4's tests do not depend on `intake()`/`readFitBack`
 * existing yet. Returns the map object written.
 */
export function writeFitBackMap(sourceAbs, { tables = [], items = {}, unusedSheets = [], confirmedAt = null } = {}) {
  const dir = path.dirname(sourceAbs);
  const base = path.basename(sourceAbs, path.extname(sourceAbs));
  const map = {
    source: sourceAbs, sha256: fs.existsSync(sourceAbs) ? sha256(fs.readFileSync(sourceAbs)) : '',
    extractedAt: new Date().toISOString(), confirmedAt,
    tables, unusedSheets, items,
  };
  fs.mkdirSync(path.join(dir, base), { recursive: true });
  fs.writeFileSync(path.join(dir, base, 'import-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
  return map;
}
