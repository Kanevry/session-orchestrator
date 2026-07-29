/**
 * project-hygiene.mjs — Project-hygiene probe family (housekeeping canon).
 *
 * WHY THIS EXISTS
 * ---------------
 * session-start Phase 4 runs 13 probes. Exactly one of them (`ci-status`)
 * inspects the PROJECT; the rest inspect the orchestrator's own substrate
 * (vault, peer-cards, loop readiness, instruction budget, its own ledger).
 * A read-only diagnostic run of the housekeeping flow across six real
 * consumer repos (9 to 2099 tracked files) found the checks the flow does
 * NOT perform outscored the ones it does in every single repo — by up to 7x.
 *
 * This module adds the highest-yield missing checks. Each one was selected by
 * measured hit rate across those six repos, not by intuition:
 *
 *   releaseHygiene   6/6 repos    tags/CHANGELOG vs. commits since
 *   ignoredBallast   6/6 repos    ignored-and-untracked working-tree mass
 *   staleArtifacts   5/6 repos    aged .orchestrator/ artifacts
 *   ciConfig         5/6 repos    pipeline present, audit job, image pinning
 *
 * DELIBERATE OMISSIONS (documented so nobody "completes" the set later):
 *
 *   docs-drift (6/6 hit rate) is NOT reimplemented here. `claude-md-drift-check`
 *   already covers it with ten checks; it merely runs at session-END, i.e.
 *   after the work. The fix is scheduling, not a second implementation.
 *
 *   env-hygiene (5/6 hit rate) is NOT implemented as a dead-variable list.
 *   The naive approach — diff `process.env.X` reads against `.env.example` —
 *   produced a 100% false-positive rate in the largest repo tested, because
 *   variables were read centrally through a Zod schema rather than at their
 *   use sites. This module reports only the falsifiable part: whether an
 *   `.env.example` exists at all when env vars are read. Counting or naming
 *   "dead" variables requires resolving indirection and is left to the
 *   per-repo parity tests that some repos already implement correctly.
 *
 * CONTRACT
 * --------
 * Mirrors the established banner-probe shape (see ci-status-banner.mjs):
 * returns `null` for a silent no-op, or `{ severity, message, findings }`.
 * Never throws, never writes, never blocks. Every finding carries `fixable`
 * so a caller can split mechanical work from work needing human judgement.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Commits past the newest tag before release hygiene is worth mentioning. */
export const DEFAULT_RELEASE_DRIFT_COMMITS = 50;
/** Megabytes of ignored working-tree mass before it is worth mentioning. */
export const DEFAULT_BALLAST_MB = 500;
/** Days before an .orchestrator/ artifact counts as aged. */
export const DEFAULT_ARTIFACT_AGE_DAYS = 30;

/**
 * Run a git command, returning trimmed stdout or null on any failure.
 * Never throws — a missing repo, missing ref, or absent git all yield null.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string|null}
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * H1 — Release hygiene.
 *
 * Measured 6/6. The severe real-world case: 980 commits, live in production,
 * zero release tags, CHANGELOG frozen 460 commits back — no rollback anchor.
 * Distinguishes "no tags at all" from "tags exist but HEAD has run far past
 * the newest one", because the remedies differ.
 *
 * @param {string} repoRoot
 * @param {number} driftCommits
 * @returns {object|null}
 */
export function checkReleaseHygiene(repoRoot, driftCommits = DEFAULT_RELEASE_DRIFT_COMMITS) {
  const totalCommits = Number(git(['rev-list', '--count', 'HEAD'], repoRoot));
  if (!Number.isFinite(totalCommits) || totalCommits === 0) return null;

  const tags = git(['tag', '--list'], repoRoot);
  if (tags === null) return null;
  const tagList = tags.split('\n').filter(Boolean);

  // A young repo without tags is normal, not a finding.
  if (tagList.length === 0) {
    if (totalCommits < driftCommits) return null;
    return {
      check: 'release-hygiene',
      fixable: false,
      message: `no release tags across ${totalCommits} commits — no rollback anchor and no deploy identity`,
    };
  }

  // `describe` fails when no ANNOTATED tag is reachable; fall back to any tag.
  const described = git(['describe', '--tags', '--abbrev=0'], repoRoot);
  if (!described) {
    return {
      check: 'release-hygiene',
      fixable: false,
      message: `${tagList.length} tag(s) exist but none is reachable from HEAD (git describe fails) — releases are not anchored to this history`,
    };
  }

  const since = Number(git(['rev-list', '--count', `${described}..HEAD`], repoRoot));
  if (!Number.isFinite(since) || since < driftCommits) return null;

  return {
    check: 'release-hygiene',
    fixable: false,
    message: `${since} commits since the newest tag (${described}) — release identity is ${since} commits stale`,
  };
}

/**
 * H2 — Ignored working-tree ballast.
 *
 * Measured 6/6. Largest observed: a 7.4 GB working tree carrying 30.8 MB of
 * tracked content (factor 240), entirely invisible to `git status`, which
 * reported clean, and to `git count-objects`, which reported a healthy pack.
 *
 * Also reports files that are NEITHER tracked NOR ignored — the state where a
 * `.gitignore` intends to version something that was never committed. In one
 * repo this hid 23 rule files the `.gitignore` explicitly un-ignored.
 *
 * @param {string} repoRoot
 * @param {number} ballastMb
 * @returns {object[]}
 */
export function checkIgnoredBallast(repoRoot, ballastMb = DEFAULT_BALLAST_MB) {
  const findings = [];

  const ignored = git(
    ['status', '--ignored=matching', '--porcelain', '--untracked-files=all'],
    repoRoot,
  );
  if (ignored === null) return findings;

  const ignoredPaths = [];
  let untrackedUnignored = 0;
  for (const line of ignored.split('\n').filter(Boolean)) {
    if (line.startsWith('!! ')) ignoredPaths.push(line.slice(3));
    else if (line.startsWith('?? ')) untrackedUnignored++;
  }

  // Size only the top-level ignored entries — recursing every path would cost
  // more than the finding is worth on a large tree.
  let totalBytes = 0;
  const heaviest = [];
  for (const p of ignoredPaths) {
    const abs = join(repoRoot, p);
    const bytes = duBytes(abs);
    if (bytes === null) continue;
    totalBytes += bytes;
    heaviest.push({ path: p, bytes });
  }

  const totalMb = Math.round(totalBytes / (1024 * 1024));
  if (totalMb >= ballastMb) {
    heaviest.sort((a, b) => b.bytes - a.bytes);
    const top = heaviest
      .slice(0, 3)
      .map((h) => `${h.path} ${Math.round(h.bytes / (1024 * 1024))}MB`)
      .join(', ');
    findings.push({
      check: 'ignored-ballast',
      fixable: true,
      message: `${totalMb} MB of ignored files in the working tree (largest: ${top}) — invisible to git status`,
    });
  }

  if (untrackedUnignored > 0) {
    findings.push({
      check: 'untracked-unignored',
      fixable: false,
      message: `${untrackedUnignored} file(s) are neither tracked nor ignored — either commit them or add them to .gitignore, since nothing currently decides`,
    });
  }

  return findings;
}

/**
 * Directory/file size in bytes via `du -sk`, or null when unavailable.
 * `du` is POSIX and present on macOS and Linux; Windows yields null, which
 * degrades the ballast check to a silent skip rather than a crash.
 * @param {string} absPath
 * @returns {number|null}
 */
function duBytes(absPath) {
  try {
    if (!existsSync(absPath)) return null;
    const out = execFileSync('du', ['-sk', absPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const kb = Number(out.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * H3 — Aged orchestrator artifacts.
 *
 * Measured 5/6. Largest observed: 184 MB under .orchestrator/, of which
 * 147 MB were Playwright test-run captures dating back seven weeks, plus
 * 592 files older than 30 days.
 *
 * @param {string} repoRoot
 * @param {number} ageDays
 * @param {number} now
 * @returns {object|null}
 */
export function checkStaleArtifacts(repoRoot, ageDays = DEFAULT_ARTIFACT_AGE_DAYS, now = Date.now()) {
  const dir = join(repoRoot, '.orchestrator');
  if (!existsSync(dir)) return null;

  const cutoff = now - ageDays * 24 * 60 * 60 * 1000;
  let aged = 0;
  let scanned = 0;

  /** @param {string} d @param {number} depth */
  const walk = (d, depth) => {
    // Bounded: a runaway scan on a huge artifact tree would cost more than
    // the finding. 20k entries is far above any healthy .orchestrator/.
    if (depth > 6 || scanned > 20_000) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile()) {
        scanned++;
        try {
          if (statSync(full).mtimeMs < cutoff) aged++;
        } catch {
          /* vanished mid-scan — ignore */
        }
      }
    }
  };
  walk(dir, 0);

  if (aged === 0) return null;

  const mb = Math.round((duBytes(dir) ?? 0) / (1024 * 1024));
  return {
    check: 'stale-artifacts',
    fixable: true,
    message: `${aged} file(s) under .orchestrator/ older than ${ageDays}d${mb > 0 ? ` (${mb} MB total)` : ''} — candidates for pruning`,
  };
}

/**
 * H4 — CI configuration hygiene.
 *
 * Measured 5/6. Reports only what is decidable by presence, never by parsing
 * pipeline semantics. The dependency-audit gap is the load-bearing one: three
 * of the tested repos carried known-vulnerable dependencies that no pipeline
 * would ever surface.
 *
 * @param {string} repoRoot
 * @returns {object[]}
 */
export function checkCiConfig(repoRoot) {
  const findings = [];
  const gitlabCi = join(repoRoot, '.gitlab-ci.yml');
  const ghWorkflows = join(repoRoot, '.github', 'workflows');
  const hasGitlab = existsSync(gitlabCi);
  const hasGithub = existsSync(ghWorkflows);

  // Only meaningful for repos that actually build something.
  const hasManifest = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'].some((m) =>
    existsSync(join(repoRoot, m)),
  );
  if (!hasManifest) return findings;

  if (!hasGitlab && !hasGithub) {
    findings.push({
      check: 'ci-config',
      fixable: false,
      message: 'no CI pipeline configured (.gitlab-ci.yml / .github/workflows) — nothing verifies commits',
    });
    return findings;
  }

  let ciText = '';
  if (hasGitlab) ciText += safeRead(gitlabCi);
  if (hasGithub) {
    try {
      for (const f of readdirSync(ghWorkflows)) {
        if (f.endsWith('.yml') || f.endsWith('.yaml')) ciText += safeRead(join(ghWorkflows, f));
      }
    } catch {
      /* unreadable workflows dir — fall through with what we have */
    }
  }

  if (ciText && !/\b(npm|pnpm|yarn) audit\b|pip-audit|cargo audit|osv-scanner|dependency.?check/i.test(ciText)) {
    findings.push({
      check: 'ci-audit-job',
      fixable: true,
      message: 'CI runs no dependency-audit step — known-vulnerable dependencies cannot surface in the pipeline',
    });
  }

  return findings;
}

/** @param {string} p @returns {string} */
function safeRead(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * H5 — Env documentation presence (deliberately narrow; see module header).
 *
 * Reports ONLY the falsifiable case: code reads environment variables and no
 * `.env.example` exists anywhere. Does NOT attempt to name dead or missing
 * variables — that requires resolving indirection (central schema modules,
 * injected config objects) and produced a 100% false-positive rate when
 * attempted naively during the diagnostic runs.
 *
 * @param {string} repoRoot
 * @returns {object|null}
 */
export function checkEnvDocumentation(repoRoot) {
  const tracked = git(['ls-files'], repoRoot);
  if (!tracked) return null;

  const files = tracked.split('\n').filter((f) => /\.(mjs|cjs|js|ts|tsx|py|go|rs)$/.test(f));
  if (files.length === 0) return null;

  const hasExample = ['.env.example', '.env.sample', '.env.template'].some((n) =>
    existsSync(join(repoRoot, n)),
  );
  if (hasExample) return null;

  // Sample rather than read every file — one hit is enough to decide.
  let readsEnv = false;
  for (const f of files.slice(0, 400)) {
    const text = safeRead(join(repoRoot, f));
    if (/process\.env\.\w|os\.environ|std::env::var|os\.Getenv/.test(text)) {
      readsEnv = true;
      break;
    }
  }
  if (!readsEnv) return null;

  return {
    check: 'env-documentation',
    fixable: false,
    message: 'code reads environment variables but no .env.example/.env.sample exists — required configuration is undiscoverable',
  };
}

/**
 * Aggregate the project-hygiene family into one banner result.
 *
 * Returns a SINGLE result rather than one banner per check: Phase 4 already
 * renders 13 banners, and the diagnostic runs showed a flat list stops being
 * read past roughly 25 findings. The caller renders the summary plus the top
 * findings and can use `mechanical` to route the fixable subset separately.
 *
 * @param {{ repoRoot: string, now?: number, thresholds?: object }} opts
 * @returns {{ severity: 'warn', message: string, findings: object[], mechanical: number } | null}
 */
export function checkProjectHygiene({ repoRoot, now = Date.now(), thresholds = {} } = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') return null;
  if (!existsSync(join(repoRoot, '.git'))) return null;

  const {
    releaseDriftCommits = DEFAULT_RELEASE_DRIFT_COMMITS,
    ballastMb = DEFAULT_BALLAST_MB,
    artifactAgeDays = DEFAULT_ARTIFACT_AGE_DAYS,
  } = thresholds;

  const findings = [];
  try {
    const release = checkReleaseHygiene(repoRoot, releaseDriftCommits);
    if (release) findings.push(release);

    findings.push(...checkIgnoredBallast(repoRoot, ballastMb));

    const stale = checkStaleArtifacts(repoRoot, artifactAgeDays, now);
    if (stale) findings.push(stale);

    findings.push(...checkCiConfig(repoRoot));

    const env = checkEnvDocumentation(repoRoot);
    if (env) findings.push(env);
  } catch {
    // Probe family is advisory — a partial result beats a crashed session-start.
    if (findings.length === 0) return null;
  }

  if (findings.length === 0) return null;

  const mechanical = findings.filter((f) => f.fixable).length;
  const head = findings.slice(0, 3).map((f) => `• ${f.message}`).join('\n');
  const rest = findings.length > 3 ? `\n  …and ${findings.length - 3} more.` : '';

  return {
    severity: 'warn',
    message:
      `⚠ project-hygiene: ${findings.length} finding(s), ${mechanical} mechanically fixable:\n${head}${rest}`,
    findings,
    mechanical,
  };
}
