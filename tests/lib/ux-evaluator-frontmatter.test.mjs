/**
 * Regression tests for agents/ux-evaluator.md frontmatter.
 *
 * Purpose: pin every required contract so that future agent-frontmatter rule
 * changes or accidental edits to the agent file are caught immediately.
 * All expected values are hardcoded literals — no re-derivation of production
 * logic inside the test.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseAgentFrontmatter,
  validateAgentFrontmatter,
  validateAgentFile,
} from '@lib/agent-frontmatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const AGENT_PATH = join(REPO_ROOT, 'agents', 'ux-evaluator.md');

// ---------------------------------------------------------------------------
// Read the file once; share across tests.
// ---------------------------------------------------------------------------

const fileContents = (() => {
  try {
    return readFileSync(AGENT_PATH, 'utf8');
  } catch {
    return null;
  }
})();

const parsed = fileContents !== null ? parseAgentFrontmatter(fileContents) : null;
const frontmatter = parsed?.ok ? parsed.frontmatter : null;

// ---------------------------------------------------------------------------
// Test 1: file exists and is readable
// ---------------------------------------------------------------------------

describe('ux-evaluator.md file', () => {
  it('exists at agents/ux-evaluator.md', () => {
    expect(existsSync(AGENT_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: frontmatter parses without error
// ---------------------------------------------------------------------------

describe('ux-evaluator frontmatter parsing', () => {
  it('parses without error (ok=true)', () => {
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
  });

  it('returns a non-null frontmatter object', () => {
    expect(frontmatter).not.toBeNull();
    expect(typeof frontmatter).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Tests 3–4: required fields present + exact name value
// ---------------------------------------------------------------------------

describe('ux-evaluator required fields', () => {
  it('has all four required fields: name, description, model, color', () => {
    expect(frontmatter['name']).toBeDefined();
    expect(frontmatter['description']).toBeDefined();
    expect(frontmatter['model']).toBeDefined();
    expect(frontmatter['color']).toBeDefined();
  });

  it('name is exactly "ux-evaluator"', () => {
    expect(frontmatter['name']).toBe('ux-evaluator');
  });
});

// ---------------------------------------------------------------------------
// Test 5: name matches canonical agent-name regex
// ---------------------------------------------------------------------------

describe('ux-evaluator name format', () => {
  it('name matches canonical agent-name regex /^[a-z][a-z0-9-]{2,49}$/', () => {
    // Regex is hardcoded here per test-quality rules — pinning the contract
    // against the documented rules, not re-deriving from agent-frontmatter.mjs.
    expect(frontmatter['name']).toMatch(/^[a-z][a-z0-9-]{2,49}$/);
  });
});

// ---------------------------------------------------------------------------
// Test 6: description is an inline string (not a block scalar)
// ---------------------------------------------------------------------------

describe('ux-evaluator description', () => {
  it('description is typeof string and not the block-scalar sentinel', () => {
    expect(typeof frontmatter['description']).toBe('string');
    expect(frontmatter['description']).not.toBe('__BLOCK_SCALAR__');
  });

  // ---------------------------------------------------------------------------
  // Test 7: description contains required inline <example> block
  // ---------------------------------------------------------------------------

  it('description contains an inline <example> block with <commentary>', () => {
    const desc = frontmatter['description'];
    expect(desc).toContain('<example>');
    expect(desc).toContain('</example>');
    expect(desc).toContain('<commentary>');
  });
});

// ---------------------------------------------------------------------------
// Tests 8–9: model value
// ---------------------------------------------------------------------------

describe('ux-evaluator model', () => {
  it('model is exactly "opus"', () => {
    expect(frontmatter['model']).toBe('opus');
  });

  it('model passes the documented validator regex (hardcoded)', () => {
    // Hardcoded per test-quality rules — verifies ux-evaluator's model value
    // will remain valid against the spec even if agent-frontmatter.mjs changes.
    const MODEL_REGEX = /^(inherit|sonnet|opus|haiku|claude-(opus|sonnet|haiku)-\d+-\d+(-\d{8})?)$/;
    expect(frontmatter['model']).toMatch(MODEL_REGEX);
  });
});

// ---------------------------------------------------------------------------
// Test 10: color value
// ---------------------------------------------------------------------------

describe('ux-evaluator color', () => {
  it('color is exactly "blue"', () => {
    expect(frontmatter['color']).toBe('blue');
  });

  it('color is in the canonical 9-color palette', () => {
    const CANONICAL_COLORS = ['blue', 'cyan', 'green', 'yellow', 'magenta', 'red', 'purple', 'orange', 'pink'];
    expect(CANONICAL_COLORS).toContain(frontmatter['color']);
  });
});

// ---------------------------------------------------------------------------
// Tests 11–12: tools list
// ---------------------------------------------------------------------------

describe('ux-evaluator tools', () => {
  /**
   * Normalise tools to a Set<string> regardless of whether it is a
   * comma-separated string or a JSON-array string.
   */
  function normaliseTools(raw) {
    if (typeof raw !== 'string' || raw === '') return new Set();
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        return new Set(Array.isArray(arr) ? arr.map((t) => String(t).trim()) : []);
      } catch {
        return new Set();
      }
    }
    return new Set(trimmed.split(',').map((t) => t.trim()).filter(Boolean));
  }

  it('tools field contains exactly the expected 4 entries: Read, Grep, Glob, Bash', () => {
    const toolSet = normaliseTools(frontmatter['tools']);
    expect(toolSet.has('Read')).toBe(true);
    expect(toolSet.has('Grep')).toBe(true);
    expect(toolSet.has('Glob')).toBe(true);
    expect(toolSet.has('Bash')).toBe(true);
    expect(toolSet.size).toBe(4);
  });

  it('tools list does NOT contain Edit or Write (read-only agent regression-canary)', () => {
    const toolSet = normaliseTools(frontmatter['tools']);
    expect(toolSet.has('Edit')).toBe(false);
    expect(toolSet.has('Write')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: validateAgentFrontmatter returns ok=true for the parsed frontmatter
// ---------------------------------------------------------------------------

describe('ux-evaluator full frontmatter validation', () => {
  it('validateAgentFrontmatter returns ok=true', () => {
    const result = validateAgentFrontmatter(frontmatter);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('validateAgentFile returns ok=true for the full file', () => {
    const result = validateAgentFile(AGENT_PATH);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 13: End-to-end validator integration (check-agents.mjs child process)
// ---------------------------------------------------------------------------

describe('check-agents.mjs end-to-end validator', () => {
  it('exits with code 0 and reports PASS for ux-evaluator.md', () => {
    const CHECK_AGENTS_PATH = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-agents.mjs');
    const result = spawnSync('node', [CHECK_AGENTS_PATH, REPO_ROOT], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: ux-evaluator.md');
  });
});
