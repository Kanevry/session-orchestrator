/**
 * vault-integration-bold-parity.test.mjs — raw-parity guard for #830.
 *
 * `skills/claude-md-drift-check/checker.mjs` Check 7 (vault-dir-parity) imports
 * `_parseVaultIntegration` DIRECTLY and feeds it RAW instruction-file content —
 * it never routes through `scripts/lib/config.mjs`. The #830 bold-tolerance
 * therefore MUST live inside the parser each caller invokes (via the shared
 * `matchBlockHeader` helper), not in a preprocessing step in config.mjs.
 *
 * This test pins that contract: importing the SAME `_parseVaultIntegration` the
 * checker imports, a bold-bullet `- **vault-integration:**` header on RAW content
 * still resolves `vault-dir` — proving the checker's direct-parser path gains the
 * tolerance by construction.
 *
 * In-process only; expected values are literals (testing.md anti-pattern #3/#4).
 */

import { describe, it, expect } from 'vitest';
// Same module the checker imports for the vault-dir-parity check
// (skills/claude-md-drift-check/checker.mjs → '../../scripts/lib/config/vault-integration.mjs').
import { _parseVaultIntegration } from '@lib/config/vault-integration.mjs';

describe('drift-check raw-parity: bold vault-integration header resolves through the direct parser', () => {
  it('resolves vault-dir from a bold-bullet block header on RAW content', () => {
    const content = [
      '- **vault-integration:**',
      '  enabled: true',
      '  vault-dir: ~/Projects/vault',
      '  mode: warn',
      '',
    ].join('\n');
    expect(_parseVaultIntegration(content)).toEqual({
      enabled: true,
      'vault-dir': '~/Projects/vault',
      mode: 'warn',
      'vault-name': null,
    });
  });

  it('plain header form remains equivalent (no regression from the refactor)', () => {
    const content = [
      'vault-integration:',
      '  enabled: true',
      '  vault-dir: ~/Projects/vault',
      '',
    ].join('\n');
    expect(_parseVaultIntegration(content)).toEqual({
      enabled: true,
      'vault-dir': '~/Projects/vault',
      mode: 'warn',
      'vault-name': null,
    });
  });

  it('negative control: an inline comment on the bold header still misses (defaults)', () => {
    // Confirms the tolerance did not over-broaden — a header carrying a comment
    // is still not a block-opener, so vault-dir stays null (defaults).
    const content = [
      '- **vault-integration:**  # opt-in',
      '  vault-dir: ~/Projects/vault',
      '',
    ].join('\n');
    expect(_parseVaultIntegration(content)).toEqual({
      enabled: false,
      'vault-dir': null,
      mode: 'warn',
      'vault-name': null,
    });
  });
});
