import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProfile, regime, PROFILE_REL_PATH } from '../lib/profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'rfp-partner-profile.fixture.md'), 'utf8');

function host(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-profile-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  if (content != null) fs.writeFileSync(path.join(root, PROFILE_REL_PATH), content, 'utf8');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('no profile file: not an error, T-shirt regime', () => {
  const h = host(null);
  try {
    const { profile, reason } = readProfile(h.root);
    assert.equal(profile, null);
    assert.equal(reason, null);
    assert.equal(regime(h.root), 'T-shirt');
  } finally { h.cleanup(); }
});

test('a valid profile parses; regime is "profile"', () => {
  const h = host(FIXTURE);
  try {
    const { profile, reason } = readProfile(h.root);
    assert.equal(reason, null);
    assert.deepEqual(profile.calibration, { small: 2, big: 20 });
    assert.equal(profile.overhead, 10);
    assert.deepEqual(profile.buffer, { percent: 5, mode: 'folded' });
    assert.equal(profile.isv[0].name, 'PIM Connector');
    assert.equal(profile.assets[0].pdSaved, 6);
    assert.equal(regime(h.root), 'profile');
  } finally { h.cleanup(); }
});

test('R-6: an isv entry with a licence field is invalid (X-7)', () => {
  const bad = FIXTURE.replace('vendor: Acme Software', 'vendor: Acme Software\n    licence: per-seat');
  const h = host(bad);
  try {
    const { profile, reason } = readProfile(h.root);
    assert.equal(profile, null);
    assert.match(reason, /licence/);
    assert.equal(regime(h.root), 'T-shirt');
  } finally { h.cleanup(); }
});

test('missing calibration / overhead / buffer is invalid, with a reason', () => {
  const noCalib = FIXTURE.replace(/calibration:\n {2}small: 2\n {2}big: 20\n/, '');
  const h1 = host(noCalib);
  try { assert.match(readProfile(h1.root).reason, /calibration/); } finally { h1.cleanup(); }

  const noOverhead = FIXTURE.replace('overhead: 10\n', '');
  const h2 = host(noOverhead);
  try { assert.match(readProfile(h2.root).reason, /overhead/); } finally { h2.cleanup(); }
});

test('malformed frontmatter is invalid, with a reason', () => {
  const h = host('no frontmatter here\n');
  try {
    const { profile, reason } = readProfile(h.root);
    assert.equal(profile, null);
    assert.match(reason, /frontmatter/);
  } finally { h.cleanup(); }
});
