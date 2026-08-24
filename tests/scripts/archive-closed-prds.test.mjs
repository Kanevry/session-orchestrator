/**
 * archive-closed-prds.test.mjs — hermetic DI tests for scripts/archive-closed-prds.mjs
 *
 * Uses dependency injection (glabRunFn / gitRunFn / hostPaths) rather than env
 * bleed — the CLI never shells out to a real glab/git and never reads the real
 * owner.yaml (issue #653 vault-dir bleed guard). Every test uses a mkdtemp repo +
 * vault fixture; the real repo / vault are NEVER touched.
 *
 * Covers:
 *   - closed-Epic PRD → archived (dry-run: manifest only; --apply: vault write + git rm)
 *   - open-Epic PRD   → skipped (untouched)
 *   - no-Epic-ref PRD → skipped + warn (never guess)
 *   - unknown state   → skipped (glab error → never guess)
 *   - *.original-uncommitted.md → excluded from enumeration
 *   - missing vault-dir → exit 1
 *   - --json emits a machine-readable manifest
 *   - custom-phase command is SAFE_COMMAND_RE-conformant (survives _parseCustomPhases)
 *   - pure helpers: parseEpicRef, readHeaderRegion, listTrackedPrds, epicState
 *
 * #786 generalisation (additive — see "Plans-Routing" below):
 *   - --prd-dir docs/plans routes archival to a distinct vault-subdir; closed-Epic
 *     plans archive + git-rm, open-Epic plans stay untouched, path-shaped
 *     `Source:` headers without a #NNN ref skip (no-epic-ref, fail-closed)
 *   - a --prd-dir with zero tracked docs (e.g. docs/plans not yet created) is
 *     graceful: exit 0, empty archived/skipped, no throw
 *   - the second (`archive-closed-plans`) custom-phase entry in CLAUDE.md also
 *     survives _parseCustomPhases
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  main,
  parseEpicDeclaration,
  parseEpicRef,
  classifyOwnership,
  readHeaderRegion,
  listTrackedPrds,
  epicState,
  defaultGlabRepo,
} from '../../scripts/archive-closed-prds.mjs';
import { _parseCustomPhases } from '@lib/config/custom-phases.mjs';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_REAL = realpathSync(tmpdir());
const cleanups = [];

function mkTmp(prefix = 'acp-') {
  const d = mkdtempSync(join(TMP_REAL, prefix));
  cleanups.push(d);
  return d;
}
function writeFile(base, rel, content) {
  const full = join(base, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

afterEach(() => {
  while (cleanups.length) {
    try {
      rmSync(cleanups.pop(), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const FIXED_NOW = new Date('2026-03-04T09:00:00Z');
// The fixture session started at FIXED_NOW; fixture docs were committed well
// before it, so the #1123 ownership guard classifies them as 'mine'.
const SESSION_STARTED_AT = FIXED_NOW.toISOString();
const OLD_COMMIT_ISO = '2026-01-01T00:00:00Z';
// Hermetic host-path ctx: no env override, no owner.yaml — committed value wins.
const HOST_PATHS = { env: {}, ownerConfig: undefined };

/**
 * Build a repo fixture with a CLAUDE.md (vault-dir → tmp vault) and 5 PRDs.
 * @param {object} [opts]
 * @param {boolean} [opts.withVaultDir=true]
 * @returns {{ repo: string, vault: string, prdRelPaths: string[] }}
 */
function makeRepo({ withVaultDir = true } = {}) {
  const repo = mkTmp('acp-repo-');
  const vault = mkTmp('acp-vault-');

  const vaultBlock = withVaultDir
    ? ['vault-integration:', '  enabled: true', `  vault-dir: ${vault}`, '  mode: warn', '']
    : ['vault-integration:', '  enabled: true', '  mode: warn', ''];

  writeFile(
    repo,
    'CLAUDE.md',
    ['# Fixture', '', '## Session Config', '', 'persistence: true', '', ...vaultBlock].join('\n'),
  );

  writeFile(
    repo,
    'docs/prd/2026-01-01-closed-epic.md',
    '# PRD — Closed Thing\n\n**Parent Epic:** #100 — done\n\n## Problem\n\nbody\n',
  );
  writeFile(
    repo,
    'docs/prd/2026-01-02-open-epic.md',
    '# PRD — Open Thing\n\n**Epic:** [#200 in progress]\n\n## Problem\n\nbody\n',
  );
  writeFile(
    repo,
    'docs/prd/2026-01-03-no-epic.md',
    '# PRD — No Epic Here\n\n**Status:** Draft\n\n## Problem\n\nbody\n',
  );
  writeFile(
    repo,
    'docs/prd/2026-01-04-unknown-epic.md',
    '# PRD — Unknown\n\n**Parent Epic:** #999\n\n## Problem\n\nbody\n',
  );
  writeFile(
    repo,
    'docs/prd/2026-01-05-legacy.original-uncommitted.md',
    '# PRD — Legacy uncommitted\n\n**Epic:** #100\n\n## Problem\n\nbody\n',
  );


  // A STATE.md carrying this session's started_at — the fallback identity source
  // readSessionStartedAt() uses when no .orchestrator/session.lock exists. Written
  // as a fixture (not injected) so the real resolution path is exercised.
  writeFile(
    repo,
    '.claude/STATE.md',
    ['---', 'schema-version: 1', 'session: fixture-session', `started_at: ${SESSION_STARTED_AT}`, 'issues: [100]', 'status: active', '---', '', '# STATE', ''].join('\n'),
  );

  const prdRelPaths = [
    'docs/prd/2026-01-01-closed-epic.md',
    'docs/prd/2026-01-02-open-epic.md',
    'docs/prd/2026-01-03-no-epic.md',
    'docs/prd/2026-01-04-unknown-epic.md',
    'docs/prd/2026-01-05-legacy.original-uncommitted.md',
  ];

  return { repo, vault, prdRelPaths };
}

/** Fake glab: 100→closed, 200→opened, everything else → API error. */
function makeGlab() {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const iid = args[2];
    if (iid === '100') return { ok: true, stdout: JSON.stringify({ state: 'closed' }), stderr: '' };
    if (iid === '200') return { ok: true, stdout: JSON.stringify({ state: 'opened' }), stderr: '' };
    return { ok: false, stdout: '', stderr: `issue #${iid} not found` };
  };
  return { fn, calls };
}

/**
 * Fake git: ls-files → the fixture doc list; remote -v → fake remotes; rm → ok;
 * status --porcelain / log -1 → the #1123 ownership probes (see inline).
 * @param {string[]} prdRelPaths
 * @param {{ porcelain?: Record<string,string>, committedAt?: Record<string,string> }} [overrides]
 */
function makeGit(prdRelPaths, overrides = {}) {
  const rmCalls = [];
  const fn = (args) => {
    if (args.includes('ls-files')) {
      return { ok: true, stdout: prdRelPaths.join('\n') + '\n', stderr: '' };
    }
    // #1123 session-ownership probes. Defaults model the benign case: the doc
    // is committed, clean, and OLDER than the fixture session's started_at
    // (FIXED_NOW) — i.e. ours to archive. Individual tests override via
    // `overrides` to model a dirty tree or a parallel session's fresh commit.
    if (args.includes('status') && args.includes('--porcelain')) {
      const rel = args[args.length - 1];
      return { ok: true, stdout: overrides.porcelain?.[rel] ?? '', stderr: '' };
    }
    if (args.includes('log') && args.includes('-1')) {
      const rel = args[args.length - 1];
      return { ok: true, stdout: (overrides.committedAt?.[rel] ?? OLD_COMMIT_ISO) + '\n', stderr: '' };
    }
    if (args.includes('remote') && args.includes('-v')) {
      // `git remote -v` shape (#1039): the resolver makes ONE such call and
      // parses `<name>\t<url> (fetch|push)`; it no longer runs one
      // `git remote get-url <name>` per preference entry. `origin` carries a
      // DIFFERENT url on purpose — the --apply assertion below pins the
      // resolved `-R` value, so "the spec comes from the gitlab remote" stays
      // a checked claim now that no remote name appears in the git argv.
      return {
        ok: true,
        stdout:
          'gitlab\thttps://example.test/group/repo.git (fetch)\n' +
          'gitlab\thttps://example.test/group/repo.git (push)\n' +
          'origin\thttps://example.test/group/origin-must-lose.git (fetch)\n' +
          'origin\thttps://example.test/group/origin-must-lose.git (push)\n',
        stderr: '',
      };
    }
    if (args.includes('rm')) {
      rmCalls.push(args);
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: `unexpected git args: ${args.join(' ')}` };
  };
  return { fn, rmCalls };
}

/**
 * Build a repo fixture with a CLAUDE.md (vault-dir → tmp vault) and 3 docs/plans/
 * fixtures — additive #786-generalisation coverage (Plans-Routing) alongside
 * makeRepo()'s docs/prd fixtures. Executable plans carry a `**Source:** <path> (#NNN)`
 * back-reference header (never the PRD's `**Epic:**`/`**Parent Epic:**` field), but
 * parseEpicRef/readHeaderRegion are field-name-agnostic — they just scan the header
 * region for the first `#NNN` — so the same pure helpers apply unchanged.
 * @returns {{ repo: string, vault: string, planRelPaths: string[] }}
 */
function makePlansRepo() {
  const repo = mkTmp('acp-plans-repo-');
  const vault = mkTmp('acp-plans-vault-');

  writeFile(
    repo,
    'CLAUDE.md',
    [
      '# Fixture',
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
      'vault-integration:',
      '  enabled: true',
      `  vault-dir: ${vault}`,
      '  mode: warn',
      '',
    ].join('\n'),
  );

  writeFile(
    repo,
    'docs/plans/2026-02-01-closed-plan.md',
    '# Plan — Closed Thing\n\n**Source:** docs/prd/2026-01-01-closed-epic.md (#100)\n\n## Steps\n\nbody\n',
  );
  writeFile(
    repo,
    'docs/plans/2026-02-02-open-plan.md',
    '# Plan — Open Thing\n\n**Source:** docs/prd/2026-01-02-open-epic.md (#200)\n\n## Steps\n\nbody\n',
  );
  writeFile(
    repo,
    'docs/plans/2026-02-03-no-epic-plan.md',
    '# Plan — No Epic Ref\n\n**Source:** docs/prd/2026-01-03-no-epic.md\n\n## Steps\n\nbody\n',
  );


  // A STATE.md carrying this session's started_at — the fallback identity source
  // readSessionStartedAt() uses when no .orchestrator/session.lock exists. Written
  // as a fixture (not injected) so the real resolution path is exercised.
  writeFile(
    repo,
    '.claude/STATE.md',
    ['---', 'schema-version: 1', 'session: fixture-session', `started_at: ${SESSION_STARTED_AT}`, 'issues: [100]', 'status: active', '---', '', '# STATE', ''].join('\n'),
  );

  const planRelPaths = [
    'docs/plans/2026-02-01-closed-plan.md',
    'docs/plans/2026-02-02-open-plan.md',
    'docs/plans/2026-02-03-no-epic-plan.md',
  ];

  return { repo, vault, planRelPaths };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseEpicRef', () => {
  it('returns the first #NNN in the header', () => {
    expect(parseEpicRef('**Epic:** [#271 foo] · deps #272–#275')).toBe('271');
    expect(parseEpicRef('**Parent Epic:** #724 (bar)')).toBe('724');
  });
  it('returns null when no #NNN is present', () => {
    expect(parseEpicRef('# Title\n\n**Status:** Draft')).toBeNull();
  });
  it('ignores a markdown H1 hash (no digit after #)', () => {
    expect(parseEpicRef('# Heading only')).toBeNull();
  });
});

describe('readHeaderRegion', () => {
  it('reads up to the first ## heading', () => {
    const repo = mkTmp('acp-hdr-');
    const p = writeFile(repo, 'x.md', '# T\n\n**Epic:** #55\n\n## Problem\n\n#999 in body\n');
    const region = readHeaderRegion(p);
    expect(region).toContain('#55');
    expect(region).not.toContain('#999'); // body content excluded
  });
});

describe('listTrackedPrds', () => {
  it('filters *.md and excludes *.original-uncommitted.md', () => {
    const { fn } = makeGit([
      'docs/prd/a.md',
      'docs/prd/b.original-uncommitted.md',
      'docs/prd/README.txt',
    ]);
    const out = listTrackedPrds('/repo', 'docs/prd', fn);
    expect(out).toEqual(['docs/prd/a.md']);
  });
  it('returns [] when git ls-files fails', () => {
    const out = listTrackedPrds('/repo', 'docs/prd', () => ({ ok: false, stdout: '', stderr: 'x' }));
    expect(out).toEqual([]);
  });
});

describe('epicState', () => {
  it('maps glab state to closed/opened/unknown', () => {
    const closed = () => ({ ok: true, stdout: JSON.stringify({ state: 'closed' }), stderr: '' });
    const opened = () => ({ ok: true, stdout: JSON.stringify({ state: 'opened' }), stderr: '' });
    const err = () => ({ ok: false, stdout: '', stderr: 'boom' });
    expect(epicState('1', closed)).toBe('closed');
    expect(epicState('1', opened)).toBe('opened');
    expect(epicState('1', err)).toBe('unknown');
  });
  it('returns unknown on unparseable JSON (never guesses)', () => {
    expect(epicState('1', () => ({ ok: true, stdout: 'not json', stderr: '' }))).toBe('unknown');
  });
  it('appends -R when a glabRepo is given (host resolves non-interactively)', () => {
    let seen;
    const fn = (args) => {
      seen = args;
      return { ok: true, stdout: JSON.stringify({ state: 'closed' }), stderr: '' };
    };
    epicState('7', fn, 'group/session-orchestrator');
    expect(seen).toEqual(['issue', 'view', '7', '--output', 'json', '-R', 'group/session-orchestrator']);
  });
});

describe('defaultGlabRepo', () => {
  /**
   * `git remote -v` stdout (#1039): ONE call, `<name>\t<url> (fetch|push)`
   * lines. The preference order the two tests below pin used to be visible in
   * the ARGV (`remote get-url gitlab`); it is now visible only in WHICH url
   * comes back, so each case lists every competing remote and asserts the
   * winner by value.
   * @param {Array<[name: string, url: string]>} entries
   */
  const remoteV = (entries) => (args) =>
    args.includes('remote') && args.includes('-v')
      ? {
          ok: true,
          stdout: entries.map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`).join(''),
          stderr: '',
        }
      : { ok: false, stdout: '', stderr: 'unexpected git args' };

  it('prefers the gitlab remote URL', () => {
    // Both remotes present: `gitlab` must win over `origin`.
    const fn = remoteV([
      ['gitlab', 'https://host/g/repo.git'],
      ['origin', 'https://host/g/origin-must-lose.git'],
    ]);
    expect(defaultGlabRepo('/repo', fn)).toBe('https://host/g/repo.git');
  });
  it('falls back to origin, then undefined', () => {
    // No `gitlab` remote — `origin` wins over the unranked `upstream`. The
    // second remote is load-bearing: with `origin` ALONE the sole-remote
    // fallback would return it even if the preference list were broken, so
    // the assertion would no longer test the fallback it names.
    const originOnly = remoteV([
      ['origin', 'git@host:g/repo.git'],
      ['upstream', 'git@host:g/upstream-must-lose.git'],
    ]);
    expect(defaultGlabRepo('/repo', originOnly)).toBe('git@host:g/repo.git');
    expect(defaultGlabRepo('/repo', () => ({ ok: false, stdout: '', stderr: 'x' }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// main — end-to-end via DI
// ---------------------------------------------------------------------------

describe('main (dry-run)', () => {
  it('archives only closed-Epic PRDs, skips the rest, writes NOTHING', () => {
    const { repo, vault, prdRelPaths } = makeRepo();
    const glab = makeGlab();
    const git = makeGit(prdRelPaths);

    const res = main({
      argv: ['--dry-run'],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });

    expect(res.code).toBe(0);
    expect(res.dryRun).toBe(true);
    expect(res.vaultDir).toBe(vault);

    // Exactly the closed PRD archived.
    expect(res.archived).toHaveLength(1);
    expect(res.archived[0]).toMatchObject({
      source: 'docs/prd/2026-01-01-closed-epic.md',
      action: 'would-archive',
      iid: '100',
      id: '2026-01-01-closed-epic',
    });
    expect(res.archived[0].target).toBe(
      '01-projects/session-orchestrator/prd/2026-01-01-closed-epic.md',
    );

    // Skips, with reasons.
    const reasons = Object.fromEntries(res.skipped.map((s) => [s.source, s.reason]));
    expect(reasons['docs/prd/2026-01-02-open-epic.md']).toBe('epic-#200-open');
    expect(reasons['docs/prd/2026-01-03-no-epic.md']).toBe('no-epic-ref');
    expect(reasons['docs/prd/2026-01-04-unknown-epic.md']).toBe('epic-#999-state-unknown');

    // *.original-uncommitted.md never enumerated.
    const allSeen = [...res.archived.map((e) => e.source), ...res.skipped.map((s) => s.source)];
    expect(allSeen).not.toContain('docs/prd/2026-01-05-legacy.original-uncommitted.md');

    // Dry-run wrote nothing to the vault and did not git rm.
    expect(
      existsSync(join(vault, '01-projects/session-orchestrator/prd/2026-01-01-closed-epic.md')),
    ).toBe(false);
    expect(git.rmCalls).toHaveLength(0);
  });
});

describe('main (--apply)', () => {
  it('writes the archived PRD into the vault and git-rm-s the source', () => {
    const { repo, vault, prdRelPaths } = makeRepo();
    const glab = makeGlab();
    const git = makeGit(prdRelPaths);

    const res = main({
      argv: ['--apply'],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });

    expect(res.code).toBe(0);
    expect(res.archived).toHaveLength(1);
    expect(res.archived[0].action).toBe('archived');
    expect(res.archived[0].removed).toBe(true);

    const target = join(vault, '01-projects/session-orchestrator/prd/2026-01-01-closed-epic.md');
    expect(existsSync(target)).toBe(true);
    const out = readFileSync(target, 'utf8');
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('id: 2026-01-01-closed-epic');
    expect(out).toContain('status: archived');
    expect(out).toContain('source-repo: session-orchestrator');
    expect(out).toContain('## Problem'); // body preserved

    // git rm called exactly for the closed PRD.
    expect(git.rmCalls).toHaveLength(1);
    expect(git.rmCalls[0]).toEqual(['-C', repo, 'rm', '--', 'docs/prd/2026-01-01-closed-epic.md']);

    // The auto-detected glab repo spec (from the 'gitlab' remote) is passed
    // through as '-R <spec>' so glab resolves the host non-interactively
    // (qa finding: main()'s effectiveGlabRepo plumbing had no E2E assertion —
    // the fake glab only read args[2], never the '-R' tail).
    expect(glab.calls[0]).toEqual([
      'issue', 'view', '100', '--output', 'json', '-R', 'https://example.test/group/repo.git',
    ]);
  });
});

describe('main (config + flag errors)', () => {
  it('exits 1 when vault-dir is not configured', () => {
    const { repo, prdRelPaths } = makeRepo({ withVaultDir: false });
    const glab = makeGlab();
    const git = makeGit(prdRelPaths);

    const res = main({
      argv: ['--dry-run'],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });
    expect(res.code).toBe(1);
    expect(res.archived).toHaveLength(0);
  });

  it('exits 1 when --apply and --dry-run are combined', () => {
    const { repo } = makeRepo();
    const res = main({ argv: ['--apply', '--dry-run'], repoRoot: repo, hostPaths: HOST_PATHS });
    expect(res.code).toBe(1);
  });

  it('exits 1 on an unknown flag', () => {
    const { repo } = makeRepo();
    const res = main({ argv: ['--bogus'], repoRoot: repo, hostPaths: HOST_PATHS });
    expect(res.code).toBe(1);
  });
});

describe('main (--json output)', () => {
  it('emits a machine-readable manifest to stdout', () => {
    const { repo, vault, prdRelPaths } = makeRepo();
    const glab = makeGlab();
    const git = makeGit(prdRelPaths);

    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let captured = '';
    spy.mockImplementation((s) => {
      captured += s;
      return true;
    });

    const res = main({
      argv: ['--dry-run', '--json'],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });
    spy.mockRestore();

    expect(res.code).toBe(0);
    const parsed = JSON.parse(captured);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.vaultDir).toBe(vault);
    expect(parsed.archived).toHaveLength(1);
    expect(parsed.archived[0].iid).toBe('100');
    expect(parsed.skipped.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// #786 generalisation — --prd-dir docs/plans routing
// ---------------------------------------------------------------------------

describe('main (--prd-dir docs/plans routing — #786 generalisation)', () => {
  it('archives a closed-Epic plan into the plans vault subdir and git-rm-s the source under --apply', () => {
    const { repo, vault, planRelPaths } = makePlansRepo();
    const glab = makeGlab();
    const git = makeGit(planRelPaths);

    const res = main({
      argv: [
        '--apply',
        '--prd-dir',
        'docs/plans',
        '--vault-subdir',
        '01-projects/session-orchestrator/plans',
      ],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });

    expect(res.code).toBe(0);
    expect(res.archived).toHaveLength(1);
    expect(res.archived[0]).toMatchObject({
      source: 'docs/plans/2026-02-01-closed-plan.md',
      action: 'archived',
      iid: '100',
    });
    // Pfad-Assertion: lands under the PLANS vault subdir, not the PRD default.
    expect(res.archived[0].target).toBe(
      '01-projects/session-orchestrator/plans/2026-02-01-closed-plan.md',
    );

    const target = join(vault, '01-projects/session-orchestrator/plans/2026-02-01-closed-plan.md');
    expect(existsSync(target)).toBe(true);

    expect(git.rmCalls).toHaveLength(1);
    expect(git.rmCalls[0]).toEqual(['-C', repo, 'rm', '--', 'docs/plans/2026-02-01-closed-plan.md']);
  });

  it('leaves an open-Epic plan untouched — no vault write, no git rm', () => {
    const { repo, vault, planRelPaths } = makePlansRepo();
    const glab = makeGlab();
    const git = makeGit(planRelPaths);

    const res = main({
      argv: [
        '--apply',
        '--prd-dir',
        'docs/plans',
        '--vault-subdir',
        '01-projects/session-orchestrator/plans',
      ],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });

    const reasons = Object.fromEntries(res.skipped.map((s) => [s.source, s.reason]));
    expect(reasons['docs/plans/2026-02-02-open-plan.md']).toBe('epic-#200-open');

    const target = join(vault, '01-projects/session-orchestrator/plans/2026-02-02-open-plan.md');
    expect(existsSync(target)).toBe(false);

    const rmForOpenPlan = git.rmCalls.filter((c) => c.includes('docs/plans/2026-02-02-open-plan.md'));
    expect(rmForOpenPlan).toHaveLength(0);

    // ─────────────────────────────────────────────────────────────────────
    // FAKE-REGRESSION PROOF (testing.md § "Negative-Assertion Fake-Regression
    // Check") — this test was manually run once with makeGlab()'s '200' branch
    // TEMPORARILY flipped from `state: 'opened'` to `state: 'closed'` (simulating
    // the open-Epic guard silently failing to skip). Result: RED —
    //   "expected undefined to be 'epic-#200-open'" (the plan was archived
    //   instead of skipped, so it never appears in `res.skipped` at all) and
    //   "expected true to be false" on the existsSync(target) assertion (the
    //   vault file WAS written). Reverting the fake back to `opened` restored
    //   both assertions to green (2/2 passed). This confirms the test actually
    //   bites if the open-Epic skip path regresses — quoted transcript in the
    //   test-writer session report.
    // ─────────────────────────────────────────────────────────────────────
  });

  it('skips a path-shaped Source: header with no #NNN reference (no-epic-ref, fail-closed)', () => {
    const { repo, vault, planRelPaths } = makePlansRepo();
    const glab = makeGlab();
    const git = makeGit(planRelPaths);

    const res = main({
      argv: [
        '--apply',
        '--prd-dir',
        'docs/plans',
        '--vault-subdir',
        '01-projects/session-orchestrator/plans',
      ],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });

    const reasons = Object.fromEntries(res.skipped.map((s) => [s.source, s.reason]));
    expect(reasons['docs/plans/2026-02-03-no-epic-plan.md']).toBe('no-epic-ref');

    const target = join(vault, '01-projects/session-orchestrator/plans/2026-02-03-no-epic-plan.md');
    expect(existsSync(target)).toBe(false);
  });
});

describe('main (--prd-dir missing-directory grace — #786)', () => {
  it('exits 0 with empty archived/skipped when --prd-dir has zero tracked docs (e.g. docs/plans not yet created)', () => {
    const { repo } = makeRepo();
    const glab = makeGlab();
    // git ls-files on an untracked/non-existent directory exits 0 with empty
    // stdout — makeGit([]) models that exact shape (see listTrackedPrds doc).
    const git = makeGit([]);

    const res = main({
      argv: [
        '--dry-run',
        '--prd-dir',
        'docs/plans',
        '--vault-subdir',
        '01-projects/session-orchestrator/plans',
      ],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });

    expect(res.code).toBe(0);
    expect(res.archived).toEqual([]);
    expect(res.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// custom-phases command contract (SAFE_COMMAND_RE)
// ---------------------------------------------------------------------------

describe('custom-phases command conformance', () => {
  it('the proposed custom-phase command survives _parseCustomPhases (SAFE_COMMAND_RE)', () => {
    const md = [
      'custom-phases:',
      '  - name: archive-closed-prds',
      '    when: both',
      '    command: node scripts/archive-closed-prds.mjs --apply',
      '    mode: warn',
      '',
      'next-top-level-key: x',
    ].join('\n');

    const recs = _parseCustomPhases(md);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      name: 'archive-closed-prds',
      when: 'both',
      command: 'node scripts/archive-closed-prds.mjs --apply',
      mode: 'warn',
    });
  });

  it('the #786 archive-closed-plans second custom-phase entry also survives _parseCustomPhases', () => {
    // Mirrors (does NOT dynamically read) the two-entry custom-phases block
    // committed in this repo's CLAUDE.md — a literal copy, so a regex/parsing
    // regression is caught without the test reading-and-asserting-against-itself.
    const md = [
      'custom-phases:',
      '  - name: archive-closed-prds',
      '    when: both',
      '    command: node scripts/archive-closed-prds.mjs --apply',
      '    mode: warn',
      '  - name: archive-closed-plans',
      '    when: both',
      '    command: node scripts/archive-closed-prds.mjs --apply --prd-dir docs/plans --vault-subdir 01-projects/session-orchestrator/plans',
      '    mode: warn',
      '',
      'next-top-level-key: x',
    ].join('\n');

    const recs = _parseCustomPhases(md);
    expect(recs).toHaveLength(2);
    expect(recs[1]).toMatchObject({
      name: 'archive-closed-plans',
      when: 'both',
      command:
        'node scripts/archive-closed-prds.mjs --apply --prd-dir docs/plans --vault-subdir 01-projects/session-orchestrator/plans',
      mode: 'warn',
    });
  });
});

// ---------------------------------------------------------------------------
// #1112 — a CITATION is not a DECLARATION
// ---------------------------------------------------------------------------

/**
 * The header of `docs/prd/2026-08-22-framework-verschlankung.md` as it stood on
 * 2026-08-22, when the old `parseEpicRef` (first `#NNN` anywhere in the header)
 * read the QUOTED, long-closed `#214` as this document's own Epic and archived +
 * `git rm`'d it. Reproduced from the file's own incident note, not hand-shaped:
 * there is no declaration line anywhere in it — only prose that mentions an issue.
 */
const CITATION_ONLY_HEADER = [
  '# Feature: Verschlankung — den vorhandenen Fast-Path zum Feuern bringen',
  '',
  '**Date:** 2026-08-22',
  '**Author:** Operator + Claude (AI-gestützte Planung)',
  '**Status:** Draft, Revision 2',
  '**Appetite:** 1w',
  '**Parent Project:** session-orchestrator',
  '',
  '> **Revision 2 nach unabhängiger Prüfung — und sie hat die Hauptthese umgedreht.**',
  '> Revision 1 schlug einen Housekeeping-Fast-Path vor. Der Prüfer wies nach, dass es',
  '> ihn gibt: `skills/session-start/SKILL.md:1181`, **Phase 8.5 Express Path (#214)**,',
  '> aktiviert bei `session_type: housekeeping` + Scope ≤ 3 Issues.',
  '',
].join('\n');

/**
 * Build a repo fixture with CLAUDE.md + STATE.md and the given docs.
 * @param {Record<string,string>} docs — repo-relative path → content.
 */
function makeDocRepo(docs) {
  const repo = mkTmp('acp-doc-repo-');
  const vault = mkTmp('acp-doc-vault-');

  writeFile(
    repo,
    'CLAUDE.md',
    [
      '# Fixture',
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
      'vault-integration:',
      '  enabled: true',
      `  vault-dir: ${vault}`,
      '  mode: warn',
      '',
    ].join('\n'),
  );
  writeFile(
    repo,
    '.claude/STATE.md',
    [
      '---',
      'schema-version: 1',
      'session: fixture-session',
      `started_at: ${SESSION_STARTED_AT}`,
      'issues: [100]',
      'status: active',
      '---',
      '',
      '# STATE',
      '',
    ].join('\n'),
  );

  for (const [rel, content] of Object.entries(docs)) writeFile(repo, rel, content);
  return { repo, vault, relPaths: Object.keys(docs) };
}

describe('parseEpicDeclaration (#1112 citation guard)', () => {
  it('returns null for the literal #1112 header — a quoted issue is not a declaration', () => {
    expect(parseEpicDeclaration(CITATION_ONLY_HEADER)).toBeNull();
  });

  it('reads a frontmatter epic: key (via=frontmatter)', () => {
    const header = ['---', 'title: Foo', 'epic: 1113', '---', '', '# Plan — Foo', ''].join('\n');
    expect(parseEpicDeclaration(header)).toEqual({ iid: '1113', via: 'frontmatter' });
  });

  it('ignores an epic: key OUTSIDE the leading frontmatter block', () => {
    const header = ['# Plan — Foo', '', 'epic: 1113', ''].join('\n');
    expect(parseEpicDeclaration(header)).toBeNull();
  });

  it('does not read body lines as frontmatter when the leading --- never closes', () => {
    // A leading `---` is also a Markdown THEMATIC BREAK. Without a closing
    // `---` inside the header region the branch scanned the whole body, so a
    // prose `issue:` note outranked the doc's real declaration below it —
    // archiving (and `git rm`-ing) the doc against a long-closed issue.
    const header = [
      '---',
      '',
      '# Plan — Foo',
      '',
      'issue: 214 (the old, closed one — quoted for context)',
      '',
      '**Epic:** #1113',
      '',
    ].join('\n');

    expect(parseEpicDeclaration(header)).toEqual({ iid: '1113', via: 'label' });
  });

  it('still reads a CLOSED frontmatter block that opens the header', () => {
    const header = ['---', 'title: Foo', 'issue: 900', '---', '', '# Plan — Foo (#1113)', ''].join('\n');
    expect(parseEpicDeclaration(header)).toEqual({ iid: '900', via: 'frontmatter' });
  });

  it('reads the live label shapes (via=label)', () => {
    // `**Epic:** #1048 · **Sub-Issues:** #1049` — the primary declaration leads.
    expect(
      parseEpicDeclaration('**Epic:** #1048 · **Sub-Issues:** #1049 (A5) · #1050 (A1+A2)'),
    ).toEqual({ iid: '1048', via: 'label' });
    expect(parseEpicDeclaration('**Epic:** #1113')).toEqual({ iid: '1113', via: 'label' });
    expect(parseEpicDeclaration('- **Issue:** #366')).toEqual({ iid: '366', via: 'label' });
    expect(parseEpicDeclaration('**Epic**: [#271 autopilot](https://host/g/r/-/issues/271)')).toEqual(
      { iid: '271', via: 'label' },
    );
    // The plan-header shape (skills/write-executable-plan/SKILL.md:193).
    expect(parseEpicDeclaration('Source: docs/prd/2026-07-09-foo.md (#786)')).toEqual({
      iid: '786',
      via: 'label',
    });
  });

  it('reads an H1 title suffix (via=title)', () => {
    expect(parseEpicDeclaration('# Feature: Wellen-Supervision (#1113)')).toEqual({
      iid: '1113',
      via: 'title',
    });
  });

  it('never takes a #NNN out of a non-declaration line', () => {
    // Every one of these appears in the live vault archive as a CITATION.
    expect(parseEpicDeclaration('**Status:** Complete (2026-05-02, Epic #229 closed)')).toBeNull();
    expect(parseEpicDeclaration('lineage: #487 / #440')).toBeNull();
    expect(parseEpicDeclaration('Issues resolved this week: #1042, #1127')).toBeNull();
    expect(parseEpicDeclaration('> siehe **Phase 8.5 Express Path (#214)**')).toBeNull();
  });
});

describe('main (citation-only header — #1112)', () => {
  it('never archives a doc whose only #NNN is a prose citation, even under --apply with a closed Epic', () => {
    const rel = 'docs/prd/2026-08-22-framework-verschlankung.md';
    const { repo, vault } = makeDocRepo({
      [rel]: `${CITATION_ONLY_HEADER}\n## 1. Problem & Motivation\n\nbody\n`,
    });
    // glab answers "closed" for EVERY iid — so if the citation #214 were ever
    // treated as a declaration, this doc would archive. It must not.
    const glabCalls = [];
    const glab = (args) => {
      glabCalls.push(args);
      return { ok: true, stdout: JSON.stringify({ state: 'closed' }), stderr: '' };
    };
    const git = makeGit([rel]);

    const res = main({
      argv: ['--apply'],
      repoRoot: repo,
      glabRunFn: glab,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      hostPaths: HOST_PATHS,
    });

    expect(res.code).toBe(0);
    expect(res.archived).toEqual([]);
    expect(res.skipped).toEqual([{ source: rel, reason: 'citation-only' }]);
    // The Epic state was never even asked for — the guard runs BEFORE glab.
    expect(glabCalls).toEqual([]);
    // Nothing written to the vault, nothing removed from the working tree.
    expect(existsSync(join(vault, '01-projects/session-orchestrator/prd'))).toBe(false);
    expect(git.rmCalls).toEqual([]);
    expect(existsSync(join(repo, rel))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #1123 — session ownership (the doc a PARALLEL session just committed)
// ---------------------------------------------------------------------------

describe('main (session ownership — #1123)', () => {
  const REL = 'docs/prd/2026-08-22-parallel.md';
  const DOC = '# PRD — Parallel Thing\n\n**Epic:** #100\n\n## Problem\n\nbody\n';

  it('skips a doc committed at/after this session started — foreign-session, no git rm', () => {
    const { repo, vault } = makeDocRepo({ [REL]: DOC });
    const glab = makeGlab();
    // Committed 20 minutes AFTER this session started — the #1123 shape exactly.
    const git = makeGit([REL], { committedAt: { [REL]: '2026-03-04T09:20:00Z' } });

    const res = main({
      argv: ['--apply'],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      sessionStartedAt: SESSION_STARTED_AT,
      hostPaths: HOST_PATHS,
    });

    expect(res.archived).toEqual([]);
    expect(res.skipped).toEqual([
      { source: REL, reason: 'foreign-session', iid: '100', via: 'label', ownership: 'foreign' },
    ]);
    expect(git.rmCalls).toEqual([]);
    expect(existsSync(join(vault, '01-projects/session-orchestrator/prd'))).toBe(false);
    expect(existsSync(join(repo, REL))).toBe(true);
  });

  it('skips a doc with uncommitted changes — uncommitted, no git rm', () => {
    const { repo } = makeDocRepo({ [REL]: DOC });
    const glab = makeGlab();
    const git = makeGit([REL], { porcelain: { [REL]: ` M ${REL}\n` } });

    const res = main({
      argv: ['--apply'],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      sessionStartedAt: SESSION_STARTED_AT,
      hostPaths: HOST_PATHS,
    });

    expect(res.archived).toEqual([]);
    expect(res.skipped[0]).toMatchObject({ source: REL, reason: 'uncommitted', ownership: 'uncommitted' });
    expect(git.rmCalls).toEqual([]);
  });

  it('archives a doc this session already owned — older commit, clean tree, closed Epic', () => {
    const { repo, vault } = makeDocRepo({ [REL]: DOC });
    const glab = makeGlab();
    const git = makeGit([REL]); // defaults: clean tree, committed 2026-01-01

    const res = main({
      argv: ['--apply'],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      sessionStartedAt: SESSION_STARTED_AT,
      hostPaths: HOST_PATHS,
    });

    expect(res.skipped).toEqual([]);
    expect(res.archived).toHaveLength(1);
    expect(res.archived[0]).toMatchObject({
      source: REL,
      action: 'archived',
      iid: '100',
      via: 'label',
      ownership: 'mine',
    });
    expect(existsSync(join(vault, '01-projects/session-orchestrator/prd/2026-08-22-parallel.md'))).toBe(
      true,
    );
    expect(git.rmCalls).toEqual([['-C', repo, 'rm', '--', REL]]);
  });

  it('treats every doc as foreign when no session identity resolves (fail-closed)', () => {
    const { repo } = makeDocRepo({ [REL]: DOC });
    const glab = makeGlab();
    const git = makeGit([REL]);

    const res = main({
      argv: ['--apply'],
      repoRoot: repo,
      glabRunFn: glab.fn,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      sessionStartedAt: null, // no session.lock, no STATE.md started_at
      hostPaths: HOST_PATHS,
    });

    expect(res.archived).toEqual([]);
    expect(res.skipped[0]).toMatchObject({ reason: 'foreign-session' });
    expect(git.rmCalls).toEqual([]);
  });

  it('--ignore-session-guard overrides foreign-session but NEVER the uncommitted guard', () => {
    const foreign = makeDocRepo({ [REL]: DOC });
    const foreignGit = makeGit([REL], { committedAt: { [REL]: '2026-03-04T09:20:00Z' } });
    const sweep = main({
      argv: ['--apply', '--ignore-session-guard'],
      repoRoot: foreign.repo,
      glabRunFn: makeGlab().fn,
      gitRunFn: foreignGit.fn,
      now: FIXED_NOW,
      sessionStartedAt: SESSION_STARTED_AT,
      hostPaths: HOST_PATHS,
    });
    expect(sweep.archived).toHaveLength(1);
    expect(foreignGit.rmCalls).toEqual([['-C', foreign.repo, 'rm', '--', REL]]);

    const dirty = makeDocRepo({ [REL]: DOC });
    const dirtyGit = makeGit([REL], { porcelain: { [REL]: `?? ${REL}\n` } });
    const guarded = main({
      argv: ['--apply', '--ignore-session-guard'],
      repoRoot: dirty.repo,
      glabRunFn: makeGlab().fn,
      gitRunFn: dirtyGit.fn,
      now: FIXED_NOW,
      sessionStartedAt: SESSION_STARTED_AT,
      hostPaths: HOST_PATHS,
    });
    expect(guarded.archived).toEqual([]);
    expect(guarded.skipped[0]).toMatchObject({ reason: 'uncommitted' });
    expect(dirtyGit.rmCalls).toEqual([]);
  });
});

describe('main (--owned-issues-only)', () => {
  it('archives only docs whose declared iid is in STATE.md issues:', () => {
    const mine = 'docs/prd/mine.md';
    const theirs = 'docs/prd/theirs.md';
    const { repo } = makeDocRepo({
      // STATE.md fixture declares `issues: [100]`.
      [mine]: '# PRD — Mine\n\n**Epic:** #100\n\n## Problem\n\nbody\n',
      [theirs]: '# PRD — Theirs\n\n**Epic:** #300\n\n## Problem\n\nbody\n',
    });
    // Both Epics closed — only the ownership filter may separate them.
    const glab = () => ({ ok: true, stdout: JSON.stringify({ state: 'closed' }), stderr: '' });
    const git = makeGit([mine, theirs]);

    const res = main({
      argv: ['--apply', '--owned-issues-only'],
      repoRoot: repo,
      glabRunFn: glab,
      gitRunFn: git.fn,
      now: FIXED_NOW,
      sessionStartedAt: SESSION_STARTED_AT,
      hostPaths: HOST_PATHS,
    });

    expect(res.archived).toHaveLength(1);
    expect(res.archived[0].source).toBe(mine);
    expect(res.skipped).toEqual([
      { source: theirs, reason: 'epic-#300-not-owned', iid: '300', via: 'label', ownership: 'mine' },
    ]);
    expect(git.rmCalls).toEqual([['-C', repo, 'rm', '--', mine]]);
  });
});

describe('classifyOwnership (#1123 fail-closed contract)', () => {
  const base = { repoRoot: '/repo', rel: 'docs/prd/x.md', sessionStartedAt: '2026-03-04T09:00:00Z' };

  it('returns foreign when a git probe fails or the commit timestamp is unparseable', () => {
    expect(classifyOwnership({ ...base, gitRunFn: () => ({ ok: false, stdout: '', stderr: 'boom' }) })).toBe(
      'foreign',
    );
    const badTimestamp = (args) =>
      args.includes('status')
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: true, stdout: 'not-a-date\n', stderr: '' };
    expect(classifyOwnership({ ...base, gitRunFn: badTimestamp })).toBe('foreign');
  });

  it('never throws when gitRunFn itself throws', () => {
    const thrower = () => {
      throw new Error('spawn ENOENT');
    };
    expect(classifyOwnership({ ...base, gitRunFn: thrower })).toBe('foreign');
  });

  it('reads a REBASED commit as foreign — the author date is old, the committer date is not', () => {
    // The bug: `--format=%aI` alone reads the AUTHOR date, which survives
    // rebase / cherry-pick / --amend unchanged. A peer session's PRD rebased
    // onto this branch therefore looked older than our session start → 'mine'
    // → `git rm` of live foreign work (the #1123 damage shape).
    const rebased = (args) =>
      args.includes('status')
        ? { ok: true, stdout: '', stderr: '' }
        : // `%aI%n%cI`: author 2026-01-01 (old), committer 09:20 (after our start).
          { ok: true, stdout: '2026-01-01T00:00:00Z\n2026-03-04T09:20:00Z\n', stderr: '' };

    expect(classifyOwnership({ ...base, gitRunFn: rebased })).toBe('foreign');
    // The argv proves BOTH stamps are requested — a `%aI`-only format could not
    // produce the verdict above no matter what the stub returned.
    const seen = [];
    classifyOwnership({
      ...base,
      gitRunFn: (args) => {
        seen.push(args);
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    expect(seen.some((a) => a.includes('--format=%aI%n%cI'))).toBe(true);
  });

  it('treats a commit in the SAME second as started_at as foreign (>= boundary, fail-closed)', () => {
    const exact = (args) =>
      args.includes('status')
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: true, stdout: `${base.sessionStartedAt}\n${base.sessionStartedAt}\n`, stderr: '' };

    // Equality is ambiguous — the doc may have been committed by the parallel
    // session in the same second this one started. 'foreign' is the verdict
    // that does not delete.
    expect(classifyOwnership({ ...base, gitRunFn: exact })).toBe('foreign');

    // One millisecond earlier is unambiguously ours.
    const justBefore = (args) =>
      args.includes('status')
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: true, stdout: '2026-03-04T08:59:59.999Z\n2026-03-04T08:59:59.999Z\n', stderr: '' };
    expect(classifyOwnership({ ...base, gitRunFn: justBefore })).toBe('mine');
  });
});
