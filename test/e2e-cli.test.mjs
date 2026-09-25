// End-to-end, no page: the whole own-tabs workflow through `bin/cli.mjs` alone, on a tmp copy of
// the real sample workbook in a tmp repo (a `.git` folder so root resolution works, `specs/`
// inside) — exactly as an operator with no browser open would run it. Build contract
// `own-tabs-contract.md`.
//
//   import -> intake --extraction <json> (a hand-made fixture, the shape a good extract agent
//   would return; intake confirms itself, own-tabs contract §3) -> (hand-written architect
//   report, as the skill would produce it) -> apply -> check --write -> report -> confirm ->
//   accept a proposal on the confirmed item (must reopen) -> answer the CQ -> export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, field, HERE } from './helpers.mjs';
import { parse } from '../lib/parse.mjs';

const REAL_SPECS = path.join(HERE, '..', '..', '..', '..', 'specs');
const SAMPLE = 'rfp-0001-hartmann-industriebedarf-replatforming.xlsx';
const SLUG = 'rfp-0001-hartmann-industriebedarf-replatforming';
const ANALYSIS = `specs/${SLUG}-analysis.md`;
const EXTRACTION = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'rfp-0001-extraction.json'), 'utf8'));

function hostRepo() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tender-tool-e2e-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

test('operator, no page: import -> intake --extraction (confirms itself) -> apply -> check -> report -> confirm -> accept (reopens) -> answer -> export', async () => {
  const real = path.join(REAL_SPECS, SAMPLE);
  if (!fs.existsSync(real)) return; // sample not present in this checkout; nothing to run against

  const root = hostRepo();
  try {
    fs.copyFileSync(real, path.join(root, 'specs', SAMPLE));

    // 1. import: writes the snapshot, the proposed mapping and the digest — no wizard any more.
    const imported = await run(['import', '--source', `specs/${SAMPLE}`], root);
    assert.equal(imported.code, 0, imported.out + imported.err);
    assert.match(imported.out, /^digest: /m);

    // 2. intake --extraction: builds §4 from the extraction (a hand-made fixture standing in for
    // the skill's own `extract` job output).
    fs.writeFileSync(path.join(root, 'extraction.json'), JSON.stringify(EXTRACTION));
    const intook = await run(['intake', ANALYSIS, '--source', `specs/${SAMPLE}`, '--extraction', 'extraction.json'], root);
    assert.equal(intook.code, 0, intook.out + intook.err);
    assert.match(intook.out, /^added: \d+$/m);

    const text0 = fs.readFileSync(path.join(root, ANALYSIS), 'utf8');
    // Own-tabs contract §3: intake confirms itself — no review step, no separate `intake-confirm`.
    assert.match(text0, /^intake: confirmed$/m);
    const model0 = parse(text0, { path: path.join(root, ANALYSIS) });
    assert.deepEqual(model0.errors, []);
    const ids = model0.items.map(i => i.id);
    assert.ok(ids.length >= 3, `expected at least 3 scope items, got ${ids.length}`);
    const [ootbId, isvId, blockedId] = ids;

    // 3. backward compatibility: `intake-confirm` on an already-confirmed document is a harmless
    // no-op ("already confirmed"), never a second confirmation step.
    const confirmedIntake = await run(['intake-confirm', ANALYSIS], root);
    assert.equal(confirmedIntake.code, 0, confirmedIntake.out + confirmedIntake.err);
    assert.match(confirmedIntake.out, /already confirmed/);
    assert.match(fs.readFileSync(path.join(root, ANALYSIS), 'utf8'), /^intake: confirmed$/m);

    // 4. a hand-written architect report, exactly the shape the skill would produce: one OOTB
    // item, one ISV item (with a proposal, so step 8 has something to accept), one blocked by a
    // brand-new CQ with a fallback.
    const report = {
      cause: 'analyze group 1',
      items: [
        // No size sent for the OOTB item: D-6 auto-fills — (0 PD) from the coverage alone.
        { id: ootbId, coverage: 'OOTB', confidence: 'high', clientResponse: 'Stock Shopware covers this out of the box.', references: ['kb: OOTB coverage'] },
        {
          id: isvId, coverage: 'ISV', confidence: 'medium', size: 'M',
          clientResponse: 'An existing Store extension covers this; we install, configure and map the fields.',
          references: ['isv: Example Connector · Acme Software · 6.6, 6.7 · https://store.shopware.com/example-connector'],
          // AQ-2: a suggestion is mandatory for a non-OOTB coverage — noProposal is only accepted
          // once the item already has an accepted assumption covering it, which is not the case yet
          // here, so this first apply sends a real proposal too (step 9 adds a second one later).
          proposals: [{ statement: 'The client accepts the extension\'s bundled default settings.', pdSaved: 0.5 }],
        },
        { id: blockedId, blockedBy: 'new:0' },
      ],
      questions: [{ items: [blockedId], question: 'Is the default field mapping acceptable, or does it need a custom mapping?', options: [{ key: 'A', text: 'Default mapping', effect: 'no extra effort' }, { key: 'B', text: 'Custom mapping', effect: '+2 PD' }], fallback: 'A' }],
    };
    const reportFile = path.join(root, 'report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report));

    // 5. apply.
    const applied = await run(['apply', ANALYSIS, '--report', 'report.json'], root);
    assert.equal(applied.code, 0, applied.out + applied.err);

    let text = fs.readFileSync(path.join(root, ANALYSIS), 'utf8');
    assert.match(text, new RegExp(`\\| ${ootbId} \\| .* \\| OOTB \\|`));
    assert.match(text, /### CQ-1 ·/);

    // 6/7. check --write, then report.
    const checked = await run(['check', ANALYSIS, '--write'], root);
    assert.equal(checked.code, 0, checked.out + checked.err);
    const reported1 = await run(['report', ANALYSIS], root);
    assert.equal(reported1.code, 0, reported1.out + reported1.err);
    assert.match(reported1.out, /^estimation_by_priority:/m);

    // 8. confirm the OOTB item.
    const confirmed = await run(['confirm', ANALYSIS, ootbId], root);
    assert.equal(confirmed.code, 0, confirmed.out + confirmed.err);
    text = fs.readFileSync(path.join(root, ANALYSIS), 'utf8');
    assert.match(text, new RegExp(`\\| ${ootbId} \\| .* \\| confirmed \\d{4}-\\d{2}-\\d{2} \\|`));

    // 9. confirm the ISV item too. A bulk/single confirm rejects any *waiting* proposal on the
    // item it confirms (L-1/L-2), so the proposal to accept has to arrive afterwards — exactly
    // as it would from a later `reestimate` run's report.
    await run(['confirm', ANALYSIS, isvId], root);
    const proposalReport = { cause: 'reestimate: partner asset found', items: [{ id: isvId, proposals: [{ statement: 'The client accepts the extension\'s default field mapping.', pdSaved: 1 }] }] };
    fs.writeFileSync(path.join(root, 'report2.json'), JSON.stringify(proposalReport));
    const reapplied = await run(['apply', ANALYSIS, '--report', 'report2.json'], root);
    assert.equal(reapplied.code, 0, reapplied.out + reapplied.err);

    const pMatch = fs.readFileSync(path.join(root, 'specs', '.rfp', SLUG, 'proposals.json'), 'utf8');
    const proposalId = JSON.parse(pMatch).find(p => p.item === isvId && p.status === 'waiting')?.id;
    assert.ok(proposalId, 'the ISV item\'s new proposal must be on record and waiting');
    const accepted = await run(['accept', ANALYSIS, proposalId], root);
    assert.equal(accepted.code, 0, accepted.out + accepted.err);
    text = fs.readFileSync(path.join(root, ANALYSIS), 'utf8');
    assert.match(text, new RegExp(`\\| ${isvId} \\| .* \\| reopened \\|`), 'accepting a proposal on a confirmed item must reopen it immediately');

    // 10. answer the CQ that blocked the third item.
    const answered = await run(['answer', ANALYSIS, 'CQ-1', 'A'], root);
    assert.equal(answered.code, 0, answered.out + answered.err);
    text = fs.readFileSync(path.join(root, ANALYSIS), 'utf8');
    assert.match(text, /Answered \d{4}-\d{2}-\d{2}: A/);

    // final check/report, then export.
    const checked2 = await run(['check', ANALYSIS, '--write'], root);
    assert.equal(checked2.code, 0, checked2.out + checked2.err);
    const reported2 = await run(['report', ANALYSIS], root);
    assert.equal(reported2.code, 0, reported2.out + reported2.err);
    assert.match(reported2.out, /^confirmed: 1 of \d+$/m);

    // 11. RC-4, decided agentically at export time: export first refuses (coverage tokens not
    // mapped yet), the agent runs `tokens --suggest`, decides the six-value -> client-token map
    // (here: takes the heuristic's own suggestion), writes it with `tokens --file` (keyed by the
    // fit-back map's own table `key`, contract §4), then exports — the file then carries real
    // client tokens, not our words.
    const refused = await run(['export', ANALYSIS], root);
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.match(refused.err, /coverage tokens not mapped/);

    const suggested = await run(['tokens', ANALYSIS, '--suggest'], root);
    assert.equal(suggested.code, 0, suggested.out + suggested.err);
    const suggestedPayload = JSON.parse(suggested.out.slice(suggested.out.indexOf('{')));
    const keys = Object.keys(suggestedPayload.tables);
    assert.ok(keys.length > 0, 'sample A has at least one requirements table with a compliance column');
    const tokensMap = Object.fromEntries(keys.map(key => [key, suggestedPayload.tables[key].suggested]));
    fs.writeFileSync(path.join(root, 'tokens.json'), JSON.stringify(tokensMap));

    const tokensApplied = await run(['tokens', ANALYSIS, '--file', 'tokens.json'], root);
    assert.equal(tokensApplied.code, 0, tokensApplied.out + tokensApplied.err);

    const exported = await run(['export', ANALYSIS], root);
    assert.equal(exported.code, 0, exported.out + exported.err);
    assert.match(exported.out, /^wrote: /m);
    const outFile = field(exported.out, 'wrote').split(' (')[0];
    assert.ok(fs.existsSync(path.join(root, outFile)), `export did not write ${outFile}`);
    // The first export's own `changed_since_last` names the id(s), not only the count (the §8 Log
    // line, checked separately, keeps the bare count).
    assert.equal(field(exported.out, 'changed_since_last'), `1 (${ootbId})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
