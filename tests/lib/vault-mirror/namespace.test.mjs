/**
 * namespace.test.mjs — Unit tests for scripts/lib/vault-mirror/namespace.mjs
 *
 * Tests resolveRepoNamespace({ vaultName?, cwd? }) → string contract:
 *  - vaultName override → sanitised slug (deterministic)
 *  - Leak redaction: CP1 (personal home path), CP6 (private slug), CP10 (personal Projects path)
 *  - Degenerate input (all special chars) → 'unknown-repo'
 *  - No vaultName → falls back to deriveRepo() path; result is a non-empty valid kebab slug
 *
 * All expected values are hardcoded literals derived empirically from subjectToSlug()
 * and isOwnerLeakySegment() so a bug in the production function fails the assertion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveRepoNamespace,
  _setNamespaceMapPath,
  _resetNamespaceMapState,
} from '@lib/vault-mirror/namespace.mjs';
import { _resetPseudonymMapCache } from '@lib/vault-mirror/pseudonym-map.mjs';

// Insulate EVERY test in this file from the machine's real owner.yaml: force
// "no pseudonym map" by default so the existing redaction/slug pins stay
// deterministic and green regardless of any host-local namespace map (#725 D5).
// The mapping describe-block below opts specific tests INTO a tmp map.
let _tmpDirs = [];
beforeEach(() => {
  _resetNamespaceMapState();
  _setNamespaceMapPath(null); // null = explicitly no map
  _resetPseudonymMapCache();
});
afterEach(() => {
  _resetNamespaceMapState();
  _resetPseudonymMapCache();
  for (const d of _tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  _tmpDirs = [];
  vi.restoreAllMocks();
});

/** Write a tmp namespace-map JSON file and pin it as the active map. Returns its path. */
function writeMap(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-map-test-'));
  _tmpDirs.push(dir);
  const p = join(dir, 'namespace-map.json');
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// vault-name override → sanitised slug
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — vaultName override', () => {
  it('simple kebab name passes through unchanged', () => {
    expect(resolveRepoNamespace({ vaultName: 'test-vault' })).toBe('test-vault');
  });

  it('spaces are STRIPPED (not converted to hyphens) — matches subjectToSlug behavior', () => {
    // "My Repo" → lowercase → strip non-[a-z0-9-] (space is stripped) → "myrepo"
    expect(resolveRepoNamespace({ vaultName: 'My Repo' })).toBe('myrepo');
  });

  it('uppercase is lowercased', () => {
    expect(resolveRepoNamespace({ vaultName: 'MyVault' })).toBe('myvault');
  });

  it('dots and underscores are replaced with hyphens', () => {
    // "my.vault_name" → "my-vault-name"
    expect(resolveRepoNamespace({ vaultName: 'my.vault_name' })).toBe('my-vault-name');
  });

  it('a plain lowercase kebab slug is returned as-is', () => {
    expect(resolveRepoNamespace({ vaultName: 'session-orchestrator' })).toBe('session-orchestrator');
  });

  it('whitespace-only vaultName falls back to deriveRepo() (treated as absent)', () => {
    // "   " trims to "", which is falsy — falls through to deriveRepo()
    const result = resolveRepoNamespace({ vaultName: '   ' });
    // Result must be non-empty and a valid kebab slug
    expect(result).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Leak redaction: CP1 / CP6 / CP10
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — owner-privacy leak redaction', () => {
  // CP6 in-process guard now uses the VAULT_CLEAR_SLUGS carve-out (issue #59,
  // owner decision 2026-07-18): only Codex-Hackathon + aiat-pmo-module still
  // redact in-process; the other 5 slugs resolve to their own vault namespace
  // (the tracked-file scanner, runScan, still blocks ALL 7 from the public
  // mirror — proven by check-owner-leakage.test.mjs Positive-3/3b staying green).
  it('CP6 (retained): private slug "Codex-Hackathon" is redacted to "redacted-repo"', () => {
    // isOwnerLeakySegment('Codex-Hackathon') returns 'CP6' (NOT carved out)
    expect(resolveRepoNamespace({ vaultName: 'Codex-Hackathon' })).toBe('redacted-repo');
  });

  it('CP6 (retained): private slug "aiat-pmo-module" is redacted to "redacted-repo"', () => {
    // isOwnerLeakySegment('aiat-pmo-module') returns 'CP6' (NOT carved out) —
    // proves the in-process CP6 guard still bites for retained slugs.
    expect(resolveRepoNamespace({ vaultName: 'aiat-pmo-module' })).toBe('redacted-repo');
  });

  it('CP1: personal home path "/Users/bernhardg/x" is redacted to "redacted-repo"', () => {
    // isOwnerLeakySegment('/Users/bernhardg/x') returns 'CP1'
    expect(resolveRepoNamespace({ vaultName: '/Users/bernhardg/x' })).toBe('redacted-repo');
  });

  it('CP10: personal Projects path "~/Projects/Bernhard" is redacted to "redacted-repo"', () => {
    // isOwnerLeakySegment('~/Projects/Bernhard') returns 'CP10'
    expect(resolveRepoNamespace({ vaultName: '~/Projects/Bernhard' })).toBe('redacted-repo');
  });
});

// ---------------------------------------------------------------------------
// VAULT_CLEAR_SLUGS carve-out (issue #59, owner decision 2026-07-18)
//
// These 5 slugs stay in the tracked-file scanner's PRIVATE_SLUGS (public-mirror
// leak guard is UNCHANGED) but are cleared for in-process vault namespacing, so
// resolveRepoNamespace returns each slug's own namespace instead of collapsing
// to the shared 'redacted-repo' bucket. Values are hardcoded literals verified
// empirically against resolveRepoNamespace (see isOwnerLeakySegment).
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — VAULT_CLEAR_SLUGS carve-out (#59)', () => {
  it('carved slug "buchhaltgenie" resolves to its own namespace (not redacted)', () => {
    expect(resolveRepoNamespace({ vaultName: 'buchhaltgenie' })).toBe('buchhaltgenie');
  });

  it('carved slug "mail-assistant" resolves to its own namespace (not redacted)', () => {
    expect(resolveRepoNamespace({ vaultName: 'mail-assistant' })).toBe('mail-assistant');
  });

  it('carved slug "wien-forschungsfragen-klima" resolves to its own namespace (not redacted)', () => {
    expect(resolveRepoNamespace({ vaultName: 'wien-forschungsfragen-klima' })).toBe('wien-forschungsfragen-klima');
  });

  it('carved slug "launchpad-ai-factory" resolves to its own namespace (not redacted)', () => {
    // Flipped from the pre-#59 redaction pin: launchpad-ai-factory is now carved out.
    expect(resolveRepoNamespace({ vaultName: 'launchpad-ai-factory' })).toBe('launchpad-ai-factory');
  });

  it('carved slug "AngebotsChecker" resolves to its lowercased slug (not redacted)', () => {
    // subjectToSlug lowercases the clean value once it is no longer CP6-leaky.
    expect(resolveRepoNamespace({ vaultName: 'AngebotsChecker' })).toBe('angebotschecker');
  });
});

// ---------------------------------------------------------------------------
// Degenerate / empty slug
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — degenerate inputs', () => {
  it('vaultName with only special chars collapses to empty slug → "unknown-repo"', () => {
    // "!@#$" → subjectToSlug strips all → "" → fallback
    expect(resolveRepoNamespace({ vaultName: '!@#$' })).toBe('unknown-repo');
  });

  it('null vaultName falls back to deriveRepo() and returns a non-empty slug', () => {
    const result = resolveRepoNamespace({ vaultName: null });
    expect(result.length).toBeGreaterThan(0);
    // Must be a valid kebab slug (may include slashes from org/repo form — accept either)
    expect(result).not.toBe('');
  });

  it('no argument at all falls back to deriveRepo() and returns a non-empty string', () => {
    const result = resolveRepoNamespace();
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Default path: no vaultName → deriveRepo() result passes leak + slug validation
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — default (no vaultName)', () => {
  it('returns a non-empty string when vaultName is omitted', () => {
    const result = resolveRepoNamespace({});
    expect(result.length).toBeGreaterThan(0);
  });

  it('does not return "unknown-repo" in the default case (repo name is present)', () => {
    // deriveRepo() falls back to path.basename(process.cwd()) at minimum,
    // so the slug will not be empty in a real repo context.
    const result = resolveRepoNamespace({});
    expect(result).not.toBe('unknown-repo');
  });

  it('result is lowercase only (no uppercase chars)', () => {
    const result = resolveRepoNamespace({});
    expect(result).toBe(result.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Host-local pseudonym mapping (#725 D5)
//
// Design: the map is consulted ONLY at the redaction site — a mapped OWNER-LEAKY
// repo returns its stable pseudonym instead of collapsing to 'redacted-repo';
// clean repos never touch the map (and never trigger the lazy owner.yaml read).
//
// Fixture-name policy: pseudonym VALUES use invented slugs ('alpha-team'). The
// only real token used is 'bernhardg' — an owner USERNAME (CP1), already present
// in this scanner-allowlisted redaction-fixture file above — reused ONLY to drive
// the leaky-repo redaction site (the map is leaky-only, so a leaky KEY is required
// to exercise it) and to prove a leaky pseudonym VALUE is rejected. No real CP6
// project slug is introduced. Exhaustive map-parsing edge cases (invalid slug,
// missing file, non-object JSON) are covered synthetically in pseudonym-map.test.mjs.
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — pseudonym mapping', () => {
  it('a MAPPED owner-leaky repo returns its stable pseudonym instead of "redacted-repo"', () => {
    // 'bernhardg' is owner-leaky (CP1). With a host-local mapping it resolves to the
    // pseudonym — preserving per-repo write-isolation (#660) instead of collapsing to
    // the shared 'redacted-repo' bucket.
    _setNamespaceMapPath(writeMap({ bernhardg: 'alpha-team' }));
    expect(resolveRepoNamespace({ vaultName: 'bernhardg' })).toBe('alpha-team');
  });

  it('CONTROL: the same owner-leaky repo still redacts when NO map is configured', () => {
    _setNamespaceMapPath(null);
    expect(resolveRepoNamespace({ vaultName: 'bernhardg' })).toBe('redacted-repo');
  });

  it('a CLEAN repo is returned as-is even when a map is configured (map is leaky-only)', () => {
    // The map is consulted only at the redaction site, so a non-leaky repo never
    // touches it — 'acme-internal' resolves to itself, not to any mapped value.
    _setNamespaceMapPath(writeMap({ bernhardg: 'alpha-team' }));
    expect(resolveRepoNamespace({ vaultName: 'acme-internal' })).toBe('acme-internal');
  });

  it('an owner-leaky repo NOT present in the map still redacts (backward-compatible)', () => {
    // Map exists but has no entry for this repo → falls through to redaction.
    _setNamespaceMapPath(writeMap({ bernhardg: 'alpha-team' }));
    expect(resolveRepoNamespace({ vaultName: '~/Projects/Bernhard' })).toBe('redacted-repo');
  });

  it('missing map file → owner-leaky repo redacts (fallback)', () => {
    _setNamespaceMapPath('/tmp/definitely-not-a-real-namespace-map-xyz/map.json');
    expect(resolveRepoNamespace({ vaultName: 'bernhardg' })).toBe('redacted-repo');
  });

  it('malformed JSON map → owner-leaky repo redacts + WARN', () => {
    const writes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((m) => {
      writes.push(String(m));
      return true;
    });
    _setNamespaceMapPath(writeMap('{ not: valid json'));
    expect(resolveRepoNamespace({ vaultName: 'bernhardg' })).toBe('redacted-repo');
    expect(writes.some((w) => /malformed JSON/.test(w))).toBe(true);
  });

  it('a leaky PSEUDONYM in the map is rejected → repo redacts + WARN (leak never reaches vault)', () => {
    const writes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((m) => {
      writes.push(String(m));
      return true;
    });
    // The mapped pseudonym is itself owner-leaky → dropped by loadPseudonymMap, so the
    // repo falls back to redaction rather than writing the leaky value into the vault.
    _setNamespaceMapPath(writeMap({ bernhardg: 'bernhardg' }));
    expect(resolveRepoNamespace({ vaultName: 'bernhardg' })).toBe('redacted-repo');
    expect(writes.some((w) => /owner-leaky/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #1039 — deriveRepo resolves the PREFERRED remote, and its fallback says WHY
//
// These tests drive REAL git repositories in tmpdirs (no child_process mock),
// because the bug class being pinned is precisely a wrong assumption about what
// git prints: the pre-#1039 implementation read `git remote get-url origin` and
// therefore (a) saw nothing in a repo whose remotes are named gitlab/github and
// (b) mis-parsed the filesystem-path origin that `git clone <path>` records.
// A mocked git cannot falsify either claim — only git can.
// ---------------------------------------------------------------------------

describe('deriveRepo (#1039) — preferred-remote resolution + distinguishable fallback', () => {
  const ORIGINAL_CWD = process.cwd();

  /** Create a tracked tmp dir; realpath so macOS /var → /private/var is stable. */
  function makeDir(prefix) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    _tmpDirs.push(dir);
    return dir;
  }

  function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** `git init` + one empty commit, so the repo is clonable. */
  function initRepo(dir) {
    git(['init', '-q', dir], tmpdir());
    git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], dir);
    return dir;
  }

  /**
   * Fresh module instance — the ONLY way to reset deriveRepo's module-level
   * `_cachedRepo`, which is deliberately process-lifetime state.
   */
  async function freshNamespaceModule() {
    vi.resetModules();
    const mod = await import('@lib/vault-mirror/namespace.mjs');
    mod._setNamespaceMapPath(null); // insulate from the host's real owner.yaml
    return mod;
  }

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
  });

  it('A1: a filesystem-path origin (git clone <path>/.) yields the repo name, not "unknown-repo"', async () => {
    // The exact state the pre-push hook's clone produced on 2026-08-19:
    // `git clone <src>/.` records origin verbatim as `/…/<repo>/.`, whose last
    // segment is a bare dot. The old regex captured "<repo>/." → slug "" →
    // 'unknown-repo', which turned the namespace assertion below red and
    // blocked a real push.
    const base = makeDir('ns-clone-');
    const source = initRepo(join(base, 'widget-service'));
    const clone = join(base, 'checkout');
    git(['clone', '-q', `${source}/.`, clone], base);

    // Golden record: this is what git itself wrote into the clone's config.
    expect(git(['remote', 'get-url', 'origin'], clone).trim()).toBe(`${source}/.`);

    process.chdir(clone);
    const mod = await freshNamespaceModule();

    expect(mod.deriveRepo()).toBe('widget-service');
    expect(mod.resolveRepoNamespace({})).toBe('widget-service');
    expect(mod.resolveRepoNamespace({})).not.toBe('unknown-repo');
  });

  it('A2: a repo with gitlab + github remotes and NO origin resolves to the repo identity', async () => {
    // Pre-#1039 this fell through to basename(process.cwd()) — i.e. vault notes
    // were namespaced under the CHECKOUT DIRECTORY, not the repo.
    const repo = initRepo(join(makeDir('ns-noorigin-'), 'checkout-dir'));
    git(['remote', 'add', 'gitlab', 'git@gitlab.example.com:acme-group/widget-service.git'], repo);
    git(['remote', 'add', 'github', 'https://github.com/acme/widget-service.git'], repo);

    process.chdir(repo);
    const mod = await freshNamespaceModule();

    expect(mod.deriveRepo()).toBe('acme-group/widget-service');
    expect(mod.resolveRepoNamespace({})).toBe('widget-service');
    expect(mod.resolveRepoNamespace({})).not.toBe(basename(repo));
  });

  it('A3a: a repo with NO remotes falls back to the directory name SILENTLY (absence is not a defect)', async () => {
    const repo = initRepo(join(makeDir('ns-noremotes-'), 'lonely-repo'));

    const writes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((m) => {
      writes.push(String(m));
      return true;
    });

    process.chdir(repo);
    const mod = await freshNamespaceModule();

    expect(mod.deriveRepo()).toBe('lonely-repo');
    expect(writes.filter((w) => w.includes('vault-mirror/namespace'))).toEqual([]);
  });

  it('A3b: OUTSIDE a git repo the same fallback WARNS and names the query failure', async () => {
    // Same returned value as A3a, opposite cause. Before #1039 the two were
    // indistinguishable, and the guessed identity was written to the vault
    // without a word.
    const dir = join(makeDir('ns-nogit-'), 'plain-dir');
    mkdirSync(dir);

    const writes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((m) => {
      writes.push(String(m));
      return true;
    });

    process.chdir(dir);
    const mod = await freshNamespaceModule();

    expect(mod.deriveRepo()).toBe('plain-dir');
    const warns = writes.filter((w) => w.includes('vault-mirror/namespace'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('not-a-git-repo');
  });

  it('A4: the module-level cache still holds — three calls, ONE git spawn', async () => {
    // Faithful double: the fixture is real `git remote -v` output (tab-separated
    // name/url + " (fetch)"/" (push)" suffix), captured from git on 2026-08-19.
    const remoteV = [
      'origin\tgit@gitlab.example.com:acme-group/cached-repo.git (fetch)',
      'origin\tgit@gitlab.example.com:acme-group/cached-repo.git (push)',
      '',
    ].join('\n');
    const execMock = vi.fn(() => remoteV);

    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: execMock };
    });
    try {
      const mod = await import('@lib/vault-mirror/namespace.mjs');
      expect(mod.deriveRepo()).toBe('acme-group/cached-repo');
      expect(mod.deriveRepo()).toBe('acme-group/cached-repo');
      expect(mod.deriveRepo()).toBe('acme-group/cached-repo');
      expect(execMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('node:child_process');
    }
  });
});

// ---------------------------------------------------------------------------
// #734b — the namespace.mjs ↔ process.mjs import cycle stays broken
// ---------------------------------------------------------------------------

describe('module topology (#734b) — no cycle back into the mirroring pipeline', () => {
  const NAMESPACE_SRC = fileURLToPath(
    new URL('../../../scripts/lib/vault-mirror/namespace.mjs', import.meta.url),
  );

  it('does not import ./process.mjs — that edge is the cycle', () => {
    // A structural invariant, not a style pin: the reverse edge already exists
    // (process.mjs imports resolveRepoNamespace), so re-adding this one closes
    // the loop again. Three consumers — vault-repo-backfill.mjs,
    // vault-relocation-rules.mjs, scripts/vault-mirror.mjs — import ONLY the
    // pure string function from here and would silently start dragging the
    // whole render/secret-masker graph behind it.
    const src = readFileSync(NAMESPACE_SRC, 'utf8');
    const importedSpecifiers = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)]
      .map((m) => m[1]);

    expect(importedSpecifiers).not.toContain('./process.mjs');
    // Falsification guard: the regex really does see this file's imports, so a
    // rename that breaks the match cannot make the assertion above vacuous.
    expect(importedSpecifiers).toContain('./utils.mjs');
  });

  it('deriveRepo re-exported from process.mjs is the SAME binding as the one defined here', async () => {
    // One definition, one module-level cache. Two copies would mean two
    // `git remote get-url origin` spawns and two divergent caches.
    const own = await import('@lib/vault-mirror/namespace.mjs');
    const reexported = await import('@lib/vault-mirror/process.mjs');
    expect(reexported.deriveRepo).toBe(own.deriveRepo);
  });
});
