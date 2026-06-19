/**
 * tests/scripts/lib/multi-provider-build/templating.test.mjs
 *
 * Verifies the single-source → many-provider templating PoC: conditional
 * blocks, placeholder substitution, command-prefix rewriting, and the
 * round-trip render for the three real providers.
 */

import { describe, it, expect } from 'vitest';
import {
  compileProviderBlocks,
  replacePlaceholders,
  renderForProvider,
  renderAll,
} from '@lib/multi-provider-build/templating.mjs';
import { PROVIDERS, PROVIDER_KEYS } from '@lib/multi-provider-build/providers.mjs';

describe('compileProviderBlocks', () => {
  const source = [
    'Shared intro.',
    '',
    '<codex>',
    'Codex-only paragraph.',
    '</codex>',
    '',
    '<claude>',
    'Claude-only paragraph.',
    '</claude>',
    '',
    'Shared outro.',
  ].join('\n');

  it('keeps the active tag body and drops the others', () => {
    const out = compileProviderBlocks(source, ['claude', 'claude-code']);
    expect(out).toContain('Claude-only paragraph.');
    expect(out).not.toContain('Codex-only paragraph.');
    expect(out).toContain('Shared intro.');
    expect(out).toContain('Shared outro.');
  });

  it('strips the tag markers themselves, not just toggles visibility', () => {
    const out = compileProviderBlocks(source, ['claude']);
    expect(out).not.toContain('<claude>');
    expect(out).not.toContain('</claude>');
    expect(out).not.toContain('<codex>');
  });

  it('drops ALL provider blocks when none are active', () => {
    const out = compileProviderBlocks(source, []);
    expect(out).not.toContain('Codex-only paragraph.');
    expect(out).not.toContain('Claude-only paragraph.');
    expect(out).toContain('Shared intro.');
  });

  it('leaves unknown (non-provider) tags untouched — does not mangle markup', () => {
    const html = ['<section>', 'real markup', '</section>'].join('\n');
    // 'section' is not a known provider tag → must be preserved verbatim.
    expect(compileProviderBlocks(html, ['claude'])).toBe(html);
  });

  it('collapses the blank-line gaps left by stripping', () => {
    const out = compileProviderBlocks(source, ['claude']);
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe('replacePlaceholders', () => {
  it('substitutes model + config_file per provider', () => {
    const tpl = 'Run with {{model}}; edit {{config_file}}.';
    expect(replacePlaceholders(tpl, 'claude-code')).toBe('Run with Claude; edit CLAUDE.md.');
    expect(replacePlaceholders(tpl, 'codex')).toBe('Run with GPT; edit AGENTS.md.');
    expect(replacePlaceholders(tpl, 'cursor')).toBe('Run with the model; edit .cursorrules.');
  });

  it('substitutes the command prefix', () => {
    expect(replacePlaceholders('Type {{command_prefix}}go', 'codex')).toBe('Type $go');
    expect(replacePlaceholders('Type {{command_prefix}}go', 'claude-code')).toBe('Type /go');
  });

  it('builds the available_commands list with the provider prefix', () => {
    const out = replacePlaceholders('Commands: {{available_commands}}', 'codex', {
      commandNames: ['session', 'go'],
    });
    expect(out).toBe('Commands: $session, $go');
  });

  it('rewrites /cmd invocations to the provider prefix (Codex)', () => {
    const out = replacePlaceholders('First /session-end, then /session.', 'codex', {
      commandNames: ['session', 'session-end'],
    });
    expect(out).toBe('First $session-end, then $session.');
  });

  it('does NOT rewrite /cmd for slash-prefix providers (Claude, Cursor)', () => {
    const tpl = 'Run /session now.';
    expect(replacePlaceholders(tpl, 'claude-code', { commandNames: ['session'] })).toBe(tpl);
    expect(replacePlaceholders(tpl, 'cursor', { commandNames: ['session'] })).toBe(tpl);
  });

  it('longest-name-first prevents /session clobbering /session-end', () => {
    // If rewrite ran shortest-first, "/session" inside "/session-end" would be
    // rewritten to "$session-end" leaving a dangling fragment. Assert clean.
    const out = replacePlaceholders('/session-end', 'codex', { commandNames: ['session', 'session-end'] });
    expect(out).toBe('$session-end');
    expect(out).not.toContain('/');
  });

  it('throws on an unknown provider', () => {
    expect(() => replacePlaceholders('x', 'nonexistent')).toThrow(/Unknown provider/);
  });
});

describe('renderForProvider (blocks then placeholders)', () => {
  const source = [
    'Use {{command_prefix}}session to start.',
    '',
    '<codex>',
    'Codex note: edit {{config_file}}.',
    '</codex>',
    '<claude>',
    'Claude note: edit {{config_file}}.',
    '</claude>',
  ].join('\n');

  it('renders the Codex variant correctly', () => {
    const out = renderForProvider(source, 'codex', { commandNames: ['session'] });
    expect(out).toContain('Use $session to start.');
    expect(out).toContain('Codex note: edit AGENTS.md.');
    expect(out).not.toContain('Claude note');
    expect(out).not.toContain('{{');
  });

  it('renders the Claude variant correctly', () => {
    const out = renderForProvider(source, 'claude-code', { commandNames: ['session'] });
    expect(out).toContain('Use /session to start.');
    expect(out).toContain('Claude note: edit CLAUDE.md.');
    expect(out).not.toContain('Codex note');
    expect(out).not.toContain('{{');
  });

  it('leaves no unresolved placeholders for any provider', () => {
    for (const key of PROVIDER_KEYS) {
      const out = renderForProvider(source, key, { commandNames: ['session'] });
      expect(out, `unresolved placeholder for ${key}`).not.toMatch(/\{\{[a-z_]+\}\}/);
    }
  });
});

describe('renderAll', () => {
  it('produces one rendering per configured provider', () => {
    const out = renderAll('Model: {{model}}', {});
    expect(Object.keys(out).sort()).toEqual(PROVIDER_KEYS.slice().sort());
    expect(out['claude-code']).toBe('Model: Claude');
    expect(out.codex).toBe('Model: GPT');
  });
});

describe('providers config invariants', () => {
  it('every provider has the full placeholder set', () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(p.placeholders.model).toBeTruthy();
      expect(p.placeholders.configFile).toBeTruthy();
      expect(p.placeholders.commandPrefix).toBeTruthy();
      expect(p.placeholders.askInstruction).toBeTruthy();
      expect(Array.isArray(p.tags)).toBe(true);
      expect(p.tags.length).toBeGreaterThan(0);
    }
  });
});
