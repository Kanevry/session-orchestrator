/**
 * tests/skills/session-plan-routing.test.mjs
 *
 * Regression-guard tests for Issue #436: content-based routing table in
 * skills/session-plan/SKILL.md and the canary script that verifies it.
 *
 * Two layers:
 *   1. SKILL.md content assertions — text presence and regex patterns that
 *      would fail if the routing table was removed or an agent row was deleted.
 *   2. Canary script execution assertions — the canary must exit 0 with exactly
 *      9 PASS lines when SKILL.md is in a valid state.
 *
 * No subprocess needed for layer 1; spawnSync used for layer 2.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills/session-plan/SKILL.md');
const CANARY_PATH = path.join(PLUGIN_ROOT, 'scripts/lib/validate/check-session-plan-routing.mjs');

// ---------------------------------------------------------------------------
// Layer 1: SKILL.md routing table content
// ---------------------------------------------------------------------------

describe('session-plan content-based routing table (#436)', () => {
  describe('SKILL.md routing table content', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');

    it('contains content-based routing table heading', () => {
      expect(text).toContain('content-based routing table');
    });

    it('routes db-related tasks to db-specialist', () => {
      // The backtick-quoted `migration` keyword and the agent name must both
      // exist in the same routing table block. The /s flag allows . to span lines.
      expect(text).toMatch(/`migration`.*session-orchestrator:db-specialist/s);
    });

    it('routes ui-related tasks to ui-developer', () => {
      expect(text).toMatch(/`component`.*session-orchestrator:ui-developer/s);
    });

    it('routes security tasks to security-reviewer', () => {
      // The `security` keyword is in the security row, not in another context.
      expect(text).toMatch(/`security`.*session-orchestrator:security-reviewer/s);
    });

    it('routes test tasks to test-writer', () => {
      expect(text).toMatch(/`test`.*session-orchestrator:test-writer/s);
    });

    it('falls back to code-implementer when no keyword matches', () => {
      // The literal fallback row text must be present.
      expect(text).toMatch(/none of the above.*session-orchestrator:code-implementer/s);
    });

    it('contains all 5 expected agent resolutions', () => {
      // Each of these being present is independently load-bearing.
      // A missing row means tasks can never route to that specialist.
      expect(text).toContain('session-orchestrator:db-specialist');
      expect(text).toContain('session-orchestrator:ui-developer');
      expect(text).toContain('session-orchestrator:security-reviewer');
      expect(text).toContain('session-orchestrator:test-writer');
      expect(text).toContain('session-orchestrator:code-implementer');
    });

    it('lists db-domain keyword set in the routing table', () => {
      // 'migration' is the canonical first keyword in the db row.
      // Its presence confirms the db routing row was not truncated or moved.
      expect(text).toContain('`migration`');
    });

    it('lists ui-domain keyword set in the routing table', () => {
      // 'component' is the first keyword in the ui-developer routing row.
      expect(text).toContain('`component`');
    });

    it('lists security-domain keyword set in the routing table', () => {
      // 'security' is the first keyword in the security-reviewer routing row.
      expect(text).toContain('`security`');
    });

    it('lists test-domain keyword set in the routing table', () => {
      // 'test' is the first keyword in the test-writer routing row.
      expect(text).toContain('`test`');
    });
  });

  // ---------------------------------------------------------------------------
  // Layer 2: canary check-session-plan-routing.mjs
  // ---------------------------------------------------------------------------

  describe('canary check-session-plan-routing.mjs', () => {
    it('exists as a file on disk', () => {
      expect(existsSync(CANARY_PATH)).toBe(true);
    });

    it('exits 0 on current SKILL.md state (all 9 checks pass)', () => {
      const result = spawnSync(process.execPath, [CANARY_PATH, PLUGIN_ROOT], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Results: 9 passed, 0 failed');
    });

    it('reports exactly 9 PASS lines', () => {
      const result = spawnSync(process.execPath, [CANARY_PATH, PLUGIN_ROOT], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      const passCount = (result.stdout.match(/ {2}PASS:/g) || []).length;
      expect(passCount).toBe(9);
    });

    it('reports 0 FAIL lines when routing table is valid', () => {
      const result = spawnSync(process.execPath, [CANARY_PATH, PLUGIN_ROOT], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      const failCount = (result.stdout.match(/ {2}FAIL:/g) || []).length;
      expect(failCount).toBe(0);
    });

    it('exits 1 when called without a plugin-root argument', () => {
      const result = spawnSync(process.execPath, [CANARY_PATH], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      // Missing argument → usage error → exit 1
      expect(result.status).toBe(1);
    });

    it('exits 1 + reports FAIL when routing table is removed (negative fixture)', () => {
      // Negative fixture per W4-Q3 HIGH gap finding: verify the canary actually
      // goes RED when the routing table is missing. Without this, the canary's
      // green status is unprovable.
      const tmp = mkdtempSync(path.join(tmpdir(), 'session-plan-routing-negative-'));
      try {
        const skillDir = path.join(tmp, 'skills/session-plan');
        mkdirSync(skillDir, { recursive: true });
        // Write a SKILL.md WITHOUT the routing table content — should fail all 6 content checks
        const brokenSkill = [
          '---',
          'name: session-plan',
          'description: Test fixture with no routing table',
          '---',
          '',
          '# Test fixture',
          '',
          'No routing table here. Nothing referencing db-specialist, ui-developer, or other agents.',
        ].join('\n');
        writeFileSync(path.join(skillDir, 'SKILL.md'), brokenSkill);

        const result = spawnSync(process.execPath, [CANARY_PATH, tmp], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/ {2}FAIL:/);
        // At least 6 FAIL lines (one per missing agent identifier + heading)
        const failCount = (result.stdout.match(/ {2}FAIL:/g) || []).length;
        expect(failCount).toBeGreaterThanOrEqual(6);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
