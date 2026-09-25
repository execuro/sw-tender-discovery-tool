// Document-level write primitives for the 0.2.0 grammar (build contract §1).
// Every primitive re-parses, rebuilds one section from the model and splices it back in,
// so every byte outside §4 / §5 stays untouched. D-19: no old-grammar helpers here.
import fs from 'node:fs';
import path from 'node:path';
import { parse, splitRow, formatEffort, formatStatus, TABS, PROJECT_INFO, ITEM_HEADER, ITEM_HEADER_LINE } from './parse.mjs';

const nl = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

/** Escape one table cell: `|` escaped, line breaks become `<br>` (contract §1). */
function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>');
}

/** `- ` bullets, `<br>`-joined (contract §1). */
function bulletsCell(list) {
  return (list || []).map(s => `- ${escapeCell(s)}`).join('<br>');
}

// One source of truth for the header (parse.mjs's ITEM_HEADER/ITEM_HEADER_LINE) — the renderer
// always writes the current (new) layout, whatever layout the document was read with (5b).
const SEP_LINE = `| ${ITEM_HEADER.map(() => '---').join(' | ')} |`;

function renderItemRow(item) {
  const cells = [
    item.id, item.prio || '', item.requirement || '', item.coverage || '', item.confidence || '',
    formatEffort(item.effort), item.clientResponse || '',
    bulletsCell(item.assumptions), item.internalNote || '', bulletsCell(item.references),
    formatStatus(item.status),
  ].map((c, i) => (i === 0 || i === 1 || i === 2 || i === 6 || i === 8 ? escapeCell(c) : c));
  return `| ${cells.join(' | ')} |`;
}

/** §4 body (contract §1): one table per `<Tab> · <Topic>` heading, in canonical render order —
 * tabs in `TABS` order, topics within a tab in client first-seen order, items in client order.
 * The model does not guarantee this order itself (e.g. after `move`), so the renderer, not the
 * parser, produces it (contract §1: "the parser does not enforce order; the renderers produce
 * it"). A group whose tab is not one of `TABS` (a malformed/legacy heading a repair pass left
 * behind) keeps first-seen order, appended after the canonical tabs, so no item is ever dropped. */
export function renderItemsSection(items) {
  const groups = new Map(); // key -> { tab, topic, area, items }
  const order = [];
  for (const it of items || []) {
    const tab = it.tab, topic = it.topic;
    const key = tab != null && topic != null ? `${tab}\u0000${topic}` : `\u0000legacy\u0000${it.area || ''}`;
    let g = groups.get(key);
    if (!g) { g = { tab, topic, area: it.area || '', items: [] }; groups.set(key, g); order.push(key); }
    g.items.push(it);
  }
  const ordered = [];
  for (const t of TABS) for (const key of order) if (groups.get(key).tab === t) ordered.push(groups.get(key));
  for (const key of order) { const g = groups.get(key); if (!TABS.includes(g.tab)) ordered.push(g); }
  return ordered.map(g => [
    `### ${g.tab != null && g.topic != null ? `${g.tab} · ${g.topic}` : g.area}`,
    '',
    ITEM_HEADER_LINE,
    SEP_LINE,
    ...g.items.map(renderItemRow),
  ].join('\n')).join('\n\n');
}

function renderQuestionBlock(q) {
  const lines = [`### ${q.id} · ${(q.items || []).join(', ')}`, '', q.question || ''];
  if (q.options && q.options.length) {
    lines.push('');
    for (const o of q.options) lines.push(`- [${o.checked ? 'x' : ' '}] ${o.key} — ${o.text} — effect: ${o.effect}`);
    lines.push(`Fallback: ${q.fallback}`);
    if (q.answered) lines.push(`Answered ${q.answered.date}: ${q.answered.key}`);
  }
  return lines.join('\n');
}

/** §5 body (contract §1): one block per question, in question order. */
export function renderQuestionsSection(questions) {
  return (questions || []).map(renderQuestionBlock).join('\n\n');
}

/**
 * Replace the content of section `n` (its heading kept, everything after the heading up to
 * (not including) `endLine` replaced) with `content`; every other line is untouched.
 * `blocks` is a parsed model's `blocks` array (`parse(text).blocks`).
 */
export function replaceSection(text, blocks, n, content) {
  const lines = nl(text);
  const sec = (blocks || []).find(b => b.n === n);
  if (!sec) return text;
  const before = lines.slice(0, sec.line);
  // `sec.endLine` is the physical line of this section's last non-blank line (parse.mjs trims
  // trailing blanks into `raw`, not out of the document); any blank lines still sitting between
  // that line and the next heading are skipped here too, or they accumulate by one every write —
  // a real, if cosmetic, diff on every apply/ops/report call.
  let afterStart = sec.endLine;
  while (afterStart < lines.length && lines[afterStart].trim() === '') afterStart++;
  const after = lines.slice(afterStart);
  const body = content ? ['', content, ''] : [''];
  return [...before, ...body, ...after].join('\n');
}

/** Replace several sections at once, from the bottom of the document up (line numbers stay valid). */
export function replaceSections(text, blocks, edits) {
  let out = text;
  for (const [n, content] of [...edits].sort((a, b) => b[0] - a[0])) {
    out = replaceSection(out, parse(out).blocks, n, content);
  }
  return out;
}

export function setFrontmatterField(text, key, value) {
  const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const fm = FM_RE.exec(text);
  if (!fm) return text;
  const body = fm[1];
  const re = new RegExp(`^(${key}:).*$`, 'm');
  const newBody = re.test(body) ? body.replace(re, `$1 ${value}`) : `${body}\n${key}: ${value}`;
  return text.slice(0, fm.index) + `---\n${newBody}\n---\n` + text.slice(fm.index + fm[0].length);
}

export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// snapshot / verifyAndRepair — guard against a run corrupting §4, and §1 Project information
// rows the operator set by hand (build contract WP-4 task 5, WP-3b addendum).

/** One line of text per item id, keyed for restoring a corrupted row (contract: "restored from
 * snapshot"), plus the `operator`-sourced §1 Project information rows (contract §1: `info`'s
 * Source `operator` — a run must never silently lose a value the operator typed in by hand). */
export function snapshot(text) {
  const lines = nl(text);
  const model = parse(text);
  const itemLines = {};
  for (const it of model.items) {
    const idx = findItemLineIndex(lines, it.id);
    if (idx >= 0) itemLines[it.id] = lines[idx];
  }
  return {
    frontmatter: model.frontmatter ? model.frontmatter.raw : null,
    items: itemLines,
    ids: model.items.map(it => it.id),
    projectInfo: (model.projectInfo || []).filter(r => r.source === 'operator'),
  };
}

function findItemLineIndex(lines, id) {
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
    const cells = splitRow(lines[i]);
    if (cells[0] === 'ID') continue;
    if (cells[0] === id) return i;
  }
  return -1;
}

/**
 * Restore any §4 row that no longer parses (invalid coverage/effort/status, or a row for a
 * known id disappeared) from the snapshot, leaving every legitimately-changed row alone.
 * Also restores an `operator`-sourced §1 Project information row (contract §1: `info`'s Source
 * `operator`) whose Source a run knocked away from `operator` or dropped entirely — a row still
 * carrying Source `operator`, whatever its current Value, is a legitimate edit (e.g. a later
 * `info` call) and is left alone, exactly like a legitimately-changed §4 row.
 */
export function verifyAndRepair(text, snap) {
  const repairs = [];
  let out = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!snap) return { text: out, repairs };

  if (snap.frontmatter && !parse(out).frontmatter) {
    out = snap.frontmatter + '\n' + (out.startsWith('\n') ? '' : '\n') + out;
    repairs.push('restored frontmatter');
  }

  const model = parse(out);
  const badIds = new Set();
  for (const e of model.errors) {
    const m = /^item (\S+):/.exec(e);
    if (m) badIds.add(m[1]);
  }
  const present = new Map(model.items.map(it => [it.id, it]));
  for (const id of snap.ids || []) {
    const corrupted = badIds.has(id);
    const missing = !present.has(id);
    if (!corrupted && !missing) continue;
    const goodLine = snap.items[id];
    if (!goodLine) continue;
    const lines = nl(out);
    if (missing) {
      // Re-insert right after the last row of its area table (best effort: end of §4).
      const s4 = parse(out).blocks.find(b => b.n === 4);
      if (!s4) continue;
      lines.splice(s4.endLine, 0, goodLine);
    } else {
      const idx = findItemLineIndex(lines, id);
      if (idx < 0) continue;
      lines[idx] = goodLine;
    }
    out = lines.join('\n');
    repairs.push(`restored §4 row for ${id}`);
  }

  if (snap.projectInfo && snap.projectInfo.length) {
    // A row's label cell can itself be the thing a run corrupted (contract §1: a wrong or
    // out-of-order label is a parse error naming the row, and the row then fails to appear in
    // `model.projectInfo` under its key), so this locates the row by its fixed `PROJECT_INFO`
    // position, not by matching the (possibly corrupted) label text.
    const model2 = parse(out);
    const curByKey = new Map((model2.projectInfo || []).map(r => [r.key, r]));
    const lines = nl(out);
    const piIdx = lines.findIndex(l => l.trim() === '### Project information');
    const sepIdx = piIdx >= 0 ? lines.findIndex((l, i) => i > piIdx && isSepRowLine(l)) : -1;
    const dataStart = sepIdx >= 0 ? sepIdx + 1 : -1;
    if (dataStart >= 0) {
      for (const row of snap.projectInfo) {
        const cur = curByKey.get(row.key);
        // Present and still `operator`-sourced: whatever its current Value is, that is a
        // legitimate edit (e.g. a later `info` call) — left alone, same as a legitimately-changed
        // §4 row. Only a row that lost the `operator` Source (or vanished) gets restored.
        if (cur && cur.source === 'operator') continue;
        const idx = dataStart + PROJECT_INFO.findIndex(p => p.key === row.key);
        if (idx < dataStart || idx >= lines.length) continue;
        lines[idx] = `| ${row.label} | ${row.value || ''} | ${row.source || ''} |`;
        repairs.push(`restored §1 Project information row for ${row.label}`);
      }
      out = lines.join('\n');
    }
  }

  return { text: out, repairs };
}

function isSepRowLine(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line || '');
}
