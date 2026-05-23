/**
 * tests/scripts/parse-config.memory-proposals.test.mjs
 *
 * E2E smoke tests for memory.proposals after the M1 refactor that moved
 * the parser from parse-config.mjs into scripts/lib/config/memory.mjs
 * (issue #544).
 *
 * The unit-test surface for `_parseMemory` lives in
 * tests/lib/config/memory.test.mjs.  This file keeps only two checks that
 * are valuable at the script-pipeline level:
 *
 *   1. Contract test — the parse-config.mjs JSON output exposes the
 *      memory.proposals shape via parseSessionConfig (refactor parity).
 *
 *   2. Outer-validator interaction — the flat-KV validator at the
 *      coercers layer rejects quoted boolean `'false'` for any `enabled`
 *      key with exit code 1.  This exercise lives at the script level
 *      because the validator runs as a subprocess gate after parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'parse-config.mjs');

// ---------------------------------------------------------------------------
// Helper: run the script with SO_SKIP_CONFIG_VALIDATION so the validator
// doesn't block on minimal fixture configs.  cwd is set via spawnOptions
// so process.chdir() is never called (avoids coordinator-cwd drift).
// ---------------------------------------------------------------------------
function runParseConfig(cwd, claudeMdContent) {
  writeFileSync(join(cwd, 'CLAUDE.md'), claudeMdContent, 'utf8');
  const stdout = execFileSync('node', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SO_SKIP_CONFIG_VALIDATION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Minimal valid Session Config header required by parseSessionConfig
// ---------------------------------------------------------------------------
const BASE_CONFIG = `# Test
## Session Config

persistence: true
enforcement: warn
waves: 5
agents-per-wave: 6
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
`;

let sandbox;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pc-proposals-'));
  // No git init needed — parse-config uses cwd for file resolution only
  writeFileSync(join(sandbox, '.gitignore'), '');
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract test: parseSessionConfig output exposes memory.proposals shape
// after the M1 refactor moved the parser into config/memory.mjs.
// ---------------------------------------------------------------------------
describe('parse-config.mjs — memory.proposals contract shape (post-#544 refactor)', () => {
  it('memory.proposals has exactly enabled, quota-per-wave, confidence-floor keys', () => {
    const result = runParseConfig(sandbox, BASE_CONFIG);
    const keys = Object.keys(result.memory.proposals).sort();
    expect(keys).toEqual(['confidence-floor', 'enabled', 'quota-per-wave']);
  });

  it('returns the canonical default {enabled:true, quota-per-wave:5, confidence-floor:0.5}', () => {
    const result = runParseConfig(sandbox, BASE_CONFIG);
    expect(result.memory.proposals).toEqual({
      enabled: true,
      'quota-per-wave': 5,
      'confidence-floor': 0.5,
    });
  });

  it('memory.banner and memory.proposals coexist after parseSessionConfig', () => {
    const content = `${BASE_CONFIG}
memory:
  banner:
    enabled: false
  proposals:
    enabled: true
    quota-per-wave: 8
    confidence-floor: 0.6
`;
    const result = runParseConfig(sandbox, content);
    expect(result.memory).toEqual({
      banner: { enabled: false },
      proposals: { enabled: true, 'quota-per-wave': 8, 'confidence-floor': 0.6 },
    });
  });
});

// ---------------------------------------------------------------------------
// Outer-validator interaction: quoted boolean 'false' on `enabled` key is
// rejected by the flat-KV coercer (config.mjs `_coerceBoolean`) BEFORE the
// nested memory parser ever runs.  The correct behaviour is a non-zero
// exit, not silent coercion.  This exercises the parse-config.mjs script
// pipeline end-to-end.
// ---------------------------------------------------------------------------
describe("parse-config.mjs — memory.proposals quoted boolean 'false' is rejected gracefully", () => {
  const CONTENT = `${BASE_CONFIG}
memory:
  proposals:
    enabled: 'false'
`;

  it("exits non-zero when proposals.enabled value is quoted 'false'", () => {
    writeFileSync(join(sandbox, 'CLAUDE.md'), CONTENT, 'utf8');
    let threw = false;
    let stderrText = '';
    try {
      execFileSync('node', [SCRIPT], {
        cwd: sandbox,
        encoding: 'utf8',
        env: { ...process.env, SO_SKIP_CONFIG_VALIDATION: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      threw = true;
      stderrText = err.stderr ?? '';
    }
    expect(threw).toBe(true);
    expect(stderrText).toContain('invalid boolean');
  });
});
