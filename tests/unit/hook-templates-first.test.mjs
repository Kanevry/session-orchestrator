/**
 * tests/unit/hook-templates-first.test.mjs
 *
 * Vitest unit tests for hooks/pre-bash-templates-first.mjs (Pattern 3, issue #519).
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin, assert exit
 * code and stderr for each behavioural case. The real hook binary is used —
 * no mocking of production logic.
 *
 * Design note: the hook does not exist yet when this file is first committed
 * (Agent A implements it in parallel). Tests will be RED until Agent A's
 * commit lands. This is expected per the wave plan.
 *
 * Hook input schema (from hooks/pre-bash-destructive-guard.mjs and
 * hooks/on-stop.mjs observation):
 *   { session_id: string, tool_name: string, tool_input: { command: string } }
 *
 * Exit-code contract (mirrors destructive-guard):
 *   0  — allow (pass-through)
 *   2  — block (no Read, no ack)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/pre-bash-templates-first.mjs');

/**
 * Minimal templates-policy fixture.
 * Mirrors the expected schema from the PRD technical notes — host allow-list
 * plus bypass_patterns array.
 */
const FIXTURE_POLICY = {
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
 * Spawn the hook, pipe stdin JSON, collect stdout/stderr, resolve with exit code.
 */
async function runHook({ projectDir, stdin, extraEnv = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PLUGIN_ROOT: path.resolve(import.meta.dirname, '../..'),
        // Disable profile gate (so full profile runs in tests)
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
 * Build a standard Bash hook payload.
 * @param {string} command
 * @param {string} [sessionId]
 */
function bashPayload(command, sessionId = 'test-session-001') {
  return { session_id: sessionId, tool_name: 'Bash', tool_input: { command } };
}

/**
 * Build a non-Bash hook payload (Edit tool).
 */
function nonBashPayload() {
  return { session_id: 'test-session-001', tool_name: 'Edit', tool_input: { file_path: 'README.md' } };
}

/**
 * Create a temporary project dir with:
 *   - .orchestrator/policy/templates-policy.json
 *   - optionally a .gitlab/merge_request_templates/Default.md
 *   - optionally a .github/PULL_REQUEST_TEMPLATE.md
 *   - optionally a .github/ISSUE_TEMPLATE/bug.md
 *   - optionally .orchestrator/runtime/templates-acknowledged.json
 */
async function mkProject({
  policy = FIXTURE_POLICY,
  withGitlabMrTemplate = false,
  withGithubPrTemplate = false,
  withGithubIssueTemplate = false,
  ackSessionId = null,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tpl-first-test-'));

  // Policy file
  const policyDir = path.join(dir, '.orchestrator', 'policy');
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, 'templates-policy.json'),
    JSON.stringify(policy, null, 2),
  );

  // Optional template files
  if (withGitlabMrTemplate) {
    const tplDir = path.join(dir, '.gitlab', 'merge_request_templates');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(
      path.join(tplDir, 'Default.md'),
      '## Summary\n\n## Test plan\n',
    );
  }

  if (withGithubPrTemplate) {
    const tplDir = path.join(dir, '.github');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(
      path.join(tplDir, 'PULL_REQUEST_TEMPLATE.md'),
      '## Changes\n\n## Why\n',
    );
  }

  if (withGithubIssueTemplate) {
    const tplDir = path.join(dir, '.github', 'ISSUE_TEMPLATE');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(path.join(tplDir, 'bug.md'), '## Bug report\n');
  }

  // Optional acknowledgement file — schema: { "<sessionId>": { acknowledgedAt: ISO } }
  if (ackSessionId !== null) {
    const runtimeDir = path.join(dir, '.orchestrator', 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, 'templates-acknowledged.json'),
      JSON.stringify({ [ackSessionId]: { acknowledgedAt: '2026-05-22T10:00:00.000Z' } }),
    );
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Temp dir cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectTracked(opts) {
  const dir = await mkProject(opts);
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// G1 — tool filter: non-Bash tools pass through immediately
// ---------------------------------------------------------------------------

describe('tool filter', { timeout: 15000 }, () => {
  it('exits 0 for a non-Bash tool call (Edit)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({ projectDir: dir, stdin: nonBashPayload() });
    expect(result.code).toBe(0);
  });

  it('exits 0 for a non-Bash tool call (Write)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const payload = { session_id: 'test-session-001', tool_name: 'Write', tool_input: { file_path: 'foo.md', content: 'x' } };
    const result = await runHook({ projectDir: dir, stdin: payload });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G2 — regex: only create/new verbs trigger blocking
// ---------------------------------------------------------------------------

describe('regex matching — pass-through commands', { timeout: 15000 }, () => {
  it('exits 0 for `ls` (unrelated command)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls -la'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 for `gh release create` (different subcommand — not pr/mr/issue)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh release create v1.0.0 --notes "initial"'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 for `glab mr list` (list verb — not create/new)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr list --state opened'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 for `glab mr view` (view verb — not create/new)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr view 42'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 for `git push origin main` (git not gh/glab)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push origin main'),
    });
    expect(result.code).toBe(0);
  });
});

describe('regex matching — blocking commands (no ack, no prior Read)', { timeout: 15000 }, () => {
  it('exits 2 for `glab mr create --title foo` with gitlab template present', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo --description bar'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for `gh pr create` with github PR template present', async () => {
    const dir = await mkProjectTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title "my PR" --body "changes"'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for `gh issue new` (issue create verb) with github issue template present', async () => {
    const dir = await mkProjectTracked({ withGithubIssueTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh issue new --title "bug" --body "desc"'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for `glab issue create` with gitlab template present', async () => {
    // Provide a gitlab issue template to trigger the block
    const dir = await mkProjectTracked();
    const tplDir = path.join(dir, '.gitlab', 'issue_templates');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(path.join(tplDir, 'Bug.md'), '## Steps to reproduce\n');
    tmpDirs.push(dir); // ensure cleanup (mkProjectTracked already pushed, double-guard fine)
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "broken thing"'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for a command with leading whitespace: `  glab mr create --title foo`', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('  glab mr create --title foo'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for command embedded after redirect: `glab mr create --title foo 2>&1`', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo 2>&1 | tee output.log'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// G3 — blocking message content checks
// ---------------------------------------------------------------------------

describe('block message content', { timeout: 15000 }, () => {
  it('stderr contains the template path when blocking `glab mr create`', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.stderr).toContain('Default.md');
  });

  it('stderr contains acknowledgement bypass hint when blocking', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    // Per Gherkin: "schreibe '/templates-ack' für Bypass"
    expect(result.stderr).toContain('templates-ack');
  });

  it('stderr contains the template path when blocking `gh pr create`', async () => {
    const dir = await mkProjectTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title "my PR"'),
    });
    expect(result.stderr).toContain('PULL_REQUEST_TEMPLATE.md');
  });
});

// ---------------------------------------------------------------------------
// G4 — acknowledgement bypass
// ---------------------------------------------------------------------------

describe('acknowledgement bypass', { timeout: 15000 }, () => {
  it('exits 0 when ack file contains the current session_id', async () => {
    const sessionId = 'session-ack-test-001';
    const dir = await mkProjectTracked({
      withGitlabMrTemplate: true,
      ackSessionId: sessionId,
    });
    const result = await runHook({
      projectDir: dir,
      sessionId,
      stdin: bashPayload('glab mr create --title foo', sessionId),
    });
    expect(result.code).toBe(0);
  });

  it('exits 2 when ack file exists but session_id does not match', async () => {
    // Ack file records a different session; current session has no ack
    const dir = await mkProjectTracked({
      withGitlabMrTemplate: true,
      ackSessionId: 'session-from-previous-run',
    });
    const result = await runHook({
      projectDir: dir,
      sessionId: 'session-current-unacked',
      stdin: bashPayload('glab mr create --title foo', 'session-current-unacked'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 when ack file is entirely absent', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    // No ackSessionId set — file does not exist
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// G5 — bypass_patterns from templates-policy.json
// ---------------------------------------------------------------------------

describe('bypass_patterns from policy', { timeout: 15000 }, () => {
  it('exits 0 when command matches a bypass_pattern (--dry-run)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --dry-run --title foo'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when command matches a bypass_pattern (--help)', async () => {
    const dir = await mkProjectTracked({ withGithubPrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --help'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G6 — no templates in repo → pass through (only blocks when templates exist)
// ---------------------------------------------------------------------------

describe('no templates found → allow', { timeout: 15000 }, () => {
  it('exits 0 for `glab mr create` when no template files exist in the repo', async () => {
    // Policy present but NO template directories/files planted
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 for `gh pr create` when no template files exist in the repo', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh pr create --title my-pr'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G7 — error handling: fail-open on malformed/missing stdin
// ---------------------------------------------------------------------------

describe('error handling — fail-open', { timeout: 15000 }, () => {
  it('exits 0 (fail-open) when stdin JSON is malformed', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: 'not valid json {',
    });
    // Fail-open: hook must not crash the session on malformed input
    expect(result.code).toBe(0);
  });

  it('exits 0 (fail-open) when stdin is empty', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      stdin: '',
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when policy file is absent (fail-open — no templates-policy.json)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    // Remove the policy file that mkProject created
    await fs.rm(path.join(dir, '.orchestrator', 'policy', 'templates-policy.json'));
    // Override CLAUDE_PLUGIN_ROOT to the tmp dir so the impl's pluginRoot
    // fallback cannot resolve to the real session-orchestrator policy.
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
      extraEnv: { CLAUDE_PLUGIN_ROOT: dir },
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when policy JSON is malformed (fail-open)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'policy', 'templates-policy.json'),
      'not-valid-json {',
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G8 — profile gate: SO_DISABLED_HOOKS disables this hook
// ---------------------------------------------------------------------------

describe('profile gate', { timeout: 15000 }, () => {
  it('exits 0 (skip) when SO_DISABLED_HOOKS includes pre-bash-templates-first', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      extraEnv: { SO_DISABLED_HOOKS: 'pre-bash-templates-first' },
      stdin: bashPayload('glab mr create --title foo'),
    });
    // Hook is disabled — should pass through without blocking
    expect(result.code).toBe(0);
  });

  it('exits 0 (skip) when SO_HOOK_PROFILE is "off"', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const result = await runHook({
      projectDir: dir,
      extraEnv: { SO_HOOK_PROFILE: 'off' },
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helper: write a transcript JSONL file with specific tool_use records
// ---------------------------------------------------------------------------

/**
 * Write a minimal transcript JSONL file and return its absolute path.
 * Each entry in `toolUses` produces one assistant record.
 *
 * @param {string} dir   Directory to write the file in (already tracked for cleanup)
 * @param {Array<{name: string, input: object}>} toolUses
 * @returns {Promise<string>}  Absolute path to the JSONL file
 */
async function writeTranscript(dir, toolUses) {
  const lines = toolUses.map((tu) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: tu.name, input: tu.input }],
      },
    }),
  );
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  await fs.writeFile(transcriptPath, lines.join('\n') + '\n');
  return transcriptPath;
}

// ---------------------------------------------------------------------------
// Group A — G7 transcript-history HAPPY PATH (the critical missing case)
// ---------------------------------------------------------------------------

describe('G7 transcript-history happy path', { timeout: 15000 }, () => {
  it('exits 0 when transcript shows prior Read of GitLab MR template', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const transcriptPath = await writeTranscript(dir, [
      { name: 'Bash', input: { command: 'ls -la' } },
      { name: 'Read', input: { file_path: path.join(dir, '.gitlab', 'merge_request_templates', 'Default.md') } },
    ]);
    const stdin = {
      session_id: 'g7-test',
      tool_name: 'Bash',
      tool_input: { command: 'glab mr create --title foo' },
      transcript_path: transcriptPath,
    };
    const result = await runHook({ projectDir: dir, stdin });
    expect(result.code).toBe(0);
  });

  it('stderr does not contain templates-ack when transcript shows prior Read', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const transcriptPath = await writeTranscript(dir, [
      { name: 'Read', input: { file_path: path.join(dir, '.gitlab', 'merge_request_templates', 'Default.md') } },
    ]);
    const stdin = {
      session_id: 'g7-test-2',
      tool_name: 'Bash',
      tool_input: { command: 'glab mr create --title foo' },
      transcript_path: transcriptPath,
    };
    const result = await runHook({ projectDir: dir, stdin });
    expect(result.stderr).not.toContain('templates-ack');
  });

  it('exits 2 (deny) when transcript_path file does not exist', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const stdin = {
      session_id: 'g7-nonexistent',
      tool_name: 'Bash',
      tool_input: { command: 'glab mr create --title foo' },
      transcript_path: '/nonexistent/path/transcript.jsonl',
    };
    const result = await runHook({ projectDir: dir, stdin });
    expect(result.code).toBe(2);
  });

  it('exits 2 (deny) when transcript has no prior Read tool_use — only Bash entries', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const transcriptPath = await writeTranscript(dir, [
      { name: 'Bash', input: { command: 'ls -la' } },
      { name: 'Bash', input: { command: 'git status' } },
    ]);
    const stdin = {
      session_id: 'g7-no-read',
      tool_name: 'Bash',
      tool_input: { command: 'glab mr create --title foo' },
      transcript_path: transcriptPath,
    };
    const result = await runHook({ projectDir: dir, stdin });
    expect(result.code).toBe(2);
  });

  it('exits 2 (deny) when transcript has Read of a DIFFERENT file (not a template path)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const transcriptPath = await writeTranscript(dir, [
      { name: 'Read', input: { file_path: '/some/other/file.md' } },
    ]);
    const stdin = {
      session_id: 'g7-wrong-read',
      tool_name: 'Bash',
      tool_input: { command: 'glab mr create --title foo' },
      transcript_path: transcriptPath,
    };
    const result = await runHook({ projectDir: dir, stdin });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Group B — enforcement: 'off' branch
// ---------------------------------------------------------------------------

describe('enforcement: off', { timeout: 15000 }, () => {
  it('exits 0 when policy enforcement is "off" regardless of template presence or transcript', async () => {
    const offPolicy = { ...FIXTURE_POLICY, enforcement: 'off' };
    const dir = await mkProjectTracked({
      policy: offPolicy,
      withGitlabMrTemplate: true,
    });
    // No transcript_path — would normally block under 'block' enforcement
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group C — malformed / edge-case ack JSON
// ---------------------------------------------------------------------------

describe('malformed ack JSON variants', { timeout: 15000 }, () => {
  it('exits 2 when ack file is malformed JSON (syntax error)', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    // Plant a corrupt ack file
    const runtimeDir = path.join(dir, '.orchestrator', 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, 'templates-acknowledged.json'),
      'not valid json {',
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', 'test-session-001'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 when ack entry exists but lacks acknowledgedAt field', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const runtimeDir = path.join(dir, '.orchestrator', 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    // Entry exists but schema is incomplete — no acknowledgedAt
    await fs.writeFile(
      path.join(runtimeDir, 'templates-acknowledged.json'),
      JSON.stringify({ 'test-session-001': { userId: 'alice' } }),
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', 'test-session-001'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 when ack file has no entry for the current session_id', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const runtimeDir = path.join(dir, '.orchestrator', 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    // Different session recorded — current session is not in the file
    await fs.writeFile(
      path.join(runtimeDir, 'templates-acknowledged.json'),
      JSON.stringify({ 'other-session-002': { acknowledgedAt: '2026-05-22T10:00:00Z' } }),
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', 'test-session-new'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 0 when ack JSON has a valid entry (with acknowledgedAt) for the current session', async () => {
    const dir = await mkProjectTracked({ withGitlabMrTemplate: true });
    const runtimeDir = path.join(dir, '.orchestrator', 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, 'templates-acknowledged.json'),
      JSON.stringify({ 'test-session-ok': { acknowledgedAt: '2026-05-22T10:00:00Z' } }),
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title foo', 'test-session-ok'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group D — .yml / .yaml template recognition (W2-A4 addition)
// ---------------------------------------------------------------------------

describe('.yml / .yaml template recognition', { timeout: 15000 }, () => {
  it('exits 2 (denies create) when only .yml template exists (GitHub form template)', async () => {
    const dir = await mkProjectTracked();
    // Plant a .yml issue template (GitHub form templates use .yml not .md)
    const tplDir = path.join(dir, '.github', 'ISSUE_TEMPLATE');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(path.join(tplDir, 'bug.yml'), 'name: Bug Report\n');
    // No transcript_path — no prior Read
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh issue create --title foo'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 0 when transcript shows prior Read of .yml template file', async () => {
    const dir = await mkProjectTracked();
    const tplDir = path.join(dir, '.github', 'ISSUE_TEMPLATE');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(path.join(tplDir, 'bug.yml'), 'name: Bug Report\n');
    const ymlTemplatePath = path.join(tplDir, 'bug.yml');
    const transcriptPath = await writeTranscript(dir, [
      { name: 'Read', input: { file_path: ymlTemplatePath } },
    ]);
    const stdin = {
      session_id: 'yml-read-test',
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --title foo' },
      transcript_path: transcriptPath,
    };
    const result = await runHook({ projectDir: dir, stdin });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group E — bypass-pattern leading whitespace symmetric strip (W2-A4 addition)
// ---------------------------------------------------------------------------

describe('bypass-pattern leading whitespace symmetric strip', { timeout: 15000 }, () => {
  it('exits 0 when bypass_pattern has leading whitespace in the policy', async () => {
    // Policy bypass entry has leading spaces — matchesBypass() should strip and still match.
    // Use a create-verb command so the regex gate fires and bypass is the only exit-0 path.
    const policyWithPaddedPattern = {
      ...FIXTURE_POLICY,
      bypass_patterns: ['  glab mr create --title bypass-test'],
    };
    const dir = await mkProjectTracked({
      policy: policyWithPaddedPattern,
      withGitlabMrTemplate: true,
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab mr create --title bypass-test'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when command has leading whitespace and the bypass_pattern does not', async () => {
    const policyWithPattern = {
      ...FIXTURE_POLICY,
      bypass_patterns: ['glab mr create --title bypass-test'],
    };
    const dir = await mkProjectTracked({
      policy: policyWithPattern,
      withGitlabMrTemplate: true,
    });
    // Command sent with leading whitespace — hook should strip and still match bypass
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('  glab mr create --title bypass-test'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group F — policy resolution priority (cwd > projectDir)
// ---------------------------------------------------------------------------

describe('policy resolution priority — cwd wins over projectDir', { timeout: 15000 }, () => {
  it('exits 0 when cwd policy sets enforcement "off" even though CLAUDE_PROJECT_DIR policy has enforcement "block"', async () => {
    // Strategy: cwd policy = 'off' → hook exits 0 (allow).
    // CLAUDE_PROJECT_DIR policy = 'block' → would exit 2 if it were used.
    // If the hook incorrectly picks the projectDir policy, the test would fail (exit 2).
    // We use bypass_patterns:[] so there is no bypass shortcut that could mask the result.

    // Outer projectDir has block enforcement
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tpl-pdir-'));
    tmpDirs.push(projectDir);

    const projectPolicyDir = path.join(projectDir, '.orchestrator', 'policy');
    await fs.mkdir(projectPolicyDir, { recursive: true });
    await fs.writeFile(
      path.join(projectPolicyDir, 'templates-policy.json'),
      JSON.stringify({ ...FIXTURE_POLICY, enforcement: 'block', bypass_patterns: [] }, null, 2),
    );

    // cwd subdir has enforcement 'off' — should win in resolution order
    const cwdDir = path.join(projectDir, 'subproject');
    await fs.mkdir(cwdDir, { recursive: true });

    const cwdPolicyDir = path.join(cwdDir, '.orchestrator', 'policy');
    await fs.mkdir(cwdPolicyDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdPolicyDir, 'templates-policy.json'),
      JSON.stringify({ ...FIXTURE_POLICY, enforcement: 'off', bypass_patterns: [] }, null, 2),
    );

    // Plant a template in cwdDir so there IS something to enforce if policy were 'block'
    const tplDir = path.join(cwdDir, '.gitlab', 'merge_request_templates');
    await fs.mkdir(tplDir, { recursive: true });
    await fs.writeFile(path.join(tplDir, 'Default.md'), '## Summary\n');

    // Run hook with cwd = cwdDir, CLAUDE_PROJECT_DIR = outer projectDir
    // cwd policy ('off') should be found first → exits 0
    const result = await runHook({
      projectDir: cwdDir,
      stdin: bashPayload('glab mr create --title foo'),
      extraEnv: {
        CLAUDE_PROJECT_DIR: projectDir,
      },
    });

    // cwd policy is 'off' → hook exits 0 regardless of templates present
    expect(result.code).toBe(0);
  });
});
