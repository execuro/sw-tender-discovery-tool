// Static shape of page/index.html: the Notes panel is gone, replaced by the Agent card's
// Queued (n) accordion, and the panel is foldable to a slim rail. No browser needed — this is a
// plain text check against the shipped markup. The intake-card tests below check page/app.js and
// page/app.css the same way (no DOM in this suite), since the page has no jsdom-style harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', 'page', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(HERE, '..', 'page', 'app.js'), 'utf8');
const APP_CSS = fs.readFileSync(path.join(HERE, '..', 'page', 'app.css'), 'utf8');

test('index.html has no #notes-panel, #notes, #send-btn or #free-note-btn (Notes panel removed)', () => {
  for (const id of ['id="notes-panel"', 'id="notes"', 'id="send-btn"', 'id="free-note-btn"']) {
    assert.ok(!HTML.includes(id), `${id} should be gone`);
  }
});

test('index.html has the single Agent card with the Queued (n) accordion', () => {
  assert.match(HTML, /<h2>Agent<\/h2>/);
  assert.match(HTML, /id="queued"[^>]*class="queued"/);
  assert.match(HTML, /id="queued-toggle"/);
  assert.match(HTML, /id="queued-count"/);
  assert.match(HTML, /id="queued-clear"/);
});

test('index.html has the fold button, the rail and its reopen control', () => {
  assert.match(HTML, /id="panel-fold"/);
  assert.match(HTML, /id="panel-rail"/);
  assert.match(HTML, /id="panel-unfold"/);
});

// --- the "No working document yet" card's auto-started intake (opening intake queued by the server) ---

test('app.js: the intake card shows a spinner and the stage while intake is queued or running, not a bare button', () => {
  assert.match(APP_JS, /function intakeQueuedOrRunning\s*\(/);
  assert.match(APP_JS, /function intakeCardBody\s*\(/);
  assert.match(APP_JS, /Intake running/);
  assert.match(APP_JS, /class: 'spinner'/);
  // Queued behind another run is shown too, not just the active one.
  assert.match(APP_JS, /Intake queued/);
});

test('app.js: the intake card reads the latest progress line for the running batch from chat', () => {
  assert.match(APP_JS, /function intakeProgressLine\s*\(/);
  assert.match(APP_JS, /e\.type === 'progress'/);
});

test('app.js: renderDoc() re-runs on run and chat SSE events while there is no model yet', () => {
  const chatLine = APP_JS.split('\n').find(l => l.includes("addEventListener('chat'"));
  const runLine = APP_JS.split('\n').find(l => l.includes("addEventListener('run'"));
  assert.match(chatLine || '', /if \(!S\.model\) renderDoc\(\)/);
  assert.match(runLine || '', /if \(!S\.model\) renderDoc\(\)/);
});

test('app.css: the shared spinner and intake-running styles exist', () => {
  assert.match(APP_CSS, /\.spinner\s*\{/);
  assert.match(APP_CSS, /@keyframes spin\s*\{/);
  assert.match(APP_CSS, /\.intake-running\s*\{/);
});

test('app.js: the wizard has an Estimation calibration section with XS/XL hints and a Reusable assets example', () => {
  assert.match(APP_JS, /'Estimation calibration'/);
  assert.match(APP_JS, /Anchor your estimates: how many person-days does your team need for the smallest and for a big typical change\?/);
  assert.match(APP_JS, /XS — e\.g\. add a custom field to products and show it on the product detail page\./);
  assert.match(APP_JS, /XL — e\.g\. a new B2B checkout flow with ERP price and stock sync and approval rules\./);
  assert.match(APP_JS, /'Reusable assets \(e\.g\. your own plugin list, estimation guidelines, boilerplates, CI templates\)'/);
});

test('app.css: the field-hint class exists', () => {
  assert.match(APP_CSS, /\.field-hint\s*\{/);
});

test('refreshProposals unwraps the { proposals } envelope (S.proposals stays an array)', () => {
  const src = fs.readFileSync(path.join(HERE, '../page/app.js'), 'utf8');
  assert.match(src, /S\.proposals = Array\.isArray\(r\) \? r : \(Array\.isArray\(r\?\.proposals\)/);
  assert.match(src, /S\.proposals = Array\.isArray\(j\.proposals\) \? j\.proposals : \[\]/);
});

// --- §4 grid: spreadsheet look, sticky confirm tick, fewer columns ---

test('app.js: no click-to-edit swap anywhere (Client Response / Internal note / Project information are always-visible textareas)', () => {
  assert.ok(!APP_JS.includes('click to edit'), 'no "click to edit" left in app.js');
  assert.ok(!APP_JS.includes('replaceWith(ta)'), 'no click-to-edit textarea swap left in app.js');
  assert.match(APP_JS, /function liveTextarea\s*\(/);
});

test('app.js: projectInfoPanel uses liveTextarea', () => {
  const start = APP_JS.indexOf('function projectInfoPanel');
  assert.ok(start >= 0, 'projectInfoPanel should exist');
  const end = APP_JS.indexOf('\nfunction ', start + 1);
  const body = APP_JS.slice(start, end);
  assert.match(body, /liveTextarea\(/);
});

test('app.css: textarea.sheet-cell has a visible border', () => {
  const start = APP_CSS.indexOf('.add-assumption, textarea.sheet-cell');
  assert.ok(start >= 0, 'the shared field-look rule should exist');
  const end = APP_CSS.indexOf('}', start);
  assert.match(APP_CSS.slice(start, end), /border:\s*1px solid var\(--line\)/);
});

test('app.js: itemRow renders a textarea cell for clientResponse and internalNote', () => {
  assert.match(APP_JS, /editableCell\(item, 'clientResponse'/);
  assert.match(APP_JS, /editableCell\(item, 'internalNote'/);
});

test('app.js: GRID_HEADER has no Export text, Move to, Skip or Confirm column', () => {
  const line = APP_JS.split('\n').find(l => l.includes('const GRID_HEADER'));
  assert.ok(line, 'GRID_HEADER should exist');
  for (const label of ['Export text', 'Move to', 'Skip', 'Confirm']) {
    assert.ok(!line.includes(`'${label}'`), `${label} should be gone from GRID_HEADER`);
  }
});

test('app.js: the confirm tick is rendered inside the sticky id cell', () => {
  assert.match(APP_JS, /function confirmTick\(/);
  assert.match(APP_JS, /el\('td', \{ class: 'sticky-col id-col' \}, confirmTick\(item\)/);
  assert.match(APP_JS, /class: 'btn-confirm'/);
  assert.match(APP_JS, /<svg /);
  assert.match(APP_JS, /`Confirm \$\{item\.id\}`/);
});

test('app.css: a suggested proposal chip is a full-width, wrapping, multi-row block', () => {
  const start = APP_CSS.indexOf('.chip.suggested {');
  assert.ok(start >= 0, 'the .chip.suggested rule should exist');
  const end = APP_CSS.indexOf('\n}', start);
  const rule = APP_CSS.slice(start, end);
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /box-sizing:\s*border-box/);
  assert.match(rule, /flex-direction:\s*column/);
  const stmtStart = APP_CSS.indexOf('.chip.suggested .stmt');
  assert.ok(stmtStart >= 0, 'the chip statement rule should exist');
  const stmtRule = APP_CSS.slice(stmtStart, APP_CSS.indexOf('\n', stmtStart));
  assert.match(stmtRule, /white-space:\s*normal/);
  assert.match(stmtRule, /overflow-wrap:\s*anywhere/);
  assert.match(stmtRule, /min-width:\s*0/);
  const topStart = APP_CSS.indexOf('.chip.suggested .chip-top');
  assert.match(APP_CSS.slice(topStart, APP_CSS.indexOf('\n', topStart)), /min-width:\s*0/);
  assert.match(APP_CSS, /\.chip\.suggested \.chip-actions \{[^}]*justify-content:\s*flex-end/);
});

test('app.js: the confirmed badge is a clickable unconfirm button', () => {
  assert.match(APP_JS, /class: 'confirm-badge'/);
  assert.match(APP_JS, /'Confirmed — click to unconfirm'/);
  assert.match(APP_JS, /`Unconfirm \$\{item\.id\}`/);
  assert.match(APP_JS, /async function unconfirmItems\(ids\)/);
  assert.match(APP_JS, /api\('\/api\/unconfirm', \{ ids \}\)/);
});

test('app.js: exportPreviewCell, loadExportPreview, moveCell and skipItem are gone', () => {
  for (const name of ['exportPreviewCell', 'loadExportPreview', 'moveCell', 'skipItem', 'moveItem']) {
    assert.ok(!APP_JS.includes(name + '('), `${name} should be removed`);
  }
});

// --- IN-3/IN-11: no manual Analyze step ---

test('index.html has no #analyze-btn; index.html has the analyze-progress pill', () => {
  assert.ok(!HTML.includes('id="analyze-btn"'), '#analyze-btn should be gone');
  assert.match(HTML, /id="analyze-progress"/);
});

test('app.js: the analyze() batch action and its click handler are gone', () => {
  assert.ok(!/function analyze\s*\(/.test(APP_JS), 'analyze() should be removed');
  assert.ok(!APP_JS.includes("$('#analyze-btn')"), 'no reference to #analyze-btn left');
});

test('app.js: the header computes "Analysing n of N" from the queued/running batches while a chain is active', () => {
  assert.match(APP_JS, /function renderAnalyzeProgress\s*\(/);
  assert.match(APP_JS, /function activeAnalyzeChain\s*\(/);
  assert.match(APP_JS, /Analysing \$\{/);
});

test('app.js: the review banner/button (Confirm extraction, inReview) is gone — intake confirms itself', () => {
  for (const name of ['reviewBanner', 'inReview', 'confirmExtraction']) {
    assert.ok(!APP_JS.includes(name), `${name} should be removed`);
  }
  assert.match(APP_JS, /function notTakenBanner\(/);
});

// --- P-2: accept/reject decisions queue with the notes, auto-send above 15, no scroll jump ---

test('app.js: accepting/rejecting a suggestion queues a decision instead of calling /api/proposal directly', () => {
  assert.match(APP_JS, /function toggleProposalDecision\s*\(/);
  assert.match(APP_JS, /toggleDecision\(S\.notes, p, action\)/);
  assert.match(APP_JS, /toggleProposalDecision\(p, 'accept'\)/);
  assert.match(APP_JS, /toggleProposalDecision\(p, 'reject'\)/);
  assert.ok(!/acceptProposal\s*\(/.test(APP_JS), 'acceptProposal() should be removed');
  assert.ok(!/rejectProposal\s*\(/.test(APP_JS), 'rejectProposal() should be removed');
});

test('app.js: queued decisions above 15 auto-send the batch, never while a run holds the lock', () => {
  assert.match(APP_JS, /AUTO_SEND_DECISIONS_ABOVE\s*=\s*15/);
  assert.match(APP_JS, /function maybeAutoSendDecisions\s*\(/);
  const fn = APP_JS.slice(APP_JS.indexOf('function maybeAutoSendDecisions'), APP_JS.indexOf('function maybeAutoSendDecisions') + 400);
  assert.match(fn, /if \(S\.run\) return;/);
  assert.match(fn, /decisionCount\(S\.notes\)/);
  assert.match(fn, /sendBatch\(/);
});

test('app.js: renderDoc and renderArea save and restore the scroll position around a rebuild', () => {
  assert.match(APP_JS, /function captureScroll\s*\(/);
  assert.match(APP_JS, /function restoreScroll\s*\(/);
  const docStart = APP_JS.indexOf('function renderDoc(');
  const docEnd = APP_JS.indexOf('\nfunction ', docStart + 1);
  const docFn = APP_JS.slice(docStart, docEnd);
  assert.match(docFn, /const scroll = captureScroll\(\);/);
  assert.match(docFn, /restoreScroll\(scroll\);/);
  const areaStart = APP_JS.indexOf('function renderArea(');
  const areaEnd = APP_JS.indexOf('\nfunction ', areaStart + 1);
  const areaFn = APP_JS.slice(areaStart, areaEnd);
  assert.match(areaFn, /const scroll = captureScroll\(\);/);
  assert.match(areaFn, /restoreScroll\(scroll\);/);
});

test('app.js: the Requirement cell clamps to 20 lines with a More/Less toggle, detected by overflow after render', () => {
  assert.match(APP_CSS, /-webkit-line-clamp:\s*20/);
  assert.match(APP_JS, /function requirementCell\s*\(/);
  assert.match(APP_JS, /class: 'cell-more'/);
  assert.match(APP_JS, /reqDiv\.scrollHeight > reqDiv\.clientHeight/);
  assert.match(APP_JS, /'Less'/);
  assert.match(APP_JS, /'More'/);
});

test('app.js: confirmItems returns on a 202 without an unconditional load()', () => {
  const fn = APP_JS.match(/async function confirmItems\(ids\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(fn, /if \(r\.queued\)[^\n]*return;/);
  assert.ok(fn.indexOf('r.queued') < fn.indexOf('await load()'), 'the queued check precedes load()');
  assert.match(fn, /captureScroll\(\)[\s\S]*restoreScroll/);
});
