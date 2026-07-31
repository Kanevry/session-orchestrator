/**
 * config-docs-orchestrator.test.mjs — split from config.test.mjs (#912 TV-003 de-hotspot).
 *
 * docs-orchestrator block parsing + docs-orchestrator/vault-staleness top-level key presence.
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

// ---------------------------------------------------------------------------
// docs-orchestrator parsing
// ---------------------------------------------------------------------------

describe('docs-orchestrator parsing', () => {
  it('returns defaults when docs-orchestrator key is absent', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['docs-orchestrator']).toEqual({
      enabled: false,
      audiences: ['user', 'dev', 'vault'],
      mode: 'warn',
    });
  });

  it('parses enabled: true', () => {
    const content = [
      '## Session Config',
      '',
      'persistence: true',
      '',
      'docs-orchestrator:',
      '  enabled: true',
      '  audiences: [user, dev]',
      '  mode: strict',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['docs-orchestrator'].enabled).toBe(true);
    expect(config['docs-orchestrator'].mode).toBe('strict');
    expect(config['docs-orchestrator'].audiences).toEqual(['user', 'dev']);
  });

  it('parses a single-item audiences narrowing', () => {
    const content = [
      '## Session Config',
      '',
      'docs-orchestrator:',
      '  enabled: true',
      '  audiences: [user]',
      '  mode: warn',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['docs-orchestrator'].audiences).toEqual(['user']);
  });

  it('filters invalid audience values and keeps only valid ones', () => {
    const content = [
      '## Session Config',
      '',
      'docs-orchestrator:',
      '  audiences: [user, bogus, dev]',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['docs-orchestrator'].audiences).toEqual(['user', 'dev']);
  });

  it('falls back to default audiences when all values in list are invalid', () => {
    const content = [
      '## Session Config',
      '',
      'docs-orchestrator:',
      '  audiences: [bogus, invalid, fake]',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['docs-orchestrator'].audiences).toEqual(['user', 'dev', 'vault']);
  });

  it('silently defaults mode to warn when invalid mode (hard) is given', () => {
    const content = [
      '## Session Config',
      '',
      'docs-orchestrator:',
      '  enabled: true',
      '  mode: hard',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['docs-orchestrator'].mode).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// docs-orchestrator and vault-staleness appear in top-level keys
// ---------------------------------------------------------------------------

describe('docs-orchestrator and vault-staleness in top-level keys', () => {
  it('returns all expected top-level keys including docs-orchestrator and vault-staleness', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config).toHaveProperty('docs-orchestrator');
    expect(config).toHaveProperty('vault-staleness');
  });
});
