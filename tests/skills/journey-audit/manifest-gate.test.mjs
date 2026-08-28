// The bug this file catches: skills/journey-audit/SKILL.md loses its manifest
// HARD-GATE wording. The skill body IS the executable here — drop the gate and
// /journey-audit runs seven agents with no repo-specific truth key, and R5
// touches production without a written safety envelope. Nothing else in the
// suite reads this file, so the regression would be silent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SKILL_PATH = join(REPO_ROOT, 'skills/journey-audit/SKILL.md');
const TEMPLATE_PATH = join(REPO_ROOT, 'templates/_shared/journey-manifest.md');

const skill = readFileSync(SKILL_PATH, 'utf8');
const template = readFileSync(TEMPLATE_PATH, 'utf8');

const hardGate = skill.match(/<HARD-GATE>([\s\S]*?)<\/HARD-GATE>/)?.[1] ?? '';

describe('journey-audit manifest HARD-GATE', () => {
  it('carries a HARD-GATE block', () => {
    expect(hardGate).not.toBe('');
  });

  it('names the manifest the gate refuses without', () => {
    expect(hardGate).toContain('.orchestrator/journey-manifest.md');
  });

  it('names the SAFETY block that gates the production role R5', () => {
    expect(hardGate).toContain('SAFETY');
    expect(hardGate).toMatch(/R5/);
  });

  it('points the operator at the template it can copy', () => {
    expect(hardGate).toContain('templates/_shared/journey-manifest.md');
  });

  it('the template the gate points at actually carries a SAFETY section', () => {
    expect(template).toMatch(/^## SAFETY$/m);
  });
});
