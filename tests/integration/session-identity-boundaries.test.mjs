/**
 * Cross-surface identity boundary: SessionStart -> peer discovery -> issue budget.
 *
 * The records under test are written by the real SessionStart and registry
 * producers. The one altered record retains that emitted shape and changes only
 * its raw id, modelling a stale/foreign current-session binding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  promises as fs,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expectAllow } from '../_helpers/hook-decision.mjs';
import { budgetStatePath } from '../../scripts/lib/issue-budget.mjs';
import { enterWorktree } from '../../scripts/lib/autopilot/worktree-pipeline.mjs';
import { registerSelf, readRegistry } from '../../scripts/lib/session-registry.mjs';
import { findPeers } from '../../scripts/lib/peer-discovery.mjs';
import { acquire, writeOwnerProof, readLock } from '../../scripts/lib/session-lock.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SESSION_START_HOOK = path.join(REPO_ROOT, 'hooks/on-session-start.mjs');
const ISSUE_BUDGET_HOOK = path.join(REPO_ROOT, 'hooks/pre-bash-issue-budget.mjs');
const PEER_DISCOVERY_MODULE = pathToFileURL(
  path.join(REPO_ROOT, 'scripts/lib/peer-discovery.mjs'),
).href;
const SESSION_REGISTRY_MODULE = pathToFileURL(
  path.join(REPO_ROOT, 'scripts/lib/session-registry.mjs'),
).href;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMANTIC_SESSION_ID = /^[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+$/;
const FOREIGN_RAW_ID = '550e8400-e29b-41d4-a716-446655440001';
const MISMATCHED_PERSISTED_RAW_ID = '550e8400-e29b-41d4-a716-446655440002';
const UNBOUND_NATIVE_RAW_ID = '550e8400-e29b-41d4-a716-446655440003';
const WORKTREE_HEAD = '0123456789abcdef0123456789abcdef01234567';

const tmpDirs = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeProject() {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-identity-boundaries-'));
  const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-identity-registry-'));
  tmpDirs.push(projectDir, registryDir);
  await fs.writeFile(
    path.join(projectDir, 'CLAUDE.md'),
    [
      '# Fixture project',
      '',
      '## Session Config',
      '',
      'enable-host-banner: false',
      'cold-start:',
      '  enabled: false',
      'issue-budget:',
      '  max-per-session: 1',
      '  mode: strict',
      '  overflow: collect-issue',
      '',
    ].join('\n'),
    'utf8',
  );
  return { projectDir, registryDir };
}

async function runNode({ cwd, args, env, stdin = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function runSessionStart({ projectDir, registryDir, stdin }) {
  return runNode({
    cwd: projectDir,
    args: [SESSION_START_HOOK],
    env: {
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      CLANK_EVENT_SECRET: '',
      CLANK_EVENT_URL: '',
      SO_DISABLED_HOOKS: '',
      SO_HOOK_PROFILE: 'full',
      SO_SESSION_REGISTRY_DIR: registryDir,
    },
    stdin,
  });
}

async function registerForeignSameSemanticPeer({ projectDir, registryDir, semanticSessionId }) {
  const program = `
    import { registerSelf } from ${JSON.stringify(SESSION_REGISTRY_MODULE)};
    const [repoRoot, semanticId] = process.argv.slice(1);
    await registerSelf({
      sessionId: ${JSON.stringify(FOREIGN_RAW_ID)},
      semanticSessionId: semanticId,
      projectRoot: repoRoot,
      branch: 'main',
      platform: 'claude',
      mode: 'deep',
      status: 'active',
      currentWave: 0,
    });
  `;
  return runNode({
    cwd: projectDir,
    args: ['--input-type=module', '--eval', program, projectDir, semanticSessionId],
    env: { SO_SESSION_REGISTRY_DIR: registryDir },
  });
}

async function findPeersWithSemanticHint({ projectDir, registryDir, semanticSessionId }) {
  const program = `
    import { findPeers } from ${JSON.stringify(PEER_DISCOVERY_MODULE)};
    const [repoRoot, semanticId] = process.argv.slice(1);
    const result = await findPeers(repoRoot, {
      mySessionId: semanticId,
      listWorktreesImpl: async () => [{
        path: repoRoot,
        branch: 'main',
        head: ${JSON.stringify(WORKTREE_HEAD)},
      }],
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const result = await runNode({
    cwd: projectDir,
    args: ['--input-type=module', '--eval', program, projectDir, semanticSessionId],
    env: { SO_SESSION_REGISTRY_DIR: registryDir },
  });
  return JSON.parse(result.stdout);
}

async function runIssueBudget({ projectDir, registryDir, sessionId, title }) {
  return runNode({
    cwd: projectDir,
    args: [ISSUE_BUDGET_HOOK],
    env: {
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      SO_HOOK_PROFILE: 'full',
      SO_SESSION_REGISTRY_DIR: registryDir,
    },
    stdin: JSON.stringify({
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: {
        command: `glab issue create --title ${JSON.stringify(title)} --label "type::bug,priority::medium"`,
      },
    }),
  });
}

const sessionStartInputs = [
  ['semantic stdin', JSON.stringify({ session_id: 'main-2026-08-20-deep-9', mode: 'deep' })],
  ['absent stdin', ''],
];

describe('SessionStart identity boundaries across peer discovery and issue budgeting', () => {
  it.each([
    ['session_id', JSON.stringify({ session_id: 'not-a-uuid', mode: 'deep' })],
    ['sessionId', JSON.stringify({ sessionId: 'not-a-uuid', mode: 'deep' })],
  ])('never assigns malformed %s input ownership across SessionStart surfaces', async (_alias, stdin) => {
    const { projectDir, registryDir } = await makeProject();

    const result = await runSessionStart({ projectDir, registryDir, stdin });
    expect(result.code).toBe(0);

    const currentSession = JSON.parse(await fs.readFile(
      path.join(projectDir, '.orchestrator', 'current-session.json'),
      'utf8',
    ));
    const lock = JSON.parse(await fs.readFile(
      path.join(projectDir, '.orchestrator', 'session.lock'),
      'utf8',
    ));
    const registryFiles = await fs.readdir(path.join(registryDir, 'active'));
    const registryEntry = JSON.parse(await fs.readFile(
      path.join(registryDir, 'active', registryFiles[0]),
      'utf8',
    ));

    expect(currentSession).toMatchObject({
      session_id: expect.stringMatching(UUID_V4),
      source: 'generated-uuid',
    });
    expect(lock.session_id).toBe(currentSession.session_id);
    expect(registryEntry.session_id).toBe(currentSession.session_id);
    expect([currentSession.session_id, lock.session_id, registryEntry.session_id])
      .not.toContain('not-a-uuid');
  });

  it.each(sessionStartInputs)(
    'keeps raw identity physical and treats a same-semantic raw mismatch as foreign for %s',
    async (_caseName, stdin) => {
      const { projectDir, registryDir } = await makeProject();

      await runSessionStart({ projectDir, registryDir, stdin });
      const currentSessionPath = path.join(projectDir, '.orchestrator', 'current-session.json');
      const currentSession = JSON.parse(await fs.readFile(currentSessionPath, 'utf8'));

      expect(currentSession).toEqual(expect.objectContaining({
        session_id: expect.stringMatching(UUID_V4),
        semantic_session_id: expect.stringMatching(SEMANTIC_SESSION_ID),
        source: 'generated-uuid',
      }));

      await registerForeignSameSemanticPeer({
        projectDir,
        registryDir,
        semanticSessionId: currentSession.semantic_session_id,
      });
      const provenBindingPeers = await findPeersWithSemanticHint({
        projectDir,
        registryDir,
        semanticSessionId: currentSession.semantic_session_id,
      });

      expect(provenBindingPeers).toEqual({
        peers: [expect.objectContaining({ source: 'discovered', sessionId: FOREIGN_RAW_ID })],
      });

      const chargedBudget = await runIssueBudget({
        projectDir,
        registryDir,
        sessionId: currentSession.session_id,
        title: 'charged through the native binding',
      });
      expectAllow(chargedBudget);
      const boundBudget = JSON.parse(await fs.readFile(
        budgetStatePath(projectDir, currentSession.semantic_session_id),
        'utf8',
      ));

      expect(boundBudget).toEqual(expect.objectContaining({
        sessionId: currentSession.semantic_session_id,
        count: 1,
      }));

      await fs.writeFile(
        currentSessionPath,
        JSON.stringify({ ...currentSession, session_id: MISMATCHED_PERSISTED_RAW_ID }, null, 2) + '\n',
        'utf8',
      );
      const unprovenBindingPeers = await findPeersWithSemanticHint({
        projectDir,
        registryDir,
        semanticSessionId: currentSession.semantic_session_id,
      });

      expect(unprovenBindingPeers).toEqual({
        peers: [
          expect.objectContaining({ source: 'discovered', sessionId: expect.stringMatching(UUID_V4) }),
          expect.objectContaining({ source: 'discovered', sessionId: FOREIGN_RAW_ID }),
        ],
      });

      const unboundBudgetResult = await runIssueBudget({
        projectDir,
        registryDir,
        sessionId: UNBOUND_NATIVE_RAW_ID,
        title: 'fresh after a raw mismatch',
      });
      expectAllow(unboundBudgetResult);
      const unboundBudget = JSON.parse(await fs.readFile(
        budgetStatePath(projectDir, UNBOUND_NATIVE_RAW_ID),
        'utf8',
      ));

      expect(unboundBudget).toEqual(expect.objectContaining({
        sessionId: UNBOUND_NATIVE_RAW_ID,
        count: 1,
      }));
    },
  );
});

// ---------------------------------------------------------------------------
// #1069 — two REAL roots: source start → worktree switch → source end →
// destination start. The "realer Zwei-Root-Integrationstest" the issue's
// acceptance criteria ask for.
//
// The bug it catches (TV-001): Worktree-Auto-Promotion creates the destination
// worktree and "exits Phase 0 immediately", leaving the SOURCE root's registry
// entry and `session.lock` behind. `findPeers()` then reports the abandoned
// root as a live peer for `freshnessMin=15` minutes (`sweepZombies()` only
// reaps it after 60), and the destination's own `acquire()` lands while the
// source lock is still live — the double-live-UUID state the AC forbid.
//
// `tests/integration/worktree-auto-promotion.test.mjs` covers `enterWorktree`
// itself with a MOCKED `$`; the lifecycle either side of the call is untestable
// there for exactly that reason. This one runs real `git init` /
// `git worktree add` through the production zx path in a throwaway tmp repo.
// ---------------------------------------------------------------------------

const PROMOTION_SEMANTIC_ID = 'main-2026-08-28-deep-1';
const PROMOTION_SOURCE_RAW_ID = 'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa';
const PROMOTION_DEST_RAW_ID = 'bbbbbbbb-9999-4999-8999-bbbbbbbbbbbb';

describe('worktree promotion is a process boundary, not a live migration (#1069)', () => {
  let basePath;
  let sourceRoot;
  let warnSpy;
  const savedEnv = {};

  /** Run git in `cwd` with stdout captured. */
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(() => {
    // Isolate from the host: no global/system git config (hooksPath, templates,
    // user identity) and no real session registry.
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'SO_SESSION_REGISTRY_DIR']) {
      savedEnv[key] = process.env[key];
    }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';

    // realpath: macOS tmpdir is a /var → /private/var symlink and enterWorktree
    // resolves its basePath, so an unresolved path would fail the comparison.
    basePath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'so-two-root-')));
    process.env.SO_SESSION_REGISTRY_DIR = path.join(basePath, 'registry');

    sourceRoot = path.join(basePath, 'srcrepo');
    execFileSync('git', ['init', '-b', 'main', sourceRoot], { stdio: 'ignore' });
    git(sourceRoot, 'config', 'user.email', 'test@example.invalid');
    git(sourceRoot, 'config', 'user.name', 'Test');
    writeFileSync(path.join(sourceRoot, 'README.md'), '# fixture\n', 'utf8');
    git(sourceRoot, 'add', 'README.md');
    git(sourceRoot, 'commit', '--no-verify', '-m', 'init');

    // enterWorktree WARNs on fresh creation by contract — silence, do not assert.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(basePath, { recursive: true, force: true });
  });

  /** Source-session start: registry entry + owned lock + owner proof. */
  const startSourceSession = async () => {
    await registerSelf({
      sessionId: PROMOTION_SOURCE_RAW_ID,
      projectRoot: sourceRoot,
      semanticSessionId: PROMOTION_SEMANTIC_ID,
      branch: 'main',
      mode: 'deep',
    });
    const sourceLock = acquire({
      sessionId: PROMOTION_SOURCE_RAW_ID,
      mode: 'deep',
      repoRoot: sourceRoot,
      semanticSessionId: PROMOTION_SEMANTIC_ID,
      quiet: true,
    });
    expect(sourceLock.ok).toBe(true);
    expect(writeOwnerProof({ repoRoot: sourceRoot, lock: sourceLock.lock }).ok).toBe(true);
  };

  it('leaves no phantom peer and no second live lock behind in the source root', async () => {
    // -- 1. Source session start ---------------------------------------------
    await startSourceSession();

    // Premise check — the phantom IS visible before the switch. Without this
    // the assertions below could pass against an empty registry and prove nothing.
    const worktreeStubPre = async () => [
      { path: sourceRoot, branch: 'main', head: WORKTREE_HEAD },
    ];
    const before = await findPeers(sourceRoot, {
      mySessionId: PROMOTION_DEST_RAW_ID,
      listWorktreesImpl: worktreeStubPre,
    });
    expect(before.peers.map((p) => p.sessionId)).toContain(PROMOTION_SOURCE_RAW_ID);

    // -- 2. Worktree switch — real git through the production zx path ---------
    // ONE call (#1170): the departure is a mechanical step of enterWorktree,
    // not a second call the coordinator prose has to remember. The bug this
    // pins: revert the leaveSourceRoot() call inside enterWorktree and the
    // source lock + registry entry survive here, exactly as they did while the
    // teardown lived only in skill prose.
    const wt = await enterWorktree({
      basePath,
      sessionId: PROMOTION_SEMANTIC_ID,
      branch: 'main',
      repoRoot: sourceRoot,
      rawSessionId: PROMOTION_SOURCE_RAW_ID,
    });
    expect(wt.reused).toBe(false);
    // #1067: `main` is checked out by sourceRoot, so the promotion lands on so/<id>.
    expect(wt.branch).toBe(`so/${PROMOTION_SEMANTIC_ID}`);
    expect(wt.promotedFrom).toBe('main');
    expect(existsSync(path.join(wt.wtPath, '.git'))).toBe(true);

    // -- 3. The source root is already gone — no second call ------------------
    // The observable comes first deliberately: the phantom peer is the bug,
    // `wt.left.steps` is only the teardown's own report of it.
    const after = await findPeers(sourceRoot, {
      mySessionId: PROMOTION_DEST_RAW_ID,
      listWorktreesImpl: worktreeStubPre,
    });
    expect(after.peers.map((p) => p.sessionId)).not.toContain(PROMOTION_SOURCE_RAW_ID);
    expect(await readRegistry()).toEqual([]);
    expect(readLock({ repoRoot: sourceRoot })).toBeNull();
    // Full clean teardown carries NO `reason` key (leaveSourceRoot returns
    // `{ ok, steps }` then) — pinned exactly so a silently degraded departure
    // reported as success cannot pass here.
    expect(wt.left).toEqual({
      ok: true,
      steps: { deregistered: true, released: true, emitted: true },
    });

    // -- 4. Destination session start, with its OWN identity ------------------
    await registerSelf({
      sessionId: PROMOTION_DEST_RAW_ID,
      projectRoot: wt.wtPath,
      semanticSessionId: PROMOTION_SEMANTIC_ID,
      branch: wt.branch,
      mode: 'deep',
    });
    const destLock = acquire({
      sessionId: PROMOTION_DEST_RAW_ID,
      mode: 'deep',
      repoRoot: wt.wtPath,
      semanticSessionId: PROMOTION_SEMANTIC_ID,
      quiet: true,
    });
    expect(destLock.ok).toBe(true);

    // AC: at most ONE live lock + ONE registry entry per harness instance.
    expect(readLock({ repoRoot: sourceRoot })).toBeNull();
    expect(readLock({ repoRoot: wt.wtPath })?.session_id).toBe(PROMOTION_DEST_RAW_ID);
    expect((await readRegistry()).map((e) => e.session_id)).toEqual([PROMOTION_DEST_RAW_ID]);
  });

  it('creates the worktree but leaves a foreign source root untouched, without throwing', async () => {
    // The bug (TV-001): a promotion driven with the WRONG raw id must not tear
    // down a root it does not own — and must not abort the promotion either.
    // A throw here would strand the session between two roots; a silent
    // teardown would unregister a session that is still running in `sourceRoot`.
    await startSourceSession();

    const wt = await enterWorktree({
      basePath,
      sessionId: PROMOTION_SEMANTIC_ID,
      branch: 'main',
      repoRoot: sourceRoot,
      rawSessionId: PROMOTION_DEST_RAW_ID, // not the owner of sourceRoot's lock
    });

    // The promotion itself still succeeded.
    expect(wt.reused).toBe(false);
    expect(existsSync(path.join(wt.wtPath, '.git'))).toBe(true);

    // The departure did not happen, and says so.
    expect(wt.left.ok).toBe(false);
    expect(wt.left.reason.startsWith('lock-session-mismatch:')).toBe(true);
    expect(wt.left.reason).toBe(`lock-session-mismatch:${PROMOTION_SOURCE_RAW_ID}`);
    expect(wt.left.steps).toEqual({ deregistered: false, released: false, emitted: false });
    expect(warnSpy.mock.calls.flat().some(
      (m) => typeof m === 'string' && m.includes('enterWorktree: leaveSourceRoot: lock-session-mismatch:'),
    )).toBe(true);

    // The foreign root is exactly as it was.
    expect(readLock({ repoRoot: sourceRoot })?.session_id).toBe(PROMOTION_SOURCE_RAW_ID);
    expect((await readRegistry()).map((e) => e.session_id)).toEqual([PROMOTION_SOURCE_RAW_ID]);
  });

  it('refuses loudly when rawSessionId is passed but unusable, and stays silent when it is omitted', async () => {
    // The bug (TV-001): `if (typeof rawSessionId !== 'string' || !length) return`
    // treated NOT PASSED and PASSED-BUT-UNUSABLE as one case. The documented
    // derivation is `readLock({ repoRoot }).session_id`, which is `null` whenever
    // the source lock is missing or unreadable — so a real caller silently got
    // the pre-#1170 behaviour back: promotion succeeds, source root never
    // deregistered, phantom owner (#1069), nothing on stderr.
    await startSourceSession();

    const unusable = await enterWorktree({
      basePath,
      sessionId: PROMOTION_SEMANTIC_ID,
      branch: 'main',
      repoRoot: sourceRoot,
      rawSessionId: null, // what readLock() returns when the lock is unreadable
    });

    expect(unusable.reused).toBe(false);
    expect(existsSync(path.join(unusable.wtPath, '.git'))).toBe(true);
    expect(unusable.left).toEqual({ ok: false, reason: 'raw-session-id-unusable' });
    const unusableWarns = warnSpy.mock.calls.flat().filter(
      (m) => typeof m === 'string' && m.includes('enterWorktree: rawSessionId unusable'),
    );
    expect(unusableWarns).toHaveLength(1);
    expect(unusableWarns[0]).toContain('(null)');
    expect(unusableWarns[0]).toContain('readLock({ repoRoot }).session_id');

    // The source root is untouched — the refusal did not tear anything down.
    expect(readLock({ repoRoot: sourceRoot })?.session_id).toBe(PROMOTION_SOURCE_RAW_ID);
    expect((await readRegistry()).map((e) => e.session_id)).toEqual([PROMOTION_SOURCE_RAW_ID]);

    // And the OMITTED case stays byte-identical to pre-#1170: the autopilot
    // callers pass no rawSessionId at all and must not start seeing a WARN or a
    // `left` key. Pinning the SILENCE is the point — without it, "warn on
    // unusable" is one refactor away from warning on every autopilot worktree.
    warnSpy.mockClear();
    const omitted = await enterWorktree({
      basePath,
      sessionId: PROMOTION_SEMANTIC_ID,
      branch: 'main',
      repoRoot: sourceRoot,
    });
    expect(omitted.reused).toBe(true); // same path — created by the call above
    expect(omitted).not.toHaveProperty('left');
    expect(warnSpy.mock.calls.flat().some(
      (m) => typeof m === 'string' && m.includes('enterWorktree: rawSessionId unusable'),
    )).toBe(false);
  });

  it('reports the idempotent departure on the reused-worktree path', async () => {
    // The bug (TV-001): the reuse early-return skipped the teardown entirely
    // before #1170, so a re-entered promotion left the source root live. The
    // second call must still report a departure — `already-gone` when the
    // first call already removed everything.
    await startSourceSession();

    const first = await enterWorktree({
      basePath,
      sessionId: PROMOTION_SEMANTIC_ID,
      branch: 'main',
      repoRoot: sourceRoot,
      rawSessionId: PROMOTION_SOURCE_RAW_ID,
    });
    expect(first.reused).toBe(false);

    const second = await enterWorktree({
      basePath,
      sessionId: PROMOTION_SEMANTIC_ID,
      branch: 'main',
      repoRoot: sourceRoot,
      rawSessionId: PROMOTION_SOURCE_RAW_ID,
    });
    expect(second.reused).toBe(true);
    expect(second.wtPath).toBe(first.wtPath);
    expect(second.left).toEqual({
      ok: true,
      steps: { deregistered: false, released: false, emitted: true },
      reason: 'already-gone',
    });
    // And it does so QUIETLY. `already-gone` is the benign idempotent-rerun
    // outcome (ok: true), so it must not reach console.warn — a WARN here reads
    // like a failed teardown on a path where nothing failed, and would train
    // the operator to ignore the line that DOES matter
    // (`lock-session-mismatch:*`, pinned by the test above).
    expect(warnSpy.mock.calls.flat().some(
      (m) => typeof m === 'string' && m.includes('enterWorktree: leaveSourceRoot:'),
    )).toBe(false);
  });
});
