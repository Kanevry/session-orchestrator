/**
 * tests/lib/peekaboo-driver-frontmatter.test.mjs
 *
 * Regression tests for skills/peekaboo-driver/SKILL.md frontmatter and body.
 *
 * Purpose: pin the structural contract for the peekaboo-driver skill so that
 * future edits or accidental overwrites are caught immediately.
 * All expected values are hardcoded literals — no re-derivation of production
 * logic inside the test.
 *
 * Coverage:
 *   - File exists and is readable
 *   - YAML frontmatter parses without error
 *   - Required fields: name, user-invocable, tags, description
 *   - name === 'peekaboo-driver'
 *   - user-invocable === false
 *   - description is single-line inline string (not block scalar)
 *   - Three required permissions named in body: Screen Recording, Accessibility,
 *     Event Synthesizing
 *   - ## Composability Contract heading exists
 *   - peekaboo-mcp string does NOT appear (R5 canary baseline)
 *   - Both install paths documented: brew + npx
 *   - sw_vers reference present (macOS version gate)
 *   - peekaboo permissions status reference present
 *   - Body line count within floor/ceiling
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SKILL_PATH = join(REPO_ROOT, 'skills', 'peekaboo-driver', 'SKILL.md');

// ---------------------------------------------------------------------------
// Read the file once; share across tests.
// ---------------------------------------------------------------------------

const fileContents = (() => {
  try {
    return readFileSync(SKILL_PATH, 'utf8');
  } catch {
    return null;
  }
})();

/**
 * Parse a YAML frontmatter block (--- ... ---) from a Markdown file.
 * Returns a plain object for the flat key-value pairs we care about.
 * Does not depend on any YAML library — parses only the fields we pin.
 */
function parseFrontmatter(source) {
  if (typeof source !== 'string') return null;
  const fenceMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fenceMatch) return null;
  const block = fenceMatch[1];
  const result = {};
  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (key === '') continue;
    // Booleans
    if (raw === 'true') { result[key] = true; continue; }
    if (raw === 'false') { result[key] = false; continue; }
    // Inline arrays [a, b, c]
    if (raw.startsWith('[') && raw.endsWith(']')) {
      result[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    // Block scalar indicator (|, >, etc.) — we flag as sentinel
    if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-') {
      result[key] = '__BLOCK_SCALAR__';
      continue;
    }
    result[key] = raw;
  }
  return result;
}

const frontmatter = fileContents !== null ? parseFrontmatter(fileContents) : null;

// Extract the body (content after the closing --- fence)
const body = (() => {
  if (fileContents === null) return '';
  const match = fileContents.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : fileContents;
})();

const bodyLines = body.split('\n');

// ---------------------------------------------------------------------------
// Test 1: file exists
// ---------------------------------------------------------------------------

describe('peekaboo-driver SKILL.md file', () => {
  it('exists at skills/peekaboo-driver/SKILL.md', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: frontmatter parses without error
// ---------------------------------------------------------------------------

describe('peekaboo-driver frontmatter parsing', () => {
  it('returns a non-null frontmatter object', () => {
    expect(frontmatter).not.toBeNull();
    expect(typeof frontmatter).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Tests 3–4: required fields present + exact name value
// ---------------------------------------------------------------------------

describe('peekaboo-driver required fields', () => {
  it('has name field defined', () => {
    expect(frontmatter?.['name']).toBeDefined();
  });

  it('has user-invocable field defined', () => {
    expect(frontmatter?.['user-invocable']).toBeDefined();
  });

  it('has tags field defined', () => {
    expect(frontmatter?.['tags']).toBeDefined();
  });

  it('name is exactly "peekaboo-driver"', () => {
    expect(frontmatter?.['name']).toBe('peekaboo-driver');
  });

  it('user-invocable is exactly false', () => {
    expect(frontmatter?.['user-invocable']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 5: description is an inline string (not a YAML block scalar)
// ---------------------------------------------------------------------------

describe('peekaboo-driver description', () => {
  it('description is a non-empty string', () => {
    expect(typeof frontmatter?.['description']).toBe('string');
    expect((frontmatter?.['description'] ?? '').length).toBeGreaterThan(0);
  });

  it('description is not a YAML block scalar (no | or > indicator)', () => {
    expect(frontmatter?.['description']).not.toBe('__BLOCK_SCALAR__');
  });

  it('description is a single line (no newline character in value)', () => {
    const desc = frontmatter?.['description'] ?? '';
    expect(desc.includes('\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests 6–8: permissions names appear in body
// ---------------------------------------------------------------------------

describe('peekaboo-driver required permission names in body', () => {
  it('body contains "Screen Recording" permission name', () => {
    expect(body).toContain('Screen Recording');
  });

  it('body contains "Accessibility" permission name', () => {
    expect(body).toContain('Accessibility');
  });

  it('body contains "Event Synthesizing" permission name', () => {
    expect(body).toContain('Event Synthesizing');
  });
});

// ---------------------------------------------------------------------------
// Test 9: ## Composability Contract heading exists
// ---------------------------------------------------------------------------

describe('peekaboo-driver body structure', () => {
  it('body contains "## Composability Contract" heading', () => {
    expect(body).toContain('## Composability Contract');
  });
});

// ---------------------------------------------------------------------------
// Test 10: R5 canary — peekaboo-mcp must NOT appear in the body
// ---------------------------------------------------------------------------

describe('peekaboo-driver R5 canary', () => {
  it('body does not contain the forbidden string "peekaboo-mcp" (R5 canary baseline)', () => {
    // Documentation markers on the same line are allowed in the canary scanner,
    // but this file should not reference the pattern at all outside HARD-GATE blocks.
    // Any line containing peekaboo-mcp that lacks HARD-GATE would cause the canary
    // to fail — so we assert the raw body is clean.
    const lines = body.split('\n');
    const bareViolations = lines.filter((line) => {
      if (!line.includes('peekaboo-mcp')) return false;
      // Allow lines with documentation markers (mirrors canary exemption logic)
      return !line.includes('HARD-GATE') &&
             !line.includes('check-peekaboo-driver-canary') &&
             !line.includes('R5 grep-canary') &&
             !line.includes('canary-exempt') &&
             !line.includes('Never peekaboo-mcp') &&
             !line.includes('DO NOT USE');
    });
    expect(bareViolations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests 11–12: Both install paths documented
// ---------------------------------------------------------------------------

describe('peekaboo-driver install paths', () => {
  it('body references "brew install steipete/tap/peekaboo" (Homebrew install path)', () => {
    expect(body).toContain('brew install steipete/tap/peekaboo');
  });

  it('body references "npx -y @steipete/peekaboo" (npx install path)', () => {
    expect(body).toContain('npx -y @steipete/peekaboo');
  });
});

// ---------------------------------------------------------------------------
// Test 13: macOS version gate — sw_vers appears in body
// ---------------------------------------------------------------------------

describe('peekaboo-driver macOS version gate', () => {
  it('body references "sw_vers" (macOS version check present)', () => {
    expect(body).toContain('sw_vers');
  });
});

// ---------------------------------------------------------------------------
// Test 14: permission probe call documented
// ---------------------------------------------------------------------------

describe('peekaboo-driver permission probe', () => {
  it('body references "peekaboo permissions status" (permission probe call documented)', () => {
    expect(body).toContain('peekaboo permissions status');
  });
});

// ---------------------------------------------------------------------------
// Test 15: body line count floor/ceiling
// ---------------------------------------------------------------------------

describe('peekaboo-driver body length', () => {
  it('body is between 100 and 400 lines (sanity floor/ceiling)', () => {
    // Floor: 100 — ensures the skill is not accidentally emptied
    // Ceiling: 400 — ensures it has not grown into an unmanageable monolith
    expect(bodyLines.length).toBeGreaterThanOrEqual(100);
    expect(bodyLines.length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Test 16: RUBRIC_GLASS_V2 env-gate canary
//
// The glass-modifiers emit block is gated on ${RUBRIC_GLASS_V2:-0} = "1" so
// that v1 rubric runs do NOT emit the artifact and existing evaluator tests
// are not broken by the new conformance field.
//
// This canary asserts:
//   (a) The env-gate pattern is documented in the SKILL.md body.
//   (b) The emit is conditional (the "if" / gate line appears before the cat block).
// If someone removes the gate and makes glass-modifiers emit unconditionally,
// this test will fail — catching the regression before rubric-v1 evaluators break.
// ---------------------------------------------------------------------------

describe('peekaboo-driver RUBRIC_GLASS_V2 env-gate canary', () => {
  it('body documents the RUBRIC_GLASS_V2 environment variable', () => {
    expect(body).toContain('RUBRIC_GLASS_V2');
  });

  it('body gates glass-modifiers emit on RUBRIC_GLASS_V2=1 (conditional emit, not unconditional)', () => {
    // The guard line uses the bash idiom: [ "${RUBRIC_GLASS_V2:-0}" = "1" ]
    // Verify the gate is present AND precedes the `cat >` emit command for glass-modifiers.
    // We search for the `cat >` write command specifically (not documentation lines
    // that reference the artifact name in prose).
    const gateLineIdx = bodyLines.findIndex((l) => l.includes('RUBRIC_GLASS_V2:-0'));
    // The actual emit line is the `cat >` command that writes the glass-modifiers file.
    const emitLineIdx = bodyLines.findIndex((l) =>
      l.includes('cat >') && l.includes('glass-modifiers-'),
    );
    // Both must exist.
    expect(gateLineIdx).not.toBe(-1);
    expect(emitLineIdx).not.toBe(-1);
    // Gate must appear before the emit.
    expect(gateLineIdx).toBeLessThan(emitLineIdx);
  });
});
