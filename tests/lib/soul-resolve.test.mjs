import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveSoul, loadAndResolveSoul } from '../../scripts/lib/soul-resolve.mjs';
import { getDefaults } from '../../scripts/lib/owner-yaml.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOUL_SESSION_START = join(
  new URL('.', import.meta.url).pathname,
  '../../skills/session-start/soul.md',
);

const SOUL_PLAN = join(
  new URL('.', import.meta.url).pathname,
  '../../skills/plan/soul.md',
);

// ---------------------------------------------------------------------------
// resolveSoul — unit tests (pure function, no I/O)
// ---------------------------------------------------------------------------

describe('resolveSoul', () => {
  it('replaces a single known slot with the value from ownerConfig', () => {
    const config = {
      owner: { language: 'de' },
      tone: { style: 'direct' },
      efficiency: { 'output-level': 'lite', preamble: 'minimal' },
    };
    const { resolved, warnings } = resolveSoul('Respond in {{owner.language}} always.', config);
    expect(resolved).toBe('Respond in de always.');
    expect(warnings).toHaveLength(0);
  });

  it('replaces multiple slots in one template pass', () => {
    const config = {
      owner: { language: 'en' },
      tone: { style: 'friendly' },
      efficiency: { 'output-level': 'ultra', preamble: 'verbose' },
    };
    const template =
      'Lang: {{owner.language}}, Tone: {{tone.style}}, Level: {{efficiency.output-level}}, Pre: {{efficiency.preamble}}.';
    const { resolved, warnings } = resolveSoul(template, config);
    expect(resolved).toBe('Lang: en, Tone: friendly, Level: ultra, Pre: verbose.');
    expect(warnings).toHaveLength(0);
  });

  it('falls back to defaults when ownerConfig is empty', () => {
    const defaults = getDefaults();
    const { resolved, warnings } = resolveSoul('{{owner.language}} {{tone.style}}', {});
    expect(resolved).toBe(`${defaults.owner.language} ${defaults.tone.style}`);
    expect(warnings).toHaveLength(0);
  });

  it('leaves unknown slot paths in place and adds a warning', () => {
    const config = {
      owner: { language: 'en' },
      tone: { style: 'neutral' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
    };
    const { resolved, warnings } = resolveSoul('Hello {{owner.unknown-field}} world.', config);
    expect(resolved).toBe('Hello {{owner.unknown-field}} world.');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unknown slot path/i);
    expect(warnings[0]).toContain('owner.unknown-field');
  });

  it('handles whitespace inside braces — {{ owner.language }}', () => {
    const config = {
      owner: { language: 'de' },
      tone: { style: 'neutral' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
    };
    const { resolved, warnings } = resolveSoul('{{ owner.language }}', config);
    expect(resolved).toBe('de');
    expect(warnings).toHaveLength(0);
  });

  it('handles leading/trailing whitespace inside braces for other known slots', () => {
    const config = {
      owner: { language: 'en' },
      tone: { style: 'direct' },
      efficiency: { 'output-level': 'lite', preamble: 'minimal' },
    };
    const { resolved } = resolveSoul('{{  tone.style  }}', config);
    expect(resolved).toBe('direct');
  });

  it('leaves static content outside braces completely unchanged', () => {
    const config = {
      owner: { language: 'en' },
      tone: { style: 'neutral' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
    };
    const template = '# Soul\n\nIdentity paragraph stays intact.\n\n{{tone.style}}\n';
    const { resolved } = resolveSoul(template, config);
    expect(resolved).toContain('# Soul\n\nIdentity paragraph stays intact.');
    expect(resolved).toContain('neutral');
    expect(resolved).not.toContain('{{tone.style}}');
  });

  it('round-trip: resolves all 4 documented slots in a single template', () => {
    const config = {
      owner: { language: 'de' },
      tone: { style: 'direct' },
      efficiency: { 'output-level': 'lite', preamble: 'minimal' },
    };
    const template =
      '{{owner.language}} {{tone.style}} {{efficiency.output-level}} {{efficiency.preamble}}';
    const { resolved, warnings } = resolveSoul(template, config);
    expect(resolved).toBe('de direct lite minimal');
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadAndResolveSoul — integration tests (disk I/O)
// ---------------------------------------------------------------------------

describe('loadAndResolveSoul', () => {
  it('reads session-start/soul.md from disk and resolves slots with defaults when owner.yaml is absent', () => {
    const { resolved, source, warnings } = loadAndResolveSoul(SOUL_SESSION_START, {
      ownerConfigPath: '/tmp/nonexistent-owner-for-soul-resolve-test.yaml',
    });
    expect(source).toBe('defaults');
    expect(warnings).toHaveLength(0);
    // resolved content must not contain unresolved {{...}} for known slots
    expect(resolved).not.toMatch(/\{\{owner\.language\}\}/);
    expect(resolved).not.toMatch(/\{\{tone\.style\}\}/);
    expect(resolved).not.toMatch(/\{\{efficiency\.output-level\}\}/);
    expect(resolved).not.toMatch(/\{\{efficiency\.preamble\}\}/);
    // static content from soul.md should still be present
    expect(resolved).toContain('Session Orchestrator');
  });

  it('reads plan/soul.md from disk and resolves slots with defaults when owner.yaml is absent', () => {
    const { resolved, source } = loadAndResolveSoul(SOUL_PLAN, {
      ownerConfigPath: '/tmp/nonexistent-owner-for-soul-resolve-test.yaml',
    });
    expect(source).toBe('defaults');
    expect(resolved).not.toMatch(/\{\{owner\.language\}\}/);
    expect(resolved).toContain('Plan Skill');
  });
});
