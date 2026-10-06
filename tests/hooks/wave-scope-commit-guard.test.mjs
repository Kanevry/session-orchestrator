/**
 * tests/hooks/wave-scope-commit-guard.test.mjs
 *
 * Regression tests for hooks/wave-scope-commit-guard.mjs — PSA-004 sub-mode B
 * commit-time guard that catches lint-staged sweep violations after the
 * PreToolUse Edit/Write gate has already passed.
 *
 * Strategy: spawn the hook as a subprocess inside a real tmp git repo
 * (NOT mocked — anti-test-the-mock per .claude/rules/test-quality.md),
 * stage files via `git add`, optionally write .orchestrator/wave-scope.json,
 * then assert exit code + stderr.
 *
 * Issue: #495 (PSA-004 sub-mode B)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(REPO_ROOT, 'hooks/wave-scope-commit-guard.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook with CWD set to the tmp repo. The hook resolves repoRoot
 * via `git rev-parse --show-toplevel`, so the tmp repo must be a real git
 * repo. Returns { code, stdout, stderr }.
 */
async function runHook(cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd,
      // The setup file already scrubbed the ambient session ids; a test that
      // needs one names it here.
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

/**
 * Create a fresh tmp git repo. Returns its absolute path.
 */
async function mkRepo() {
  const dir = makeTmpDir('wave-commit-guard-test-');
  fixtureGit(['init', '-q'], dir);
  // git config a user — needed so future `git commit` calls would work, but
  // we only use `git add` + `git diff --cached` here. Defensive belt-and-braces.
  fixtureGit(['config', 'user.email', 'test@example.com'], dir);
  fixtureGit(['config', 'user.name', 'Test'], dir);
  return dir;
}

/**
 * Write a wave-scope.json under .claude/ inside the repo — the actual
 * resolution path per scope-gate.mjs findScopeFile() precedence
 * (.pi/.cursor/.codex/.claude), matching where the coordinator writes it
 * (skills/wave-executor/references/wave-loop-scope-manifest.md). #801: the hook
 * previously read a
 * hardcoded (dead) .orchestrator/wave-scope.json path — see the dedicated
 * legacy-path test below that pins the fix.
 */
async function writeScope(repoDir, scope) {
  const dir = path.join(repoDir, '.claude');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'wave-scope.json'), scope);
}

/**
 * Write a wave-scope.json under the LEGACY .orchestrator/ path — the dead
 * path #801 fixed. Used only by the dedicated legacy-path regression test.
 */
async function writeLegacyOrchestratorScope(repoDir, scope) {
  const dir = path.join(repoDir, '.orchestrator');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'wave-scope.json'), scope);
}

/**
 * Create a file under the repo and `git add` it.
 */
async function stageFile(repoDir, relPath, content = 'x\n') {
  const abs = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  fixtureGit(['add', relPath], repoDir);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    removeTree(d);
  }
});

async function mkRepoTracked() {
  const dir = await mkRepo();
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Test cases (per task spec)
// ---------------------------------------------------------------------------

describe('wave-scope-commit-guard — PSA-004 sub-mode B', { timeout: 15000 }, () => {
  it('exits 0 with no output when no wave-scope.json present (no active wave)', async () => {
    const dir = await mkRepoTracked();
    await stageFile(dir, 'src/app.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  // Changed deliberately (#1493.1). This used to pin "empty allowedPaths →
  // exit 0 (permissive default)": a writing wave whose `--union` step never
  // completed let EVERY staged path through, while enforce-scope denied the same
  // paths at write time. An empty manifest is now judged by its role instead.
  it('blocks a commit under an EMPTY manifest of a writing role — the union never completed (#1493.1)', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ wave: 2, role: 'Impl-Core', allowedPaths: [] }));
    await stageFile(dir, 'README.md');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/grants no paths for role `Impl-Core`.*--union/);
  });

  it('lets the coordinator commit between waves under an empty Discovery manifest, with a note', async () => {
    // Bug caught (the deny-all shape of the fix above): Discovery's `[]` is its
    // read-only contract and no agent commits, so blocking here would block
    // every coordinator commit made while the Discovery manifest is still in place.
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ wave: 1, role: 'Discovery', allowedPaths: [] }));
    await stageFile(dir, 'README.md');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/Discovery \(read-only\) manifest/);
  });

  it('never blocks on an empty manifest older than the newest session start — it may be a peer\'s', async () => {
    // Bug caught: a crashed session's leftover (or a parallel session's live,
    // unbound) empty manifest would block every later commit under strict.
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ wave: 2, role: 'Impl-Core', allowedPaths: [] }));
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(path.join(dir, '.claude', 'wave-scope.json'), past, past);
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ timestamp: new Date().toISOString() }),
    );
    await stageFile(dir, 'README.md');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/predates the newest session start/);
  });

  it('stands down on a manifest bound to ANOTHER session (#1493.1)', async () => {
    // Bug caught: the guard had no session check, so a peer session's manifest
    // in the same working copy blocked this session's commit of its own files.
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ session_id: 'sess-peer', allowedPaths: ['src/'] }));
    await stageFile(dir, 'docs/mine.md');
    const result = await runHook(dir, { CLAUDE_CODE_SESSION_ID: 'sess-mine' });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/belongs to another session/);
  });

  it("BLOCKS from this session's own .claude manifest when a peer's .codex manifest outranks it (#1504 point 6)", async () => {
    // BUG: the guard took the FIRST existing manifest (.codex outranks .claude);
    // the peer's one read foreign and the commit passed, while this session's
    // own .claude manifest was never read. The peer allows docs/, so the block
    // can only come from our own allowedPaths.
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ session_id: 'sess-mine', allowedPaths: ['src/'] }));
    await fs.mkdir(path.join(dir, '.codex'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.codex', 'wave-scope.json'),
      JSON.stringify({ session_id: 'sess-peer', allowedPaths: ['docs/'] }),
    );
    await stageFile(dir, 'docs/mine.md');
    const result = await runHook(dir, { CLAUDE_CODE_SESSION_ID: 'sess-mine' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/outside wave-scope\.allowedPaths[\s\S]*docs\/mine\.md/);
  });

  it('keeps BLOCKING an out-of-scope staged path under enforcement: warn', async () => {
    // Bug caught: tying this verdict to `enforcement` turned the only hard
    // PSA-004 stop of a warn-mode wave (enforce-scope lets the write through
    // there) into a stderr line, so a lint-staged sweep reached the commit.
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ enforcement: 'warn', allowedPaths: ['src/'] }));
    await stageFile(dir, 'docs/out.md');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/outside wave-scope\.allowedPaths[\s\S]*docs\/out\.md/);
  });

  it('passes silently under enforcement: off, even with an out-of-scope staged path', async () => {
    // Bug caught: if the `off` rung stops being honoured, a wave the operator
    // switched off still blocks every commit that stages a path outside
    // allowedPaths — no other test reaches this rung.
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ enforcement: 'off', allowedPaths: ['src/'] }));
    await stageFile(dir, 'docs/out.md');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('only REPORTS an empty writing-role union under enforcement: warn (#1493.1)', async () => {
    // Bug caught: the empty-union verdict judges the coordinator's bookkeeping,
    // not a staged foreign file; blocking it in a warn-mode wave would stop every
    // coordinator commit until the union is re-run.
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ enforcement: 'warn', role: 'Impl-Core', allowedPaths: [] }));
    await stageFile(dir, 'README.md');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/grants no paths[\s\S]*enforcement: warn/);
  });

  it('exits 0 when all staged paths are inside allowedPaths', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/', 'lib/'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'lib/util.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 1 with stderr listing the path + restore hint when one staged path is outside allowedPaths', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'tests/foreign.test.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('wave-scope-commit-guard');
    expect(result.stderr).toContain('tests/foreign.test.ts');
    // src/app.ts is in-scope, must NOT appear in the violation list
    expect(result.stderr).not.toContain('  - src/app.ts');
    // Restore hint must be present
    expect(result.stderr).toContain('git restore --staged');
  });

  it('exits 1 with parse error when wave-scope.json is malformed', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, '{ not valid json');
    await stageFile(dir, 'src/app.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('wave-scope-commit-guard');
    expect(result.stderr).toContain('failed to parse .claude/wave-scope.json');
  });

  it('names WHICH manifest failed to parse when the subdirectory one is corrupt (#1514.2)', async () => {
    // Bug caught: with two candidate manifests the message said only
    // "wave-scope.json", so the operator could not tell the valid repo-root one
    // from the corrupt one under the session root.
    const dir = await mkRepoTracked();
    const pkg = path.join(dir, 'pkg');
    await writeScope(dir, JSON.stringify({ allowedPaths: ['pkg/'] }));
    await writeScope(pkg, '{ not valid json');
    await stageFile(dir, 'pkg/src/a.mjs');
    const result = await runHook(dir, { CLAUDE_PROJECT_DIR: pkg });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed to parse pkg/.claude/wave-scope.json');
  });
});

// ---------------------------------------------------------------------------
// #801 — wave-scope path resolution (findScopeFile precedence, dead-path fix)
// ---------------------------------------------------------------------------

describe('wave-scope-commit-guard — #801 wave-scope path resolution', { timeout: 15000 }, () => {
  it('exits 1 (guard fires) when wave-scope.json is under .claude/ (findScopeFile precedence)', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await stageFile(dir, 'tests/foreign.test.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('tests/foreign.test.ts');
  });

  it('exits 0 (guard does NOT fire) when wave-scope.json is under the legacy .orchestrator/ path', async () => {
    // Documents the #801 dead path: the hook no longer reads
    // .orchestrator/wave-scope.json at all, so an out-of-scope staged file
    // is silently allowed through when only the legacy location is populated.
    const dir = await mkRepoTracked();
    await writeLegacyOrchestratorScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await stageFile(dir, 'tests/foreign.test.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('reads the manifest at the session root when the session was launched in a repo SUBDIRECTORY (#1511 point d)', async () => {
    // BUG: the guard read only `<toplevel>/.claude/wave-scope.json`, while
    // enforce-scope reads at `resolveSessionRoot` — the launch subdirectory. The
    // repo root holds no manifest, so an out-of-scope staged path passed. The
    // in-scope path pins the other half: manifest paths are relative to the
    // session root, so matching the repo-relative `pkg/src/a.mjs` would block it.
    const dir = await mkRepoTracked();
    const pkg = path.join(dir, 'pkg');
    await writeScope(pkg, JSON.stringify({ allowedPaths: ['src/a.mjs'] }));
    await stageFile(dir, 'pkg/src/a.mjs');
    const inScope = await runHook(dir, { CLAUDE_PROJECT_DIR: pkg });
    expect(inScope.code).toBe(0);

    await stageFile(dir, 'pkg/src/b.mjs');
    const outOfScope = await runHook(dir, { CLAUDE_PROJECT_DIR: pkg });
    expect(outOfScope.code).toBe(1);
    expect(outOfScope.stderr).toMatch(/outside wave-scope\.allowedPaths[\s\S]*pkg\/src\/b\.mjs/);
  });

  it('still reads the REPO-ROOT manifest when a subdirectory session root holds none (#1511 d regression)', async () => {
    // BUG: the subdirectory mode replaced the repo-root lookup, so a wave whose
    // manifest sits at the toplevel stopped governing a commit made from a
    // session launched in `pkg/` — the out-of-scope path passed with exit 0.
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await fs.mkdir(path.join(dir, 'pkg'), { recursive: true });
    await stageFile(dir, 'other/evil.mjs');
    const result = await runHook(dir, { CLAUDE_PROJECT_DIR: path.join(dir, 'pkg') });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('other/evil.mjs');
  });

  // BUG (second review, MED-1): the repo-root manifest was consulted only when
  // the subdirectory held no own manifest, so an unbound or `enforcement: off`
  // subdirectory manifest silenced a repo-root wave that blocked the commit
  // before #1511 d. Invariant: never laxer than the repo-root-only guard
  // (a9c6f98a) — `old` is that guard's exit code for the same cell.
  const OWN_ROOT = { session_id: 'me', allowedPaths: ['pkg/src/ok.mjs'] };
  it.each([
    ['unbound+off', { allowedPaths: ['x'], enforcement: 'off' }, OWN_ROOT, ['other/evil.mjs'], 1],
    ['unbound+off', { allowedPaths: ['x'], enforcement: 'off' }, { allowedPaths: ['src/'] }, ['other/evil.mjs'], 1],
    ['own', { session_id: 'me', allowedPaths: ['src/ok.mjs'] }, OWN_ROOT, ['pkg/src/ok.mjs'], 0],
    ['own', { session_id: 'me', allowedPaths: ['src/ok.mjs'] }, OWN_ROOT, ['other/evil.mjs'], 1],
    ['foreign', { session_id: 'peer', allowedPaths: ['src/ok.mjs'] }, OWN_ROOT, ['other/evil.mjs'], 1],
    ['absent', null, OWN_ROOT, ['other/evil.mjs'], 1],
    ['absent', null, OWN_ROOT, ['pkg/src/ok.mjs'], 0],
  ])('session-root %s manifest vs repo-root manifest: exit never below the repo-root-only guard (%#)', async (_label, sub, root, staged, old) => {
    const dir = await mkRepoTracked();
    const pkg = path.join(dir, 'pkg');
    await fs.mkdir(pkg, { recursive: true });
    if (sub !== null) await writeScope(pkg, JSON.stringify(sub));
    await writeScope(dir, JSON.stringify(root));
    for (const f of staged) await stageFile(dir, f);
    const result = await runHook(dir, { CLAUDE_PROJECT_DIR: pkg, CLAUDE_CODE_SESSION_ID: 'me' });
    expect(result.code).toBe(old);
  });

  it('blocks a staged path OUTSIDE the subdirectory session root even when a glob would match its ../ form', async () => {
    // BUG: `other/evil.mjs` became `../other/evil.mjs`, which `**/*.mjs`
    // matches — a write enforce-scope denies (REQ-04) committed unchecked.
    const dir = await mkRepoTracked();
    const pkg = path.join(dir, 'pkg');
    await writeScope(pkg, JSON.stringify({ allowedPaths: ['**/*.mjs'] }));
    await stageFile(dir, 'pkg/src/ok.mjs');
    await stageFile(dir, 'other/evil.mjs');
    const result = await runHook(dir, { CLAUDE_PROJECT_DIR: pkg });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('other/evil.mjs');
    expect(result.stderr).not.toContain('pkg/src/ok.mjs');
  });

  it('prints the remediation hint once and names both manifests when both block (#1514.3)', async () => {
    // Bug caught: each blocking manifest printed its own "To proceed:" block
    // under an identical header, so the operator saw the hint twice and could
    // not tell which manifest had blocked.
    const dir = await mkRepoTracked();
    const pkg = path.join(dir, 'pkg');
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await writeScope(pkg, JSON.stringify({ allowedPaths: ['src/a.mjs'] }));
    await stageFile(dir, 'other/evil.mjs');
    const result = await runHook(dir, { CLAUDE_PROJECT_DIR: pkg });
    expect(result.code).toBe(1);
    expect(result.stderr.match(/To proceed:/g)).toHaveLength(1);
    expect(result.stderr).toContain('outside wave-scope.allowedPaths (.claude/wave-scope.json)');
    expect(result.stderr).toContain('outside wave-scope.allowedPaths (pkg/.claude/wave-scope.json)');
  });

  it('blocks a staged repo-root package-lock.json under a subdirectory manifest (#1514.4)', async () => {
    // Intentionally STRICTER than the repo-root-only guard, hence not a row of
    // the never-laxer matrix above: a path outside the session root is the
    // lint-staged sweep this guard exists to stop (header § Behavior summary).
    const dir = await mkRepoTracked();
    const pkg = path.join(dir, 'pkg');
    // Bind the manifest to the committing process: unknown ownership must
    // not stand in for the own-session REQ-04 contract.
    await writeScope(pkg, JSON.stringify({ session_id: 'sess-req04', allowedPaths: ['src/'] }));
    const env = { CLAUDE_PROJECT_DIR: pkg, CLAUDE_CODE_SESSION_ID: 'sess-req04' };
    await stageFile(dir, 'pkg/src/ok.mjs');
    const inScope = await runHook(dir, env);
    expect(inScope.code).toBe(0);
    expect(inScope.stderr).toBe('');

    await stageFile(dir, 'package-lock.json', '{}\n');
    const result = await runHook(dir, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/outside wave-scope\.allowedPaths[\s\S]*package-lock\.json/);
    expect(result.stderr).not.toContain('pkg/src/ok.mjs');
  });

  it('adopts a subdirectory session root named in a different letter case on a case-insensitive FS', async () => {
    // BUG: plain realpathSync keeps the caller's case, so a case-different
    // CLAUDE_PROJECT_DIR relativised to `../..` against the git toplevel and the
    // subdirectory mode silently stood down. Only reproducible where the FS
    // folds case (APFS default); elsewhere the case-different path does not exist.
    const dir = await mkRepoTracked();
    const pkg = path.join(dir, 'pkg');
    const shouted = path.join(path.dirname(dir), path.basename(dir).toUpperCase(), 'pkg');
    if (shouted === pkg) return;
    await writeScope(pkg, JSON.stringify({ allowedPaths: ['src/a.mjs'] }));
    let caseInsensitive = true;
    try { await fs.access(shouted); } catch { caseInsensitive = false; }
    if (!caseInsensitive) return;
    await stageFile(dir, 'pkg/src/b.mjs');
    const result = await runHook(dir, { CLAUDE_PROJECT_DIR: shouted });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('pkg/src/b.mjs');
  });
});

// ---------------------------------------------------------------------------
// G-M1 + G-L2 coverage gap tests (#553)
// ---------------------------------------------------------------------------

describe('wave-scope-commit-guard — #553 G-M1 coverage gaps', { timeout: 20000 }, () => {
  // G-M1.a — concurrent git-add race (no false positive from interleaving)
  it('two concurrent hook subprocesses on disjoint scopes do not falsely interfere', async () => {
    // Two separate tmp repos run the hook in parallel. The hook reads from
    // its own tmp repo's wave-scope.json and only walks its own fence dir;
    // there must be no cross-talk between the two child processes.
    const dirA = await mkRepoTracked();
    const dirB = await mkRepoTracked();
    await writeScope(dirA, JSON.stringify({ allowedPaths: ['src/'] }));
    await writeScope(dirB, JSON.stringify({ allowedPaths: ['lib/'] }));
    await stageFile(dirA, 'src/a.ts');
    await stageFile(dirB, 'lib/b.ts');

    const [resultA, resultB] = await Promise.all([runHook(dirA), runHook(dirB)]);

    expect(resultA.code).toBe(0);
    expect(resultB.code).toBe(0);
  });

  // G-M1.b — gitignored path: `git diff --cached` already excludes ignored
  // files. Even if a gitignored path appears in allowedPaths the guard never
  // sees it among staged files. We verify two things:
  //   1) Without -f, `git add` of an ignored file fails (git's built-in safety).
  //   2) The guard sees only the tracked, in-scope files and exits 0.
  it('gitignored paths are silently excluded by git diff --cached (no false positive)', async () => {
    const dir = await mkRepoTracked();
    // Write a .gitignore that ignores tmp/ — but stage nothing from .gitignore yet.
    await fs.writeFile(path.join(dir, '.gitignore'), 'tmp/\n');
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await stageFile(dir, 'src/app.ts');

    // Create a gitignored file and try to stage it explicitly. git refuses
    // without -f. The file therefore NEVER appears in `git diff --cached`.
    const ignored = path.join(dir, 'tmp', 'ignored.txt');
    await fs.mkdir(path.dirname(ignored), { recursive: true });
    await fs.writeFile(ignored, 'secret');
    let addSucceeded = true;
    try {
      fixtureGit(['add', 'tmp/ignored.txt'], dir, { stdio: 'pipe' });
    } catch {
      addSucceeded = false;
    }
    expect(addSucceeded).toBe(false);

    const result = await runHook(dir);
    // Only src/app.ts is in the cached set; it is in scope → exit 0.
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  // G-M1.c — glob edge cases: trailing slash + nested glob pattern
  it('trailing-slash directory pattern matches both files at the prefix and deep descendants', async () => {
    const dir = await mkRepoTracked();
    // Pattern 'src/' must match 'src/app.ts' AND 'src/utils/format.ts'.
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'src/utils/format.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('directory pattern WITHOUT trailing slash does NOT auto-match descendants', async () => {
    const dir = await mkRepoTracked();
    // 'src' (no slash) is treated as a literal path by pathMatchesPattern's
    // exact-match branch; 'src/app.ts' does NOT match 'src'.
    // This documents the existing behavior — operators must add trailing slash
    // or a recursive glob to allow descendants.
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src'] }));
    await stageFile(dir, 'src/app.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('src/app.ts');
  });

  it('nested recursive glob pattern src/**/*.ts matches deep descendants', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/**/*.ts'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'src/utils/helpers/format.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('nested recursive glob pattern src/**/*.ts rejects non-.ts files even when nested', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/**/*.ts'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'src/utils/data.json');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('src/utils/data.json');
  });
});

// ---------------------------------------------------------------------------
// #557 staging-fence lock timeout (sub-mode C) — +1 test
// ---------------------------------------------------------------------------

describe('wave-scope-commit-guard — #557 staging-fence lock timeout', { timeout: 20000 }, () => {
  // When the staging-fence commit-lock is held by a live PID, the hook's
  // withStagingFenceLock call times out (timeoutMs: 5000 in the hook). The
  // guard must exit 0 (fail-safe) and emit a warning containing
  // "staging-fence lock failed".
  it('exits 0 and warns when staging-fence lock cannot be acquired (timeout)', async () => {
    const dir = await mkRepoTracked();

    // Create the fence dir so the hook enters sub-mode C (does not short-circuit).
    await fs.mkdir(path.join(dir, '.orchestrator', 'staging-fence'), { recursive: true });

    // Stage a file so stagedFiles.length > 0 (another sub-mode C early-exit guard).
    await stageFile(dir, 'src/guarded.ts');

    // Write the .commit.lock with our own PID (definitely alive) so the hook's
    // tryAcquireStagingFenceLock always sees a live holder and never succeeds.
    // The hook's timeoutMs is 5000ms — the test waits that out.
    const lockBody = {
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
      holder: `stuck-pid-${process.pid}`,
    };
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'staging-fence', '.commit.lock'),
      JSON.stringify(lockBody, null, 2) + '\n',
      'utf8',
    );

    const result = await runHook(dir);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('staging-fence lock failed');
  });
});

describe('wave-scope-commit-guard — #553 G-L2 performance bound', { timeout: 30000 }, () => {
  // G-L2 — stage 500 files (mix in/out scope); assert exit + duration < 2s
  it('completes 500-file scan in under 2 seconds (perf bound)', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));

    // Stage 250 in-scope + 250 out-of-scope = 500 total.
    // Use a single `git add` call after writing all files to minimise setup time.
    const srcDir = path.join(dir, 'src');
    const otherDir = path.join(dir, 'other');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    const writes = [];
    for (let i = 0; i < 250; i++) {
      writes.push(fs.writeFile(path.join(srcDir, `f${i}.ts`), 'x'));
      writes.push(fs.writeFile(path.join(otherDir, `f${i}.ts`), 'x'));
    }
    await Promise.all(writes);
    fixtureGit(['add', 'src/', 'other/'], dir);

    const start = performance.now();
    const result = await runHook(dir);
    const elapsedMs = performance.now() - start;

    // Exit 1 because 250 out-of-scope files violate.
    expect(result.code).toBe(1);
    // Performance bound: 500-file scan must complete in under 2 seconds.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
