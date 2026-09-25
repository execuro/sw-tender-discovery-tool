// Item-level diff for the 0.2.0 grammar: added / removed / changed scope item ids, with the
// fields that changed on each. Build contract WP-4 task 5.
const FIELDS = ['coverage', 'confidence', 'effort', 'requirement', 'clientResponse', 'assumptions', 'internalNote', 'references', 'status'];

function val(item, field) {
  return JSON.stringify(item[field] ?? null);
}

/**
 * `diff(oldItems, newItems)` -> `{ added: string[], removed: string[], changed: [{ id, fields }] }`.
 * Accepts parsed item arrays (`model.items`) or plain objects keyed the same way.
 */
export function diff(oldItems, newItems) {
  const before = new Map((oldItems || []).map(it => [it.id, it]));
  const after = new Map((newItems || []).map(it => [it.id, it]));
  const added = [], removed = [], changed = [];
  for (const [id, item] of after) {
    const prev = before.get(id);
    if (!prev) { added.push(id); continue; }
    const fields = FIELDS.filter(f => val(prev, f) !== val(item, f));
    if (fields.length) changed.push({ id, fields });
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, changed };
}
