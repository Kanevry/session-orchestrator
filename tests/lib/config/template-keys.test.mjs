/**
 * tests/lib/config/template-keys.test.mjs — #1567 item 1.
 *
 * Named bug (TV-001): `/bootstrap --retroactive` step 6 looked for missing
 * mandatory fields in the validator's stderr, but `parseSessionConfig()` fills
 * every mandatory field with its default, so an ABSENT field was never reported
 * and a pnpm repo without `test-command` silently ran `npm test`. Measured
 * 2026-10-14: a block holding only `special: x` gave empty stderr, exit 0.
 * The template read here is the real `docs/session-config-template.md`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingStarterKeys } from '../../../scripts/lib/config/template-keys.mjs';

const TEMPLATE = readFileSync(join(process.cwd(), 'docs', 'session-config-template.md'), 'utf8');

describe('missingStarterKeys (#1567)', () => {
  it('names every absent mandatory field and accepts the bullet and bold spellings as present', () => {
    const local = [
      '# Repo',
      '',
      '## Session Config',
      '',
      'special: x',
      '- waves: 3',
      '- **test-command:** pnpm test',
      '',
      '## Next',
      'persistence: true',
    ].join('\n');

    expect(missingStarterKeys(local, TEMPLATE)).toEqual([
      'typecheck-command',
      'lint-command',
      'agents-per-wave',
      'persistence',
      'enforcement',
    ]);
  });
});
