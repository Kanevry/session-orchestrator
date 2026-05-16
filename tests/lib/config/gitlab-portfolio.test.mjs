import { describe, it, expect } from 'vitest';
import {
  GITLAB_PORTFOLIO_DEFAULTS,
  coerceGitlabPortfolio,
  _parseGitlabPortfolio,
} from '@lib/config/gitlab-portfolio.mjs';

// ── GITLAB_PORTFOLIO_DEFAULTS ──────────────────────────────────────────────────

describe('GITLAB_PORTFOLIO_DEFAULTS', () => {
  it('has the expected shape and values', () => {
    expect(GITLAB_PORTFOLIO_DEFAULTS.enabled).toBe(false);
    expect(GITLAB_PORTFOLIO_DEFAULTS.mode).toBe('warn');
    expect(GITLAB_PORTFOLIO_DEFAULTS['stale-days']).toBe(30);
    expect(GITLAB_PORTFOLIO_DEFAULTS['critical-labels']).toEqual(['priority:critical', 'priority:high']);
  });
});

// ── coerceGitlabPortfolio ──────────────────────────────────────────────────────

describe('coerceGitlabPortfolio — undefined/null input', () => {
  it('returns defaults when input is undefined', () => {
    const result = coerceGitlabPortfolio(undefined);

    expect(result.enabled).toBe(false);
    expect(result.mode).toBe('warn');
    expect(result['stale-days']).toBe(30);
    expect(result['critical-labels']).toEqual(['priority:critical', 'priority:high']);
  });

  it('returns defaults when input is null', () => {
    const result = coerceGitlabPortfolio(null);

    expect(result.enabled).toBe(false);
    expect(result.mode).toBe('warn');
    expect(result['stale-days']).toBe(30);
    expect(result['critical-labels']).toEqual(['priority:critical', 'priority:high']);
  });

  it('returns defaults when input is an array (not a plain object)', () => {
    const result = coerceGitlabPortfolio([]);

    expect(result.enabled).toBe(false);
    expect(result.mode).toBe('warn');
  });
});

describe('coerceGitlabPortfolio — full valid config', () => {
  it('returns fully normalized object with all valid values', () => {
    const raw = {
      enabled: true,
      mode: 'strict',
      'stale-days': 60,
      'critical-labels': ['bug', 'urgent'],
    };

    const result = coerceGitlabPortfolio(raw);

    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('strict');
    expect(result['stale-days']).toBe(60);
    expect(result['critical-labels']).toEqual(['bug', 'urgent']);
  });

  it('accepts mode: off', () => {
    const result = coerceGitlabPortfolio({ mode: 'off' });

    expect(result.mode).toBe('off');
  });
});

describe('coerceGitlabPortfolio — enabled coercion', () => {
  it('coerces string "true" to false (strict boolean check — only literal true passes)', () => {
    const result = coerceGitlabPortfolio({ enabled: 'true' });

    expect(result.enabled).toBe(false);
  });

  it('coerces 1 (number) to false', () => {
    const result = coerceGitlabPortfolio({ enabled: 1 });

    expect(result.enabled).toBe(false);
  });

  it('keeps enabled: true as true', () => {
    const result = coerceGitlabPortfolio({ enabled: true });

    expect(result.enabled).toBe(true);
  });
});

describe('coerceGitlabPortfolio — mode fallback', () => {
  it('falls back to warn for invalid mode string', () => {
    const result = coerceGitlabPortfolio({ mode: 'invalid' });

    expect(result.mode).toBe('warn');
  });

  it('falls back to warn for mode: null', () => {
    const result = coerceGitlabPortfolio({ mode: null });

    expect(result.mode).toBe('warn');
  });

  it('falls back to warn for missing mode', () => {
    const result = coerceGitlabPortfolio({});

    expect(result.mode).toBe('warn');
  });
});

describe('coerceGitlabPortfolio — stale-days fallback', () => {
  it('falls back to 30 for negative stale-days', () => {
    const result = coerceGitlabPortfolio({ 'stale-days': -5 });

    expect(result['stale-days']).toBe(30);
  });

  it('falls back to 30 for non-integer stale-days (float)', () => {
    const result = coerceGitlabPortfolio({ 'stale-days': 1.5 });

    expect(result['stale-days']).toBe(30);
  });

  it('falls back to 30 for stale-days: 0', () => {
    const result = coerceGitlabPortfolio({ 'stale-days': 0 });

    expect(result['stale-days']).toBe(30);
  });

  it('falls back to 30 for string stale-days', () => {
    const result = coerceGitlabPortfolio({ 'stale-days': '45' });

    expect(result['stale-days']).toBe(30);
  });

  it('accepts valid integer stale-days: 1 (minimum)', () => {
    const result = coerceGitlabPortfolio({ 'stale-days': 1 });

    expect(result['stale-days']).toBe(1);
  });
});

describe('coerceGitlabPortfolio — critical-labels filtering', () => {
  it('filters out empty strings, numbers, and nulls from critical-labels', () => {
    const result = coerceGitlabPortfolio({
      'critical-labels': ['x', '', 123, null],
    });

    expect(result['critical-labels']).toEqual(['x']);
  });

  it('falls back to defaults when all entries are invalid', () => {
    const result = coerceGitlabPortfolio({
      'critical-labels': ['', null, 42],
    });

    expect(result['critical-labels']).toEqual(['priority:critical', 'priority:high']);
  });

  it('falls back to defaults when critical-labels is not an array', () => {
    const result = coerceGitlabPortfolio({
      'critical-labels': 'priority:critical',
    });

    expect(result['critical-labels']).toEqual(['priority:critical', 'priority:high']);
  });

  it('accepts single valid label string in array', () => {
    const result = coerceGitlabPortfolio({
      'critical-labels': ['security'],
    });

    expect(result['critical-labels']).toEqual(['security']);
  });
});

// ── _parseGitlabPortfolio ─────────────────────────────────────────────────────

describe('_parseGitlabPortfolio — full YAML block', () => {
  it('parses a complete gitlab-portfolio block from markdown content', () => {
    const content = `# Config

gitlab-portfolio:
  enabled: true
  mode: strict
  stale-days: 45
  critical-labels:
    - priority:critical
    - bug
`;

    const result = _parseGitlabPortfolio(content);

    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('strict');
    expect(result['stale-days']).toBe(45);
    expect(result['critical-labels']).toEqual(['priority:critical', 'bug']);
  });

  it('returns defaults when gitlab-portfolio block is absent', () => {
    const content = `# Config\n\nvault-integration:\n  vault-dir: ~/vault\n`;

    const result = _parseGitlabPortfolio(content);

    expect(result.enabled).toBe(false);
    expect(result.mode).toBe('warn');
    expect(result['stale-days']).toBe(30);
    expect(result['critical-labels']).toEqual(['priority:critical', 'priority:high']);
  });

  it('uses defaults for critical-labels when none are listed under the block', () => {
    const content = `gitlab-portfolio:\n  enabled: true\n  mode: warn\n  stale-days: 30\n`;

    const result = _parseGitlabPortfolio(content);

    // No critical-labels block → falls back to defaults
    expect(result['critical-labels']).toEqual(['priority:critical', 'priority:high']);
  });
});
