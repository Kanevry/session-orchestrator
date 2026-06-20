/**
 * tests/scripts/validate/check-subagent-types.test.mjs
 *
 * Integration + unit tests for scripts/lib/validate/check-subagent-types.mjs (#614).
 * The validator asserts every `subagent_type: "session-orchestrator:<X>"`
 * reference under skills/** resolves to an existing agents/<X>.md definition.
 * Spawns the script as a child process (exit-code + output shape) and also
 * exercises the exported collector directly.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/validate/check-subagent-types.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

/** Build a tmp plugin-root with skills/ + agents/ scaffolding. */
function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-subagent-types-'));
  mkdirSync(path.join(dir, 'skills'), { recursive: true });
  mkdirSync(path.join(dir, 'agents'), { recursive: true });
  return dir;
}

function writeSkill(dir, rel, contents) {
  const full = path.join(dir, 'skills', rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function writeAgent(dir, name) {
  writeFileSync(path.join(dir, 'agents', `${name}.md`), `---\nname: ${name}\n---\n`);
}

// ---------------------------------------------------------------------------
// Smoke — current repo (all references must resolve after #614)
// ---------------------------------------------------------------------------

describe('check-subagent-types.mjs — smoke against current repo', () => {
  // Spawn once per describe — both it()s use identical args (PLUGIN_REPO).
  let r;
  beforeAll(() => {
    r = run(PLUGIN_REPO);
  });

  it('exits 0 against the current plugin repo', () => {
    expect(r.status).toBe(0);
  });

  it('reports zero failures and surfaces a resolving PASS line', () => {
    // Count is intentionally not pinned (the referenced-agent set grows); assert
    // a known-good resolution + absence of any FAIL instead.
    expect(r.stdout).toContain('PASS: session-orchestrator:session-reviewer → agents/session-reviewer.md');
    expect(r.stdout).not.toContain('FAIL:');
    expect(r.stdout).toContain('0 failed');
  });
});

// ---------------------------------------------------------------------------
// Missing plugin-root argument
// ---------------------------------------------------------------------------

describe('check-subagent-types.mjs — missing argument', () => {
  it('exits 1 and writes usage to stderr when no plugin-root arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage: check-subagent-types.mjs <plugin-root>');
  });
});

// ---------------------------------------------------------------------------
// Dead reference fails (the #614 regression this guard exists to catch)
// ---------------------------------------------------------------------------

describe('check-subagent-types.mjs — unresolved reference', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 and emits a NOT FOUND FAIL line pointing at the file:line', () => {
    dir = makeFixture();
    writeSkill(dir, 'session-end/SKILL.md', 'prose\nsubagent_type: "session-orchestrator:ghost"\nmore\n');
    // agents/ghost.md intentionally absent
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL: session-orchestrator:ghost → agents/ghost.md NOT FOUND');
    expect(r.stdout).toContain('skills/session-end/SKILL.md:2');
    expect(r.stdout).toContain('1 failed');
  });

  it('catches dead references in nested skill subdirectories', () => {
    dir = makeFixture();
    writeSkill(dir, 'wave-executor/loop/inner.md', 'subagent_type: "session-orchestrator:phantom"\n');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL: session-orchestrator:phantom → agents/phantom.md NOT FOUND');
  });
});

// ---------------------------------------------------------------------------
// Known reference passes
// ---------------------------------------------------------------------------

describe('check-subagent-types.mjs — resolved reference', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 and emits a PASS line when the referenced agent exists', () => {
    dir = makeFixture();
    writeAgent(dir, 'code-implementer');
    writeSkill(dir, 'a.md', 'subagent_type: "session-orchestrator:code-implementer"\n');
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS: session-orchestrator:code-implementer → agents/code-implementer.md (1 ref)');
  });
});

// ---------------------------------------------------------------------------
// Inline-ignore marker skips a line
// ---------------------------------------------------------------------------

describe('check-subagent-types.mjs — inline-ignore marker', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when a dead reference sits on a line carrying check-subagent-types:ignore', () => {
    dir = makeFixture();
    writeSkill(
      dir,
      'doc.md',
      'historical: subagent_type: "session-orchestrator:retired" <!-- check-subagent-types:ignore -->\n',
    );
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('retired');
  });
});

// ---------------------------------------------------------------------------
// No skills/ directory — vacuous pass
// ---------------------------------------------------------------------------

describe('check-subagent-types.mjs — no skills directory', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when skills/ is absent', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'check-subagent-types-noskills-'));
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no skills/ directory');
  });
});

// ---------------------------------------------------------------------------
// Direct unit test of the exported collector
// ---------------------------------------------------------------------------

describe('collectSubagentTypeRefs', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('records agent name and 1-based line for each non-ignored reference', async () => {
    dir = makeFixture();
    writeSkill(
      dir,
      'x.md',
      [
        'line one',
        'subagent_type: "session-orchestrator:alpha"',
        'subagent_type: "session-orchestrator:beta" <!-- check-subagent-types:ignore -->',
        'subagent_type: "session-orchestrator:gamma"',
      ].join('\n'),
    );
    const { collectSubagentTypeRefs } = await import('../../../scripts/lib/validate/check-subagent-types.mjs');
    const refs = collectSubagentTypeRefs(path.join(dir, 'skills'));
    expect(refs).toEqual([
      { agent: 'alpha', file: path.join(dir, 'skills', 'x.md'), line: 2 },
      { agent: 'gamma', file: path.join(dir, 'skills', 'x.md'), line: 4 },
    ]);
  });
});
