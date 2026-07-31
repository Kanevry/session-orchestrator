/**
 * config-phases.test.mjs — split from config.test.mjs (#912 TV-003 de-hotspot).
 *
 * custom-phases (#637) + evolve.extra-sources (#638) block parsing.
 * Feature-domain slice of the former monolithic config.test.mjs. Split by
 * domain to reduce merge-conflict churn on a single hotspot file. Tests were
 * moved 1:1 from config.test.mjs — no behaviour change.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseSessionConfig } from '@lib/config.mjs';

// ---------------------------------------------------------------------------
// custom-phases parsing (#637)
// ---------------------------------------------------------------------------

describe('custom-phases parsing (#637)', () => {
  it('defaults to [] when the custom-phases: block is absent', () => {
    const config = parseSessionConfig('## Session Config\n\npersistence: true\n');
    expect(config['custom-phases']).toEqual([]);
  });

  it('exposes custom-phases as a top-level key', () => {
    const config = parseSessionConfig('## Session Config\n\npersistence: true\n');
    expect(config).toHaveProperty('custom-phases');
  });

  it('parses a full custom-phases record through parseSessionConfig', () => {
    const content = [
      '## Session Config',
      '',
      'custom-phases:',
      '  - name: eval-learn-aggregate',
      '    when: housekeeping',
      '    command: npm run eval:aggregate',
      '    mode: hard',
      '    review: docs/eval/last-run.md',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['custom-phases']).toEqual([
      {
        name: 'eval-learn-aggregate',
        when: 'housekeeping',
        command: 'npm run eval:aggregate',
        mode: 'hard',
        review: 'docs/eval/last-run.md',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// evolve.extra-sources parsing (#638)
// ---------------------------------------------------------------------------

describe('evolve.extra-sources parsing (#638)', () => {
  it('defaults to [] when the evolve: block is absent', () => {
    const config = parseSessionConfig('## Session Config\n\npersistence: true\n');
    expect(config['evolve.extra-sources']).toEqual([]);
  });

  it('exposes evolve.extra-sources as a top-level key', () => {
    const config = parseSessionConfig('## Session Config\n\npersistence: true\n');
    expect(config).toHaveProperty('evolve.extra-sources');
  });

  it('parses a full evolve.extra-sources record through parseSessionConfig', () => {
    const content = [
      '## Session Config',
      '',
      'evolve:',
      '  extra-sources:',
      '    - path: eval/learn/reports/latest.json',
      '      kind: regression-flags',
      '      learning-type: domain-regression',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['evolve.extra-sources']).toEqual([
      {
        path: 'eval/learn/reports/latest.json',
        kind: 'regression-flags',
        'learning-type': 'domain-regression',
      },
    ]);
  });

  it('drops evolve.extra-sources records that escape repo-relative scope', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const content = [
        '## Session Config',
        '',
        'evolve:',
        '  extra-sources:',
        '    - path: ../outside.json',
        '      kind: regression-flags',
        '      learning-type: domain-regression',
        '',
      ].join('\n');
      const config = parseSessionConfig(content);
      expect(config['evolve.extra-sources']).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });
});
