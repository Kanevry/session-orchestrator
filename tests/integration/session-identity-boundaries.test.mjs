/**
 * Cross-surface identity boundary: SessionStart -> peer discovery -> issue budget.
 *
 * The records under test are written by the real SessionStart and registry
 * producers. The one altered record retains that emitted shape and changes only
 * its raw id, modelling a stale/foreign current-session binding.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expectAllow } from '../_helpers/hook-decision.mjs';
import { budgetStatePath } from '../../scripts/lib/issue-budget.mjs';

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
