// @test-value-bans-allowed — this file embeds ban signatures (toHaveLength(<n>),
// .md prose-pin shapes) as fixture literals for the validator under test.
/**
 * tests/lib/validate/check-test-value-bans.test.mjs
 *
 * Tests for scripts/lib/validate/check-test-value-bans.mjs.
 *
 * Named bugs these lock in (TV-001):
 *   1. B1 misses a DYNAMIC-derived `toHaveLength(<n>)` / `.length).toBe(<n>)`
 *      (subject traced to readdirSync / Object.keys / a walk) → the ban is dead
 *      and count-drift pins keep landing (the 3× recurrence in testing.md).
 *   1b. B1 REGROWS its v1 over-report — flags a fixed arity over a STATIC
 *      fixture (a hand-built array, a parsed record) that never drifts → the
 *      ~349-finding noise returns and the advisory gets muted (#911).
 *   1c. The hardened length regex regresses to the `\s*\)?\s*\)?\s*` adjacency →
 *      polynomial backtracking (ReDoS) on a pathological `.length` line (#911).
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
 *  13. B4 stops seeing a hand-rolled `systemMessage` warn-envelope restatement
 *      in a deny-capable-hook test → the emitWarn warn contract is copied
 *      outside the helper and survives the next protocol change verbatim, the
 *      way `permissionDecision` copies did (#941 3b — the warn envelope carries
 *      NO `permissionDecision`, so keying only on it made warn blocks invisible).
 *  14. B4's systemMessage arm loses its deny-capable-hook scope gate → the plain
 *      `systemMessage` output of operator-steer / the session-start banner
 *      false-positives, since that key is overloaded (warn carrier vs plain out).
 *  15. B2 regresses to a WHOLE-FILE assert count reported at the FIRST .md
 *      read's line (#1148) — two populations with no causal relation. The
 *      reported location then drifts without the finding changing (filed
 *      2026-08-23 as tests/unit/vault-mirror.test.mjs:1077, reported :1415
 *      three days later with the same 52 asserts; nothing happened at line
 *      1077, the first .md read moved 338 lines), AND every later .md read in
 *      the file is masked because findIndex stops at the first.
 *  16. The --stdin (pre-commit) path reports findings on lines this commit
 *      does not touch (#1148) — editing one line of a long test file surfaces
 *      every pre-existing finding in it, so the warning is about work the
 *      committer did not do and gets trained away. The unscoped CI job
 *      `test-value-bans` is what keeps the repo-wide census.
 *  17. B5 stops seeing subjects imported through a vitest alias (`@lib/`) → 303
 *      of 715 test files (measured 2026-09-30) are unreachable by the scan
 *      again, and every clock-seam time bomb in them ships unseen (#1476).
 *  18. B5's clock check forgets property shorthand `{ now }` → a block that
 *      hands the clock over is flagged as uncontrolled (11 of the 19 false
 *      positives measured 2026-09-30 when the alias was first added).
 *  19. B5 flags a date that only echoes an input of its own block or of the
 *      shared setup → the passthrough class floods the advisory (the other 8
 *      false positives of that measurement).
 *  20. B5's echo check widens to the whole file → a sibling test that asserts
 *      the same date hides a real bomb (the two 2026-08-05 bombs of fa57ee66^
 *      vanished in all 8 realistic variants measured 2026-09-30).
 *  21. B5's seam proof reads the WIDE clock form of the controlled-block check →
 *      a helper whose only clock token is a shorthand/positional `now` becomes a
 *      "subject", and a date pinned next to it is reported (+20 seamed pairs in
 *      15 files measured 2026-10-01, e.g. `expectDeny` in enforce-scope, #1478).
 *  22. B5 counts a handover of the REAL clock as clock control — `const now =
 *      Date.now(); fn(now)`, `{ now }` from `new Date()`, `{ now: new Date() }`
 *      — so a block that reads the wall clock and pins a date stays silent: a
 *      genuine time bomb hidden by the rule built to find it (#1487 item 8).
 *  23. B5 reads clock bindings block-wise only → a module-level or `beforeEach`
 *      `now = Date.now()` handed over as `{ now }` counts as control and the bomb
 *      stays silent (#1489 item 16). The counter-examples pin the precision side
 *      of reading the setup: a block's own rebinding, a clock frozen in setup,
 *      and a name the file-wide setup binds both ways.
 *  24. B5 lets a setup fake timer exempt the whole file → a `vi.useFakeTimers()`
 *      in one `describe`'s beforeEach silences a real-clock bomb in a SIBLING
 *      `describe` it never runs for (review of 3206ab24); or counts a bare
 *      `advanceTimersByTime` as freezing the clock. The counter-example pins the
 *      other side: a fake timer in an ENCLOSING `describe` still exempts.
 *  25. B5 knows only camelCase clock names → `const NOW = Date.now()` handed
 *      over as `{ now: NOW }` counts as control (a silent bomb), and a fixed
 *      `NOW` / `FIXED_NOW` handed over positionally counts as NO control (a false
 *      finding) — 29 test files bind `NOW`, 10 `FIXED_NOW` (#1499 item 7).
 *  26. B5 reads any fake-timer installer as a frozen DATE → a bare
 *      `useFakeTimers()` (vitest 4 installs it at the real `Date.now()`), a
 *      timers-only `toFake` or a real-clock `setSystemTime` exempts a genuine
 *      bomb (#1499 item 8). The counter-example pins a date-naming config.
 *  27. B5 lets a freeze exempt a block that hands over a clock read at
 *      COLLECTION time (module level, `describe` body) — before any hook ran,
 *      so the freeze never reaches that value (#1499 item 9).
 *  28. B5 counts a helper function's local `now = Date.now()` as read at
 *      collection time → a block that freezes the clock and then calls the
 *      helper is reported (12 of 13 such corpus bindings were helper locals,
 *      review of ac3ded47). Only module level and a `describe` body count.
 *  29. B5 reads `vi.setSystemTime(now)` / `useFakeTimers({ now })` as a pin
 *      although the scanner knows `now` was bound to the real clock → a real
 *      bomb stays exempt (review of ac3ded47).
 *
 * Fixtures are written into tmpdirs at runtime: a committed fixture file
 * carrying ban signatures would be flagged by the check's own repo-wide scan.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vitestConfig from '../../../vitest.config.mjs';

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
  it('reports a dynamic-derived toHaveLength(<n>) and .length).toBe(<n>) with file + line', () => {
    const { res, json } = scan({
      'tests/a.test.mjs': [
        'const skills = readdirSync(skillsDir);', // traced dynamic source
        'it("x", () => {',
        '  expect(skills).toHaveLength(42);',
        '  expect(Object.keys(map).length).toBe(7);', // inline dynamic source
        '});',
        '',
      ].join('\n'),
    });

    expect(res.status).toBe(0); // warn-only: findings never change the exit code
    expect(json.counts['B1-exact-count']).toBe(2);
    expect(json.findings[0]).toMatchObject({
      file: 'tests/a.test.mjs',
      line: 3,
      ban: 'B1-exact-count',
      match: '.toHaveLength(42)',
    });
    expect(json.findings[1]).toMatchObject({ line: 4, match: '.length).toBe(7)' });
  });

  it('does NOT flag a fixed arity over a static fixture (the #911 v1 over-report)', () => {
    const { json } = scan({
      'tests/static.test.mjs': [
        'it("static counts do not drift on catalog growth", () => {',
        '  const records = [{ a: 1 }, { b: 2 }];', // hand-built array
        '  expect(records).toHaveLength(2);',
        '  expect([1, 2, 3].length).toBe(3);', // inline literal array
        '  expect(parsed.rows).toHaveLength(4);', // property of a parsed record
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B1-exact-count']).toBe(0);
    expect(json.findings).toEqual([]);
  });

  it('flags the same arity when the subject is derived from a dynamic source', () => {
    const { json } = scan({
      'tests/dynamic.test.mjs': [
        'it("dynamic counts drift on catalog growth", () => {',
        '  const files = readdirSync(dir);', // directory walk
        '  expect(files).toHaveLength(2);', // traced to readdirSync
        '  expect(Object.keys(registry)).toHaveLength(3);', // inline export map
        '  expect(Object.values(map).length).toBe(4);', // inline registry
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B1-exact-count']).toBe(3);
    expect(json.findings.map((f) => f.line)).toEqual([3, 4, 5]);
  });

  it('does not catastrophically backtrack on a pathological .length line (ReDoS guard)', () => {
    // A `.length` followed by a long whitespace run and a FAILING `.toBe(` was
    // the polynomial-backtracking trigger in v1's `\s*\)?\s*\)?\s*` adjacency
    // (measured: the old regex hung >2min on this input; the hardened `[\s)]*`
    // class matches it in ~0ms). A regression to the ambiguous form would blow
    // the 20s spawn timeout below, turning this red.
    const pathological = 'expect(x.length' + ' '.repeat(100_000) + 'y).toBe(2);\n';
    const { res, json } = scan({ 'tests/redos.test.mjs': pathological });

    expect(res.status).toBe(0);
    expect(json.counts['B1-exact-count']).toBe(0); // the trailing `.toBe(` never matches
  });

  it('respects the integrity-anchor carve-out on the same line and the line above', () => {
    // Subjects are dynamic (Object.keys) so they WOULD flag — the carve-out is
    // what suppresses them, which is the behaviour under test.
    const { json } = scan({
      'tests/anchor.test.mjs': [
        'it("sha", () => {',
        '  expect(Object.keys(digests)).toHaveLength(40); // integrity-anchor: fixed-width',
        '  // integrity-anchor: protocol tuple is fixed at 3 fields',
        '  expect(Object.keys(tuple)).toHaveLength(3);',
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
        'expect(Object.keys(violations)).toHaveLength(0);',
        'expect(Object.keys(matches)).toHaveLength(1);',
        'expect(Object.keys(entries)).toHaveLength(2);',
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
        'expect(Object.keys(items)).toHaveLength(42);', // dynamic, but opted out
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

  // --- #941 3b: the warn envelope's systemMessage key -----------------------
  // emitWarn's operator notice rides a TOP-LEVEL systemMessage and carries NO
  // permissionDecision, so a hand-rolled warn-contract block was invisible to a
  // B4 keyed only on permissionDecision. The key is overloaded (warn carrier vs
  // plain hook output), so this arm is scope-gated on a deny-capable-hook test.

  it('flags a hand-rolled systemMessage warn-envelope assertion in a deny-capable-hook test', () => {
    const { json } = scan({
      'hooks/guard.mjs': DENY_HOOK_SRC,
      'tests/warn.test.mjs': hookTest('guard.mjs', [
        '  const parsed = JSON.parse(result.stdout);',
        "  expect(parsed.systemMessage).toContain('Blocked');",
      ]),
    });

    expect(json.counts['B4-hook-decision-contract-copy']).toBe(1);
    expect(json.findings[0]).toMatchObject({
      file: 'tests/warn.test.mjs',
      ban: 'B4-hook-decision-contract-copy',
    });
  });

  it('flags the soft "systemMessage" substring literal in a deny-capable-hook test', () => {
    const { json } = scan({
      'hooks/guard.mjs': DENY_HOOK_SRC,
      'tests/soft-warn.test.mjs': hookTest('guard.mjs', [
        '  expect(result.stdout).toContain(\'"systemMessage":"⛔ Blocked"\');',
      ]),
    });

    expect(json.counts['B4-hook-decision-contract-copy']).toBe(1);
  });

  it('stays silent on a plain-hook systemMessage — overloaded key, not a warn contract', () => {
    const { json } = scan({
      'hooks/on-session-start.mjs': "process.stdout.write(JSON.stringify({ systemMessage: 'hi' }));\n",
      'tests/banner.test.mjs': hookTest('on-session-start.mjs', [
        '  const parsed = JSON.parse(result.stdout);',
        "  expect(parsed.systemMessage).toContain('hi');",
      ]),
    });

    expect(json.counts['B4-hook-decision-contract-copy']).toBe(0);
  });

  it('stays silent when the warn read goes through the expectWarn helper', () => {
    const { json } = scan({
      'hooks/guard.mjs': DENY_HOOK_SRC,
      'tests/warn.test.mjs': hookTest('guard.mjs', [
        '  const msg = expectWarn(result).systemMessage;',
        "  expect(msg).toContain('Blocked');",
      ]),
    });

    expect(json.counts['B4-hook-decision-contract-copy']).toBe(0);
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

// Every import form a real test file uses: relative, plus each vitest alias read from the real config.
const IMPORT_FORMS = [
  '../scripts/lib/reconcile/emitter.mjs',
  ...Object.keys(vitestConfig.resolve.alias).map((key) => `${key}/reconcile/emitter.mjs`),
];

/** A block that hands the clock over in property shorthand — `{ now }` is the seam in use, not an uncontrolled call. */
const SHORTHAND_CLOCK_BLOCK = [
  "it('derives the expiry from the clock it hands over', () => {",
  "  const now = new Date('2026-07-05T00:00:00Z');",
  '  const meta = toActivationMetadata(learning, { now });',
  "  expect(meta.expiresAt).toBe('2026-08-05');",
  '});',
];

/** The pinned date is an echo of an input the file itself supplies — a passthrough, not a clock reading. */
const ECHO_BLOCK = [
  "it('keeps the supplied reviewed_at', () => {",
  "  const meta = toActivationMetadata({ reviewed_at: '2026-06-21' }, {});",
  "  expect(meta.reviewedAt).toBe('2026-06-21');",
  '});',
];

/** A block that hands over a `now` it does not bind itself — the binding lives in the shared setup. */
const SETUP_CLOCK_BLOCK = [
  "it('derives the per-type expiry', () => {",
  '  const meta = toActivationMetadata(learning, { now });',
  "  expect(meta.expiresAt).toBe('2026-08-05');",
  '});',
];

/** A block that freezes the clock, then takes its `now` from a helper `make()` it calls after the freeze. */
const FROZEN_HELPER_BLOCK = [
  "it('derives the per-type expiry', () => {",
  "  vi.setSystemTime(new Date('2026-07-05T00:00:00Z'));",
  '  const { now } = make();',
  '  const meta = toActivationMetadata(learning, { now });',
  "  expect(meta.expiresAt).toBe('2026-08-05');",
  '});',
];

/** A seamed sibling that happens to assert the same date — its assertion is no input of the bomb's block. */
const SIBLING_SAME_DATE_BLOCK = [
  "it('reports the expiry inside the metadata object', () => {",
  "  const meta = toActivationMetadata(learning, { now: new Date('2026-07-05T00:00:00Z') });",
  "  expect(meta).toMatchObject({ expiresAt: '2026-08-05' });",
  '});',
];

describe('check-test-value-bans — B5 date-literal time bombs', () => {
  it.each(IMPORT_FORMS)('flags a pinned date in a block that ignores the seam its siblings use (import %s)', (spec) => {
    const { res, json } = scan({
      'tests/bomb.test.mjs': [
        `import { toActivationMetadata } from '${spec}';`,
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

  // #1487 item 8: each body hands over a clock-named value that IS the wall clock.
  it.each([
    [
      'positional `now` from Date.now()',
      ['  const now = Date.now();', '  const meta = toActivationMetadata(learning, now);'],
    ],
    [
      '`{ now }` from new Date()',
      ['  const now = new Date();', '  const meta = toActivationMetadata(learning, { now });'],
    ],
    [
      '`now:` reading the clock inline',
      [
        '  const learning = makeLearning();',
        '  const meta = toActivationMetadata(learning, { now: new Date() });',
      ],
    ],
    [
      '`now:` fed from a real-clock binding',
      [
        '  const nowMs = Date.now();',
        '  const meta = toActivationMetadata(learning, { now: nowMs - DAY_MS });',
      ],
    ],
  ])('flags a pinned date when the clock it hands over is the real one (%s)', (_shape, body) => {
    const { json } = scan({
      'tests/real-clock.test.mjs': [
        EMITTER_IMPORT,
        '',
        ...SEAM_BLOCK,
        '',
        "it('derives the per-type expiry', () => {",
        ...body,
        "  expect(meta.expiresAt).toBe('2026-08-05');",
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(1);
    expect(json.findings[0]).toMatchObject({
      file: 'tests/real-clock.test.mjs',
      line: 11,
      ban: 'B5-date-time-bomb',
    });
  });

  // #1489 item 16: the same real-clock handover, with the binding OUTSIDE the block.
  it.each([
    ['module-level `const now = Date.now()`', ['const now = Date.now();'], 11],
    ['`beforeEach` assigning `now = Date.now()`', ['let now;', 'beforeEach(() => {', '  now = Date.now();', '});'], 14],
  ])('flags a pinned date when the real clock it hands over is bound in the shared setup (%s)', (_shape, setup, line) => {
    const { json } = scan({
      'tests/setup-clock.test.mjs': [EMITTER_IMPORT, ...setup, '', ...SEAM_BLOCK, '', ...SETUP_CLOCK_BLOCK, ''].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(1);
    expect(json.findings[0]).toMatchObject({ file: 'tests/setup-clock.test.mjs', line, ban: 'B5-date-time-bomb' });
  });

  // Review of 3206ab24: the fake timer lives in a SIBLING describe's beforeEach, which vitest never runs for the bomb.
  it.each([
    ['the block only reads the real clock', [], 16],
    ['the block also advances timers no installer of its own faked', ['    vi.advanceTimersByTime(1_000);'], 17],
  ])('flags a real-clock bomb although a sibling `describe` installs a fake timer (%s)', (_shape, extra, line) => {
    const { json } = scan({
      'tests/sibling-timer.test.mjs': [
        EMITTER_IMPORT,
        "describe('under a frozen clock', () => {",
        '  beforeEach(() => {',
        '    vi.useFakeTimers();',
        '  });',
        ...SEAM_BLOCK.map((l) => `  ${l}`),
        '});',
        '',
        "describe('against the live clock', () => {",
        "  it('derives the per-type expiry', () => {",
        '    const now = Date.now();',
        ...extra,
        '    const meta = toActivationMetadata(learning, { now });',
        "    expect(meta.expiresAt).toBe('2026-08-05');",
        '  });',
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(1);
    expect(json.findings[0]).toMatchObject({
      file: 'tests/sibling-timer.test.mjs',
      line,
      ban: 'B5-date-time-bomb',
    });
  });

  // #1499 item 7: a SCREAMING_CASE binding of the real clock, handed over under the seam's own key.
  it.each([
    ['NOW', 'Date.now()'],
    ['NOW_MS', 'Date.now()'],
    ['NOW_ISO', 'new Date().toISOString()'],
  ])('flags a pinned date when the real clock it hands over is bound under a SCREAMING_CASE name (%s)', (name, read) => {
    const { json } = scan({
      'tests/upper-clock.test.mjs': [
        EMITTER_IMPORT,
        `const ${name} = ${read};`,
        '',
        ...SEAM_BLOCK,
        '',
        "it('derives the per-type expiry', () => {",
        `  const meta = toActivationMetadata(learning, { now: ${name} });`,
        "  expect(meta.expiresAt).toBe('2026-08-05');",
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(1);
    expect(json.findings[0]).toMatchObject({ file: 'tests/upper-clock.test.mjs', line: 11, ban: 'B5-date-time-bomb' });
  });

  // #1499 item 8: vitest 4 installs fake timers at the REAL `Date.now()` unless a date is pinned first.
  it.each([
    ['a bare `useFakeTimers()` in a module-level beforeEach', ['beforeEach(() => {', '  vi.useFakeTimers();', '});'], []],
    ['a bare `useFakeTimers()` in the block', [], ['  vi.useFakeTimers();']],
    ['`useFakeTimers` faking only setTimeout', [], ["  vi.useFakeTimers({ toFake: ['setTimeout'] });"]],
    ['`useFakeTimers` installed at `now: Date.now()`', [], ['  vi.useFakeTimers({ now: Date.now() });']],
    ['`setSystemTime` to the real clock', [], ['  vi.setSystemTime(new Date());']],
    // Review of ac3ded47: the pin value names a binding the scanner already knows reads the real clock.
    ['`setSystemTime` to a real-clock binding of the block', [], ['  const now = new Date();', '  vi.setSystemTime(now);']],
    [
      '`setSystemTime` to a real-clock binding of a beforeEach',
      ['let now;', 'beforeEach(() => {', '  now = Date.now();', '  vi.setSystemTime(now);', '});'],
      [],
    ],
    ['`useFakeTimers({ now })` shorthand of a real-clock binding', [], ['  const now = Date.now();', '  vi.useFakeTimers({ now });']],
  ])('flags a pinned date when the fake timer it relies on leaves the date real (%s)', (_shape, setup, installer) => {
    const { json } = scan({
      'tests/unpinned-timer.test.mjs': [
        EMITTER_IMPORT,
        ...setup,
        '',
        ...SEAM_BLOCK,
        '',
        "it('derives the per-type expiry', () => {",
        ...installer,
        '  const meta = toActivationMetadata(learning, {});',
        "  expect(meta.expiresAt).toBe('2026-08-05');",
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(1);
  });

  // #1499 item 9: a binding at COLLECTION time (module level, `describe` body) reads the clock before any
  // hook runs, so a freeze in a beforeEach — or in the block itself — does not reach the value handed over.
  it.each([
    [
      'bound in the `describe` body, frozen in its beforeEach',
      [
        "describe('under a frozen clock', () => {",
        '  const now = Date.now();',
        '  beforeEach(() => {',
        "    vi.setSystemTime(new Date('2026-07-05T00:00:00Z'));",
        '  });',
        ...SETUP_CLOCK_BLOCK.map((l) => `  ${l}`),
        '});',
      ],
    ],
    [
      'bound at module level, frozen in a module-level beforeEach',
      [
        'const now = Date.now();',
        'beforeEach(() => {',
        "  vi.setSystemTime(new Date('2026-07-05T00:00:00Z'));",
        '});',
        ...SETUP_CLOCK_BLOCK,
      ],
    ],
    [
      'bound in the `describe` body, frozen in the block itself',
      [
        "describe('under a frozen clock', () => {",
        '  const now = Date.now();',
        "  it('derives the per-type expiry', () => {",
        "    vi.setSystemTime(new Date('2026-07-05T00:00:00Z'));",
        '    const meta = toActivationMetadata(learning, { now });',
        "    expect(meta.expiresAt).toBe('2026-08-05');",
        '  });',
        '});',
      ],
    ],
  ])('flags a pinned date when the real clock it hands over was read before any freeze ran (%s)', (_shape, body) => {
    const { json } = scan({
      'tests/collection-clock.test.mjs': [EMITTER_IMPORT, ...SEAM_BLOCK, '', ...body, ''].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(1);
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

describe('check-test-value-bans — B5 counter-examples', () => {
  it('does not flag a block that hands the clock over as `{ now }` shorthand', () => {
    // Catches a CLOCK_ARG that only knows `now:` — it flags every `{ now }` block.
    const { json } = scan({
      'tests/shorthand.test.mjs': [
        EMITTER_IMPORT,
        '',
        ...SEAM_BLOCK,
        '',
        ...SHORTHAND_CLOCK_BLOCK,
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });

  it('does not prove a seam from a clock handed over only as a bare `now` value', () => {
    // Catches a seam proof that reads the wide controlled-block form (#1478): `manifestMtimeMs: now }`
    // (shape of enforce-scope.test.mjs) would make the helper `expectDeny` a clock-seamed subject.
    const { json } = scan({
      'tests/helper.test.mjs': [
        "import { expectDeny } from '../_helpers/hook-decision.mjs';",
        '',
        "it('denies an edit once the manifest went stale', () => {",
        '  const now = Date.now();',
        '  writeManifest(dir, { sessionStartedAtMs: now - HOUR_MS, manifestMtimeMs: now });',
        '  expectDeny(runHook(dir));',
        '});',
        '',
        "it('stamps the deny record with its day', () => {",
        '  expectDeny(runHook(dir));',
        "  expect(readLedger(dir)[0].day).toBe('2026-08-05');",
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });

  it('does not flag an asserted date that echoes an input literal of its own block', () => {
    // Expected value equals an input literal of the same block = echo. Consistent with the
    // scanner's CEILING decision that fixed INPUT dates are not flagged: nothing reads the clock.
    const { json } = scan({
      'tests/echo.test.mjs': [
        EMITTER_IMPORT,
        '',
        ...SEAM_BLOCK,
        '',
        ...ECHO_BLOCK,
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });

  it('still flags a bomb whose date only a sibling test repeats', () => {
    // Catches an echo check that reads the whole file: a sibling's toMatchObject carrying
    // the same date then hides the real bomb (measured 2026-09-30 on the fa57ee66^ bombs).
    const { json } = scan({
      'tests/sibling.test.mjs': [
        EMITTER_IMPORT,
        '',
        ...SEAM_BLOCK,
        '',
        ...SIBLING_SAME_DATE_BLOCK,
        '',
        "it('derives the per-type expiry', () => {",
        '  const meta = toActivationMetadata(learning, {});',
        "  expect(meta.expiresAt).toBe('2026-08-05');",
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(1);
  });

  // #1489 item 16, precision side: reading the shared setup must not turn a controlled block into a finding.
  it.each([
    [
      // Catches a setup read that ignores shadowing: the block hands over its OWN fixed `now`.
      'the block rebinds `now` to a fixed date',
      ['const now = Date.now();', '', ...SEAM_BLOCK, '', ...SHORTHAND_CLOCK_BLOCK],
    ],
    [
      // Catches a collection-time read (#1499 item 9) that ignores shadowing: the block reads its OWN
      // `now` after its own freeze, so the module-level real-clock `now` never reaches the handover.
      'the block rebinds `now` after freezing the clock itself',
      [
        'const now = Date.now();',
        '',
        ...SEAM_BLOCK,
        '',
        "it('derives the per-type expiry', () => {",
        "  vi.setSystemTime(new Date('2026-07-05T00:00:00Z'));",
        '  const now = Date.now();',
        '  const meta = toActivationMetadata(learning, { now });',
        "  expect(meta.expiresAt).toBe('2026-08-05');",
        '});',
      ],
    ],
    [
      // Catches a collection-time read that counts a helper's local (review of ac3ded47): `make()`
      // runs when the block calls it, after the block's own freeze — not when the file is collected.
      'a module-level helper binds `now` in its body and runs after the freeze',
      ['function make() {', '  const now = Date.now();', '  return { now };', '}', '', ...SEAM_BLOCK, '', ...FROZEN_HELPER_BLOCK],
    ],
    [
      'a `describe`-level helper binds `now` in its body and runs after the freeze',
      [
        ...SEAM_BLOCK,
        "describe('per type', () => {",
        '  function make() {',
        '    const now = Date.now();',
        '    return { now };',
        '  }',
        ...FROZEN_HELPER_BLOCK.map((l) => `  ${l}`),
        '});',
      ],
    ],
    [
      // Catches dropping the hook test once the indent rule exists: a one-line, expression-bodied hook
      // sits at the hook's own indentation, yet runs after the freeze registered before it.
      'a one-line hook binds `now` after a one-line freeze',
      [
        'let now;',
        "beforeEach(() => vi.setSystemTime(new Date('2026-07-05T00:00:00Z')));",
        'beforeEach(() => (now = Date.now()));',
        '',
        ...SEAM_BLOCK,
        '',
        ...SETUP_CLOCK_BLOCK,
      ],
    ],
    [
      // Catches a setup read that ignores a frozen clock: `Date.now()` after setSystemTime is fixed.
      'the setup freezes the clock before binding `now`',
      [
        'let now;',
        'beforeEach(() => {',
        "  vi.setSystemTime(new Date('2026-07-05T00:00:00Z'));",
        '  now = Date.now();',
        '});',
        '',
        ...SEAM_BLOCK,
        '',
        ...SETUP_CLOCK_BLOCK,
      ],
    ],
    [
      // Catches "any real-clock setup binding wins": the setup is file-wide, and
      // this block sits under the `describe` that binds a fixed date.
      'another `describe` binds the same `now` to the real clock',
      [
        'let now;',
        "describe('against the live clock', () => {",
        '  beforeEach(() => {',
        '    now = Date.now();',
        '  });',
        "  it('returns metadata', () => {",
        '    expect(toActivationMetadata(learning, { now })).toBeDefined();',
        '  });',
        '});',
        '',
        "describe('against a fixed clock', () => {",
        '  beforeEach(() => {',
        "    now = new Date('2026-07-05T00:00:00Z');",
        '  });',
        ...SEAM_BLOCK.map((l) => `  ${l}`),
        ...SETUP_CLOCK_BLOCK.map((l) => `  ${l}`),
        '});',
      ],
    ],
  ])('does not flag a block whose `now` is controlled although the setup binds it too (%s)', (_shape, body) => {
    const { json } = scan({ 'tests/setup-control.test.mjs': [EMITTER_IMPORT, ...body, ''].join('\n') });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });

  // Precision side of the describe scope: vitest runs a describe's beforeEach for every block it encloses.
  it.each([
    ['the block sits directly in that describe', ["  it('derives the per-type expiry', () => {"], ['  });']],
    [
      // Catches a scope check that demands the timer's describe be the block's INNERMOST one.
      'the block sits in a describe nested inside it',
      ["  describe('per type', () => {", "    it('derives the per-type expiry', () => {"],
      ['    });', '  });'],
    ],
  ])('does not flag a real-clock block an enclosing `describe` freezes the clock for (%s)', (_shape, open, close) => {
    const { json } = scan({
      'tests/enclosing-timer.test.mjs': [
        EMITTER_IMPORT,
        ...SEAM_BLOCK,
        '',
        "describe('under a frozen clock', () => {",
        '  beforeEach(() => {',
        "    vi.setSystemTime(new Date('2026-07-05T00:00:00Z'));",
        '  });',
        ...open,
        '    const now = Date.now();',
        '    const meta = toActivationMetadata(learning, { now });',
        "    expect(meta.expiresAt).toBe('2026-08-05');",
        ...close,
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });

  // #1499 item 7, precision side: the backlog-scan shape `summarizeIssues(issues, NOW)` and the
  // autopilot-effectiveness shape `buildLearning(…, NOW_ISO)` — a FIXED SCREAMING_CASE clock handed over.
  it.each([
    ['NOW', "Date.parse('2026-07-05T00:00:00Z')"],
    ['FIXED_NOW', "new Date('2026-07-05T00:00:00Z')"],
    ['NOW_ISO', "'2026-07-05T00:00:00.000Z'"],
  ])('does not flag a block that hands over a fixed SCREAMING_CASE clock positionally (%s)', (name, value) => {
    const { json } = scan({
      'tests/upper-control.test.mjs': [
        EMITTER_IMPORT,
        `const ${name} = ${value};`,
        '',
        ...SEAM_BLOCK,
        '',
        "it('derives the per-type expiry', () => {",
        `  const meta = toActivationMetadata(learning, ${name});`,
        "  expect(meta.expiresAt).toBe('2026-08-05');",
        '});',
        '',
      ].join('\n'),
    });

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });

  // #1499 item 8, precision side: a fake timer that names the date it installs at does freeze the clock —
  // and an argument the line scan cannot read (a config spread over lines) is read as a pin.
  it.each([
    ['`useFakeTimers({ now })` at a fixed date', ["  vi.useFakeTimers({ now: new Date('2026-07-05T00:00:00Z') });"]],
    ['a `useFakeTimers` config spread over lines', ['  vi.useFakeTimers({', "    now: new Date('2026-07-05T00:00:00Z'),", '  });']],
    [
      '`useFakeTimers({ now })` shorthand of a fixed date',
      ["  const now = new Date('2026-07-05T00:00:00Z');", '  vi.useFakeTimers({ now });'],
    ],
    ['a quoted `now` key the line scan does not read', ["  vi.useFakeTimers({ 'now': new Date('2026-07-05T00:00:00Z') });"]],
  ])('does not flag a block a setup fake timer pins the date for (%s)', (_shape, installer) => {
    const { json } = scan({
      'tests/pinned-timer.test.mjs': [
        EMITTER_IMPORT,
        'beforeEach(() => {',
        ...installer,
        '});',
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

    expect(json.counts['B5-date-time-bomb']).toBe(0);
  });
});

describe('check-test-value-bans — CLI contract', () => {
  it('--json emits the advisory/scanned/counts/findings shape consumers parse', () => {
    const { json } = scan({ 'tests/shape.test.mjs': 'expect(Object.keys(a)).toHaveLength(9);\n' });

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
    const { res } = scan({ 'tests/human.test.mjs': 'expect(Object.keys(a)).toHaveLength(9);\n' }, []);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('B1-exact-count');
    expect(res.stdout).toContain('tests/human.test.mjs:1');
  });

  // bug_caught: a `process.exit(0)` tail truncated stdout on a PIPE once the
  // payload passed the ~64 KiB pipe buffer — `--json | jq` got cut-off JSON
  // while `--json > file` was complete. The #911 B1 narrowing dropped the real
  // corpus far below that buffer, so this synthesises a >64 KiB payload from a
  // fixture with enough dynamic-count findings and reads it through a pipe.
  it('emits complete JSON through a pipe when the payload exceeds the buffer (no exit-truncation)', () => {
    const root = mkdtempSync(join(tmpdir(), 'so-tvb-pipe-'));
    tmpDirs.push(root);
    mkdirSync(join(root, 'tests'), { recursive: true });
    const rel = 'tests/big.test.mjs';
    const body =
      Array.from(
        { length: 400 },
        (_, i) => `expect(Object.keys(reg${i})).toHaveLength(${i + 2});`,
      ).join('\n') + '\n';
    writeFileSync(join(root, rel), body);
    const res = spawnSync(
      '/bin/sh',
      ['-c', `printf '%s' "${rel}" | "${process.execPath}" "${SCRIPT}" "${root}" --stdin --json | cat`],
      { encoding: 'utf8', timeout: 60_000 },
    );

    expect(res.status).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(65_536); // past the pipe buffer
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(JSON.parse(res.stdout).counts['B1-exact-count']).toBe(400);
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

// ---------------------------------------------------------------------------
// #1148 — B2 counts the population it reports, and --stdin judges staged lines
// ---------------------------------------------------------------------------

describe('check-test-value-bans — B2 counts the population it reports (#1148)', () => {
  it('emits one finding per .md read, at that read, counting only its own test (bug 15)', () => {
    const src = [
      "it('a', () => {", //                                  1
      "  const doc = readFileSync('docs/a.md', 'utf8');", //  2
      "  expect(doc).toContain('x1');", //                    3
      "  expect(doc).toContain('x2');", //                    4
      "  expect(doc).toContain('x3');", //                    5
      '});', //                                               6
      "it('b', () => {", //                                   7
      "  const doc = readFileSync('docs/b.md', 'utf8');", //  8
      '  expect(doc).toMatch(/y1/);', //                      9
      '  expect(doc).toMatch(/y2/);', //                     10
      '  expect(doc).toMatch(/y3/);', //                     11
      '  expect(doc).toMatch(/y4/);', //                     12
      '});',
      '',
    ].join('\n');

    const { json } = scan({ 'tests/two-reads.test.mjs': src });
    const b2 = json.findings.filter((f) => f.ban === 'B2-prose-pin-suspected');

    // v1 emitted ONE finding: line 2, count 7 (the whole file). Both numbers
    // described something no single assertion belongs to, and the read at
    // line 8 was invisible because findIndex stops at the first match.
    expect(b2.map((f) => f.line)).toEqual([2, 8]);
    expect(b2[0].match).toContain('3 toContain/toMatch asserts');
    expect(b2[1].match).toContain('4 toContain/toMatch asserts');
  });

  it('does not flag a file whose asserts only reach the threshold when summed (bug 15)', () => {
    // Four .md-reading tests, two prose asserts each: 8 file-wide, so v1
    // flagged it — at the first read's line, for assertions living in three
    // other tests. No single read reaches PROSE_ASSERT_THRESHOLD, so no read
    // is a suspected pin.
    const block = (i) =>
      [
        "it('t" + i + "', () => {",
        "  const doc = readFileSync('docs/" + i + ".md', 'utf8');",
        "  expect(doc).toContain('one');",
        "  expect(doc).toContain('two');",
        '});',
      ].join('\n');
    const src = [0, 1, 2, 3].map(block).join('\n') + '\n';

    const { json } = scan({ 'tests/spread.test.mjs': src });
    expect(json.counts['B2-prose-pin-suspected']).toBe(0);
  });

  it('counts file-wide for a module-scope read, where the file IS that read’s scope', () => {
    const src = [
      "const doc = readFileSync('docs/guide.md', 'utf8');", // 1 — module scope
      "it('a', () => {",
      "  expect(doc).toContain('x1');",
      "  expect(doc).toContain('x2');",
      '});',
      "it('b', () => {",
      "  expect(doc).toContain('x3');",
      '});',
      '',
    ].join('\n');

    const { json } = scan({ 'tests/module-read.test.mjs': src });
    const b2 = json.findings.filter((f) => f.ban === 'B2-prose-pin-suspected');

    expect(b2).toHaveLength(1);
    expect(b2[0].line).toBe(1);
    expect(b2[0].match).toContain('3 toContain/toMatch asserts in this file');
  });
});

/**
 * An ISOLATED tmpdir git repository. Nothing here can reach this working copy:
 * every git call is cwd-pinned to the tmpdir, and `tests/setup/scrub-git-env.mjs`
 * strips GIT_DIR / GIT_WORK_TREE from the suite environment for exactly this
 * reason. Same pattern as tests/lib/validate/check-untracked-test-deps.test.mjs.
 * @param {Record<string, string>} files committed as the base revision
 * @returns {{root: string, git: (...args: string[]) => string, write: (rel: string, body: string) => void}}
 */
function gitFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'so-tvb-git-'));
  tmpDirs.push(root);
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  git('add', '-A');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  return { root, git, write };
}

describe('check-test-value-bans — --stdin judges staged LINES, not staged files (#1148)', () => {
  const banLine = (i) => 'expect(Object.keys(reg' + i + ')).toHaveLength(' + (i + 2) + ');';
  const base = [banLine(0), '// filler', '// filler', '// filler', ''].join('\n');
  const REL = 'tests/staged.test.mjs';

  /** Base revision committed, then ONE new line staged far below line 1. */
  function stagedFixture() {
    const fx = gitFixture({ [REL]: base });
    fx.write(REL, base + banLine(9) + '\n');
    fx.git('add', '-A');
    return fx;
  }

  it('reports the finding inside the staged hunk and suppresses the pre-existing one (bug 16)', () => {
    const { root } = stagedFixture();

    const res = spawnSync(process.execPath, [SCRIPT, root, '--stdin', '--json'], {
      encoding: 'utf8',
      input: REL,
      timeout: 20_000,
    });
    const json = JSON.parse(res.stdout);

    expect(json.stagedScope).toEqual({ applied: true, suppressed: 1 });
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0].line).toBe(5); // the staged line — not line 1
  });

  it('keeps the repo-wide census when --stdin is absent (the CI path is untouched)', () => {
    const { root } = stagedFixture();

    const res = spawnSync(process.execPath, [SCRIPT, root, '--json'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    const json = JSON.parse(res.stdout);

    expect(json.stagedScope).toEqual({ applied: false, suppressed: 0 });
    expect(json.findings.map((f) => f.line)).toEqual([1, 5]);
  });

  it('leaves the gate inert outside a git working tree (fail open, never silent)', () => {
    // The tmpdir fixtures every other test in this file uses are NOT git
    // checkouts. A gate that returned an empty scope there instead of null
    // would silently zero the whole suite — and, on a non-git export, the
    // pre-commit hook with it.
    const { json } = scan({ 'tests/nogit.test.mjs': banLine(0) + '\n' });

    expect(json.stagedScope).toEqual({ applied: false, suppressed: 0 });
    expect(json.counts['B1-exact-count']).toBe(1);
  });
});
