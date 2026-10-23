/**
 * security-delta.test.mjs — Unit tests for scripts/lib/config/security-delta.mjs (#1769)
 *
 * Bugs each case catches:
 *   - absent block must stay `off` (opt-in rollout) — a default of warn/strict
 *     would run network checks on every close of every repo;
 *   - `strict` must parse — the CLI keys its exit-3 block on it;
 *   - an unknown mode must throw, never silently degrade to `off`;
 *   - an inline comment after the value must be stripped (template ships one);
 *   - the map key `security-delta` must surface through parseSessionConfig,
 *     which is what the CLI and session-end Phase 2.4 read.
 */

import { describe, it, expect } from 'vitest';
import { _parseSecurityDelta } from '@lib/config/security-delta.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

const hermetic = { hostPaths: { env: {}, ownerConfig: undefined } };

describe('_parseSecurityDelta', () => {
  it('returns { mode: off } when the block is absent', () => {
    expect(_parseSecurityDelta('# Title\n\nsome-other: 1\n')).toEqual({ mode: 'off' });
  });

  it('parses mode: strict and ignores an inline comment after the value', () => {
    const md = 'security-delta:\n  mode: strict   # off | warn | strict\n';
    expect(_parseSecurityDelta(md)).toEqual({ mode: 'strict' });
  });

  it('throws on an unknown mode', () => {
    expect(() => _parseSecurityDelta('security-delta:\n  mode: block\n')).toThrow(
      "security-delta.mode must be off|warn|strict, got 'block'",
    );
  });

  it('surfaces cfg["security-delta"] through parseSessionConfig', () => {
    const md = '## Session Config\n\npersistence: true\n\nsecurity-delta:\n  mode: warn\n';
    expect(parseSessionConfig(md, hermetic)['security-delta']).toEqual({ mode: 'warn' });
  });
});
