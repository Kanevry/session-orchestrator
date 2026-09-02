/**
 * health-endpoints.test.mjs — parser unit tests for `health-endpoints`
 * (scripts/lib/config/health-endpoints.mjs) and the block form of
 * `ecosystem-health`.
 *
 * The bug each group catches is named in its describe title. The load-bearing
 * one is the round-trip: the ecosystem wizard's OWN output, produced by the
 * real writer, fed into the real parser — the two used to disagree silently
 * (`health-endpoints: null`, `ecosystem-health: false`, plus bare `name`/`url`
 * entries in the flat KV map where the last one won). #1174.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _parseHealthEndpoints, _parseEcosystemHealthBlockEnabled } from '@lib/config/health-endpoints.mjs';
import { parseSessionConfig } from '@lib/config.mjs';
import { writeSessionConfigBlock } from '@lib/ecosystem-wizard/config-writer.mjs';

// ---------------------------------------------------------------------------
// Form B — the wizard's nested block (the reported bug)
// ---------------------------------------------------------------------------

describe('Form B — wizard round-trip: writer output must survive the parser', () => {
  let sandbox;
  beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), 'health-endpoints-test-')); });
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

  it('parses the EXACT bytes writeSessionConfigBlock produces (was: null + feature dark)', () => {
    const claudeMd = join(sandbox, 'CLAUDE.md');
    writeFileSync(claudeMd, '## Session Config\n\npersistence: true\n', 'utf8');

    const written = writeSessionConfigBlock(
      claudeMd,
      {
        endpoints: [
          { name: 'API', url: 'https://api.example.com/health' },
          { name: 'Worker', url: 'http://worker:8080/healthz' },
        ],
        pipelines: [{ id: 'main', label: 'primary' }],
        criticalIssueLabels: ['priority::critical'],
      },
      false
    );
    expect(written).toBe('written');

    const content = readFileSync(claudeMd, 'utf8');
    const config = parseSessionConfig(content);

    expect(config['health-endpoints']).toEqual([
      { name: 'API', url: 'https://api.example.com/health' },
      { name: 'Worker', url: 'http://worker:8080/healthz' },
    ]);
    // The valueless `ecosystem-health:` header carries no KV pair, so the flat
    // map cannot see it — the block form must still enable the feature.
    expect(config['ecosystem-health']).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// The accepted input forms — one table, because every row is the same call
// with the same assertion shape and differs only in the bytes it feeds in.
// ---------------------------------------------------------------------------

describe('_parseHealthEndpoints — accepted input forms', () => {
  it.each([
    {
      label: 'Form B: nested block stops at the sibling `pipelines:` key instead of swallowing it',
      md: [
        'ecosystem-health:',
        '  health-endpoints:',
        '    - name: API',
        '      url: https://a/health',
        '  pipelines:',
        '    - id: main',
        '',
      ].join('\n'),
      expected: [{ name: 'API', url: 'https://a/health' }],
    },
    {
      label: 'Form B: TOP-LEVEL block terminates at the next top-level key',
      md: 'health-endpoints:\n  - name: API\n    url: https://a/health\nwaves: 5\n',
      expected: [{ name: 'API', url: 'https://a/health' }],
    },
    {
      label: 'Form B: block list items written as inline objects (session-config-template.md form)',
      md: 'health-endpoints:\n  - { name: API, url: https://api.example.com/health }\n',
      expected: [{ name: 'API', url: 'https://api.example.com/health' }],
    },
    {
      label: 'Form A: does not split on a comma inside a quoted value',
      md: 'health-endpoints: [{name: "A, B", url: "https://a/health?x=1,2"}]\n',
      expected: [{ name: 'A, B', url: 'https://a/health?x=1,2' }],
    },
    {
      label: 'Form C: a bare bracket list of URLs uses each URL as its own name',
      md: 'health-endpoints: [https://a/health, https://b/health]\n',
      expected: [
        { name: 'https://a/health', url: 'https://a/health' },
        { name: 'https://b/health', url: 'https://b/health' },
      ],
    },
    {
      // The wizard writes the BLOCK form, so an operator extending it by hand
      // writes `- <url>`. That used to WARN to null (matched as key `https`)
      // while the identical inline list parsed — i.e. hand-editing the wizard's
      // own output turned the feature off.
      label: 'Form C in BLOCK form: a bare `- <url>` item is its own name (was: null + WARN)',
      md: 'health-endpoints:\n  - https://a/health\n  - http://b:8080/healthz\n',
      expected: [
        { name: 'https://a/health', url: 'https://a/health' },
        { name: 'http://b:8080/healthz', url: 'http://b:8080/healthz' },
      ],
    },
    {
      label: 'Form C in BLOCK form: a quoted bare URL item',
      md: 'health-endpoints:\n  - "https://a/health"\n',
      expected: [{ name: 'https://a/health', url: 'https://a/health' }],
    },
    {
      label: 'Form C in BLOCK form: bare URLs mix with `name:`/`url:` entries',
      md: 'health-endpoints:\n  - https://a/health\n  - name: API\n    url: https://b/health\n',
      expected: [
        { name: 'https://a/health', url: 'https://a/health' },
        { name: 'API', url: 'https://b/health' },
      ],
    },
  ])('$label', ({ md, expected }) => {
    expect(_parseHealthEndpoints(md)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Form A — inline object array
// ---------------------------------------------------------------------------

describe('Form A — inline object array (was: _coerceList bailed to null on any "{")', () => {
  it('parses a quoted inline object array', () => {
    const md = '## Session Config\nhealth-endpoints: [{name: "API", url: "https://a/health"}, {name: "W", url: "http://w:8080/z"}]\n';
    expect(parseSessionConfig(md)['health-endpoints']).toEqual([
      { name: 'API', url: 'https://a/health' },
      { name: 'W', url: 'http://w:8080/z' },
    ]);
  });

});

// ---------------------------------------------------------------------------
// Absent / empty / malformed
// ---------------------------------------------------------------------------

describe('absent, empty and malformed input', () => {
  it.each([
    { label: 'key absent (unchanged default)', md: '## Session Config\nwaves: 5\n', expected: null },
    { label: 'empty document', md: '', expected: null },
    { label: 'null input', md: null, expected: null },
    { label: 'an empty list is [] — NOT null, so the feature stays on with 0 endpoints', md: 'health-endpoints: []\n', expected: [] },
    { label: 'the sentinel `none`', md: 'health-endpoints: none\n', expected: null },
    { label: 'the sentinel `null`', md: 'health-endpoints: null\n', expected: null },
  ])('returns the documented default for: $label', ({ md, expected }) => {
    expect(_parseHealthEndpoints(md)).toEqual(expected);
  });

  it.each([
    { label: 'an entry missing `url`', md: 'health-endpoints:\n  - name: API\n' },
    { label: 'an unmatched brace', md: 'health-endpoints: [{name: "API", url: "https://a/health"]\n' },
    // The Form-C-in-block acceptance is URL-shaped only: real garbage must keep
    // WARNing rather than becoming an endpoint named after itself.
    { label: 'a block item that is neither a key/value pair nor a URL', md: 'health-endpoints:\n  - just some text\n' },
    { label: 'a block item with an unknown key only (no name/url)', md: 'health-endpoints:\n  - timeout: 5\n' },
  ])('returns null and warns ONCE on $label', ({ md }) => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(_parseHealthEndpoints(md)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(/^config: health-endpoints:/);
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws on garbage', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => _parseHealthEndpoints('health-endpoints:\n  not a list at all\n')).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// ecosystem-health block form
// ---------------------------------------------------------------------------

describe('_parseEcosystemHealthBlockEnabled', () => {
  it('returns null when no block form is present (caller keeps its default)', () => {
    expect(_parseEcosystemHealthBlockEnabled('ecosystem-health: true\n')).toBeNull();
    expect(_parseEcosystemHealthBlockEnabled('waves: 5\n')).toBeNull();
  });

  it('returns true for a non-empty block', () => {
    expect(_parseEcosystemHealthBlockEnabled('ecosystem-health:\n  health-endpoints:\n    - name: A\n      url: u\n')).toBe(true);
  });

  it('honours an explicit `enabled: false` inside the block', () => {
    expect(_parseEcosystemHealthBlockEnabled('ecosystem-health:\n  enabled: false\n  health-endpoints: []\n')).toBe(false);
  });

  // The block path used to compare `=== 'true'` locally, so `enabled: yes`
  // silently became FALSE while the scalar path (`_coerceBoolean`) THREW on the
  // same token — one document, two truth tables. Both paths now share
  // `_coerceBoolean`: true/false case-insensitively, throw on anything else.
  it.each([
    { token: 'true', expected: true },
    { token: 'TRUE', expected: true },
    { token: 'false', expected: false },
    { token: 'False', expected: false },
  ])('block `enabled: $token` agrees with the scalar path', ({ token, expected }) => {
    expect(_parseEcosystemHealthBlockEnabled(`ecosystem-health:\n  enabled: ${token}\n  health-endpoints: []\n`)).toBe(expected);
    expect(parseSessionConfig(`## Session Config\necosystem-health: ${token}\n`)['ecosystem-health']).toBe(expected);
  });

  it.each(['yes', 'no', '1', 'on'])('block `enabled: %s` throws, exactly as the scalar path does', (token) => {
    expect(() => _parseEcosystemHealthBlockEnabled(`ecosystem-health:\n  enabled: ${token}\n`)).toThrow(/invalid boolean/);
    expect(() => parseSessionConfig(`## Session Config\necosystem-health: ${token}\n`)).toThrow(/invalid boolean/);
  });

  it('lets the scalar form win over the block form', () => {
    const md = '## Session Config\necosystem-health: false\n';
    expect(parseSessionConfig(md)['ecosystem-health']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The other five _coerceList keys must be untouched by this change
// ---------------------------------------------------------------------------

describe('the five sibling _coerceList keys keep their string[] shape', () => {
  const md = [
    '## Session Config',
    '',
    'cross-repos: [repo-a, repo-b]',
    'ssot-files: [README.md]',
    'discovery-probes: [all]',
    'discovery-exclude-paths: [dist]',
    'worktree-exclude: [node_modules]',
    '',
  ].join('\n');
  const config = parseSessionConfig(md);

  it.each([
    { key: 'cross-repos', expected: ['repo-a', 'repo-b'] },
    { key: 'ssot-files', expected: ['README.md'] },
    { key: 'discovery-probes', expected: ['all'] },
    { key: 'discovery-exclude-paths', expected: ['dist'] },
    { key: 'worktree-exclude', expected: ['node_modules'] },
  ])('$key still parses as string[]', ({ key, expected }) => {
    expect(config[key]).toEqual(expected);
  });
});
