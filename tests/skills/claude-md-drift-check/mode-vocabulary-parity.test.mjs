/**
 * tests/skills/claude-md-drift-check/mode-vocabulary-parity.test.mjs
 *
 * Cross-layer mode-vocabulary parity guard (issue #836).
 *
 * Three layers each declare a `mode` enum for blocking/non-blocking behaviour:
 *   - scripts/lib/config-schema.mjs   VAULT_MODE_VALUES = {strict, warn, off}
 *   - skills/vault-sync/validator.mjs MODE_VALUES = {hard, strict, warn, off,
 *     baseline, diff, full}; normalizes strict -> hard (canonical: 'hard')
 *   - skills/claude-md-drift-check/checker.mjs accepts {strict, hard, warn,
 *     off}; normalizes hard -> strict (canonical: 'strict')
 *
 * The two consuming CLIs normalise the SAME literal ('strict') to OPPOSITE
 * canonical values ('hard' vs 'strict') — that asymmetry is the durable drift
 * risk this test guards. It is deliberately NOT a set-equality assertion
 * (vault-sync legitimately carries extra modes — baseline/diff/full — that
 * checker.mjs has no reason to accept; see .claude/rules/testing.md
 * "Dynamic Artifact Counts" / count-drift guidance against over-pinning).
 * Instead: every member of the schema's VAULT_MODE_VALUES (the actual set a
 * `*.mode:` Session Config key is validated against) must be (a) ACCEPTED
 * by both CLIs (no invalid-mode infra-error) and (b) NORMALISED to that
 * CLI's own documented canonical value — a hardcoded literal per CLI, per
 * .claude/rules/testing.md "expected values MUST be hardcoded literals, not
 * computed in the test."
 *
 * Both CLIs are spawned against an EMPTY tmp directory with no markdown
 * files, which resolves to their respective "skipped" JSON shape without any
 * outcome-affecting content — status/exit code are always the "clean" values,
 * so the meaningful signal is exclusively the reported `mode` field.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VAULT_MODE_VALUES } from '../../../scripts/lib/config-schema.mjs';

const CHECKER = resolve(process.cwd(), 'skills/claude-md-drift-check/checker.mjs');
const VALIDATOR = resolve(process.cwd(), 'skills/vault-sync/validator.mjs');

// Hardcoded literals (NOT derived from the CLIs' own source) — the exact
// mapping each CLI documents for a value drawn from VAULT_MODE_VALUES.
const CHECKER_MODE_CANONICAL = { strict: 'strict', warn: 'warn', off: 'off' };
const VALIDATOR_MODE_CANONICAL = { strict: 'hard', warn: 'warn', off: 'off' };

function runNode(scriptPath, vaultDir, args) {
  const env = { ...process.env, VAULT_DIR: vaultDir, PATH: process.env.PATH };
  delete env.TYPECHECK_CMD;
  delete env.TEST_CMD;
  delete env.LINT_CMD;
  delete env.FILES;
  delete env.SESSION_START_REF;
  const r = spawnSync('node', [scriptPath, ...args], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function parseJson(out) {
  const line = out.trim().split('\n').find((l) => l.startsWith('{'));
  return JSON.parse(line);
}

let vault;

beforeEach(() => {
  // Deliberately empty — no CLAUDE.md, no .md files anywhere. Both CLIs
  // resolve this to a "skipped" (checker.mjs: no scope files matched;
  // validator.mjs: no vault) shape that reports `mode` without any
  // errors/warnings noise from unrelated checks.
  vault = mkdtempSync(join(tmpdir(), 'mode-vocab-parity-'));
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

describe('mode-vocabulary parity — VAULT_MODE_VALUES accepted + correctly normalised by both CLIs', () => {
  const modes = [...VAULT_MODE_VALUES];

  // Sanity: this is the ground truth this whole file is built against —
  // pin its literal shape so a schema edit that removes a member is visible
  // right here, not just as a silently-shrunk loop below.
  it('VAULT_MODE_VALUES is exactly {strict, warn, off}', () => {
    expect(modes.sort()).toEqual(['off', 'strict', 'warn']);
  });

  for (const mode of modes) {
    it(`checker.mjs accepts '${mode}' and normalises to '${CHECKER_MODE_CANONICAL[mode]}'`, () => {
      const r = runNode(CHECKER, vault, ['--mode', mode, '--skip-issue-refs']);
      expect(r.code).not.toBe(2);
      const j = parseJson(r.stdout);
      expect(j.mode).toBe(CHECKER_MODE_CANONICAL[mode]);
    });

    it(`validator.mjs accepts '${mode}' and normalises to '${VALIDATOR_MODE_CANONICAL[mode]}'`, () => {
      const r = runNode(VALIDATOR, vault, ['--mode', mode]);
      expect(r.code).not.toBe(2);
      const j = parseJson(r.stdout);
      expect(j.mode).toBe(VALIDATOR_MODE_CANONICAL[mode]);
    });
  }
});

describe('mode-vocabulary parity — negative twin: a value outside every vocabulary is rejected by both', () => {
  it('checker.mjs rejects an unknown mode value with exit 2', () => {
    const r = runNode(CHECKER, vault, ['--mode', 'not-a-real-mode', '--skip-issue-refs']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid --mode');
  });

  it('validator.mjs rejects an unknown mode value with exit 2', () => {
    const r = runNode(VALIDATOR, vault, ['--mode', 'not-a-real-mode']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid --mode value');
  });
});
