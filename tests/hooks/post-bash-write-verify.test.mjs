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
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parsePorcelainZ,
  isIgnoredPath,
  isInScope,
  scopeSignature,
  snapshotPathFor,
  computeReport,
  formatMessage,
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
    ['.pi/wave-scope.json', 'harness scope manifest'],
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

  it('treats an empty allowedPaths as "nothing is in scope"', () => {
    expect(isInScope('any.mjs', [])).toBe(false);
  });

  it('rejects a sibling path outside the declared globs', () => {
    expect(isInScope('scripts/lib/io.mjs', ['hooks/**', 'docs/*.md'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// snapshotPathFor
// ---------------------------------------------------------------------------

describe('snapshotPathFor', () => {
  it('places the snapshot OUTSIDE the repo so it cannot report itself', () => {
    // Deliberately not a `/Users/<name>/…` shape: the owner-leakage scanner's
    // CP1 rule flags canonicalized personal home paths in tracked files.
    const repo = '/srv/demo-repo';
    const snap = snapshotPathFor(repo);
    expect(snap.startsWith(tmpdir())).toBe(true);
    expect(snap.startsWith(repo)).toBe(false);
  });

  it('keys per repo so two working copies do not share a baseline', () => {
    expect(snapshotPathFor('/a/repo')).not.toBe(snapshotPathFor('/b/repo'));
  });
});

// ---------------------------------------------------------------------------
// computeReport — the anti-noise core
// ---------------------------------------------------------------------------

describe('computeReport', () => {
  const allowed = ['hooks/**'];
  const sig = scopeSignature(allowed);

  it('first run re-baselines SILENTLY — pre-existing dirt is not the observed call\'s fault', () => {
    const r = computeReport({
      dirtyPaths: ['scripts/lib/io.mjs', 'out-of-scope.mjs'],
      allowedPaths: allowed,
      snapshot: null,
      signature: sig,
    });
    expect(r.report).toEqual([]);
    expect(r.rebaselined).toBe(true);
    expect(r.nextSnapshot.paths).toEqual(['scripts/lib/io.mjs', 'out-of-scope.mjs']);
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

  it('a new wave (changed allowedPaths) re-baselines silently instead of blaming the next call', () => {
    const prev = { signature: scopeSignature(['docs/**']), paths: [] };
    const r = computeReport({
      dirtyPaths: ['out-of-scope.mjs'],
      allowedPaths: allowed,
      snapshot: prev,
      signature: sig,
    });
    expect(r.report).toEqual([]);
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

  it('names at most MAX_REPORTED_PATHS paths and discloses the remainder', () => {
    const many = Array.from({ length: MAX_REPORTED_PATHS + 7 }, (_, i) => `f${i}.mjs`);
    const msg = formatMessage(many, 1);
    expect(msg).toContain(`+7 more`);
    expect(msg).toContain('f0.mjs');
  });

  it('states the warn-only contract so the reader does not expect a block', () => {
    expect(formatMessage(['x.mjs'], 1)).toContain('Warn-only');
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
});
