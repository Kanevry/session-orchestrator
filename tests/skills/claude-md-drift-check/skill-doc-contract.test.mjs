/**
 * Static contract checks for skills/claude-md-drift-check/SKILL.md.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL_PATH = fileURLToPath(
  new URL('../../../skills/claude-md-drift-check/SKILL.md', import.meta.url),
);
const skill = readFileSync(SKILL_PATH, 'utf8');

describe('claude-md-drift-check skill docs', () => {
  it('documents every generated-rule and rule-scoping skip flag', () => {
    expect(skill).toContain('--skip-generated-rule-staleness');
    expect(skill).toContain('--skip-rule-scoping');
  });

  it('includes AGENTS.md in Session Config include-path examples', () => {
    const samples = skill.match(/include-paths:[\s\S]*?check-path-resolver:/g) ?? [];
    expect(samples.length).toBeGreaterThanOrEqual(1);
    for (const sample of samples) {
      expect(sample).toContain('CLAUDE.md');
      expect(sample).toContain('AGENTS.md');
    }
  });
});
