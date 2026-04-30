/**
 * tests/scripts/validate/check-agents.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-agents.mjs.
 * Spawns the script as a child process and verifies exit codes + output shape.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/validate/check-agents.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-agents-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(dir, 'agents'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'test-plugin', version: '1.0.0' }));
  return dir;
}

function writeAgent(dir, filename, content) {
  writeFileSync(path.join(dir, 'agents', filename), content);
}

const VALID_AGENT = `---
name: my-agent
description: Use this agent when you need to do something. <example>Context: user: "do it" assistant: "done"</example>
model: inherit
color: blue
tools: Read, Edit, Write
---

# My Agent
`;

// ---------------------------------------------------------------------------
// Smoke — current repo
// ---------------------------------------------------------------------------

describe('check-agents.mjs — smoke against current repo', () => {
  it('exits 0 against the current plugin repo', () => {
    const r = run(PLUGIN_REPO);
    expect(r.status).toBe(0);
  });

  it('emits at least 7 PASS lines (one per agent .md file)', () => {
    const r = run(PLUGIN_REPO);
    const passLines = r.stdout.split('\n').filter((l) => l.startsWith('  PASS:'));
    expect(passLines.length).toBeGreaterThanOrEqual(7);
  });

  it('reports 0 failed checks', () => {
    const r = run(PLUGIN_REPO);
    const match = r.stdout.match(/Results:\s+\d+\s+passed,\s+(\d+)\s+failed/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Missing plugin-root argument
// ---------------------------------------------------------------------------

describe('check-agents.mjs — missing argument', () => {
  it('exits 1 when no plugin-root arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
  });

  it('writes usage message to stderr when no arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.stderr).toContain('Usage: check-agents.mjs <plugin-root>');
  });
});

// ---------------------------------------------------------------------------
// Agent missing required 'name' field
// ---------------------------------------------------------------------------

describe('check-agents.mjs — agent missing name field', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when an agent .md is missing the name frontmatter field', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-agent.md', `---
description: Some description inline here
model: inherit
color: blue
---
`);
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line listing the missing name field', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-agent.md', `---
description: Some description inline here
model: inherit
color: blue
---
`);
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: bad-agent.md: missing frontmatter fields: name');
  });
});

// ---------------------------------------------------------------------------
// Agent with tools as JSON array (forbidden)
// ---------------------------------------------------------------------------

describe('check-agents.mjs — tools as JSON array', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when agent tools field is a JSON array', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-tools.md', `---
name: bad-tools
description: Some description inline here
model: inherit
color: blue
tools: ["Read", "Edit"]
---
`);
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning comma-separated string when tools is a JSON array', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-tools.md', `---
name: bad-tools
description: Some description inline here
model: inherit
color: blue
tools: ["Read", "Edit"]
---
`);
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: bad-tools.md: tools must be a comma-separated string, not a JSON array');
  });
});

// ---------------------------------------------------------------------------
// Agent with description as YAML block scalar (forbidden)
// ---------------------------------------------------------------------------

describe('check-agents.mjs — description as block scalar', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when agent description is a YAML block scalar (> style)', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-desc.md', `---
name: bad-desc
description: >
  This is a block scalar description
  that spans multiple lines.
model: inherit
color: blue
---
`);
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning block scalar when description uses > syntax', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-desc.md', `---
name: bad-desc
description: >
  This is a block scalar description
  that spans multiple lines.
model: inherit
color: blue
---
`);
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: bad-desc.md: description must be an inline string, not a YAML block scalar');
  });
});

// ---------------------------------------------------------------------------
// Agent with invalid model value
// ---------------------------------------------------------------------------

describe('check-agents.mjs — invalid model value', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when agent model field has an invalid value', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-model.md', `---
name: bad-model
description: Some description inline here
model: gpt-4
color: blue
---
`);
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning allowed model values', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-model.md', `---
name: bad-model
description: Some description inline here
model: gpt-4
color: blue
---
`);
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: bad-model.md: model must be one of inherit|sonnet|opus|haiku (got: \'gpt-4\')');
  });
});

// ---------------------------------------------------------------------------
// Agent with invalid color value
// ---------------------------------------------------------------------------

describe('check-agents.mjs — invalid color value', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when agent color field has an invalid value', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-color.md', `---
name: bad-color
description: Some description inline here
model: inherit
color: purple
---
`);
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning allowed color values', () => {
    dir = makeFixture();
    writeAgent(dir, 'bad-color.md', `---
name: bad-color
description: Some description inline here
model: inherit
color: purple
---
`);
    const r = run(dir);
    expect(r.stdout).toContain("  FAIL: bad-color.md: color must be one of blue|cyan|green|yellow|magenta|red (got: 'purple')");
  });
});

// ---------------------------------------------------------------------------
// Valid agent passes all checks
// ---------------------------------------------------------------------------

describe('check-agents.mjs — valid agent fixture', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when agent has all valid required fields', () => {
    dir = makeFixture();
    writeAgent(dir, 'good-agent.md', VALID_AGENT);
    const r = run(dir);
    expect(r.status).toBe(0);
  });

  it('emits PASS line for the valid agent file', () => {
    dir = makeFixture();
    writeAgent(dir, 'good-agent.md', VALID_AGENT);
    const r = run(dir);
    expect(r.stdout).toContain('  PASS: good-agent.md: all required frontmatter fields present');
  });
});
