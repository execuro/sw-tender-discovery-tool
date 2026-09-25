// `check <doc> [--write]` — grammar, the six Requirement Coverage values, reference prefixes,
// CQ shape (all via parse.mjs), §2 totals equality (E-3, contract `own-tabs-contract.md` §1) and
// the money scan (X-7/R-7 — §1 Project information Values are the client's or operator's own
// facts, verbatim, amounts included, and are never scanned).
// `--write` regenerates §2 between its markers and sets frontmatter `state`.
import fs from 'node:fs';
import path from 'node:path';
import * as out from './out.mjs';
import { canonical, resolveRoot } from './paths.mjs';
import { parse } from './parse.mjs';
import { totals as calcTotals, readiness as calcReadiness, isReady, staleCount } from './calc.mjs';
import { readProfile, regime as regimeOf } from './profile.mjs';
import * as proposals from './proposals.mjs';

const TOTALS_BEGIN = '<!-- totals:begin -->';
const TOTALS_END = '<!-- totals:end -->';
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// Money scan (R-7): case-insensitive, word-boundary money terms, currency symbols, ISO codes.
const MONEY_WORD_RE = /\b(price|prices|priced|cost|costs|rate|rates|fee|fees|budget|budgets)\b/i;
const MONEY_WORD_RE_G = /\b(price|prices|priced|cost|costs|rate|rates|fee|fees|budget|budgets)\b/gi;
const MONEY_SYMBOL_RE = /[€$£¥₣]/;
const MONEY_ISO_RE = /\b(EUR|USD|GBP|CHF)\b/i;

// R-7a stems: "prices"/"priced" is the same word as "price" for the exemption below — the client
// wrote one form in the Requirement, the tool may quote it back in a different inflection.
const MONEY_STEMS = { price: 'price', prices: 'price', priced: 'price', cost: 'cost', costs: 'cost', rate: 'rate', rates: 'rate', fee: 'fee', fees: 'fee', budget: 'budget', budgets: 'budget' };
const wordStem = w => MONEY_STEMS[w] || w;

export function moneyHits(text) {
  const s = String(text ?? '');
  const hits = [];
  if (MONEY_WORD_RE.test(s)) hits.push('money term');
  if (MONEY_SYMBOL_RE.test(s)) hits.push('currency symbol');
  if (MONEY_ISO_RE.test(s)) hits.push('currency code');
  return hits;
}

// §1 Project information describes the client's own business, so its keys need money *words* and
// bare currency names ("Currencies: EUR", "Price model: customer-specific prices"); only an amount —
// a number next to a currency symbol or code, either order, with an optional k/m multiplier — is refused.
const CURRENCY = '(?:[€$£¥₣]|\\b(?:EUR|USD|GBP|CHF)\\b)';
const AMOUNT_RE = new RegExp(`${CURRENCY}\\s*\\d|\\d(?:[\\d.,]*\\d)?\\s*(?:k|m|mio|million|thousand)?\\s*${CURRENCY}`, 'i');

export function amountHits(text) {
  return AMOUNT_RE.test(String(text ?? '')) ? ['amount'] : [];
}

/** The money *words* matched (lowercased), for the R-7a exemption below — currency symbols and
 * ISO codes are never exempt and are not returned here. */
function moneyWords(text) {
  const s = String(text ?? '');
  const out = [];
  let m;
  MONEY_WORD_RE_G.lastIndex = 0;
  while ((m = MONEY_WORD_RE_G.exec(s))) out.push(m[1].toLowerCase());
  return out;
}

/** Client Response / Assumptions hits (R-7a): a money *word* that also occurs (same stem) in the
 * item's own Requirement text is the client's own vocabulary quoted back, not the tool stating a
 * price — it is exempt, whatever inflection either side uses ("price" in the Requirement exempts
 * "prices"/"priced" in the response). A currency symbol, an ISO code, or a word whose stem is
 * absent from the Requirement is never exempt. */
function fieldMoneyHits(val, requirementText) {
  const exempt = new Set(moneyWords(requirementText).map(wordStem));
  const words = moneyWords(val).filter(w => !exempt.has(wordStem(w)));
  const hits = [];
  if (words.length) hits.push('money term');
  if (MONEY_SYMBOL_RE.test(String(val ?? ''))) hits.push('currency symbol');
  if (MONEY_ISO_RE.test(String(val ?? ''))) hits.push('currency code');
  return hits;
}

/** One item's Client Response / Assumptions fields, each with its R-7a-exempted money hits
 * (empty entries omitted) — the single scan `check`'s money gate and every export path (surgical
 * xlsx, working-sheet xlsx) share, so a document that passes `check` never gets refused (or vice
 * versa) by a differently-behaved export-time scan. */
export function itemFieldMoneyHits(it) {
  const fields = [['Client Response', it.clientResponse], ...(it.assumptions || []).map((a, i) => [`Assumptions[${i}]`, a])];
  const results = [];
  for (const [field, val] of fields) {
    const hits = fieldMoneyHits(val, it.requirement);
    if (hits.length) results.push({ field, hits, val });
  }
  return results;
}

const REFERENCE_MONEY_EXEMPT_PREFIXES = new Set(['kb', 'project']);

/** D-33: `cost:` is exempt from money *words* (the architect's own vocabulary — a licence, a
 * subscription, a paid ISV, a hosting tier) but the amount check still applies (no figure). */
function referenceMoneyHits(r) {
  const m = /^(\w+):/.exec(String(r ?? ''));
  if (m && REFERENCE_MONEY_EXEMPT_PREFIXES.has(m[1])) return [];
  if (m && m[1] === 'cost') return amountHits(r.slice(r.indexOf(':') + 1));
  return moneyHits(r);
}

/** The regime named the way every effort figure and the §2 Totals line name it (contract §1):
 * T-shirt: "T-shirt, default scale, before overhead and buffer"; profile: "profile (overhead
 * o%, buffer b% folded|separate)". Shared by `check`, `report` and the exported workbooks so
 * the same document never shows two different regime labels. */
export function regimeLabel(regimeStr, profile) {
  if (regimeStr === 'profile') {
    const overhead = profile?.overhead ?? 0;
    const pct = profile?.buffer?.percent ?? 0;
    const mode = profile?.buffer?.mode ?? 'separate';
    return `profile (overhead ${overhead}%, buffer ${pct}% ${mode})`;
  }
  return 'T-shirt, default scale, before overhead and buffer';
}

function regimeLine(regimeStr, profile) {
  return `Regime: ${regimeLabel(regimeStr, profile)}`;
}

function table(label, rows, totalRow) {
  const head = `| ${label} | Items | Estimated PD | Blocked (at fallback) | Not estimated | Not decomposed |`;
  const sep = '| --- | --- | --- | --- | --- | --- |';
  const body = rows.map(r => `| ${r.key} | ${r.items} | ${r.estimatedPd} | ${r.blocked} | ${r.notEstimated} | ${r.notDecomposed} |`);
  const tot = `| Total | ${totalRow.items} | ${totalRow.estimatedPd} | ${totalRow.blocked} | ${totalRow.notEstimated} | ${totalRow.notDecomposed} |`;
  return [head, sep, ...body, tot].join('\n');
}

/** Canonical §2 content (between the markers), from the parsed items. E-3, contract §1.
 * `questions` (the model's §5 blocks) drives "Open CQ" — a CQ without an `Answered` line
 * (contract §1), not a count of blocked items. */
export function renderTotals(items, { regime: regimeStr, profile = null, proposals = [], questions = [] } = {}) {
  const t = calcTotals(items, { profile });
  const r = calcReadiness(items, { proposals, questions });
  // #5: an item whose Effort was produced under the OTHER regime (a profile added/removed since)
  // is stale — the live regime's own Not decomposed rule and label do not cover it until the
  // next apply re-estimates it; called out here rather than silently folded into either table.
  const stale = staleCount(items, regimeStr);
  const lines = [
    regimeLine(regimeStr, profile),
    '',
    'By priority:',
    table('Priority', t.byPriority, t.total),
    '',
    'By tab:',
    table('Tab', t.byTab, t.total),
    '',
    `Confirmed ${r.confirmed} of ${r.total} · Reopened ${r.reopened} · Failed ${r.failed} · Open CQ ${r.openCQ} · Low confidence ${r.lowConfidence} · Waiting proposals ${r.waitingProposals}`,
  ];
  if (stale > 0) lines.push(`Stale (regime changed): ${stale} — pending re-estimate`);
  return lines.join('\n');
}

function betweenMarkers(text) {
  const b = text.indexOf(TOTALS_BEGIN), e = text.indexOf(TOTALS_END);
  if (b < 0 || e < 0 || e < b) return null;
  return text.slice(b + TOTALS_BEGIN.length, e).replace(/^\n/, '').replace(/\n$/, '');
}

function writeMarkers(text, content) {
  const b = text.indexOf(TOTALS_BEGIN), e = text.indexOf(TOTALS_END);
  if (b < 0 || e < 0 || e < b) return text;
  return text.slice(0, b + TOTALS_BEGIN.length) + '\n' + content + '\n' + text.slice(e);
}

export function setFrontmatterField(text, key, value) {
  const fm = FM_RE.exec(text);
  if (!fm) return text;
  const body = fm[1];
  const re = new RegExp(`^(${key}:).*$`, 'm');
  const newBody = re.test(body) ? body.replace(re, `$1 ${value}`) : `${body}\n${key}: ${value}`;
  return text.slice(0, fm.index) + `---\n${newBody}\n---\n` + text.slice(fm.index + fm[0].length);
}

/** §1's free prose — everything before "### Project information" — the editor's own words,
 * never the client's (same split `intake.mjs`'s `proseBefore` uses, inlined here to avoid an
 * intake.mjs <-> check.mjs import cycle). */
function proseBeforeProjectInfo(raw) {
  const idx = (raw || '').indexOf('### Project information');
  return idx < 0 ? (raw || '').trim() : raw.slice(0, idx).trim();
}

/** The text of one `### <heading>` subsection within a block's raw body, up to the next `###`
 * heading or the end — used to separate §3's tool-authored "Assumptions" from its client-derived
 * "Exclusions". */
function subsection(raw, heading) {
  const marker = `### ${heading}`;
  const idx = (raw || '').indexOf(marker);
  if (idx < 0) return '';
  const rest = raw.slice(idx + marker.length);
  const next = rest.search(/\n### /);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

function moneyScan(model, proposals) {
  const problems = [];
  for (const it of model.items) {
    for (const { field, hits, val } of itemFieldMoneyHits(it)) problems.push(`item ${it.id} ${field}: ${hits.join(', ')} in "${val}"`);
    it.references.forEach((r, i) => {
      const hits = referenceMoneyHits(r);
      if (hits.length) problems.push(`item ${it.id} References[${i}]: ${hits.join(', ')} in "${r}"`);
    });
  }
  // §1 Project information is the client's or operator's own facts, verbatim — amounts included
  // (2026-09-24 decision). Only text the tool itself authors (below) is ever money-scanned.
  // R-7 scans only text the tool itself authors: §1's free prose before "### Project information",
  // §2 Totals, §3's own "### Assumptions" bullets, §8 Log. Project information's own Values, §3's
  // "### Exclusions", §5 Questions (the client's own requirement text, quoted into the CQ), §6
  // Integrations and §7 Glossary are transcriptions of the client's own document (or, for Project
  // information, the client's or operator's own facts) and are never scanned.
  const s1 = model.blocks.find(b => b.n === 1);
  if (s1?.raw) {
    const hits = moneyHits(proseBeforeProjectInfo(s1.raw));
    if (hits.length) problems.push(`§1: ${hits.join(', ')}`);
  }
  for (const n of [2, 8]) {
    const sec = model.blocks.find(b => b.n === n);
    if (sec?.raw) {
      const hits = moneyHits(sec.raw);
      if (hits.length) problems.push(`§${n}: ${hits.join(', ')}`);
    }
  }
  const s3 = model.blocks.find(b => b.n === 3);
  if (s3?.raw) {
    const hits = moneyHits(subsection(s3.raw, 'Assumptions'));
    if (hits.length) problems.push(`§3 Assumptions: ${hits.join(', ')}`);
  }
  // A proposal's money word is exempt when its item's Requirement uses it (R-7a), same as
  // Client Response / Assumptions above; a global proposal (no item) has no requirement to
  // exempt against and is scanned in full.
  for (const p of proposals || []) {
    const it = p.item ? model.items.find(i => i.id === p.item) : null;
    const hits = it ? fieldMoneyHits(p.statement, it.requirement) : moneyHits(p.statement);
    if (hits.length) problems.push(`proposal ${p.id}: ${hits.join(', ')}`);
  }
  return problems;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') { opts.write = true; continue; }
    if (a === '--root') { opts.root = argv[++i]; continue; }
    if (!a.startsWith('--')) opts._.push(a);
  }
  return opts;
}

/**
 * The read-only half of `check`: every reason the document would fail on, without writing
 * anything. `report` refuses to run against a document that fails this (B) — a run report on a
 * document `check` itself would reject is worse than no report.
 */
export function checkReasons(docAbs, root, { write = false } = {}) {
  const text = fs.readFileSync(docAbs, 'utf8');
  const model = parse(text, { path: docAbs });
  const reasons = [...model.errors];

  const { profile } = readProfile(root);
  const regimeStr = regimeOf(root);
  const fmRegime = model.frontmatter?.data?.regime;
  if (!write && fmRegime && fmRegime !== regimeStr) reasons.push(`frontmatter regime "${fmRegime}" does not match the profile file (${regimeStr})`);

  const slug = model.slug || path.basename(docAbs).replace(/-analysis\.md$/i, '');
  let proposals = [];
  const proposalsFile = path.join(root, 'specs', '.rfp', slug, 'proposals.json');
  if (fs.existsSync(proposalsFile)) {
    try { proposals = JSON.parse(fs.readFileSync(proposalsFile, 'utf8')); } catch { reasons.push('proposals.json is not valid JSON'); }
  }

  reasons.push(...moneyScan(model, proposals));

  const existing = betweenMarkers(text);
  if (existing == null) reasons.push('§2 is missing the totals:begin/totals:end markers');

  const canonicalTotals = renderTotals(model.items, { regime: regimeStr, profile, proposals, questions: model.questions });
  if (!write && existing != null && existing.trim() !== canonicalTotals.trim()) {
    reasons.push('§2 totals do not match the recomputed totals — run `check --write`');
  }

  // T4: an Effort cell written in the OTHER regime's format (a profile removed/added since it was
  // estimated) is accepted, never a failure — flagged here instead, until the item is
  // re-estimated (regime change also queues it via `markReestimate('*', ...)` in `main`).
  const effortFormatFlags = model.items
    .filter(it => it.effort && it.effort.regime !== regimeStr)
    .map(it => it.id);

  return { text, model, reasons, regimeStr, fmRegime, profile, existing, canonicalTotals, effortFormatFlags };
}

export async function main(argv = []) {
  const opts = parseArgs(argv);
  const docArg = opts._[0];
  if (!docArg) { out.line('reason', 'usage: check <doc> [--write]'); process.exitCode = out.EXIT_USAGE; return; }
  const docAbs = canonical(docArg);
  if (!fs.existsSync(docAbs)) { out.line('reason', `document not found: ${docArg}`); process.exitCode = out.EXIT_UNREACHABLE; return; }
  const root = resolveRoot({ rootFlag: opts.root || '', docAbs });
  const { text, model, reasons, regimeStr, fmRegime, canonicalTotals, existing, effortFormatFlags } = checkReasons(docAbs, root, { write: Boolean(opts.write) });

  // T4: the profile file's regime (removed or added since the document last saw it) differs from
  // the document's own frontmatter — `--write` follows the profile, queues every item for
  // re-estimate and reports it, rather than leaving stale Effort figures unflagged.
  const regimeChanged = Boolean(opts.write) && fmRegime && fmRegime !== regimeStr;

  if (opts.write) {
    let next = text;
    if (existing != null) next = writeMarkers(next, canonicalTotals);
    next = setFrontmatterField(next, 'state', isReady(model.items) ? 'Ready' : 'In progress');
    next = setFrontmatterField(next, 'regime', regimeStr);
    if (next !== text) fs.writeFileSync(docAbs, next, 'utf8');
    if (regimeChanged) {
      const slug = model.slug || path.basename(docAbs).replace(/-analysis\.md$/i, '');
      proposals.markReestimate(root, slug, '*', `regime changed ${fmRegime} -> ${regimeStr}`);
    }
  }

  if (reasons.length) {
    for (const r of reasons) out.line('reason', r);
    out.nextStep('fix the reasons above, then run check again');
    process.exitCode = out.EXIT_UNREACHABLE;
    return;
  }

  out.line('doc', path.relative(root, docAbs));
  out.line('items', model.items.length);
  out.line('state', isReady(model.items) ? 'Ready' : 'In progress');
  if (opts.write) out.line('written', 'totals, state');
  if (regimeChanged) out.line('regime', 'regime changed — every item queued for re-estimate');
  if (effortFormatFlags.length) out.line('flag', `Estimation in the other regime's format, pending re-estimate: ${effortFormatFlags.join(', ')}`);
  out.nextStep('run `report <doc>` for the run report');
}
