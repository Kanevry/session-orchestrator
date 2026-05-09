/**
 * tests/lib/harness-audit/categories/category7.test.mjs
 *
 * Vitest suite for scripts/lib/harness-audit/categories/category7.mjs
 *
 * Category 7: Policy Freshness — checks blocked-commands-schema,
 * blocked-commands-min-rules, parallel-sessions-rules, ecosystem-schema-optional.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory7 } from '../../../../scripts/lib/harness-audit/categories/category7.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'cat7-'));
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** Build a valid blocked-commands.json with n well-formed rules. */
function validBlockedCommands(n = 13) {
  const rules = Array.from({ length: n }, (_, i) => ({
    id: `rule-${i + 1}`,
    pattern: `^dangerous-cmd-${i + 1}`,
    severity: 'block',
    description: `Block dangerous command ${i + 1}`,
  }));
  return JSON.stringify({ version: 1, rationale: 'Safety', rules });
}

/** Write parallel-sessions.md with all 4 PSA codes. */
function writeParallelSessionsMd(root, content) {
  ensureDir(join(root, '.claude/rules'));
  writeFileSync(join(root, '.claude/rules/parallel-sessions.md'), content);
}

/** Scaffold a fully-passing category 7 run. */
function scaffoldHappyPath(root) {
  ensureDir(join(root, '.orchestrator/policy'));
  writeFileSync(
    join(root, '.orchestrator/policy/blocked-commands.json'),
    validBlockedCommands(13),
  );
  writeParallelSessionsMd(
    root,
    'PSA-001 — Aware\nPSA-002 — Pause\nPSA-003 — Destructive\nPSA-004 — Commit\n',
  );
  // No ecosystem.schema.json — optional, absent is a pass
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runCategory7', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Happy path — all 4 checks pass (ecosystem.schema.json absent = pass)
  // -------------------------------------------------------------------------
  it('returns 4 passing checks for a valid policy setup (no ecosystem schema)', () => {
    scaffoldHappyPath(root);

    const checks = runCategory7(root);

    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checks.map((c) => c.check_id)).toEqual([
      'blocked-commands-schema',
      'blocked-commands-min-rules',
      'parallel-sessions-rules',
      'ecosystem-schema-optional',
    ]);
  });

  // -------------------------------------------------------------------------
  // Failure case — blocked-commands.json has malformed JSON
  // -------------------------------------------------------------------------
  it('fails blocked-commands-schema when blocked-commands.json is not valid JSON', () => {
    ensureDir(join(root, '.orchestrator/policy'));
    writeFileSync(
      join(root, '.orchestrator/policy/blocked-commands.json'),
      '{ "version": 1, "rationale": "test", "rules": [INVALID',
    );

    const checks = runCategory7(root);
    const schemaCheck = checks.find((c) => c.check_id === 'blocked-commands-schema');

    expect(schemaCheck.status).toBe('fail');
    expect(schemaCheck.evidence.version).toBeNull();
    expect(schemaCheck.message).toContain('invalid JSON');
  });

  // -------------------------------------------------------------------------
  // Failure case — blocked-commands.json missing required top-level fields
  // -------------------------------------------------------------------------
  it('fails blocked-commands-schema when required fields are absent', () => {
    ensureDir(join(root, '.orchestrator/policy'));
    // Missing "rationale" and "rules"
    writeFileSync(
      join(root, '.orchestrator/policy/blocked-commands.json'),
      JSON.stringify({ version: 1 }),
    );

    const checks = runCategory7(root);
    const schemaCheck = checks.find((c) => c.check_id === 'blocked-commands-schema');

    expect(schemaCheck.status).toBe('fail');
    expect(schemaCheck.message).toContain('rationale');
  });

  // -------------------------------------------------------------------------
  // Edge case — fewer than 10 rules fails blocked-commands-min-rules
  // -------------------------------------------------------------------------
  it('fails blocked-commands-min-rules when fewer than 10 rules are present', () => {
    ensureDir(join(root, '.orchestrator/policy'));
    writeFileSync(
      join(root, '.orchestrator/policy/blocked-commands.json'),
      validBlockedCommands(5), // only 5 rules — below the 10-rule threshold
    );
    writeParallelSessionsMd(
      root,
      'PSA-001\nPSA-002\nPSA-003\nPSA-004\n',
    );

    const checks = runCategory7(root);
    const minRulesCheck = checks.find((c) => c.check_id === 'blocked-commands-min-rules');

    expect(minRulesCheck.status).toBe('fail');
    expect(minRulesCheck.evidence.ruleCount).toBe(5);
    expect(minRulesCheck.message).toContain('≥10');
  });

  // -------------------------------------------------------------------------
  // Edge case — rule with invalid severity fails blocked-commands-min-rules
  // -------------------------------------------------------------------------
  it('fails blocked-commands-min-rules when a rule has severity != "block"|"warn"', () => {
    ensureDir(join(root, '.orchestrator/policy'));
    const rules = Array.from({ length: 12 }, (_, i) => ({
      id: `rule-${i + 1}`,
      pattern: `^cmd-${i + 1}`,
      severity: i === 0 ? 'deny' : 'block', // "deny" is not a valid severity
    }));
    writeFileSync(
      join(root, '.orchestrator/policy/blocked-commands.json'),
      JSON.stringify({ version: 1, rationale: 'Safety', rules }),
    );
    writeParallelSessionsMd(root, 'PSA-001\nPSA-002\nPSA-003\nPSA-004\n');

    const checks = runCategory7(root);
    const minRulesCheck = checks.find((c) => c.check_id === 'blocked-commands-min-rules');

    expect(minRulesCheck.status).toBe('fail');
    // 12 total rules but only 11 are well-formed (the one with "deny" severity fails)
    expect(minRulesCheck.evidence.wellFormedCount).toBe(11);
    expect(minRulesCheck.evidence.ruleCount).toBe(12);
  });

  // -------------------------------------------------------------------------
  // Failure case — parallel-sessions.md missing PSA codes
  // -------------------------------------------------------------------------
  it('fails parallel-sessions-rules when PSA codes are missing from parallel-sessions.md', () => {
    scaffoldHappyPath(root);

    // Overwrite with content missing PSA-003 and PSA-004
    writeParallelSessionsMd(root, 'PSA-001 — Aware\nPSA-002 — Pause\n');

    const checks = runCategory7(root);
    const psaCheck = checks.find((c) => c.check_id === 'parallel-sessions-rules');

    expect(psaCheck.status).toBe('fail');
    expect(psaCheck.evidence.psaCodesFound).toContain('PSA-001');
    expect(psaCheck.evidence.psaCodesFound).toContain('PSA-002');
    expect(psaCheck.evidence.psaCodesFound).not.toContain('PSA-003');
    expect(psaCheck.evidence.psaCodesFound).not.toContain('PSA-004');
    expect(psaCheck.message).toContain('PSA-003');
  });

  // -------------------------------------------------------------------------
  // Edge case — ecosystem.schema.json present but invalid JSON fails
  // -------------------------------------------------------------------------
  it('fails ecosystem-schema-optional when ecosystem.schema.json exists with invalid JSON', () => {
    scaffoldHappyPath(root);

    writeFileSync(
      join(root, '.orchestrator/policy/ecosystem.schema.json'),
      '{ broken json >>>',
    );

    const checks = runCategory7(root);
    const ecoCheck = checks.find((c) => c.check_id === 'ecosystem-schema-optional');

    expect(ecoCheck.status).toBe('fail');
    expect(ecoCheck.evidence.present).toBe(true);
    expect(ecoCheck.evidence.valid).toBe(false);
    expect(ecoCheck.message).toContain('invalid JSON');
  });
});
