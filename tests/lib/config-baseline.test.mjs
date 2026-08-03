/**
 * config-baseline.test.mjs — split from config.test.mjs (#912 TV-003 de-hotspot).
 *
 * plan-baseline-path resolution: #497 YAML list-item form + #819 baselines: match tier.
 * Feature-domain slice of the former monolithic config.test.mjs. Split by
 * domain to reduce merge-conflict churn on a single hotspot file. Tests were
 * moved 1:1 from config.test.mjs — no behaviour change.
 */

import { describe, it, expect } from 'vitest';
import { parseSessionConfig } from '@lib/config.mjs';

// Issue #497 — baseline CLAUDE.md uses YAML list-item form `- key: value`
// throughout the Session Config block, and `vault-integration` is written
// as an inline object literal on a single line. Both must round-trip.
describe('issue #497: YAML list-item form + inline vault-integration', () => {
  const fixture = [
    '## Session Config',
    '',
    '- vcs: gitlab',
    '- gitlab-host: gitlab.example.com',
    '- plan-baseline-path: ~/Projects/projects-baseline',
    '- vault-integration: { enabled: true, vault-dir: ~/Projects/vault, mode: warn }',
    '- cross-repos: [sven, session-orchestrator]',
    '- waves: 7',
    '- agents-per-wave: 6 (deep: 18)',
  ].join('\n');

  // Hermetic ctx: the default hostPaths tier reads the REAL owner.yaml — a host-local
  // `paths.baseline-path` override would bleed into this committed-value assertion
  // (2026-07-03 Full-Gate incident). Inject an empty ctx to pin the COMMITTED tier.
  const hermetic = { hostPaths: { env: {}, ownerConfig: undefined } };

  it('preserves "- plan-baseline-path: ~/..." as a string (was null pre-#497)', () => {
    const config = parseSessionConfig(fixture, hermetic);
    expect(config['plan-baseline-path']).toBe('~/Projects/projects-baseline');
  });

  it('owner.yaml paths.baseline-path override wins over the committed value (hermetic, #653)', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: {},
        ownerConfig: { paths: { 'baseline-path': '/tmp/owner-override/projects-baseline' } },
      },
    });
    expect(config['plan-baseline-path']).toBe('/tmp/owner-override/projects-baseline');
  });

  it('SO_BASELINE_PATH env override wins over owner.yaml and committed (hermetic, #653)', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: { SO_BASELINE_PATH: '/tmp/env-override/projects-baseline' },
        ownerConfig: { paths: { 'baseline-path': '/tmp/owner-override/projects-baseline' } },
      },
    });
    expect(config['plan-baseline-path']).toBe('/tmp/env-override/projects-baseline');
  });

  it('parses inline "- vault-integration: { ... }" into the full nested object', () => {
    // Hermetic ctx (issue #783): vault-dir goes through the SAME
    // resolveHostPath tier as plan-baseline-path above — a host-local
    // `paths.vault-dir` override would otherwise win over the committed
    // `~/Projects/vault` value asserted here.
    const config = parseSessionConfig(fixture, hermetic);
    expect(config['vault-integration']).toEqual({
      enabled: true,
      'vault-dir': '~/Projects/vault',
      mode: 'warn',
      'vault-name': null,
    });
  });

  // Regression (issue #783): proves the `hostPaths` DI seam deterministically
  // governs vault-dir resolution — an INJECTED (fake, test-controlled) owner.yaml
  // context wins over the fixture's committed value, exactly mirroring
  // resolveHostPath's env > owner.yaml > committed precedence. This is the
  // load-bearing half of the #783 fix: because the test passes its OWN
  // `hostPaths` context explicitly, the REAL host's on-disk owner.yaml is never
  // consulted — the resolution is fully deterministic and independent of
  // whatever `paths.vault-dir` happens to be configured on the machine running
  // the suite. Host state cannot leak in; only the injected context can win.
  it('owner.yaml paths.vault-dir override wins over the committed value (hermetic, #783)', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: {},
        ownerConfig: { paths: { 'vault-dir': '/tmp/fake-owner-override/vault' } },
      },
    });
    expect(config['vault-integration']['vault-dir']).toBe('/tmp/fake-owner-override/vault');
  });

  it('parses "- vcs:" scalar (was null pre-#497)', () => {
    const config = parseSessionConfig(fixture);
    expect(config.vcs).toBe('gitlab');
  });

  it('parses "- cross-repos:" list (was null pre-#497)', () => {
    const config = parseSessionConfig(fixture);
    expect(config['cross-repos']).toEqual(['sven', 'session-orchestrator']);
  });

  it('parses "- waves:" integer (was default 5 pre-#497)', () => {
    const config = parseSessionConfig(fixture);
    expect(config.waves).toBe(7);
  });

  it('parses "- agents-per-wave:" integer-with-overrides syntax', () => {
    const config = parseSessionConfig(fixture);
    expect(config['agents-per-wave']).toEqual({ default: 6, deep: 18 });
  });
});

describe('issue #819: baselines: match tier for plan-baseline-path', () => {
  const fixture = [
    '## Session Config',
    '',
    '- vcs: gitlab',
    '- plan-baseline-path: ~/Projects/projects-baseline',
  ].join('\n');

  // A `baselines:` array whose path-prefix matches the injected cwd MUST win
  // over both the legacy owner.yaml `paths.baseline-path` scalar and the
  // committed Session Config value. `hostPaths.cwd` is the test-only seam that
  // pins the directory the baselines: tier matches against (production uses
  // process.cwd()).
  const baselinesOwnerConfig = {
    baselines: [
      {
        name: 'private',
        path: '/base/private',
        match: { 'path-prefix': '/home/x/Projects/private-world' },
      },
      {
        name: 'aiat',
        path: '/base/aiat',
        match: { 'path-prefix': '/home/x/Projects/intern' },
      },
    ],
    paths: { 'baseline-path': '/legacy/owner/baseline' },
  };

  it('baselines: match wins over legacy paths.baseline-path AND committed value', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: {},
        ownerConfig: baselinesOwnerConfig,
        cwd: '/home/x/Projects/private-world/repo-a',
      },
    });
    expect(config['plan-baseline-path']).toBe('/base/private');
  });

  it('a different cwd selects the aiat baseline', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: {},
        ownerConfig: baselinesOwnerConfig,
        cwd: '/home/x/Projects/intern/foo',
      },
    });
    expect(config['plan-baseline-path']).toBe('/base/aiat');
  });

  it('SO_BASELINE_PATH env still wins over a matching baselines: entry', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: { SO_BASELINE_PATH: '/env/override/baseline' },
        ownerConfig: baselinesOwnerConfig,
        cwd: '/home/x/Projects/private-world/repo-a',
      },
    });
    expect(config['plan-baseline-path']).toBe('/env/override/baseline');
  });

  it('cwd outside every path-prefix falls back to legacy paths.baseline-path', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: {},
        ownerConfig: baselinesOwnerConfig,
        cwd: '/home/x/Projects/other/repo',
      },
    });
    expect(config['plan-baseline-path']).toBe('/legacy/owner/baseline');
  });

  it('no baselines: array → byte-identical legacy behavior (committed value)', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: { env: {}, ownerConfig: undefined, cwd: '/home/x/Projects/private-world/repo-a' },
    });
    expect(config['plan-baseline-path']).toBe('~/Projects/projects-baseline');
  });

  it('no baselines: array + legacy paths.baseline-path → owner.yaml legacy wins (unchanged)', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: {},
        ownerConfig: { paths: { 'baseline-path': '/legacy/owner/baseline' } },
        cwd: '/home/x/Projects/private-world/repo-a',
      },
    });
    expect(config['plan-baseline-path']).toBe('/legacy/owner/baseline');
  });

  // MED-1 (#813-class chain-interaction gap): resolveNamedBaseline's env-yield
  // guard is `envVal.trim() !== ''` — a whitespace-only SO_BASELINE_PATH fails
  // that check, so the resolver does NOT yield to the (still-blank) env tier
  // and the baselines: match tier is free to win, exactly as if the env var
  // were absent.
  it('whitespace-only SO_BASELINE_PATH does NOT suppress the baselines: match tier', () => {
    const config = parseSessionConfig(fixture, {
      hostPaths: {
        env: { SO_BASELINE_PATH: '   ' },
        ownerConfig: baselinesOwnerConfig,
        cwd: '/home/x/Projects/private-world/repo-a',
      },
    });
    expect(config['plan-baseline-path']).toBe('/base/private');
  });

  // LOW batch: null propagation — no plan-baseline-path key in the fixture,
  // no owner.yaml override, and a cwd that matches no baselines: entry.
  // Reality-vs-panel-prediction divergence: the panel predicted `undefined`,
  // but `_coerceString` (scripts/lib/config/coercers.mjs) normalizes an
  // absent value to `null` before it ever reaches resolveHostPath, so the
  // committed-default tier that "wins" here is `null`, not `undefined`.
  it('no plan-baseline-path key + no owner override + non-matching cwd → null', () => {
    const fixtureNoBaselineKey = ['## Session Config', '', '- vcs: gitlab'].join('\n');
    const config = parseSessionConfig(fixtureNoBaselineKey, {
      hostPaths: { env: {}, ownerConfig: undefined, cwd: '/home/x/Projects/other/repo' },
    });
    expect(config['plan-baseline-path']).toBeNull();
  });
});
