/**
 * tests/lib/config/test.test.mjs
 *
 * Unit tests for scripts/lib/config/test.mjs (_parseTest).
 *
 * Coverage:
 *   - Returns all defaults when no `test:` block present
 *   - Each field is independently overridable: enabled, default-profile,
 *     profiles-path, mode, retention-days
 *   - Invalid `mode` value falls back silently to 'warn'
 *   - CRLF tolerance
 *   - Inline YAML comments stripped
 *   - Block boundary: next top-level key stops parsing
 *
 * Mirrors the docs-orchestrator.test.mjs pattern (see tests/lib/config/).
 * All expected values are hardcoded literals.
 */

import { describe, it, expect } from 'vitest';
import { _parseTest } from '../../../scripts/lib/config/test.mjs';

const DEFAULTS = {
  enabled: false,
  'default-profile': 'smoke',
  'profiles-path': '.orchestrator/policy/test-profiles.json',
  mode: 'warn',
  'retention-days': 30,
};

// ---------------------------------------------------------------------------
// Missing / empty block — all defaults returned
// ---------------------------------------------------------------------------

describe('_parseTest — missing or empty block', () => {
  it('returns all defaults on empty string input', () => {
    expect(_parseTest('')).toEqual(DEFAULTS);
  });

  it('returns all defaults when test: block is absent from content', () => {
    expect(_parseTest('persistence: true\nenforcement: warn\n')).toEqual(DEFAULTS);
  });

  it('returns all defaults when test: block is present but empty', () => {
    const content = 'test:\n\nnext-section:\n';
    expect(_parseTest(content)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// Individual fields — each overridable
// ---------------------------------------------------------------------------

describe('_parseTest — individual field overrides', () => {
  it('parses enabled: true', () => {
    const content = 'test:\n  enabled: true\n';
    expect(_parseTest(content).enabled).toBe(true);
  });

  it('parses default-profile: full', () => {
    const content = 'test:\n  default-profile: full\n';
    expect(_parseTest(content)['default-profile']).toBe('full');
  });

  it('parses profiles-path: custom path', () => {
    const content = 'test:\n  profiles-path: .custom/profiles.json\n';
    expect(_parseTest(content)['profiles-path']).toBe('.custom/profiles.json');
  });

  it('parses mode: strict', () => {
    const content = 'test:\n  mode: strict\n';
    expect(_parseTest(content).mode).toBe('strict');
  });

  it('parses retention-days: 60', () => {
    const content = 'test:\n  retention-days: 60\n';
    expect(_parseTest(content)['retention-days']).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Invalid mode — falls back to 'warn'
// ---------------------------------------------------------------------------

describe('_parseTest — invalid mode value', () => {
  it('silently falls back to "warn" when mode is an unrecognized value', () => {
    const content = 'test:\n  mode: turbo\n';
    expect(_parseTest(content).mode).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// CRLF tolerance
// ---------------------------------------------------------------------------

describe('_parseTest — CRLF tolerance', () => {
  it('handles CRLF line endings correctly', () => {
    const content = 'test:\r\n  enabled: true\r\n  mode: strict\r\n';
    const result = _parseTest(content);
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('strict');
  });
});

// ---------------------------------------------------------------------------
// Inline YAML comments stripped
// ---------------------------------------------------------------------------

describe('_parseTest — inline YAML comments stripped', () => {
  it('strips trailing inline comments from field values', () => {
    const content = 'test:\n  enabled: true  # opt-in\n  retention-days: 45  # days\n';
    const result = _parseTest(content);
    expect(result.enabled).toBe(true);
    expect(result['retention-days']).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Block boundary — stops at next top-level key
// ---------------------------------------------------------------------------

describe('_parseTest — block boundary', () => {
  it('stops parsing when the next top-level key is encountered', () => {
    const content = 'test:\n  enabled: true\nother-section:\n  enabled: false\n';
    expect(_parseTest(content).enabled).toBe(true);
  });

  it('does not bleed default-profile from a subsequent block', () => {
    const content = 'test:\n  enabled: true\nother:\n  default-profile: bleed\n';
    expect(_parseTest(content)['default-profile']).toBe('smoke');
  });
});
