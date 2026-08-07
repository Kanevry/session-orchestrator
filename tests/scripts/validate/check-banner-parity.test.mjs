/**
 * tests/scripts/validate/check-banner-parity.test.mjs
 *
 * Coverage for the #621 HISTORICAL guard banner invariant canary.
 *
 * The bug class this guards: the banner literal lives once in code
 * (`HISTORICAL_GUARD_BANNER`) and seven times as prose in skill markdown. Nothing
 * recompiles when markdown changes, so a reword on the prose side diverges from
 * the SSOT silently and the stale-replay guard degrades without a single test
 * going red. Residual (named, not covered here): a reword that destroys BOTH
 * detection-marker phrases removes the site from the census entirely — that
 * degenerate case equals whole-site deletion and is owned by the placement
 * tests in `tests/skills/session-start/` (see the module header's residuals).
 *
 * The load-bearing case is the fake-regression below: a green check NEVER proves
 * a drift guard bites — only a red-on-drift observation does
 * (`.claude/rules/testing.md` § Negative-Assertion Fake-Regression Check).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  BANNER_FIRST_SENTENCE,
  DETECTION_MARKER,
  DETECTION_MARKERS,
  classifyBannerSite,
  inspectBannerParity,
  normalizeQuotedLine,
} from '../../../scripts/lib/validate/check-banner-parity.mjs';
import { HISTORICAL_GUARD_BANNER } from '../../../scripts/lib/historical-guard.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/lib/validate/check-banner-parity.mjs');
const fixtureRoots = [];

/**
 * Build a throwaway plugin root containing markdown under `skills/`.
 * Deliberately NOT a git repo: enumeration must fall back to the filesystem walk.
 *
 * @param {Record<string, string>} files relative path under skills/ -> body
 * @returns {string} absolute fixture root
 */
function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'banner-parity-'));
  fixtureRoots.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const target = join(root, 'skills', relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

function withEnv(name, value, callback) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

afterEach(() => {
  while (fixtureRoots.length > 0) rmSync(fixtureRoots.pop(), { recursive: true, force: true });
});

describe('check-banner-parity.mjs — derived constants', () => {
  it('derives the detection marker from the SSOT instead of a second hardcoded copy', () => {
    expect(DETECTION_MARKER).toBe('HISTORICAL REFERENCE ONLY');
    expect(HISTORICAL_GUARD_BANNER).toContain(DETECTION_MARKER);
  });

  it('derives BOTH disjunctive detection markers from the SSOT', () => {
    expect(DETECTION_MARKERS).toEqual(['HISTORICAL REFERENCE ONLY', 'NOT LIVE INSTRUCTIONS']);
    for (const marker of DETECTION_MARKERS) {
      expect(HISTORICAL_GUARD_BANNER).toContain(marker);
    }
  });

  it('derives the elision floor as the load-bearing first sentence', () => {
    expect(BANNER_FIRST_SENTENCE).toBe('⚠ HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS.');
    expect(HISTORICAL_GUARD_BANNER.startsWith(BANNER_FIRST_SENTENCE)).toBe(true);
  });
});

describe('check-banner-parity.mjs — current repository', () => {
  it('passes every banner site and reports the measured census', () => {
    const result = inspectBannerParity(REPO_ROOT);
    // Floor-only (never an exact count): guards a vacuous green where the scanner
    // silently matches nothing, while leaving site growth/removal unpinned.
    expect({ ok: result.ok, findings: result.findings }).toEqual({ ok: true, findings: [] });
    expect(result.summary.sites).toBeGreaterThanOrEqual(2);
    expect(result.summary.files).toBeGreaterThanOrEqual(2);
    expect(result.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'skills/session-start/SKILL.md', form: 'full' }),
        expect.objectContaining({
          file: 'skills/session-start/presentation-format.md',
          form: 'elided',
        }),
      ]),
    );
  });

  it('reports the canonical CLI pass result with exit 0', () => {
    const run = spawnSync('node', [SCRIPT, REPO_ROOT], { encoding: 'utf8', timeout: 15_000 });
    expect({ status: run.status, output: run.stdout }).toEqual({
      status: 0,
      output: expect.stringContaining('Results: 1 passed, 0 failed'),
    });
  });
});

describe('check-banner-parity.mjs — fake-regression (the guard must bite)', () => {
  it('fails and names the file when a prose site rewords the banner', () => {
    const reworded = HISTORICAL_GUARD_BANNER.replace(
      'NOT LIVE INSTRUCTIONS',
      'NOT CURRENT INSTRUCTIONS',
    );
    const root = makeFixture({ 'session-start/SKILL.md': `> \`${reworded}\`\n` });

    const result = inspectBannerParity(root);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: 'banner-divergence',
        file: 'skills/session-start/SKILL.md',
        line: 1,
        message: expect.stringContaining('diverges from HISTORICAL_GUARD_BANNER'),
      }),
    ]);
  });

  it('returns exit 1 and names the offending file on the CLI', () => {
    const reworded = HISTORICAL_GUARD_BANNER.replace('Do NOT re-execute', 'Feel free to re-execute');
    const root = makeFixture({ 'session-start/SKILL.md': `> \`${reworded}\`\n` });

    const run = spawnSync('node', [SCRIPT, root], { encoding: 'utf8', timeout: 15_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('skills/session-start/SKILL.md:1');
    expect(run.stdout).toContain('Results: 0 passed, 1 failed');
  });

  it('catches a rotted site even when a sibling site in the same file is intact', () => {
    // A file-wide `includes(BANNER)` assertion is GREEN for this input — one
    // intact copy satisfies it while the second site has rotted.
    const rotted = HISTORICAL_GUARD_BANNER.replace('current git state', 'the session log');
    const body = `> \`${HISTORICAL_GUARD_BANNER}\`\n\nprose\n\n> \`${rotted}\`\n`;
    const root = makeFixture({ 'session-start/SKILL.md': body });

    expect(body).toContain(HISTORICAL_GUARD_BANNER); // the weaker assertion passes
    const result = inspectBannerParity(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map(({ line }) => line)).toEqual([5]);
  });

  it('catches a reword of the FIRST marker phrase via the second marker (F1 disjunction)', () => {
    // Before the disjunction, rewording 'HISTORICAL REFERENCE ONLY' removed the
    // site from the census entirely — green while the most destructive reword
    // class shipped. The second SSOT-derived marker keeps the site visible.
    const markerReworded = HISTORICAL_GUARD_BANNER.replace(
      'HISTORICAL REFERENCE ONLY',
      'HISTORICAL CONTEXT',
    );
    const root = makeFixture({ 'session-start/SKILL.md': `> \`${markerReworded}\`\n` });

    const result = inspectBannerParity(root);
    expect({ ok: result.ok, sites: result.summary.sites }).toEqual({ ok: false, sites: 1 });
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'banner-divergence', line: 1 }),
    ]);
  });

  it('rejects an elision that truncates below the load-bearing first sentence', () => {
    const root = makeFixture({
      'session-start/presentation-format.md': '⚠ HISTORICAL REFERENCE ONLY …\n',
    });

    const result = inspectBannerParity(root);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'banner-divergence', line: 1 }),
    ]);
  });

  it('censuses the fixture root even when an ambient GIT_DIR points elsewhere', () => {
    // Without the git env allowlist + toplevel check, `git ls-files` would
    // enumerate the FOREIGN repo and pass vacuously. The fixture path MUST NOT
    // collide with a path in the real repo index: with a colliding path
    // (e.g. skills/session-start/SKILL.md) the foreign census accidentally
    // lands on the fixture file and a de-hardened module stays red too —
    // the test then discriminates nothing (reviewed 2026-08-07, B1).
    const reworded = HISTORICAL_GUARD_BANNER.replace('prior session', 'previous run');
    const root = makeFixture({ 'zzz-banner-fixture/NOTE.md': `> \`${reworded}\`\n` });

    const result = withEnv('GIT_DIR', join(REPO_ROOT, '.git'), () => inspectBannerParity(root));
    expect(result.ok).toBe(false);
    expect(result.summary.sites).toBe(1);
  });
});

describe('check-banner-parity.mjs — accepted quoting forms', () => {
  it.each([
    { name: 'a blockquoted, backticked quote', line: `> \`${HISTORICAL_GUARD_BANNER}\`` },
    { name: 'an indented, backticked quote', line: `   \`${HISTORICAL_GUARD_BANNER}\`` },
    { name: 'a nested blockquote', line: `> > ${HISTORICAL_GUARD_BANNER}` },
    { name: 'a bare line', line: HISTORICAL_GUARD_BANNER },
    { name: 'an inline prose quote', line: `Prefix with \`${HISTORICAL_GUARD_BANNER}\` first.` },
    { name: 'an ellipsis-elided quote', line: `${BANNER_FIRST_SENTENCE} …` },
    { name: 'a dot-elided quote', line: `${BANNER_FIRST_SENTENCE} ...` },
  ])('accepts $name', ({ line }) => {
    const root = makeFixture({ 'session-start/SKILL.md': `${line}\n` });
    const result = inspectBannerParity(root);
    expect({ ok: result.ok, sites: result.summary.sites }).toEqual({ ok: true, sites: 1 });
  });

  it('passes with exit 0 when no file carries the marker at all', () => {
    const root = makeFixture({ 'session-start/SKILL.md': '# No banner here\n' });
    const run = spawnSync('node', [SCRIPT, root], { encoding: 'utf8', timeout: 15_000 });
    expect({ status: run.status, output: run.stdout }).toEqual({
      status: 0,
      output: expect.stringContaining('Results: 1 passed, 0 failed'),
    });
  });
});

describe('check-banner-parity.mjs — unit helpers', () => {
  it('strips blockquote prefixes and surrounding backticks', () => {
    expect(normalizeQuotedLine('>  > `banner text`  ')).toBe('banner text');
  });

  it('classifies the canonical literal as the full form', () => {
    expect(classifyBannerSite(HISTORICAL_GUARD_BANNER)).toEqual({ ok: true, form: 'full' });
  });

  it('rejects a divergent line with no elision marker', () => {
    expect(classifyBannerSite('⚠ HISTORICAL REFERENCE ONLY — read at your own risk.')).toEqual({
      ok: false,
      form: 'divergent',
    });
  });
});
