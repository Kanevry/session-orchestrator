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
 *   6. B3 stops seeing a bare `expect(res.status).toBe(0)` in a deny-capable
 *      hook test → the #906 assert-nothing regrows and a hook that flips from
 *      allow to deny keeps its tests green (both directions exit 0).
 *   7. B3's scope gate widens to non-deny hooks or husky/CLI spawns → 200+
 *      legitimate exit-0 assertions light up, the advisory becomes noise and
 *      gets muted. (Measured 2026-07-29: 223 findings without the gate, 0 with.)
 *   8. B3's discriminator set shrinks → migrated `expectAllow`/`expectDeny`/
 *      stdout blocks get flagged, same mute-it failure mode from the other side.
 *   9. B4 stops seeing a restated decision envelope → the 6 local helper copies
 *      and 21 soft `toContain('"permissionDecision":"deny"')` substring asserts
 *      regrow and survive the next protocol change verbatim.
 *  10. B4 starts flagging comment prose, helper-routed reads or absence guards →
 *      12 docblock lines + the sanctioned `expectDeny(...)` usage go red.
 *  11. B5 stops seeing a hardcoded date asserted against a subject that takes an
 *      injectable clock elsewhere in the same file → the `test-fixture-time-bomb`
 *      class regrows and CI turns red on a calendar date nobody chose (it did:
 *      2026-07-30, tests/lib/reconcile/emitter.test.mjs, with no code change).
 *  12. B5's seam-proof gate widens to "any date literal" → 150 legitimate date
 *      assertions light up, the advisory becomes noise and gets muted.
 *      (Measured 2026-07-30: 150 naive hits across tests/, 3 with the gate —
 *      exactly the three real bombs.)
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

// ---------------------------------------------------------------------------
// B3 / B4 — the hook-decision bans
// ---------------------------------------------------------------------------

/** A deny-capable hook: its source emits the permission-decision envelope. */
const DENY_HOOK_SRC = "import { emitDeny } from '../scripts/lib/io.mjs';\nemitDeny('nope');\n";
/** A hook with no deny channel at all — exit 0 there is unambiguous. */
const PLAIN_HOOK_SRC = "process.stdout.write('');\n";

/**
 * Build a hook-test fixture: a module-level HOOK constant plus one `it(` block.
 * @param {string} hookFile basename under hooks/
 * @param {string[]} body lines inside the it-block
 * @param {string[]} [extraTop] extra module-level lines (e.g. a second subject)
 */
const hookTest = (hookFile, body, extraTop = []) =>
  [
    `const HOOK = path.resolve(import.meta.dirname, '../../hooks/${hookFile}');`,
    ...extraTop,
    "it('runs', () => {",
    '  const result = spawnSync(process.execPath, [HOOK]);',
    ...body,
    '});',
    '',
  ].join('\n');

describe('check-test-value-bans — B3 bare exit-code on a deny-capable hook', () => {
  it('flags a bare exit-0 assertion when nothing in the block tells allow from deny', () => {
    const { res, json } = scan({
      'hooks/guard.mjs': DENY_HOOK_SRC,
      'tests/guard.test.mjs': hookTest('guard.mjs', ['  expect(result.status).toBe(0);']),
    });

    expect(res.status).toBe(0); // still advisory
    expect(json.counts['B3-bare-hook-exit-code']).toBe(1);
    expect(json.findings[0]).toMatchObject({
      file: 'tests/guard.test.mjs',
      line: 4,
      ban: 'B3-bare-hook-exit-code',
      match: 'expect(result.status).toBe(0);',
    });
  });

  it.each([
    ['expectAllow', '  expectAllow(result);'],
    ['expectDeny', "  expectDeny(result, 'blocked');"],
    ['stdout assertion', "  expect(result.stdout.trim()).toBe('');"],
  ])('stays silent when the block carries a %s discriminator', (_label, discriminator) => {
    const { json } = scan({
      'hooks/guard.mjs': DENY_HOOK_SRC,
      'tests/guard.test.mjs': hookTest('guard.mjs', [
        '  expect(result.status).toBe(0);',
        discriminator,
      ]),
    });

    expect(json.counts['B3-bare-hook-exit-code']).toBe(0);
  });

  it('ignores a hook with no deny channel — exit 0 is unambiguous there', () => {
    const { json } = scan({
      'hooks/on-session-start.mjs': PLAIN_HOOK_SRC,
      'tests/plain.test.mjs': hookTest('on-session-start.mjs', [
        '  expect(result.status).toBe(0);',
      ]),
    });

    expect(json.counts['B3-bare-hook-exit-code']).toBe(0);
  });

  it('ignores a file that also drives a non-deny hook (mixed subject)', () => {
    const { json } = scan({
      'hooks/guard.mjs': DENY_HOOK_SRC,
      'hooks/run-node.sh': '#!/bin/sh\n',
      'tests/mixed.test.mjs': hookTest('guard.mjs', ['  expect(result.status).toBe(0);'], [
        "const SHIM = path.join(REPO_ROOT, 'hooks', 'run-node.sh');",
      ]),
    });

    expect(json.counts['B3-bare-hook-exit-code']).toBe(0);
  });

  it('ignores a file that declares no hook subject at all (CLI / husky test)', () => {
    const { json } = scan({
      'hooks/guard.mjs': DENY_HOOK_SRC,
      'tests/cli.test.mjs': [
        "const SCRIPT = resolve(__dirname, '../../scripts/validate-wave-scope.mjs');",
        "it('exits 0', () => {",
        '  const r = spawnSync(process.execPath, [SCRIPT]);',
        '  expect(r.status).toBe(0);',
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B3-bare-hook-exit-code']).toBe(0);
  });
});

describe('check-test-value-bans — B4 decision contract copied outside its owner', () => {
  it('flags a restated envelope-key literal (the soft substring-assert shape)', () => {
    const { json } = scan({
      'tests/soft.test.mjs':
        '  expect(result.stdout).toContain(\'"permissionDecision":"deny"\');\n',
    });

    expect(json.counts['B4-hook-decision-contract-copy']).toBe(1);
    expect(json.findings[0]).toMatchObject({
      file: 'tests/soft.test.mjs',
      line: 1,
      ban: 'B4-hook-decision-contract-copy',
    });
  });

  it('flags a hand-rolled positive assertion instead of the helper', () => {
    const { json } = scan({
      'tests/local.test.mjs': [
        'const parsed = JSON.parse(result.stdout);',
        "expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');",
        '',
      ].join('\n'),
    });

    expect(json.counts['B4-hook-decision-contract-copy']).toBe(1);
    expect(json.findings[0]).toMatchObject({ line: 2 });
  });

  it.each([
    ['comment prose', ' * to stderr. It now travels inside `permissionDecisionReason`,'],
    ['line comment', '// substring \'"permissionDecision":"deny"\' survives re-nesting'],
    ['helper-routed read', 'const r = expectDeny(result).hookSpecificOutput.permissionDecisionReason;'],
    ['absence guard', 'expect(out.permissionDecision).toBeUndefined();'],
  ])('stays silent on %s', (_label, line) => {
    const { json } = scan({ 'tests/ok.test.mjs': line + '\n' });

    expect(json.counts['B4-hook-decision-contract-copy']).toBe(0);
  });

  it('exempts the declared contract owners (producer + bridge tests)', () => {
    const violation = "expect(obj.hookSpecificOutput.permissionDecision).toBe('deny');\n";
    const owned = scan({
      'tests/lib/io.test.mjs': violation,
      'tests/lib/pi-hook-bridge.test.mjs': violation,
    }).json;
    const foreign = scan({ 'tests/lib/other.test.mjs': violation }).json;

    expect(owned.counts['B4-hook-decision-contract-copy']).toBe(0);
    expect(foreign.counts['B4-hook-decision-contract-copy']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B5 — date-literal time bombs
// ---------------------------------------------------------------------------

/** The seam-proving block every B5 fixture needs: a call that hands over a clock. */
const SEAM_BLOCK = [
  "it('honours the injected clock', () => {",
  "  const meta = toActivationMetadata(learning, { now: new Date('2026-07-05T00:00:00Z') });",
  "  expect(meta.expiresAt).toBe('2026-07-12');",
  '});',
];

const EMITTER_IMPORT = "import { toActivationMetadata } from '../scripts/lib/reconcile/emitter.mjs';";

describe('check-test-value-bans — B5 date-literal time bombs', () => {
  it('flags a pinned date in a block that ignores the seam its siblings use', () => {
    const { res, json } = scan({
      'tests/bomb.test.mjs': [
        EMITTER_IMPORT,
        '',
        ...SEAM_BLOCK,
        '',
        "it('derives the per-type expiry', () => {",
        '  const meta = toActivationMetadata(learning, {});',
        "  expect(meta.expiresAt).toBe('2026-08-05');",
        '});',
        '',
      ].join('\n'),
    });

    expect(res.status).toBe(0); // warn-only, like every other ban here
    expect(json.counts['B5-date-time-bomb']).toBe(1);
    expect(json.findings[0]).toMatchObject({
      file: 'tests/bomb.test.mjs',
      line: 10,
      ban: 'B5-date-time-bomb',
      match: ".toBe('2026-08-05') — toActivationMetadata() called without its clock seam",
    });
  });

  it('says nothing when no block in the file ever injects a clock', () => {
    // The seam proof is what puts a subject in scope. A pure input→output date
    // function never grows a `now` parameter, so it is out of scope by
    // construction — this is the passthrough false-positive class.
    const { json } = scan({
      'tests/no-seam.test.mjs': [
        "import { deriveExpiresAt } from '../scripts/lib/learnings.mjs';",
        '',
        "it('adds the 60d default to the supplied date', () => {",
        "  const out = deriveExpiresAt('2026-05-01T00:00:00Z', 'unknown-type');",
        "  expect(out).toBe('2026-06-30T00:00:00.000Z');",
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
    expect(json.findings).toEqual([]);
  });

  it('exempts a block that freezes the global clock instead of using the seam', () => {
    const { json } = scan({
      'tests/frozen.test.mjs': [
        EMITTER_IMPORT,
        '',
        ...SEAM_BLOCK,
        '',
        "it('derives the per-type expiry under a frozen clock', () => {",
        "  vi.setSystemTime(new Date('2026-07-05T00:00:00Z'));",
        '  const meta = toActivationMetadata(learning, {});',
        "  expect(meta.expiresAt).toBe('2026-08-05');",
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });

  it('ignores date literals in INPUT position — only expected values are read', () => {
    const { json } = scan({
      'tests/passthrough.test.mjs': [
        EMITTER_IMPORT,
        '',
        ...SEAM_BLOCK,
        '',
        "it('passes created_at through untouched', () => {",
        "  const meta = toActivationMetadata({ created_at: '2026-06-21T00:00:00Z' }, {});",
        '  expect(meta.createdAt).toBe(input.created_at);',
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });
});

describe('check-test-value-bans — CLI contract', () => {
  it('--json emits the advisory/scanned/counts/findings shape consumers parse', () => {
    const { json } = scan({ 'tests/shape.test.mjs': 'expect(a).toHaveLength(9);\n' });

    expect(json).toMatchObject({
      advisory: true,
      scanned: 1,
      counts: {
        'B1-exact-count': 1,
        'B2-prose-pin-suspected': 0,
        'B3-bare-hook-exit-code': 0,
        'B4-hook-decision-contract-copy': 0,
        'B5-date-time-bomb': 0,
      },
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

  // bug_caught: a `process.exit(0)` tail truncated stdout on a PIPE once the
  // payload passed the ~64 KiB pipe buffer — `--json | jq` got cut-off JSON
  // while `--json > file` was complete. Scanning the real corpus is the only
  // way to exceed that buffer, so this test uses the repo root, not a fixture.
  it('emits complete JSON through a pipe on the full corpus (no exit-truncation)', () => {
    const res = spawnSync(
      '/bin/sh',
      ['-c', `"${process.execPath}" "${SCRIPT}" "${REPO_ROOT}" --json | cat`],
      { encoding: 'utf8', timeout: 60_000 },
    );

    expect(res.status).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(65_536); // past the pipe buffer
    expect(() => JSON.parse(res.stdout)).not.toThrow();
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
