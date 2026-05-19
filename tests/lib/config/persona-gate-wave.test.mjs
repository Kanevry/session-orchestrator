/**
 * tests/lib/config/persona-gate-wave.test.mjs
 *
 * Unit tests for scripts/lib/config/persona-gate-wave.mjs — the Session Config
 * parser for the `persona-gate-wave:` block introduced in #458.
 *
 * Coord-direct fold-in for W4-Q4 HIGH-2 (qa-strategist): config parser shipped
 * with zero coverage in W3. Sibling wave-reviewers.mjs has 11 tests; this file
 * mirrors that surface.
 */

import { describe, it, expect } from 'vitest';
import {
  _parsePersonaGateWave,
  _normalizePersonaGateWave,
} from '../../../scripts/lib/config/persona-gate-wave.mjs';

// ---------------------------------------------------------------------------
// _parsePersonaGateWave — parse the YAML block from CLAUDE.md content
// ---------------------------------------------------------------------------

describe('_parsePersonaGateWave — block extraction', () => {
  it('returns null when the block is absent', () => {
    const content = '# CLAUDE.md\n\n## Session Config\n\nother-key: value\n';
    expect(_parsePersonaGateWave(content)).toBe(null);
  });

  it('returns parsed config when block is present', () => {
    const content = `## Session Config
persona-gate-wave:
  enabled: true
  after: quality
  threshold: "all"
  mode: strict
`;
    const result = _parsePersonaGateWave(content);
    expect(result).not.toBe(null);
    expect(result.enabled).toBe(true);
    expect(result.after).toBe('quality');
    expect(result.mode).toBe('strict');
  });

  it('parses minimal block (defaults applied)', () => {
    const content = `persona-gate-wave:
  enabled: true
`;
    const result = _parsePersonaGateWave(content);
    expect(result.enabled).toBe(true);
    expect(result.after).toBe('quality');
    expect(result.threshold).toBe('all');
    expect(result.mode).toBe('off');
    expect(result['dispatch-model']).toBe('claude-opus-4-7');
    expect(result.personas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _normalizePersonaGateWave — field-level validation + default application
// ---------------------------------------------------------------------------

describe('_normalizePersonaGateWave — happy path defaults', () => {
  it('applies all defaults when input is empty object', () => {
    const result = _normalizePersonaGateWave({});
    expect(result.enabled).toBe(false);
    expect(result.after).toBe('quality');
    expect(result.threshold).toBe('all');
    expect(result.personas).toEqual([]);
    expect(result['dispatch-model']).toBe('claude-opus-4-7');
    expect(result.mode).toBe('off');
  });

  it('accepts canonical valid config', () => {
    const input = {
      enabled: true,
      after: 'impl-polish',
      threshold: '5-of-6',
      personas: ['klima-physicist', 'klima-ai-expert'],
      'dispatch-model': 'claude-opus-4-7',
      mode: 'warn',
    };
    const result = _normalizePersonaGateWave(input);
    expect(result.enabled).toBe(true);
    expect(result.after).toBe('impl-polish');
    expect(result.threshold).toBe('5-of-6');
    expect(result.personas).toEqual(['klima-physicist', 'klima-ai-expert']);
    expect(result.mode).toBe('warn');
  });

  it('accepts model alias (opus)', () => {
    const result = _normalizePersonaGateWave({ 'dispatch-model': 'opus' });
    expect(result['dispatch-model']).toBe('opus');
  });

  it('accepts full model ID (claude-sonnet-4-6)', () => {
    const result = _normalizePersonaGateWave({ 'dispatch-model': 'claude-sonnet-4-6' });
    expect(result['dispatch-model']).toBe('claude-sonnet-4-6');
  });
});

describe('_normalizePersonaGateWave — rejects invalid fields', () => {
  it('throws on invalid enabled (string instead of boolean)', () => {
    expect(() => _normalizePersonaGateWave({ enabled: 'yes' })).toThrow(/enabled/);
  });

  it('throws on invalid after value', () => {
    expect(() => _normalizePersonaGateWave({ after: 'rogue' })).toThrow(/after/);
  });

  it('throws on invalid mode value', () => {
    expect(() => _normalizePersonaGateWave({ mode: 'rogue' })).toThrow(/mode/);
  });

  it('throws on invalid threshold (propagates parseThreshold error)', () => {
    expect(() => _normalizePersonaGateWave({ threshold: '0-of-5' })).toThrow();
  });

  it('throws on invalid threshold "6-of-5" (M > N)', () => {
    expect(() => _normalizePersonaGateWave({ threshold: '6-of-5' })).toThrow();
  });

  it('throws on invalid dispatch-model (not in allowlist)', () => {
    expect(() => _normalizePersonaGateWave({ 'dispatch-model': 'claude-evil-99-99' })).toThrow(
      /dispatch-model/,
    );
  });

  it('throws on persona name failing SAFE_PERSONA_NAME_RE', () => {
    expect(() => _normalizePersonaGateWave({ personas: ['../etc/passwd'] })).toThrow();
  });

  it('throws on non-array personas (string instead)', () => {
    expect(() => _normalizePersonaGateWave({ personas: 'klima-physicist' })).toThrow(/personas/);
  });
});

describe('_normalizePersonaGateWave — edge cases', () => {
  it('accepts empty personas array (means "all from catalog")', () => {
    const result = _normalizePersonaGateWave({ personas: [] });
    expect(result.personas).toEqual([]);
  });

  it('preserves the threshold string verbatim (parsed at dispatch time)', () => {
    // Validation happens via parseThreshold (throws on bad); but the string is preserved.
    const result = _normalizePersonaGateWave({ threshold: '3-of-3' });
    expect(result.threshold).toBe('3-of-3');
  });
});
