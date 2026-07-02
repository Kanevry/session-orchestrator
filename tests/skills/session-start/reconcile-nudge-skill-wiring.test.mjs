/**
 * tests/skills/session-start/reconcile-nudge-skill-wiring.test.mjs
 *
 * Regression: Epic #723 B1 reconcile-nudge banner wiring in session-start
 * Phase 4. The banner block must remain present, sit between the
 * instruction-budget block and the "All banners are non-blocking" terminator,
 * reference the helper module path, and document the message shape + the
 * pre-#723 absent-plugin skip clause.
 *
 * Without this snapshot test the doc wiring is invisible to CI — the helper
 * (`scripts/lib/reconcile-nudge-banner.mjs`) ships green even when SKILL.md
 * drops the wiring, and the banner stops rendering in production.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills/session-start/SKILL.md');

describe('reconcile-nudge banner wiring (#723, session-start Phase 4)', () => {
  it('skills/session-start/SKILL.md exists at the expected path', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('Phase 4 references the reconcile-nudge helper module path', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('scripts/lib/reconcile-nudge-banner.mjs');
  });

  it('Phase 4 invokes checkReconcileNudge with repoRoot and config', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('checkReconcileNudge({ repoRoot, config: $CONFIG })');
  });

  it('reconcile-nudge block sits between the instruction-budget block and the "All banners are non-blocking" terminator', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    const idxInstructionBudget = body.indexOf('instruction-budget-guard.mjs');
    const idxReconcileNudge = body.indexOf('reconcile-nudge-banner.mjs');
    const idxTerminator = body.indexOf('All banners are non-blocking');

    expect(idxInstructionBudget).toBeGreaterThan(-1);
    expect(idxReconcileNudge).toBeGreaterThan(-1);
    expect(idxTerminator).toBeGreaterThan(-1);
    expect(idxInstructionBudget).toBeLessThan(idxReconcileNudge);
    expect(idxReconcileNudge).toBeLessThan(idxTerminator);
  });

  it('block documents the nudge message shape ("active learnings", "rule-eligible", "last reconcile run")', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('active learnings');
    expect(body).toContain('rule-eligible');
    expect(body).toContain('last reconcile run');
    expect(body).toContain('run /reconcile to convert learnings into rules');
  });

  it('block documents the reconcile.enabled advisory parenthetical', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('reconcile.enabled: false');
    expect(body).toContain('banner is advisory only');
  });

  it('block introduces no new Session Config key (advisory-only note is present)', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('Introduces NO new Session Config key');
  });

  it('the absent-plugin skip clause includes reconcile-nudge-banner.mjs (pre-#723 plugin install)', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toMatch(/reconcile-nudge-banner\.mjs.*is absent \(pre-#723 plugin install\)/);
  });
});
