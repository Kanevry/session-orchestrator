/**
 * config.test.mjs — Vitest tests for scripts/lib/config.mjs
 *
 * Covers:
 *  - parseSessionConfig: minimal, defaults, full, CRLF, no-block, invalid enum,
 *    integer override syntax, vault-integration nested object
 *  - getConfigValue: existing key, missing key
 *  - readConfigFile: finds CLAUDE.md, throws when neither file exists
 *  - Parity: parseSessionConfig result matches bash scripts/parse-config.sh JSON output
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfigFile, parseSessionConfig, getConfigValue } from '../../scripts/lib/config.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKTREE_ROOT = new URL('../../', import.meta.url).pathname;
const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

function readFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------
// parseSessionConfig
// ---------------------------------------------------------------------------

describe('parseSessionConfig', () => {
  describe('minimal config', () => {
    it('returns persistence: true from explicit value', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config.persistence).toBe(true);
    });

    it('applies default agents-per-wave of 6', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['agents-per-wave']).toBe(6);
    });

    it('applies default waves of 5', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config.waves).toBe(5);
    });

    it('applies default enforcement of warn', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config.enforcement).toBe('warn');
    });

    it('applies default isolation of auto', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config.isolation).toBe('auto');
    });

    it('applies default test-command to pnpm test --run', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['test-command']).toBe('pnpm test --run');
    });

    it('applies default typecheck-command to tsgo --noEmit', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['typecheck-command']).toBe('tsgo --noEmit');
    });

    it('applies default lint-command to pnpm lint', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['lint-command']).toBe('pnpm lint');
    });

    it('applies default recent-commits of 20', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['recent-commits']).toBe(20);
    });

    it('applies null to optional string fields not present', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config.vcs).toBeNull();
      expect(config['gitlab-host']).toBeNull();
      expect(config.mirror).toBeNull();
      expect(config['cross-repos']).toBeNull();
    });

    it('returns all expected top-level keys', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      const expectedKeys = [
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
        'vault-integration', 'vault-sync',
      ];
      for (const key of expectedKeys) {
        expect(config, `expected key '${key}' to be present`).toHaveProperty(key);
      }
    });
  });

  describe('default values', () => {
    it('defaults discovery-probes to [all]', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['discovery-probes']).toEqual(['all']);
    });

    it('defaults discovery-exclude-paths to []', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['discovery-exclude-paths']).toEqual([]);
    });

    it('defaults max-turns to auto', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['max-turns']).toBe('auto');
    });

    it('defaults learning-decay-rate to 0.05', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['learning-decay-rate']).toBe(0.05);
    });

    it('defaults ecosystem-health to false', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['ecosystem-health']).toBe(false);
    });

    it('defaults issue-limit to 50', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['issue-limit']).toBe(50);
    });

    it('defaults plan-default-visibility to internal', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['plan-default-visibility']).toBe('internal');
    });

    it('defaults plan-prd-location to docs/prd/', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['plan-prd-location']).toBe('docs/prd/');
    });

    it('defaults plan-retro-location to docs/retro/', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['plan-retro-location']).toBe('docs/retro/');
    });

    it('defaults grounding-check to true', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['grounding-check']).toBe(true);
    });

    it('defaults allow-destructive-ops to false', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['allow-destructive-ops']).toBe(false);
    });

    it('defaults resource-awareness to true', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['resource-awareness']).toBe(true);
    });

    it('defaults enable-host-banner to true', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['enable-host-banner']).toBe(true);
    });

    it('defaults resource-thresholds to canonical values', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['resource-thresholds']).toEqual({
        'ram-free-min-gb': 4,
        'ram-free-critical-gb': 2,
        'cpu-load-max-pct': 80,
        'concurrent-sessions-warn': 5,
        'ssh-no-docker': true,
      });
    });
  });

  describe('full config (CLAUDE.md fixture)', () => {
    it('parses test-command verbatim with embedded quotes', () => {
      const config = parseSessionConfig(readFixture('config-full.md'));
      expect(config['test-command']).toBe(
        'for f in scripts/test/test-*.sh; do bash "$f" || exit 1; done'
      );
    });

    it('parses typecheck-command: false as string "false"', () => {
      const config = parseSessionConfig(readFixture('config-full.md'));
      // "false" is the string value from the config (not filtered to null)
      // parse-config.sh treats it as a string via json_string which returns "false"
      expect(config['typecheck-command']).toBe('false');
    });

    it('parses lint-command: false as string "false"', () => {
      const config = parseSessionConfig(readFixture('config-full.md'));
      expect(config['lint-command']).toBe('false');
    });

    it('parses stale-branch-days: 7', () => {
      const config = parseSessionConfig(readFixture('config-full.md'));
      expect(config['stale-branch-days']).toBe(7);
    });

    it('parses plugin-freshness-days: 30', () => {
      const config = parseSessionConfig(readFixture('config-full.md'));
      expect(config['plugin-freshness-days']).toBe(30);
    });

    it('parses recent-commits: 20', () => {
      const config = parseSessionConfig(readFixture('config-full.md'));
      expect(config['recent-commits']).toBe(20);
    });

    it('parses enforcement: warn', () => {
      const config = parseSessionConfig(readFixture('config-full.md'));
      expect(config.enforcement).toBe('warn');
    });
  });

  describe('parity with parse-config.sh', () => {
    it.skipIf(process.platform === 'win32')(
      'produces JSON matching bash parse-config.sh output on CLAUDE.md (sorted keys)',
      () => {
        const claudeMdPath = join(WORKTREE_ROOT, 'CLAUDE.md');
        const claudeMdContent = readFileSync(claudeMdPath, 'utf8');

        // Run bash parse-config.sh
        const result = spawnSync(
          'bash',
          [join(WORKTREE_ROOT, 'scripts/parse-config.sh'), claudeMdPath],
          { encoding: 'utf8', timeout: 10000 }
        );

        if (result.error) {
          throw result.error;
        }
        if (result.status !== 0) {
          throw new Error(`parse-config.sh failed (exit ${result.status}): ${result.stderr}`);
        }

        const bashJson = JSON.parse(result.stdout);
        const mjsConfig = parseSessionConfig(claudeMdContent);

        // Compare with sorted keys for deterministic diff output
        const sortedKeys = Object.keys(bashJson).sort();
        const bashSorted = JSON.stringify(bashJson, sortedKeys);
        const mjsSorted = JSON.stringify(mjsConfig, sortedKeys);

        if (bashSorted !== mjsSorted) {
          // Find mismatched keys for a useful failure message
          const diffs = [];
          for (const k of sortedKeys) {
            const bashVal = JSON.stringify(bashJson[k]);
            const mjsVal = JSON.stringify(mjsConfig[k]);
            if (bashVal !== mjsVal) {
              diffs.push(`  "${k}": bash=${bashVal} | mjs=${mjsVal}`);
            }
          }
          throw new Error(
            `config.mjs diverged from parse-config.sh:\n${diffs.join('\n')}`
          );
        }

        expect(bashSorted).toBe(mjsSorted);
      }
    );
  });

  describe('CRLF-tolerant', () => {
    it('raw fixture bytes contain \\r\\n', () => {
      const raw = readFileSync(join(FIXTURES, 'config-crlf.md'));
      expect(raw.includes(Buffer.from('\r\n'))).toBe(true);
    });

    it('produces same persistence value as LF version', () => {
      const crlfContent = readFileSync(join(FIXTURES, 'config-crlf.md'), 'utf8');
      const lfContent = readFixture('config-minimal.md');
      const crlfConfig = parseSessionConfig(crlfContent);
      const lfConfig = parseSessionConfig(lfContent);
      expect(crlfConfig.persistence).toBe(lfConfig.persistence);
      expect(crlfConfig.persistence).toBe(true);
    });

    it('produces same agents-per-wave default as LF version', () => {
      const crlfContent = readFileSync(join(FIXTURES, 'config-crlf.md'), 'utf8');
      const lfContent = readFixture('config-minimal.md');
      const crlfConfig = parseSessionConfig(crlfContent);
      const lfConfig = parseSessionConfig(lfContent);
      expect(crlfConfig['agents-per-wave']).toBe(lfConfig['agents-per-wave']);
      expect(crlfConfig['agents-per-wave']).toBe(6);
    });

    it('produces same enforcement default as LF version', () => {
      const crlfContent = readFileSync(join(FIXTURES, 'config-crlf.md'), 'utf8');
      const lfContent = readFixture('config-minimal.md');
      const crlfConfig = parseSessionConfig(crlfContent);
      const lfConfig = parseSessionConfig(lfContent);
      expect(crlfConfig.enforcement).toBe(lfConfig.enforcement);
      expect(crlfConfig.enforcement).toBe('warn');
    });
  });

  describe('no Session Config block', () => {
    it('does not throw', () => {
      expect(() => parseSessionConfig(readFixture('config-no-block.md'))).not.toThrow();
    });

    it('returns agents-per-wave default of 6', () => {
      const config = parseSessionConfig(readFixture('config-no-block.md'));
      expect(config['agents-per-wave']).toBe(6);
    });

    it('returns enforcement default of warn', () => {
      const config = parseSessionConfig(readFixture('config-no-block.md'));
      expect(config.enforcement).toBe('warn');
    });

    it('returns persistence default of true', () => {
      const config = parseSessionConfig(readFixture('config-no-block.md'));
      expect(config.persistence).toBe(true);
    });

    it('returns max-turns default of auto', () => {
      const config = parseSessionConfig(readFixture('config-no-block.md'));
      expect(config['max-turns']).toBe('auto');
    });
  });

  describe('invalid enum throws', () => {
    it('throws for enforcement: loose', () => {
      expect(() => parseSessionConfig(readFixture('config-invalid-enum.md'))).toThrow();
    });

    it('error message mentions "enforcement"', () => {
      expect(() => parseSessionConfig(readFixture('config-invalid-enum.md'))).toThrow(
        /enforcement/
      );
    });

    it('error message mentions allowed values', () => {
      expect(() => parseSessionConfig(readFixture('config-invalid-enum.md'))).toThrow(
        /strict|warn|off/
      );
    });
  });

  describe('integer override syntax', () => {
    it('parses agents-per-wave: 6 (deep: 18) into object with default and deep', () => {
      const content = `## Session Config\n\nagents-per-wave: 6 (deep: 18)\n`;
      const config = parseSessionConfig(content);
      expect(config['agents-per-wave']).toEqual({ default: 6, deep: 18 });
    });

    it('sets default property to 6', () => {
      const content = `## Session Config\n\nagents-per-wave: 6 (deep: 18)\n`;
      const config = parseSessionConfig(content);
      expect(config['agents-per-wave'].default).toBe(6);
    });

    it('sets deep property to 18', () => {
      const content = `## Session Config\n\nagents-per-wave: 6 (deep: 18)\n`;
      const config = parseSessionConfig(content);
      expect(config['agents-per-wave'].deep).toBe(18);
    });

    it('parses multiple overrides in one field', () => {
      const content = `## Session Config\n\nwaves: 5 (deep: 10, fast: 3)\n`;
      const config = parseSessionConfig(content);
      expect(config.waves).toEqual({ default: 5, deep: 10, fast: 3 });
    });
  });

  describe('vault-integration nested object', () => {
    it('returns vault-integration with enabled, vault-dir, mode keys when absent', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['vault-integration']).toHaveProperty('enabled');
      expect(config['vault-integration']).toHaveProperty('vault-dir');
      expect(config['vault-integration']).toHaveProperty('mode');
    });

    it('defaults vault-integration.enabled to false', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['vault-integration'].enabled).toBe(false);
    });

    it('defaults vault-integration.vault-dir to null', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['vault-integration']['vault-dir']).toBeNull();
    });

    it('defaults vault-integration.mode to warn', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['vault-integration'].mode).toBe('warn');
    });

    it('parses explicit vault-integration sub-keys from Session Config', () => {
      const content = [
        '## Session Config',
        '',
        'enabled: true',
        'vault-dir: /secrets/vault',
        'mode: strict',
      ].join('\n');
      const config = parseSessionConfig(content);
      expect(config['vault-integration'].enabled).toBe(true);
      expect(config['vault-integration']['vault-dir']).toBe('/secrets/vault');
      expect(config['vault-integration'].mode).toBe('strict');
    });

    it('defaults vault-sync to disabled with empty exclude list', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['vault-sync'].enabled).toBe(false);
      expect(config['vault-sync'].exclude).toEqual([]);
    });
  });

  describe('allow-destructive-ops', () => {
    it('defaults to false when not present in config', () => {
      const config = parseSessionConfig(readFixture('config-minimal.md'));
      expect(config['allow-destructive-ops']).toBe(false);
    });

    it('parses allow-destructive-ops: true', () => {
      const content = `## Session Config\n\nallow-destructive-ops: true\n`;
      const config = parseSessionConfig(content);
      expect(config['allow-destructive-ops']).toBe(true);
    });

    it('parses explicit allow-destructive-ops: false', () => {
      const content = `## Session Config\n\nallow-destructive-ops: false\n`;
      const config = parseSessionConfig(content);
      expect(config['allow-destructive-ops']).toBe(false);
    });
  });

  describe('resource-awareness + env-aware block (v3.1.0 #166)', () => {
    it('parses resource-awareness: false', () => {
      const content = `## Session Config\n\nresource-awareness: false\n`;
      const config = parseSessionConfig(content);
      expect(config['resource-awareness']).toBe(false);
    });

    it('parses enable-host-banner: false', () => {
      const content = `## Session Config\n\nenable-host-banner: false\n`;
      const config = parseSessionConfig(content);
      expect(config['enable-host-banner']).toBe(false);
    });

    it('parses resource-thresholds sub-keys with custom values', () => {
      const content = [
        '## Session Config',
        '',
        'resource-thresholds:',
        '  ram-free-min-gb: 8',
        '  ram-free-critical-gb: 3',
        '  cpu-load-max-pct: 70',
        '  concurrent-sessions-warn: 3',
        '  ssh-no-docker: false',
        '',
      ].join('\n');
      const config = parseSessionConfig(content);
      expect(config['resource-thresholds']).toEqual({
        'ram-free-min-gb': 8,
        'ram-free-critical-gb': 3,
        'cpu-load-max-pct': 70,
        'concurrent-sessions-warn': 3,
        'ssh-no-docker': false,
      });
    });

    it('resource-thresholds sub-keys fall back to defaults when partial', () => {
      const content = [
        '## Session Config',
        '',
        'resource-thresholds:',
        '  concurrent-sessions-warn: 2',
        '',
      ].join('\n');
      const config = parseSessionConfig(content);
      expect(config['resource-thresholds']['concurrent-sessions-warn']).toBe(2);
      expect(config['resource-thresholds']['ram-free-min-gb']).toBe(4);
      expect(config['resource-thresholds']['ssh-no-docker']).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// getConfigValue
// ---------------------------------------------------------------------------

describe('getConfigValue', () => {
  it('returns the config value for an existing key', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    const result = getConfigValue(config, 'agents-per-wave', 99);
    expect(result).toBe(6);
  });

  it('ignores the defaultValue when key exists', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    // enforcement is 'warn', not the defaultValue we pass
    const result = getConfigValue(config, 'enforcement', 'strict');
    expect(result).toBe('warn');
  });

  it('returns defaultValue for a missing key', () => {
    const config = {};
    const result = getConfigValue(config, 'nonexistent-key', 'fallback');
    expect(result).toBe('fallback');
  });

  it('returns defaultValue when key value is null', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    // vcs is null in minimal config
    const result = getConfigValue(config, 'vcs', 'default-vcs');
    expect(result).toBe('default-vcs');
  });

  it('returns null as defaultValue when no defaultValue given and key is missing', () => {
    const result = getConfigValue({}, 'missing');
    expect(result).toBeNull();
  });

  it('returns boolean true correctly', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    const result = getConfigValue(config, 'persistence', false);
    expect(result).toBe(true);
  });

  it('returns array values correctly', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    const result = getConfigValue(config, 'discovery-probes', null);
    expect(result).toEqual(['all']);
  });
});

// ---------------------------------------------------------------------------
// readConfigFile
// ---------------------------------------------------------------------------

describe('readConfigFile', () => {
  it('finds and returns CLAUDE.md content from the project root', async () => {
    const content = await readConfigFile(WORKTREE_ROOT);
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
  });

  it('returned content contains ## Session Config header', async () => {
    const content = await readConfigFile(WORKTREE_ROOT);
    expect(content).toContain('## Session Config');
  });

  it('returned content is parseable by parseSessionConfig', async () => {
    const content = await readConfigFile(WORKTREE_ROOT);
    const config = parseSessionConfig(content);
    // Must produce a valid object with key fields
    expect(config['agents-per-wave']).toBe(6);
    expect(config.enforcement).toBe('warn');
  });

  it('throws when neither CLAUDE.md nor AGENTS.md exists in the given directory', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'config-test-'));
    await expect(readConfigFile(tmpDir)).rejects.toThrow(/CLAUDE\.md|AGENTS\.md/);
  });

  it('error from missing files mentions the projectRoot path', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'config-test-'));
    await expect(readConfigFile(tmpDir)).rejects.toThrow(tmpDir);
  });
});
