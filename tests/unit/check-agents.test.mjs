/**
 * tests/unit/check-agents.test.mjs
 *
 * Focused tests for the Check 9 color-collision aggregation added to
 * scripts/lib/validate/check-agents.mjs (issue #443).
 *
 * The broader frontmatter/output-schema/sandbox-tier integration tests live in
 * tests/scripts/validate/check-agents.test.mjs. This file isolates the #443
 * color-collision behaviour: two dispatchable agents sharing a color → WARN
 * (not FAIL); a dispatchable agent sharing a color with a non-dispatchable
 * reference doc → no WARN.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/lib/validate/check-agents.mjs',
);

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-agents-color-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(dir, 'agents'), { recursive: true });
  writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0' }),
  );
  return dir;
}

function writeAgent(dir, filename, content) {
  writeFileSync(path.join(dir, 'agents', filename), content);
}

// ---------------------------------------------------------------------------
// Check 9: color-collision aggregation (issue #443)
// ---------------------------------------------------------------------------

describe('check-agents.mjs — color-collision aggregation (#443)', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('warns (does not fail) when two dispatchable agents share a color', () => {
    dir = makeFixture();
    writeAgent(dir, 'alpha.md', `---
name: alpha
description: Use this agent to do alpha work inline. <example>Context: user: "alpha" assistant: "done"</example>
model: inherit
color: green
---
`);
    writeAgent(dir, 'beta.md', `---
name: beta
description: Use this agent to do beta work inline. <example>Context: user: "beta" assistant: "done"</example>
model: inherit
color: green
---
`);
    const r = run(dir);
    expect(r.status).toBe(0); // WARN, not FAIL
    expect(r.stdout).toContain('WARN: color collision: green shared by dispatchable agents alpha.md, beta.md');
  });

  it('does NOT warn when a dispatchable agent shares a color with a non-dispatchable reference doc', () => {
    dir = makeFixture();
    writeAgent(dir, 'gamma.md', `---
name: gamma
description: Use this agent to do gamma work inline. <example>Context: user: "gamma" assistant: "done"</example>
model: inherit
color: cyan
---
`);
    writeAgent(dir, 'ref-doc.md', `---
name: ref-doc
description: Reference documentation (NOT a dispatchable agent) for a coordinator-direct flow. <example>Context: user: "ref" assistant: "noted"</example>
model: inherit
color: cyan
---
`);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('WARN: color collision');
    expect(r.stdout).toContain('  PASS: no color collisions among dispatchable agents');
  });

  it('emits the PASS line when all dispatchable agents have distinct colors', () => {
    dir = makeFixture();
    writeAgent(dir, 'one.md', `---
name: one
description: Use this agent for one thing inline. <example>Context: user: "one" assistant: "done"</example>
model: inherit
color: green
---
`);
    writeAgent(dir, 'two.md', `---
name: two
description: Use this agent for two things inline. <example>Context: user: "two" assistant: "done"</example>
model: inherit
color: blue
---
`);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('  PASS: no color collisions among dispatchable agents');
  });
});
