/**
 * tests/lib/validate/skill-description-quality.test.mjs
 *
 * Verifies that skill descriptions meet the quality bar established in W2-I5
 * (issue #432): enriched 4 short skills have substantive descriptions
 * (≥ 250 chars), all skills stay within the 1024-char platform limit, and
 * the majority of skills use a verb-first "Use..." opener.
 *
 * Parser note (CORRECTED 2026-08-15). This file used to extract the description
 * with a hand-rolled regex, and the header you are reading claimed that handled
 * block scalars "correctly". It did not. The terminating lookahead
 * `(?=^\S|^---|$)` was compiled with `/m`, where the `$` alternative matches at
 * EVERY line end — so the match stopped after the FIRST folded line. Measured on
 * files that were never edited: session-start 97 chars vs 329 of real YAML,
 * autopilot 107 vs 555, bootstrap 98 vs 341. The `>= 250` assertion below was
 * therefore VACUOUS for every skill already using the block-scalar form: it
 * measured an opening line and passed.
 *
 * It surfaced only because repairing 12 unparseable frontmatter blocks moved
 * four more skills into the same blind spot and finally pushed the truncated
 * value under the floor. A green assertion is not evidence that it bites.
 *
 * The fix is the same lesson the repaired files teach: read structured data with
 * a parser, never a regex. `yaml.load` is now the single reader, so both the
 * inline and the block form resolve to the value the platform actually sees.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

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
  if (!fm) return '';

  // ONE reader for both the inline and the block-scalar form — see the header.
  // CORE_SCHEMA matches scripts/lib/validate/check-commands.mjs and
  // check-skills.mjs, so this test and the gates agree on what a frontmatter
  // block means. A parse failure returns '' and lets the length assertions
  // report it; check-skills.mjs owns the "is it parseable at all" verdict.
  let doc;
  try {
    doc = yaml.load(fm, { schema: yaml.CORE_SCHEMA });
  } catch {
    return '';
  }
  if (!doc || typeof doc !== 'object') return '';

  const value = doc.description;
  if (typeof value !== 'string') return '';
  // Folded scalars keep a trailing newline; collapse the residue so the length
  // measured here is the length a reader sees.
  return value.replace(/\s+/g, ' ').trim();
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
