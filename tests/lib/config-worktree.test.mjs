/**
 * config-worktree.test.mjs — split from config.test.mjs (#912 TV-003 de-hotspot).
 *
 * worktree / host-environment config: worktree-exclude, allow-destructive-ops, heavy-repo, resource-awareness.
 * Feature-domain slice of the former monolithic config.test.mjs. Split by
 * domain to reduce merge-conflict churn on a single hotspot file. Tests were
 * moved 1:1 from config.test.mjs — no behaviour change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionConfig } from '@lib/config.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

function readFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('worktree-exclude (issue #192)', () => {
  it('defaults worktree-exclude to canonical 10-pattern list', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['worktree-exclude']).toEqual([
      'node_modules', 'dist', 'build', '.next', '.nuxt',
      'coverage', '.cache', '.turbo', '.vercel', 'out',
    ]);
  });

  it('parses worktree-exclude: [custom, list]', () => {
    const content = `## Session Config\n\nworktree-exclude: [custom, list]\n`;
    const config = parseSessionConfig(content);
    expect(config['worktree-exclude']).toEqual(['custom', 'list']);
  });

  it('parses empty worktree-exclude: [] to empty array (feature disabled)', () => {
    const content = `## Session Config\n\nworktree-exclude: []\n`;
    const config = parseSessionConfig(content);
    expect(config['worktree-exclude']).toEqual([]);
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

describe('heavy-repo / worktree-cleanup (HR-003, baseline #60)', () => {
  it('defaults heavy-repo to false when not present in config', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['heavy-repo']).toBe(false);
  });

  it('parses heavy-repo: true', () => {
    const content = `## Session Config\n\nheavy-repo: true\n`;
    const config = parseSessionConfig(content);
    expect(config['heavy-repo']).toBe(true);
  });

  it('parses explicit heavy-repo: false', () => {
    const content = `## Session Config\n\nheavy-repo: false\n`;
    const config = parseSessionConfig(content);
    expect(config['heavy-repo']).toBe(false);
  });

  it('defaults worktree-cleanup to "default" when not present in config', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['worktree-cleanup']).toBe('default');
  });

  it('parses worktree-cleanup: aggressive', () => {
    const content = `## Session Config\n\nworktree-cleanup: aggressive\n`;
    const config = parseSessionConfig(content);
    expect(config['worktree-cleanup']).toBe('aggressive');
  });

  it('parses explicit worktree-cleanup: default', () => {
    const content = `## Session Config\n\nworktree-cleanup: default\n`;
    const config = parseSessionConfig(content);
    expect(config['worktree-cleanup']).toBe('default');
  });

  it('throws on invalid worktree-cleanup value', () => {
    const content = `## Session Config\n\nworktree-cleanup: bogus\n`;
    expect(() => parseSessionConfig(content)).toThrow(/worktree-cleanup must be/);
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
