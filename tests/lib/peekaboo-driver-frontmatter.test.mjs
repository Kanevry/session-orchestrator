/**
 * tests/lib/peekaboo-driver-frontmatter.test.mjs
 *
 * Frontmatter SCHEMA contract for skills/peekaboo-driver/SKILL.md.
 *
 * Scope narrowed (TV-003 consolidation): the body content-presence pins that
 * once lived here — permission-name strings, install-path strings, `sw_vers`,
 * `## Composability Contract` heading, body line-count floor/ceiling, and the
 * rubric_features gate ordering — were removed. They asserted that sentences
 * or headings exist in a markdown body, which pins prose, not behaviour
 * (TV-002c). The inline R5 `peekaboo-mcp` canary was also removed: it
 * duplicated scripts/lib/validate/check-peekaboo-driver-canary.mjs, whose own
 * spawnSync test (tests/lib/validate/check-peekaboo-driver-canary.test.mjs)
 * proves exit-1-on-violation against the same file.
 *
 * What remains is the frontmatter schema: the parse contract plus the two
 * behavioral flags (name identity + user-invocable:false) and the
 * block-scalar/inline-string contract that validate-plugin enforces.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SKILL_PATH = join(REPO_ROOT, 'skills', 'peekaboo-driver', 'SKILL.md');

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

describe('peekaboo-driver frontmatter schema', () => {
  it('frontmatter parses to a non-null object', () => {
    expect(frontmatter).not.toBeNull();
    expect(typeof frontmatter).toBe('object');
  });

  it('name is exactly "peekaboo-driver"', () => {
    expect(frontmatter?.['name']).toBe('peekaboo-driver');
  });

  it('user-invocable is exactly false (dispatch-only skill)', () => {
    expect(frontmatter?.['user-invocable']).toBe(false);
  });

  it('description is not a YAML block scalar (validate-plugin inline-string contract)', () => {
    expect(frontmatter?.['description']).not.toBe('__BLOCK_SCALAR__');
  });

  it('description is a single-line inline string (no embedded newline)', () => {
    const desc = frontmatter?.['description'] ?? '';
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.includes('\n')).toBe(false);
  });
});
