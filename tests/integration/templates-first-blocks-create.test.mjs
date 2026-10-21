/**
 * tests/integration/templates-first-blocks-create.test.mjs
 *
 * Integration tests for the pre-bash-templates-first hook (Pattern 3, issue #519).
 *
 * These tests spawn the hook as a subprocess against a real tmp git repo,
 * verifying the end-to-end blocking + allow behaviour exactly as Claude Code
 * would experience it at runtime.
 *
 * Scenarios:
 *   1. glab mr create blocked when .gitlab template present and no ack/Read
 *   2. glab mr create allowed when ack file present for current session
 *   3. gh pr create blocked when .github PR template present and no ack/Read
 *   4. gh issue new blocked when .github ISSUE_TEMPLATE present and no ack/Read
 *   5. Command with bypass_pattern passes through even with templates present
 *   6. No template files in repo → always pass through
 *
 * Decision contract (#906): a block is `exit 0` + a `hookSpecificOutput`
 * envelope on stdout — NOT `exit 2`, under which Claude Code discards stdout
 * and the operator sees only "hook error … No stderr output". Because BOTH
 * outcomes now exit 0, the exit code alone no longer discriminates: the deny
 * carries exactly one envelope line on stdout, the allow carries nothing.
 * expectDeny/expectAllow (tests/_helpers/hook-decision.mjs) assert that.
 */

import { describe, it, afterEach, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { expectDeny, expectAllow } from '../_helpers/hook-decision.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(REPO_ROOT, 'hooks', 'pre-bash-templates-first.mjs');

// Per-spawn watchdog ceiling: above the real hook runtime, below the per-test
// vitest timeout (20000ms here). Node SIGTERMs any hook subprocess that
// overruns so the fork-pool worker is never pinned alive past the test
// boundary by an orphan under CPU starvation.
const CHILD_SPAWN_TIMEOUT_MS = 17000;

// Track every spawned child so afterEach can SIGKILL any survivor.
let spawnedChildren = [];

/**
 * Minimal canonical policy — mirrors what Agent A plants at
 * .orchestrator/policy/templates-policy.json.
 */
const CANONICAL_POLICY = {
  version: 1,
  enforcement: 'block',
  hosts: {
    github: {
      template_paths: [
        '.github/PULL_REQUEST_TEMPLATE.md',
        '.github/ISSUE_TEMPLATE/',
      ],
    },
    gitlab: {
      template_paths: [
        '.gitlab/merge_request_templates/',
        '.gitlab/issue_templates/',
      ],
    },
  },
  bypass_patterns: [
    'gh pr create --dry-run',
    'gh pr create --help',
    'gh issue new --dry-run',
    'gh issue create --help',
    'glab mr create --dry-run',
    'glab mr create --help',
    'glab issue create --dry-run',
    'glab issue create --help',
  ],
  acknowledgement_file: '.orchestrator/runtime/templates-acknowledged.json',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook subprocess and return { code, stdout, stderr }.
 * Mirrors the exact runtime invocation Claude Code uses.
 *
 * A per-spawn `timeout` makes Node SIGTERM a child that overruns the watchdog
 * ceiling, and every child is tracked so afterEach can SIGKILL any survivor.
 */
function isolatedEnv(projectDir, extraEnv = {}) {
  const env = { ...process.env };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'SO_PLATFORM', 'PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CURSOR_RULES_DIR', 'PI_PLUGIN_ROOT']) {
    delete env[key];
  }
  return {
    ...env,
    HOME: projectDir,
    NAVIGATOR_CONFIG_DIR: path.join(projectDir, '.navigator-test-config'),
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PLUGIN_ROOT: REPO_ROOT,
    PLUGIN_ROOT: REPO_ROOT,
    SO_HOOK_PROFILE: 'full',
    ...extraEnv,
  };
}

async function runSubprocess({ projectDir, executable, args, stdin = '', extraEnv = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: projectDir,
      env: isolatedEnv(projectDir, extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CHILD_SPAWN_TIMEOUT_MS,
    });
    spawnedChildren.push(child);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // EPERM or another spawn failure must fail the test, never look like allow.
    child.on('error', reject);
    // EPIPE on stdin only means the child ended before consuming its input
    // (watchdog SIGTERM or a crash under CI load). The verdict then comes from
    // `close` with the real exit code or signal, not from the dangling write.
    child.stdin.on('error', (err) => {
      if (err?.code !== 'EPIPE') reject(err);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`hook subprocess ended by ${signal} (watchdog ${CHILD_SPAWN_TIMEOUT_MS} ms); stderr: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

async function runHook(opts) {
  return runSubprocess({ ...opts, executable: process.execPath, args: [HOOK] });
}

async function runAck(projectDir, extraEnv = {}, ancestorSessionId = null) {
  // Deterministic ps fixture for the real command's subprocess boundary. This
  // exercises Linux-style ppid/comm output, not native process measurement.
  const bin = path.join(projectDir, 'ack-test-bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'ps'), ancestorSessionId
    ? '#!/bin/sh\ncase "$2" in 424242) printf "1 claude\\n";; *) printf "424242 bash\\n";; esac\n'
    : '#!/bin/sh\nprintf "0 bash\\n"\n', { mode: 0o755 });
  if (ancestorSessionId) {
    const sessions = path.join(projectDir, '.claude', 'sessions');
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, '424242.json'), JSON.stringify({ sessionId: ancestorSessionId }));
  }
  const command = await fs.readFile(path.join(REPO_ROOT, 'commands', 'templates-ack.md'), 'utf8');
  const implementation = command.match(/## Implementation[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
  if (!implementation) throw new Error('Canonical templates-ack implementation block missing');
  // Execute the published Bash snippet itself, including its quoted node code.
  // This catches shell escaping and plugin-root imports from a consumer checkout.
  return runSubprocess({ projectDir, executable: 'bash', args: ['-c', implementation], extraEnv: {
    ...extraEnv, PATH: bin + path.delimiter + process.env.PATH,
  } });
}

async function writePeerSession(dir, sessionId) {
  await fs.writeFile(path.join(dir, '.orchestrator', 'current-session.json'), JSON.stringify({ session_id: sessionId }));
}

function withoutSessionPayload() {
  const payload = bashPayload('glab mr create --title foo');
  delete payload.session_id;
  return payload;
}

/**
 * Build a Bash hook payload.
 * @param {string} command
 * @param {string} [sessionId]
 */
function bashPayload(command, sessionId = 'integration-test-session-001') {
  return {
    session_id: sessionId,
    tool_name: 'Bash',
    tool_input: { command },
  };
}

/**
 * Create a fully-configured git repo in a tmp dir.
 * Plants the policy file and any requested template files.
 */
async function mkRepo({
  withGitlabMrTemplate = false,
  withGitlabIssueTemplate = false,
  withGithubPrTemplate = false,
  withGithubIssueTemplate = false,
  ackSessionId = null,
  policy = CANONICAL_POLICY,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tpl-first-int-'));
  await fs.mkdir(path.join(dir, '.navigator-test-config'));

  // Initialise as a git repo — the hook may resolve CWD via git
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
  ]) {
    const result = await runSubprocess({ projectDir: dir, executable: 'git', args });
    if (result.code !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
  }

  // Plant policy file
  const policyDir = path.join(dir, '.orchestrator', 'policy');
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, 'templates-policy.json'),
    JSON.stringify(policy, null, 2),
  );

  // GitLab MR template
  if (withGitlabMrTemplate) {
    const tplDir = path.join(dir, '.gitlab', 'merge_request_templates');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(
      path.join(tplDir, 'Default.md'),
      '## Summary\n\nDescribe your changes.\n\n## Test plan\n\nHow was this tested?\n',
    );
  }

  // GitLab issue template
  if (withGitlabIssueTemplate) {
    const tplDir = path.join(dir, '.gitlab', 'issue_templates');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(
      path.join(tplDir, 'Bug.md'),
      '## Steps to reproduce\n\n## Expected vs actual behaviour\n',
    );
  }

  // GitHub PR template
  if (withGithubPrTemplate) {
    const tplDir = path.join(dir, '.github');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(
      path.join(tplDir, 'PULL_REQUEST_TEMPLATE.md'),
      '## Changes\n\n## Why\n\n## Test plan\n',
    );
  }

  // GitHub issue template
  if (withGithubIssueTemplate) {
    const tplDir = path.join(dir, '.github', 'ISSUE_TEMPLATE');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(
      path.join(tplDir, 'bug_report.md'),
      '## Bug report\n\n## Steps\n',
    );
  }

  // Acknowledgement file — schema: { "<sessionId>": { acknowledgedAt: ISO } }
  if (ackSessionId !== null) {
    const runtimeDir = path.join(dir, '.orchestrator', 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, 'templates-acknowledged.json'),
      JSON.stringify({
        [ackSessionId]: {
          acknowledgedAt: '2026-05-22T10:00:00.000Z',
        },
      }),
    );
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(async () => {
  for (const child of spawnedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  spawnedChildren = [];
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkRepoTracked(opts) {
  const dir = await mkRepo(opts);
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Scenario 1 — glab mr create blocked (gitlab template present, no ack)
// ---------------------------------------------------------------------------

describe('glab mr create — gitlab MR template present, no ack', { timeout: 20000 }, () => {
  it('denies `glab mr create --title foo --description bar`', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo --description bar'),
    });
    expectDeny(result);
  });

  it('deny reason lists the template path (.gitlab/merge_request_templates/Default.md)', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    // Pre-#906 this rode on stderr under exit 2 — where Claude Code kept it but
    // the JSON envelope was discarded. The template list now travels inside
    // permissionDecisionReason, the only channel the operator actually sees.
    expectDeny(result, 'Default.md');
  });

  it('the deny reason contains the templates-ack bypass hint', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expectDeny(result, 'templates-ack');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — glab mr create allowed when ack file present
// ---------------------------------------------------------------------------

describe('glab mr create — ack file present for current session', { timeout: 20000 }, () => {
  it('allows (exit 0, empty stdout) when templates-acknowledged.json contains the current session_id', async () => {
    const sessionId = 'integration-ack-session-xyz';
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      ackSessionId: sessionId,
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', sessionId),
    });
    // Empty stdout is the allow signal — exit 0 alone would also pass on a deny.
    expectAllow(result);
  });

  it('denies when ack file exists but records a different session_id', async () => {
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      ackSessionId: 'old-session-from-yesterday',
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', 'current-session-not-acked'),
    });
    expectDeny(result);
  });
});

describe('process-local acknowledgement identity', { timeout: 60000 }, () => {
  const own = 'own-session-a';
  const peer = 'peer-session-b';
  const nativeOwn = { SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: own };

  it('a: canonical command acknowledges only its own native ID in a shared checkout', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    await writePeerSession(dir, peer);
    const result = await runAck(dir, nativeOwn, own);
    expect(result.code, result.stderr).toBe(0);
    const ack = JSON.parse(await fs.readFile(path.join(dir, '.orchestrator/runtime/templates-acknowledged.json'), 'utf8'));
    expect(Object.keys(ack)).toEqual([own]);
    expect(ack[own].acknowledgedAt).toEqual(expect.any(String));
    expectAllow(await runHook({ projectDir: dir, stdin: bashPayload('glab mr create --title foo', own), extraEnv: nativeOwn }));
    expectDeny(await runHook({ projectDir: dir, stdin: bashPayload('glab mr create --title foo', peer), extraEnv: nativeOwn }));
  });

  it('b: canonical command refuses unknown identity without creating an ack', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    await writePeerSession(dir, peer);
    const result = await runAck(dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/templates-ack.*(?:identity|session|ID)/i);
    await expect(fs.access(path.join(dir, '.orchestrator/runtime/templates-acknowledged.json'))).rejects.toThrow();
  });

  it.each([false, true])('refuses inherited parent env identity; preserves parent ack (existing=%s)', async (existing) => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true, ...(existing ? { ackSessionId: peer } : {}) });
    const ackFile = path.join(dir, '.orchestrator/runtime/templates-acknowledged.json');
    const before = existing ? await fs.readFile(ackFile, 'utf8') : null;
    const result = await runAck(dir, { SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: peer }, own);
    expect(result.code, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('session id does not come from this invocation');
    if (existing) expect(await fs.readFile(ackFile, 'utf8')).toBe(before);
    else await expect(fs.access(ackFile)).rejects.toThrow();
    if (!existing) expectDeny(await runHook({ projectDir: dir, stdin: bashPayload('glab mr create --title foo', peer) }));
  });

  it('refuses an env identity when the process ancestry is not measurable', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runAck(dir, nativeOwn);
    expect(result.code, result.stderr).not.toBe(0);
    await expect(fs.access(path.join(dir, '.orchestrator/runtime/templates-acknowledged.json'))).rejects.toThrow();
  });

  it('acknowledges the nearest Claude invocation when env identity is absent', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runAck(dir, {}, own);
    expect(result.code, result.stderr).toBe(0);
    const ack = JSON.parse(await fs.readFile(path.join(dir, '.orchestrator/runtime/templates-acknowledged.json'), 'utf8'));
    expect(Object.keys(ack)).toEqual([own]);
    expectAllow(await runHook({ projectDir: dir, stdin: bashPayload('glab mr create --title foo', own) }));
    expectDeny(await runHook({ projectDir: dir, stdin: bashPayload('glab mr create --title foo', peer) }));
  });

  it('b: canonical command leaves an existing peer ack byte-identical when identity is missing', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true, ackSessionId: peer });
    await writePeerSession(dir, peer);
    const ackFile = path.join(dir, '.orchestrator/runtime/templates-acknowledged.json');
    const before = await fs.readFile(ackFile, 'utf8');
    const result = await runAck(dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/templates-ack.*(?:identity|session|ID)/i);
    expect(await fs.readFile(ackFile, 'utf8')).toBe(before);
  });

  it('b: conflicting native IDs without an explicit platform cannot acknowledge either session', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    await writePeerSession(dir, peer);
    const extraEnv = { CLAUDE_CODE_SESSION_ID: own, CODEX_THREAD_ID: peer };
    const result = await runAck(dir, extraEnv);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/templates-ack.*(?:identity|session|ID)/i);
    await expect(fs.access(path.join(dir, '.orchestrator/runtime/templates-acknowledged.json'))).rejects.toThrow();
  });

  it('c: hook without stdin or native identity cannot use a shared peer ack', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true, ackSessionId: peer });
    await writePeerSession(dir, peer);
    expectDeny(await runHook({ projectDir: dir, stdin: withoutSessionPayload() }));
  });

  it('c: stdin identity takes precedence over an inherited peer environment ID', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true, ackSessionId: peer });
    await writePeerSession(dir, peer);
    expectDeny(await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', own),
      extraEnv: { SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: peer },
    }));
  });

  it('c: parent_session_id alone cannot authorize the child using its parent ack', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true, ackSessionId: peer });
    const payload = withoutSessionPayload();
    payload.parent_session_id = peer;
    expectDeny(await runHook({ projectDir: dir, stdin: payload, extraEnv: { SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: peer } }));
    payload.session_id = own;
    expectDeny(await runHook({ projectDir: dir, stdin: payload }));
  });

  it('c: missing stdin identity cannot use an inherited peer env ID and ack', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true, ackSessionId: peer });
    await writePeerSession(dir, peer);
    expectDeny(await runHook({
      projectDir: dir,
      stdin: withoutSessionPayload(),
      extraEnv: { SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: peer },
    }));
  });

  it('c: missing stdin identity also denies when native env names an acknowledged own session', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true, ackSessionId: own });
    await writePeerSession(dir, peer);
    expectDeny(await runHook({ projectDir: dir, stdin: withoutSessionPayload(), extraEnv: nativeOwn }));
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — gh pr create blocked (github PR template present, no ack)
// ---------------------------------------------------------------------------

describe('gh pr create — github PR template present, no ack', { timeout: 20000 }, () => {
  it('denies `gh pr create --title "my PR" --body "changes"`', async () => {
    const dir = await mkRepoTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title "my PR" --body "changes"'),
    });
    expectDeny(result);
  });

  it('deny reason lists the template path (PULL_REQUEST_TEMPLATE.md)', async () => {
    const dir = await mkRepoTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title "my PR"'),
    });
    expectDeny(result, 'PULL_REQUEST_TEMPLATE.md');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — gh issue new blocked (github issue template present, no ack)
// ---------------------------------------------------------------------------

describe('gh issue new — github issue template present, no ack', { timeout: 20000 }, () => {
  it('denies `gh issue new --title "bug" --body "desc"`', async () => {
    const dir = await mkRepoTracked({ withGithubIssueTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh issue new --title "bug" --body "desc"'),
    });
    expectDeny(result);
  });

  it('deny reason lists the issue template path (ISSUE_TEMPLATE/bug_report.md)', async () => {
    const dir = await mkRepoTracked({ withGithubIssueTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh issue new --title "bug"'),
    });
    expectDeny(result, 'bug_report.md');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — bypass_pattern from policy passes through even with templates
// ---------------------------------------------------------------------------

describe('bypass_pattern — always passes through', { timeout: 20000 }, () => {
  it('allows `glab mr create --dry-run` when --dry-run is in bypass_patterns', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --dry-run --title foo'),
    });
    expectAllow(result);
  });

  it('allows `gh pr create --help` when --help is in bypass_patterns', async () => {
    const dir = await mkRepoTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --help'),
    });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — no template files → always allow (nothing to enforce)
// ---------------------------------------------------------------------------

describe('no template files present → always allow', { timeout: 20000 }, () => {
  it('allows `glab mr create` when no .gitlab/merge_request_templates/ exists', async () => {
    // Policy present but no templates in the repo
    const dir = await mkRepoTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expectAllow(result);
  });

  it('allows `gh pr create` when no .github/PULL_REQUEST_TEMPLATE.md exists', async () => {
    const dir = await mkRepoTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title my-pr'),
    });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — both gitlab + github templates present, command matches gitlab
// ---------------------------------------------------------------------------

describe('multiple template directories present', { timeout: 20000 }, () => {
  it('denies `glab mr create` when both gitlab and github templates exist', async () => {
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      withGithubPrTemplate: true,
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expectDeny(result);
  });

  it('deny reason for glab lists at least the gitlab template (not only github)', async () => {
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      withGithubPrTemplate: true,
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expectDeny(result, 'Default.md');
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — ack file persists for the session (written by prior ack)
// ---------------------------------------------------------------------------

describe('ack file written by hook persists for session', { timeout: 20000 }, () => {
  it('second run with same session_id is still allowed after ack', async () => {
    const sessionId = 'reuse-ack-session-abc';
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      ackSessionId: sessionId,
    });

    // First run — allowed
    const first = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', sessionId),
    });
    expectAllow(first);

    // Second run in same session — ack file still present, still allowed
    const second = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title bar', sessionId),
    });
    expectAllow(second);
  });
});
