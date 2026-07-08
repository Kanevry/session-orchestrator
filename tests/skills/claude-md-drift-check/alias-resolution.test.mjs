/**
 * tests/skills/claude-md-drift-check/alias-resolution.test.mjs
 *
 * Vitest suite for the CLAUDE.md / AGENTS.md alias resolution behaviour
 * landed in checker.mjs (issue #33 AC2) plus the session-config-parity
 * check (issue #30).
 *
 * Strategy: spawn the checker as a subprocess with VAULT_DIR pointing at
 * an ephemeral tmp dir. Assert on JSON output + exit code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the checker relative to this test file so the suite works regardless
// of the cwd vitest happens to be invoked from.
// Test file path:    tests/skills/claude-md-drift-check/alias-resolution.test.mjs
// Checker file path: skills/claude-md-drift-check/checker.mjs
const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = resolve(HERE, '..', '..', '..', 'skills', 'claude-md-drift-check', 'checker.mjs');

function runChecker(vaultDir, args = []) {
  const r = spawnSync('node', [CHECKER, ...args], {
    env: { ...process.env, VAULT_DIR: vaultDir, PATH: process.env.PATH },
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function parseJson(out) {
  const line = out.trim().split('\n').find((l) => l.startsWith('{'));
  return JSON.parse(line);
}

let vault;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'drift-alias-'));
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

describe('instruction-file alias resolution (#33 AC2)', () => {
  it('resolves AGENTS.md when CLAUDE.md absent', () => {
    writeFileSync(
      join(vault, 'AGENTS.md'),
      '# AGENTS\n\nMissing: /Users/definitely/no-such-path-xyz-w2b3\n',
    );
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.resolved_kind).toBe('agents');
    expect(j.resolved_path).toMatch(/AGENTS\.md$/);
    expect(j.files_scanned).toBe(1);
    // path-resolver fires against AGENTS.md, not CLAUDE.md.
    const pathErrors = j.errors.filter((e) => e.check === 'path-resolver');
    expect(pathErrors).toHaveLength(1);
    expect(pathErrors[0].file).toBe('AGENTS.md');
    expect(pathErrors[0].extracted).toBe('/Users/definitely/no-such-path-xyz-w2b3');
  });

  it('prefers CLAUDE.md when both present', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# CLAUDE\n\nClean file.\n');
    writeFileSync(join(vault, 'AGENTS.md'), '# AGENTS\n\nClean file.\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.resolved_kind).toBe('claude');
    expect(j.resolved_path).toMatch(/CLAUDE\.md$/);
    // Default include-paths seed only CLAUDE.md (alias winner) + _meta/**/*.md.
    expect(j.files_scanned).toBe(1);
  });

  it('emits null when neither CLAUDE.md nor AGENTS.md is present', () => {
    // Empty vault (no instruction file, no _meta/).
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.resolved_path).toBeNull();
    expect(j.resolved_kind).toBeNull();
    // No instruction file + no _meta/ → no scope files matched → skipped.
    expect(j.status).toBe('skipped');
    expect(j.files_scanned).toBe(0);
  });
});

describe('session-config-parity (#30)', () => {
  it('flags missing top-level keys when local Session Config diverges from template', () => {
    const template = [
      '# Session Config Template',
      '',
      '## Session Config',
      '',
      '```yaml',
      'foo: 1',
      'bar: 2',
      'baz: 3',
      '```',
      '',
    ].join('\n');
    const local = [
      '# CLAUDE',
      '',
      '## Session Config',
      '',
      '```yaml',
      'foo: 1',
      'bar: 2',
      '```',
      '',
    ].join('\n');
    mkdirSync(join(vault, 'docs'));
    writeFileSync(join(vault, 'docs', 'session-config-template.md'), template);
    writeFileSync(join(vault, 'CLAUDE.md'), local);
    const r = runChecker(vault, ['--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('session-config-parity');
    const parityErrors = j.errors.filter((e) => e.check === 'session-config-parity');
    expect(parityErrors).toHaveLength(1);
    expect(parityErrors[0].extracted).toBe('baz');
    expect(parityErrors[0].file).toBe('CLAUDE.md');
    expect(parityErrors[0].message).toContain("missing top-level key 'baz'");
  });

  it('skips gracefully when template file missing', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# CLAUDE\n\n## Session Config\n\n```yaml\nfoo: 1\n```\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('session-config-parity');
    expect(j.checks_skipped.some((s) => s.startsWith('session-config-parity:'))).toBe(true);
  });
});

// ── opt-in baseline regression (issue #785, severity split per coordinator
// follow-up triage) ──────────────────────────────────────────────────────────
//
// `extractSessionConfigBlock()` originally stopped at the FIRST `## Session
// Config` heading it found. docs/session-config-template.md carries TWO such
// headings — both live INSIDE fenced ```yaml example blocks: the "Full
// minimal baseline" (7 mandatory keys) and the "Full opt-in baseline" (the
// full key catalog, a strict superset). Stopping at the first meant Check 6
// never enforced ANY opt-in-baseline key (e.g. `handover-gate`,
// `state-md-lock`) — a local CLAUDE.md omitting them passed green. The
// initial #785 fix read the LAST occurrence and treated every missing
// opt-in-baseline key as an ERROR — but a consumer repo legitimately NOT
// adopting an opt-in feature must not go red (this repo's own CLAUDE.md
// deliberately omits 37 opt-in-baseline keys). The coordinator triaged this:
// missing MANDATORY (minimal-block) keys stay ERROR; missing OPT-IN-ONLY
// (last-block-but-not-first-block) keys are now WARNING, so pure opt-in gaps
// never trip `mode: hard` (and, downstream, never block
// `autonomous-gated` skill-evolution's `runConfigValidationGate()`).
describe('session-config-parity — opt-in baseline severity split (#785)', () => {
  const twoBlockTemplate = [
    '# Session Config Template',
    '',
    '## Full minimal baseline (copy-paste)',
    '',
    '```yaml',
    '## Session Config',
    '',
    'test-command: npm test',
    'persistence: true',
    '```',
    '',
    '## Full opt-in baseline (copy-paste)',
    '',
    '```yaml',
    '## Session Config',
    '',
    'test-command: npm test',
    'persistence: true',
    'handover-gate:',
    '  enabled: true',
    '  max-open-questions: 3',
    '```',
    '',
  ].join('\n');

  it('fires a WARNING (not an error) when a local CLAUDE.md omits an opt-in-baseline-only key', () => {
    mkdirSync(join(vault, 'docs'));
    writeFileSync(join(vault, 'docs', 'session-config-template.md'), twoBlockTemplate);
    writeFileSync(
      join(vault, 'CLAUDE.md'),
      '# CLAUDE\n\n## Session Config\n\ntest-command: npm test\npersistence: true\n',
    );
    const r = runChecker(vault, ['--skip-issue-refs']);
    expect(r.code).toBe(0); // mode defaults to warn
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('session-config-parity');
    const parityWarnings = j.warnings.filter((w) => w.check === 'session-config-parity');
    expect(parityWarnings.map((w) => w.extracted)).toContain('handover-gate');
    // The opt-in gap must NOT appear in errors[] — only mandatory gaps do.
    const parityErrors = j.errors.filter((e) => e.check === 'session-config-parity');
    expect(parityErrors.map((e) => e.extracted)).not.toContain('handover-gate');
  });

  it('is green (no warning, no error) once the opt-in key is present locally — fake-regression revert', () => {
    mkdirSync(join(vault, 'docs'));
    writeFileSync(join(vault, 'docs', 'session-config-template.md'), twoBlockTemplate);
    writeFileSync(
      join(vault, 'CLAUDE.md'),
      '# CLAUDE\n\n## Session Config\n\ntest-command: npm test\npersistence: true\nhandover-gate:\n  enabled: true\n',
    );
    const r = runChecker(vault, ['--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const parityErrors = j.errors.filter((e) => e.check === 'session-config-parity');
    const parityWarnings = j.warnings.filter((w) => w.check === 'session-config-parity');
    expect(parityErrors.map((e) => e.extracted)).not.toContain('handover-gate');
    expect(parityWarnings.map((w) => w.extracted)).not.toContain('handover-gate');
  });

  it('mode=hard does NOT exit 1 when only an opt-in-baseline key is omitted (warnings never gate hard mode)', () => {
    mkdirSync(join(vault, 'docs'));
    writeFileSync(join(vault, 'docs', 'session-config-template.md'), twoBlockTemplate);
    writeFileSync(
      join(vault, 'CLAUDE.md'),
      '# CLAUDE\n\n## Session Config\n\ntest-command: npm test\npersistence: true\n',
    );
    const r = runChecker(vault, ['--mode', 'hard', '--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('ok'); // status is errors-driven; warnings don't flip it to 'invalid'
    expect(j.errors.filter((e) => e.check === 'session-config-parity')).toHaveLength(0);
    expect(j.warnings.filter((w) => w.check === 'session-config-parity').map((w) => w.extracted)).toContain(
      'handover-gate',
    );
  });

  it('mode=hard still exits 1 when a MANDATORY (minimal-block) key is omitted', () => {
    mkdirSync(join(vault, 'docs'));
    writeFileSync(join(vault, 'docs', 'session-config-template.md'), twoBlockTemplate);
    // Omits `persistence` — a minimal-block (mandatory) key — while keeping the opt-in key.
    writeFileSync(
      join(vault, 'CLAUDE.md'),
      '# CLAUDE\n\n## Session Config\n\ntest-command: npm test\nhandover-gate:\n  enabled: true\n',
    );
    const r = runChecker(vault, ['--mode', 'hard', '--skip-issue-refs']);
    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('invalid');
    const parityErrors = j.errors.filter((e) => e.check === 'session-config-parity');
    expect(parityErrors.map((e) => e.extracted)).toContain('persistence');
  });
});
