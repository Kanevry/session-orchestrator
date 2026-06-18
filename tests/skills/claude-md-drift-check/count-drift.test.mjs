/**
 * tests/skills/claude-md-drift-check/count-drift.test.mjs
 *
 * Vitest suite for the surface-count drift family (issue #663) in
 * skills/claude-md-drift-check/checker.mjs. Generalizes the original
 * command-count check into a parity guard over six artifact surfaces:
 *   command-count · skill-count · agent-count ·
 *   hook-event-count · hook-matcher-count · test-count
 *
 * For each surface the checker derives an ACTUAL on-disk count (glob / hooks.json
 * wiring) and compares it to a CLAIMED count regex-extracted from a scanned doc.
 * These are EXACT-count drift checks by design (the point is catching drift) —
 * NO floor/ceiling here (see .claude/rules/testing.md "Dynamic Artifact Counts"
 * carve-out, which explicitly exempts drift checks).
 *
 * Strategy: scaffold an ephemeral tmp vault with a known on-disk count per
 * surface, plant a CLAUDE.md claim (matching or drifted), spawn the checker,
 * assert on JSON errors + exit code. Expected values are hardcoded literals.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECKER = resolve(process.cwd(), 'skills/claude-md-drift-check/checker.mjs');

// Skip checks unrelated to surface-count so a tmp vault stays focused.
const NOISE_FLAGS = [
  '--skip-path-resolver',
  '--skip-project-count',
  '--skip-issue-refs',
  '--skip-session-files',
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
  vault = mkdtempSync(join(tmpdir(), 'count-drift-'));
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

// ── On-disk scaffolders ──────────────────────────────────────────────────────

/** Create N command markdown files under commands/. */
function makeCommands(n) {
  mkdirSync(join(vault, 'commands'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(vault, 'commands', `cmd${i}.md`), '# cmd\n');
}

/** Create N skill dirs each containing a SKILL.md. Adds a _shared/ dir WITHOUT
 *  a SKILL.md (must NOT be counted). */
function makeSkills(n) {
  const dir = join(vault, 'skills');
  mkdirSync(join(dir, '_shared'), { recursive: true });
  writeFileSync(join(dir, '_shared', 'notes.md'), '# internal, not a skill\n');
  for (let i = 0; i < n; i++) {
    mkdirSync(join(dir, `skill${i}`), { recursive: true });
    writeFileSync(join(dir, `skill${i}`, 'SKILL.md'), '# skill\n');
  }
}

/** Create N agent definitions under agents/, plus the AGENTS.md spec file that
 *  must be EXCLUDED from the count, plus a schemas/ subdir that must be ignored. */
function makeAgents(n) {
  const dir = join(vault, 'agents');
  mkdirSync(join(dir, 'schemas'), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), '# authoring spec, excluded\n');
  writeFileSync(join(dir, 'schemas', 'code-implementer.schema.json'), '{}\n');
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `agent${i}.md`), '# agent\n');
}

/**
 * Write a hooks/hooks.json with `events` distinct event keys and, within them,
 * `matchers` total matcher entries distributed across the events.
 */
function makeHooks(events, matchers) {
  const dir = join(vault, 'hooks');
  mkdirSync(dir, { recursive: true });
  const hooks = {};
  for (let e = 0; e < events; e++) hooks[`Event${e}`] = [];
  // Distribute matcher entries round-robin across the event keys.
  const keys = Object.keys(hooks);
  for (let m = 0; m < matchers; m++) {
    const key = keys[m % keys.length];
    hooks[key].push({ matcher: `m${m}`, hooks: [{ type: 'command', command: 'noop' }] });
  }
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }, null, 2));
}

/** Create N *.test.mjs files under tests/ (plus a non-test .mjs that must be ignored). */
function makeTestFiles(n) {
  const dir = join(vault, 'tests', 'unit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(vault, 'tests', 'helper.mjs'), '// not a test\n');
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `feature${i}.test.mjs`), 'it("x",()=>{});\n');
}

function writeClaim(text) {
  writeFileSync(join(vault, 'CLAUDE.md'), `# Repo\n\n${text}\n`);
}

// ── command-count (regression-preserving) ────────────────────────────────────

describe('surface: command-count', () => {
  it('flags a drifted "N commands" claim', () => {
    makeCommands(20);
    writeClaim('The plugin ships **16 commands**.');
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'command-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('Narrative claims 16 commands but actual on-disk count is 20');
    expect(errs[0].count).toEqual({ surface: 'command-count', actual: 20, claimed: 16 });
    // back-compat field preserved
    expect(errs[0].command_count).toEqual({ actual: 20, claimed: 16 });
  });

  it('passes a matching "N commands" claim', () => {
    makeCommands(20);
    writeClaim('The plugin ships **20 commands**.');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'command-count')).toHaveLength(0);
    expect(j.checks_run).toContain('command-count');
  });
});

// ── skill-count ──────────────────────────────────────────────────────────────

describe('surface: skill-count', () => {
  it('flags a drifted "N skills" claim (and ignores _shared/)', () => {
    makeSkills(40); // _shared/ present but has no SKILL.md → not counted
    writeClaim('- **36 skills** for the session lifecycle.');
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'skill-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('Narrative claims 36 skills but actual on-disk count is 40');
    expect(errs[0].count).toEqual({ surface: 'skill-count', actual: 40, claimed: 36 });
  });

  it('passes a matching "N user-facing skills" claim', () => {
    makeSkills(40);
    writeClaim('| `skills/` | 40 user-facing skills (+ `_shared/` internal) |');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'skill-count')).toHaveLength(0);
    expect(j.checks_run).toContain('skill-count');
  });
});

// ── agent-count ──────────────────────────────────────────────────────────────

describe('surface: agent-count', () => {
  it('flags a drifted "N sub-agent definitions" claim (excludes AGENTS.md)', () => {
    makeAgents(14); // 14 agent*.md + AGENTS.md spec (excluded) + schemas/ (ignored)
    writeClaim('| `agents/` | 13 sub-agent definitions |');
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'agent-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('Narrative claims 13 agents but actual on-disk count is 14');
    expect(errs[0].count).toEqual({ surface: 'agent-count', actual: 14, claimed: 13 });
  });

  it('passes a matching "N sub-agent definitions" claim', () => {
    makeAgents(14);
    writeClaim('| `agents/` | 14 sub-agent definitions |');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'agent-count')).toHaveLength(0);
    expect(j.checks_run).toContain('agent-count');
  });

  it('does NOT match the Codex "N agent role definitions" phrasing', () => {
    makeAgents(14);
    // "3 agent role definitions" is Codex-specific and must be ignored entirely,
    // even though 3 !== 14 — the regex deliberately excludes the "role" phrasing.
    writeClaim('Codex: compatibility config, 3 agent role definitions, marketplace icon.');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'agent-count')).toHaveLength(0);
  });
});

// ── hook-event-count (distinct events from hooks.json) ────────────────────────

describe('surface: hook-event-count', () => {
  it('flags a drifted "N distinct events" claim', () => {
    makeHooks(10, 14); // 10 distinct events, 14 matcher entries
    writeClaim('The full manifest spans 11 distinct events.');
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'hook-event-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('Narrative claims 11 distinct hook events but actual on-disk count is 10');
    expect(errs[0].count).toEqual({ surface: 'hook-event-count', actual: 10, claimed: 11 });
  });

  it('passes a matching "N distinct events" claim', () => {
    makeHooks(10, 14);
    writeClaim('10 distinct events: SessionStart, SessionEnd, ... CwdChanged.');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'hook-event-count')).toHaveLength(0);
    expect(j.checks_run).toContain('hook-event-count');
  });
});

// ── hook-matcher-count (matcher entries from hooks.json) ──────────────────────

describe('surface: hook-matcher-count', () => {
  it('flags a drifted "N matcher entries" claim', () => {
    makeHooks(10, 14); // 14 matcher entries
    writeClaim('The full manifest is **12 matcher entries** across these events.');
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'hook-matcher-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('Narrative claims 12 hook matcher entries but actual on-disk count is 14');
    expect(errs[0].count).toEqual({ surface: 'hook-matcher-count', actual: 14, claimed: 12 });
  });

  it('passes a matching "N matcher entries" claim', () => {
    makeHooks(10, 14);
    writeClaim('The full manifest is **14 matcher entries**.');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'hook-matcher-count')).toHaveLength(0);
    expect(j.checks_run).toContain('hook-matcher-count');
  });
});

// ── test-count (test files under tests/) ─────────────────────────────────────

describe('surface: test-count', () => {
  it('flags a drifted "N test files" claim (ignores non-.test.mjs)', () => {
    makeTestFiles(7); // 7 *.test.mjs + helper.mjs (ignored)
    writeClaim('Suite contains 5 test files.');
    const j = parseJson(runChecker(vault).stdout);
    const errs = errorsFor(j, 'test-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('Narrative claims 5 test files but actual on-disk count is 7');
    expect(errs[0].count).toEqual({ surface: 'test-count', actual: 7, claimed: 5 });
  });

  it('passes a matching "N test files" claim', () => {
    makeTestFiles(7);
    writeClaim('Suite contains 7 test files.');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'test-count')).toHaveLength(0);
    expect(j.checks_run).toContain('test-count');
  });

  it('does NOT match the runtime "N tests" pass-count phrasing', () => {
    makeTestFiles(7);
    // The README badge claims a runtime pass-count ("9303 tests"), which a static
    // checker cannot derive — the regex matches only the "test files" phrasing.
    writeClaim('npm test  # vitest, 9303 tests passing');
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'test-count')).toHaveLength(0);
  });
});

// ── graceful skip when a surface is unclaimed / artifact absent ───────────────

describe('graceful skip behaviour', () => {
  it('skips surfaces whose source artifact is absent (no commands/ etc.)', () => {
    // Only skills present; commands/agents/hooks/tests dirs absent.
    makeSkills(40);
    writeClaim('- **40 skills** present.');
    const j = parseJson(runChecker(vault).stdout);
    expect(j.checks_run).toContain('skill-count');
    expect(j.checks_run).not.toContain('command-count');
    expect(j.checks_run).not.toContain('agent-count');
    expect(j.checks_run).not.toContain('hook-event-count');
    expect(j.checks_run).not.toContain('test-count');
    // Each absent surface left a skip note.
    expect(j.checks_skipped.some((s) => s.startsWith('command-count'))).toBe(true);
    expect(j.checks_skipped.some((s) => s.startsWith('agent-count'))).toBe(true);
    expect(j.checks_skipped.some((s) => s.startsWith('hook-event-count'))).toBe(true);
  });

  it('makes NO claim when the doc has no numeric phrase for a surface (skills present, unclaimed)', () => {
    makeSkills(40);
    writeClaim('This repo has many skills but states no number.');
    const j = parseJson(runChecker(vault).stdout);
    // Surface ran (artifact present) but found nothing to compare → 0 errors.
    expect(j.checks_run).toContain('skill-count');
    expect(errorsFor(j, 'skill-count')).toHaveLength(0);
  });
});

// ── mode + flag wiring ───────────────────────────────────────────────────────

describe('mode + skip-flag wiring', () => {
  it('mode=hard exits 1 on any surface-count drift', () => {
    makeSkills(40);
    writeClaim('- **36 skills**.');
    const r = runChecker(vault, ['--mode', 'hard']);
    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('invalid');
    expect(errorsFor(j, 'skill-count')).toHaveLength(1);
  });

  it('mode=hard exits 0 when all claimed surfaces match', () => {
    makeSkills(40);
    makeCommands(20);
    writeClaim('40 skills and 20 commands.');
    const r = runChecker(vault, ['--mode', 'hard']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('ok');
  });

  it('--skip-surface-count disables the whole family', () => {
    makeSkills(40);
    writeClaim('- **36 skills**.');
    const j = parseJson(runChecker(vault, ['--skip-surface-count']).stdout);
    expect(j.checks_run).not.toContain('skill-count');
    expect(j.checks_run).not.toContain('command-count');
    expect(errorsFor(j, 'skill-count')).toHaveLength(0);
  });

  it('--skip-command-count disables only the command-count surface', () => {
    makeSkills(40);
    makeCommands(20);
    writeClaim('36 skills and 16 commands.'); // both drifted
    const j = parseJson(runChecker(vault, ['--skip-command-count']).stdout);
    expect(j.checks_run).not.toContain('command-count');
    expect(j.checks_run).toContain('skill-count');
    expect(errorsFor(j, 'command-count')).toHaveLength(0);
    expect(errorsFor(j, 'skill-count')).toHaveLength(1);
  });

  it('multiple surfaces drift simultaneously → one error per surface', () => {
    makeSkills(40);
    makeCommands(20);
    makeAgents(14);
    makeHooks(10, 14);
    makeTestFiles(7);
    writeClaim(
      '36 skills, 16 commands, 13 sub-agent definitions, 11 distinct events, ' +
      '12 matcher entries, 5 test files.',
    );
    const j = parseJson(runChecker(vault).stdout);
    expect(errorsFor(j, 'skill-count')).toHaveLength(1);
    expect(errorsFor(j, 'command-count')).toHaveLength(1);
    expect(errorsFor(j, 'agent-count')).toHaveLength(1);
    expect(errorsFor(j, 'hook-event-count')).toHaveLength(1);
    expect(errorsFor(j, 'hook-matcher-count')).toHaveLength(1);
    expect(errorsFor(j, 'test-count')).toHaveLength(1);
  });
});
