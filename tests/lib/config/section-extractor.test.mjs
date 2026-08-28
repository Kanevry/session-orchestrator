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
  collectUnparsableLines,
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

  // Issue #497: support YAML list-item form `- key: value` used in
  // baseline CLAUDE.md and other consumer repos.
  describe('issue #497: YAML list-item form "- key: value"', () => {
    it('parses simple "- key: value" line', () => {
      const kv = _parseKV(['- vcs: gitlab']);
      expect(kv.get('vcs')).toBe('gitlab');
    });

    it('preserves leading-tilde paths (~/...) in value', () => {
      const kv = _parseKV(['- plan-baseline-path: ~/Projects/projects-baseline']);
      expect(kv.get('plan-baseline-path')).toBe('~/Projects/projects-baseline');
    });

    it('parses inline object literal value verbatim', () => {
      const kv = _parseKV([
        '- vault-integration: { enabled: true, vault-dir: ~/Projects/vault, mode: warn }',
      ]);
      expect(kv.get('vault-integration')).toBe(
        '{ enabled: true, vault-dir: ~/Projects/vault, mode: warn }'
      );
    });

    it('parses list-value verbatim', () => {
      const kv = _parseKV(['- cross-repos: [sven, session-orchestrator]']);
      expect(kv.get('cross-repos')).toBe('[sven, session-orchestrator]');
    });

    it('does not misinterpret "- just a list item" (no colon-then-space) as key:value', () => {
      const kv = _parseKV(['- just a list item']);
      expect(kv.size).toBe(0);
    });

    it('parses mix of "- key: value", plain "key: value", and Format 1', () => {
      const lines = [
        '- vcs: gitlab',
        'waves: 5',
        '- **persistence:** true',
        '- plan-baseline-path: ~/Projects/foo',
      ];
      const kv = _parseKV(lines);
      expect(kv.get('vcs')).toBe('gitlab');
      expect(kv.get('waves')).toBe('5');
      expect(kv.get('persistence')).toBe('true');
      expect(kv.get('plan-baseline-path')).toBe('~/Projects/foo');
    });
  });
});

// ---------------------------------------------------------------------------
// collectUnparsableLines (#1097)
// ---------------------------------------------------------------------------

describe('collectUnparsableLines', () => {
  it('reports a prose line inside the block with its 1-based document line number', () => {
    // The bug: this line contributes nothing to the KV map, and its keys — if
    // it was meant to be one — fall back to defaults with no error anywhere.
    const content = '# Title\n\n## Session Config\n\npersistence: true\nthis is not config\n';
    expect(collectUnparsableLines(content)).toEqual([{ line: 6, text: 'this is not config' }]);
  });

  it('reports a key/value line whose colon is missing (the silent-default shape)', () => {
    const content = '## Session Config\n\npersistence true\n';
    expect(collectUnparsableLines(content)).toEqual([{ line: 3, text: 'persistence true' }]);
  });

  it('accepts every legitimate construct without reporting it', () => {
    const content = [
      '## Session Config',
      '',
      '```yaml',
      '# a yaml comment',
      '<!-- an html comment -->',
      '> a blockquote note',
      'persistence: true',
      '- **waves:** 5',
      '- vcs: gitlab',
      'cross-repos: [a, b]',
      'vault-integration:',
      '  enabled: true',
      'custom-phases:',
      '  - name: demo',
      '    command: node x.mjs',
      'audiences:',
      '  - user',
      '```',
      '',
    ].join('\n');
    expect(collectUnparsableLines(content)).toEqual([]);
  });

  it('does not read past the closing ## heading', () => {
    const content = '## Session Config\npersistence: true\n## Notes\nprose after the block\n';
    expect(collectUnparsableLines(content)).toEqual([]);
  });

  it('tolerates a multi-line HTML comment inside the block', () => {
    const content = '## Session Config\n<!--\nprose inside a comment\n-->\npersistence: true\n';
    expect(collectUnparsableLines(content)).toEqual([]);
  });

  it('returns empty for content without a Session Config block', () => {
    expect(collectUnparsableLines('# Title\n\nsome prose\n')).toEqual([]);
    expect(collectUnparsableLines('')).toEqual([]);
    expect(collectUnparsableLines(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #1097: the fence-skip covers an info-string opener
// ---------------------------------------------------------------------------

describe('_extractConfigSection code-fence tolerance (#1097)', () => {
  it('skips a ```yaml opener, not only a bare fence', () => {
    // Before #1097 the predicate was `line.trim() === '```'`, so ```yaml
    // survived into the line list — invisible while unmatched lines were
    // dropped silently, a false "unparsable" report once they are named.
    const content = '## Session Config\n```yaml\npersistence: true\n```\n';
    const lines = _extractConfigSection(content);
    expect(lines).not.toContain('```yaml');
    expect(lines).toContain('persistence: true');
  });
});

// ---------------------------------------------------------------------------
// #1097 review: the reader and the classifier share ONE accept-set
// ---------------------------------------------------------------------------

describe('multi-line HTML comments are documentation on BOTH sides', () => {
  const COMMENTED = [
    '## Session Config',
    '',
    'persistence: true',
    '<!--',
    'enforcement: strict',
    '-->',
    '',
    '```yaml',
    'vcs: github',
    '```',
    '',
    '## Next',
  ].join('\n');

  it('does not read a commented-out key as live config', () => {
    // The bug: `enforcement: strict` inside <!-- --> reached _parseKV as a LIVE
    // value (measured) while collectUnparsableLines called the same block
    // clean — and parse-config.mjs branches its own #1097 gate on
    // config.enforcement, so a commented-out key armed the strictest path.
    const kv = _parseKV(_extractConfigSection(COMMENTED));
    expect(kv.has('enforcement')).toBe(false);
    expect(kv.get('persistence')).toBe('true');
    expect(kv.get('vcs')).toBe('github');
  });

  it('reports no unparsable line for that same block', () => {
    // The other half of the divergence: whatever the reader ignores, the
    // classifier must ignore too — silence here is only correct because the
    // key above is genuinely gone, not merely unread.
    expect(collectUnparsableLines(COMMENTED)).toEqual([]);
  });

  it('leaves a single-line trailing <!-- … --> on a key line untouched', () => {
    // This repo's own convention decorates headings and keys with
    // `<!-- consistency:exempt:… -->`. The multi-line skip anchors its opener
    // at line start precisely so it cannot swallow the rest of such a block.
    const doc =
      '## Session Config\n\npersistence: true <!-- consistency:exempt:x -->\nwaves: 5\n';
    const kv = _parseKV(_extractConfigSection(doc));
    expect(kv.get('persistence')).toBe('true <!-- consistency:exempt:x -->');
    expect(kv.get('waves')).toBe('5');
    expect(collectUnparsableLines(doc)).toEqual([]);
  });
});
