/**
 * tests/scripts/pack-policy-floor.test.mjs
 *
 * Guards the npm packlist against ONE bug the rest of the suite cannot see
 * (TV-001): the published tarball does not carry
 * `.orchestrator/policy/blocked-commands.json`, the FLOOR policy that
 * `scripts/lib/blocked-commands-policy.mjs` resolves from
 * `[cwd, projectDir, pluginRoot]/.orchestrator/policy/blocked-commands.json`.
 *
 * Why nothing else catches it: the file is TRACKED, so every in-repo test,
 * every hook and every marketplace/git install sees it. It is absent ONLY in
 * the packed artefact — an npm consumer without their own overlay gets
 * `loadEffectivePolicy() -> rules: null`, and `hooks/pre-bash-destructive-guard.mjs`
 * then warns and ALLOWS. The guard README and CLAUDE.md advertise is silently
 * gone, and the only observable difference is inside the tarball.
 * (Found by the W1 Codex review, 2026-09-06: `npm pack --dry-run | grep -c
 * orchestrator/policy` -> 0.)
 *
 * The second assertion guards the tempting over-broad fix: `.orchestrator/`
 * wholesale would ship the operator's own `metrics/` (sessions.jsonl,
 * events.jsonl), `debug/` artefacts and live `*.lock` files to every consumer.
 *
 * Measurement, not mock: this spawns a REAL `npm pack --dry-run --json`, which
 * is why the timeout is generous. `--dry-run` writes no tarball.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * Tracked files under `.orchestrator/policy/`, measured from git — the SET the
 * packlist must equal. Uses `-z` so a path with a space or a quote-worthy
 * character survives verbatim (`git ls-files` C-quotes those without it).
 */
function trackedPolicyFiles(cwd) {
  const r = spawnSync('git', ['ls-files', '-z', '--', '.orchestrator/policy'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`git ls-files failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return r.stdout.split('\0').filter((p) => p !== '');
}

const REPO_ROOT = process.cwd();
const FLOOR_POLICY = '.orchestrator/policy/blocked-commands.json';

/** Paths reported by `npm pack --dry-run --json`, lazily measured once. */
let packedPaths = [];

beforeAll(() => {
  // `npm_config_loglevel` is INHERITED from an outer gate run; a silent level
  // makes npm suppress output the parse below depends on. Strip it (same
  // hazard scripts/release.mjs documents for its own packlist gate).
  const env = { ...process.env };
  delete env.npm_config_loglevel;
  delete env.NPM_CONFIG_LOGLEVEL;

  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024,
  });

  // Fail CLOSED and say so: an unparseable pack must never read as "no finding".
  if (r.status !== 0) {
    throw new Error(`npm pack --dry-run --json failed (exit ${r.status}): ${(r.stderr || '').trim().slice(-400)}`);
  }
  const parsed = JSON.parse(r.stdout);
  packedPaths = (parsed?.[0]?.files ?? []).map((f) => f.path);
  if (packedPaths.length === 0) {
    throw new Error('npm pack --dry-run --json returned an empty file list — packlist not measurable');
  }
}, 120_000);

describe('npm packlist — destructive-guard floor policy', () => {
  it('ships .orchestrator/policy/blocked-commands.json', () => {
    expect(packedPaths).toContain(FLOOR_POLICY);
  });

  it('does not ship .orchestrator/ wholesale (metrics, debug artefacts, locks)', () => {
    const leaked = packedPaths.filter(
      (p) => p.startsWith('.orchestrator/') && !p.startsWith('.orchestrator/policy/'),
    );
    expect(leaked).toEqual([]);
  });

  /**
   * TV-001, the bug this names: `package.json` `files[]` admits the whole
   * `.orchestrator/policy/` DIRECTORY, and the owner-leakage carve-out exempts
   * that directory — so a file that merely EXISTS on the release host at pack
   * time ships, tracked or not. A private overlay an operator dropped there
   * while debugging (`blocked-commands.local.json`, a client-named profile)
   * would be published to every npm consumer, and no other check looks.
   *
   * The accepted trust boundary is VCS: what ships is what is committed and
   * therefore review-gated (`.claude/rules/security.md` § Session Config
   * Command Trust states the same anchor for command-bearing config). A
   * directory-level `files[]` entry is fine BECAUSE this test is what makes
   * that boundary hold — set equality against `git ls-files`, not a floor.
   */
  it('ships EXACTLY the tracked policy set — an untracked file there turns this red', () => {
    const packedPolicy = packedPaths.filter((p) => p.startsWith('.orchestrator/policy/')).sort();
    const tracked = trackedPolicyFiles(REPO_ROOT).sort();

    expect(tracked.length).toBeGreaterThan(0); // vacuum guard: an empty census proves nothing
    expect(packedPolicy).toEqual(tracked);
  });
});
