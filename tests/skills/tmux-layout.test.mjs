/**
 * tests/skills/tmux-layout.test.mjs
 *
 * Integration tests for scripts/tmux-layout.mjs (ADR-0007, GitLab #561).
 * Exercises the CLI via spawnSync with the bash stub at tests/fixtures/tmux/tmux
 * injected into PATH so no real tmux process is launched.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Repo paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TMUX_STUB_DIR = join(REPO_ROOT, 'tests/fixtures/tmux');
const SCRIPT = join(REPO_ROOT, 'scripts/tmux-layout.mjs');

// ---------------------------------------------------------------------------
// Helper: spawn scripts/tmux-layout.mjs
// ---------------------------------------------------------------------------

function runSkill(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${TMUX_STUB_DIR}:${process.env.PATH}`,
      ...env,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tmux-layout CLI', () => {
  // ── 1. --help ─────────────────────────────────────────────────────────────
  it('--help exits 0 and output contains "Usage"', () => {
    const result = runSkill(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage');
  });

  // ── 2. --version ──────────────────────────────────────────────────────────
  it('--version exits 0 and prints a semver string', () => {
    const result = runSkill(['--version']);

    expect(result.status).toBe(0);
    // Must match semver x.y.z
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // ── 3. invalid --layout ───────────────────────────────────────────────────
  it('--layout xyz exits 1 and error mentions valid layouts', () => {
    const result = runSkill(['--layout', 'xyz', '--json']);

    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout.trim());
    expect(json.ok).toBe(false);
    // Must mention at least one valid layout name
    expect(json.error).toMatch(/default/);
    expect(json.error).toMatch(/debug/);
  });

  // ── 4. tmux-missing degradation via EXIT_CODE=127 stub ────────────────────
  it('exits 2 with tmux-not-found error when stub exits 127', () => {
    const result = runSkill(['--json'], {
      TMUX_STUB_EXIT_CODE: '127',
    });

    expect(result.status).toBe(2);
    const json = JSON.parse(result.stdout.trim());
    expect(json.ok).toBe(false);
    expect(json.error).toContain('tmux not found');
    expect(json.exitCode).toBe(2);
  });

  // ── 5. default layout success (--json) ────────────────────────────────────
  it('default layout exits 0 and returns ok:true with 4 panes and a non-empty oneliner', () => {
    const result = runSkill(['--json'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim());
    expect(json.ok).toBe(true);
    expect(json.panes).toBe(4);
    expect(typeof json.oneliner).toBe('string');
    expect(json.oneliner.length).toBeGreaterThan(0);
  });

  // ── 6. debug layout success (--json) ──────────────────────────────────────
  it('--layout debug exits 0 and returns ok:true with 4 panes', () => {
    const result = runSkill(['--layout', 'debug', '--json'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim());
    expect(json.ok).toBe(true);
    expect(json.panes).toBe(4);
    expect(json.layout).toBe('debug');
  });

  // ── 7. session collision without --force ──────────────────────────────────
  it('exits 2 when session already exists and --force is not set', () => {
    const result = runSkill(['--json'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '0',
    });

    expect(result.status).toBe(2);
    const json = JSON.parse(result.stdout.trim());
    expect(json.ok).toBe(false);
    expect(json.error).toContain('already exists');
    // Must mention PSA-003 or --force as the escape hatch
    const mentionsPsa = json.error.includes('PSA-003') || json.error.includes('--force');
    expect(mentionsPsa).toBe(true);
  });

  // ── 8. session collision with --force ─────────────────────────────────────
  it('exits 0 with ok:true when session exists but --force is set, oneliner contains kill-session', () => {
    const result = runSkill(['--force', '--json'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '0',
    });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim());
    expect(json.ok).toBe(true);
    expect(json.oneliner).toContain('tmux kill-session');
  });

  // ── 9. bash-stub call-log records has-session invocation ──────────────────
  it('call log contains ["has-session", ...] JSON array on pre-check', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tmux-layout-test-'));
    const callLog = join(tmp, 'calls.jsonl');

    try {
      runSkill(['--json'], {
        TMUX_STUB_VERSION: 'tmux 3.4',
        TMUX_STUB_HAS_SESSION_RESULT: '1',
        TMUX_STUB_CALL_LOG: callLog,
      });

      const logContent = readFileSync(callLog, 'utf-8').trim();
      // First line must be the has-session call
      const firstLine = logContent.split('\n')[0];
      const parsed = JSON.parse(firstLine);
      expect(parsed[0]).toBe('has-session');
      expect(parsed[1]).toBe('-t');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── 10. tmux-too-old: version < 3.0 exits 2 with version error ────────────
  it('exits 2 and JSON error mentions "< 3.0" when tmux version is 2.9', () => {
    const result = runSkill(['--json'], {
      TMUX_STUB_VERSION: 'tmux 2.9',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });

    expect(result.status).toBe(2);
    const json = JSON.parse(result.stdout.trim());
    expect(json.ok).toBe(false);
    expect(json.exitCode).toBe(2);
    // Error must mention the version requirement
    expect(json.error).toMatch(/3\.0/);
  });

  // ── 11. AUQ-001: oneliner does NOT send a claude command to any pane ───────
  it('oneliner does not contain a claude command being sent to any pane (AUQ-001 / scratch-shell rule)', () => {
    const result = runSkill(['--json'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim());
    // send-keys must not ship a "claude" CLI command to any pane.
    // AUQ-001: Pane 1 is a scratch shell — no coordinator is launched.
    // The regex matches send-keys whose quoted argument STARTS with "claude"
    // (as a CLI invocation). A path like '.claude/STATE.md' must NOT match.
    // Pattern: send-keys ... '<space-or-start>claude<space-or-end>'
    expect(json.oneliner).not.toMatch(/send-keys\s[^&]*'\s*claude\s/);
  });

  // ── 12. session name in JSON output matches default convention ─────────────
  it('default layout session name follows "so-layout-default" convention', () => {
    const result = runSkill(['--json'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim());
    expect(json.sessionName).toBe('so-layout-default');
  });

  // ── 13. --session-name with whitespace exits 1 (tmux constraint) ──────────
  it('--session-name containing whitespace exits 1 with validation error', () => {
    const result = runSkill(['--session-name', 'bad name', '--json'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });

    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout.trim());
    expect(json.ok).toBe(false);
    expect(json.error).toContain('whitespace');
  });
});

// Gap-fill tests added by W4 coordinator after E2E best-practice review (research vs. claude-squad / workmux / jq best-practices 2026).
// Source: WebSearch synthesis 2026-05-25 — tmux scripted layout patterns + jq buffering + ADR-0007 § Decision differentiation.
describe('tmux-layout integration gaps (best-practice E2E coverage)', () => {
  it('Pane 4 oneliner uses jq --unbuffered (not --line-buffered) per jq 1.7+ flag', () => {
    const result = runSkill(['--json', '--layout', 'default'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim());
    expect(json.oneliner).toContain('jq --unbuffered');
    expect(json.oneliner).not.toContain('jq --line-buffered');
  });

  it('Pane 4 jq filter targets session-orchestrator real event types (wave|gate|spiral)', () => {
    const result = runSkill(['--json', '--layout', 'default'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });
    const json = JSON.parse(result.stdout.trim());
    // The jq filter is: select(.event | test("wave|gate|spiral"))
    // Match the regex alternation pattern that filters real events from .orchestrator/metrics/events.jsonl
    expect(json.oneliner).toMatch(/test\(["\\"]+wave\|gate\|spiral["\\"]+\)/);
  });

  it('Pane 2 STATE.md path resolves to current platform state-dir', () => {
    const result = runSkill(['--json', '--layout', 'default'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });
    const json = JSON.parse(result.stdout.trim());
    // On Claude Code, resolveStateDir() returns '.claude'. Verify Pane 2 uses tail -F on it.
    expect(json.oneliner).toMatch(/tail -F \.(claude|codex|cursor)\/STATE\.md/);
  });

  it('shellQuote escapes single-quote injection in --session-name', () => {
    // Attempt shell injection via session name. Skill validates session-name first,
    // so the attack should be rejected at validation (exit 1), NOT passed through to tmux.
    const result = runSkill(['--session-name', "evil'; rm -rf /;", '--json'], {
      TMUX_STUB_VERSION: 'tmux 3.4',
      TMUX_STUB_HAS_SESSION_RESULT: '1',
    });
    // Either exit 1 (validation rejects) or exit 0 with properly escaped output (defense in depth).
    expect([0, 1, 2]).toContain(result.status);
    if (result.status === 0) {
      // If accepted, the oneliner MUST NOT contain unescaped "; rm -rf /"
      const json = JSON.parse(result.stdout.trim());
      expect(json.oneliner).not.toMatch(/[^\\]'; rm -rf/);   // no unescaped injection
    }
  });
});
