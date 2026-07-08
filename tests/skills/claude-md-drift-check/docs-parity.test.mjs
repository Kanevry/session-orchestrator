/**
 * tests/skills/claude-md-drift-check/docs-parity.test.mjs
 *
 * Vitest suite for Check 10 (`docs-parity`, issue #780) in
 * skills/claude-md-drift-check/checker.mjs. Three sub-checks, all reported
 * under the single `docs-parity` check id:
 *   (a) count-claims          — docs/components.md heading counts vs actual
 *                                on-disk counts (skills/commands/agents/hooks)
 *   (b) config-block-parity   — Session Config keys documented in
 *                                docs/session-config-template.md (opt-in
 *                                baseline) vs mentioned anywhere in
 *                                docs/session-config-reference.md
 *   (c) metrics-path-liveness — stale `.claude/metrics/` path references in
 *                                docs/*.md / docs/examples/*.md
 *
 * Strategy: scaffold an ephemeral tmp vault, spawn the checker, assert on
 * JSON errors + checks_run + exit code. Expected values are hardcoded
 * literals per .claude/rules/testing.md False-Positive-Prevention rules.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECKER = resolve(process.cwd(), 'skills/claude-md-drift-check/checker.mjs');

// Skip checks unrelated to docs-parity so a tmp vault stays focused.
const NOISE_FLAGS = [
  '--skip-path-resolver',
  '--skip-project-count',
  '--skip-issue-refs',
  '--skip-session-files',
  '--skip-surface-count',
  '--skip-session-config-parity',
  '--skip-vault-dir-parity',
];

function runChecker(vaultDir, args = []) {
  const r = spawnSync('node', [CHECKER, ...NOISE_FLAGS, ...args], {
    env: { ...process.env, VAULT_DIR: vaultDir, PATH: process.env.PATH },
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function parseJson(out) {
  const line = out.trim().split('\n').find((l) => l.startsWith('{'));
  return JSON.parse(line);
}

function errorsFor(j, check) {
  return j.errors.filter((e) => e.check === check);
}

let vault;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'docs-parity-'));
  // A minimal CLAUDE.md keeps `scopeFiles` non-empty so the checker takes its
  // normal (non-early-exit) path; NOISE_FLAGS disable every check that would
  // otherwise scan it.
  writeFileSync(join(vault, 'CLAUDE.md'), '# Repo\n\nNothing interesting here.\n');
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

// ── on-disk scaffolders (mirrors count-drift.test.mjs conventions) ──────────

function makeCommands(n) {
  mkdirSync(join(vault, 'commands'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(vault, 'commands', `cmd${i}.md`), '# cmd\n');
}

function makeSkills(n) {
  const dir = join(vault, 'skills');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    mkdirSync(join(dir, `skill${i}`), { recursive: true });
    writeFileSync(join(dir, `skill${i}`, 'SKILL.md'), '# skill\n');
  }
}

function makeAgents(n) {
  const dir = join(vault, 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), '# authoring spec, excluded\n');
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `agent${i}.md`), '# agent\n');
}

function makeHooks(events) {
  const dir = join(vault, 'hooks');
  mkdirSync(dir, { recursive: true });
  const hooks = {};
  for (let e = 0; e < events; e++) hooks[`Event${e}`] = [{ matcher: '*', hooks: [{ type: 'command', command: 'noop' }] }];
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }, null, 2));
}

/** Write docs/components.md with the exact heading forms Check 10a matches. */
function writeComponentsMd({ skills, commands, agents, hookEvents }) {
  mkdirSync(join(vault, 'docs'), { recursive: true });
  const lines = ['# Components & Reference', ''];
  if (skills !== undefined) lines.push(`## Skills (${skills} user-facing)`, '');
  if (commands !== undefined) lines.push(`## Commands (${commands})`, '');
  if (agents !== undefined) lines.push(`## Agents (${agents} typed sub-agents)`, '');
  if (hookEvents !== undefined) lines.push(`## Hook event types (${hookEvents})`, '');
  writeFileSync(join(vault, 'docs', 'components.md'), lines.join('\n') + '\n');
}

function writeTemplate(bodyLines) {
  mkdirSync(join(vault, 'docs'), { recursive: true });
  const content = [
    '# Session Config Template',
    '',
    '## Full opt-in baseline (copy-paste)',
    '',
    '```yaml',
    '## Session Config',
    '',
    ...bodyLines,
    '```',
    '',
  ].join('\n');
  writeFileSync(join(vault, 'docs', 'session-config-template.md'), content);
}

function writeReference(bodyLines) {
  mkdirSync(join(vault, 'docs'), { recursive: true });
  writeFileSync(join(vault, 'docs', 'session-config-reference.md'), ['# Session Config Reference', '', ...bodyLines, ''].join('\n'));
}

function writeDoc(relPath, content) {
  const abs = join(vault, relPath);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

// ── silent-skip when docs/components.md is absent ────────────────────────────

describe('graceful silent-skip', () => {
  it('does not run docs-parity when docs/components.md is absent (no checks_run entry, no checks_skipped entry)', () => {
    const j = parseJson(runChecker(vault).stdout);
    expect(j.checks_run).not.toContain('docs-parity');
    expect(j.checks_skipped.some((s) => s.startsWith('docs-parity'))).toBe(false);
  });
});

// ── --skip-docs-parity ────────────────────────────────────────────────────────

describe('--skip-docs-parity', () => {
  it('disables the whole check and logs the explicit skip reason', () => {
    writeComponentsMd({ skills: 40 });
    makeSkills(42); // drifted vs claim — would error if the check ran
    const j = parseJson(runChecker(vault, ['--skip-docs-parity']).stdout);
    expect(j.checks_run).not.toContain('docs-parity');
    expect(j.checks_skipped).toContain('docs-parity: explicitly skipped');
    expect(errorsFor(j, 'docs-parity')).toHaveLength(0);
  });
});

// ── (a) count-claims ──────────────────────────────────────────────────────────

describe('sub-check (a): count-claims', () => {
  it('flags a drifted skill count in docs/components.md', () => {
    makeSkills(42);
    writeComponentsMd({ skills: 40 });
    const j = parseJson(runChecker(vault).stdout);
    expect(j.checks_run).toContain('docs-parity');
    const errs = errorsFor(j, 'docs-parity');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('docs/components.md claims 40 skills but actual on-disk count is 42');
    expect(errs[0].file).toBe('docs/components.md');
  });

  it('is green once components.md is corrected — fake-regression revert', () => {
    makeSkills(42);
    writeComponentsMd({ skills: 42 });
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'docs-parity')).toHaveLength(0);
  });

  it('flags a drifted command count', () => {
    makeCommands(22);
    writeComponentsMd({ commands: 20 });
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('docs/components.md claims 20 commands but actual on-disk count is 22');
  });

  it('flags a drifted agent count', () => {
    makeAgents(14);
    writeComponentsMd({ agents: 13 });
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('docs/components.md claims 13 agents but actual on-disk count is 14');
  });

  it('flags a drifted hook-event count', () => {
    makeHooks(10);
    writeComponentsMd({ hookEvents: 9 });
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('docs/components.md claims 9 distinct hook events but actual on-disk count is 10');
  });

  it('skips a surface silently when its source artifact is absent (no commands/ dir)', () => {
    makeSkills(42);
    writeComponentsMd({ skills: 42, commands: 999 }); // claim present, but no commands/ dir on disk
    const j = parseJson(runChecker(vault).stdout);
    expect(j.checks_run).toContain('docs-parity');
    expect(errorsFor(j, 'docs-parity')).toHaveLength(0); // no crash, no false claim
  });

  it('multiple surfaces drift simultaneously → one docs-parity error per surface', () => {
    makeSkills(42);
    makeCommands(22);
    makeAgents(14);
    makeHooks(10);
    writeComponentsMd({ skills: 40, commands: 20, agents: 13, hookEvents: 9 });
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'docs-parity')).toHaveLength(4);
  });
});

// ── (b) config-block-parity ───────────────────────────────────────────────────

describe('sub-check (b): config-block-parity', () => {
  it('flags a template key that is not documented anywhere in the reference', () => {
    writeComponentsMd({ skills: 1 });
    makeSkills(1);
    writeTemplate(['test-command: npm test', 'handover-gate:', '  enabled: true']);
    writeReference(['| `test-command` | string | `npm test` | Test command. |']); // handover-gate undocumented
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity').filter((e) => e.file === 'docs/session-config-reference.md');
    expect(errs).toHaveLength(1);
    expect(errs[0].extracted).toBe('handover-gate');
    expect(errs[0].message).toBe(
      "Session Config key 'handover-gate' (documented in docs/session-config-template.md) is not documented in docs/session-config-reference.md",
    );
  });

  it('is green when the reference documents the key via a table row', () => {
    writeComponentsMd({ skills: 1 });
    makeSkills(1);
    writeTemplate(['test-command: npm test', 'handover-gate:', '  enabled: true']);
    writeReference([
      '| `test-command` | string | `npm test` | Test command. |',
      '| `handover-gate` | object | `{}` | Handover gate config. |',
    ]);
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity').filter((e) => e.file === 'docs/session-config-reference.md');
    expect(errs).toHaveLength(0);
  });

  it('is green when the reference documents the key via a yaml fence', () => {
    writeComponentsMd({ skills: 1 });
    makeSkills(1);
    writeTemplate(['test-command: npm test', 'handover-gate:', '  enabled: true']);
    writeReference([
      '| `test-command` | string | `npm test` | Test command. |',
      '',
      '```yaml',
      'handover-gate:',
      '  enabled: true',
      '```',
    ]);
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity').filter((e) => e.file === 'docs/session-config-reference.md');
    expect(errs).toHaveLength(0);
  });

  it('is green when the reference documents the key via a heading', () => {
    writeComponentsMd({ skills: 1 });
    makeSkills(1);
    writeTemplate(['test-command: npm test', 'handover-gate:', '  enabled: true']);
    writeReference(['| `test-command` | string | `npm test` | Test command. |', '', '### handover-gate']);
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity').filter((e) => e.file === 'docs/session-config-reference.md');
    expect(errs).toHaveLength(0);
  });

  it('skips gracefully (no sub-check-b errors) when session-config-reference.md is absent', () => {
    writeComponentsMd({ skills: 1 });
    makeSkills(1);
    writeTemplate(['test-command: npm test', 'handover-gate:', '  enabled: true']);
    // No session-config-reference.md written.
    const j = parseJson(runChecker(vault).stdout);
    expect(j.checks_run).toContain('docs-parity'); // components.md alone gates the whole Check 10
    expect(errorsFor(j, 'docs-parity').filter((e) => e.file === 'docs/session-config-reference.md')).toHaveLength(0);
  });
});

// ── (c) metrics-path-liveness ──────────────────────────────────────────────────

describe('sub-check (c): metrics-path-liveness', () => {
  it('flags a stale .claude/metrics/ reference in a root docs/*.md file', () => {
    writeComponentsMd({ skills: 1 });
    makeSkills(1);
    writeDoc('docs/validation-checklist.md', '# Checklist\n\n- Read `.claude/metrics/sessions.jsonl` after close\n');
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity').filter((e) => e.file === 'docs/validation-checklist.md');
    expect(errs).toHaveLength(1);
    expect(errs[0].line).toBe(3);
    expect(errs[0].extracted).toBe('.claude/metrics/');
    expect(errs[0].message).toBe(
      "Stale metrics path '.claude/metrics/' referenced — canonical path is '.orchestrator/metrics/'",
    );
  });

  it('flags a stale .claude/metrics/ reference in docs/examples/*.md', () => {
    writeComponentsMd({ skills: 1 });
    makeSkills(1);
    writeDoc('docs/examples/swift-ios-config.md', '# Example\n\nSee `.claude/metrics/learnings.jsonl`.\n');
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'docs-parity').filter((e) => e.file === 'docs/examples/swift-ios-config.md');
    expect(errs).toHaveLength(1);
  });

  it('is green when the doc uses the canonical .orchestrator/metrics/ path', () => {
    writeComponentsMd({ skills: 1 });
    makeSkills(1);
    writeDoc('docs/validation-checklist.md', '# Checklist\n\n- Read `.orchestrator/metrics/sessions.jsonl` after close\n');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'docs-parity').filter((e) => e.file === 'docs/validation-checklist.md')).toHaveLength(0);
  });
});

// ── mode + combined behaviour ──────────────────────────────────────────────────

describe('mode wiring', () => {
  it('mode=hard exits 1 on a docs-parity drift', () => {
    makeSkills(42);
    writeComponentsMd({ skills: 40 });
    const r = runChecker(vault, ['--mode', 'hard']);
    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('invalid');
    expect(errorsFor(j, 'docs-parity')).toHaveLength(1);
  });

  it('mode=hard exits 0 when everything matches', () => {
    makeSkills(42);
    writeComponentsMd({ skills: 42 });
    const r = runChecker(vault, ['--mode', 'hard']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('ok');
  });
});
