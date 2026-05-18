/**
 * cross-repo.test.mjs — Unit tests for scripts/lib/config/cross-repo.mjs
 *
 * Covers:
 *   _parseCrossRepo  — PURE parser: absent block, none/null/empty, inline list,
 *                      trailing comment, non-indented break.
 *   getCrossRepoProjects — async accessor: valid config → list, missing file → [].
 *   parseSessionConfig deprecation WARN emission (B.6) — when persona-reviewers:
 *                      is present in a CLAUDE.md, parseSessionConfig emits exactly
 *                      1 byte-identical stderr WARN.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _parseCrossRepo, getCrossRepoProjects } from '@lib/config/cross-repo.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

// ---------------------------------------------------------------------------
// _parseCrossRepo — PURE parser tests
// ---------------------------------------------------------------------------

describe('_parseCrossRepo — absent block', () => {
  it('returns [] when cross-repo: block is completely absent', () => {
    expect(_parseCrossRepo('')).toEqual([]);
  });

  it('returns [] when only other blocks are present', () => {
    expect(_parseCrossRepo('persistence: true\nvcs: gitlab\n')).toEqual([]);
  });

  it('returns [] when cross-repo: block exists but has no projects: key', () => {
    const content = [
      'cross-repo:',
      '  some-other-key: value',
      '',
    ].join('\n');
    expect(_parseCrossRepo(content)).toEqual([]);
  });
});

describe('_parseCrossRepo — empty / null / none values', () => {
  it('returns [] when projects: is empty brackets []', () => {
    const content = 'cross-repo:\n  projects: []\n';
    expect(_parseCrossRepo(content)).toEqual([]);
  });

  it('returns [] when projects: is the literal value "none"', () => {
    const content = 'cross-repo:\n  projects: none\n';
    expect(_parseCrossRepo(content)).toEqual([]);
  });

  it('returns [] when projects: is the literal value "null"', () => {
    const content = 'cross-repo:\n  projects: null\n';
    expect(_parseCrossRepo(content)).toEqual([]);
  });

  it('returns [] when projects: value is empty after stripping inline comment', () => {
    const content = 'cross-repo:\n  projects:  # empty\n';
    expect(_parseCrossRepo(content)).toEqual([]);
  });
});

describe('_parseCrossRepo — inline list parsing', () => {
  it('parses a single project path', () => {
    const content = 'cross-repo:\n  projects: [~/Projects/my-app]\n';
    expect(_parseCrossRepo(content)).toEqual(['~/Projects/my-app']);
  });

  it('parses two items', () => {
    const content = 'cross-repo:\n  projects: [a, b]\n';
    expect(_parseCrossRepo(content)).toEqual(['a', 'b']);
  });

  it('parses multiple project paths into an array', () => {
    const content = 'cross-repo:\n  projects: [app-a, app-b, app-c]\n';
    expect(_parseCrossRepo(content)).toEqual(['app-a', 'app-b', 'app-c']);
  });

  it('trims whitespace around each entry', () => {
    const content = 'cross-repo:\n  projects: [ app-a ,  app-b ]\n';
    expect(_parseCrossRepo(content)).toEqual(['app-a', 'app-b']);
  });

  it('filters out empty entries after split', () => {
    const content = 'cross-repo:\n  projects: [a, , b]\n';
    // The empty element between commas is filtered by the filter(s => s.length > 0) step
    expect(_parseCrossRepo(content)).toEqual(['a', 'b']);
  });
});

describe('_parseCrossRepo — trailing comment stripped', () => {
  it('strips inline YAML comment from projects: line', () => {
    const content = 'cross-repo:\n  projects: [app-a, app-b]  # see also: app-c\n';
    expect(_parseCrossRepo(content)).toEqual(['app-a', 'app-b']);
  });
});

describe('_parseCrossRepo — non-indented break', () => {
  it('stops scanning at next top-level (non-indented) key', () => {
    const content = [
      'cross-repo:',
      '  projects: [repo-x]',
      'persistence: true',
      '',
    ].join('\n');
    expect(_parseCrossRepo(content)).toEqual(['repo-x']);
  });

  it('handles CRLF line endings', () => {
    const content = 'cross-repo:\r\n  projects: [crlf-app]\r\n';
    expect(_parseCrossRepo(content)).toEqual(['crlf-app']);
  });
});

// ---------------------------------------------------------------------------
// getCrossRepoProjects — async accessor tests
// ---------------------------------------------------------------------------

describe('getCrossRepoProjects — with CLAUDE.md fixture', () => {
  it('returns the projects list from a valid CLAUDE.md with cross-repo.projects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cross-repo-test-'));
    const content = [
      '## Session Config',
      '',
      'cross-repo:',
      '  projects: [project-a, project-b]',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf8');

    const result = await getCrossRepoProjects(dir);
    expect(result).toEqual(['project-a', 'project-b']);
  });

  it('returns [] when CLAUDE.md has cross-repo: block with no projects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cross-repo-test-'));
    const content = '## Session Config\n\ncross-repo:\n  projects: []\n';
    writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf8');

    const result = await getCrossRepoProjects(dir);
    expect(result).toEqual([]);
  });

  it('returns [] when CLAUDE.md has no cross-repo: block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cross-repo-test-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '## Session Config\n\npersistence: true\n', 'utf8');

    const result = await getCrossRepoProjects(dir);
    expect(result).toEqual([]);
  });
});

describe('getCrossRepoProjects — missing CLAUDE.md', () => {
  it('returns [] without throwing when CLAUDE.md is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cross-repo-test-empty-'));
    // No CLAUDE.md written — directory is empty
    const result = await getCrossRepoProjects(dir);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _parseCrossRepo — shell-meta validation (#477)
// ---------------------------------------------------------------------------

describe('_parseCrossRepo — shell-meta validation (#477)', () => {
  let stderrCapture = [];

  beforeEach(() => {
    stderrCapture = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrCapture.push(String(msg));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an entry containing a semicolon and emits WARN to stderr', () => {
    const content = 'cross-repo:\n  projects: [bad;path, good-path]\n';
    const result = _parseCrossRepo(content);
    expect(result).toEqual(['good-path']);
    const warns = stderrCapture.filter((m) => m.includes('rejected project entry with shell metacharacter'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe('cross-repo: rejected project entry with shell metacharacter: "bad;path"\n');
  });

  it('rejects an entry containing $( shell substitution', () => {
    const content = 'cross-repo:\n  projects: [$(echo pwned), safe-repo]\n';
    const result = _parseCrossRepo(content);
    expect(result).toEqual(['safe-repo']);
    const warns = stderrCapture.filter((m) => m.includes('rejected project entry with shell metacharacter'));
    expect(warns).toHaveLength(1);
  });

  it('rejects an entry containing a backtick', () => {
    const content = 'cross-repo:\n  projects: [`cmd`, safe-repo]\n';
    const result = _parseCrossRepo(content);
    expect(result).toEqual(['safe-repo']);
    const warns = stderrCapture.filter((m) => m.includes('rejected project entry with shell metacharacter'));
    expect(warns).toHaveLength(1);
  });

  it('rejects an entry containing a space', () => {
    const content = 'cross-repo:\n  projects: [bad path, safe-repo]\n';
    const result = _parseCrossRepo(content);
    expect(result).toEqual(['safe-repo']);
    const warns = stderrCapture.filter((m) => m.includes('rejected project entry with shell metacharacter'));
    expect(warns).toHaveLength(1);
  });

  it('accepts normal safe entries: my-repo, foo/bar, ~/Projects/x, app.v2', () => {
    const content = 'cross-repo:\n  projects: [my-repo, foo/bar, ~/Projects/x, app.v2]\n';
    const result = _parseCrossRepo(content);
    expect(result).toEqual(['my-repo', 'foo/bar', '~/Projects/x', 'app.v2']);
    const warns = stderrCapture.filter((m) => m.includes('rejected project entry with shell metacharacter'));
    expect(warns).toHaveLength(0);
  });

  it('WARN message format matches exactly for semicolon entry', () => {
    const content = 'cross-repo:\n  projects: [evil;entry]\n';
    _parseCrossRepo(content);
    expect(stderrCapture[0]).toBe('cross-repo: rejected project entry with shell metacharacter: "evil;entry"\n');
  });

  // W4-Q4 HIGH-1: SAFE_PATH_RE deliberately permits `../`-relative paths because
  // `.`, `/`, `-` are in the allowlist. Confinement at the sink is the actual
  // guard against path traversal. Pin both halves of that contract.
  it('regex INTENTIONALLY permits "../etc/passwd" — confinement at the sink is the guard', () => {
    const content = 'cross-repo:\n  projects: [../etc/passwd]\n';
    const result = _parseCrossRepo(content);
    // Parser passes the entry through (regex matches alphanumerics + . / -).
    expect(result).toEqual(['../etc/passwd']);
    // No shell-meta WARN — the entry has no metacharacter.
    const warns = stderrCapture.filter((m) => m.includes('shell metacharacter'));
    expect(warns).toHaveLength(0);
  });
});

// W4-Q4 HIGH-1 end-to-end: a `../`-bearing entry must be REJECTED at the sink
// by validatePathInsideProject. The regex permits it; confinement catches it.
describe('end-to-end: validatePathInsideProject rejects ../-bearing cross-repo entries (#477)', () => {
  // Inline dynamic import to keep the test file's top-level imports minimal.
  it('confinement rejects "../etc/passwd" against a ~/Projects root (real path-utils)', async () => {
    const { validatePathInsideProject } = await import('../../../scripts/lib/path-utils.mjs');
    const { realpathSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    // Resolve the would-be path the way the sink scripts do (after expandHome).
    const projectsRoot = realpathSync(join(homedir(), 'Projects'));
    const escapeAttempt = join(projectsRoot, '..', 'etc', 'passwd');
    const guard = validatePathInsideProject(escapeAttempt, projectsRoot);
    expect(guard.ok).toBe(false);
    expect(['lexical', 'symlink']).toContain(guard.reason);
  });

  it('confinement accepts a path inside the project root', async () => {
    const { validatePathInsideProject } = await import('../../../scripts/lib/path-utils.mjs');
    const { realpathSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const projectsRoot = realpathSync(join(homedir(), 'Projects'));
    const inside = join(projectsRoot, 'Bernhard', 'session-orchestrator');
    const guard = validatePathInsideProject(inside, projectsRoot);
    expect(guard.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B.6 — config.mjs deprecation WARN emission (moved here from wave-reviewers.test.mjs)
//
// After the purity fix (#478), _parseWaveReviewers no longer emits to stderr
// itself — it sets the `deprecated` flag, and config.mjs emits the WARN.
// This section verifies the caller-level behaviour using parseSessionConfig.
// ---------------------------------------------------------------------------

describe('parseSessionConfig — persona-reviewers deprecation WARN emission (B.6)', () => {
  let stderrCapture = [];

  beforeEach(() => {
    stderrCapture = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrCapture.push(String(msg));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits exactly 1 byte-identical WARN when persona-reviewers: is present', () => {
    const content = [
      '## Session Config',
      '',
      'persona-reviewers:',
      '  enabled: true',
      '  reviewers: [architect-reviewer]',
      '  mode: warn',
      '',
    ].join('\n');

    parseSessionConfig(content);

    const warns = stderrCapture.filter((m) => m.includes("'persona-reviewers' is deprecated"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(
      "Session Config: 'persona-reviewers' is deprecated — rename to 'wave-reviewers'. " +
        'Will be removed in v4.0.\n'
    );
  });

  it('emits NO WARN when only wave-reviewers: is present', () => {
    const content = [
      '## Session Config',
      '',
      'wave-reviewers:',
      '  enabled: true',
      '  reviewers: [analyst]',
      '  mode: warn',
      '',
    ].join('\n');

    parseSessionConfig(content);

    const warns = stderrCapture.filter((m) => m.includes("'persona-reviewers' is deprecated"));
    expect(warns).toHaveLength(0);
  });

  it('emits exactly 1 WARN when both wave-reviewers: and persona-reviewers: are present', () => {
    const content = [
      '## Session Config',
      '',
      'wave-reviewers:',
      '  enabled: true',
      '  reviewers: [architect-reviewer]',
      '  mode: strict',
      'persona-reviewers:',
      '  enabled: false',
      '  reviewers: [qa-strategist]',
      '  mode: off',
      '',
    ].join('\n');

    parseSessionConfig(content);

    const warns = stderrCapture.filter((m) => m.includes("'persona-reviewers' is deprecated"));
    expect(warns).toHaveLength(1);
  });

  it('emits NO WARN when neither wave-reviewers: nor persona-reviewers: is present', () => {
    const content = '## Session Config\n\npersistence: true\n';

    parseSessionConfig(content);

    const warns = stderrCapture.filter((m) => m.includes("'persona-reviewers' is deprecated"));
    expect(warns).toHaveLength(0);
  });
});
