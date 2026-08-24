/**
 * tests/lib/project-hygiene.test.mjs
 *
 * Tests for scripts/lib/project-hygiene.mjs — the project-hygiene probe family.
 *
 * Every test below names the specific bug it catches (test-value.md TV-001).
 * The load-bearing ones are the NEGATIVE cases: a hygiene probe that fires on
 * healthy repos trains operators to ignore it, which is strictly worse than
 * not having the probe. The diagnostic runs that motivated this module also
 * produced two convincing false findings, so the false-positive boundaries
 * are tested at least as carefully as the true positives.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkCiConfig,
  checkEnvDocumentation,
  checkIgnoredBallast,
  checkProjectHygiene,
  checkReleaseHygiene,
  checkStaleArtifacts,
} from '@lib/project-hygiene.mjs';

let root;

function gitIn(args) {
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Create N commits so the repo has a plausible history length. */
function commitN(n, prefix = 'c') {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(root, `${prefix}${i}.txt`), String(i));
    gitIn(['add', '-A']);
    gitIn(['commit', '-q', '-m', `${prefix}${i}`]);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-hygiene-'));
  gitIn(['init', '-q']);
  gitIn(['config', 'user.email', 'hygiene-test@example.com']);
  gitIn(['config', 'user.name', 'Hygiene Test']);
  gitIn(['config', 'commit.gpgsign', 'false']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── Release hygiene ──────────────────────────────────────────────────────────

describe('checkReleaseHygiene', () => {
  it('stays silent for a young untagged repo', () => {
    // Bug this catches: firing on every freshly-created repo. A 7-commit repo
    // with no tags is normal — reporting it would make the probe noise, and an
    // ignored probe catches nothing at all.
    commitN(7);
    expect(checkReleaseHygiene(root, 50)).toBeNull();
  });

  it('reports an established repo that never tagged a release', () => {
    // Bug this catches: the observed case of a long-lived repo running in
    // production with zero release tags — no rollback anchor.
    commitN(55);
    const result = checkReleaseHygiene(root, 50);
    expect(result).not.toBeNull();
    expect(result.check).toBe('release-hygiene');
    expect(result.message).toContain('no release tags');
  });

  it('stays silent when the newest tag is close to HEAD', () => {
    commitN(55);
    gitIn(['tag', 'v1.0.0']);
    commitN(3, 'post');
    expect(checkReleaseHygiene(root, 50)).toBeNull();
  });

  it('reports commit distance when HEAD has run far past the newest tag', () => {
    // Bug this catches: tags exist, so a naive "has tags?" check reports clean —
    // while the published tag is dozens of commits behind what ships.
    commitN(5);
    gitIn(['tag', 'v0.1.0']);
    commitN(60, 'after');
    const result = checkReleaseHygiene(root, 50);
    expect(result).not.toBeNull();
    expect(result.message).toContain('v0.1.0');
    expect(result.message).toContain('60 commits since');
  });
});

// ── Ignored ballast / untracked-unignored ────────────────────────────────────

describe('checkIgnoredBallast', () => {
  it('reports files that are neither tracked nor ignored', () => {
    // Bug this catches: a .gitignore that deliberately un-ignores a directory
    // (`!.claude/rules/**`) while those files were never actually committed —
    // observed leaving 23 intended-to-be-versioned files in limbo.
    commitN(1);
    writeFileSync(join(root, 'undecided.txt'), 'x');
    const findings = checkIgnoredBallast(root, 999_999);
    const limbo = findings.find((f) => f.check === 'untracked-unignored');
    expect(limbo).toBeDefined();
    expect(limbo.message).toContain('neither tracked nor ignored');
  });

  it('does not flag limbo when every file is tracked or ignored', () => {
    // False-positive boundary: a clean repo must produce no finding at all.
    writeFileSync(join(root, '.gitignore'), 'build/\n');
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build', 'out.js'), 'x');
    commitN(1);
    const findings = checkIgnoredBallast(root, 999_999);
    expect(findings.find((f) => f.check === 'untracked-unignored')).toBeUndefined();
  });
});

// ── Stale orchestrator artifacts ─────────────────────────────────────────────

describe('checkStaleArtifacts', () => {
  it('returns null when there is no .orchestrator directory', () => {
    commitN(1);
    expect(checkStaleArtifacts(root, 30)).toBeNull();
  });

  it('ignores fresh artifacts', () => {
    // False-positive boundary: the CURRENT session writes into .orchestrator/.
    // Flagging its own live files would fire on every single session.
    mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
    writeFileSync(join(root, '.orchestrator', 'metrics', 'now.json'), '{}');
    expect(checkStaleArtifacts(root, 30)).toBeNull();
  });

  it('reports artifacts older than the age threshold', () => {
    // Bug this catches: observed 592 files and 147 MB of test-run captures
    // accumulating for seven weeks with nothing ever pruning them.
    mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
    const old = join(root, '.orchestrator', 'metrics', 'ancient.json');
    writeFileSync(old, '{}');
    const longAgo = Date.now() / 1000 - 90 * 24 * 60 * 60;
    utimesSync(old, longAgo, longAgo);

    const result = checkStaleArtifacts(root, 30);
    expect(result).not.toBeNull();
    expect(result.check).toBe('stale-artifacts');
    expect(result.fixable).toBe(true);
  });

  it('sizes the AGED subset, not the whole .orchestrator/ directory', () => {
    // Bug this catches: the reported byte total was `du -s .orchestrator`, i.e.
    // the whole directory — while the sentence around it speaks about the aged
    // files only. Against this repo that overstated the reachable win by ~18x
    // (11 MB claimed, 0.68 MB actually reclaimable). An operator who follows
    // the finding frees a fraction of what it promised.
    mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
    const old = join(root, '.orchestrator', 'metrics', 'ancient.json');
    writeFileSync(old, 'x'.repeat(2048));
    const young = join(root, '.orchestrator', 'metrics', 'fresh.bin');
    writeFileSync(young, 'y'.repeat(5 * 1024 * 1024));
    const longAgo = Date.now() / 1000 - 90 * 24 * 60 * 60;
    utimesSync(old, longAgo, longAgo);

    const result = checkStaleArtifacts(root, 30);
    expect(result).not.toBeNull();
    expect(result.agedFiles).toBe(1);
    expect(result.agedBytes).toBe(2048);
    expect(result.message).toContain('2 KB');
    // The young 5 MB file must not appear in the total in any rendering.
    expect(result.message).not.toContain('5 MB');
  });

  it('excludes version-tracked paths — they are source, not artifacts', () => {
    // Bug this catches: the probe consulted git nowhere, so it proposed pruning
    // .orchestrator/policy/*.json and .orchestrator/steering/*.md — files read
    // at runtime by hooks and skills. Their age means stability, not decay.
    mkdirSync(join(root, '.orchestrator', 'policy'), { recursive: true });
    mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
    const trackedSource = join(root, '.orchestrator', 'policy', 'schema.json');
    writeFileSync(trackedSource, 'z'.repeat(4096));
    gitIn(['add', '--', '.orchestrator/policy/schema.json']);
    gitIn(['commit', '-q', '-m', 'add policy schema']);
    const untrackedArtifact = join(root, '.orchestrator', 'metrics', 'old.json');
    writeFileSync(untrackedArtifact, '{}');

    const longAgo = Date.now() / 1000 - 90 * 24 * 60 * 60;
    utimesSync(trackedSource, longAgo, longAgo);
    utimesSync(untrackedArtifact, longAgo, longAgo);

    // Anti-trap: a tmp fixture where git simply found nothing would pass this
    // test while pinning the OPPOSITE of its name. Prove the file is tracked.
    const lsOut = execFileSync('git', ['ls-files', '--', '.orchestrator'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(lsOut).toContain('.orchestrator/policy/schema.json');

    const result = checkStaleArtifacts(root, 30);
    expect(result).not.toBeNull();
    expect(result.agedFiles).toBe(1);
    expect(result.agedBytes).toBe(2); // only the untracked '{}' artifact
    expect(result.message).toContain('1 untracked file');
  });

  it('returns null when every aged file under .orchestrator/ is tracked', () => {
    // Corollary of the exclusion: the tracked set must be removed BEFORE the
    // "nothing aged" short-circuit, or a repo whose only aged files are source
    // still gets a pruning proposal.
    mkdirSync(join(root, '.orchestrator', 'steering'), { recursive: true });
    const trackedSource = join(root, '.orchestrator', 'steering', 'tech.md');
    writeFileSync(trackedSource, '# tech\n');
    gitIn(['add', '--', '.orchestrator/steering/tech.md']);
    gitIn(['commit', '-q', '-m', 'add steering']);
    const longAgo = Date.now() / 1000 - 90 * 24 * 60 * 60;
    utimesSync(trackedSource, longAgo, longAgo);

    expect(checkStaleArtifacts(root, 30)).toBeNull();
  });

  it('stays silent when git cannot resolve the tracked set (fail-safe, not fail-open)', () => {
    // Bug this catches: falling back to an empty tracked set on git failure
    // re-opens the exact defect the exclusion closes — every source file under
    // .orchestrator/ becomes a pruning candidate again, silently.
    const notARepo = mkdtempSync(join(tmpdir(), 'so-hygiene-nogit-'));
    try {
      mkdirSync(join(notARepo, '.orchestrator'), { recursive: true });
      const old = join(notARepo, '.orchestrator', 'old.json');
      writeFileSync(old, '{}');
      const longAgo = Date.now() / 1000 - 90 * 24 * 60 * 60;
      utimesSync(old, longAgo, longAgo);

      // Anti-trap: assert git really fails here rather than assuming it.
      expect(() =>
        execFileSync('git', ['ls-files', '--', '.orchestrator'], {
          cwd: notARepo,
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).toThrow();

      expect(checkStaleArtifacts(notARepo, 30)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('never proposes deleting idempotency markers or append-only ledgers', () => {
    // Bug this catches: today the check proposes deleting idempotency markers
    // whose deletion causes duplicate backfills. A `.backfilled-*.marker` is the
    // TOCTOU guard of scripts/lib/session-close-backfill.mjs — its EXISTENCE is
    // the entire state, so an aged marker is a HEALTHY marker, and removing one
    // makes the next backfill pass re-run for that session id. Ledgers and logs
    // are append-only history for the same reason. Measured in this repo
    // 2026-08-24: 24 of 25 reported candidates were markers, *.jsonl ledgers or
    // *.log files — every one of them carrying `fixable: true`.
    mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
    const marker = join(root, '.orchestrator', 'metrics', '.backfilled-x.marker');
    const ledger = join(root, '.orchestrator', 'metrics', 'events.jsonl');
    const log = join(root, '.orchestrator', 'reconcile.rejected.log');
    const scratch = join(root, '.orchestrator', 'foo.json');
    writeFileSync(marker, '');
    writeFileSync(ledger, '{"a":1}\n');
    writeFileSync(log, 'rejected\n');
    writeFileSync(scratch, '{}');
    const longAgo = Date.now() / 1000 - 90 * 24 * 60 * 60;
    for (const f of [marker, ledger, log, scratch]) utimesSync(f, longAgo, longAgo);

    const result = checkStaleArtifacts(root, 30);
    expect(result).not.toBeNull();
    // Only the scratch json is a candidate. agedBytes proves the exclusion is a
    // real removal from the set, not a message-level downgrade: the ledger and
    // log bytes are absent from the total too.
    expect(result.agedFiles).toBe(1);
    expect(result.agedBytes).toBe(2);
    expect(result.message).toContain('1 untracked file');
    // The count change has to be explainable from the banner alone.
    expect(result.message).toContain('idempotency markers + ledgers excluded');

    // Corollary: a repo whose ONLY aged files are load-bearing must produce no
    // banner at all — not a zero-count one.
    rmSync(scratch);
    expect(checkStaleArtifacts(root, 30)).toBeNull();
  });
});

// ── CI configuration ─────────────────────────────────────────────────────────

describe('checkCiConfig', () => {
  it('stays silent for a repo with no build manifest', () => {
    // False-positive boundary: a docs-only repo needs no pipeline, and telling
    // its owner to add CI is noise.
    commitN(1);
    expect(checkCiConfig(root)).toEqual([]);
  });

  it('reports a missing pipeline when a manifest exists', () => {
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    const findings = checkCiConfig(root);
    expect(findings.map((f) => f.check)).toContain('ci-config');
  });

  it('reports a pipeline without any dependency-audit step', () => {
    // Bug this catches: three of six repos tested carried known-vulnerable
    // dependencies that no pipeline would ever surface.
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    writeFileSync(join(root, '.gitlab-ci.yml'), 'test:\n  script:\n    - npm test\n');
    const findings = checkCiConfig(root);
    expect(findings.map((f) => f.check)).toContain('ci-audit-job');
  });

  it('accepts any recognised audit tool, not just npm', () => {
    // False-positive boundary: a Python or Rust repo auditing correctly must
    // not be told it has no audit step.
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\n');
    writeFileSync(join(root, '.gitlab-ci.yml'), 'audit:\n  script:\n    - pip-audit\n');
    const findings = checkCiConfig(root);
    expect(findings.map((f) => f.check)).not.toContain('ci-audit-job');
  });
});

// ── Env documentation ────────────────────────────────────────────────────────

describe('checkEnvDocumentation', () => {
  it('reports env reads with no .env.example anywhere', () => {
    writeFileSync(join(root, 'app.mjs'), 'const k = process.env.API_KEY;\n');
    commitN(1);
    const result = checkEnvDocumentation(root);
    expect(result).not.toBeNull();
    expect(result.check).toBe('env-documentation');
  });

  it('stays silent once an .env.example exists', () => {
    // Deliberately narrow: this probe does NOT judge whether the example file
    // is COMPLETE. Naive read-vs-documented diffing produced a 100% false
    // positive rate against code reading env through a central schema module.
    writeFileSync(join(root, 'app.mjs'), 'const k = process.env.API_KEY;\n');
    writeFileSync(join(root, '.env.example'), 'API_KEY=\n');
    commitN(1);
    expect(checkEnvDocumentation(root)).toBeNull();
  });

  it('stays silent for code that reads no env vars', () => {
    writeFileSync(join(root, 'app.mjs'), 'export const x = 1;\n');
    commitN(1);
    expect(checkEnvDocumentation(root)).toBeNull();
  });
});

// ── Aggregate ────────────────────────────────────────────────────────────────

describe('checkProjectHygiene', () => {
  it('returns null for a non-repo path', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'so-not-repo-'));
    try {
      expect(checkProjectHygiene({ repoRoot: notARepo })).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('returns null for missing or non-string repoRoot', () => {
    expect(checkProjectHygiene({})).toBeNull();
    expect(checkProjectHygiene({ repoRoot: 42 })).toBeNull();
    expect(checkProjectHygiene()).toBeNull();
  });

  it('returns null for a healthy young repo', () => {
    // The single most important test here: a clean repo must produce NO banner.
    // Phase 4 already renders 13 of them; a probe that always fires is worse
    // than no probe, because it teaches operators to skip the banner block.
    writeFileSync(join(root, '.env.example'), 'API_KEY=\n');
    commitN(3);
    expect(checkProjectHygiene({ repoRoot: root })).toBeNull();
  });

  it('aggregates findings and counts the mechanically fixable subset', () => {
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    commitN(55);
    mkdirSync(join(root, '.orchestrator'), { recursive: true });
    const old = join(root, '.orchestrator', 'old.json');
    writeFileSync(old, '{}');
    const longAgo = Date.now() / 1000 - 90 * 24 * 60 * 60;
    utimesSync(old, longAgo, longAgo);

    const result = checkProjectHygiene({ repoRoot: root });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    // Release drift (not fixable) + stale artifacts (fixable) + no CI (not fixable).
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    expect(result.mechanical).toBeGreaterThanOrEqual(1);
    expect(result.mechanical).toBeLessThan(result.findings.length);
    expect(result.message).toContain('mechanically fixable');
  });
});
