/**
 * tests/scripts/parse-config.memory-proposals.test.mjs
 *
 * Vitest suite: parse-config.mjs correctly parses the `memory.proposals.*`
 * sub-block (issue #501, F2.1).
 *
 * Test surface: run `node scripts/parse-config.mjs` against fixture CLAUDE.md
 * files written to a tmp directory, parse stdout JSON, assert on
 * `result.memory.proposals.*`.  Uses `SO_SKIP_CONFIG_VALIDATION=1` so the
 * validator gate does not interact with minimal fixture files.
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
// Case 1: absent memory.proposals block → all three defaults returned
// ---------------------------------------------------------------------------
describe('parse-config.mjs — memory.proposals defaults', () => {
  it('returns enabled=true when memory.proposals block is absent', () => {
    const result = runParseConfig(sandbox, BASE_CONFIG);
    expect(result.memory.proposals.enabled).toBe(true);
  });

  it('returns quota-per-wave=5 when memory.proposals block is absent', () => {
    const result = runParseConfig(sandbox, BASE_CONFIG);
    expect(result.memory.proposals['quota-per-wave']).toBe(5);
  });

  it('returns confidence-floor=0.5 when memory.proposals block is absent', () => {
    const result = runParseConfig(sandbox, BASE_CONFIG);
    expect(result.memory.proposals['confidence-floor']).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Case 2: enabled: false → enabled=false, quota/floor still default
// ---------------------------------------------------------------------------
describe('parse-config.mjs — memory.proposals enabled: false', () => {
  const CONTENT = `${BASE_CONFIG}
memory:
  proposals:
    enabled: false
`;

  it('returns enabled=false when explicitly set to false', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals.enabled).toBe(false);
  });

  it('still returns quota-per-wave=5 when enabled is false', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals['quota-per-wave']).toBe(5);
  });

  it('still returns confidence-floor=0.5 when enabled is false', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals['confidence-floor']).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Case 3: explicit quota-per-wave and confidence-floor values returned
// ---------------------------------------------------------------------------
describe('parse-config.mjs — memory.proposals explicit values', () => {
  const CONTENT = `${BASE_CONFIG}
memory:
  proposals:
    enabled: true
    quota-per-wave: 10
    confidence-floor: 0.7
`;

  it('returns quota-per-wave=10 when explicitly configured', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals['quota-per-wave']).toBe(10);
  });

  it('returns confidence-floor=0.7 when explicitly configured', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals['confidence-floor']).toBe(0.7);
  });

  it('returns enabled=true when explicitly set to true', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 4: quoted boolean 'false' → config.mjs rejects with exit 1 (graceful fail)
//
// The outer config.mjs parser sees 'false' (with quotes) in the flat KV map
// and throws "invalid boolean for 'enabled'" before _parseMemoryProposals
// ever runs.  The correct behavior is a non-zero exit, not silent coercion.
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
    expect(stderrText).toContain("invalid boolean");
  });
});

// ---------------------------------------------------------------------------
// Case 5: negative quota-per-wave falls back to default 5
// ---------------------------------------------------------------------------
describe('parse-config.mjs — memory.proposals invalid quota-per-wave', () => {
  // Negative integer — the parser only accepts /^\d+$/ so "-3" fails and falls back
  const CONTENT = `${BASE_CONFIG}
memory:
  proposals:
    quota-per-wave: -3
`;

  it('falls back to quota-per-wave=5 for a negative value', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals['quota-per-wave']).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Case 6: coexistence with memory.banner.enabled — both parsed, neither broken
// ---------------------------------------------------------------------------
describe('parse-config.mjs — memory.proposals coexists with memory.banner', () => {
  const CONTENT = `${BASE_CONFIG}
memory:
  banner:
    enabled: false
  proposals:
    enabled: true
    quota-per-wave: 8
    confidence-floor: 0.6
`;

  it('parses memory.banner.enabled=false without overwriting proposals', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.banner.enabled).toBe(false);
  });

  it('parses memory.proposals.enabled=true when banner block also present', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals.enabled).toBe(true);
  });

  it('parses memory.proposals.quota-per-wave=8 when banner block also present', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals['quota-per-wave']).toBe(8);
  });

  it('parses memory.proposals.confidence-floor=0.6 when banner block also present', () => {
    const result = runParseConfig(sandbox, CONTENT);
    expect(result.memory.proposals['confidence-floor']).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// Shape check: memory.proposals is always an object with exactly the 3 keys
// ---------------------------------------------------------------------------
describe('parse-config.mjs — memory.proposals object shape', () => {
  it('memory.proposals has exactly enabled, quota-per-wave, confidence-floor keys', () => {
    const result = runParseConfig(sandbox, BASE_CONFIG);
    const keys = Object.keys(result.memory.proposals).sort();
    expect(keys).toEqual(['confidence-floor', 'enabled', 'quota-per-wave']);
  });

  it('memory.proposals is present even when memory block is entirely absent', () => {
    const result = runParseConfig(sandbox, BASE_CONFIG);
    expect(result.memory).toHaveProperty('proposals');
  });
});
