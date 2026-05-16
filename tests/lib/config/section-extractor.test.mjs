/**
 * section-extractor.test.mjs — Unit tests for scripts/lib/config/section-extractor.mjs
 *
 * Covers _extractConfigSection (section detection, CRLF, code-fence skip,
 * boundary at next ##) and _parseKV (format 1 bold, format 2 plain, inline
 * comment strip, quote strip, last-match-wins).
 */

import { describe, it, expect } from 'vitest';
import {
  _extractConfigSection,
  _parseKV,
} from '@lib/config/section-extractor.mjs';

// ---------------------------------------------------------------------------
// _extractConfigSection
// ---------------------------------------------------------------------------

describe('_extractConfigSection', () => {
  it('returns empty array when section is absent', () => {
    expect(_extractConfigSection('some content\nwithout config')).toEqual([]);
  });

  it('returns empty array on empty string', () => {
    expect(_extractConfigSection('')).toEqual([]);
  });

  it('extracts lines under ## Session Config', () => {
    const content = '## Session Config\n\npersistence: true\nwaves: 5\n';
    const lines = _extractConfigSection(content);
    expect(lines).toContain('persistence: true');
    expect(lines).toContain('waves: 5');
  });

  it('stops at next ## header', () => {
    const content = '## Session Config\npersistence: true\n## Other Section\nother: value\n';
    const lines = _extractConfigSection(content);
    expect(lines).toContain('persistence: true');
    expect(lines).not.toContain('other: value');
  });

  it('skips standalone code fence lines', () => {
    const content = '## Session Config\n```\npersistence: true\n```\n';
    const lines = _extractConfigSection(content);
    expect(lines).not.toContain('```');
    expect(lines).toContain('persistence: true');
  });

  it('strips trailing whitespace from lines', () => {
    const content = '## Session Config\npersistence: true   \n';
    const lines = _extractConfigSection(content);
    expect(lines).toContain('persistence: true');
  });

  it('handles CRLF line endings', () => {
    const content = '## Session Config\r\npersistence: true\r\nwaves: 5\r\n';
    const lines = _extractConfigSection(content);
    expect(lines).toContain('persistence: true');
    expect(lines).toContain('waves: 5');
  });

  it('does not include the ## Session Config header line itself', () => {
    const content = '## Session Config\npersistence: true\n';
    const lines = _extractConfigSection(content);
    expect(lines).not.toContain('## Session Config');
  });
});

// ---------------------------------------------------------------------------
// _parseKV
// ---------------------------------------------------------------------------

describe('_parseKV', () => {
  it('returns empty Map for empty lines array', () => {
    const kv = _parseKV([]);
    expect(kv.size).toBe(0);
  });

  it('parses Format 1: "- **key:** value"', () => {
    const kv = _parseKV(['- **persistence:** true']);
    expect(kv.get('persistence')).toBe('true');
  });

  it('parses Format 2: plain "key: value"', () => {
    const kv = _parseKV(['persistence: true']);
    expect(kv.get('persistence')).toBe('true');
  });

  it('strips inline YAML comments from Format 1', () => {
    const kv = _parseKV(['- **mode:** warn  # strict | warn | off']);
    expect(kv.get('mode')).toBe('warn');
  });

  it('strips inline YAML comments from Format 2', () => {
    const kv = _parseKV(['waves: 5  # number of waves']);
    expect(kv.get('waves')).toBe('5');
  });

  it('strips surrounding double quotes from value', () => {
    const kv = _parseKV(['- **token:** "abc123"']);
    expect(kv.get('token')).toBe('abc123');
  });

  it('last match wins when same key appears multiple times', () => {
    const kv = _parseKV(['waves: 3', 'waves: 7']);
    expect(kv.get('waves')).toBe('7');
  });

  it('skips blank lines silently', () => {
    const kv = _parseKV(['', '  ', 'waves: 5', '']);
    expect(kv.get('waves')).toBe('5');
  });

  it('skips lines that match neither Format 1 nor Format 2', () => {
    const kv = _parseKV(['  ## comment', '  - just a list item']);
    expect(kv.size).toBe(0);
  });

  it('parses multiple keys from a mix of formats', () => {
    const lines = ['- **persistence:** true', 'waves: 5', 'enforcement: warn'];
    const kv = _parseKV(lines);
    expect(kv.get('persistence')).toBe('true');
    expect(kv.get('waves')).toBe('5');
    expect(kv.get('enforcement')).toBe('warn');
  });
});
