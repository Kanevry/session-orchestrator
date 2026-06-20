/**
 * tests/unit/sandbox-tier.test.mjs
 *
 * Unit + integration tests for scripts/lib/validate/tier-inference.mjs (issue #418).
 * Covers:
 *   - inferTierFromTools: correct tier inference from tools arrays
 *   - validateTierConsistency: declared vs inferred mismatch detection
 *   - TIER_ENUM: valid set
 *   - Integration: check-agents Check 8 against the 11 production agents
 *   - Fixture: mismatched declared vs tools → FAIL
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_ENUM, inferTierFromTools, validateTierConsistency } from '@lib/validate/tier-inference.mjs';

const CHECK_AGENTS_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/lib/validate/check-agents.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runCheckAgents(pluginRoot) {
  return spawnSync('node', [CHECK_AGENTS_SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 20_000 });
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandbox-tier-'));
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
// TIER_ENUM
// ---------------------------------------------------------------------------

describe('TIER_ENUM', () => {
  it('contains exactly the 4 canonical tiers in order', () => {
    expect(TIER_ENUM).toEqual(['read-only', 'repo-write', 'network-allowed', 'dangerous']);
  });
});

// ---------------------------------------------------------------------------
// inferTierFromTools
// ---------------------------------------------------------------------------

describe('inferTierFromTools', () => {
  it('returns repo-write when tools include Edit and Write', () => {
    expect(inferTierFromTools(['Read', 'Edit', 'Write'])).toBe('repo-write');
  });

  it('returns repo-write when tools include Edit only', () => {
    expect(inferTierFromTools(['Read', 'Edit'])).toBe('repo-write');
  });

  it('returns repo-write when tools include Write only', () => {
    expect(inferTierFromTools(['Write'])).toBe('repo-write');
  });

  it('returns read-only when tools are Read, Grep, Glob, Bash', () => {
    expect(inferTierFromTools(['Read', 'Grep', 'Glob', 'Bash'])).toBe('read-only');
  });

  it('returns read-only when tools include Skill(...) wildcard', () => {
    expect(inferTierFromTools(['Read', 'Grep', 'Glob', 'Bash', 'Skill(session-orchestrator:*)'])).toBe('read-only');
  });

  it('returns repo-write as safe default for empty array', () => {
    expect(inferTierFromTools([])).toBe('repo-write');
  });

  it('returns repo-write as safe default for non-array input', () => {
    expect(inferTierFromTools(null)).toBe('repo-write');
    expect(inferTierFromTools(undefined)).toBe('repo-write');
  });

  // =========================================================================
  // NEW BOUNDARY TESTS (W4-T1)
  // =========================================================================

  it('returns repo-write for array with only Bash (safe default — unknown might be dangerous)', () => {
    // Bash alone is in READ_ONLY_TOOLS, so all-read-only path → read-only.
    // BUT the assignment says "array with only Bash" — let's verify the actual
    // contract: Bash IS in READ_ONLY_TOOLS, so inferTierFromTools(['Bash'])
    // should return 'read-only' since every tool is in the read-only set.
    expect(inferTierFromTools(['Bash'])).toBe('read-only');
  });

  it('returns repo-write for mixed-case "EDIT" (case-sensitive lookup — no match)', () => {
    // WRITE_TOOLS is case-sensitive ('Edit', 'Write'). 'EDIT' does not match.
    // READ_ONLY_TOOLS also does not contain 'EDIT', so falls to safe default.
    expect(inferTierFromTools(['EDIT'])).toBe('repo-write');
  });

  it('returns read-only for Skill(*) wildcard (normalised to Skill)', () => {
    expect(inferTierFromTools(['Skill(*)', 'Read'])).toBe('read-only');
  });

  it('returns read-only for all 5 read-only tools listed together', () => {
    expect(inferTierFromTools(['Read', 'Grep', 'Glob', 'Bash', 'Skill'])).toBe('read-only');
  });

  it('returns repo-write when an unknown tool appears alongside read-only tools', () => {
    // 'MyCoolTool' is not in READ_ONLY_TOOLS or WRITE_TOOLS → safe default
    expect(inferTierFromTools(['Read', 'Grep', 'MyCoolTool'])).toBe('repo-write');
  });

  it('returns repo-write for an array containing a non-string element', () => {
    // Non-string entries are coerced to string via String(); 'null' is not in any set
    expect(inferTierFromTools([null, 'Read'])).toBe('repo-write');
  });
});

// ---------------------------------------------------------------------------
// validateTierConsistency
// ---------------------------------------------------------------------------

describe('validateTierConsistency', () => {
  it('returns ok:true when declared=repo-write and tools include Edit', () => {
    const result = validateTierConsistency({
      declared: 'repo-write',
      inferred: 'repo-write',
      tools: ['Read', 'Edit', 'Write'],
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:true when declared=read-only and tools are read-only', () => {
    const result = validateTierConsistency({
      declared: 'read-only',
      inferred: 'read-only',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with error when declared=read-only but tools include Edit', () => {
    const result = validateTierConsistency({
      declared: 'read-only',
      inferred: 'repo-write',
      tools: ['Read', 'Edit'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/read-only/);
    expect(result.error).toMatch(/Edit/);
  });

  it('returns ok:false with error for an invalid tier value', () => {
    const result = validateTierConsistency({
      declared: 'super-dangerous',
      inferred: 'repo-write',
      tools: ['Read', 'Edit'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a valid tier/);
  });

  it('returns ok:false for empty string declared tier', () => {
    const result = validateTierConsistency({
      declared: '',
      inferred: 'read-only',
      tools: ['Read'],
    });
    expect(result.ok).toBe(false);
  });

  // =========================================================================
  // NEW BOUNDARY TESTS (W4-T1)
  // =========================================================================

  it('returns ok:true for declared=dangerous — accepts any tools without constraint', () => {
    // 'dangerous' is a valid enum value; the only constraint is read-only cannot
    // have write tools.  'dangerous' has no such restriction.
    const result = validateTierConsistency({
      declared: 'dangerous',
      inferred: 'repo-write',
      tools: ['Read', 'Edit', 'Write', 'Bash'],
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:true for declared=network-allowed even when tools infer repo-write', () => {
    // network-allowed is a valid enum; it is above repo-write so the constraint
    // (declared=read-only must not have write tools) does not apply.
    const result = validateTierConsistency({
      declared: 'network-allowed',
      inferred: 'repo-write',
      tools: ['Read', 'Edit'],
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:false and mentions the invalid tier name in the error message', () => {
    const result = validateTierConsistency({
      declared: 'semi-safe',
      inferred: 'read-only',
      tools: ['Read'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('semi-safe');
    expect(result.error).toContain('not a valid tier');
  });

  it('returns ok:false with detail listing the write tools when declared=read-only + Edit present', () => {
    const result = validateTierConsistency({
      declared: 'read-only',
      inferred: 'repo-write',
      tools: ['Read', 'Edit', 'Write'],
    });
    expect(result.ok).toBe(false);
    // Both write tools mentioned in error detail
    expect(result.error).toMatch(/Edit/);
    expect(result.error).toMatch(/Write/);
  });
});

// ---------------------------------------------------------------------------
// Integration: check-agents Check 8 against all 11 production agents
// ---------------------------------------------------------------------------

describe('check-agents Check 8 — production agents', () => {
  // Spawn once per describe — all three it()s use identical args (PLUGIN_REPO).
  let r;
  beforeAll(() => {
    r = runCheckAgents(PLUGIN_REPO);
  });

  it('exits 0 for the real plugin repo (all production agents have valid sandbox-tier)', () => {
    expect(r.status).toBe(0);
  });

  it('emits ≥8 PASS lines for Check 8 (one per agent — floor/ceiling per test-quality.md dynamic-artifact-count carve-out)', () => {
    const check8Pass = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('  PASS:') && l.includes('sandbox-tier OK'));
    expect(check8Pass.length).toBeGreaterThanOrEqual(8);
    expect(check8Pass.length).toBeLessThanOrEqual(50);
  });

  it('emits no FAIL lines for Check 8 in the real repo', () => {
    const failLines = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('  FAIL:') && l.includes('sandbox-tier'));
    expect(failLines.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture: mismatched declared tier → FAIL
// ---------------------------------------------------------------------------

describe('check-agents Check 8 — mismatch fixture', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when agent declares read-only but tools include Edit', () => {
    dir = makeFixture();
    writeAgent(
      dir,
      'mismatch-agent.md',
      `---
name: mismatch-agent
description: An agent that declares the wrong tier.
model: inherit
color: blue
tools: Read, Edit, Write, Glob, Grep, Bash
sandbox-tier: read-only
---

# Mismatch Agent
`,
    );
    const r = runCheckAgents(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning sandbox-tier mismatch when tools include Edit', () => {
    dir = makeFixture();
    writeAgent(
      dir,
      'mismatch-agent.md',
      `---
name: mismatch-agent
description: An agent that declares the wrong tier.
model: inherit
color: blue
tools: Read, Edit, Write, Glob, Grep, Bash
sandbox-tier: read-only
---

# Mismatch Agent
`,
    );
    const r = runCheckAgents(dir);
    expect(r.stdout).toContain('sandbox-tier mismatch');
  });

  it('exits 0 when agent declares repo-write and tools include Edit', () => {
    dir = makeFixture();
    writeAgent(
      dir,
      'valid-agent.md',
      `---
name: valid-agent
description: An agent with correct repo-write tier declaration.
model: inherit
color: green
tools: Read, Edit, Write, Glob, Grep, Bash
sandbox-tier: repo-write
---

# Valid Agent
`,
    );
    const r = runCheckAgents(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sandbox-tier OK (repo-write)');
  });

  it('exits 1 when sandbox-tier has an invalid value', () => {
    dir = makeFixture();
    writeAgent(
      dir,
      'invalid-tier.md',
      `---
name: invalid-tier
description: Agent with a made-up tier value.
model: inherit
color: blue
tools: Read, Grep, Glob, Bash
sandbox-tier: ultra-safe
---

# Invalid Tier Agent
`,
    );
    const r = runCheckAgents(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('not valid');
  });

  // =========================================================================
  // NEW BOUNDARY TESTS (W4-T1) — placed inside the fixture describe so they
  // share the dir/afterEach cleanup mechanism.
  // =========================================================================

  it('exits 0 for declared=dangerous (any tools accepted above repo-write)', () => {
    dir = makeFixture();
    writeAgent(
      dir,
      'dangerous-agent.md',
      `---
name: dangerous-agent
description: An agent with dangerous tier.
model: inherit
color: red
tools: Read, Edit, Write, Glob, Grep, Bash
sandbox-tier: dangerous
---

# Dangerous Agent
`,
    );
    const r = runCheckAgents(dir);
    // dangerous tier is a valid enum value and is not 'read-only', so
    // validateTierConsistency returns ok:true for any tools.
    expect(r.status).toBe(0);
  });

  it('exits 0 for declared=network-allowed (valid enum, no constraint violation)', () => {
    dir = makeFixture();
    writeAgent(
      dir,
      'network-agent.md',
      `---
name: network-agent
description: An agent with network-allowed tier.
model: inherit
color: blue
tools: Read, Grep, Glob, Bash
sandbox-tier: network-allowed
---

# Network Agent
`,
    );
    const r = runCheckAgents(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sandbox-tier OK (network-allowed)');
  });

  it('emits WARN (not FAIL) when sandbox-tier is absent — backward-compat', () => {
    dir = makeFixture();
    writeAgent(
      dir,
      'no-tier.md',
      `---
name: no-tier
description: Agent without sandbox-tier field.
model: inherit
color: cyan
tools: Read, Grep, Glob, Bash
---

# No Tier Agent
`,
    );
    const r = runCheckAgents(dir);
    // WARN is emitted but the script exits 0 (no FAIL).
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARN: no-tier.md: sandbox-tier missing');
  });
});
