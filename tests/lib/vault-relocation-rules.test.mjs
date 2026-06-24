/**
 * tests/lib/vault-relocation-rules.test.mjs
 *
 * Unit tests for the pure classifier helpers exported from
 * scripts/lib/vault-relocation-rules.mjs (Issue #700 vault namespacing phase-2).
 *
 * Mirrors the pattern from migrate-vault-paths-pure.test.mjs:
 *  - Import exported helpers directly.
 *  - Use _setResolverForTest to inject deterministic resolvers.
 *  - Restore the previous resolver via the returned value after each case.
 *
 * All expected values are hardcoded literals — no computed expectations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  _setResolverForTest,
  getDefaults,
  loadVaultRelocationRules,
  parseRelocationFrontmatter,
  namespaceForSession,
  namespaceForLearning,
  classifyOwner,
  isConfident,
  computeDest,
  isAlreadyNamespaced,
} from '../../scripts/lib/vault-relocation-rules.mjs';

// ---------------------------------------------------------------------------
// Resolver injection helpers
// ---------------------------------------------------------------------------

/** Identity resolver — returns the vaultName unchanged. */
function identityResolver({ vaultName }) {
  return vaultName ?? '_unsorted';
}

/**
 * Resolver that maps known vault names to short slugs;
 * throws for unknowns so misfires are detected.
 * 'session-orchestrator' → 'session-orchestrator'
 * 'BuchhaltGenie' / 'buchhaltgenie' → 'redacted-repo'
 */
function mappingResolver({ vaultName }) {
  const table = {
    'session-orchestrator': 'session-orchestrator',
    buchhaltgenie: 'redacted-repo',
    BuchhaltGenie: 'redacted-repo',
    'foo-repo': 'foo-repo',
    'my-slug': 'my-slug',
  };
  if (vaultName in table) return table[vaultName];
  // Return fallback so the test can still detect wrong-path calls
  return vaultName ?? '_unsorted';
}

/** Resolver that always throws — used to prove certain paths never call it. */
function throwingResolver() {
  throw new Error('resolver must NOT be called on this path');
}

let prevResolver;

beforeEach(() => {
  // Default to identity so any unconfigured test is transparent
  prevResolver = _setResolverForTest(identityResolver);
});

afterEach(() => {
  // Always restore so resolver state does not leak between tests
  _setResolverForTest(prevResolver);
});

// ---------------------------------------------------------------------------
// Tmp-dir helpers
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpDirs.length = 0;
});

function makeTmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'vrr-test-'));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// getDefaults
// ---------------------------------------------------------------------------

describe('getDefaults', () => {
  it('returns fallbackBucket "_unsorted"', () => {
    expect(getDefaults().fallbackBucket).toBe('_unsorted');
  });

  it('returns learningsRoot "40-learnings"', () => {
    expect(getDefaults().learningsRoot).toBe('40-learnings');
  });

  it('returns sessionsRoot "50-sessions"', () => {
    expect(getDefaults().sessionsRoot).toBe('50-sessions');
  });
});

// ---------------------------------------------------------------------------
// loadVaultRelocationRules
// ---------------------------------------------------------------------------

describe('loadVaultRelocationRules — missing file', () => {
  it('returns defaults and source "defaults" when the file does not exist', () => {
    const dir = makeTmpDir();
    const result = loadVaultRelocationRules(join(dir, 'nonexistent.yaml'));
    expect(result.source).toBe('defaults');
    expect(result.config.fallbackBucket).toBe('_unsorted');
    expect(result.config.learningsRoot).toBe('40-learnings');
    expect(result.config.sessionsRoot).toBe('50-sessions');
    expect(result.errors).toHaveLength(0);
  });

  it('never throws for a completely bogus path', () => {
    expect(() => loadVaultRelocationRules('/dev/null/impossible/path.yaml')).not.toThrow();
  });
});

describe('loadVaultRelocationRules — valid file', () => {
  it('parses a valid YAML config and returns source "file"', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'vault-relocation-rules.yaml');
    writeFileSync(filePath, 'schema-version: 1\nfallback-bucket: custom-fallback\nlearnings-root: my-learnings\nsessions-root: my-sessions\n', 'utf8');

    const result = loadVaultRelocationRules(filePath);
    expect(result.source).toBe('file');
    expect(result.config.fallbackBucket).toBe('custom-fallback');
    expect(result.config.learningsRoot).toBe('my-learnings');
    expect(result.config.sessionsRoot).toBe('my-sessions');
    expect(result.errors).toHaveLength(0);
  });
});

describe('loadVaultRelocationRules — invalid YAML', () => {
  it('returns defaults and errors for unparseable YAML', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'bad.yaml');
    writeFileSync(filePath, '{ unclosed: [bracket\n still going', 'utf8');

    const result = loadVaultRelocationRules(filePath);
    expect(result.source).toBe('defaults');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns defaults and errors when YAML is not a mapping', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'bad.yaml');
    writeFileSync(filePath, '- just\n- a\n- list\n', 'utf8');

    const result = loadVaultRelocationRules(filePath);
    expect(result.source).toBe('defaults');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseRelocationFrontmatter
// ---------------------------------------------------------------------------

describe('parseRelocationFrontmatter — basic scalars', () => {
  it('extracts type and repo from a simple frontmatter block', () => {
    const content = '---\ntype: session\nrepo: infrastructure/session-orchestrator\n---\n# body';
    const result = parseRelocationFrontmatter(content);
    expect(result.type).toBe('session');
    expect(result.repo).toBe('infrastructure/session-orchestrator');
  });

  it('extracts source and project fields', () => {
    const content = '---\ntype: learning\nproject: "[[01-projects/foo]]"\nsource: intern/aiat-pmo-module extra\n---\nbody';
    const result = parseRelocationFrontmatter(content);
    expect(result.type).toBe('learning');
    expect(result.project).toBe('[[01-projects/foo]]');
    expect(result.source).toBe('intern/aiat-pmo-module extra');
  });

  it('extracts source_session wikilink', () => {
    const content = '---\ntype: learning\nsource_session: "[[s1]]"\n---\nbody';
    const result = parseRelocationFrontmatter(content);
    expect(result.source_session).toBe('[[s1]]');
  });

  it('returns empty object when content has no frontmatter', () => {
    expect(parseRelocationFrontmatter('# No frontmatter here')).toEqual({});
  });

  it('returns empty object when frontmatter is not closed', () => {
    expect(parseRelocationFrontmatter('---\ntype: session\n')).toEqual({});
  });
});

describe('parseRelocationFrontmatter — inline array tags', () => {
  it('parses inline array tags: [project/foo, project/bar]', () => {
    const content = '---\ntags: [project/foo, project/bar]\n---\nbody';
    const result = parseRelocationFrontmatter(content);
    expect(result.tags).toEqual(['project/foo', 'project/bar']);
  });

  it('parses inline array tags with quoted values', () => {
    const content = '---\ntags: ["project/foo", "session"]\n---\nbody';
    const result = parseRelocationFrontmatter(content);
    expect(result.tags).toEqual(['project/foo', 'session']);
  });
});

describe('parseRelocationFrontmatter — block-sequence tags', () => {
  it('parses block-sequence tags', () => {
    const content = '---\ntype: session\ntags:\n  - project/session-orchestrator\n  - review\n---\nbody';
    const result = parseRelocationFrontmatter(content);
    expect(result.type).toBe('session');
    expect(result.tags).toEqual(['project/session-orchestrator', 'review']);
  });

  it('parses block-sequence tags alongside other scalar fields', () => {
    const content = '---\ntype: learning\nid: abc123\ntags:\n  - project/foo\n---\nbody';
    const result = parseRelocationFrontmatter(content);
    expect(result.id).toBe('abc123');
    expect(result.tags).toEqual(['project/foo']);
  });
});

// ---------------------------------------------------------------------------
// namespaceForSession
// ---------------------------------------------------------------------------

describe('namespaceForSession — repo: field', () => {
  it('derives namespace from last segment of repo path and source is "repo"', () => {
    // Use the mapping resolver to verify it passes the last segment
    _setResolverForTest(mappingResolver);
    const result = namespaceForSession({ repo: 'infrastructure/session-orchestrator' });
    expect(result.namespace).toBe('session-orchestrator');
    expect(result.source).toBe('repo');
  });

  it('repo with private CP6 slug (BuchhaltGenie) → resolver returns "redacted-repo"', () => {
    // The REAL resolver (resolveRepoNamespace) would fire CP6 guard.
    // We simulate it here with the mapping resolver for unit isolation.
    _setResolverForTest(mappingResolver);
    const result = namespaceForSession({ repo: 'products/BuchhaltGenie' });
    expect(result.namespace).toBe('redacted-repo');
    expect(result.source).toBe('repo');
  });
});

describe('namespaceForSession — project-tag fallback', () => {
  it('derives namespace from project/<slug> tag when repo is absent', () => {
    _setResolverForTest(identityResolver);
    const result = namespaceForSession({ tags: ['project/my-slug', 'review'] });
    expect(result.namespace).toBe('my-slug');
    expect(result.source).toBe('project-tag');
  });

  it('uses inline-array tags to find project/ tag', () => {
    _setResolverForTest(identityResolver);
    const result = namespaceForSession({ tags: ['project/foo-repo'] });
    expect(result.namespace).toBe('foo-repo');
    expect(result.source).toBe('project-tag');
  });
});

describe('namespaceForSession — fallback', () => {
  it('returns "_unsorted" and source "fallback" when neither repo nor project tag present', () => {
    const result = namespaceForSession({});
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('returns "_unsorted" when repo is empty string', () => {
    const result = namespaceForSession({ repo: '' });
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('returns "_unsorted" when repo is whitespace only', () => {
    const result = namespaceForSession({ repo: '   ' });
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });
});

describe('degenerate path-only values fall through (Q3 LOW — never CWD-derive)', () => {
  it('namespaceForSession: repo "/" → _unsorted WITHOUT calling the resolver', () => {
    _setResolverForTest(throwingResolver);
    const result = namespaceForSession({ repo: '/' });
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('namespaceForSession: repo "///" → _unsorted', () => {
    _setResolverForTest(throwingResolver);
    expect(namespaceForSession({ repo: '///' }).namespace).toBe('_unsorted');
  });

  it('namespaceForLearning: source "/" → _unsorted fallback without CWD derivation', () => {
    _setResolverForTest(throwingResolver);
    const result = namespaceForLearning({ source: '/' }, new Map());
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('namespaceForLearning: project "[[/]]" degenerate → _unsorted fallback', () => {
    _setResolverForTest(throwingResolver);
    const result = namespaceForLearning({ project: '[[/]]' }, new Map());
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// namespaceForSession — backfill index (Issue #700 W1-D5)
// ---------------------------------------------------------------------------

describe('namespaceForSession — backfill index', () => {
  it('matches the backfill index when no in-file repo/tag signal is present', () => {
    // No repo:, no project/ tag — the backfillIndex entry supplies the namespace.
    // The matched repo is returned verbatim (already leak-guarded), so the
    // resolver must NOT be called on this path.
    _setResolverForTest(throwingResolver);
    const backfillIndex = new Map([
      ['main-2026-06-21-s1', { repo: 'session-orchestrator', confidence: 'HIGH', source: 'sid-authoritative' }],
    ]);
    const result = namespaceForSession({ id: 'main-2026-06-21-s1' }, { backfillIndex });
    expect(result.namespace).toBe('session-orchestrator');
    expect(result.source).toBe('backfill');
  });

  it('lets frontmatter.repo WIN over the backfill index', () => {
    _setResolverForTest(mappingResolver);
    const backfillIndex = new Map([
      ['main-2026-06-21-s1', { repo: 'foo-repo', confidence: 'HIGH', source: 'sid-authoritative' }],
    ]);
    const result = namespaceForSession(
      { id: 'main-2026-06-21-s1', repo: 'infrastructure/session-orchestrator' },
      { backfillIndex },
    );
    expect(result.namespace).toBe('session-orchestrator');
    expect(result.source).toBe('repo');
  });

  it('lets a project/<slug> tag WIN over the backfill index', () => {
    _setResolverForTest(identityResolver);
    const backfillIndex = new Map([
      ['main-2026-06-21-s1', { repo: 'foo-repo', confidence: 'HIGH', source: 'sid-authoritative' }],
    ]);
    const result = namespaceForSession(
      { id: 'main-2026-06-21-s1', tags: ['project/my-slug'] },
      { backfillIndex },
    );
    expect(result.namespace).toBe('my-slug');
    expect(result.source).toBe('project-tag');
  });

  it('falls through to _unsorted when the backfill entry confidence is SKIP', () => {
    const backfillIndex = new Map([
      ['main-2026-06-21-s1', { repo: null, confidence: 'SKIP', source: 'id-collision' }],
    ]);
    const result = namespaceForSession({ id: 'main-2026-06-21-s1' }, { backfillIndex });
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('falls through to _unsorted when the id is absent from the backfill index', () => {
    const backfillIndex = new Map([
      ['some-other-id', { repo: 'foo-repo', confidence: 'HIGH', source: 'sid-authoritative' }],
    ]);
    const result = namespaceForSession({ id: 'main-2026-06-21-s1' }, { backfillIndex });
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('is backward-compatible: a 1-arg call behaves identically to pre-change', () => {
    const result = namespaceForSession({ id: 'main-2026-06-21-s1' });
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('forwards the backfill index through classifyOwner for a type:session note', () => {
    _setResolverForTest(throwingResolver);
    const backfillIndex = new Map([
      ['main-2026-06-21-s1', { repo: 'session-orchestrator', confidence: 'MEDIUM', source: 'branchdate-unique' }],
    ]);
    const result = classifyOwner({
      frontmatter: { type: 'session', id: 'main-2026-06-21-s1' },
      sessionRepoIndex: new Map(),
      backfillIndex,
    });
    expect(result.namespace).toBe('session-orchestrator');
    expect(result.source).toBe('backfill');
    expect(result.confident).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// namespaceForLearning
// ---------------------------------------------------------------------------

describe('namespaceForLearning — project: wikilink', () => {
  it('extracts slug from wikilink project: field and source is "project"', () => {
    _setResolverForTest(identityResolver);
    const fm = { project: '[[01-projects/session-orchestrator]]' };
    const result = namespaceForLearning(fm, new Map());
    expect(result.namespace).toBe('session-orchestrator');
    expect(result.source).toBe('project');
  });

  it('handles quoted wikilink project: field', () => {
    _setResolverForTest(identityResolver);
    const fm = { project: '"[[01-projects/foo-repo]]"' };
    const result = namespaceForLearning(fm, new Map());
    expect(result.namespace).toBe('foo-repo');
    expect(result.source).toBe('project');
  });
});

describe('namespaceForLearning — source: free-text', () => {
  it('uses first word of source: field, takes last path segment, source is "source"', () => {
    _setResolverForTest(identityResolver);
    const fm = { source: 'intern/foo-repo some extra text' };
    const result = namespaceForLearning(fm, new Map());
    expect(result.namespace).toBe('foo-repo');
    expect(result.source).toBe('source');
  });

  it('CP6 private slug in source: first word fires leak-guard via resolver → "redacted-repo"', () => {
    // Simulate what the real resolver would return for 'aiat-pmo-module'
    _setResolverForTest(({ vaultName }) => {
      if (vaultName === 'aiat-pmo-module') return 'redacted-repo';
      return vaultName ?? '_unsorted';
    });
    const fm = { source: 'aiat-pmo-module extra context' };
    const result = namespaceForLearning(fm, new Map());
    expect(result.namespace).toBe('redacted-repo');
    expect(result.source).toBe('source');
  });
});

describe('namespaceForLearning — source_session: transitive', () => {
  it('looks up session id in index and returns namespace with source "transitive"', () => {
    const fm = { source_session: '[[s1]]' };
    const index = new Map([['s1', 'foo-repo']]);
    const result = namespaceForLearning(fm, index);
    expect(result.namespace).toBe('foo-repo');
    expect(result.source).toBe('transitive');
  });

  it('falls back when session id not found in index', () => {
    const fm = { source_session: '[[missing-session]]' };
    const index = new Map([['s1', 'foo-repo']]);
    const result = namespaceForLearning(fm, index);
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('handles wikilink with display alias in source_session', () => {
    const fm = { source_session: '[[s1|Session 1 display]]' };
    const index = new Map([['s1', 'foo-repo']]);
    const result = namespaceForLearning(fm, index);
    expect(result.namespace).toBe('foo-repo');
    expect(result.source).toBe('transitive');
  });
});

describe('namespaceForLearning — fallback', () => {
  it('returns "_unsorted" and source "fallback" when no derivable field', () => {
    const result = namespaceForLearning({}, new Map());
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });

  it('returns "_unsorted" when project is empty string', () => {
    const result = namespaceForLearning({ project: '' }, new Map());
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// classifyOwner
// ---------------------------------------------------------------------------

describe('classifyOwner — dispatch on type', () => {
  it('dispatches to session path for type "session" with repo: field', () => {
    _setResolverForTest(mappingResolver);
    const result = classifyOwner({
      frontmatter: { type: 'session', repo: 'infrastructure/session-orchestrator' },
      sessionRepoIndex: new Map(),
    });
    expect(result.namespace).toBe('session-orchestrator');
    expect(result.source).toBe('repo');
    expect(result.confident).toBe(true);
  });

  it('dispatches to learning path for type "learning" with transitive lookup', () => {
    _setResolverForTest(identityResolver);
    const result = classifyOwner({
      frontmatter: { type: 'learning', source_session: '[[s1]]' },
      sessionRepoIndex: new Map([['s1', 'foo-repo']]),
    });
    expect(result.namespace).toBe('foo-repo');
    expect(result.source).toBe('transitive');
    expect(result.confident).toBe(true);
  });

  it('returns "_unsorted" WITHOUT calling resolver for unknown/absent type', () => {
    // Inject a throwing resolver to prove it is not called on the fallback path
    _setResolverForTest(throwingResolver);
    const result = classifyOwner({
      frontmatter: { type: 'unknown-type' },
      sessionRepoIndex: new Map(),
    });
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
    expect(result.confident).toBe(false);
  });

  it('returns "_unsorted" WITHOUT calling resolver when type is absent', () => {
    _setResolverForTest(throwingResolver);
    const result = classifyOwner({
      frontmatter: {},
      sessionRepoIndex: new Map(),
    });
    expect(result.namespace).toBe('_unsorted');
    expect(result.source).toBe('fallback');
    expect(result.confident).toBe(false);
  });

  it('attaches confident=false when namespace is "_unsorted" for session fallback', () => {
    const result = classifyOwner({
      frontmatter: { type: 'session' },
      sessionRepoIndex: new Map(),
    });
    expect(result.confident).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isConfident
// ---------------------------------------------------------------------------

describe('isConfident', () => {
  it('returns false for "_unsorted"', () => {
    expect(isConfident('_unsorted')).toBe(false);
  });

  it('returns false for "redacted-repo"', () => {
    expect(isConfident('redacted-repo')).toBe(false);
  });

  it('returns false for "unknown-repo"', () => {
    expect(isConfident('unknown-repo')).toBe(false);
  });

  it('returns true for a real repo slug', () => {
    expect(isConfident('session-orchestrator')).toBe(true);
  });

  it('returns true for an arbitrary non-sentinel slug', () => {
    expect(isConfident('my-project')).toBe(true);
  });

  it('returns true for "foo-repo" (not in sentinel list)', () => {
    expect(isConfident('foo-repo')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeDest
// ---------------------------------------------------------------------------

describe('computeDest', () => {
  it('computes path as root/namespace/basename', () => {
    const result = computeDest({ basename: 'x.md', root: '/v/40-learnings', namespace: 'foo' });
    expect(result).toBe('/v/40-learnings/foo/x.md');
  });

  it('computes path for a different root and namespace', () => {
    const result = computeDest({
      basename: '2026-06-21-session.md',
      root: '/vault/50-sessions',
      namespace: 'session-orchestrator',
    });
    expect(result).toBe('/vault/50-sessions/session-orchestrator/2026-06-21-session.md');
  });

  it('handles _unsorted namespace correctly in path', () => {
    const result = computeDest({ basename: 'note.md', root: '/v/40-learnings', namespace: '_unsorted' });
    expect(result).toBe('/v/40-learnings/_unsorted/note.md');
  });
});

// ---------------------------------------------------------------------------
// isAlreadyNamespaced
// ---------------------------------------------------------------------------

describe('isAlreadyNamespaced', () => {
  it('returns true for a path with a subdirectory ("foo/bar.md")', () => {
    expect(isAlreadyNamespaced('foo/bar.md')).toBe(true);
  });

  it('returns true for a deeper nested path', () => {
    expect(isAlreadyNamespaced('session-orchestrator/2026-06-21-note.md')).toBe(true);
  });

  it('returns false for a flat top-level filename ("bar.md")', () => {
    expect(isAlreadyNamespaced('bar.md')).toBe(false);
  });

  it('returns false for a filename with no path separator', () => {
    expect(isAlreadyNamespaced('note-without-namespace.md')).toBe(false);
  });
});
