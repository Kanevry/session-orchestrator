// @test-value-bans-allowed — this file embeds ban signatures (toHaveLength(<n>),
// .md prose-pin shapes) as fixture literals for the validator under test.
/**
 * tests/lib/validate/check-test-value-bans.test.mjs
 *
 * Tests for scripts/lib/validate/check-test-value-bans.mjs.
 *
 * Named bugs these lock in (TV-001):
 *   1. B1 misses `toHaveLength(<n>)` / `.length).toBe(<n>)` → the ban is dead
 *      and count-drift pins keep landing (the 3× recurrence in testing.md).
 *   2. The `// integrity-anchor:` carve-out stops working → legitimate fixed
 *      width assertions get flagged, the advisory becomes noise, devs mute it.
 *   3. The 0/1 exemption regresses → every emptiness assert is reported and
 *      the advisory drowns (same mute-it failure mode from the other side).
 *   4. --json loses a key → the hook / CI consumers that parse it break.
 *   5. The check starts exiting non-zero → it becomes a blocking gate on a
 *      366-finding corpus, which is not what warn-only v1 promises.
 *
 * Fixtures are written into tmpdirs at runtime: a committed fixture file
 * carrying ban signatures would be flagged by the check's own repo-wide scan.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-test-value-bans.mjs');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Write test fixtures into a tmp root and scan them via --stdin (the mode the
 * pre-commit hook uses).
 * @param {Record<string, string>} files relative path → source text
 * @param {string[]} extraFlags
 */
function scan(files, extraFlags = ['--json']) {
  const root = mkdtempSync(join(tmpdir(), 'so-tvb-'));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const res = spawnSync(process.execPath, [SCRIPT, root, '--stdin', ...extraFlags], {
    encoding: 'utf8',
    input: Object.keys(files).join('\n'),
    timeout: 20_000,
  });
  return { res, json: extraFlags.includes('--json') ? JSON.parse(res.stdout) : null };
}

describe('check-test-value-bans — B1 exact count assertions', () => {
  it('reports toHaveLength(<n>) and .length).toBe(<n>) with file + line', () => {
    const { res, json } = scan({
      'tests/a.test.mjs': [
        'it("x", () => {',
        '  expect(skills).toHaveLength(42);',
        '  expect(Object.keys(map).length).toBe(7);',
        '});',
        '',
      ].join('\n'),
    });

    expect(res.status).toBe(0); // warn-only: findings never change the exit code
    expect(json.counts['B1-exact-count']).toBe(2);
    expect(json.findings[0]).toMatchObject({
      file: 'tests/a.test.mjs',
      line: 2,
      ban: 'B1-exact-count',
      match: '.toHaveLength(42)',
    });
    expect(json.findings[1]).toMatchObject({ line: 3, match: '.length).toBe(7)' });
  });

  it('respects the integrity-anchor carve-out on the same line and the line above', () => {
    const { json } = scan({
      'tests/anchor.test.mjs': [
        'it("sha", () => {',
        '  expect(sha).toHaveLength(40); // integrity-anchor: git SHA-1 is fixed-width',
        '  // integrity-anchor: protocol tuple is fixed at 3 fields',
        '  expect(tuple).toHaveLength(3);',
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B1-exact-count']).toBe(0);
    expect(json.findings).toEqual([]);
  });

  it('exempts the 0 and 1 literals (emptiness / uniqueness invariants)', () => {
    const { json } = scan({
      'tests/zero.test.mjs': [
        'expect(violations).toHaveLength(0);',
        'expect(matches).toHaveLength(1);',
        'expect(entries).toHaveLength(2);',
        '',
      ].join('\n'),
    });

    expect(json.counts['B1-exact-count']).toBe(1);
    expect(json.findings[0]).toMatchObject({ line: 3, match: '.toHaveLength(2)' });
  });

  it('skips files carrying the @test-value-bans-allowed opt-out comment', () => {
    const { json } = scan({
      'tests/opted-out.test.mjs': [
        '// @test-value-bans-allowed — fixture literals below',
        'expect(items).toHaveLength(42);',
        '',
      ].join('\n'),
    });

    expect(json.findings).toEqual([]);
    expect(json.scanned).toBe(1); // still counted as scanned, just not reported
  });
});

describe('check-test-value-bans — B2 suspected prose pins', () => {
  it('flags a .md read combined with >=3 toContain/toMatch, but not with 2', () => {
    const proseAsserts = (n) =>
      Array.from({ length: n }, (_, i) => `  expect(doc).toContain("heading ${i}");`).join('\n');
    const fixture = (n) =>
      ['const doc = readFileSync("docs/guide.md", "utf8");', 'it("doc", () => {', proseAsserts(n), '});', ''].join('\n');

    const flagged = scan({ 'tests/pin.test.mjs': fixture(3) }).json;
    const clean = scan({ 'tests/nopin.test.mjs': fixture(2) }).json;

    expect(flagged.counts['B2-prose-pin-suspected']).toBe(1);
    expect(flagged.findings[0]).toMatchObject({ file: 'tests/pin.test.mjs', line: 1 });
    expect(clean.counts['B2-prose-pin-suspected']).toBe(0);
  });
});

describe('check-test-value-bans — CLI contract', () => {
  it('--json emits the advisory/scanned/counts/findings shape consumers parse', () => {
    const { json } = scan({ 'tests/shape.test.mjs': 'expect(a).toHaveLength(9);\n' });

    expect(json).toMatchObject({
      advisory: true,
      scanned: 1,
      counts: { 'B1-exact-count': 1, 'B2-prose-pin-suspected': 0 },
    });
    expect(Array.isArray(json.findings)).toBe(true);
    expect(Object.keys(json.findings[0]).sort()).toEqual(['ban', 'file', 'hint', 'line', 'match']);
  });

  it('exits 0 in human mode even with findings, and prints them to stdout', () => {
    const { res } = scan({ 'tests/human.test.mjs': 'expect(a).toHaveLength(9);\n' }, []);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('B1-exact-count');
    expect(res.stdout).toContain('tests/human.test.mjs:1');
  });

  it('exits 2 on an unknown flag (tool error, per cli-design.md)', () => {
    const res = spawnSync(process.execPath, [SCRIPT, REPO_ROOT, '--nope'], {
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Unknown flag');
  });
});
