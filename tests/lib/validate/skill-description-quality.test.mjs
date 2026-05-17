/**
 * tests/lib/validate/skill-description-quality.test.mjs
 *
 * Verifies that skill descriptions meet the quality bar established in W2-I5
 * (issue #432): enriched 4 short skills have substantive descriptions
 * (≥ 250 chars), all skills stay within the 1024-char platform limit, and
 * the majority of skills use a verb-first "Use..." opener.
 *
 * Parser note: YAML block-scalar descriptions (description: >\n  text...)
 * require special handling — the inline regex `^description:\s*(.+?)$`
 * matches the literal `>` before the block regex can fire. The getDescription
 * helper here handles both forms correctly by checking for the `>` sentinel
 * before dispatching to the block-scalar parser.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../../..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFrontmatter(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

function getDescription(filePath) {
  const fm = getFrontmatter(filePath);

  // Block-scalar form: `description: >` or `description: |` followed by
  // indented lines. Detect the sentinel first so the inline regex below
  // doesn't swallow the `>` character as the description value.
  const blockSentinel = fm.match(/^description:\s*[>|]\s*$/m);
  if (blockSentinel) {
    const blockMatch = fm.match(/^description:\s*[>|]\s*\n([\s\S]*?)(?=^\S|^---|$)/m);
    if (blockMatch) {
      return blockMatch[1].replace(/^[ \t]+/gm, '').replace(/\n+/g, ' ').trim();
    }
  }

  // Inline form: `description: some text`
  const inlineMatch = fm.match(/^description:\s*(.+?)$/m);
  if (inlineMatch) return inlineMatch[1].trim();

  return '';
}

function getSkillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_shared')
    .map((d) => d.name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skill description quality (#432)', () => {
  const skills = getSkillDirs();

  it('skill count in expected range (floor/ceiling)', () => {
    expect(skills.length).toBeGreaterThanOrEqual(30);
    expect(skills.length).toBeLessThanOrEqual(60);
  });

  describe('per-skill quality checks', () => {
    skills.forEach((skill) => {
      const skillMd = path.join(SKILLS_DIR, skill, 'SKILL.md');
      const description = getDescription(skillMd);

      it(`${skill}: description ≤ 1024 chars`, () => {
        expect(description.length).toBeLessThanOrEqual(1024);
      });
    });
  });

  describe('enriched short skills (W2-I5 explicit work)', () => {
    const enriched = ['vault-mirror', 'vault-sync', 'gitlab-portfolio', 'gitlab-ops'];
    enriched.forEach((skill) => {
      it(`${skill}: description ≥ 250 chars (post-enrichment)`, () => {
        const desc = getDescription(path.join(SKILLS_DIR, skill, 'SKILL.md'));
        expect(desc.length).toBeGreaterThanOrEqual(250);
      });
    });
  });

  it('majority of skills (≥ 25) have verb-first "Use..." opener', () => {
    const count = skills.reduce((acc, s) => {
      const desc = getDescription(path.join(SKILLS_DIR, s, 'SKILL.md'));
      return acc + (/^Use\b/.test(desc) ? 1 : 0);
    }, 0);
    expect(count).toBeGreaterThanOrEqual(25);
  });
});
