/**
 * config.test.mjs — Vitest tests for scripts/lib/config.mjs
 *
 * Covers:
 *  - parseSessionConfig: minimal, defaults, full, CRLF, no-block, invalid enum,
 *    integer override syntax, vault-integration nested object
 *  - getConfigValue: existing key, missing key
 *  - readConfigFile: finds CLAUDE.md, throws when neither file exists
 *  - Parity: parseSessionConfig result matches scripts/parse-config.mjs JSON output
 *
 * Shape: the fixture-driven key/default assertions are it.each {key, expected}
 * tables over a fixture parsed ONCE per fixture (parseSessionConfig is pure —
 * content string in, fresh object out — so a shared parse cannot leak state).
 * Every expected value is a hardcoded literal.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readConfigFile, parseSessionConfig, getConfigValue, _coerceCollisionRisk } from '@lib/config.mjs';
// Same primitive imported from the dependency-free leaf — issue #664 extracted
// readConfigFile here to break the config.mjs ⇄ config/cross-repo.mjs cycle. The
// config.mjs export above is now a back-compat re-export of this leaf.
import { readConfigFile as readConfigFileFromLeaf } from '@lib/config/io.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// fileURLToPath, not .pathname — Windows returns `/D:/...` via .pathname, which
// resolve() then mangles to `D:\D:\...`.
const WORKTREE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

function readFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

const MINIMAL = parseSessionConfig(readFixture('config-minimal.md'));
const FULL = parseSessionConfig(readFixture('config-full.md'));
const NO_BLOCK = parseSessionConfig(readFixture('config-no-block.md'));

// ---------------------------------------------------------------------------
// parseSessionConfig
// ---------------------------------------------------------------------------

describe('parseSessionConfig', () => {
  describe('minimal config — explicit values and defaults', () => {
    it.each([
      { key: 'persistence', expected: true },
      { key: 'agents-per-wave', expected: 6 },
      { key: 'waves', expected: 5 },
      { key: 'enforcement', expected: 'warn' },
      { key: 'isolation', expected: 'auto' },
      { key: 'test-command', expected: 'npm test' },
      { key: 'typecheck-command', expected: 'npm run typecheck' },
      { key: 'lint-command', expected: 'npm run lint' },
      { key: 'recent-commits', expected: 20 },
      // optional string fields absent from the fixture must be null, not undefined
      { key: 'vcs', expected: null },
      { key: 'gitlab-host', expected: null },
      { key: 'mirror', expected: null },
      { key: 'cross-repos', expected: null },
      { key: 'discovery-probes', expected: ['all'] },
      { key: 'discovery-exclude-paths', expected: [] },
      { key: 'max-turns', expected: 'auto' },
      { key: 'learning-decay-rate', expected: 0.05 },
      { key: 'ecosystem-health', expected: false },
      { key: 'issue-limit', expected: 50 },
      { key: 'plan-default-visibility', expected: 'internal' },
      { key: 'plan-prd-location', expected: 'docs/prd/' },
      { key: 'plan-retro-location', expected: 'docs/retro/' },
      { key: 'grounding-check', expected: true },
      { key: 'allow-destructive-ops', expected: false },
      { key: 'resource-awareness', expected: true },
      { key: 'enable-host-banner', expected: true },
      {
        key: 'resource-thresholds',
        expected: {
          'ram-free-min-gb': 4,
          'ram-free-critical-gb': 2,
          'cpu-load-max-pct': 90,
          'concurrent-sessions-warn': 5,
          'ssh-no-docker': true,
        },
      },
      { key: 'custom-phases', expected: [] }, // #637
      { key: 'evolve.extra-sources', expected: [] }, // #638
    ])('$key resolves to the documented value', ({ key, expected }) => {
      expect(MINIMAL[key]).toEqual(expected);
    });

    it.each([
      'agents-per-wave', 'waves', 'recent-commits', 'special', 'vcs',
      'gitlab-host', 'mirror', 'cross-repos', 'pencil', 'ecosystem-health',
      'health-endpoints', 'issue-limit', 'stale-branch-days', 'stale-issue-days',
      'test-command', 'typecheck-command', 'lint-command', 'ssot-files',
      'ssot-freshness-days', 'plugin-freshness-days', 'discovery-on-close',
      'discovery-probes', 'discovery-exclude-paths', 'discovery-severity-threshold',
      'discovery-confidence-threshold', 'persistence', 'memory-cleanup-threshold',
      'learning-expiry-days', 'learnings-surface-top-n', 'learning-decay-rate',
      'enforcement', 'isolation', 'max-turns', 'baseline-ref', 'baseline-project-id',
      'plan-baseline-path', 'plan-default-visibility', 'plan-prd-location',
      'plan-retro-location', 'agent-mapping', 'enforcement-gates', 'reasoning-output',
      'grounding-injection-max-files', 'grounding-check', 'allow-destructive-ops',
      'resource-awareness', 'enable-host-banner', 'resource-thresholds',
      'worktree-exclude', 'vault-integration', 'vault-sync', 'drift-check',
      'heavy-repo', 'worktree-cleanup', 'issue-budget',
    ])('always emits the top-level key %s', (key) => {
      expect(MINIMAL).toHaveProperty(key);
    });
  });

  describe('full config (CLAUDE.md fixture)', () => {
    it.each([
      // verbatim shell command with embedded quotes must survive parsing
      { key: 'test-command', expected: 'for f in scripts/test/test-*.sh; do bash "$f" || exit 1; done' },
      // `false` stays the STRING "false" (json_string semantics), never boolean/null
      { key: 'typecheck-command', expected: 'false' },
      { key: 'lint-command', expected: 'false' },
      { key: 'stale-branch-days', expected: 7 },
      { key: 'plugin-freshness-days', expected: 30 },
      { key: 'recent-commits', expected: 20 },
      { key: 'enforcement', expected: 'warn' },
    ])('parses $key', ({ key, expected }) => {
      expect(FULL[key]).toEqual(expected);
    });
  });

  describe('parity with parse-config.mjs', () => {
    it.skipIf(process.platform === 'win32')(
      'produces JSON matching node parse-config.mjs output on CLAUDE.md (sorted keys)',
      () => {
        const claudeMdPath = join(WORKTREE_ROOT, 'CLAUDE.md');
        const claudeMdContent = readFileSync(claudeMdPath, 'utf8');

        const result = spawnSync(
          'node',
          [join(WORKTREE_ROOT, 'scripts/parse-config.mjs'), claudeMdPath],
          { encoding: 'utf8', timeout: 10000 }
        );

        if (result.error) {
          throw result.error;
        }
        if (result.status !== 0) {
          throw new Error(`parse-config.mjs failed (exit ${result.status}): ${result.stderr}`);
        }

        const bashJson = JSON.parse(result.stdout);
        const mjsConfig = parseSessionConfig(claudeMdContent);

        // Compare with sorted keys for deterministic diff output
        const sortedKeys = Object.keys(bashJson).sort();
        const bashSorted = JSON.stringify(bashJson, sortedKeys);
        const mjsSorted = JSON.stringify(mjsConfig, sortedKeys);

        if (bashSorted !== mjsSorted) {
          const diffs = [];
          for (const k of sortedKeys) {
            const bashVal = JSON.stringify(bashJson[k]);
            const mjsVal = JSON.stringify(mjsConfig[k]);
            if (bashVal !== mjsVal) {
              diffs.push(`  "${k}": bash=${bashVal} | mjs=${mjsVal}`);
            }
          }
          throw new Error(
            `config.mjs diverged from parse-config.mjs:\n${diffs.join('\n')}`
          );
        }

        expect(bashSorted).toBe(mjsSorted);
      }
    );
  });

  describe('CRLF-tolerant', () => {
    // Fixture-integrity anchor: if the fixture ever gets normalised to LF, the
    // rows below would pass while testing nothing about CRLF handling.
    it('raw fixture bytes contain \\r\\n', () => {
      const raw = readFileSync(join(FIXTURES, 'config-crlf.md'));
      expect(raw.includes(Buffer.from('\r\n'))).toBe(true);
    });

    const CRLF = parseSessionConfig(readFileSync(join(FIXTURES, 'config-crlf.md'), 'utf8'));

    it.each([
      { key: 'persistence', expected: true },
      { key: 'agents-per-wave', expected: 6 },
      { key: 'enforcement', expected: 'warn' },
    ])('CRLF input yields the same $key as the LF fixture', ({ key, expected }) => {
      expect(CRLF[key]).toEqual(expected);
      expect(MINIMAL[key]).toEqual(expected);
    });
  });

  describe('no Session Config block', () => {
    it('does not throw', () => {
      expect(() => parseSessionConfig(readFixture('config-no-block.md'))).not.toThrow();
    });

    it.each([
      { key: 'agents-per-wave', expected: 6 },
      { key: 'enforcement', expected: 'warn' },
      { key: 'persistence', expected: true },
      { key: 'max-turns', expected: 'auto' },
    ])('falls back to the $key default', ({ key, expected }) => {
      expect(NO_BLOCK[key]).toEqual(expected);
    });
  });

  describe('invalid enum throws', () => {
    it.each([
      { why: 'names the offending key', matcher: /enforcement/ },
      { why: 'lists the allowed values', matcher: /strict|warn|off/ },
    ])('throws for enforcement: loose and $why', ({ matcher }) => {
      expect(() => parseSessionConfig(readFixture('config-invalid-enum.md'))).toThrow(matcher);
    });
  });

  describe('integer override syntax', () => {
    it.each([
      {
        why: 'agents-per-wave: 6 (deep: 18)',
        content: '## Session Config\n\nagents-per-wave: 6 (deep: 18)\n',
        key: 'agents-per-wave',
        expected: { default: 6, deep: 18 },
      },
      {
        why: 'multiple overrides in one field',
        content: '## Session Config\n\nwaves: 5 (deep: 10, fast: 3)\n',
        key: 'waves',
        expected: { default: 5, deep: 10, fast: 3 },
      },
    ])('parses $why into a {default, ...overrides} object', ({ content, key, expected }) => {
      expect(parseSessionConfig(content)[key]).toEqual(expected);
    });
  });
});

// ---------------------------------------------------------------------------
// getConfigValue
// ---------------------------------------------------------------------------

describe('getConfigValue', () => {
  it.each([
    { why: 'returns the config value for an existing key', config: MINIMAL, key: 'agents-per-wave', fallback: 99, expected: 6 },
    { why: 'ignores the defaultValue when the key exists', config: MINIMAL, key: 'enforcement', fallback: 'strict', expected: 'warn' },
    { why: 'returns the defaultValue for a missing key', config: {}, key: 'nonexistent-key', fallback: 'fallback', expected: 'fallback' },
    // vcs is null in the minimal fixture — null must be treated as absent
    { why: 'returns the defaultValue when the key value is null', config: MINIMAL, key: 'vcs', fallback: 'default-vcs', expected: 'default-vcs' },
    { why: 'returns null when no defaultValue is given and the key is missing', config: {}, key: 'missing', fallback: undefined, expected: null },
    { why: 'returns boolean true correctly', config: MINIMAL, key: 'persistence', fallback: false, expected: true },
    { why: 'returns array values correctly', config: MINIMAL, key: 'discovery-probes', fallback: null, expected: ['all'] },
  ])('$why', ({ config, key, fallback, expected }) => {
    expect(getConfigValue(config, key, fallback)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// readConfigFile
// ---------------------------------------------------------------------------

describe('readConfigFile', () => {
  it('returns CLAUDE.md content from the project root, parseable by parseSessionConfig', async () => {
    const content = await readConfigFile(WORKTREE_ROOT);
    expect(content).toContain('## Session Config');
    const config = parseSessionConfig(content);
    // The live CLAUDE.md Session Config uses the deep-override syntax
    // `agents-per-wave: 6 (deep: 18)` (lean-root session-config-parity fix,
    // 2026-05-19), which resolves to the {default, deep} object — not scalar 6.
    expect(config['agents-per-wave']).toEqual({ default: 6, deep: 18 });
    expect(config.enforcement).toBe('warn');
  });

  it.each([
    { platform: 'pi', expected: 'waves: 9' }, // AGENTS.md wins on Pi/Codex
    { platform: 'claude', expected: 'waves: 3' }, // CLAUDE.md precedence elsewhere
  ])('SO_PLATFORM=$platform selects the file containing "$expected"', async ({ platform, expected }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), `config-test-${platform}-`));
    try {
      writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Claude\n\n## Session Config\n\nwaves: 3\n', 'utf8');
      writeFileSync(join(tmpDir, 'AGENTS.md'), '# Agents\n\n## Session Config\n\nwaves: 9\n', 'utf8');
      vi.stubEnv('SO_PLATFORM', platform);

      const content = await readConfigFile(tmpDir);
      expect(content).toContain(expected);
    } finally {
      vi.unstubAllEnvs();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws naming both candidate files and the projectRoot when neither exists', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'config-test-'));
    try {
      await expect(readConfigFile(tmpDir)).rejects.toThrow(/CLAUDE\.md|AGENTS\.md/);
      await expect(readConfigFile(tmpDir)).rejects.toThrow(tmpDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readConfigFile leaf-extraction back-compat (issue #664)
//
// readConfigFile was extracted into the dependency-free leaf config/io.mjs to
// break the config.mjs ⇄ config/cross-repo.mjs cycle. The config.mjs export is
// now a re-export. These tests assert behavioural identity between the two
// import paths so the public API of config.mjs stays stable.
// ---------------------------------------------------------------------------

describe('readConfigFile leaf back-compat (#664)', () => {
  it('config.mjs re-exports the SAME function object as config/io.mjs', () => {
    expect(readConfigFile).toBe(readConfigFileFromLeaf);
  });

  it('leaf import reads CLAUDE.md identically to the config.mjs re-export', async () => {
    const viaConfig = await readConfigFile(WORKTREE_ROOT);
    const viaLeaf = await readConfigFileFromLeaf(WORKTREE_ROOT);
    expect(viaLeaf).toBe(viaConfig);
    expect(viaLeaf).toContain('## Session Config');
  });

  it('leaf import throws the same way when neither file exists', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'config-leaf-test-'));
    try {
      await expect(readConfigFileFromLeaf(tmpDir)).rejects.toThrow(/CLAUDE\.md|AGENTS\.md/);
      await expect(readConfigFileFromLeaf(tmpDir)).rejects.toThrow(tmpDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaf import honours SO_PLATFORM=pi AGENTS.md precedence', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'config-leaf-pi-'));
    try {
      writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Claude\n\nwaves: 3\n', 'utf8');
      writeFileSync(join(tmpDir, 'AGENTS.md'), '# Agents\n\nwaves: 9\n', 'utf8');
      vi.stubEnv('SO_PLATFORM', 'pi');

      const content = await readConfigFileFromLeaf(tmpDir);
      expect(content).toContain('waves: 9');
    } finally {
      vi.unstubAllEnvs();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// _coerceCollisionRisk (issue #194)
// ---------------------------------------------------------------------------

describe('_coerceCollisionRisk', () => {
  it.each([
    { why: 'null falls back to the built-in default', input: null, fallback: undefined, expected: 'low' },
    { why: 'undefined falls back to the built-in default', input: undefined, fallback: undefined, expected: 'low' },
    { why: 'a supplied custom default is honoured', input: null, fallback: 'medium', expected: 'medium' },
    { why: 'accepts low', input: 'low', fallback: undefined, expected: 'low' },
    { why: 'accepts medium', input: 'medium', fallback: undefined, expected: 'medium' },
    { why: 'accepts high', input: 'high', fallback: undefined, expected: 'high' },
  ])('$why', ({ input, fallback, expected }) => {
    expect(_coerceCollisionRisk(input, fallback)).toBe(expected);
  });

  it.each([
    { why: 'is a TypeError', matcher: TypeError },
    { why: 'lists the allowed values', matcher: 'low|medium|high' },
  ])('rejecting an invalid value: the throw $why', ({ matcher }) => {
    expect(() => _coerceCollisionRisk('extreme')).toThrow(matcher);
  });
});
