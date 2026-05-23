/**
 * tests/lib/wave-context.test.mjs
 *
 * G-L1 (issue #553, LOW) — wave-context.mjs has no direct test.
 *
 * SUT: scripts/lib/wave-context.mjs (~30 LOC)
 *   - export const WAVE_AGENT_ENV_VAR = 'SO_WAVE_AGENT'
 *   - export const WAVE_AGENT_ENV_VALUE = '1'
 *   - export function isWaveAgentContext() => process.env.SO_WAVE_AGENT === '1'
 *
 * Coverage scope:
 *   1. Exported constant literal values (anchor — refactors that rename the
 *      env-var or shift the value would break call-sites in scripts/memory-propose.mjs
 *      Step 2b and the wave-executor harness).
 *   2. isWaveAgentContext() truth-table:
 *      - true when env === '1'
 *      - false when env is unset
 *      - false for each documented strict-equality variant ('0', 'true', '01',
 *        ' 1' leading-space, '1\n' trailing-newline, '' empty-string)
 *
 * Non-overlap with tests/scripts/memory-propose.test.mjs Section E (#549 G8):
 *   - Section E spawns CHILD processes via runCli and verifies the CLI exit
 *     code (3 = rejected-wrong-context). That tests the integration of the
 *     guard at the CLI boundary.
 *   - This file tests the helper function DIRECTLY via in-process env-var
 *     mutation. Different scope, no duplication.
 *
 * Parallel-test isolation:
 *   - beforeEach saves the current process.env.SO_WAVE_AGENT to a local var.
 *   - afterEach restores it. MANDATORY — without this, vitest worker pools
 *     would cross-contaminate other tests (e.g., memory-propose.test.mjs)
 *     that depend on the env-var.
 *
 * Test-quality (.claude/rules/test-quality.md):
 *   - Hardcoded literal expectations — no computed expected values
 *   - One AAA per test, cyclomatic complexity = 1 (it.each() for variants)
 *   - Falsification-checked: each test fails if the targeted code path is
 *     mutated (constant rename, loose equality, env-var renamed)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  WAVE_AGENT_ENV_VAR,
  WAVE_AGENT_ENV_VALUE,
  isWaveAgentContext,
} from '@lib/wave-context.mjs';

describe('wave-context — exported constants (G-L1, #553)', () => {
  // L1.1 — WAVE_AGENT_ENV_VAR pins the contract name. Call-sites grep this
  // literal in CLAUDE.md, scripts/memory-propose.mjs, and the wave-executor
  // skill body; a silent rename would break the dispatch chain.
  it('exports WAVE_AGENT_ENV_VAR as literal "SO_WAVE_AGENT"', () => {
    expect(WAVE_AGENT_ENV_VAR).toBe('SO_WAVE_AGENT');
  });

  // L1.2 — WAVE_AGENT_ENV_VALUE pins the strict-equality target. The
  // contract is "=== '1'" (string), not 1 (number) or true (boolean).
  it('exports WAVE_AGENT_ENV_VALUE as literal "1"', () => {
    expect(WAVE_AGENT_ENV_VALUE).toBe('1');
  });
});

describe('wave-context — isWaveAgentContext() truth-table (G-L1, #553)', () => {
  // Save/restore SO_WAVE_AGENT around every test so parallel vitest workers
  // and unrelated tests downstream of this file are not contaminated.
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.SO_WAVE_AGENT;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.SO_WAVE_AGENT;
    } else {
      process.env.SO_WAVE_AGENT = savedEnv;
    }
  });

  // L1.3 — Positive case: env === '1' → true.
  // Falsification: if the function returned constant `false` or compared
  // against a different value, this test would fail.
  it('returns true when SO_WAVE_AGENT === "1"', () => {
    process.env.SO_WAVE_AGENT = '1';

    expect(isWaveAgentContext()).toBe(true);
  });

  // L1.4 — Unset env → false (delete property, not just empty-string).
  // Falsification: if the function used `==` (loose equality with undefined
  // accidentally matching), this would return true.
  it('returns false when SO_WAVE_AGENT is unset', () => {
    delete process.env.SO_WAVE_AGENT;

    expect(isWaveAgentContext()).toBe(false);
  });

  // L1.5 — Strict-equality variants table.
  //
  // Documented in scripts/lib/wave-context.mjs:23-28:
  //   "Strict equality semantics (=== '1') are intentional: leading
  //    whitespace, trailing newline, '01', 'true', '0', undefined, and
  //    empty string all return false."
  //
  // Each variant exercises a specific class of near-miss that a loose-
  // equality refactor would silently allow:
  //   '0'       → boolean-coerced or numeric-compared
  //   'true'    → boolean-string mistake
  //   '01'      → numeric "1" with leading zero (parseInt('01') === 1)
  //   ' 1'      → leading-whitespace shell-quoting accident
  //   '1\n'     → trailing-newline from shell heredoc
  //   ''        → empty-string falsy short-circuit
  //
  // Falsification: if the function were rewritten as
  //   `process.env.SO_WAVE_AGENT == '1'` (loose) OR
  //   `process.env.SO_WAVE_AGENT.trim() === '1'` (auto-trim) OR
  //   `Boolean(process.env.SO_WAVE_AGENT)` (truthy check),
  // then one or more variants below would return true and the test row
  // would fail.
  it.each([
    ['0'],
    ['true'],
    ['01'],
    [' 1'],
    ['1\n'],
    [''],
  ])('returns false for variant %j', (variant) => {
    process.env.SO_WAVE_AGENT = variant;

    expect(isWaveAgentContext()).toBe(false);
  });
});
