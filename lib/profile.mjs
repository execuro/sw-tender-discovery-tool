// The partner profile: `var/sw-ai-sdk/tender/partner-profile.md` under the project root — one per
// checkout, shared by every tender, gitignored through Shopware's `/var/*`. The pre-0.2.0 location
// `specs/rfp-partner-profile.md` is still read when the new file is absent (never written). Contract §2.
// R-6: no `licence` field on an isv entry (X-7 hard boundary).
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export const PROFILE_REL_PATH = 'var/sw-ai-sdk/tender/partner-profile.md';
export const LEGACY_PROFILE_REL_PATH = 'specs/rfp-partner-profile.md';

/** Absolute path of the profile file for a project root. */
export function profilePath(root) { return path.join(root || '.', PROFILE_REL_PATH); }
/** Absolute path of the pre-0.2.0 location, read-only. */
export function legacyProfilePath(root) { return path.join(root || '.', LEGACY_PROFILE_REL_PATH); }

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
 * error). A file that fails to parse or validate → `{ profile: null, reason: '<why>' }`. The new
 * location wins; a legacy `specs/rfp-partner-profile.md` is read only when it is absent and the
 * result then carries `legacy: true`.
 */
export function readProfile(root) {
  const current = profilePath(root);
  if (fs.existsSync(current)) return readProfileFile(current, PROFILE_REL_PATH);
  const legacy = legacyProfilePath(root);
  if (fs.existsSync(legacy)) return { ...readProfileFile(legacy, LEGACY_PROFILE_REL_PATH), legacy: true };
  return { profile: null, reason: null };
}

function readProfileFile(file, rel) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { profile: null, reason: `cannot read ${rel}: ${e.message}` }; }
  const fm = FM_RE.exec(text.replace(/\r\n?/g, '\n'));
  if (!fm) return { profile: null, reason: `${rel}: missing frontmatter` };
  let data;
  try { data = parseYaml(fm[1]); } catch (e) { return { profile: null, reason: `${rel}: ${e.message}` }; }
  const reason = validate(data);
  if (reason) return { profile: null, reason };
  return { profile: data, reason: null };
}

/** `profile` when the profile file exists and parses; otherwise `T-shirt`. Contract §4. */
export function regime(root) {
  return readProfile(root).profile ? 'profile' : 'T-shirt';
}
