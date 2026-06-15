/**
 * tests/unit/harness-audit-category9.test.mjs
 *
 * Unit tests for Category 9: Skill-Health Surfacing (#648).
 *   scripts/lib/harness-audit/categories/category9.mjs — runCategory9(root)
 *
 * The load-bearing invariant under test: NON-ADOPTION IS A HEALTHY STATE.
 * A repo with no skill-health telemetry and no scorer module MUST score full
 * points (10) on every check. Reduced points appear only on a genuine defect
 * (malformed telemetry lines, or a present-but-broken scorer export).
 *
 * Fixtures are tmp-dir-based (mkdtempSync) and cleaned up in afterEach. No
 * hardcoded home path; the tmp root is derived from os.tmpdir(). Every expected
 * value is a hardcoded literal per .claude/rules/testing.md.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory9 } from '@lib/harness-audit/categories.mjs';

// ---------------------------------------------------------------------------
// tmp-dir registry — cleaned up after each test
// ---------------------------------------------------------------------------

let _tmpdirs = [];

afterEach(() => {
  for (const d of _tmpdirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  _tmpdirs = [];
});

/** Create a fresh isolated tmp dir for one test. */
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'harness-audit-cat9-'));
  _tmpdirs.push(d);
  return d;
}

/** Recursively create parent dirs and write a file under root. */
function write(root, relPath, content) {
  const parts = relPath.split('/');
  if (parts.length > 1) {
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(join(root, relPath), content, 'utf8');
}

/** Sum points across the checks array. */
function totalPoints(checks) {
  return checks.reduce((sum, c) => sum + (c.points ?? 0), 0);
}

const TELEMETRY_REL = '.orchestrator/metrics/skill-invocations.jsonl';
const SCORER_REL = 'scripts/lib/skill-health/score.mjs';
const JOIN_REL = 'scripts/lib/skill-health/join.mjs';

// ---------------------------------------------------------------------------
// Non-adoption is healthy: empty repo scores full 10/10
// ---------------------------------------------------------------------------

describe('category 9: non-adoption is a healthy state', () => {
  it('returns exactly 3 checks', () => {
    const checks = runCategory9(tmp());
    expect(checks).toHaveLength(3);
  });

  it('all 3 checks pass and points sum to 10 when telemetry and scorer are absent', () => {
    const checks = runCategory9(tmp());
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(totalPoints(checks)).toBe(10);
  });

  it('c9.1 telemetry-hygiene passes 4/4 with a "feature not adopted" message when telemetry is absent', () => {
    const checks = runCategory9(tmp());
    const c91 = checks.find((c) => c.check_id === 'skill-telemetry-hygiene');
    expect(c91).toBeDefined();
    expect(c91.status).toBe('pass');
    expect(c91.points).toBe(4);
    expect(c91.message).toBe('no skill-invocations telemetry yet (feature not adopted)');
  });

  it('c9.2 scorer-wired passes 3/3 with a "not adopted" message when score.mjs is absent', () => {
    const checks = runCategory9(tmp());
    const c92 = checks.find((c) => c.check_id === 'skill-scorer-wired');
    expect(c92).toBeDefined();
    expect(c92.status).toBe('pass');
    expect(c92.points).toBe(3);
    expect(c92.message).toBe('skill-health scoring not adopted');
  });

  it('c9.3 advisory passes 3/3 with an "insufficient signal" note when modules are absent', () => {
    const checks = runCategory9(tmp());
    const c93 = checks.find((c) => c.check_id === 'skill-health-advisory');
    expect(c93).toBeDefined();
    expect(c93.status).toBe('pass');
    expect(c93.points).toBe(3);
    expect(c93.message).toBe('no advisory verdicts (insufficient signal)');
  });
});

// ---------------------------------------------------------------------------
// Malformed telemetry → reduced points (genuine defect), still pass status
// ---------------------------------------------------------------------------

describe('category 9: malformed telemetry reduces c9.1 points', () => {
  it('c9.1 drops to 2/4 (status pass) and names the malformed count for 1 valid + 1 garbage line', () => {
    const root = tmp();
    const validLine = JSON.stringify({ event: 'selected', schema_version: 1, skill: 'plan' });
    write(root, TELEMETRY_REL, validLine + '\n' + 'this is not json {{{' + '\n');

    const checks = runCategory9(root);
    const c91 = checks.find((c) => c.check_id === 'skill-telemetry-hygiene');
    expect(c91).toBeDefined();
    expect(c91.status).toBe('pass');
    expect(c91.points).toBeLessThan(4);
    expect(c91.points).toBe(2);
    expect(c91.message).toBe('1 of 2 skill-invocation line(s) malformed (1 valid)');
  });

  it('c9.1 evidence records the malformed count', () => {
    const root = tmp();
    const validLine = JSON.stringify({ event: 'selected', schema_version: 1, skill: 'plan' });
    write(root, TELEMETRY_REL, validLine + '\n' + 'garbage-line' + '\n');

    const checks = runCategory9(root);
    const c91 = checks.find((c) => c.check_id === 'skill-telemetry-hygiene');
    expect(c91.evidence).toEqual({ present: true, total: 2, valid: 1, malformed: 1 });
  });

  it('c9.1 passes 4/4 when every telemetry line is valid (event + schema_version)', () => {
    const root = tmp();
    const a = JSON.stringify({ event: 'selected', schema_version: 1, skill: 'plan' });
    const b = JSON.stringify({ event: 'applied', schema_version: 1, skill: 'plan' });
    write(root, TELEMETRY_REL, a + '\n' + b + '\n');

    const checks = runCategory9(root);
    const c91 = checks.find((c) => c.check_id === 'skill-telemetry-hygiene');
    expect(c91.status).toBe('pass');
    expect(c91.points).toBe(4);
    expect(c91.message).toBe('2/2 skill-invocation line(s) valid (event + schema_version), 0 malformed');
  });
});

// ---------------------------------------------------------------------------
// c9.2: scorer present with the right export → full points (grep detection)
// ---------------------------------------------------------------------------

describe('category 9: scorer-wired grep detection', () => {
  it('c9.2 passes 3/3 when score.mjs contains "export function scoreSkillHealth"', () => {
    const root = tmp();
    // Minimal stub — we test the string-grep detection, not the real scorer.
    write(root, SCORER_REL, 'export function scoreSkillHealth() { return []; }\n');

    const checks = runCategory9(root);
    const c92 = checks.find((c) => c.check_id === 'skill-scorer-wired');
    expect(c92).toBeDefined();
    expect(c92.status).toBe('pass');
    expect(c92.points).toBe(3);
    expect(c92.message).toBe('scripts/lib/skill-health/score.mjs exports scoreSkillHealth');
  });

  it('c9.2 fails 0/3 when score.mjs exists but the scoreSkillHealth export is gone (wiring regression)', () => {
    const root = tmp();
    write(root, SCORER_REL, 'export function somethingElse() { return []; }\n');

    const checks = runCategory9(root);
    const c92 = checks.find((c) => c.check_id === 'skill-scorer-wired');
    expect(c92).toBeDefined();
    expect(c92.status).toBe('fail');
    expect(c92.points).toBe(0);
    expect(c92.message).toBe('score.mjs present but does not export scoreSkillHealth (wiring regression)');
  });
});

// ---------------------------------------------------------------------------
// Security N2b: c9.3 must NOT import (execute) the AUDITED repo's code.
// The advisory worker imports the AUDITOR's OWN trusted skill-health modules and
// runs them over the target's telemetry DATA files. A malicious target repo that
// plants its own join.mjs/score.mjs MUST never have that code executed during an
// audit. We prove non-execution with a side-effect sentinel: the planted target
// modules would write a sentinel file on import — it must remain absent.
// ---------------------------------------------------------------------------

describe('category 9: N2b — c9.3 never executes audited-repo code', () => {
  it('does NOT execute the target repo planted join.mjs/score.mjs (no side-effect sentinel written)', () => {
    const root = tmp();
    const sentinel = join(root, 'PWNED_BY_TARGET_CODE.txt');

    // Telemetry present so c9.3 attempts to compute the advisory tally.
    const line = JSON.stringify({ event: 'selected', schema_version: 1, skill: 'plan', session_id: 's1' });
    write(root, TELEMETRY_REL, line + '\n');
    write(root, '.orchestrator/metrics/sessions.jsonl', JSON.stringify({ session_id: 's1', agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 } }) + '\n');

    // Plant MALICIOUS target modules: importing either writes the sentinel file.
    // If c9.3 imported target code (the pre-N2b vulnerability) the sentinel would
    // appear. The auditor must import its OWN modules instead → sentinel absent.
    const poison =
      "import { writeFileSync } from 'node:fs';\n" +
      `writeFileSync(${JSON.stringify(sentinel)}, 'pwned');\n` +
      'export async function joinSkillOutcomes() { return { bySkill: {} }; }\n' +
      'export function scoreSkillHealth() { return []; }\n';
    write(root, JOIN_REL, poison);
    write(root, SCORER_REL, poison);

    const checks = runCategory9(root);
    const c93 = checks.find((c) => c.check_id === 'skill-health-advisory');

    // The audited repo's code was NEVER imported/executed.
    expect(existsSync(sentinel)).toBe(false);

    // c9.3 is structurally pass-only and still scores full 3/3.
    expect(c93).toBeDefined();
    expect(c93.status).toBe('pass');
    expect(c93.points).toBe(3);
  });

  it('c9.3 still passes 3/3 when the target ships a present-but-broken score.mjs (degrades to advisory pass)', () => {
    const root = tmp();
    // Telemetry present + target modules that THROW on import. The auditor's own
    // modules are used instead, so the throw never reaches the audit.
    const line = JSON.stringify({ event: 'selected', schema_version: 1, skill: 'plan', session_id: 's1' });
    write(root, TELEMETRY_REL, line + '\n');
    write(root, JOIN_REL, "throw new Error('target join import boom');\n");
    write(root, SCORER_REL, "throw new Error('target score import boom');\n");

    const checks = runCategory9(root);
    const c93 = checks.find((c) => c.check_id === 'skill-health-advisory');

    expect(c93).toBeDefined();
    expect(c93.status).toBe('pass');
    expect(c93.points).toBe(3);
  });
});
