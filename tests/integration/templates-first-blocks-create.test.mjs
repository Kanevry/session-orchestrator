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

// No bare `expect` here: every assertion in this file goes through the shared
// decision helpers, which own the allow/deny contract (see the docblock above).
import { describe, it, afterEach } from 'vitest';
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
async function runHook({ projectDir, stdin, extraEnv = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
        SO_HOOK_PROFILE: 'full',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CHILD_SPAWN_TIMEOUT_MS,
    });
    spawnedChildren.push(child);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
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

  // Initialise as a git repo — the hook may resolve CWD via git
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;

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
