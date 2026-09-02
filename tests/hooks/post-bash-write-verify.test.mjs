/**
 * tests/hooks/post-bash-write-verify.test.mjs
 *
 * Tests for hooks/post-bash-write-verify.mjs (#915).
 *
 * Each test names the bug it catches (TV-001) — none of these are "the function
 * returns what it returns" restatements:
 *
 *  - parsePorcelainZ      → a line-based parser corrupts paths containing a
 *                           newline/space; `-z` records are NUL-separated.
 *  - isIgnoredPath        → an ignore list that is too broad BLINDS the guard
 *                           (a real source file stops being reported); too
 *                           narrow and it emits per-Bash-call noise, which gets
 *                           the guard switched off — the #915 bypass pressure.
 *  - computeReport        → the noise catastrophe: without delta + report-once
 *                           + silent re-baseline, one edit makes every later
 *                           Bash call of the session fire.
 *  - formatMessage        → the #906 fail-open class: an unclamped payload past
 *                           the 64 KiB pipe buffer is silently truncated.
 *  - snapshotPathFor      → an in-repo snapshot would appear in `git status`
 *                           and make the guard report its own bookkeeping.
 *  - E2E (fake-regression)→ the guard must WARN for an out-of-scope Bash write
 *                           and stay SILENT for an in-scope one, against a real
 *                           git repo and the real hook process.
 *  - #938 (3 vectors)     → the observed actor could silence the guard: V1
 *                           rewrite the (ignored + gitignored) control file,
 *                           V2 delete the $TMPDIR state sidecar, V3 exploit
 *                           the blind first call after every scope change.
 *  - #944                 → G4/G5 fell back to the LIVE scope file whenever no
 *                           snapshot existed, and `rm -f <sidecar>` re-creates
 *                           that state on demand (the path is sha1(repoRoot)) —
 *                           so ONE Bash call could install its own kill-switch
 *                           and be judged under it.
 *  - #945                 → "snapshot lost" was only distinguishable from
 *                           "first call" via the wave-scope.json mtime, the one
 *                           clock a `touch` resets. Session age is not.
 *
 * The fail-safe direction of the #945 signal (unknown session age ⇒ SILENCE,
 * never a false alarm) needs no test of its own: every E2E case below runs in a
 * tmp repo WITHOUT `.orchestrator/current-session.json` and asserts silence, so
 * a fail-loud regression turns this whole file red.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, realpathSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  parsePorcelainZ,
  isIgnoredPath,
  isInScope,
  scopeSignature,
  snapshotPathFor,
  computeReport,
  formatMessage,
  formatSnapshotMissingNotice,
  sessionAgeMs,
  MAX_CONTEXT_CHARS,
  MAX_REPORTED_PATHS,
} from '../../hooks/post-bash-write-verify.mjs';

const HOOK = new URL('../../hooks/post-bash-write-verify.mjs', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// parsePorcelainZ
// ---------------------------------------------------------------------------

describe('parsePorcelainZ', () => {
  it('splits on NUL and strips the 3-char status prefix', () => {
    expect(parsePorcelainZ('?? out.mjs\0 M src/a.mjs\0')).toEqual(['out.mjs', 'src/a.mjs']);
  });

  it('preserves a path containing a newline (the reason -z is not optional)', () => {
    // A line-splitting parser would yield 'weird' and 'name.txt' as two paths.
    expect(parsePorcelainZ('?? weird\nname.txt\0')).toEqual(['weird\nname.txt']);
  });

  it('returns [] for empty/non-string input rather than throwing', () => {
    expect(parsePorcelainZ('')).toEqual([]);
    expect(parsePorcelainZ(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isIgnoredPath — the noise contract
// ---------------------------------------------------------------------------

describe('isIgnoredPath', () => {
  it.each([
    ['.orchestrator/metrics/events.jsonl', 'sibling-hook event write'],
    ['.orchestrator/current-session.json', 'corrective-context sidecar'],
    ['.orchestrator/current-session.json.tmp-ptf-123-456', 'tmp+rename residue'],
    ['.claude/STATE.md', 'coordinator status file'],
    ['node_modules/foo/index.js', 'package-manager artefact'],
    ['package-lock.json', 'lockfile rewrite by npm'],
    ['coverage/index.html', 'coverage artefact'],
    ['dist/bundle.js', 'build artefact'],
    ['some/nested/.tmp.abc123', 'writeJsonAtomicSync tmp file'],
    ['.DS_Store', 'OS noise'],
  ])('ignores %s (%s)', (p) => {
    expect(isIgnoredPath(p)).toBe(true);
  });

  it.each([
    'scripts/lib/io.mjs',
    'hooks/enforce-scope.mjs',
    'docs/session-config-reference.md',
    '.orchestrator/policy/blocked-commands.json',
    '.orchestrator/steering/product.md',
    'out-of-scope.mjs',
    // #938 vector 1: the guard's OWN control file was on this ignore list —
    // an actor rewriting `enforcement`/`gates` changed the gate unreported.
    '.claude/wave-scope.json',
    '.pi/wave-scope.json',
  ])('does NOT ignore %s — over-broad patterns would blind the guard', (p) => {
    expect(isIgnoredPath(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isInScope — must agree with the enforce-scope Gate-7 matcher
// ---------------------------------------------------------------------------

describe('isInScope', () => {
  it('matches a glob pattern the Edit/Write gate would also accept', () => {
    expect(isInScope('hooks/post-bash-write-verify.mjs', ['hooks/**'])).toBe(true);
  });

  // TV-003 consolidation: the empty-allowedPaths case and the sibling-glob case
  // were two `it` blocks asserting the same predicate direction.
  it('rejects an empty allowedPaths and a sibling outside the declared globs', () => {
    expect(isInScope('any.mjs', [])).toBe(false);
    expect(isInScope('scripts/lib/io.mjs', ['hooks/**', 'docs/*.md'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// snapshotPathFor
// ---------------------------------------------------------------------------

describe('snapshotPathFor', () => {
  // TV-003 consolidation: two `it` blocks over one pure function, both about
  // where the sidecar may live.
  it('places the snapshot OUTSIDE the repo (self-report immunity) and keys it per repo', () => {
    // Deliberately not a `/Users/<name>/…` shape: the owner-leakage scanner's
    // CP1 rule flags canonicalized personal home paths in tracked files.
    const repo = '/srv/demo-repo';
    const snap = snapshotPathFor(repo);
    expect(snap.startsWith(tmpdir())).toBe(true);
    expect(snap.startsWith(repo)).toBe(false);
    // Two working copies must not share a baseline.
    expect(snapshotPathFor('/a/repo')).not.toBe(snapshotPathFor('/b/repo'));
  });
});

// ---------------------------------------------------------------------------
// computeReport — the anti-noise core
// ---------------------------------------------------------------------------

describe('computeReport', () => {
  const allowed = ['hooks/**'];
  const sig = scopeSignature(allowed);

  it('first-run re-baseline reports dirt NEWER than the scope file, not pre-wave dirt (#938 vectors 2+3)', () => {
    // Bug caught (was pinned as intended silence pre-#938): deleting the
    // $TMPDIR sidecar (vector 2) forced a FULLY silent re-baseline that
    // swallowed the observed call's own out-of-scope write. Dirt older than
    // the wave-scope.json write predates the wave and must still stay silent.
    const r = computeReport({
      dirtyPaths: ['scripts/lib/io.mjs', 'out-of-scope.mjs'],
      allowedPaths: allowed,
      snapshot: null,
      signature: sig,
      scopeMtimeMs: 1_000,
      mtimeMs: (p) => (p === 'out-of-scope.mjs' ? 1_500 : 200),
    });
    expect(r.report).toEqual(['out-of-scope.mjs']);
    expect(r.rebaselined).toBe(true);
    expect(r.nextSnapshot.paths).toEqual(['scripts/lib/io.mjs', 'out-of-scope.mjs']);
  });

  it('re-baseline reports an out-of-scope write whose mtime EQUALS the scope file (#938 MED-3, W4 panel)', () => {
    // Bug caught: a strict `>` dropped a write landing on the SAME coarse-FS
    // tick as the wave-scope.json write — a same-instant out-of-scope write from
    // THIS wave read as pre-wave dirt and stayed silent. `>=` attributes it.
    const r = computeReport({
      dirtyPaths: ['out-of-scope.mjs'],
      allowedPaths: allowed,
      snapshot: null,
      signature: sig,
      scopeMtimeMs: 1_000,
      mtimeMs: () => 1_000, // exactly equal to the scope file
    });
    expect(r.report).toEqual(['out-of-scope.mjs']);
    expect(r.rebaselined).toBe(true);
  });

  it('first-run re-baseline degrades to silence without an mtime signal (no false blame)', () => {
    // Bug caught: a scope-file stat failure must fall back to the conservative
    // silent re-baseline — NOT report pre-wave dirt it cannot attribute.
    const r = computeReport({
      dirtyPaths: ['scripts/lib/io.mjs', 'out-of-scope.mjs'],
      allowedPaths: allowed,
      snapshot: null,
      signature: sig,
    });
    expect(r.report).toEqual([]);
    expect(r.rebaselined).toBe(true);
  });

  it('reports only the NEWLY appeared out-of-scope path, not the whole dirty tree', () => {
    const r = computeReport({
      dirtyPaths: ['scripts/lib/io.mjs', 'out-of-scope.mjs'],
      allowedPaths: allowed,
      snapshot: { signature: sig, paths: ['scripts/lib/io.mjs'] },
      signature: sig,
    });
    expect(r.report).toEqual(['out-of-scope.mjs']);
  });

  it('report-once: the same path stays silent on the next call (noise catastrophe guard)', () => {
    const first = computeReport({
      dirtyPaths: ['out-of-scope.mjs'],
      allowedPaths: allowed,
      snapshot: { signature: sig, paths: [] },
      signature: sig,
    });
    expect(first.report).toEqual(['out-of-scope.mjs']);

    const second = computeReport({
      dirtyPaths: ['out-of-scope.mjs'],
      allowedPaths: allowed,
      snapshot: first.nextSnapshot,
      signature: sig,
    });
    expect(second.report).toEqual([]);
  });

  it('stays silent for an in-scope write', () => {
    const r = computeReport({
      dirtyPaths: ['hooks/new-thing.mjs'],
      allowedPaths: allowed,
      snapshot: { signature: sig, paths: [] },
      signature: sig,
    });
    expect(r.report).toEqual([]);
  });

  it('stays silent for an ignored path even when it is outside allowedPaths', () => {
    const r = computeReport({
      dirtyPaths: ['.orchestrator/metrics/events.jsonl', 'package-lock.json'],
      allowedPaths: allowed,
      snapshot: { signature: sig, paths: [] },
      signature: sig,
    });
    expect(r.report).toEqual([]);
    expect(r.nextSnapshot.paths).toEqual([]);
  });

  it('a new wave re-baselines but still reports dirt written AFTER the new scope file (#938 vector 3)', () => {
    // Bug caught (was pinned as intended silence pre-#938): the first Bash
    // call after every wave rollover was blind — an out-of-scope write timed
    // into that call was folded silently into the snapshot. Pre-wave dirt
    // (mtime older than the new wave-scope.json) must still NOT be blamed.
    const prev = { signature: scopeSignature(['docs/**']), paths: [] };
    const r = computeReport({
      dirtyPaths: ['out-of-scope.mjs', 'pre-wave-dirt.mjs'],
      allowedPaths: allowed,
      snapshot: prev,
      signature: sig,
      scopeMtimeMs: 1_000,
      mtimeMs: (p) => (p === 'out-of-scope.mjs' ? 1_500 : 200),
    });
    expect(r.report).toEqual(['out-of-scope.mjs']);
    expect(r.rebaselined).toBe(true);
  });

  it('scopeSignature is order-insensitive so a reordered plan does not force a re-baseline', () => {
    expect(scopeSignature(['a/**', 'b/**'])).toBe(scopeSignature(['b/**', 'a/**']));
  });
});

// ---------------------------------------------------------------------------
// formatMessage — the #906 pipe-buffer fail-open class
// ---------------------------------------------------------------------------

describe('formatMessage', () => {
  it('clamps a pathological report far below the 64 KiB pipe buffer', () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `dir${i}/file-with-a-long-name-${i}.mjs`);
    const msg = formatMessage(huge, 3);
    expect(msg.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(Buffer.byteLength(msg, 'utf8')).toBeLessThan(65_536);
  });

  // TV-003 consolidation: the standalone "states the warn-only contract" block
  // asserted one substring of the same rendered message and is folded in here.
  it('names at most MAX_REPORTED_PATHS paths, discloses the remainder, and states the warn-only contract', () => {
    const many = Array.from({ length: MAX_REPORTED_PATHS + 7 }, (_, i) => `f${i}.mjs`);
    const msg = formatMessage(many, 1);
    expect(msg).toContain(`+7 more`);
    expect(msg).toContain('f0.mjs');
    // Truncation must not eat the contract line — a reader who expects a BLOCK
    // from a PostToolUse hook draws the wrong conclusion from silence later.
    expect(msg).toContain('Warn-only');
  });
});

// ---------------------------------------------------------------------------
// formatSnapshotMissingNotice — the #945 discriminator
// ---------------------------------------------------------------------------

describe('formatSnapshotMissingNotice', () => {
  it('is silent for a young session and fires on session age alone when the scope mtime was reset (#945)', () => {
    // Bug caught: the ONLY discriminator between "sidecar deleted mid-session"
    // and "legitimate first Bash call" was the wave-scope.json mtime — exactly
    // the value `touch .claude/wave-scope.json` resets (content unchanged, so
    // no control notice either). A fresh scope age must therefore NOT be able
    // to buy silence on its own.
    // Legitimate first call: session seconds old, scope file seconds old.
    expect(formatSnapshotMissingNotice({ sessionAge: 30_000, scopeAge: 30_000 })).toBeNull();
    // The attack: scope file freshly touched, session 3 h old.
    const notice = formatSnapshotMissingNotice({ sessionAge: 3 * 3_600_000, scopeAge: 30_000 });
    expect(notice).toContain('no state snapshot');
    expect(notice).toContain('the session started 180 min ago');
    // Fail-safe direction: neither clock readable ⇒ silence, never an alarm.
    expect(formatSnapshotMissingNotice({ sessionAge: null, scopeAge: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sessionAgeMs — the two-clock minimum (#957 finding 2)
// ---------------------------------------------------------------------------

describe('sessionAgeMs', () => {
  const NOW = Date.parse('2026-07-31T18:00:00.000Z');
  const MINUTES = 60_000;
  const HOURS = 3_600_000;
  let repo;

  /** Write one of the two clock files; pass null to leave it absent. */
  const writeClock = (name, body) => {
    const file = join(repo, '.orchestrator', name);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  };
  const isoAgo = (ms) => new Date(NOW - ms).toISOString();

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'so-session-age-')));
    mkdirSync(join(repo, '.orchestrator'), { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('takes the MINIMUM of both clocks, so a leftover current-session.json cannot fake an hours-old session (#957)', () => {
    // Bug caught: the single-clock read returned `now - timestamp` for ANY
    // finite parse, however old. On a harness where
    // `.orchestrator/current-session.json` survives from a PREVIOUS session,
    // a session seconds old reported an age of hours and fired the
    // lost-snapshot notice on its very first Bash call.
    //
    // The fresh clock is `session.lock`, written by session-start Phase 1.2 —
    // a skill step, so it runs on every harness, not only where a hook does.
    writeClock('current-session.json', { timestamp: isoAgo(6 * HOURS) }); // leftover
    writeClock('session.lock', { started_at: isoAgo(30_000) }); // this session

    expect(sessionAgeMs(repo, NOW)).toBe(30_000);
    // …and the notice the age feeds is therefore SILENT, which is the point.
    expect(formatSnapshotMissingNotice({ sessionAge: sessionAgeMs(repo, NOW), scopeAge: 30_000 })).toBeNull();

    // The guard must NOT go blind in the regime it was built for: once the
    // session is GENUINELY long both clocks agree and the notice fires. This
    // is what a hard staleness cap would have destroyed.
    writeClock('current-session.json', { timestamp: isoAgo(14 * HOURS) });
    writeClock('session.lock', { started_at: isoAgo(14 * HOURS) });
    expect(sessionAgeMs(repo, NOW)).toBe(14 * HOURS);
    const notice = formatSnapshotMissingNotice({ sessionAge: sessionAgeMs(repo, NOW), scopeAge: 30_000 });
    expect(notice).toContain('the session started 840 min ago');
  });

  it('degenerates to whichever single clock is readable, and to null when neither is', () => {
    // Bug caught: reading a SECOND file must not make the hook depend on it.
    // Only current-session.json (the pre-#957 world, and every existing test).
    writeClock('current-session.json', { timestamp: isoAgo(45 * MINUTES) });
    expect(sessionAgeMs(repo, NOW)).toBe(45 * MINUTES);

    // Only session.lock — a harness that never wrote current-session.json now
    // has a session clock at all, where before it had none.
    rmSync(join(repo, '.orchestrator', 'current-session.json'));
    writeClock('session.lock', { started_at: isoAgo(20 * MINUTES) });
    expect(sessionAgeMs(repo, NOW)).toBe(20 * MINUTES);

    // Fail-safe direction is SILENCE: unreadable clocks contribute nothing
    // rather than a guess. Garbage JSON, a missing field, a non-ISO string and
    // a non-string value must each yield null, never NaN and never an alarm.
    for (const [cs, lock] of [
      ['not json at all', '{"started_at":'],
      [{ nope: 1 }, { nope: 1 }],
      [{ timestamp: 'yesterday' }, { started_at: 'yesterday' }],
      [{ timestamp: 12345 }, { started_at: null }],
    ]) {
      writeClock('current-session.json', cs);
      writeClock('session.lock', lock);
      expect(sessionAgeMs(repo, NOW)).toBeNull();
    }

    rmSync(join(repo, '.orchestrator'), { recursive: true });
    expect(sessionAgeMs(repo, NOW)).toBeNull();
  });

  it('drops a FUTURE timestamp instead of letting it win the minimum', () => {
    // Bug caught: min() over raw `now - started_at` lets a single timestamp in
    // the future produce a NEGATIVE age that wins every comparison and silences
    // the notice forever. That would be a brand-new silence range bought with
    // one forgery — precisely what choosing min() over a staleness cap avoided.
    writeClock('current-session.json', { timestamp: isoAgo(-2 * HOURS) }); // 2 h in the FUTURE
    writeClock('session.lock', { started_at: isoAgo(9 * HOURS) });

    expect(sessionAgeMs(repo, NOW)).toBe(9 * HOURS);
    expect(formatSnapshotMissingNotice({ sessionAge: sessionAgeMs(repo, NOW) })).toContain('540 min ago');

    // A lone future clock is unknown, not "age zero".
    rmSync(join(repo, '.orchestrator', 'session.lock'));
    expect(sessionAgeMs(repo, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E2E — real hook process against a real git repo (fake-regression)
// ---------------------------------------------------------------------------

describe('post-bash-write-verify E2E', () => {
  let tmp;

  const git = (...args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });

  const runHook = () => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > out-of-scope.mjs' } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, SO_HOOK_PROFILE: 'full', SO_DISABLED_HOOKS: '' },
    timeout: 20_000,
  });

  const writeScope = (allowedPaths, gates) => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths, ...(gates ? { gates } : {}) }),
    );
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pbwv-e2e-'));
    git('init', '-q');
    git('config', 'user.email', 't@e.st');
    git('config', 'user.name', 'T');
    mkdirSync(join(tmp, 'hooks'), { recursive: true });
    writeFileSync(join(tmp, 'hooks', 'keep.mjs'), '// seed\n');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed');
    // Clear any stale snapshot for this tmp path (paths are unique per test).
    // The hook keys its snapshot on the REALPATH of the project dir (macOS
    // /var/folders → /private/var/folders), so the test must too.
    const snap = snapshotPathFor(realpathSync(tmp));
    if (existsSync(snap)) rmSync(snap, { force: true });
  });

  afterEach(() => {
    if (tmp && existsSync(tmp)) {
      // The hook keys its snapshot on the REALPATH of the project dir (macOS
    // /var/folders → /private/var/folders), so the test must too.
    const snap = snapshotPathFor(realpathSync(tmp));
      if (existsSync(snap)) rmSync(snap, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('WARNS when a Bash call wrote outside allowedPaths', () => {
    writeScope(['hooks/**']);
    // 1st call: silent baseline of a clean tree.
    expect(runHook().stderr).toBe('');
    // Simulate the bypass: a Bash write no PreToolUse path gate ever saw.
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');

    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('bash-write-verify');
    expect(res.stderr).toContain('out-of-scope.mjs');

    const envelope = JSON.parse(res.stdout.trim());
    expect(envelope.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(envelope.hookSpecificOutput.additionalContext).toContain('out-of-scope.mjs');
  });

  it('still runs when invoked through a SYMLINKED path (#938 MED-2, W4 panel)', () => {
    // Bug caught: `isMain = argv[1] === fileURLToPath(import.meta.url)` read
    // false under a symlinked $CLAUDE_PLUGIN_ROOT (argv[1] is the symlink path,
    // import.meta.url is realpath-resolved) → main() never ran → the whole
    // scope-detector silently no-op'd. realpath'ing both sides fixes it.
    writeScope(['hooks/**']);
    // A symlink to the REAL hook file, invoked as the script entry point.
    const linkDir = mkdtempSync(join(tmpdir(), 'pbwv-symlink-'));
    const linkedHook = join(linkDir, 'post-bash-write-verify.mjs');
    symlinkSync(HOOK, linkedHook);
    try {
      const baseline = () => spawnSync(process.execPath, [linkedHook], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x' } }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, SO_HOOK_PROFILE: 'full', SO_DISABLED_HOOKS: '' },
        timeout: 20_000,
      });
      expect(baseline().stderr).toBe(''); // clean baseline via the symlink → main() ran
      writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');
      const res = baseline();
      expect(res.status).toBe(0);
      // The decisive assertion: main() ran through the symlink and produced the
      // warning. Before the fix this was empty (hook silently disabled).
      expect(res.stderr).toContain('bash-write-verify');
      expect(res.stderr).toContain('out-of-scope.mjs');
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it('is SILENT when the Bash call wrote inside allowedPaths', () => {
    writeScope(['hooks/**']);
    expect(runHook().stderr).toBe('');
    writeFileSync(join(tmp, 'hooks', 'in-scope.mjs'), 'ok\n');

    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('');
  });

  it('is SILENT for an ignored path (sibling-hook event write) outside allowedPaths', () => {
    writeScope(['hooks/**']);
    expect(runHook().stderr).toBe('');
    mkdirSync(join(tmp, '.orchestrator', 'metrics'), { recursive: true });
    writeFileSync(join(tmp, '.orchestrator', 'metrics', 'events.jsonl'), '{"k":1}\n');

    const res = runHook();
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('');
  });

  it('reports each out-of-scope path exactly once across consecutive calls', () => {
    writeScope(['hooks/**']);
    runHook();
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');
    expect(runHook().stderr).toContain('out-of-scope.mjs');
    // Same dirty tree, next Bash call → silence. Without report-once this line
    // repeats for every remaining Bash call of the session.
    expect(runHook().stderr).toBe('');
  });

  it('respects gates["bash-write-verify"]: false', () => {
    writeScope(['hooks/**'], { 'bash-write-verify': false });
    runHook();
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');
    expect(runHook().stderr).toBe('');
  });

  it('is inert with no wave-scope.json (nothing defines "outside")', () => {
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');
    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('is inert under enforcement: off', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'off', allowedPaths: ['hooks/**'] }),
    );
    runHook();
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');
    expect(runHook().stderr).toBe('');
  });

  it('never writes its snapshot inside the repo (self-report immunity, live check)', () => {
    writeScope(['hooks/**']);
    runHook();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: tmp, encoding: 'utf8' });
    // Only the scope file the test itself created may be dirty.
    expect(dirty).not.toContain('so-bash-write-verify');
    const live = snapshotPathFor(realpathSync(tmp));
    expect(existsSync(live)).toBe(true);
    expect(JSON.parse(readFileSync(live, 'utf8'))).toHaveProperty('signature');
  });

  // -------------------------------------------------------------------------
  // #938 — the three self-silencing vectors
  // -------------------------------------------------------------------------

  it('reports a control-file rewrite and still evaluates the SAME call under the pre-change scope (#938 V1)', () => {
    // Bug caught: wave-scope.json sat on the hook's own ignore list AND is
    // typically gitignored, while G4/G5 read the LIVE file — one Bash call
    // could write `enforcement: "off"` plus an out-of-scope file and the hook
    // reported neither the gate change nor the write.
    writeScope(['hooks/**']);
    runHook(); // baseline records the pre-change scope state
    // The observed actor silences the guard and writes out of scope in one call:
    writeFileSync(
      join(tmp, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'off', allowedPaths: ['hooks/**'] }),
    );
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');

    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('wave-scope.json'); // the rewrite is reported …
    expect(res.stderr).toContain('enforcement warn→off'); // … with the weakening named …
    expect(res.stderr).toContain('out-of-scope.mjs'); // … and the write still evaluated
    // The new state is honored from the NEXT call on (a legit disable still works):
    expect(runHook().stderr).toBe('');
  });

  it('still reports an out-of-scope write after the $TMPDIR state file was deleted (#938 V2)', () => {
    // Bug caught: `rm -f $TMPDIR/so-bash-write-verify/<key>.json` (outside the
    // repo, invisible to git status, untouched by the destructive-guard)
    // forced a silent re-baseline that swallowed the very write being observed.
    writeScope(['hooks/**']);
    runHook(); // baseline exists
    rmSync(snapshotPathFor(realpathSync(tmp)), { force: true }); // the attack
    // Deterministic mtime ordering on any fs granularity: scope file is old …
    const past = new Date(Date.now() - 20 * 60_000);
    utimesSync(join(tmp, '.claude', 'wave-scope.json'), past, past);
    // … and the observed write is new.
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');

    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('out-of-scope.mjs');
    // Fix 3: the missing sidecar under a 20-min-old scope file is itself named.
    expect(res.stderr).toContain('no state snapshot');
  });

  // Bug caught, twice. #944 first: G4/G5 fell back to the LIVE wave-scope.json
  // whenever no snapshot existed. The sidecar path is sha1(repoRoot).slice(0,16)
  // under $TMPDIR — exactly computable — so `rm -f` on it re-creates the "no
  // snapshot" precondition ON DEMAND, not only on the genuine first call. One
  // Bash call could therefore delete the sidecar, write `enforcement: "off"`,
  // and write out of scope, and the hook judged that call under the value the
  // same call had just installed: no path report, and (because the G5 return
  // sat BEFORE the suspicion line) no lost-sidecar notice either.
  //
  // The #944 fix then keyed the strict decision on `snapshot === null` — on file
  // EXISTENCE — which closed exactly ONE of four states at unchanged attacker
  // cost: `rm -f <path>` simply becomes `echo '{}' > <path>`. Measured against
  // that fix, B and C were still totally silent (both assertions below failed);
  // A and D were already reported. The decision now hangs on whether a
  // TRUSTWORTHY prior scope state can be read — a current-build schema marker
  // plus a string `enforcement` — which no forgery supplies without writing the
  // very value it wants hidden.
  //
  // Both assertions are load-bearing and neither may be dropped: they are two
  // effects of ONE condition. A fix that restores the path report but leaves the
  // notice on the old condition passes a `toContain('out-of-scope.mjs')` test
  // while still dropping the tamper trail.
  it.each([
    ['A: absent — `rm -f <sidecar>`', null],
    ['B: empty object — `echo \'{}\' > <sidecar>`', '{}'],
    ['C: scopeState present, enforcement missing', '{"scopeState":{"hash":"deadbeef"}}'],
    ['D: unparseable — `echo garbage > <sidecar>`', 'garbage'],
    // E is the same forgery aimed at the OTHER suppression axis: a record whose
    // `paths` claims the write was already reported. The signature must match or
    // computeReport re-baselines anyway, so it is computed the way the hook does.
    ['E: forged report-once list (signature + paths)',
      JSON.stringify({ signature: scopeSignature(['hooks/**']), paths: ['out-of-scope.mjs'] })],
  ])('evaluates a call as strict when the sidecar holds no trustworthy scope state (%s) (#944/#945)', (_label, sidecar) => {
    // The kill-switch the observed call installs for itself.
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'off', allowedPaths: ['hooks/**'] }),
    );
    // Both clocks aged: makes the suspicion notice reachable at all, and makes
    // computeReport's mtime attribution deterministic on coarse-granularity fs.
    const past = new Date(Date.now() - 20 * 60_000);
    utimesSync(join(tmp, '.claude', 'wave-scope.json'), past, past);
    mkdirSync(join(tmp, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(tmp, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: 'sid', timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
    );
    // The sidecar state this one Bash call buys itself — same path, same round.
    const snap = snapshotPathFor(realpathSync(tmp));
    if (sidecar === null) {
      rmSync(snap, { force: true });
    } else {
      mkdirSync(dirname(snap), { recursive: true });
      writeFileSync(snap, sidecar);
    }
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');

    const res = runHook();
    expect(res.status).toBe(0);
    // 1) the out-of-scope write is still evaluated and reported …
    expect(res.stderr).toContain('out-of-scope.mjs');
    expect(JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext)
      .toContain('out-of-scope.mjs');
    // 2) … and the guard's own lost/forged state is named, not silently trusted.
    expect(res.stderr).toContain('state snapshot');

    // The anti-noise half still holds: with the state now recorded by THIS
    // build, a genuinely configured `enforcement: off` is honored from the next
    // call on — the second write proves the silence is not mere report-once.
    writeFileSync(join(tmp, 'second-out-of-scope.mjs'), 'pwned\n');
    expect(runHook().stderr).toBe('');
  });

  it('names a lost sidecar via SESSION age even when the scope-file mtime was reset (#945)', () => {
    // Bug caught: `touch .claude/wave-scope.json` (content unchanged → no
    // control notice) reset the only clock the lost-sidecar heuristic had, so
    // the same Bash call that deleted the sidecar also neutralised the warning
    // about the deletion. Session start time is not reachable by that touch.
    writeScope(['hooks/**']); // scope file mtime = now → the #938 clock reads "clean first call"
    mkdirSync(join(tmp, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(tmp, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: 'sid', timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
    );
    rmSync(snapshotPathFor(realpathSync(tmp)), { force: true }); // the attack

    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('no state snapshot');
    expect(res.stderr).toContain('the session started');
    // Report-once: the notice must not repeat for every remaining Bash call.
    expect(runHook().stderr).toBe('');
  });

  it('a wave rollover reports dirt written AFTER the new scope file, never pre-wave dirt (#938 V3)', () => {
    // Bug caught: the first Bash call after every scope change was blind, so an
    // out-of-scope write timed into that call vanished into the re-baseline.
    // The anti-noise half still holds: pre-wave dirt is not blamed, and the
    // coordinator's legitimate rollover produces a visible, non-alarming notice.
    writeScope(['hooks/**']);
    runHook();
    // Pre-wave dirt, clearly older than the upcoming rollover:
    writeFileSync(join(tmp, 'pre-wave.mjs'), 'old dirt\n');
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(tmp, 'pre-wave.mjs'), past, past);
    // Coordinator rolls over to a new wave (changed allowedPaths → re-baseline);
    // pin the scope mtime BETWEEN pre-wave dirt and the upcoming write so the
    // ordering is deterministic on coarse-granularity filesystems too.
    writeScope(['docs/**']);
    const scopeAge = new Date(Date.now() - 5_000);
    utimesSync(join(tmp, '.claude', 'wave-scope.json'), scopeAge, scopeAge);
    // First Bash call of the new wave writes out of scope:
    writeFileSync(join(tmp, 'evil-new-wave.mjs'), 'pwned\n');

    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('evil-new-wave.mjs'); // V3 closed
    expect(res.stderr).not.toContain('pre-wave.mjs'); // pre-wave dirt not blamed
    expect(res.stderr).toContain('wave-scope.json'); // rollover notice visible
  });

  it('reports a peer-session-scoped path as a PEER WRITE, not a violation (#1195)', () => {
    // The bug: the hook knew only `allowedPaths`, so a file a PEER session
    // declared through a `peer-session-*` record in the wave's aggregate sidecar
    // was reported as "changed by a Bash call OUTSIDE the wave's N allowedPaths"
    // — an alarm naming the peer's own agreed, legitimate write. Measured in a
    // consumer repo 2026-09-02 (#1195): a peer's temp helper file surfaced in
    // this session's knip gate through exactly this line.
    mkdirSync(join(tmp, '.claude', 'filescopes'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'wave-scope.json'),
      JSON.stringify({ wave: 4, role: 'Impl', enforcement: 'warn', allowedPaths: ['hooks/**'] }),
    );
    writeFileSync(
      join(tmp, '.claude', 'filescopes', 'wave-4.scopes.json'),
      JSON.stringify([
        { id: 'a1', files: ['hooks/**'] },
        { id: 'peer-session-b', files: ['peer/**'] },
      ]),
    );
    runHook(); // baseline — folds the sidecar's own untracked path into the snapshot
    mkdirSync(join(tmp, 'peer'), { recursive: true });
    writeFileSync(join(tmp, 'peer', 'helper.mjs'), 'peer temp helper\n');

    const res = runHook();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain(
      'peer/helper.mjs inside peer-session-b scope — peer write, not a violation',
    );
    // The decisive half: the same path must NOT also be counted as a violation.
    expect(res.stderr).not.toContain('OUTSIDE the wave');

    // The PREMISE of this test — 'peer/**' absent from allowedPaths — is not a
    // fixture convenience: it is what the production union must produce from
    // this very sidecar. While `--union` unioned peer records in, allowedPaths
    // granted 'peer/**' to every agent of the wave and this branch was
    // unreachable in production, passing here only because the fixture wrote
    // allowedPaths by hand (W4 architect HIGH-1, #1195).
    const union = spawnSync(
      process.execPath,
      [
        new URL('../../scripts/validate-wave-scope.mjs', import.meta.url).pathname,
        '--union',
        join(tmp, '.claude', 'filescopes', 'wave-4.scopes.json'),
      ],
      {
        input: JSON.stringify({
          wave: 4, role: 'Impl', enforcement: 'warn', allowedPaths: [], blockedCommands: [],
        }),
        encoding: 'utf8',
      },
    );
    expect(union.status).toBe(0);
    expect(JSON.parse(union.stdout)).not.toContain('peer/**');
  });

  it('is unchanged when the aggregate sidecar is absent (#1195)', () => {
    writeScope(['hooks/**']);
    runHook();
    writeFileSync(join(tmp, 'out-of-scope.mjs'), 'pwned\n');
    const res = runHook();
    expect(res.stderr).toContain('OUTSIDE the wave');
    expect(res.stderr).toContain('out-of-scope.mjs');
    expect(res.stderr).not.toContain('peer write');
  });
});
