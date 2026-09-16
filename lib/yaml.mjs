// Minimal YAML reader for the analysis frontmatter. Reads scalars, nested maps
// (indentation stack), `- item` lists and inline `{}` / `[]`. Never serialises.

// No leading zeros and at most 15 digits, so hashes and ids stay strings.
const NUM_RE = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/;

export function parseYaml(text) {
  const root = {};
  // frames: {indent, obj, parent, key, pending} — a pending frame was opened by
  // `key:` and becomes a map or a list with its first child line.
  const stack = [{ indent: -1, obj: root, pending: false }];
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (body.startsWith('- ') || body === '-') {
      if (!Array.isArray(top.obj)) {
        if (top.pending) { top.obj = []; top.parent[top.key] = top.obj; top.pending = false; } else continue;
      }
      const rest = body.slice(1).trim();
      const kv = keyValue(rest);
      if (kv && !kv.value) { const o = {}; top.obj.push(o); stack.push({ indent: indent + 1, obj: o, pending: false }); if (kv.key) { o[kv.key] = {}; stack.push({ indent: indent + 1, obj: o[kv.key], parent: o, key: kv.key, pending: true }); } continue; }
      if (kv && !/^[{["']/.test(rest)) { const o = { [kv.key]: parseValue(kv.value) }; top.obj.push(o); stack.push({ indent: indent + 1, obj: o, pending: false }); continue; }
      top.obj.push(parseValue(rest));
      continue;
    }

    const kv = keyValue(body);
    if (!kv) continue;
    if (Array.isArray(top.obj)) continue;
    if (top.pending) top.pending = false;
    if (kv.value === '') {
      const o = {};
      top.obj[kv.key] = o;
      stack.push({ indent, obj: o, parent: top.obj, key: kv.key, pending: true });
    } else {
      top.obj[kv.key] = parseValue(kv.value);
    }
  }
  return root;
}

function keyValue(s) {
  const m = /^("[^"]*"|'[^']*'|[^:#{}[\],]+?)\s*:(?:\s+(.*))?$/.exec(s);
  if (!m) return null;
  return { key: unquote(m[1].trim()), value: (m[2] ?? '').trim() };
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function unquote(s) {
  if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function scalar(s) {
  const t = s.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (NUM_RE.test(t)) return Number(t);
  return unquote(t);
}

export function parseValue(s) {
  const t = String(s ?? '').trim();
  if (t[0] === '{' || t[0] === '[') return parseInline(t);
  return scalar(t);
}

// Tokenizer for one inline collection; honours nesting and quotes.
function parseInline(s) {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const readRaw = () => {
    const start = i;
    let depth = 0, q = null;
    for (; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
    }
    return s.slice(start, i).trim();
  };
  const value = () => { ws(); if (s[i] === '{') return map(); if (s[i] === '[') return list(); return scalar(readRaw()); };
  const map = () => {
    i++;
    const o = {};
    for (;;) {
      ws();
      if (i >= s.length || s[i] === '}') { i++; return o; }
      let key;
      if (s[i] === '"' || s[i] === "'") { const q = s[i]; const e = s.indexOf(q, i + 1); key = s.slice(i + 1, e < 0 ? s.length : e); i = e < 0 ? s.length : e + 1; }
      else { let e = s.indexOf(':', i); if (e < 0) e = s.length; key = s.slice(i, e).trim(); i = e; }
      ws();
      if (s[i] === ':') i++;
      o[key] = value();
      ws();
      if (s[i] === ',') i++;
    }
  };
  const list = () => {
    i++;
    const a = [];
    for (;;) {
      ws();
      if (i >= s.length || s[i] === ']') { i++; return a; }
      a.push(value());
      ws();
      if (s[i] === ',') i++;
    }
  };
  return value();
}
