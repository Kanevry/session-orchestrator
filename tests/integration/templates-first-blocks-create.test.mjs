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
 * Design note: tests will be RED until Agent A commits
 * hooks/pre-bash-templates-first.mjs and .orchestrator/policy/templates-policy.json.
 * This is expected per the wave plan.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(REPO_ROOT, 'hooks', 'pre-bash-templates-first.mjs');

/**
 * Minimal canonical policy — mirrors what Agent A plants at
 * .orchestrator/policy/templates-policy.json.
 */
const CANONICAL_POLICY = {
  version: 1,
  hosts: ['github', 'gitlab'],
  bypass_patterns: ['--dry-run', '--help'],
  template_globs: [
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/PULL_REQUEST_TEMPLATE/*.md',
    '.github/ISSUE_TEMPLATE/*.md',
    '.gitlab/merge_request_templates/*.md',
    '.gitlab/issue_templates/*.md',
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook subprocess and return { code, stdout, stderr }.
 * Mirrors the exact runtime invocation Claude Code uses.
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
    });

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

  // Acknowledgement file
  if (ackSessionId !== null) {
    const runtimeDir = path.join(dir, '.orchestrator', 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, 'templates-acknowledged.json'),
      JSON.stringify({
        sessionId: ackSessionId,
        acknowledgedAt: '2026-05-22T10:00:00.000Z',
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
  it('exits 2 (blocked) for `glab mr create --title foo --description bar`', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo --description bar'),
    });
    expect(result.code).toBe(2);
  });

  it('stderr lists the template path (.gitlab/merge_request_templates/Default.md)', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.stderr).toContain('Default.md');
  });

  it('stderr contains the templates-ack bypass hint', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.stderr).toContain('templates-ack');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — glab mr create allowed when ack file present
// ---------------------------------------------------------------------------

describe('glab mr create — ack file present for current session', { timeout: 20000 }, () => {
  it('exits 0 when templates-acknowledged.json contains the current session_id', async () => {
    const sessionId = 'integration-ack-session-xyz';
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      ackSessionId: sessionId,
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', sessionId),
    });
    expect(result.code).toBe(0);
  });

  it('exits 2 when ack file exists but records a different session_id', async () => {
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      ackSessionId: 'old-session-from-yesterday',
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', 'current-session-not-acked'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — gh pr create blocked (github PR template present, no ack)
// ---------------------------------------------------------------------------

describe('gh pr create — github PR template present, no ack', { timeout: 20000 }, () => {
  it('exits 2 (blocked) for `gh pr create --title "my PR" --body "changes"`', async () => {
    const dir = await mkRepoTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title "my PR" --body "changes"'),
    });
    expect(result.code).toBe(2);
  });

  it('stderr lists the template path (PULL_REQUEST_TEMPLATE.md)', async () => {
    const dir = await mkRepoTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title "my PR"'),
    });
    expect(result.stderr).toContain('PULL_REQUEST_TEMPLATE.md');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — gh issue new blocked (github issue template present, no ack)
// ---------------------------------------------------------------------------

describe('gh issue new — github issue template present, no ack', { timeout: 20000 }, () => {
  it('exits 2 (blocked) for `gh issue new --title "bug" --body "desc"`', async () => {
    const dir = await mkRepoTracked({ withGithubIssueTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh issue new --title "bug" --body "desc"'),
    });
    expect(result.code).toBe(2);
  });

  it('stderr lists the issue template path (ISSUE_TEMPLATE/bug_report.md)', async () => {
    const dir = await mkRepoTracked({ withGithubIssueTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh issue new --title "bug"'),
    });
    expect(result.stderr).toContain('bug_report.md');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — bypass_pattern from policy passes through even with templates
// ---------------------------------------------------------------------------

describe('bypass_pattern — always passes through', { timeout: 20000 }, () => {
  it('exits 0 for `glab mr create --dry-run` when --dry-run is in bypass_patterns', async () => {
    const dir = await mkRepoTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --dry-run --title foo'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 for `gh pr create --help` when --help is in bypass_patterns', async () => {
    const dir = await mkRepoTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --help'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — no template files → always allow (nothing to enforce)
// ---------------------------------------------------------------------------

describe('no template files present → always allow', { timeout: 20000 }, () => {
  it('exits 0 for `glab mr create` when no .gitlab/merge_request_templates/ exists', async () => {
    // Policy present but no templates in the repo
    const dir = await mkRepoTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 for `gh pr create` when no .github/PULL_REQUEST_TEMPLATE.md exists', async () => {
    const dir = await mkRepoTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title my-pr'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — both gitlab + github templates present, command matches gitlab
// ---------------------------------------------------------------------------

describe('multiple template directories present', { timeout: 20000 }, () => {
  it('exits 2 for `glab mr create` when both gitlab and github templates exist', async () => {
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      withGithubPrTemplate: true,
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.code).toBe(2);
  });

  it('stderr for glab lists at least the gitlab template (not only github)', async () => {
    const dir = await mkRepoTracked({
      withGitlabMrTemplate: true,
      withGithubPrTemplate: true,
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.stderr).toContain('Default.md');
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — ack file persists for the session (written by prior ack)
// ---------------------------------------------------------------------------

describe('ack file written by hook persists for session', { timeout: 20000 }, () => {
  it('second run with same session_id still exits 0 after ack', async () => {
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
    expect(first.code).toBe(0);

    // Second run in same session — ack file still present, still allowed
    const second = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title bar', sessionId),
    });
    expect(second.code).toBe(0);
  });
});
