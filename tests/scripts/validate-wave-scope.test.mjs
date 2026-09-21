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
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
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

/**
 * #1123: a manifest with NO `session` field now emits one advisory stderr line
 * (absence = legacy = not session-bound). `VALID` deliberately stays unbound —
 * it is the legacy shape every pre-#1123 manifest still has, and the suite must
 * keep exercising it — so the pre-existing "nothing reached stderr" assertions
 * strip exactly that one line rather than being weakened to `.not.toMatch(/ERROR/)`.
 * Anything else on stderr still fails them.
 *
 * @param {string} stderr
 * @returns {string}
 */
function stderrSansSessionWarn(stderr) {
  return stderr.replace(/^WARNING: no session field — [^\n]*\n/m, '');
}

describe('validate-wave-scope.mjs — happy path', () => {
  it('accepts a valid wave-scope.json from stdin and exits 0', () => {
    const r = run(JSON.stringify(VALID));
    expect(r.status).toBe(0);
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject(VALID);
  });

  it('accepts a valid wave-scope.json from a file path and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vws-'));
    const path = join(dir, 'wave-scope.json');
    writeFileSync(path, JSON.stringify(VALID));
    try {
      const r = run(null, path);
      expect(r.status).toBe(0);
      expect(stderrSansSessionWarn(r.stderr)).toBe('');
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
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
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

  // #1398/#1402: `Users`/`home` left the flat denylist and are judged by the
  // home-grant depth rule instead. `/Users/**` must STAY an error — it hands the
  // whole of every user's home to the wave — but the message now names the depth
  // rule rather than the denylist, so the assertion follows the rule that rejects it.
  it('rejects a home-directory glob at the root level: /Users/**', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*home directory at or above the user level/);
  });

  it('rejects a bare absolute file grant with no wildcard: /etc/passwd', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/etc/passwd'] }));
    expect(r.status).toBe(1);
    // /etc/passwd is caught by the system/home denylist (top segment "etc");
    // the no-wildcard rule below covers bare files OUTSIDE the denylist too.
    expect(r.stderr).toMatch(/ERROR:.*system\/home directory|ERROR:.*no wildcard/);
  });

  // #1402 (second point): a CONCRETE absolute file path is the NARROWER grant,
  // not the wider one — hooks/enforce-scope.mjs Gate 5b matches it exactly
  // (measured 2026-09-19: pathMatchesPattern('/Users/alice/Projects/vault/x.md',
  // '/Users/alice/Projects/vault/x.md') === true). Rejecting it while honouring
  // the `/**` glob above it inverted the risk ordering and is the bug this flip
  // catches: the validator forbade exactly the one shape that grants least.
  it('accepts a bare absolute file grant with no wildcard OUTSIDE the denylist with a WARN (#1402)', () => {
    const r = run(
      JSON.stringify({ ...VALID, allowedPaths: ['/private/tmp/so-session-example/notes.txt'] }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*no wildcard/);
  });

  // The root check was LITERAL while the thing that grants the root is a GLOB.
  // Measured 2026-09-20 @ 7e110a2a: `/` → error/filesystem-root and `/etc/**` →
  // error/denied-system-dir, but `/**` → warn/absolute — and `/**` matches every
  // path through pathMatchesPattern at Gate 5b, i.e. it is strictly WIDER than
  // both hard errors beside it. A single hallucinated entry in that spelling
  // handed the wave the whole host with a stderr line instead of an exit 1.
  it.each([
    ['POSIX root + recursive glob', '/**'],
    ['POSIX root + single-segment glob', '/*'],
    ['doubled separator', '//**'],
    ['Windows drive + glob, backslash', 'C:\\**'],
    ['Windows drive + glob, forward slash', 'C:/**'],
  ])('rejects a root-wide glob grant — %s: %s', (_label, entry) => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: [entry] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*filesystem root/);
  });

  // Counter-direction: the widened predicate must not swallow a DEEP glob. A
  // literal segment after the root narrows the grant, so these keep their own
  // (non-root) verdicts — `/**/x` is not the filesystem, and `/Users/<u>/<p>/**`
  // is the #792 happy path.
  it('does NOT read a deep glob as a root grant', () => {
    const deep = run(JSON.stringify({ ...VALID, allowedPaths: ['/private/tmp/so-x/**/notes'] }));
    expect(deep.status).toBe(0);
    expect(deep.stderr).not.toMatch(/filesystem root/);
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
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
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

describe('validate-wave-scope.mjs — home-directory grants (#1398 / #1402)', () => {
  // The defect these tests pin: `Users` and `home` sat on the flat
  // DENIED_ABSOLUTE_TOP_SEGMENTS denylist, so EVERY path under any home
  // directory was a hard ERROR — while hooks/enforce-scope.mjs Gate 5b
  // (matchesAbsoluteAllowlist) honours the very same entries without any
  // denylist or depth check. Validator and hook contradicted each other, and a
  // wave that legitimately writes outside the repo (a vault study folder) could
  // not validate its manifest — which happened live on 2026-09-19 and forced a
  // wave onto `enforcement: warn`.
  //
  // Hook truth re-measured 2026-09-19 against scripts/lib/scope-gate.mjs
  // `pathMatchesPattern` (the matcher Gate 5b calls):
  //   '/Users/alice/Projects/vault/**' ← '/Users/alice/Projects/vault/notes/x.md'  true
  //   '/Users/alice/**'                ← '/Users/alice/.ssh/authorized_keys'       true
  //   '/Users/alice/*/id'              ← '/Users/alice/.ssh/id'                    true
  // i.e. the hook grants everything the validator now has to grade itself.

  it('accepts a legitimate home-directory project grant with a WARN: /Users/alice/Projects/vault/**', () => {
    // Bug caught: the live #1398 blocker — a vault grant the hook honours
    // (measured true above) that the validator refused, leaving the coordinator
    // no way to validate a manifest it had to dispatch anyway.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice/Projects/vault/**'] }));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*home-directory grant honoured by Gate 5b/);
  });

  it('rejects a bare home directory: /Users/alice', () => {
    // Bug caught: a depth rule that counts the ENTRY rather than its literal
    // prefix would read three segments here ("/Users/alice" plus nothing) or
    // treat a wildcard-free entry as the narrow case and let the whole home
    // through as a WARN.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*home directory at or above the user level/);
  });

  it('rejects a whole-home glob: /Users/alice/**', () => {
    // Bug caught: this grant reaches ~/.ssh/authorized_keys — measured true
    // against the hook matcher above. A home check keyed only on the FIRST
    // segment ("is it /Users?") would have to reject the vault case too; one
    // keyed only on "does a dotfile appear in the pattern" passes this.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*home directory at or above the user level/);
  });

  it('rejects a wildcard in the user segment: /Users/*/Projects/**', () => {
    // Bug caught: counting SEGMENTS instead of LITERAL segments scores this 4
    // and lets it pass, although it spans every account on the host.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/*/Projects/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*home directory at or above the user level/);
  });

  it('rejects a wildcard in the first segment below the home: /Users/alice/*/x', () => {
    // Bug caught: a `*` in segment 3 reaches dot-directories — measured:
    // '/Users/alice/*/id' matches '/Users/alice/.ssh/id'. A dotfile check that
    // only inspects LITERAL text would see no leading dot here and allow it.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice/*/x'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*home directory at or above the user level/);
  });

  it('rejects a dotfile directory under the home: /Users/alice/.ssh/**', () => {
    // Bug caught: depth alone (3 literal segments) is satisfied here, so a
    // depth-only rule would WARN and hand the wave the host's SSH keys.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice/.ssh/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*sensitive home subdirectory/);
  });

  it('rejects the macOS Library directory under the home: /Users/alice/Library/**', () => {
    // Bug caught: Library/Keychains carries no leading dot, so a dotfile-only
    // rule misses the single biggest credential store on macOS.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice/Library/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*sensitive home subdirectory/);
  });

  it('rejects a Linux-home dotfile grant with no wildcard: /home/alice/.config/x', () => {
    // Bug caught (two at once): `home` must be graded like `Users`, and the
    // #1402 no-wildcard WARN must not become a bypass for a sensitive
    // subdirectory — ~/.config holds tokens and owner.yaml.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/home/alice/.config/x'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*sensitive home subdirectory/);
  });

  it('rejects a dotfile grant hidden behind a "." segment: /Users/./alice/.ssh/**', () => {
    // Bug caught: without path.posix.normalize() the literal prefix reads
    // [Users, ".", alice, ".ssh"], whose third element is "alice" — not a
    // dotfile — so the entry classifies as an ordinary project grant and WARNS.
    // Normalised it reads [Users, alice, ".ssh"] and rejects.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/./alice/.ssh/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*sensitive home subdirectory/);
  });

  // #1398/#1402 follow-up — the classification compared segments BYTE-EXACT
  // (`segment === 'Library'`, `HOME_TOP_SEGMENTS.has('Users')`) while the
  // filesystem underneath is case-insensitive and `fs.realpath()` does NOT
  // correct the spelling. Measured on this host 2026-09-19 (all five WARN,
  // exit 0, before the fold; `stat -f %i` reports the SAME inode for
  // `/Users/<u>/.ssh` and `/users/<u>/.ssh`, and for
  // `/Users/<u>/Library/Keychains` and `/users/<u>/library/Keychains`):
  //   /Users/<u>/library/**  → WARNING   (correct spelling → ERROR)
  //   /Users/<u>/LIBRARY/**  → WARNING
  //   /users/<u>/**          → WARNING   (not recognised as a home grant at all)
  //   /USERS/<u>/.ssh/**     → WARNING
  //   /HOME/<u>/.ssh/**      → WARNING
  // Gate 5b honours the mis-cased entry unchanged — measured the same day:
  // pathMatchesPattern('/Users/<u>/library/Keychains/login.keychain-db',
  // '/Users/<u>/library/**') === true — so a WARNING here was a live grant on
  // ~/Library/LaunchAgents, ~/Library/Keychains, ~/.ssh and ~/.claude.
  it.each([
    ['lowercased Library', '/Users/alice/library/**', /sensitive home subdirectory/],
    ['uppercased LIBRARY', '/Users/alice/LIBRARY/**', /sensitive home subdirectory/],
    ['lowercased home root', '/users/alice/**', /home directory at or above the user level/],
    ['uppercased home root + dotdir', '/USERS/alice/.ssh/**', /sensitive home subdirectory/],
    ['uppercased Linux home root', '/HOME/alice/.ssh/**', /sensitive home subdirectory/],
    // Same defect, third site in the same file: the flat system denylist was
    // compared byte-exact too, so `/ETC/**` (same directory as `/etc/**` here)
    // was a WARNING while `/etc/**` was an ERROR.
    ['mis-cased system root', '/ETC/**', /system\/home directory/],
  ])('rejects a case-variant grant (%s): %s', (_label, entry, message) => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: [entry] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`ERROR:.*${message.source}`));
  });

  // Counter-direction: the fold must not turn a legitimate grant into a
  // rejection. Both spellings of the #1398 reference case stay a WARN with
  // exit 0 — three literal segments, first below the home is a project dir.
  it.each(['/Users/alice/Projects/vault/**', '/users/alice/Projects/vault/**'])(
    'keeps a legitimate project grant at WARN under the fold: %s',
    (entry) => {
      const r = run(JSON.stringify({ ...VALID, allowedPaths: [entry] }));
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/WARNING.*home-directory grant honoured by Gate 5b/);
    },
  );

  it('accepts a concrete home FILE grant with a WARN: /Users/alice/Projects/vault/x.md', () => {
    // Bug caught: the #1402 flip must survive the home path too — a concrete
    // file is the narrowest grant there is (Gate 5b matches it exactly,
    // measured true above), so neither the home rule nor the no-wildcard rule
    // may reject it.
    const r = run(
      JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice/Projects/vault/x.md'] }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*home-directory grant honoured by Gate 5b/);
  });

  it('keeps the non-home denylist intact: /root/** and /var/** still ERROR', () => {
    // Bug caught: removing `Users`/`home` from DENIED_ABSOLUTE_TOP_SEGMENTS must
    // not remove the other 14 segments with them.
    const r1 = run(JSON.stringify({ ...VALID, allowedPaths: ['/root/**'] }));
    expect(r1.status).toBe(1);
    expect(r1.stderr).toMatch(/ERROR:.*system\/home directory/);

    const r2 = run(JSON.stringify({ ...VALID, allowedPaths: ['/var/**'] }));
    expect(r2.status).toBe(1);
    expect(r2.stderr).toMatch(/ERROR:.*system\/home directory/);
  });
});

describe('validate-wave-scope.mjs — grading reaches the CLI (#1405 / #1406)', () => {
  // The grading predicate itself is unit-tested with an injected resolver in
  // tests/lib/scope-gate.test.mjs. What is proved HERE is the wiring: that this
  // CLI calls it, and that the exit code follows the verdict.

  it('rejects a tilde grant — nothing in the scope chain expands it (#1405.3)', () => {
    // Bug caught: this entry exited 0 with NO finding at all — not even a WARN.
    // It matches nothing (Gate 5b filters on path.isAbsolute, and '~/…' is not),
    // so the coordinator read silence as a granted vault path.
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['~/Projects/vault/**'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR:.*tilde/);
  });

  it('accepts a ~/.cache PROJECT grant with a WARN while the bare cache stays refused (#1406)', () => {
    // Bug caught: `segment.startsWith('.')` refused /Users/<u>/.cache/<project>/**
    // although a study contract keeps its data exactly there and Gate 5b honours
    // it — while a carve-out written as a NAME rather than a DEPTH would have
    // opened the whole of ~/.cache with it.
    const ok = run(
      JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice/.cache/jev-eval/so/**'] }),
    );
    expect(ok.status).toBe(0);
    expect(ok.stderr).toMatch(/WARNING.*home-directory grant honoured by Gate 5b/);

    const bare = run(JSON.stringify({ ...VALID, allowedPaths: ['/Users/alice/.cache/**'] }));
    expect(bare.status).toBe(1);
    expect(bare.stderr).toMatch(/ERROR:.*sensitive home subdirectory/);
  });

  // The canonicalisation wiring can only be observed where a symlinked system
  // root EXISTS. `/etc → /private/etc` is macOS; on Linux the two spellings are
  // different directories and the verdicts below would be wrong, not missing.
  // Probed at runtime rather than keyed on `process.platform` — the question is
  // whether this host has the symlink, not what it is called.
  const etcIsSymlinked = (() => {
    try { return realpathSync('/etc') !== '/etc'; } catch { return false; }
  })();

  it.skipIf(!etcIsSymlinked)(
    'resolves the grant prefix the same direction the hook resolves candidates (#1405.1/.2)',
    () => {
      // Bug caught (both directions of ONE gap): the validator graded the LITERAL
      // spelling while Gate 5b matches the REALPATH-resolved candidate. So
      // /private/etc/** passed with a WARN although it grants what the refused
      // /etc/** grants, and /tmp/x/** passed as "honoured by Gate 5b" although
      // the hook can never match it.
      const alias = run(JSON.stringify({ ...VALID, allowedPaths: ['/private/etc/**'] }));
      expect(alias.status).toBe(1);
      expect(alias.stderr).toMatch(/ERROR:.*system\/home directory/);

      const dead = run(JSON.stringify({ ...VALID, allowedPaths: ['/tmp/x/**'] }));
      expect(dead.status).toBe(1);
      expect(dead.stderr).toMatch(/ERROR:.*non-canonical/);
      // Actionable or worthless: the finding must name the spelling to write.
      expect(dead.stderr).toContain('/private/tmp/x/**');
    },
  );
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
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
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
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
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
      expect(stderrSansSessionWarn(r.stderr)).toBe(
        `ERROR: --assert-subset file is not valid JSON: ${fsPath}\n`,
      );
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
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
  });

  it('exits 0 once the union grants the test sibling', () => {
    const granted = { ...VALID, allowedPaths: ['scripts/lib/x.mjs', 'tests/**'] };
    const r = runSiblings(granted, ['scripts/lib/x.mjs'], ['--expand-test-siblings']);
    expect(r.status).toBe(0);
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
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
      expect(stderrSansSessionWarn(r.stderr)).toBe('');
    },
  );

  it('stays silent when allowedPaths is non-empty', () => {
    const r = run(JSON.stringify({ ...VALID, role: 'Impl-Core' }));
    expect(r.status).toBe(0);
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
  });
});

describe('#1083 — empty flag values are refused, not treated as absent', () => {
  const MANIFEST = JSON.stringify({
    wave: 7,
    role: 'Quality',
    enforcement: 'warn',
    allowedPaths: [],
    blockedCommands: [],
  });

  // A failed $(...) capture of materialize-wave-scope.mjs yields ''. Because both
  // modes were gated on a truthy path, '' skipped the check and still exited 0 --
  // green, with the collision gate never run.
  it.each([['--assert-disjoint'], ['--union']])('rejects %s with an empty value', (flag) => {
    const res = spawnSync('node', [SCRIPT, flag, ''], { input: MANIFEST, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${flag} requires a file-path argument`);
  });
});

// ---------------------------------------------------------------------------
// Session binding (#1123)
//
// A wave-scope manifest is a SHARED working-copy artefact: `hooks/enforce-scope.mjs`
// applies it to every session running in this checkout, so a Discovery wave's
// `allowedPaths: []` written by session A denied every write of unrelated
// session B. The manifest now names the session that wrote it, and the writer
// derives both fields from ONE `sessionAttribution(repoRoot)` call.
//
// The field is OPTIONAL by measurement, not by taste: every manifest written
// before #1123 lacks it, and § Scope Manifest 3.3 feeds a pre-union skeleton
// through this validator. Absence therefore WARNs; the flip to an error is a
// later release.
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — session binding (#1123)', () => {
  const SESSION = '10de3bb9-95bc-4793-ab51-a609287d11df';
  const SEMANTIC = 'main-2026-08-24-session-1';

  // BUG CAUGHT: a validator that rejects (or silently drops) the new binding
  // makes every session-bound manifest fail at the Scope Manifest step, and the
  // coordinator's only recovery is to stop writing the field — reverting #1123
  // while every gate still reports green.
  it('accepts a manifest carrying both session and semantic_session, silently', () => {
    const r = run(JSON.stringify({ ...VALID, session: SESSION, semantic_session: SEMANTIC }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({ session: SESSION, semantic_session: SEMANTIC });
  });

  // BUG CAUGHT: a non-string id (a JSON number from a hand-edited manifest, or
  // an object from a mis-spread `sessionAttribution()` result) can never equal
  // the reader's own string session id, so EVERY session reads the manifest as
  // foreign and skips enforcement — a deny-all scope silently becomes allow-all.
  it.each([
    ['a number', 12345, 'number'],
    ['null', null, 'null'],
    ['an object', { session_id: SESSION }, 'object'],
    ['an array', [SESSION], 'object'],
  ])('rejects a session that is %s', (_label, value, type) => {
    const r = run(JSON.stringify({ ...VALID, session: value }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      new RegExp(`ERROR: session must be a non-empty string, got type: ${type}`),
    );
  });

  // BUG CAUGHT — the one the pre-#1123 code let through: `"session": ""` is what
  // a failed lock read yields when the writer fills the key unconditionally
  // instead of omitting it. It is present (so no legacy warning fires) yet equal
  // to no session id (so every reader treats the manifest as FOREIGN and
  // enforces nothing). Measured before the fix: exit 0, empty stderr.
  it('rejects an EMPTY-STRING session — bound to nothing reads as foreign to everyone', () => {
    const r = run(JSON.stringify({ ...VALID, session: '' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR: session must be a non-empty string, got: ""/);
    expect(r.stderr).toMatch(/omit the key entirely/);
  });

  it('rejects an empty-string semantic_session for the same reason', () => {
    const r = run(JSON.stringify({ ...VALID, session: SESSION, semantic_session: '' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR: semantic_session must be a non-empty string/);
  });

  // BUG CAUGHT: making the field REQUIRED would exit 1 on every legacy manifest
  // and on the `allowedPaths: []` pre-union skeleton § Scope Manifest 3.3 pipes
  // through this very script — breaking the documented procedure that produces
  // the field it complains about. Warning-and-0 is the load-bearing half.
  it('WARNS and exits 0 when session is absent — legacy manifests still validate', () => {
    const r = run(JSON.stringify(VALID));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING: no session field — manifest is not session-bound \(legacy, #1123\)/);
    expect(r.stderr).not.toMatch(/ERROR/);
    expect(JSON.parse(r.stdout)).toMatchObject(VALID);
  });

  // BUG CAUGHT: keying the presence check off `semantic_session` (the readable
  // one) instead of `session`. `hooks/enforce-scope.mjs` compares the RAW id, so
  // a manifest carrying only the semantic twin is still unbound — a check on the
  // wrong field would silence the warning for exactly the manifest that needs it.
  it('still WARNS when only semantic_session is present — the raw id is what binds', () => {
    const r = run(JSON.stringify({ ...VALID, semantic_session: SEMANTIC }));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING: no session field/);
    expect(stderrSansSessionWarn(r.stderr)).toBe('');
  });

  // Fake-regression control for the warning: the SAME manifest with the field
  // present is silent. Green here + warned above is the only evidence that the
  // absence of `session`, and not some unrelated field, produced the line.
  it('emits NO session warning once the field is present', () => {
    const r = run(JSON.stringify({ ...VALID, session: SESSION }));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/no session field/);
  });
});


describe('session-binding key rename (#1153 P2)', () => {
  const SESSION = '10de3bb9-95bc-4793-ab51-a609287d11df';
  const SEMANTIC = 'main-2026-08-24-session-1';

  it('accepts the CURRENT key names silently', () => {
    const r = run(JSON.stringify({ ...VALID, session_id: SESSION, semantic_session_id: SEMANTIC }));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/not session-bound/);
  });

  it('still accepts the LEGACY key names for one transition release', () => {
    const r = run(JSON.stringify({ ...VALID, session: SESSION, semantic_session: SEMANTIC }));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/not session-bound/);
  });

  it('accepts both spellings of a slot when they carry the SAME value', () => {
    const r = run(JSON.stringify({ ...VALID, session_id: SESSION, session: SESSION }));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/DIFFERENT values/);
  });

  it('ERRORS when both spellings of a slot carry DIFFERENT values', () => {
    // The reader silently prefers `session_id` and drops the other id, so this
    // manifest would name two sessions and classify as `own` for one of them.
    const r = run(JSON.stringify({ ...VALID, session_id: SESSION, session: 'SOMEONE-ELSE' }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/session_id and legacy session are both present with DIFFERENT values/);
  });
});
