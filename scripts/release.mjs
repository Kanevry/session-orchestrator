#!/usr/bin/env node
// scripts/release.mjs
//
// Release als ein Dispatch — the local half of issue #978.
//
// WHY THIS EXISTS (the incident class):
//   Version, tag, npm publish, README badge, CHANGELOG entry, site copy and
//   the two plugin manifests were SEVEN independent manual acts. Every past
//   release forgot at least one: v3.18.0 shipped without its tag for 65
//   commits (retro-tagged 2026-07-31), the marketplace pin froze ~588 commits
//   behind HEAD (#851). The defense is a single surfaces table that both the
//   rewrite and the check share — a version literal that exists outside the
//   table is found by the drift sweep, and a table pattern that stops
//   matching its file is a hard error, never a silent pass.
//
// PHASES:
//   --set-version X.Y.Z   Mechanically rewrite every version surface, then
//                         sync package-lock.json via `npm install
//                         --package-lock-only`. Editorial surfaces (CHANGELOG
//                         entry, README highlights prose) are NOT written —
//                         they are enforced by --check instead.
//   --check               Preflight: surface parity, CHANGELOG entry present
//                         + Unreleased folded, drift sweep, tag collision
//                         (local, origin, github), github/main mirror parity,
//                         npm registry collision, npm token liveness, CI green
//                         on HEAD, leakage gate over `npm pack --dry-run`.
//   --publish             Runs --check first, then: token publish via temp
//                         userconfig (NPM_TOKEN from .env.local), registry
//                         verify, annotated tag AFTER successful publish
//                         (never before — eliminates "tagged but unpublished"),
//                         push main + tag to origin AND the github mirror,
//                         the GitHub release (idempotent, `--verify-tag`), the
//                         live-site poll, then the post-release checklist.
//
// USAGE:
//   node scripts/release.mjs --check [--json] [--skip-ci]
//   node scripts/release.mjs --set-version 3.19.0
//   node scripts/release.mjs --publish [--json]
//
// EXIT CODES:
//   0  success
//   1  check failure (stale surface, missing CHANGELOG entry, tag/registry
//      collision, mirror behind, dead token, CI not green, leakage-gate hit)
//   2  system/usage error (git/npm spawn failure, missing NPM_TOKEN,
//      unknown flag, --skip-ci combined with --publish)
//
// FAIL-CLOSED IS THE HOUSE RULE (the defect class this file kept re-growing):
//   A preflight check reports on evidence it GATHERED. When the gathering
//   itself fails — a non-zero exit nobody read, output in an unexpected shape,
//   an empty listing — the honest verdict is "could not tell", and "could not
//   tell" MUST be reported as `ok:false`. Three checks previously did the
//   opposite: an errored `git grep` produced an empty hit list that read as a
//   clean sweep, an unparseable `npm view` produced an empty version list that
//   read as "no collision", and an `npm pack` whose listing did not parse
//   produced zero scanned lines that read as "0 leaks". Each is a green check
//   that verified nothing, on the one code path where being wrong is
//   irreversible. Hence: every check that consumes a subprocess result routes
//   through an exported `evaluate*` function below, which is pure over
//   `{status, stdout, stderr}` and unit-tested against exactly the degraded
//   shapes that used to pass.
//
//   --skip-ci is the deliberate, operator-visible exception to that rule — and
//   is therefore REFUSED under --publish (see `validateFlags`).
//
// SECURITY INVARIANTS (from skills/npm-publish/SKILL.md):
//   - NPM_TOKEN only from gitignored .env.local; never logged, never persisted.
//   - Temp userconfig chmod 600, removed in a finally block.
//   - Leakage gate runs before EVERY publish, not only the first.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  chmodSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveRepoSpec } from './lib/vcs-repo-spec.mjs';

const PACKAGE_NAME = 'session-orchestrator';
const SPAWN_OPTS = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };

// ---------------------------------------------------------------------------
// Surfaces table — the SSOT both the scan and the rewrite share.
//
// Every entry: { file, patterns: [RegExp], checkOnly?: boolean }. Each pattern
// has exactly one capture group holding the version. Matching ZERO occurrences
// is a hard failure ("pattern-dead") — that is the guard against a surface
// silently falling out of the check after a file refactor. All captured
// versions must equal the target.
//
// `checkOnly: true` means: scanned by --check, NOT rewritten by applyVersion,
// because a different generator owns the write. See site/index.html below for
// the only current case and for why the ownership split is structural here
// rather than a comment asking the next editor to be careful.
//
// CHANGELOG.md is deliberately NOT here: it carries version HISTORY, so a
// replace-all would corrupt it. It has its own editorial check below.
// package-lock.json is also special-cased (thousands of dep "version" keys).
// ---------------------------------------------------------------------------
export const SURFACES = [
  {
    file: 'package.json',
    patterns: [/"version":\s*"(\d+\.\d+\.\d+)"/],
  },
  {
    file: '.claude-plugin/plugin.json',
    patterns: [/"version":\s*"(\d+\.\d+\.\d+)"/],
  },
  {
    file: '.claude-plugin/marketplace.json',
    patterns: [/"version":\s*"(\d+\.\d+\.\d+)"/g],
  },
  {
    // Codex manifest: version is '<base>+codex.<YYYYMMDDHHmmss>' (see
    // scripts/lib/codex/plugin-contract.mjs). The base must equal the target;
    // applyVersion additionally rotates the cachebuster timestamp. This
    // surface was the first drift-sweep catch: a plain `rg` census missed it
    // because ripgrep skips hidden directories by default — only `git grep`
    // (and the validate-plugin base-version check) saw it.
    file: '.codex-plugin/plugin.json',
    patterns: [/"version":\s*"(\d+\.\d+\.\d+)\+codex\./],
  },
  {
    file: 'hooks/hooks.json',
    patterns: [/Session Orchestrator v(\d+\.\d+\.\d+)/],
  },
  {
    file: 'hooks/hooks-codex.json',
    patterns: [/Session Orchestrator v(\d+\.\d+\.\d+)/],
  },
  {
    file: 'README.md',
    patterns: [
      /version-(\d+\.\d+\.\d+)-blue\.svg/,
      /^## Recent highlights \(v(\d+\.\d+\.\d+)\)/m,
      /Highlights of the v(\d+\.\d+\.\d+) line:/,
    ],
  },
  {
    // ONE WRITER, ONE CHECKER — and they are not the same program.
    //
    // The page carries its version in three `<span data-metric="version">`
    // cells, and `scripts/site-numbers.mjs --write` owns every `data-metric`
    // cell on the site: it recomputes each one from its declared source (for
    // `version`, that source is package.json). This table only READS them back,
    // hence `checkOnly` — applyVersion deliberately does not touch this file.
    //
    // Why that is not a gap: --set-version runs applyVersion FIRST (package.json
    // gets the target) and `site-numbers --write` SECOND, so the generator
    // derives the same literal from the surface applyVersion just wrote. Adding
    // a second writer here would not "make it safer" — it would make two
    // programs authoritative for one cell, and the next divergence between them
    // would be invisible until a release shipped. If the generator ever stops
    // running, this check goes red rather than quietly self-healing, which is
    // the outcome worth having.
    //
    // HISTORY (do not restore either old pattern): the previous entry was
    // `/"softwareVersion":\s*"(...)"/` plus `/v(\d+\.\d+\.\d+)\b/g`. Commit
    // 8802aa4 removed `softwareVersion` from the JSON-LD (deliberately — see the
    // comment at the top of site/index.html) and replaced the bare `vX.Y.Z`
    // literals with the metric cells, leaving BOTH patterns matching nothing.
    // The pattern-dead guard caught that, which is the entire reason it exists.
    // The `\b`-anchored one was also actively dangerous as a WRITE pattern: it
    // was a replace-all over every `vX.Y.Z` on the page, so a sentence
    // mentioning a historical release would have been silently rewritten to the
    // new version by --set-version. The replacement is anchored to the cell.
    file: 'site/index.html',
    patterns: [/data-metric="version"[^>]*>(\d+\.\d+\.\d+)</g],
    checkOnly: true,
  },
  {
    file: 'site/llms.txt',
    patterns: [/Version:\s*(\d+\.\d+\.\d+)/],
  },
  {
    file: 'site/llms-full.txt',
    patterns: [/Version\s+(\d+\.\d+\.\d+)/g],
  },
];

/**
 * Scan every surface against the target version.
 * Pure over the filesystem — no git/network. Returns one row per surface:
 * { file, ok, problems: string[] }.
 */
export function scanSurfaces(repoRoot, target) {
  const rows = [];
  for (const surface of SURFACES) {
    const abs = join(repoRoot, surface.file);
    const problems = [];
    if (!existsSync(abs)) {
      rows.push({ file: surface.file, ok: false, problems: ['file missing'] });
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    for (const pattern of surface.patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      const found = [...text.matchAll(re)].map((m) => m[1]);
      if (found.length === 0) {
        problems.push(`pattern-dead: /${pattern.source}/ matches nothing`);
        continue;
      }
      const stale = found.filter((v) => v !== target);
      if (stale.length > 0) {
        problems.push(`/${pattern.source}/ found ${stale.join(', ')} (want ${target})`);
      }
    }
    rows.push({ file: surface.file, ok: problems.length === 0, problems });
  }

  // package-lock.json — parse, don't pattern-match (dep versions everywhere).
  const lockPath = join(repoRoot, 'package-lock.json');
  if (!existsSync(lockPath)) {
    rows.push({ file: 'package-lock.json', ok: false, problems: ['file missing'] });
  } else {
    const problems = [];
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (lock.version !== target) problems.push(`root version is ${lock.version} (want ${target})`);
      const rootPkg = lock.packages?.[''];
      if (rootPkg && rootPkg.version !== target) {
        problems.push(`packages[""].version is ${rootPkg.version} (want ${target})`);
      }
    } catch (err) {
      problems.push(`unparseable: ${err.message}`);
    }
    rows.push({ file: 'package-lock.json', ok: problems.length === 0, problems });
  }

  return rows;
}

/**
 * Mechanically rewrite every surface to the target version by replacing the
 * captured version in each pattern match. Idempotent. Does NOT touch
 * CHANGELOG.md or package-lock.json (the caller syncs the lock via npm), nor
 * any `checkOnly` surface (another generator owns that file's write — see the
 * site/index.html entry in SURFACES).
 * Returns the list of files actually changed.
 */
export function applyVersion(repoRoot, target) {
  const changed = [];
  for (const surface of SURFACES) {
    if (surface.checkOnly) continue;
    const abs = join(repoRoot, surface.file);
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, 'utf8');
    let after = before;
    for (const pattern of surface.patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      after = after.replace(re, (full, captured) => full.replace(captured, target));
    }
    if (surface.file === '.codex-plugin/plugin.json') {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      after = after.replace(/(\+codex\.)\d{14}/, `$1${stamp}`);
    }
    if (after !== before) {
      writeFileSync(abs, after);
      changed.push(surface.file);
    }
  }
  return changed;
}

/**
 * Editorial gate: the CHANGELOG must carry a dated entry for the target as
 * its topmost release, and [Unreleased] must be folded (empty) — an
 * Unreleased section with content means the release notes are incomplete.
 */
export function checkChangelogEntry(text, target) {
  const problems = [];
  const entryRe = new RegExp(`^## \\[${target.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}`, 'm');
  if (!entryRe.test(text)) {
    problems.push(`no "## [${target}] - YYYY-MM-DD" entry`);
  }
  const headings = [...text.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
  const firstRelease = headings.find((h) => h.toLowerCase() !== 'unreleased');
  if (firstRelease && firstRelease !== target) {
    problems.push(`topmost release entry is [${firstRelease}], not [${target}]`);
  }
  const unreleasedMatch = text.match(/^## \[Unreleased\]([\s\S]*?)(?=^## \[|$(?![\s\S]))/m);
  if (unreleasedMatch && unreleasedMatch[1].trim() !== '') {
    problems.push('[Unreleased] still has content — fold it into the release entry');
  }
  return { ok: problems.length === 0, problems };
}

// The seven leakage patterns from skills/npm-publish/SKILL.md, applied to
// `npm pack --dry-run` output lines. Any hit blocks the publish.
export const LEAKAGE_PATTERNS = [
  { name: 'tests/', re: /npm notice.* tests\// },
  { name: '.orchestrator/', re: /npm notice.*\.orchestrator\// },
  { name: '.claude/', re: /npm notice.*\s\.claude\// },
  { name: '.github/', re: /npm notice.*\.github\// },
  { name: 'node_modules', re: /node_modules/ },
  { name: '.env', re: /npm notice.*\.env/i },
  { name: 'owner.yaml', re: /owner\.yaml/i },
  // Claimed as checked by docs/distribution/npm-publish-checklist.md long before
  // any code checked it (measured 2026-08-19: 3 leakage lists, 3 different sets).
  // `files` in package.json overrides .gitignore, so a stray .DS_Store inside a
  // shipped directory reaches the tarball.
  { name: '.DS_Store', re: /\.DS_Store/ },
];

// `commands/release.md` quotes the `npm view` OUTPUT that proves the 3.18.0 gap,
// dated at the line. Bumping it would destroy the evidence it exists to carry —
// the registry state on that date is the whole point of the paragraph.
//
// `site/guide/index.html` carries ONE dated historical sentence — "re-checked
// against v<prev> on <date>" — deliberately left as a literal: a release that
// bumped the version while the date stood still would fabricate a verification
// nobody ran. The page is not unguarded by this exemption. It loses only the
// coarse prev-tag sweep and keeps the STRICTER guard in
// tests/scripts/site-numbers.test.mjs, which forbids ANY vX.Y.Z and the current
// package version outside a `data-metric` cell on EVERY shipped page, and
// exempts exactly the lines marked `site-numbers:historical`.
export const HISTORY_ALLOWLIST = /^(CHANGELOG\.md|README\.md|docs\/|tests\/|skills\/npm-publish\/|scripts\/release\.mjs|\.orchestrator\/|site\/leaderboard\.json|site\/guide\/index\.html|commands\/release\.md)/;

/** Pure check over pack-output lines. Returns violations: {name, line}[]. */
export function checkLeakage(lines) {
  const violations = [];
  for (const line of lines) {
    for (const { name, re } of LEAKAGE_PATTERNS) {
      if (re.test(line)) violations.push({ name, line: line.trim() });
    }
  }
  return violations;
}

/**
 * One packed tarball entry in `npm pack --dry-run` output:
 * `npm notice 1.3kB .claude-plugin/marketplace.json`.
 *
 * The previous inline counter was `/npm notice.*[0-9]+B /`, which requires a
 * DIGIT immediately before the `B` and therefore matched only entries sized in
 * plain bytes — 108 of the 830 real entries at 8984224. It was never load-
 * bearing (it only decorated a detail string), but it becomes load-bearing the
 * moment a floor is asserted on it, so it is fixed here rather than floored at
 * a number that means nothing.
 */
export const PACKED_ENTRY_RE = /^npm notice\s+[\d.]+\s*(?:B|kB|MB|GB)\s+\S/;

/**
 * Floor on parsed packed entries, below which the leak scan is presumed BLIND
 * rather than clean.
 *
 * Measured at 8984224 with `npm pack --dry-run`: npm's own summary reports
 * `total files: 830` and {@link PACKED_ENTRY_RE} independently counts 830 —
 * two differently-shaped measurements agreeing. Package size 2.9 MB, unpacked
 * 8.9 MB. (docs/distribution/npm-publish-checklist.md still records the older
 * "~750 files, ~6.5 MB unpacked" baseline; that file has a different owner.)
 *
 * 400 is a FLOOR, not a pin — deliberately ~48% of today's count. It cannot
 * break on growth (the pack only grows), and it is far enough below 830 that a
 * deliberate docs/skills prune would not trip it. What it does catch is the
 * whole failure class in one number: an npm output-format change, an
 * `npm notice` prefix rename, a `files`/`.npmignore` edit that drops entire
 * trees — every state in which the scan sees a handful of lines, finds no
 * leak pattern in them, and reports "0 leaks" with total confidence.
 */
export const MIN_PACKED_ENTRIES = 400;

// ---------------------------------------------------------------------------
// Preflight evaluators — pure over a spawn result `{status, stdout, stderr}`.
//
// These exist so the DECISION of every preflight check is unit-testable while
// the subprocess call itself stays in the impure section below. Each returns
// `{ok, detail}`. The shared contract, and the reason this family exists at
// all, is the FAIL-CLOSED house rule in the file header: an evaluator may
// return `ok:true` only when it has positively SEEN the evidence, never merely
// because it failed to see a counterexample.
// ---------------------------------------------------------------------------

/**
 * Drift sweep verdict over a `git grep -l` result.
 *
 * `git grep` exit codes: 0 = matches found, 1 = no match (the success case
 * here), anything else = it did not run. Measured on git 2.x: a bad regex and
 * a bad pathspec both exit 128; git also documents 2 for usage errors. The old
 * inline code read `.stdout` without ever looking at `.status`, so BOTH the
 * no-match case and the it-crashed case produced an empty hit list and the
 * same reassuring detail line, "no tracked file still carries X". A sweep that
 * never ran is not a clean sweep.
 *
 * @param {{status: number, stdout?: string, stderr?: string}} grep
 * @param {string} prevTag — the previous release literal being swept for
 * @param {RegExp} allowlist — files that legitimately carry version HISTORY
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateDriftSweep(grep, prevTag, allowlist) {
  if (grep.status !== 0 && grep.status !== 1) {
    return {
      ok: false,
      detail: `git grep did not run (exit ${grep.status}): ${(grep.stderr || '').trim().slice(0, 200)} — sweep for ${prevTag} is inconclusive`,
    };
  }
  const hits = (grep.stdout || '')
    .split('\n')
    .filter(Boolean)
    .filter((f) => !allowlist.test(f));
  return {
    ok: hits.length === 0,
    detail: hits.length
      ? `still carry ${prevTag}: ${hits.slice(0, 5).join(', ')}`
      : `no tracked file outside the allowlist still carries ${prevTag}`,
  };
}

/**
 * Registry-collision verdict over `npm view <pkg> versions --json`.
 *
 * The most dangerous of the three fail-opens this file carried: on `status 0`
 * with unparseable stdout, the old code swallowed the parse error, left the
 * version list EMPTY, and concluded from that emptiness that the target was
 * free — reporting `latest: ?` while claiming the collision check had passed.
 * Reproduced verbatim: a `<html>` body (proxy/captive-portal response) with
 * exit 0 yields `ok = true`. Any npm output-format change lands in the same
 * hole. An empty ARRAY is treated identically: a published package always has
 * at least one version, so an empty list is a shape we do not understand, not
 * an all-clear.
 *
 * @param {{status: number, stdout?: string, stderr?: string}} view
 * @param {string} target
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateRegistryCollision(view, target) {
  if (view.status !== 0) {
    const e404 = /E404/.test(view.stderr || '');
    return e404
      ? { ok: true, detail: 'package not yet on registry (first publish)' }
      : { ok: false, detail: `npm view failed (exit ${view.status}): ${(view.stderr || '').slice(0, 200)}` };
  }
  const raw = view.stdout || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      detail: `npm view returned unparseable JSON (${raw.length} bytes, starts "${raw.trim().slice(0, 40)}") — cannot rule out a collision on ${target}`,
    };
  }
  const published = Array.isArray(parsed) ? parsed : [parsed];
  if (published.length === 0) {
    return { ok: false, detail: `npm view returned an empty version list — cannot rule out a collision on ${target}` };
  }
  return published.includes(target)
    ? { ok: false, detail: `${target} already published` }
    : { ok: true, detail: `latest: ${published[published.length - 1]}` };
}

/**
 * Leakage-gate verdict over an `npm pack --dry-run` result.
 *
 * The SURFACES table has `pattern-dead` for exactly this class — a matcher that
 * stops matching its input must be a hard error, never a silent pass — and the
 * leak scan had no equivalent: an `npm pack` that exits 0 with output the scan
 * cannot parse yields zero scanned lines, zero violations, and the verdict
 * "0 packed entries, 0 leaks". Reproduced verbatim with empty stdout+stderr.
 * {@link MIN_PACKED_ENTRIES} is that missing `pattern-dead`.
 *
 * The floor is asserted on the SAME lines `checkLeakage` scans, not on npm's
 * `total files:` summary line. That is the point: the summary could survive a
 * format change that broke the per-entry lines, and it is the per-entry lines
 * whose absence blinds the scan.
 *
 * @param {{status: number, stdout?: string, stderr?: string}} pack
 * @param {{minEntries?: number}} [opts]
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateLeakageGate(pack, { minEntries = MIN_PACKED_ENTRIES } = {}) {
  if (pack.status !== 0) {
    return { ok: false, detail: `npm pack failed (exit ${pack.status}): ${(pack.stderr || '').trim().slice(-200)}` };
  }
  const lines = `${pack.stdout || ''}\n${pack.stderr || ''}`.split('\n');
  const entries = lines.filter((l) => PACKED_ENTRY_RE.test(l)).length;
  if (entries < minEntries) {
    return {
      ok: false,
      detail: `only ${entries} packed entries parsed (floor ${minEntries}) — the pack listing did not parse, so the leak scan read ${entries} line(s) and its "no leaks" verdict means nothing`,
    };
  }
  const violations = checkLeakage(lines);
  return violations.length
    ? { ok: false, detail: violations.map((v) => `${v.name}: ${v.line}`).slice(0, 5).join(' | ') }
    : { ok: true, detail: `${entries} packed entries, 0 leaks` };
}

/**
 * Remote-branch parity verdict over `git ls-remote <remote> refs/heads/<branch>`.
 *
 * Preflight compared HEAD against `origin/main` only. The Vercel deploy hangs
 * off the GITHUB mirror, so a mirror that lags is invisible until
 * `verifyLiveSite` fails — which happens AFTER npm publish and AFTER both tag
 * pushes, i.e. after the two irreversible steps. Same fail-closed shape as
 * `tag-free-github`: a failed `ls-remote` is a failed check, and so is output
 * that carries no sha (an empty answer for `refs/heads/main` means the branch
 * is not there at all, which is not parity either).
 *
 * @param {string} remote
 * @param {{status: number, stdout?: string, stderr?: string}} ls
 * @param {string} head — the local HEAD sha
 * @param {string} [branch]
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateRemoteHeadParity(remote, ls, head, branch = 'main') {
  if (ls.status !== 0) {
    return { ok: false, detail: `ls-remote ${remote} failed (exit ${ls.status}): ${(ls.stderr || '').trim().slice(0, 200)}` };
  }
  const sha = (ls.stdout || '').trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    return { ok: false, detail: `ls-remote ${remote} returned no sha for refs/heads/${branch} — cannot compare` };
  }
  return sha === head
    ? { ok: true, detail: sha.slice(0, 8) }
    : { ok: false, detail: `${remote}/${branch} at ${sha.slice(0, 8)}, HEAD at ${head.slice(0, 8)} — the mirror is behind` };
}

/**
 * npm-auth verdict over `npm whoami --userconfig <tmp>`.
 *
 * A dead or revoked token used to surface only inside `publish()`, i.e. after
 * every other preflight check had passed and the operator had committed to the
 * release. The probe is read-only and costs one request. Fail-closed on the
 * empty-identity case too: `whoami` exiting 0 while printing nothing is not
 * proof of an identity.
 *
 * @param {{status: number, stdout?: string, stderr?: string}|null} whoami
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateNpmAuth(whoami) {
  if (!whoami) return { ok: false, detail: 'npm whoami was not run' };
  if (whoami.status !== 0) {
    return { ok: false, detail: `npm whoami exited ${whoami.status}: ${(whoami.stderr || '').trim().slice(0, 200)}` };
  }
  const who = (whoami.stdout || '').trim();
  return who
    ? { ok: true, detail: `authenticated as ${who}` }
    : { ok: false, detail: 'npm whoami exited 0 with an empty identity — the token could not be confirmed' };
}

/**
 * Flag-combination gate, applied before any work.
 *
 * `--skip-ci` turns the CI check into `ok:true` with the detail
 * "SKIPPED via --skip-ci". That is a legitimate affordance for `--check` (an
 * operator inspecting surface parity while a pipeline is still running) and an
 * illegitimate one for `--publish`: it would let a green summary that verified
 * nothing about CI authorise npm publish + two tag pushes, none of which can be
 * taken back. The refusal is a usage error (exit 2), not a check failure —
 * nothing was checked.
 *
 * @param {{publish?: boolean, 'skip-ci'?: boolean}} values
 * @returns {{ok: boolean, code?: number, message?: string}}
 */
export function validateFlags(values) {
  if (values.publish && values['skip-ci']) {
    return {
      ok: false,
      code: 2,
      message:
        '--skip-ci is refused under --publish: it makes ci-green-on-head pass without checking anything, and publish is irreversible.\n' +
        'Run `--check --skip-ci` to inspect the other surfaces, then `--publish` once CI is actually green on HEAD.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Impure orchestration below — git/npm/network. The DECISIONS live in the
// evaluators above and are unit-tested; what remains here is the plumbing that
// feeds them.
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { ...SPAWN_OPTS, ...opts });
  if (res.error) throw new Error(`${cmd} ${args.join(' ')}: ${res.error.message}`);
  return res;
}

function mustRun(cmd, args, opts = {}) {
  const res = run(cmd, args, opts);
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}: ${(res.stderr || res.stdout || '').slice(0, 500)}`);
  }
  return res;
}

function readPackageVersion(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
}

async function preflight(repoRoot, target, { skipCi = false } = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  // 1. Git state: on main, clean tree, HEAD present on BOTH publish remotes.
  //
  // Both remotes, symmetrically, and both read LIVE via ls-remote rather than
  // from a local tracking ref. origin (GitLab) is where the code lives; github
  // is where the Vercel git integration watches, so a lagging mirror means the
  // site cannot deploy — and that was previously discovered only by
  // verifyLiveSite, i.e. after npm publish and both tag pushes had already
  // happened. The old origin check read `origin/main` after a `git fetch` whose
  // exit status nobody inspected: a failed fetch left a stale tracking ref that
  // could still equal HEAD, so the comparison was against remembered state
  // rather than remote state. ls-remote has no such intermediate.
  const branch = run('git', ['branch', '--show-current'], { cwd: repoRoot }).stdout.trim();
  add('branch-is-main', branch === 'main', branch);
  // `git status` exit status is read, not assumed: an empty stdout from a
  // FAILED status call is indistinguishable from a genuinely clean tree, and
  // the empty-reads-as-all-clear shape is exactly the fail-open this file was
  // hardened against elsewhere. Same reasoning for the two `git tag -l` reads
  // below — those are the only other preflight subprocesses whose emptiness
  // means "all clear" (census: all 14 `run(` call sites in this file).
  const status = run('git', ['status', '--porcelain'], { cwd: repoRoot });
  const dirty = (status.stdout || '').trim();
  add(
    'working-tree-clean',
    status.status === 0 && dirty === '',
    status.status !== 0
      ? `git status failed (exit ${status.status}) — cleanliness unknown`
      : dirty
        ? `${dirty.split('\n').length} dirty path(s)`
        : '',
  );
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  for (const remote of ['origin', 'github']) {
    const ls = run('git', ['ls-remote', remote, 'refs/heads/main'], { cwd: repoRoot });
    const parity = evaluateRemoteHeadParity(remote, ls, head);
    add(`head-pushed-${remote}`, parity.ok, parity.detail);
  }

  // 2. Surface parity.
  const surfaceRows = scanSurfaces(repoRoot, target);
  for (const row of surfaceRows) {
    add(`surface:${row.file}`, row.ok, row.problems.join('; '));
  }

  // 3. CHANGELOG editorial gate.
  const changelog = checkChangelogEntry(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), target);
  add('changelog-entry', changelog.ok, changelog.problems.join('; '));

  // 3b. Drift sweep: no TRACKED file outside the surfaces table + allowlist
  // may still carry the previous release's version literal. `git grep` (not
  // rg) on purpose — it searches every tracked file including hidden
  // directories, which is exactly how the forgotten .codex-plugin manifest
  // was invisible to a plain rg census. Allowlisted: files that legitimately
  // carry version HISTORY.
  const tagList = run('git', ['tag', '-l', 'v*', '--sort=-v:refname'], { cwd: repoRoot });
  const prevTag = (tagList.stdout || '')
    .split('\n').map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t) && t !== target)[0];
  if (tagList.status !== 0) {
    // "No previous tag" and "could not list tags" are different facts, and only
    // one of them means the sweep is unnecessary.
    add('drift-sweep', false, `git tag -l failed (exit ${tagList.status}) — cannot determine the previous release to sweep for`);
  } else if (prevTag) {
    const grep = run('git', ['grep', '-l', '--fixed-strings', prevTag, '--', '.'], { cwd: repoRoot });
    const sweep = evaluateDriftSweep(grep, prevTag, HISTORY_ALLOWLIST);
    add('drift-sweep', sweep.ok, sweep.detail);
  } else {
    add('drift-sweep', true, 'no previous tag to sweep against');
  }

  // 4. Tag collision — local, origin, github mirror.
  const tag = `v${target}`;
  const localTagRes = run('git', ['tag', '-l', tag], { cwd: repoRoot });
  const localTag = (localTagRes.stdout || '').trim();
  add(
    'tag-free-local',
    localTagRes.status === 0 && localTag === '',
    localTagRes.status !== 0
      ? `git tag -l failed (exit ${localTagRes.status}) — local tag collision unknown`
      : localTag && `${tag} already exists locally`,
  );
  for (const remote of ['origin', 'github']) {
    const ls = run('git', ['ls-remote', '--tags', remote, `refs/tags/${tag}`], { cwd: repoRoot });
    const collision = ls.status === 0 && ls.stdout.trim() !== '';
    add(`tag-free-${remote}`, ls.status === 0 && !collision, collision ? `${tag} already on ${remote}` : ls.status !== 0 ? `ls-remote ${remote} failed` : '');
  }

  // 5. npm registry collision (E404 = name free = fine for a first publish).
  const view = run('npm', ['view', PACKAGE_NAME, 'versions', '--json'], { cwd: repoRoot });
  const registry = evaluateRegistryCollision(view, target);
  add('registry-version-free', registry.ok, registry.detail);

  // 5b. npm token liveness. Read-only, one request, and it answers the one
  // question the rest of the preflight cannot: is the credential we are about
  // to publish with actually alive? Without it, a revoked or expired token
  // surfaces inside publish() — after every other check has gone green and the
  // operator has committed to the release. Same token discipline as publish():
  // .env.local only, temp userconfig at 0600, removed in a finally.
  let auth;
  try {
    auth = withTempUserconfig(loadNpmToken(repoRoot), (rc) =>
      run('npm', ['whoami', '--userconfig', rc], { cwd: repoRoot }),
    );
    const verdict = evaluateNpmAuth(auth);
    add('npm-token-live', verdict.ok, verdict.detail);
  } catch (err) {
    // A missing/ungitignored .env.local is a legitimate red preflight, not a
    // crash: "cannot publish from here" is exactly what the operator needs.
    add('npm-token-live', false, err.message);
  }

  // 6. CI green on HEAD (the repo's iron session-start rule applies to
  // releases doubly: local green is not evidence — see .claude/rules).
  // --skip-ci is refused under --publish upstream in validateFlags(); it can
  // only reach this branch from --check.
  if (skipCi) {
    add('ci-green-on-head', true, 'SKIPPED via --skip-ci');
  } else {
    const { checkCiStatus } = await import('./lib/ci-status-banner.mjs');
    const ci = await checkCiStatus({ repoRoot, timeoutMs: 15000 });
    const green = ci !== null && ci.status === 'green';
    add('ci-green-on-head', green, ci === null ? 'CI status unavailable' : `status: ${ci.status}${ci.failingJobName ? ` (${ci.failingJobName})` : ''}`);
  }

  // 7. Leakage gate over the actual pack file list.
  const pack = run('npm', ['pack', '--dry-run'], { cwd: repoRoot });
  const leakage = evaluateLeakageGate(pack);
  add('leakage-gate', leakage.ok, leakage.detail);

  return checks;
}

function changelogExcerpt(repoRoot, target) {
  const text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const re = new RegExp(`^## \\[${target.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|$(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  return m ? m[1].trim().split('\n').slice(0, 40).join('\n') : '';
}

/**
 * Read NPM_TOKEN from the gitignored .env.local, refusing if the ignore is not
 * actually in force. Throws with an operator-actionable message; the token
 * itself is never part of any message.
 */
function loadNpmToken(repoRoot) {
  const ignored = run('git', ['check-ignore', '.env.local'], { cwd: repoRoot });
  if (ignored.status !== 0) throw new Error('.env.local is NOT gitignored — refusing to read a token from it');
  if (!existsSync(join(repoRoot, '.env.local'))) throw new Error('.env.local not found — no NPM_TOKEN to publish with');
  const tokenMatch = readFileSync(join(repoRoot, '.env.local'), 'utf8').match(/^NPM_TOKEN=(.+)$/m);
  if (!tokenMatch) throw new Error('NPM_TOKEN not found in .env.local');
  return tokenMatch[1].trim();
}

/**
 * Run `fn(userconfigPath)` against a throwaway npm userconfig carrying the
 * token. Extracted so the preflight liveness probe and the publish itself share
 * ONE implementation of the security invariants from
 * skills/npm-publish/SKILL.md — 0600, and removed in a finally even when the
 * callback throws. Two hand-copied versions of this dance would be two places
 * for a token file to be left behind.
 */
function withTempUserconfig(token, fn) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'release-npmrc-'));
  const tmpRc = join(tmpDir, 'npmrc');
  try {
    writeFileSync(tmpRc, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
    chmodSync(tmpRc, 0o600);
    return fn(tmpRc);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function publish(repoRoot, target) {
  const token = loadNpmToken(repoRoot);
  const res = withTempUserconfig(token, (tmpRc) =>
    run('npm', ['publish', '--access', 'public', '--userconfig', tmpRc], { cwd: repoRoot }),
  );
  const out = `${res.stdout}\n${res.stderr}`;
  if (res.status !== 0 || !out.includes(`+ ${PACKAGE_NAME}@${target}`)) {
    // Never echo the raw output wholesale into logs beyond the error slice —
    // it cannot contain the token (npm masks userconfig), but stay frugal.
    throw new Error(`npm publish failed (exit ${res.status}): ${out.slice(0, 800)}`);
  }

  // Registry verify with propagation retries.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const view = run('npm', ['view', PACKAGE_NAME, 'version'], { cwd: repoRoot });
    if (view.status === 0 && view.stdout.trim() === target) return;
    if (attempt < 5) spawnSync('sleep', ['3']);
  }
  throw new Error(`registry verify failed: npm view does not report ${target} after 5 attempts`);
}

function tagAndPush(repoRoot, target) {
  const tag = `v${target}`;
  const excerpt = changelogExcerpt(repoRoot, target);
  const msgDir = mkdtempSync(join(tmpdir(), 'release-tagmsg-'));
  const msgFile = join(msgDir, 'msg');
  try {
    writeFileSync(msgFile, `${tag}\n\n${excerpt}\n`);
    mustRun('git', ['tag', '-a', tag, '-F', msgFile], { cwd: repoRoot });
  } finally {
    rmSync(msgDir, { recursive: true, force: true });
  }
  const pushed = [];
  for (const remote of ['origin', 'github']) {
    mustRun('git', ['push', remote, 'main'], { cwd: repoRoot });
    mustRun('git', ['push', remote, tag], { cwd: repoRoot });
    pushed.push(remote);
  }
  return { tag, pushed };
}

/**
 * Create the GitHub release for `v<target>`, or confirm the existing one.
 *
 * WHY THIS IS CODE AND NOT A CHECKLIST LINE: it was a checklist line, and the
 * evidence that a checklist line is not a mechanism is in the release history.
 * The GitHub releases for v3.15, v3.18, v3.19 and v3.20 were all created within
 * a THREE-SECOND window on 2026-08-19 — hand-backfilled in one sitting, 5 to 31
 * days after their tags, where the releases that were not forgotten were made 19
 * seconds to 2.5 minutes after theirs. The same class of gap left 3.18.0 with a
 * tag, a GitHub release and a CHANGELOG entry that the npm registry has still
 * never seen.
 *
 * Three properties make this safe to run unconditionally after a push:
 *  - `--verify-tag` makes gh refuse when the tag is not on the remote, so
 *    "release without a tag" is structurally impossible rather than merely
 *    discouraged.
 *  - The `gh release view` probe first makes a re-run a no-op instead of an
 *    error, so a second `--publish` pass after a partial failure is not blocked
 *    by the step that already succeeded.
 *  - The `-R` spec comes from `resolveRepoSpec({vcs:'github'})` (#1039), not a
 *    hardcoded owner/repo, so a fork or a renamed remote targets its own repo.
 *
 * Never throws: the caller has already published to npm and pushed both tags by
 * the time this runs, so an exception here would report a successful release as
 * a crash. Failure comes back as `{ok:false}` with the recovery command.
 *
 * @param {string} repoRoot
 * @param {string} target
 * @param {{runImpl?: Function, repoSpec?: string}} [deps] — injection seam for tests
 * @returns {{ok: boolean, created: boolean, tag: string, detail: string, argv?: string[]}}
 */
export function ensureGithubRelease(repoRoot, target, deps = {}) {
  const runImpl = deps.runImpl ?? run;
  const tag = `v${target}`;
  const spec = deps.repoSpec ?? resolveRepoSpec({ repoRoot, vcs: 'github' });
  // resolveRepoSpec returns undefined when it cannot auto-detect; its contract
  // is that callers OMIT the flag rather than pass `-R undefined`.
  const repoFlag = spec ? ['--repo', spec] : [];

  try {
    const existing = runImpl('gh', ['release', 'view', tag, ...repoFlag], { cwd: repoRoot });
    if (existing.status === 0) {
      return { ok: true, created: false, tag, detail: `GitHub release ${tag} already exists — no-op` };
    }

    const notesDir = mkdtempSync(join(tmpdir(), 'release-ghnotes-'));
    const notesFile = join(notesDir, 'notes.md');
    let argv;
    try {
      writeFileSync(notesFile, `${changelogExcerpt(repoRoot, target)}\n`);
      argv = ['release', 'create', tag, ...repoFlag, '--verify-tag', '--title', tag, '--notes-file', notesFile];
      const created = runImpl('gh', argv, { cwd: repoRoot });
      if (created.status !== 0) {
        return {
          ok: false,
          created: false,
          tag,
          argv,
          detail: `gh release create exited ${created.status}: ${(created.stderr || created.stdout || '').trim().slice(0, 300)}`,
        };
      }
      return { ok: true, created: true, tag, argv, detail: `GitHub release ${tag} created (--verify-tag)` };
    } finally {
      rmSync(notesDir, { recursive: true, force: true });
    }
  } catch (err) {
    return { ok: false, created: false, tag, detail: `gh could not be run: ${err.message}` };
  }
}

/**
 * Poll the live site until it serves `expected`, or give up.
 *
 * WHY POLLING: the Vercel git integration builds asynchronously after the push
 * to `github`, so a single immediate check would report a false negative on
 * every release. WHY AT ALL: the live site silently fell a release behind twice
 * in four weeks (#1043) — a deploy that reports success at the push and is
 * never re-read afterwards cannot tell "deployed" from "did not deploy".
 *
 * Fail-closed by design: a network error, a non-200, an unparseable body and a
 * genuine version mismatch are four DISTINCT reported outcomes, never collapsed
 * onto one "not ok" — collapsing them is the defect class this replaces.
 *
 * @param {string} expected — the version literal the site must serve
 * @param {{url?: string, attempts?: number, delayMs?: number, fetchImpl?: Function}} [opts]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function verifyLiveSite(expected, opts = {}) {
  const url = opts.url ?? 'https://session-orchestrator.com/llms.txt';
  const attempts = opts.attempts ?? 12;
  const delayMs = opts.delayMs ?? 10_000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let last = 'no attempt made';

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await doFetch(url, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) {
        last = `HTTP ${res.status} from ${url}`;
      } else {
        const body = await res.text();
        const m = body.match(/^Version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m);
        if (!m) {
          last = `no "Version: X.Y.Z" line in ${url} (${body.length} bytes) — the surface moved, fix the check`;
        } else if (m[1] === expected) {
          return { ok: true, detail: `attempt ${i}/${attempts}, ${url}` };
        } else {
          last = `live serves ${m[1]}, expected ${expected}`;
        }
      }
    } catch (err) {
      last = `fetch failed: ${err.message}`;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false, detail: `${last} (gave up after ${attempts} attempts)` };
}

function printChecks(checks, asJson, version) {
  const ok = checks.every((c) => c.ok);
  if (asJson) {
    console.log(JSON.stringify({ ok, version, checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.ok ? '  ok ' : 'FAIL '} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    console.log(ok ? `\nAll ${checks.length} checks green for v${version}.` : `\n${checks.filter((c) => !c.ok).length} of ${checks.length} checks FAILED for v${version}.`);
  }
  return ok;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'set-version': { type: 'string' },
      check: { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      'skip-ci': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log('Usage: node scripts/release.mjs [--set-version X.Y.Z | --check | --publish] [--skip-ci] [--json]');
    console.log('Release als ein Dispatch: surface sync, preflight checks, token publish, tag AFTER publish.');
    console.log('  --skip-ci  allowed with --check only; REFUSED with --publish (it verifies nothing).');
    console.log('Exit codes: 0 success, 1 check failure, 2 system/usage error.');
    return 0;
  }

  const flags = validateFlags(values);
  if (!flags.ok) {
    console.error(flags.message);
    return flags.code;
  }
  if (values.version) {
    console.log(readPackageVersion(repoRootOf()));
    return 0;
  }

  const repoRoot = repoRootOf();

  if (values['set-version']) {
    const target = values['set-version'];
    if (!/^\d+\.\d+\.\d+$/.test(target)) {
      console.error(`invalid version: ${target}`);
      return 2;
    }
    const changed = applyVersion(repoRoot, target);
    mustRun('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: repoRoot });

    // Re-stamp the site's measured census (#1043, second drift level). The
    // version literals above are only half the problem: the "Measured in this
    // repository" block was typed once on 2026-08-03 and 5 of its 8 figures
    // were wrong twelve days later. Release time is the RIGHT moment and CI is
    // the wrong one — `sessions` and `learnings` grow on every session, so a
    // pipeline gate on them would be permanently red. The page discloses that
    // by stamping the date and SHA it was counted at, which this refreshes too.
    mustRun('node', ['scripts/site-numbers.mjs', '--write'], { cwd: repoRoot });

    console.log(`Rewrote ${changed.length} surface file(s) to ${target}:`);
    for (const f of changed) console.log(`  ${f}`);
    console.log('  package-lock.json (via npm install --package-lock-only)');
    console.log('  site/index.html cells + site/_census.json re-stamped (scripts/site-numbers.mjs --write) — commit BOTH');
    console.log('\nEditorial TODOs (enforced by --check):');
    console.log(`  1. CHANGELOG.md — write the "## [${target}] - YYYY-MM-DD" entry, fold [Unreleased].`);
    console.log('  2. README.md — rewrite the "Recent highlights" section content.');
    return 0;
  }

  if (values.check || values.publish) {
    const target = readPackageVersion(repoRoot);
    const checks = await preflight(repoRoot, target, { skipCi: values['skip-ci'] });
    const ok = printChecks(checks, values.json && !values.publish, target);
    if (!ok) return 1;
    if (!values.publish) return 0;

    console.log(`\nPublishing ${PACKAGE_NAME}@${target} ...`);
    publish(repoRoot, target);
    console.log(`  + ${PACKAGE_NAME}@${target} — registry verified.`);
    const { tag, pushed } = tagAndPush(repoRoot, target);
    console.log(`  tagged ${tag} (AFTER publish) and pushed main+tag to: ${pushed.join(', ')}.`);

    // GitHub release — after the tag is on the remote (so --verify-tag can do
    // its job), before the site poll. Not fatal on its own: npm and both tags
    // are already published at this point, and reporting a shipped release as a
    // crash would be a worse lie than reporting the one missing artefact.
    const release = ensureGithubRelease(repoRoot, target);
    if (release.ok) {
      console.log(`  ${release.detail}.`);
    } else {
      console.error(`\nFAIL: ${release.detail}`);
      console.error('  npm publish and both tag pushes SUCCEEDED — only the GitHub release is missing.');
      console.error(`  Recover with: gh release create ${tag} --verify-tag --title ${tag} --notes-file <changelog excerpt>`);
    }

    // The push to `github` above triggers the Vercel git integration, which
    // deploys site/ (see vercel.json `outputDirectory`). The deploy is async,
    // so poll rather than assume. This replaces the old manual checklist line
    // `cd site && vercel --prod` — a checklist line is not a mechanism, and it
    // was skipped twice in four weeks (#1043), leaving the live site a full
    // release behind while every other surface said otherwise.
    const live = await verifyLiveSite(target);
    if (!live.ok) {
      console.error(`\nFAIL: live site did not reach ${target}.`);
      console.error(`  ${live.detail}`);
      console.error('  npm and the tags ARE published — only the site lag remains.');
      console.error('  Check https://vercel.com/kanevrys-projects/session-orchestrator for the deploy.');
    } else {
      console.log(`  site live at ${target} (${live.detail}).`);
    }

    // Both post-publish steps report before either decides the exit code —
    // an operator who lost the GitHub release should still learn whether the
    // site deployed, and vice versa.
    if (!release.ok || !live.ok) return 1;

    console.log('\nPost-release checklist (manual):');
    console.log('  1. Rotate/delete the npm token: https://www.npmjs.com/settings/<user>/tokens');
    console.log('  2. pi.dev gallery indexes asynchronously — do not block on it.');
    return 0;
  }

  console.error('Nothing to do — pass --check, --publish, or --set-version X.Y.Z (see --help).');
  return 2;
}

function repoRootOf() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], SPAWN_OPTS);
  if (res.status !== 0) throw new Error('not inside a git repository');
  return res.stdout.trim();
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`release.mjs: ${err.message}`);
      process.exit(2);
    },
  );
}
