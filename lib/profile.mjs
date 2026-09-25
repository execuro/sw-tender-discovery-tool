// The partner profile (`specs/rfp-partner-profile.md`, gitignored). Contract §2.
// R-6: no `licence` field on an isv entry (X-7 hard boundary).
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export const PROFILE_REL_PATH = 'specs/rfp-partner-profile.md';

function validate(data) {
  if (!data || typeof data !== 'object') return 'profile: empty or malformed frontmatter';
  const c = data.calibration;
  if (!c || typeof c.small !== 'number' || typeof c.big !== 'number') return 'profile: calibration.small and calibration.big must be numbers';
  if (typeof data.overhead !== 'number') return 'profile: overhead must be a number';
  const b = data.buffer;
  if (!b || typeof b.percent !== 'number' || !['folded', 'separate'].includes(b.mode)) return 'profile: buffer.percent (number) and buffer.mode (folded|separate) are required';
  for (const isv of data.isv || []) {
    if (isv && Object.prototype.hasOwnProperty.call(isv, 'licence')) return 'profile: an isv entry must not carry a licence field (X-7)';
    if (!isv?.name || !isv?.vendor || !Array.isArray(isv?.versions)) return 'profile: each isv entry needs name, vendor, versions[]';
  }
  for (const a of data.assets || []) {
    if (!a?.name || !a?.covers || typeof a?.pdSaved !== 'number') return 'profile: each asset needs name, covers, pdSaved (number)';
  }
  return null;
}

/**
 * `{ profile, reason }`. No file → `{ profile: null, reason: null }` (T-shirt regime, not an
 * error). A file that fails to parse or validate → `{ profile: null, reason: '<why>' }`.
 */
export function readProfile(root) {
  const file = path.join(root || '.', PROFILE_REL_PATH);
  if (!fs.existsSync(file)) return { profile: null, reason: null };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { profile: null, reason: `cannot read ${PROFILE_REL_PATH}: ${e.message}` }; }
  const fm = FM_RE.exec(text.replace(/\r\n?/g, '\n'));
  if (!fm) return { profile: null, reason: `${PROFILE_REL_PATH}: missing frontmatter` };
  let data;
  try { data = parseYaml(fm[1]); } catch (e) { return { profile: null, reason: `${PROFILE_REL_PATH}: ${e.message}` }; }
  const reason = validate(data);
  if (reason) return { profile: null, reason };
  return { profile: data, reason: null };
}

/** `profile` when the profile file exists and parses; otherwise `T-shirt`. Contract §4. */
export function regime(root) {
  return readProfile(root).profile ? 'profile' : 'T-shirt';
}
