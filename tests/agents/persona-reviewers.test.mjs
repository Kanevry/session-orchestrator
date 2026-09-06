/**
 * tests/agents/persona-reviewers.test.mjs
 *
 * Regression tests for #339 — persona-reviewer agents.
 * Config key renamed to wave-reviewers in #461 — see "Migration: `persona-reviewers`
 * → `wave-reviewers`" (#461; archived in the private Meta-Vault)
 *
 * Verifies that:
 *   - All three new agent files exist
 *   - Each has valid YAML frontmatter (starts with ---)
 *   - Each frontmatter has all 4 required fields: name, description, model, color
 *   - Each `tools:` field (if present) is a comma-separated string, not a JSON array
 *   - Each `description:` is a single-line inline string (no block-scalar markers)
 *   - All 3 agents pass validate-plugin.mjs (exit 0, 0 failed)
 *
 * REMOVED 2026-09-06 (#1157 split follow-up): the `wave-loop.md persona-reviewer
 * dispatch step` describe asserted three strings existed in a skill markdown file
 * (`/5a\.|persona-reviewer/`, `'wave-reviewers'`, `/no-op|absent|empty/`). It had no
 * behavioural consumer and is a TV-002c prose pin — measured: after the whole
 * 1,337-line loop body moved out of wave-loop.md into `references/`, the FIRST
 * assertion still passed against the 39-line index, i.e. it never detected the
 * section leaving. The behaviour it gestured at — `wave-reviewers` absent or `[]`
 * is a no-op — is really covered by `tests/lib/config/wave-reviewers.test.mjs`
 * (`returns all defaults on empty string`, `parses reviewers empty array []`,
 * `treats a commented-out block as absent`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function exists(rel) {
  return existsSync(path.join(REPO_ROOT, rel));
}

const PERSONA_AGENTS = [
  'agents/architect-reviewer.md',
  'agents/qa-strategist.md',
  'agents/analyst.md',
];

/**
 * Parse the YAML frontmatter block from a Markdown file.
 * Returns the raw frontmatter string between the first pair of --- delimiters.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]+?)\n---/);
  return match ? match[1] : null;
}

// ─── Test 1: All 3 agent files exist ─────────────────────────────────────────

describe('#339 — persona-reviewer agent files exist', () => {
  it('all three agent files exist at agents/{architect-reviewer,qa-strategist,analyst}.md', () => {
    for (const rel of PERSONA_AGENTS) {
      expect(exists(rel), `expected ${rel} to exist`).toBe(true);
    }
  });
});

// ─── Test 2: Each file has YAML frontmatter ───────────────────────────────────

describe('#339 — agent YAML frontmatter structure', () => {
  it('each agent file starts with --- (YAML frontmatter delimiter)', () => {
    for (const rel of PERSONA_AGENTS) {
      const content = read(rel);
      expect(content.trimStart(), `${rel} should start with ---`).toMatch(/^---\n/);
    }
  });

  // ─── Test 3: All 4 required fields present ───────────────────────────────────

  it('each frontmatter contains all 4 required fields: name, description, model, color', () => {
    for (const rel of PERSONA_AGENTS) {
      const content = read(rel);
      const fm = parseFrontmatter(content);
      expect(fm, `${rel} must have parseable frontmatter`).not.toBeNull();
      expect(fm).toMatch(/^name:/m);
      expect(fm).toMatch(/^description:/m);
      expect(fm).toMatch(/^model:/m);
      expect(fm).toMatch(/^color:/m);
    }
  });

  // ─── Test 4: tools: is a comma-separated string, NOT a JSON array ─────────

  it('each tools: field (if present) is a comma-separated string, not a JSON array', () => {
    for (const rel of PERSONA_AGENTS) {
      const content = read(rel);
      const fm = parseFrontmatter(content);
      if (fm === null) continue;
      const toolsLine = fm.split('\n').find(l => l.startsWith('tools:'));
      if (!toolsLine) continue; // tools is optional
      // A JSON array would contain `[` immediately after `tools:`
      expect(toolsLine, `${rel} tools: must not be a JSON array`).not.toMatch(/tools:\s*\[/);
      // Must be a plain string value (comma-separated list or single value)
      expect(toolsLine, `${rel} tools: must be a non-empty string value`).toMatch(/tools:\s*\S/);
    }
  });

  // ─── Test 5: description: is a single-line inline string ─────────────────

  it('each description: is a single-line inline string (no > or | block-scalar markers)', () => {
    for (const rel of PERSONA_AGENTS) {
      const content = read(rel);
      const fm = parseFrontmatter(content);
      expect(fm, `${rel} must have parseable frontmatter`).not.toBeNull();
      const descLine = fm.split('\n').find(l => l.startsWith('description:'));
      expect(descLine, `${rel} must have a description: line`).toBeDefined();
      // Block-scalar marker would be `description: >` or `description: |`
      expect(descLine, `${rel} description must not use block-scalar (> or |)`).not.toMatch(/^description:\s*[>|]/);
      // Must have actual inline content after the key
      expect(descLine, `${rel} description must have inline content`).toMatch(/^description:\s*\S/);
    }
  });
});

// ─── Test 6: validate-plugin.mjs reports 0 failed ────────────────────────────

describe('#339 — validate-plugin.mjs passes with all 3 agents present', () => {
  // Spawn once per describe — validate-plugin.mjs forks ~21 grandchild
  // processes; re-spawning per it() flakes under loaded-runner contention.
  let result;
  beforeAll(() => {
    result = spawnSync('node', ['scripts/validate-plugin.mjs', REPO_ROOT], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
  });

  it('exits 0 and reports 0 failed when run against the current repo', () => {
    expect(result.status, `validate-plugin.mjs exited ${result.status}; stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('0 failed');
  });

  it('validate-plugin.mjs stdout contains Results: summary line', () => {
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Results:');
  });
});
