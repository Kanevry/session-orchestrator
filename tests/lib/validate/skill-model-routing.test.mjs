/**
 * tests/lib/validate/skill-model-routing.test.mjs
 *
 * Verifies that every skill's SKILL.md frontmatter declares a `model:` field
 * from the allowed tier set, that the distribution matches expected floor/ceiling
 * bounds, and that critical reasoning skills are opus while lookup/triage skills
 * are haiku (issue #434).
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

const VALID_MODELS = ['opus', 'sonnet', 'haiku', 'inherit'];

function getModel(filePath) {
  const fm = getFrontmatter(filePath);
  const match = fm.match(/^model:\s*(.+?)$/m);
  return match ? match[1].trim() : null;
}

function getSkillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_shared')
    .map((d) => d.name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skill model: frontmatter routing (#434)', () => {
  const skills = getSkillDirs();

  it('every skill has model: set to a valid tier', () => {
    for (const skill of skills) {
      const model = getModel(path.join(SKILLS_DIR, skill, 'SKILL.md'));
      expect(model, `${skill} should have model:`).not.toBeNull();
      expect(VALID_MODELS, `${skill} model: ${model} should be valid`).toContain(model);
    }
  });

  it('distribution matches expected mix (floor/ceiling)', () => {
    const distribution = { opus: 0, sonnet: 0, haiku: 0, inherit: 0 };
    for (const skill of skills) {
      const model = getModel(path.join(SKILLS_DIR, skill, 'SKILL.md'));
      if (model && distribution[model] !== undefined) distribution[model]++;
    }

    // Floor/ceiling per test-quality.md — distribution may shift over time
    expect(distribution.opus).toBeGreaterThanOrEqual(2);
    expect(distribution.opus).toBeLessThanOrEqual(10);
    expect(distribution.sonnet).toBeGreaterThanOrEqual(8);
    expect(distribution.haiku).toBeGreaterThanOrEqual(8);
    expect(distribution.inherit).toBeGreaterThanOrEqual(5);
  });

  it('critical reasoning skills are opus', () => {
    const critical = ['session-plan', 'architecture', 'plan'];
    for (const skill of critical) {
      const model = getModel(path.join(SKILLS_DIR, skill, 'SKILL.md'));
      expect(model, `${skill} should be opus tier`).toBe('opus');
    }
  });

  it('lookup/triage skills are haiku', () => {
    const triage = ['quality-gates', 'gitlab-ops', 'mode-selector', 'vault-sync'];
    for (const skill of triage) {
      const model = getModel(path.join(SKILLS_DIR, skill, 'SKILL.md'));
      expect(model, `${skill} should be haiku tier`).toBe('haiku');
    }
  });
});
