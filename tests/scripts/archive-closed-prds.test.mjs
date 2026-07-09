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
  parseEpicRef,
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

/** Fake git: ls-files → the fixture PRD list; remote get-url → fake URL; rm → ok. */
function makeGit(prdRelPaths) {
  const rmCalls = [];
  const fn = (args) => {
    if (args.includes('ls-files')) {
      return { ok: true, stdout: prdRelPaths.join('\n') + '\n', stderr: '' };
    }
    if (args.includes('remote') && args.includes('get-url')) {
      return { ok: true, stdout: 'https://example.test/group/repo.git\n', stderr: '' };
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
  it('prefers the gitlab remote URL', () => {
    const fn = (args) => {
      if (args.includes('gitlab')) return { ok: true, stdout: 'https://host/g/repo.git\n', stderr: '' };
      return { ok: false, stdout: '', stderr: 'no remote' };
    };
    expect(defaultGlabRepo('/repo', fn)).toBe('https://host/g/repo.git');
  });
  it('falls back to origin, then undefined', () => {
    const originOnly = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'git@host:g/repo.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no remote' };
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
