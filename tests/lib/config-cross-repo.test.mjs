/**
 * config-cross-repo.test.mjs — split from config.test.mjs (#912 TV-003 de-hotspot).
 *
 * cross-repo.projects block parsing (#469).
 * Feature-domain slice of the former monolithic config.test.mjs. Split by
 * domain to reduce merge-conflict churn on a single hotspot file. Tests were
 * moved 1:1 from config.test.mjs — no behaviour change.
 */

import { describe, it, expect } from 'vitest';
import { parseSessionConfig } from '@lib/config.mjs';

// ---------------------------------------------------------------------------
// cross-repo.projects parsing (#469)
// ---------------------------------------------------------------------------

describe('cross-repo.projects parsing (#469)', () => {
  it('returns [] when cross-repo: block is completely absent', () => {
    const config = parseSessionConfig('## Session Config\n\npersistence: true\n');
    expect(config['cross-repo.projects']).toEqual([]);
  });

  it('returns [] when cross-repo: block exists but has no projects: key', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  some-other-key: value',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual([]);
  });

  it('returns [] when projects: is empty brackets []', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: []',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual([]);
  });

  it('returns [] when projects: is the literal value "none"', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: none',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual([]);
  });

  it('returns [] when projects: is the literal value "null"', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: null',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual([]);
  });

  it('parses a single project path', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: [~/Projects/my-app]',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual(['~/Projects/my-app']);
  });

  it('parses multiple project paths into an array', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: [app-a, app-b, app-c]',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual(['app-a', 'app-b', 'app-c']);
  });

  it('strips inline YAML comment from projects: line', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: [app-a, app-b]  # see also: app-c',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual(['app-a', 'app-b']);
  });

  it('trims whitespace around each entry', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: [ app-a ,  app-b ]',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual(['app-a', 'app-b']);
  });

  it('stops scanning at next top-level (non-indented) key after cross-repo:', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: [repo-x]',
      'persistence: true',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    // Only the projects line inside the block should be parsed; persistence is a top-level key
    expect(config['cross-repo.projects']).toEqual(['repo-x']);
    expect(config.persistence).toBe(true);
  });

  it('handles CRLF line endings inside the cross-repo: block', () => {
    const content = '## Session Config\r\n\r\ncross-repo:\r\n  projects: [crlf-app]\r\n';
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual(['crlf-app']);
  });

  it('does not throw when projects: contains only whitespace after stripping comment', () => {
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects:  # empty',
      '',
    ].join('\n');
    expect(() => parseSessionConfig(content)).not.toThrow();
    const config = parseSessionConfig(content);
    expect(config['cross-repo.projects']).toEqual([]);
  });
});
