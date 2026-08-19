/**
 * tests/scripts/validate-wave-scope.test.mjs
 *
 * Vitest suite for scripts/validate-wave-scope.mjs (issue #270).
 *
 * Covers: happy path, missing required fields, type errors, path traversal,
 * absolute path rejection, gates shape, invalid JSON, stdin vs. file input.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../scripts/validate-wave-scope.mjs');

function run(input, fileArg) {
  const args = fileArg ? [SCRIPT, fileArg] : [SCRIPT];
  return spawnSync('node', args, {
    input: fileArg ? undefined : input,
    encoding: 'utf8',
  });
}

const VALID = {
  wave: 2,
  role: 'impl-core',
  enforcement: 'warn',
  allowedPaths: ['src/**', 'tests/**'],
  blockedCommands: ['rm -rf', 'git reset --hard'],
};

describe('validate-wave-scope.mjs — happy path', () => {
  it('accepts a valid wave-scope.json from stdin and exits 0', () => {
    const r = run(JSON.stringify(VALID));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject(VALID);
  });

  it('accepts a valid wave-scope.json from a file path and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vws-'));
    const path = join(dir, 'wave-scope.json');
    writeFileSync(path, JSON.stringify(VALID));
    try {
      const r = run(null, path);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts the optional gates field when all values are booleans', () => {
    const r = run(JSON.stringify({ ...VALID, gates: { test: true, lint: false } }));
    expect(r.status).toBe(0);
  });

  it('passes through overly permissive patterns with a stderr WARNING but exits 0', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['**/*'] }));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*overly permissive/);
  });
});

describe('validate-wave-scope.mjs — invalid JSON', () => {
  it('exits 1 with ERROR on non-JSON input', () => {
    const r = run('not valid json at all');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR: Input is not valid JSON/);
  });
});

describe('validate-wave-scope.mjs — required-field contract', () => {
  it('rejects missing wave', () => {
    const { wave: _wave, ...noWave } = VALID;
    const r = run(JSON.stringify(noWave));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Missing required field: wave/);
  });

  it('rejects non-integer wave', () => {
    const r = run(JSON.stringify({ ...VALID, wave: 1.5 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/wave must be a positive integer/);
  });

  it('rejects zero or negative wave', () => {
    const r = run(JSON.stringify({ ...VALID, wave: 0 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/wave must be a positive integer/);
  });

  it('rejects non-string role', () => {
    const r = run(JSON.stringify({ ...VALID, role: 42 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/role must be a string/);
  });

  it('rejects enforcement outside strict|warn|off', () => {
    const r = run(JSON.stringify({ ...VALID, enforcement: 'loose' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/enforcement must be one of/);
  });
});

describe('validate-wave-scope.mjs — security checks', () => {
  // #870: an explicit absolute allowedPaths entry is a SANCTIONED Gate 5b
  // out-of-repo grant (hooks/enforce-scope.mjs matchesAbsoluteAllowlist, #792)
  // — the validator must agree with the hook, not contradict it. Flipped from
  // "rejects absolute paths" (the pre-#870 contract) to "accepts with a WARN".
  //
  // #870-followup (security review, confidence 0.85): the ORIGINAL #870 fixture
  // here was `/etc/passwd` — that is now a member of the catastrophic subclass
  // (see "catastrophic absolute grant rejection" below) and correctly rejects.
  // This test now uses a legitimately-scoped absolute glob (a scratchpad grant
  // outside any denylisted system/home directory) to keep exercising the WARN
  // path the #870 fix introduced.
  it('accepts an absolute path entry with a WARN (#870 — sanctioned Gate 5b out-of-repo grant)', () => {
    const r = run(
      JSON.stringify({ ...VALID, allowedPaths: ['/private/tmp/so-session-example/scratchpad/**'] }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*absolute \(out-of-repo\) path.*Gate 5b/);
  });

  // Exact repro from GitLab issue #870:
  //   echo '{"wave":1,"role":"Discovery","enforcement":"strict","allowedPaths":["/private/tmp/x/**"],"blockedCommands":[]}' \
  //     | node scripts/validate-wave-scope.mjs
  // Pre-#870 this exited 1 ("allowedPaths contains absolute path"), even though
  // the SAME entry is honoured live by hooks/enforce-scope.mjs Gate 5b.
  it('accepts the #870 issue repro — absolute glob out-of-repo grant exits 0', () => {
    const repro = {
      wave: 1,
      role: 'Discovery',
      enforcement: 'strict',
      allowedPaths: ['/private/tmp/x/**'],
      blockedCommands: [],
    };
    const r = run(JSON.stringify(repro));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*absolute \(out-of-repo\) path: \/private\/tmp\/x\/\*\*/);
  });

  it('rejects path traversal in allowedPaths', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['../escape'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/path traversal/);
  });

  // The traversal guard (entry.includes('../')) is INDEPENDENT of the absolute
  // check — an absolute entry that ALSO contains `../` must still be rejected.
  // This is also the "hostile absolute entry the hook would NOT honour" case:
  // hooks/enforce-scope.mjs matchesAbsoluteAllowlist (~253-261) matches the
  // pattern literally against the fully realpath-RESOLVED candidate (REQ-03),
  // and realpath strips `..` segments before that comparison ever runs — so a
  // `../`-bearing absolute pattern can never actually match Gate 5b's candidate
  // in the first place (REQ-09, ~32-38). A naive fix that early-`continue`s on
  // `path.isAbsolute(entry)` would silently drop this guard; this test pins
  // that the traversal check still fires for absolute entries too.
  it('rejects an absolute entry that ALSO contains path traversal (hostile — Gate 5b could never match it either)', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/private/tmp/x/../../etc/shadow'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/path traversal/);
  });

  // Bare relative `**` is NOT a Gate 5b grant (path.isAbsolute('**') === false,
  // so hooks/enforce-scope.mjs matchesAbsoluteAllowlist's `abs` filter drops it
  // — REQ-09, ~32-34) — it remains an ordinary in-repo relative glob, unaffected
  // by the #870 fix.
  it('accepts a bare relative "**" entry unaffected by #870 (not a Gate 5b grant, ordinary in-repo glob)', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['**'] }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('rejects non-array allowedPaths', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: 'src/**' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/allowedPaths must be an array/);
  });

  it('rejects missing blockedCommands', () => {
    const { blockedCommands: _bc, ...noBc } = VALID;
    const r = run(JSON.stringify(noBc));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Missing required field: blockedCommands/);
  });
});

describe('validate-wave-scope.mjs — catastrophic absolute grant rejection (#870-followup)', () => {
  // Security review (confidence 0.85): #870 made EVERY absolute allowedPaths
  // entry pass with a stderr WARN, including the literal filesystem root ("/")
  // and well-known system/home directories. allowedPaths is not hand-authored —
  // wave-loop.md's Scope Manifest computes it PROGRAMMATICALLY as the union of
  // LLM-authored "Files:" scopes — so a hallucinated/mis-copied/injected entry
  // reaching one of these shapes must hard-fail (exit 1), not rely on a stderr
  // line nothing guarantees a human reads before dispatch. These tests must
  // observe RED against the pre-fix (#870) code, then GREEN after.

  it('rejects the literal filesystem root "/"', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*filesystem root/);
  });

  it('rejects a denylisted system-directory glob: /etc/**', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/etc/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*system\/home directory/);
  });

  it('rejects a denylisted home-directory glob: /Users/**', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*system\/home directory/);
  });

  it('rejects a bare absolute file grant with no wildcard: /etc/passwd', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/etc/passwd'] }));
    expect(r.status).toBe(1);
    // /etc/passwd is caught by the system/home denylist (top segment "etc");
    // the no-wildcard rule below covers bare files OUTSIDE the denylist too.
    expect(r.stderr).toMatch(/ERROR:.*system\/home directory|ERROR:.*no wildcard/);
  });

  it('rejects a bare absolute file grant with no wildcard OUTSIDE the denylist', () => {
    const r = run(
      JSON.stringify({ ...VALID, allowedPaths: ['/private/tmp/so-session-example/notes.txt'] }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*no wildcard/);
  });

  it('rejects the Windows literal root forms "\\\\" and "C:\\\\"', () => {
    const r1 = run(JSON.stringify({ ...VALID, allowedPaths: ['\\'] }));
    expect(r1.status).toBe(1);
    expect(r1.stderr).toMatch(/ERROR:.*filesystem root/);

    const r2 = run(JSON.stringify({ ...VALID, allowedPaths: ['C:\\'] }));
    expect(r2.status).toBe(1);
    expect(r2.stderr).toMatch(/ERROR:.*filesystem root/);
  });

  // Non-regression: the #792/#870 legitimately-scoped absolute glob must keep
  // exiting 0 with a WARN — this is the case #870 exists for.
  it('does NOT regress the #792/#870 legitimately-scoped absolute glob', () => {
    const r = run(
      JSON.stringify({ ...VALID, allowedPaths: ['/private/tmp/so-session-abc/scratchpad/**'] }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(
      /WARNING.*absolute \(out-of-repo\) path: \/private\/tmp\/so-session-abc\/scratchpad\/\*\*/,
    );
  });

  // Relative paths are wholly unaffected by this subclass — no absolute check
  // ever fires for them.
  it('leaves relative paths unaffected', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['src/**', 'tests/**'] }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  // The traversal check remains INDEPENDENT (not else-if) of the new absolute
  // subclass checks — an absolute entry rejected for another reason must still
  // surface the traversal error when it also contains "../".
  it('still rejects absolute + traversal via the unconditional traversal check', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/private/tmp/x/../../etc/shadow'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/path traversal/);
  });
});

describe('validate-wave-scope.mjs — gates shape', () => {
  it('rejects non-boolean gate values', () => {
    const r = run(JSON.stringify({ ...VALID, gates: { test: true, lint: 'no' } }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/gates values must be booleans.*lint/);
  });

  it('rejects gates that is not an object', () => {
    const r = run(JSON.stringify({ ...VALID, gates: ['test'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/gates must be an object/);
  });
});

describe('validate-wave-scope.mjs — file input errors', () => {
  it('exits 1 with ERROR when file path does not exist', () => {
    const r = run(null, '/nonexistent/path/wave-scope.json');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR: File not found/);
  });
});

describe('validate-wave-scope.mjs — stdin pipe (shebang/runnable)', () => {
  // #901: previously gated on the live, gitignored .claude/wave-scope.json —
  // the suite total flipped by ±1 depending on WHEN it ran (mid-wave vs.
  // between waves vs. CI, where the file never exists). A fixture makes the
  // test deterministic and gives the stdin path CI coverage for the first
  // time. Precedent: tests/lib/state-md/frontmatter-safe-guard.test.mjs.
  const stdinFixture = JSON.stringify({
    wave: 2,
    role: 'Impl-Core',
    enforcement: 'strict',
    allowedPaths: ['src/lib/example.mjs', 'tests/lib/example.test.mjs'],
    blockedCommands: ['rm -rf', 'git push --force'],
  });

  it('piping a valid wave-scope JSON via stdin exits 0', () => {
    const r = spawnSync('node', [SCRIPT], {
      input: stdinFixture,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    // Output must be valid JSON matching the source
    const parsed = JSON.parse(r.stdout);
    expect(parsed.wave).toBe(2);
    expect(parsed.enforcement).toBe('strict');
  });
});

describe('validate-wave-scope.mjs — --assert-subset (#796)', () => {
  // Runs the validator with the #796 subset flag: wave-scope.json piped via
  // stdin, the agent fileScope passed as a --assert-subset <file> argument.
  function runSubset(waveScope, fileScope) {
    const dir = mkdtempSync(join(tmpdir(), 'vws-subset-'));
    const fsPath = join(dir, 'agent-filescope.json');
    writeFileSync(fsPath, JSON.stringify(fileScope));
    try {
      return spawnSync('node', [SCRIPT, '--assert-subset', fsPath], {
        input: JSON.stringify(waveScope),
        encoding: 'utf8',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 when the agent fileScope is a subset of allowedPaths', () => {
    // VALID.allowedPaths = ['src/**', 'tests/**'] — src/a.ts ⊆ src/**.
    const r = runSubset(VALID, ['src/a.ts', 'tests/a.test.ts']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('exits 1 with a missing: list when the fileScope is not a subset', () => {
    const r = runSubset(VALID, ['docs/x.md']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/agent fileScope not ⊆ allowedPaths/);
    expect(r.stderr).toMatch(/missing: \[docs\/x\.md\]/);
  });

  it('exits 2 when the --assert-subset file is unreadable (a directory)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vws-subset-dir-'));
    try {
      // Pass the DIRECTORY path itself — statSync(dir).isFile() is false for
      // every uid (root and non-root alike), so this is an I/O error (exit 2).
      const r = spawnSync('node', [SCRIPT, '--assert-subset', dir], {
        input: JSON.stringify(VALID),
        encoding: 'utf8',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/Cannot read --assert-subset file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when the --assert-subset file is not a JSON array of strings', () => {
    const r = runSubset(VALID, { not: 'an array' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must be a JSON array of strings/);
  });

  it('exits 1 with the exact die() message when --assert-subset is given no value', () => {
    // parseArgs: `--assert-subset` is the last argv token, so argv[i+1] is
    // undefined and die() fires before any stdin/file read happens.
    const r = spawnSync('node', [SCRIPT, '--assert-subset'], {
      input: JSON.stringify(VALID),
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('ERROR: --assert-subset requires a file-path argument\n');
  });

  it('exits 1 with the exact die() message when the --assert-subset file has malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vws-subset-malformed-'));
    const fsPath = join(dir, 'agent-filescope.json');
    // Not valid JSON (missing closing brace) — hits JSON.parse's catch branch
    // in assertSubsetOrDie, distinct from the "not an array" shape-check above.
    writeFileSync(fsPath, '{ not valid');
    try {
      const r = spawnSync('node', [SCRIPT, '--assert-subset', fsPath], {
        input: JSON.stringify(VALID),
        encoding: 'utf8',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(`ERROR: --assert-subset file is not valid JSON: ${fsPath}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// --expand-test-siblings (#970)
//
// BUG CAUGHT: an allowedPaths union that grants a production file WITHOUT its
// test sibling mechanically prevents the agent from updating that test — the
// scope guard enforcing exactly the inconsistency the quality gate exists to
// catch. --assert-subset is the ONE fail-closed enforcement point in the
// dispatch pipeline (it exits 1); warnings in this script are printed but do
// NOT affect the exit code, so a warn here would be decorative.
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — --expand-test-siblings (#970)', () => {
  function runSiblings(waveScope, fileScope, extraArgs = []) {
    const dir = mkdtempSync(join(tmpdir(), 'vws-siblings-'));
    const fsPath = join(dir, 'agent-filescope.json');
    writeFileSync(fsPath, JSON.stringify(fileScope));
    try {
      return spawnSync('node', [SCRIPT, '--assert-subset', fsPath, ...extraArgs], {
        input: JSON.stringify(waveScope),
        encoding: 'utf8',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The union grants the production file only — the #970 incident shape.
  const PROD_ONLY = { ...VALID, allowedPaths: ['scripts/lib/x.mjs'] };

  it('exits 1 when allowedPaths grants a production file but not its test sibling', () => {
    const r = runSiblings(PROD_ONLY, ['scripts/lib/x.mjs'], ['--expand-test-siblings']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not grant the test sibling/);
    expect(r.stderr).toMatch(/missing: \[tests\/\*\*\/x\*\.test\.mjs\]/);
  });

  it('exits 0 for the SAME manifest without the flag — proving the flag is what bites', () => {
    // Fake-regression control: identical wave-scope + fileScope, flag omitted.
    // Green here + red above is the only evidence that the new assertion, and
    // not some unrelated schema change, produced the exit 1.
    const r = runSiblings(PROD_ONLY, ['scripts/lib/x.mjs']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('exits 0 once the union grants the test sibling', () => {
    const granted = { ...VALID, allowedPaths: ['scripts/lib/x.mjs', 'tests/**'] };
    const r = runSiblings(granted, ['scripts/lib/x.mjs'], ['--expand-test-siblings']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  // The flag is gated on the MANIFEST's own role, so wave-loop.md can carry it
  // unconditionally on every pre-dispatch check. Without the gate, a Quality
  // phase-1 manifest — production files with tests deliberately excluded — would
  // hard-fail at dispatch for a requirement that phase must never satisfy.
  it.each([
    ['Quality', 'Quality'],
    ['Discovery', 'Discovery'],
    ['an unrecognised role', 'Impl-Something'],
  ])('exits 0 and WARNs instead of blocking for role: %s', (_n, role) => {
    const r = runSiblings({ ...PROD_ONLY, role }, ['scripts/lib/x.mjs'], ['--expand-test-siblings']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/--expand-test-siblings: skipped for role/);
    expect(r.stderr).not.toMatch(/does not grant the test sibling/);
  });

  it('fires for a role in TEST_SIBLING_EXPANSION_ROLES regardless of casing', () => {
    const r = runSiblings({ ...PROD_ONLY, role: 'IMPL-POLISH' }, ['scripts/lib/x.mjs'], [
      '--expand-test-siblings',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not grant the test sibling/);
  });

  it('does NOT weaken --assert-subset: the plain subset failure keeps its exact message', () => {
    // The #796 assertion runs FIRST and unchanged. An entry outside the union
    // must still fail with the original wording, not the #970 one.
    const r = runSiblings(VALID, ['docs/x.md'], ['--expand-test-siblings']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/agent fileScope not ⊆ allowedPaths/);
    expect(r.stderr).not.toMatch(/does not grant the test sibling/);
  });
});

// ---------------------------------------------------------------------------
// Empty allowedPaths under a writable role — WARN, never ERROR (#1057)
// ---------------------------------------------------------------------------
//
// Measured before the change: `{"wave":1,"role":"Impl-Core","enforcement":
// "strict","allowedPaths":[],"blockedCommands":[]}` exited 0 with NOTHING on
// stderr — the state in which every write of the wave will be denied passed
// validation silently.
//
// It must WARN, not error, and that is a measured constraint rather than a
// preference: `skills/wave-executor/wave-loop.md` § Scope Manifest feeds a
// skeleton with `"allowedPaths": []` through this very script in
// `--assert-disjoint` and `--union` mode, BEFORE the union exists. An error
// would break the documented procedure that produces the field it complains
// about.
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — empty allowedPaths (#1057)', () => {
  it('WARNS and exits 0 for a writable role, naming --union as the repair', () => {
    const r = run(JSON.stringify({ ...VALID, role: 'Impl-Core', allowedPaths: [] }));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING: allowedPaths is empty for role "Impl-Core"/);
    expect(r.stderr).toContain('--union step did not complete');
    // The load-bearing half: a WARNING, never an ERROR — an error here would
    // break the pre-union skeleton procedure.
    expect(r.stderr).not.toMatch(/ERROR/);
    expect(JSON.parse(r.stdout)).toMatchObject({ allowedPaths: [] });
  });

  it.each([['Discovery'], ['discovery'], [' DISCOVERY ']])(
    'stays SILENT for the read-only role %s — empty is that role\'s contract',
    (role) => {
      const r = run(JSON.stringify({ ...VALID, role, allowedPaths: [] }));
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    },
  );

  it('stays silent when allowedPaths is non-empty', () => {
    const r = run(JSON.stringify({ ...VALID, role: 'Impl-Core' }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
