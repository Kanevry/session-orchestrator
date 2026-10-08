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
//                         on HEAD, leakage gate over retained archive filenames and contents.
//   --publish             Runs --check first, then token publish via temp
//                         userconfig (NPM_TOKEN from .env.local). A
//                         target-confirmed npm receipt is the irreversible
//                         boundary: before it, failure aborts normally; after it,
//                         never rerun --publish. The tail tags AFTER receipt
//                         (never before — eliminates "tagged but unpublished"),
//                         pushes main + tag to origin AND github, handles the
//                         GitHub release (`--verify-tag`), reconciles registry
//                         propagation, and polls the live site. A tag/push
//                         failure skips the tag-dependent GitHub-release and
//                         site phases and returns reconciliation guidance.
//                         After the receipt it writes the publish proof
//                         .orchestrator/runtime/release-<target>.json (#1537).
//   --reconcile           Read-only resume after an accepted upload: from the
//                         proof, verify the exact version is served as latest
//                         with the checked integrity, then that a consumer
//                         download hashes to it. Never publishes, tags or pushes.
//
// USAGE:
//   node scripts/release.mjs --check [--json] [--skip-ci]
//   node scripts/release.mjs --set-version 3.19.0
//   node scripts/release.mjs --publish [--json]
//   node scripts/release.mjs --reconcile [--target X.Y.Z] [--json]
//
// EXIT CODES:
//   0  success
//   1  preflight/check failure (stale surface, missing CHANGELOG entry,
//      tag/registry collision, mirror behind, dead token, CI not green,
//      leakage-gate hit) OR post-publish reconciliation required OR
//      --reconcile not yet installable (pending / failed / proof missing)
//   2  system/usage error before the npm receipt (git/npm spawn failure,
//      missing NPM_TOKEN, unknown flag, --skip-ci combined with --publish)
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
  mkdirSync,
  lstatSync,
} from 'node:fs';
import { join, relative as relativePath, sep, basename, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { packedFilename } from './lib/plugin-package-stage.mjs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveRepoSpec } from './lib/vcs-repo-spec.mjs';
import { enumerateRepoFiles } from './lib/validate/enumerate-repo-files.mjs';
import { writeJsonAtomicSync } from './lib/io.mjs';

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
    // Cursor's native manifest replaces the root Agent Plugins manifest so
    // Codex can load its own component paths and cache version independently.
    // It remains a required version surface for every release.
    file: '.cursor-plugin/plugin.json',
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
    // The German landing page (2026-09-07 redesign) mirrors the EN metric cells
    // one-to-one; same single writer (scripts/site-numbers.mjs --write), so it is
    // checkOnly for the same reason as site/index.html above.
    file: 'site/de/index.html',
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

// The leak checks operate only on paths extracted from real packed-entry lines,
// never on arbitrary `npm notice` prose. `tests` and `.claude` are exact path
// segments: nested copies leak too, while `contest` and `.claude-plugin` do not.
function hasPathSegment(path, segment) {
  return path.split('/').includes(segment);
}

export const LEAKAGE_PATTERNS = [
  { name: 'tests/', matches: (path) => hasPathSegment(path, 'tests') },
  // `.orchestrator/policy/` is CARVED OUT and everything else under
  // `.orchestrator/` still leaks: the destructive-guard FLOOR policy ships to npm
  // consumers since 4.0.0 (Codex P1 — measured: `npm pack` carried 0 policy
  // entries, so `loadEffectivePolicy` returned `rules:null` and the guard allowed
  // everything on a consumer install). The carve-out is a `policy/` PATH segment,
  // not a prefix: `.orchestrator/metrics/`, `.orchestrator/tmp/`,
  // `.orchestrator/runtime/`, `*.lock` and the `.orchestrator/policy-backup/`
  // prefix trick are all still caught.
  {
    name: '.orchestrator/',
    matches: (path) => /\.orchestrator\//.test(path) && !/^\.orchestrator\/policy\//.test(path),
  },
  { name: '.claude/', matches: (path) => hasPathSegment(path, '.claude') },
  { name: '.github/', matches: (path) => /\.github\//.test(path) },
  { name: 'node_modules', matches: (path) => /node_modules/.test(path) },
  { name: '.env', matches: (path) => /\.env/i.test(path) },
  { name: 'owner.yaml', matches: (path) => /owner\.yaml/i.test(path) },
  // Claimed as checked by docs/distribution/npm-publish-checklist.md long before
  // any code checked it (measured 2026-08-19: 3 leakage lists, 3 different sets).
  // `files` in package.json overrides .gitignore, so a stray .DS_Store inside a
  // shipped directory reaches the tarball.
  { name: '.DS_Store', matches: (path) => /\.DS_Store/.test(path) },
];

// Bootstrap's public Standard path copies each selected template in full, so
// these two sanity tests are intentional scaffold assets, not package-internal
// test material. This is exact by path and applies only to the `tests/` class:
// do not turn it into a templates/** or segment-level bypass.
const INTENTIONAL_TEST_ASSET_PATHS = new Set([
  'templates/node-minimal/tests/sanity.test.ts',
  'templates/python-uv/tests/test_sanity.py',
]);

// `skills/release/SKILL.md` quotes the `npm view` OUTPUT that proves the 3.18.0 gap,
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
// 4.0.1 (measured 2026-09-07): the 4.0.0 sweep would have flagged five files whose only literal
// is PROSE HISTORY of the major ("moved out of agents/ in 4.0.0", "removed in 4.0.0",
// "releases 4.0.0 would have blocked on itself") — CLAUDE.md, its generated twin AGENTS.md,
// CONTRIBUTING.md, NOTICE and .husky/pre-push. None of them is a version SURFACE (no
// `"version":`, badge or `vX.Y.Z` form), so they join the history allowlist rather than being
// reworded to dodge the sweep.
// Four more prose-history files surfaced once the detail line stopped truncating at five hits
// (same 2026-09-07 sweep): site/llms-full.txt ("The v4.0.0 release REMOVES public surfaces" — its
// version SURFACE is checked separately by the SURFACES row, so the sweep on it is redundant),
// skills/architecture/references/domain-model.md ("Merged here in v4.0.0"), skills/autopilot/SKILL.md
// ("4.0.0 — see docs/migration-v4.md"). A fifth, templates/_shared/journey-manifest.md ("Retired …
// in 4.0.0"), was DELETED on 2026-09-12 (replaced by ux-manifest.template.md, Epic #1322) and its
// allowlist entry went with it — re-add only if a file of that name returns.
// September 10 campaign snapshot: inputs and receipt reproduce the dated 4.3-planned
// render made while 4.2.0 was current. Exact files only; neighboring marketing
// remains checked. Do not bump receipt props without a newly reviewed render.
// `scripts/lib/locks/index.mjs` is the one-cycle deprecation shim (5.2.0 CHANGELOG, Changed): its
// runtime warning names the version it was deprecated IN, so it legitimately carries the previous
// release literal until its 6.0.0 removal — version history by construction, not drift.
// `skills/eval/rubric-v3.md` (5.9.0 sweep, measured 2026-10-06): its change log quotes the dated
// owner decision "rubric-v3 in 5.8.0" (2026-10-05, #1487) — the release that introduced the rubric.
// Prose history, not a version surface; bumping it would falsify the quote.
// `site/_census.json` is deliberately NOT allowlisted: it carries a `"version"` field that
// `--set-version` re-stamps (scripts/site-numbers.mjs --write, see the post-bump hint in main()),
// so leaving it under the drift sweep makes the sweep double as its staleness gate — a census
// not re-stamped after a bump fails `--check` instead of shipping the previous version.
export const HISTORY_ALLOWLIST = /^(CHANGELOG\.md|README\.md|scripts\/lib\/locks\/index\.mjs|CLAUDE\.md|AGENTS\.md|CONTRIBUTING\.md|NOTICE|\.husky\/pre-push|docs\/|tests\/|skills\/npm-publish\/|skills\/architecture\/references\/domain-model\.md|skills\/autopilot\/SKILL\.md|skills\/eval\/rubric-v3\.md|scripts\/release\.mjs|\.orchestrator\/|site\/leaderboard\.json|site\/guide\/index\.html|site\/llms-full\.txt|skills\/release\/SKILL\.md|marketing\/remotion\/(?:README\.md|campaign\.json|render-receipt\.json|src\/ReleaseFilm\.tsx)$)/;

/** Pure check over packed-entry lines. Returns violations: {name, line}[]. */
export function checkLeakage(lines) {
  const violations = [];
  for (const line of lines) {
    const entry = parsePackedEntry(line);
    if (!entry) continue;
    for (const { name, matches } of LEAKAGE_PATTERNS) {
      if (name === 'tests/' && INTENTIONAL_TEST_ASSET_PATHS.has(entry.path)) continue;
      if (matches(entry.path)) violations.push({ name, line: line.trim() });
    }
  }
  return violations;
}

/**
 * One packed tarball entry in `npm pack --dry-run` output:
 * `npm notice 1.3kB .claude-plugin/marketplace.json`.
 *
 * This grammar intentionally excludes npm's package metadata and summary
 * notices. Leakage decisions must be made over a file path, not a sentence
 * that happens to mention one.
 */
export const PACKED_ENTRY_RE = /^npm notice\s+(\d+(?:\.\d+)?\s*(?:B|kB|MB|GB))\s+(\S.*)$/;

/**
 * Parse an npm packed-entry notice into its path. Returns null for every other
 * npm notice line, including package metadata and summaries.
 *
 * @param {string} line
 * @returns {{path: string}|null}
 */
export function parsePackedEntry(line) {
  const match = line.match(PACKED_ENTRY_RE);
  return match ? { path: match[2].trim() } : null;
}

/**
 * Floor on parsed packed entries, below which the leak scan is presumed BLIND
 * rather than clean.
 *
 * Measured 2026-08-21 with `npm pack --dry-run`: npm's own summary reports
 * `total files: 805` and {@link PACKED_ENTRY_RE} independently counts 805 —
 * two differently-shaped measurements agreeing. Package size 2.9 MB, unpacked
 * 9.0 MB. The count dropped from 830 when `package.json` `files` gained
 * `!scripts/tests/**` and `!skills/vault-sync/tests/**`; those 28 entries were
 * shipped in 3.21.0 (scanned: no secrets, no owner data — ballast, not an
 * incident). Independently confirmable after the fact:
 * `npm view session-orchestrator@3.21.0 dist.fileCount` returns 832 — npm's own
 * count of what the registry accepted for THAT version, from outside this repo,
 * and therefore still the pre-exclusion number.
 *
 * (An earlier revision of this comment claimed the checklist "still records the
 * older ~750 files" baseline. It did not: commit a2e495c rewrote that line to
 * the measured 830/2.9/8.9 at the same SHA this comment was written. The claim
 * was a second copy of a fact, contradicting the first, inside the file that
 * argues against second copies. Caught by the post-publish review panel.)
 *
 * 400 is a FLOOR, not a pin — deliberately ~50% of today's count. It cannot
 * break on growth (the pack only grows), and it is far enough below 805 that a
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
 * A regex matching `literal` as a VERSION TOKEN, not as a substring.
 *
 * THE BUG (measured 2026-09-07, mid-release): the sweep matched the previous tag `4.0.0`
 * inside `>=24.0.0` — `package.json`'s own engines field and a `scripts/lib/` string that
 * quotes it — so a release could not be cut without either rewording an engines constraint or
 * widening the allowlist over two files that carry no version surface at all. The boundary is
 * therefore part of WHAT IS SWEPT FOR, not an allowlist row: `24.0.0`, `14.0.0` and `4.0.0.1`
 * are different literals, at every path, forever.
 *
 * @param {string} literal — the previous release version
 * @returns {RegExp} global regex; `4.0.0` matches only when not preceded by `[0-9.]` and not
 *   continued by a further numeric component (`(?!\.?[0-9])`).
 */
function versionTokenRegex(literal) {
  return new RegExp(`(?<![0-9.])${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\.?[0-9])`, 'g');
}

/**
 * Is EVERY token occurrence of `literal` on this line a dependency range (`^X.Y.Z` / `~X.Y.Z`)?
 *
 * One bare occurrence anywhere on the line is enough to call the whole line drift — a comment
 * that also happens to mention a ranged dep must not be excused by that mention. Occurrences are
 * counted with {@link versionTokenRegex}, so `>=24.0.0` is not an occurrence of `4.0.0` here
 * either — otherwise a line pinning `^4.0.0` beside an engines constraint would read as drift.
 *
 * @param {string} content — the matching line's text
 * @param {string} literal — the previous release version, matched as a token
 * @returns {boolean}
 */
export function isDependencyRangeOnly(content, literal) {
  const re = versionTokenRegex(literal);
  let seen = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    seen += 1;
    const before = m.index > 0 ? content[m.index - 1] : '';
    if (before !== '^' && before !== '~') return false;
  }
  return seen > 0;
}

/** Lockfiles whose dependency entries are third-party history, never our surface. */
const LOCKFILE_BASENAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

/** Code files in which a `//`, `*`, `/*` or `#` line is comment prose, never a version surface. */
const CODE_COMMENT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.sh']);

/** Workflow/CI files in which a SHA-pinned `uses:` carries a third-party version as a trailing comment. */
const YAML_EXTENSIONS = new Set(['.yml', '.yaml']);

/**
 * Is this YAML row a SHA-pinned THIRD-PARTY action whose version lives only in the
 * trailing comment?
 *
 * Measured on the 5.1.0 cut (2026-09-13): `.github/workflows/test.yml` carries
 * `uses: actions/setup-node@a0853c2…  # v5.0.0` twice. That `5.0.0` is setup-node's
 * version, not ours — the sweep matched it only because our previous release happened
 * to land on the same number, so the false positive is triggered by COINCIDENCE and
 * would reappear for any action whose pin equals our next version.
 *
 * Expressed as a PREDICATE, like the three classes above, for the reason
 * `.claude/rules/measurement-discipline.md` records: a per-path allowlist row fixes
 * this file and leaves the class open for the next workflow.
 *
 * Two conditions, both required, so the predicate cannot mask a stale surface of ours:
 *   1. the line pins a reference with `uses:` BEFORE the comment marker, and
 *   2. EVERY occurrence of the literal sits AFTER that marker.
 * A version in the pin itself (`uses: foo@v5.0.0`) fails condition 2 and is still swept.
 *
 * NAMED CEILING (BV-004): no SURFACES pattern targets a `.yml`/`.yaml` file today, so a
 * YAML hit is never our own surface anyway. Revisit trigger: the first version surface
 * added to a YAML file — then this predicate must also exclude that file's pattern.
 *
 * @param {string} content — the matching line's text
 * @param {string} literal — the previous release literal being swept for
 * @returns {boolean} true = third-party pin comment, skip the row
 */
export function isPinnedActionComment(content, literal) {
  const hash = content.indexOf('#');
  if (hash === -1) return false;
  if (!/\buses:\s*\S/.test(content.slice(0, hash))) return false;
  const re = versionTokenRegex(literal);
  let seen = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    seen += 1;
    if (m.index < hash) return false;
  }
  return seen > 0;
}

/**
 * Is this `path:line:content` row version HISTORY rather than a stale surface?
 *
 * Three classes, all measured on the 4.0.1 cut (2026-09-07) as FALSE POSITIVES of the raw
 * substring sweep, and all expressed as PREDICATES for the same reason the range carve-out
 * above is one: a per-path allowlist row fixes the instance and leaves the class open.
 *
 * 1. **Dependency range** — `^X.Y.Z` / `~X.Y.Z` (see {@link isDependencyRangeOnly}).
 * 2. **Lockfile dependency entry** — `package-lock.json` carried 72 hits for `4.0.0`, every one
 *    a third-party package version or an engines range. Our OWN entry there is still swept: the
 *    root package's `"version"` line, which npm writes in the `packages[""]` record at the top
 *    of the file. NAMED CEILING (BV-004): "at the top" is read as `line <= 20`, which covers
 *    every lockfileVersion-3 file npm writes today (the root record starts at line 5). Revisit
 *    trigger: a lockfile whose root `"version"` sits below line 20 — then key on the enclosing
 *    JSON path instead of the line number.
 * 3. **Comment prose in a code file** — `// (pre-4.0.0 checkouts, …)` and a `* since 4.0.0`
 *    docblock line. No SURFACES pattern is ever a comment (every one is `"version": "X.Y.Z"`,
 *    `vX.Y.Z` or a badge), so excusing comment lines cannot mask a stale surface.
 *
 * @param {string} file — repo-relative path
 * @param {number} line — 1-based line number
 * @param {string} content — the matching line's text
 * @param {string} prevTag — the previous release literal being swept for
 * @returns {boolean} true = history, skip the row
 */
function isHistoryRow(file, line, content, prevTag) {
  if (!versionTokenRegex(prevTag).test(content)) return true;
  if (isDependencyRangeOnly(content, prevTag)) return true;
  const base = file.split('/').pop();
  if (LOCKFILE_BASENAMES.has(base)) {
    const isRootVersionLine = line <= 20 && new RegExp(`"version":\\s*"${prevTag.replace(/\./g, '\\.')}"`).test(content);
    return !isRootVersionLine;
  }
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot);
  if (YAML_EXTENSIONS.has(ext) && isPinnedActionComment(content, prevTag)) return true;
  if (CODE_COMMENT_EXTENSIONS.has(ext)) {
    const trimmed = content.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return true;
    if (ext === '.sh' && trimmed.startsWith('#')) return true;
  }
  return false;
}

/**
 * Drift sweep verdict over a grep-shaped result (`-l` file list or `-n` line hits).
 *
 * Exit-code contract, kept identical to `git grep`'s because that is what this
 * evaluator was written against and what {@link collectDriftHits} now emits:
 * 0 = matches found, 1 = no match (the success case here), anything else = it
 * did not run. Measured on git 2.x: a bad regex and a bad pathspec both exit
 * 128; git also documents 2 for usage errors. The old inline code read
 * `.stdout` without ever looking at `.status`, so BOTH the no-match case and
 * the it-crashed case produced an empty hit list and the same reassuring
 * detail line, "no file still carries X". A sweep that never ran is not a
 * clean sweep.
 *
 * ONE CLASS OF MATCH IS NOT OURS TO BUMP: a dependency RANGE that happens to equal our own
 * previous version. `skills/vault-sync` pins `zod` at `^3.24.0` (the projects-baseline pin), so
 * the 4.0.0 sweep collected two files whose literal belongs to zod and must NOT move when we
 * release. The carve-out is deliberately a PREDICATE and not two allowlist rows: a per-path row
 * fixes this instance and leaves the class open for the next dependency that lands on our version
 * number — the unenumerable-table failure `.claude/rules/measurement-discipline.md` records. A
 * caret- or tilde-prefixed literal is a range, and no version surface of this package is ever
 * written as one (see SURFACES above: every pattern is an exact `"version": "X.Y.Z"`, `vX.Y.Z`
 * or badge form), so the predicate cannot mask a stale surface.
 *
 * THREE FURTHER CLASSES are history for the same reason, all measured 2026-09-07 mid-release
 * and all decided by {@link isHistoryRow}, never by an allowlist row: a literal that is only a
 * SUBSTRING of a longer version (`4.0.0` inside `>=24.0.0`), a `package-lock.json` /
 * `npm-shrinkwrap.json` row that is not the root package's own `"version"` line (72 of the 72
 * lockfile hits on that cut were third-party), and COMMENT PROSE in a code file
 * (`// (pre-4.0.0 checkouts, …)`). See that function for each one's ceiling.
 *
 * Accepts BOTH `git grep` output shapes. A bare `path` (from `-l`) carries no content and is
 * therefore always a hit — the fail-closed reading, unchanged, and the shape {@link collectDriftHits}
 * emits for a file it could not READ. `path:line:content` (from `-n`)
 * is judged per line, and the file counts as drift as soon as ONE matching line is not a range.
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
      detail: `drift sweep did not run (exit ${grep.status}): ${(grep.stderr || '').trim().slice(0, 200)} — sweep for ${prevTag} is inconclusive`,
    };
  }
  const hits = [];
  for (const row of (grep.stdout || '').split('\n').filter(Boolean)) {
    const withContent = row.match(/^(.+?):(\d+):(.*)$/);
    const file = withContent ? withContent[1] : row;
    if (allowlist.test(file)) continue;
    if (withContent && isHistoryRow(file, Number(withContent[2]), withContent[3], prevTag)) continue;
    if (!hits.includes(file)) hits.push(file);
  }
  return {
    ok: hits.length === 0,
    detail: hits.length
      ? `still carry ${prevTag} (${hits.length} file(s)): ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}`
      : `no file outside the allowlist still carries ${prevTag} (tracked + untracked-not-ignored)`,
  };
}

/**
 * Bytes of a file inspected when deciding whether it is binary.
 *
 * A NUL byte in the first 8 KB is the same heuristic `git grep`/`grep` use to
 * declare a file binary. NAMED CEILING (BV-004): a text file whose only NUL
 * sits past 8 KB is scanned as text (harmless — it produces no version match),
 * and a binary whose first 8 KB happen to be NUL-free is scanned as text and
 * may emit mojibake rows. Revisit trigger: the first drift-sweep row naming a
 * file nobody recognises as text.
 */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Produce the drift-sweep hit list over the files that EXIST in the working
 * tree — tracked or not — in the exact `{status, stdout, stderr}` shape
 * {@link evaluateDriftSweep} already consumes.
 *
 * ## Why not `git grep` any more (#1248)
 *
 * `git grep` searches the INDEX: it is blind to an untracked file, so the
 * moment a stale version literal is most likely to exist (a doc or manifest
 * written for this release and not yet staged) is exactly the moment the sweep
 * cannot see it and reports clean. The population is now
 * `scripts/lib/validate/enumerate-repo-files.mjs`
 * (`git ls-files --cached --others --exclude-standard`) — tracked PLUS
 * untracked, minus everything `.gitignore` excludes, so `node_modules/` and
 * the peer worktrees under `.claude/worktrees/` stay out without a prune list
 * having to guess at them.
 *
 * What `git grep` bought — searching hidden directories a plain `rg` skips,
 * which is how the forgotten `.codex-plugin` manifest was found — is kept:
 * `git ls-files` lists dotted paths like any other.
 *
 * ## Fail-closed, in two places
 *
 * Enumeration itself throwing is reported as exit 128, which
 * {@link evaluateDriftSweep} reads as "inconclusive" = FAIL — the same reading
 * a crashed `git grep` got. A single file that enumerates but cannot be READ
 * is emitted as a CONTENT-LESS row, which that evaluator already treats as a
 * hit: a file we could not sweep is never silently a clean file.
 *
 * @param {object} options
 * @param {string} options.repoRoot absolute repository root
 * @param {string} options.prevTag the previous release literal to sweep for
 * @param {(o: {repoRoot: string}) => string[]} [options.enumerate] injection seam for tests
 * @param {(absolute: string) => Buffer} [options.read] injection seam for tests
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function collectDriftHits({ repoRoot, prevTag, enumerate = enumerateRepoFiles, read = readFileSync }) {
  let files;
  try {
    files = enumerate({ repoRoot });
  } catch (err) {
    return { status: 128, stdout: '', stderr: `enumerateRepoFiles failed: ${err && err.message}` };
  }
  const rows = [];
  for (const absolute of files) {
    const relative = relativePath(repoRoot, absolute).split(sep).join('/');
    let buf;
    try {
      buf = read(absolute);
    } catch {
      // Content-less row = hit (see the evaluator's contract above).
      rows.push(relative);
      continue;
    }
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    const text = buf.toString('utf8');
    if (!text.includes(prevTag)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(prevTag)) rows.push(`${relative}:${i + 1}:${lines[i]}`);
    }
  }
  return { status: rows.length ? 0 : 1, stdout: rows.length ? `${rows.join('\n')}\n` : '', stderr: '' };
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
  const entries = lines.filter(parsePackedEntry).length;
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

/** Strict npm 11/12 inventory, preserving the existing filename policy/floor. */
export function evaluatePackedInventory(pack, { minEntries = MIN_PACKED_ENTRIES } = {}) {
  if (pack.status !== 0) return { ok: false, detail: 'npm pack failed' };
  try {
    const json = JSON.parse(pack.stdout);
    const records = Array.isArray(json) ? json : json && typeof json === 'object' ? Object.values(json) : [];
    if (records.length !== 1) throw new Error('inventory-shape');
    const record = records[0];
    const filename = packedFilename([record]);
    if (!filename || basename(filename) !== filename || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(filename)) throw new Error('archive-name');
    if (!Array.isArray(record.files) || record.files.length > 20000 || record.files.length < minEntries) throw new Error('inventory-floor');
    const paths = record.files.map((entry) => entry?.path);
    if (paths.some((name) => typeof name !== 'string' || !name || name.length > 4096 || isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..') || (name.includes('\\') || [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) || new Set(paths).size !== paths.length) throw new Error('inventory-path');
    const violations = checkLeakage(paths.map((name) => `npm notice 1B ${name}`));
    if (violations.length) return { ok: false, detail: 'forbidden packed filename class: ' + [...new Set(violations.map((v) => v.name))].join(', ') };
    return { ok: true, detail: `${paths.length} packed entries, 0 filename leaks`, record, filename, paths };
  } catch { return { ok: false, detail: 'invalid packed inventory or insufficient entry count' }; }
}

function archiveDigest(tarballPath) {
  if (!lstatSync(tarballPath).isFile()) throw new Error('checked archive is not a regular file');
  return createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
}

/**
 * npm's Subresource-Integrity form of an archive (`sha512-<base64>`), the exact
 * shape npm serves as `dist.integrity` — so the checked bytes can later be
 * compared with what the registry and a consumer download actually carry.
 *
 * @param {string} tarballPath
 * @returns {string}
 */
export function archiveIntegrity(tarballPath) {
  if (!lstatSync(tarballPath).isFile()) throw new Error('archive is not a regular file');
  return `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
}

/**
 * Scan extracted archive bytes, retain that archive for the callback, and always
 * clean up. Command/scan failures never call the publication callback. The
 * 20,000-entry inventory ceiling matches the scanner; revisit for larger packs.
 */
export async function withCheckedPackage(repoRoot, callback, {
  runImpl = run, env = process.env, minEntries = MIN_PACKED_ENTRIES, cleanupImpl = rmSync,
} = {}) {
  const work = mkdtempSync(join(tmpdir(), 'so-release-pack-'));
  try {
    let artifact;
    let detail;
    try {
      const opts = { cwd: repoRoot, env: { ...env, npm_config_loglevel: 'notice' }, timeout: 60000 };
      const pack = runImpl('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], opts);
      const inventory = evaluatePackedInventory(pack, { minEntries });
      if (!inventory.ok) return inventory;
      const tarballPath = join(work, inventory.filename);
      const digest = archiveDigest(tarballPath);
      // Refuse links/special members BEFORE extraction and check the file census.
      const members = runImpl('tar', ['-tzf', tarballPath], opts);
      const types = runImpl('tar', ['-tvzf', tarballPath], opts);
      if (members.status !== 0 || types.status !== 0 || types.stdout.trim().split('\n').some((line) => !/^[-d]/.test(line))) throw new Error('archive-list');
      const names = members.stdout.trim().split('\n');
      const files = names.filter((name) => !name.endsWith('/'));
      const expected = new Set(inventory.paths.map((name) => `package/${name}`));
      if (names.some((name) => !name.startsWith('package/') || name.split('/').some((part) => part === '..' || part === '.')) || files.length !== expected.size || new Set(files).size !== files.length || files.some((name) => !expected.has(name))) throw new Error('archive-census');
      const unpacked = join(work, 'unpacked');
      mkdirSync(unpacked);
      const extracted = runImpl('tar', ['-xzf', tarballPath, '-C', unpacked], opts);
      if (extracted.status !== 0) throw new Error('archive-extraction');
      const inventoryPath = join(work, 'inventory.json');
      writeFileSync(inventoryPath, JSON.stringify([inventory.record]), { mode: 0o600 });
      const scanner = fileURLToPath(new URL('./lib/validate/check-owner-leakage.mjs', import.meta.url));
      const scan = runImpl(process.execPath, [scanner, join(unpacked, 'package'), '--require-owner-patterns', '--packed-files', inventoryPath], opts);
      const summaries = [...(scan.stdout || '').matchAll(/^Results: (\d+) passed, (\d+) failed \((\d+) scanned files\)$/gm)];
      if (scan.status !== 0 || summaries.length !== 1 || Number(summaries[0][1]) < 1 || Number(summaries[0][2]) !== 0 || Number(summaries[0][3]) !== inventory.paths.length) return { ok: false, detail: 'required owner policy / packed content scan failed or incomplete' };
      if (archiveDigest(tarballPath) !== digest) throw new Error('archive-changed');
      chmodSync(tarballPath, 0o400);
      artifact = { tarballPath, digest, integrity: archiveIntegrity(tarballPath) };
      detail = `${inventory.paths.length} packed files, filenames and contents verified`;
    } catch { return { ok: false, detail: 'packed archive preparation or content verification failed' }; }
    return { ok: true, detail, value: await callback(artifact) };
  } finally {
    // Cleanup must never replace an irreversible receipt or the original error.
    try { cleanupImpl(work, { recursive: true, force: true }); }
    catch { console.error('release: temporary package cleanup failed; release outcome unchanged'); }
  }
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
 * Turn a `checkCiStatus` result into the `ci-green-on-head` preflight row.
 *
 * Three input states since #1031, and the middle one is why this is a named
 * function rather than a ternary: `degraded` means the check could NOT be READ.
 * Interpolating `ci.status` there printed `status: undefined` — a red row whose
 * detail names no cause, which reads as "CI is broken" when the truth is "we
 * never found out". Only an actual `status: 'green'` reading passes; a release
 * must never proceed on an unknown CI state.
 *
 * The row also carries the CAUSE the probe already knows, because the three
 * ways this row goes red are indistinguishable without it (#1384 P5): a short
 * `sha`, a commit the mirror has never seen, and a HEAD with no pipeline all
 * printed `CI status unknown (query-failed)` / `status: unknown`. The probe's
 * `detail` (degraded branch, `degradedResult`) and `details.reason` /
 * `failingJobName` (read branch, `sanitizeApiText`) are clamped and
 * control-byte-escaped AT THEIR GENERATION in `ci-status-banner.mjs` —
 * appended here, never re-formatted. That escaping is load-bearing, not
 * hygiene: the read branch interpolates a RAW API `status` value into
 * `reason`, and until #1384 f-4 a status carrying `\r` + an ANSI sequence
 * could repaint THIS row green while its verdict stayed `ok:false`. Do not
 * append a further probe field here without checking it goes through one of
 * those two. With neither present the text is byte-identical to
 * before, so a plain green or a named failing job reads exactly as it did.
 *
 * @param {null | {status?: string, failingJobName?: string, degraded?: string,
 *   detail?: string, details?: {reason?: string}}} ci
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateCiRow(ci) {
  if (ci === null || ci === undefined) return { ok: false, detail: 'CI status unavailable' };
  if (ci.degraded) {
    const why = ci.detail ? `: ${ci.detail}` : '';
    return { ok: false, detail: `CI status unknown (${ci.degraded}${why})` };
  }
  // A failing job NAMES the failure, so it wins over the generic reason;
  // `reason` is what fills the gap when there is no job to name (`unknown`).
  const reason = ci.failingJobName || ci.details?.reason || '';
  const why = reason ? ` (${reason})` : '';
  return { ok: ci.status === 'green', detail: `status: ${ci.status}${why}` };
}

/**
 * Turn the GitHub-mirror CI reading into the `ci-green-on-head-github` row.
 *
 * WHY A SECOND CI ROW AT ALL: `ci-green-on-head` reads whatever platform
 * `detectVcsFamily` picks for `origin` — GitLab here — and the GitLab pipeline
 * runs Linux only. The **macOS** matrix leg exists solely on the GitHub mirror
 * (`.github/workflows/test.yml`), i.e. on the operator's own platform. A
 * release could therefore go out fully green with the macOS leg red, and the
 * release path would never have asked.
 *
 * SELF-DISABLING, and that is the one place this row is allowed to pass without
 * evidence: a checkout with no `github` remote has no mirror to be red, so the
 * row is `skipped` rather than red. Everything else keeps the three-state
 * contract of `evaluateCiRow` unchanged — `unknown` and `degraded` FAIL, because
 * "we could not read the mirror" is not "the mirror is green" (the fail-closed
 * house rule at the top of this file).
 *
 * This function only judges the `ci` reading it is handed — it is
 * `evaluateCiPreflightRows` (the caller, see its own docblock) that fetches
 * `ci` for the commit actually being released, rather than whichever HEAD the
 * GitHub mirror itself reports.
 *
 * @param {string|undefined} repoSpec — `resolveRepoSpec({vcs:'github'})`, undefined when no github remote resolves
 * @param {null | {status?: string, failingJobName?: string, degraded?: string}} ci
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateGithubCiRow(repoSpec, ci) {
  if (!repoSpec) return { ok: true, detail: 'skipped — no github remote' };
  const row = evaluateCiRow(ci);
  return { ok: row.ok, detail: `${repoSpec} — ${row.detail}` };
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
  // --reconcile is the read-only resume path after an accepted upload (#1537).
  // Combining it with a mode that writes would blur exactly the separation it
  // exists for, so every combination is a usage error rather than a precedence rule.
  if (values.reconcile && (values.publish || values.check || values['set-version'] || values['skip-ci'])) {
    return {
      ok: false,
      code: 2,
      message: '--reconcile cannot be combined with --publish, --check, --set-version or --skip-ci: it only verifies an already accepted upload.',
    };
  }
  if (values.target !== undefined && !values.reconcile) {
    return { ok: false, code: 2, message: '--target is only valid with --reconcile.' };
  }
  if (values.target !== undefined && !/^\d+\.\d+\.\d+$/.test(values.target)) {
    return { ok: false, code: 2, message: `invalid --target: ${values.target} (expected X.Y.Z)` };
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

/**
 * Both CI preflight rows (`ci-green-on-head` + `ci-green-on-head-github`) for
 * ONE commit — the commit actually about to be released — never whichever
 * HEAD the queried platform happens to report.
 *
 * Before this function existed, neither `checkCiStatus` call below passed
 * `sha`, so the GitHub branch fell back to `commits/HEAD` — the MIRROR's own
 * default-branch head, which is the release commit only once `head-pushed-github`
 * has ALREADY proven `github/main == local HEAD`. A release cut before that
 * push landed asked GitHub about a commit that was never pushed and could read
 * green for work GitHub has not seen at all (measured 2026-09-16 for
 * `3ebf0e9d`). The GitLab branch was already correct by default (`deps.sha ??
 * getHeadSha(repoRoot)`), so only the two call sites below needed the fix —
 * see `checkCiStatus`'s own docblock in `ci-status-banner.mjs` for the `sha`
 * contract (#1332).
 *
 * Factored out of `preflight()` as its own async, DI-testable unit:
 * `checkCiStatus` reaches the network by default, and `preflight()`'s
 * surrounding checks (git, npm) are not test-doubled, so this is the seam
 * through which the `sha` wiring can be unit-tested without spinning up a
 * full fixture release.
 *
 * @param {string} repoRoot
 * @param {string} head - full hex commit id of the commit being released (the
 *   local HEAD `preflight()` already computed for the remote-parity rows).
 * @param {{
 *   skipCi?: boolean,
 *   checkCiStatus?: Function,
 *   resolveRepoSpec?: (opts: { repoRoot: string, vcs: 'github' }) => string|undefined,
 * }} [deps]
 * @returns {Promise<{ gitlab: {ok: boolean, detail: string}, github: {ok: boolean, detail: string} }>}
 */
export async function evaluateCiPreflightRows(repoRoot, head, {
  skipCi = false,
  checkCiStatus: checkCiStatusDep,
  resolveRepoSpec: resolveRepoSpecDep = resolveRepoSpec,
} = {}) {
  if (skipCi) {
    const skipped = { ok: true, detail: 'SKIPPED via --skip-ci' };
    return { gitlab: skipped, github: skipped };
  }
  const checkCiStatusImpl = checkCiStatusDep ?? (await import('./lib/ci-status-banner.mjs')).checkCiStatus;

  const ci = await checkCiStatusImpl({ repoRoot, timeoutMs: 15000, sha: head });
  const gitlab = evaluateCiRow(ci);

  const githubSpec = resolveRepoSpecDep({ repoRoot, vcs: 'github' });
  let githubCi = null;
  if (githubSpec) {
    githubCi = await checkCiStatusImpl({ repoRoot, vcs: 'github', timeoutMs: 15000, sha: head });
  }
  const github = evaluateGithubCiRow(githubSpec, githubCi);

  return { gitlab, github };
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
  // below. A third subprocess shares the shape — the `git ls-remote --tags`
  // collision probe further down reads an empty stdout as "no collision" — but
  // that one guards it with an explicit `ls.status === 0`, so it is not
  // fail-open. Emptiness-means-all-clear is the shape to look for; reading the
  // status is what makes it safe. (Census: 14 `run(` call sites in this file.
  // It does NOT cover the raw `spawnSync` calls — a payload-keyed census misses
  // the consumer that uses a different channel, which is how the unchecked
  // propagation wait stayed invisible to it.)
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

  // 3b. Drift sweep: no file outside the surfaces table + allowlist may still
  // carry the previous release's version literal.
  //
  // POPULATION (#1248, closed here): this used to be one `git grep`, which
  // searches the INDEX and is therefore blind to UNTRACKED files — the sweep
  // measured "no TRACKED file still carries X" while its row read as a
  // whole-tree census. It now enumerates via
  // `scripts/lib/validate/enumerate-repo-files.mjs` (tracked PLUS
  // untracked-not-ignored) and greps in-process; see {@link collectDriftHits}
  // for the fail-closed contract and why hidden directories (the forgotten
  // .codex-plugin manifest) are still covered. Allowlisted: files that
  // legitimately carry version HISTORY.
  const tagList = run('git', ['tag', '-l', 'v*', '--sort=-v:refname'], { cwd: repoRoot });
  const prevTag = (tagList.stdout || '')
    .split('\n').map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t) && t !== target)[0];
  if (tagList.status !== 0) {
    // "No previous tag" and "could not list tags" are different facts, and only
    // one of them means the sweep is unnecessary.
    add('drift-sweep', false, `git tag -l failed (exit ${tagList.status}) — cannot determine the previous release to sweep for`);
  } else if (prevTag) {
    // Line-shaped rows (not a bare file list): the verdict needs the matching LINE, because a
    // caret-ranged dependency that equals our previous version is not drift and a file list
    // cannot show that.
    const hits = collectDriftHits({ repoRoot, prevTag });
    const sweep = evaluateDriftSweep(hits, prevTag, HISTORY_ALLOWLIST);
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

  // 6/6b. CI green on HEAD, both platforms — judged for the commit actually
  // being released, never whichever HEAD the queried platform reports (see
  // evaluateCiPreflightRows's docblock for the `sha`-wiring history, #1332).
  //
  // GitLab: the repo's iron session-start rule applies to releases doubly —
  // local green is not evidence — see .claude/rules. GitHub: this second row
  // exists because `detectVcsFamily` picks `origin` (GitLab) for the row
  // above, whose pipeline is Linux-only; the macOS matrix leg lives
  // exclusively in `.github/workflows/test.yml`. `vcs: 'github'` forces the
  // probe onto the mirror without touching the detection order.
  // SELF-DISABLING: a checkout with no `github` remote has no mirror to be
  // red, so `evaluateGithubCiRow` reports `skipped` rather than red — see its
  // own docblock. --skip-ci is refused under --publish upstream in
  // validateFlags(); it can only reach this branch from --check.
  const ciRows = await evaluateCiPreflightRows(repoRoot, head, { skipCi });
  add('ci-green-on-head', ciRows.gitlab.ok, ciRows.gitlab.detail);
  add('ci-green-on-head-github', ciRows.github.ok, ciRows.github.detail);

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
    // NEVER let cleanup decide the release outcome. This finally runs AFTER
    // `npm publish` has already published and BEFORE the caller evaluates the
    // receipt, so a throwing rmSync (EPERM/EBUSY -- `force` only swallows
    // ENOENT) surfaced as a pre-receipt system failure: published, untagged,
    // unpushed, and reported as "safe to re-run". That is the #1088 F1 shape at
    // its last remaining site. A surviving 0600 token file is a hygiene problem,
    // so it is announced rather than swallowed.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(
        `WARN: could not remove temporary npm userconfig ${tmpDir} (${err?.message ?? err}). ` +
          `It contains a write token — delete it and rotate the token.\n`,
      );
    }
  }
}

/**
 * Evaluate npm publish output for the receipt that makes the release immutable.
 * A successful process alone is insufficient: the receipt must name this package
 * and this exact target version.
 *
 * @param {{status: number|null, stdout?: string, stderr?: string}} result
 * @param {string} target
 * @returns {{confirmed: boolean, target: string, detail: string}}
 */
export function evaluatePublishReceipt(result, target) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const receipt = new RegExp(`(?:^|\\n)\\+ ${PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r?$|\\s)`);
  const confirmed = result.status === 0 && receipt.test(output);
  return {
    confirmed,
    target,
    detail: confirmed
      ? `${PACKAGE_NAME}@${target} receipt confirmed`
      : `npm publish did not emit a target-confirmed receipt for ${PACKAGE_NAME}@${target} (exit ${result.status})`,
  };
}

/**
 * Poll the registry after npm has issued a target-confirmed receipt. Every
 * failure remains visible, but none invalidates the already irreversible npm
 * publish; callers must reconcile rather than retry `--publish`.
 *
 * `npm view <pkg> version` resolves the `latest` dist-tag (and `npm view` fetches
 * with `preferOnline`, so no local cache masks the answer): the poll returns
 * `verified` on the first attempt whose `dist-tags.latest` equals `target`.
 * Default budget: 12 attempts, 15 s apart = 165 s between the first and last
 * poll. npm's registry needs ~2 min to serve a fresh `latest` (#1440 C2); the
 * previous 5 x 3 s = 12 s budget reported `timeout` on every real publish.
 *
 * @param {string} repoRoot
 * @param {string} target
 * @param {{attempts?: number, delaySeconds?: number, runImpl?: Function, waitImpl?: Function}} [deps]
 * @returns {{ok: boolean, kind: 'verified'|'timeout'|'query-failed'|'wait-failed', attempts: number, detail: string}}
 */
export function waitForRegistryPropagation(repoRoot, target, deps = {}) {
  const attempts = deps.attempts ?? 12;
  const delaySeconds = deps.delaySeconds ?? 15;
  const runImpl = deps.runImpl ?? run;
  const waitImpl = deps.waitImpl ?? (() => runImpl('sleep', [String(delaySeconds)], { cwd: repoRoot }));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let view;
    try {
      view = runImpl('npm', ['view', PACKAGE_NAME, 'version'], { cwd: repoRoot });
    } catch (err) {
      return {
        ok: false,
        kind: 'query-failed',
        attempts: attempt,
        detail: `registry query failed on attempt ${attempt}/${attempts}: ${err.message}`,
      };
    }
    if (view.status === 0 && (view.stdout || '').trim() === target) {
      return {
        ok: true,
        kind: 'verified',
        attempts: attempt,
        detail: `registry reports ${target} on attempt ${attempt}/${attempts}`,
      };
    }
    if (view.status !== 0) {
      return {
        ok: false,
        kind: 'query-failed',
        attempts: attempt,
        detail: `registry query failed on attempt ${attempt}/${attempts} (exit ${view.status}): ${(view.stderr || view.stdout || '').trim().slice(0, 300)}`,
      };
    }
    if (attempt < attempts) {
      let wait;
      try {
        wait = waitImpl({ attempt, delaySeconds });
      } catch (err) {
        return {
          ok: false,
          kind: 'wait-failed',
          attempts: attempt,
          detail: `registry propagation wait failed after attempt ${attempt}/${attempts}: ${err.message}`,
        };
      }
      if (!wait || wait.status !== 0 || wait.error) {
        return {
          ok: false,
          kind: 'wait-failed',
          attempts: attempt,
          detail: `registry propagation wait failed after attempt ${attempt}/${attempts} (exit ${wait?.status ?? 'unknown'}): ${(wait?.error?.message || wait?.stderr || wait?.stdout || '').trim().slice(0, 300)}`,
        };
      }
    }
  }
  return {
    ok: false,
    kind: 'timeout',
    attempts,
    detail: `registry did not report ${target} after ${attempts} attempts`,
  };
}

// ---------------------------------------------------------------------------
// Accepted -> available -> installable (#1537).
//
// npm's PUT answers HTTP 202 and the CLI prints the target receipt BEFORE the
// version is publicly served: publish-time scanning runs asynchronously and can
// hold a version for far longer than any in-process poll should wait (5.10.0
// stayed 404 for more than 25 minutes after its receipt). So the receipt is
// persisted as a proof file, and `--reconcile` resumes the verification later
// from that proof alone. That path is structurally separate from publishing: it
// never reaches publish(), tagAndPush(), a push, or an `npm pack` of the repo.
// ---------------------------------------------------------------------------

const RELEASE_PROOF_DIR = join('.orchestrator', 'runtime');
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** Path of the persisted publish proof for `target` (gitignored runtime dir). */
export function releaseProofPath(repoRoot, target) {
  return join(repoRoot, RELEASE_PROOF_DIR, `release-${target}.json`);
}

/**
 * The evidence `--reconcile` needs to verify an accepted upload later without
 * the original archive: which bytes were checked (sha256 + npm-style sha512
 * integrity), when npm issued the receipt, and which commit/tag they belong to.
 *
 * @param {{target: string, artifact: {digest: string, integrity: string}, commit: string|null, receiptAt: string}} input
 */
export function buildReleaseProof({ target, artifact, commit, receiptAt }) {
  return {
    schema: 1,
    package: PACKAGE_NAME,
    target,
    tag: `v${target}`,
    commit: commit || null,
    receiptAt,
    sha256: artifact.digest,
    integrity: artifact.integrity,
  };
}

/**
 * Persist the proof atomically. Never throws: it runs after the irreversible
 * receipt, where a write failure must be reported, not turned into a pre-receipt
 * style abort.
 *
 * @returns {{ok: boolean, path: string, detail: string}}
 */
export function writeReleaseProof(repoRoot, proof, { writeImpl = writeJsonAtomicSync } = {}) {
  const path = releaseProofPath(repoRoot, proof.target);
  try {
    const res = writeImpl(path, proof, { tmpPrefix: '.release-proof' });
    if (res?.ok) return { ok: true, path, detail: `publish proof written to ${relativePath(repoRoot, path)}` };
    return { ok: false, path, detail: `publish proof NOT written (${res?.error ?? 'unknown error'})` };
  } catch (err) {
    return { ok: false, path, detail: `publish proof NOT written (${err?.message ?? err})` };
  }
}

/**
 * Read and validate the proof for `target`. A missing or malformed proof is a
 * refusal — success is never derived from `latest` alone.
 *
 * @returns {{ok: true, proof: object, path: string} | {ok: false, path: string, detail: string}}
 */
export function readReleaseProof(repoRoot, target, { readImpl = readFileSync } = {}) {
  const path = releaseProofPath(repoRoot, target);
  let proof;
  try {
    proof = JSON.parse(readImpl(path, 'utf8'));
  } catch (err) {
    const missing = err?.code === 'ENOENT';
    return { ok: false, path, detail: missing ? `proof missing: ${relativePath(repoRoot, path)} does not exist` : `proof unreadable: ${err?.message ?? err}` };
  }
  if (!proof || typeof proof !== 'object' || proof.package !== PACKAGE_NAME || proof.target !== target || !INTEGRITY_RE.test(proof.integrity ?? '') || !/^[0-9a-f]{64}$/.test(proof.sha256 ?? '')) {
    return { ok: false, path, detail: `proof invalid: ${relativePath(repoRoot, path)} does not describe ${PACKAGE_NAME}@${target} with sha256 + sha512 integrity` };
  }
  return { ok: true, proof, path };
}

/**
 * Judge one `npm view <pkg>@<target> --json` answer against the proof.
 * A 404 is `pending` — never read as "held" or "blocked": the package token
 * cannot see npm's internal scan state, so a 404 alone carries no diagnosis.
 *
 * `superseded` = exact version + integrity served, but `latest` already points
 * at a semver-greater release.
 *
 * @returns {{state: 'available'|'superseded'|'pending'|'failed', reason: string, detail: string}}
 */
export function evaluateRegistryManifest(view, target, proof) {
  const raw = (view?.stdout || '').trim();
  let json;
  try { json = raw ? JSON.parse(raw) : null; } catch { json = undefined; }
  if (view?.status !== 0) {
    if (json?.error?.code === 'E404' || /\bE404\b/.test(`${view?.stderr || ''}`)) {
      return { state: 'pending', reason: 'not-visible', detail: `registry answers 404 for ${PACKAGE_NAME}@${target} — not yet publicly served; a 404 alone is not evidence of a hold or block` };
    }
    return { state: 'pending', reason: 'query-failed', detail: `npm view exited ${view?.status}: ${(json?.error?.summary || view?.stderr || raw).trim().slice(0, 300)}` };
  }
  if (json === null) return { state: 'pending', reason: 'not-visible', detail: `registry returned no manifest for ${PACKAGE_NAME}@${target}` };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { state: 'pending', reason: 'unparseable', detail: 'npm view output is not a single manifest object' };
  if (json.version !== target) return { state: 'pending', reason: 'not-visible', detail: `registry manifest reports version ${json.version ?? 'none'}, not ${target}` };
  const integrity = json.dist?.integrity;
  if (!integrity) return { state: 'pending', reason: 'integrity-missing', detail: 'registry manifest carries no dist.integrity yet' };
  if (integrity !== proof.integrity) {
    return { state: 'failed', reason: 'integrity-mismatch', detail: `registry dist.integrity ${integrity} differs from the checked archive ${proof.integrity}` };
  }
  const latest = json['dist-tags']?.latest;
  if (latest !== target) {
    // A later release can only have been published after this one was
    // accepted, so `latest` will never come back to the target. Keeping that
    // `pending` forever would be a standing false alarm; the exact version and
    // its bytes are still verified (here, and by the download that follows).
    if (isNewerRelease(latest, target)) {
      return { state: 'superseded', reason: 'superseded', detail: `registry serves ${target} with the checked integrity; dist-tags.latest is already the later ${latest}` };
    }
    return { state: 'pending', reason: 'latest-not-target', detail: `dist-tags.latest is ${latest ?? 'unset'}, not ${target}` };
  }
  return { state: 'available', reason: 'available', detail: `registry serves ${target} as latest with the checked integrity` };
}

/** True when `candidate` is a plain X.Y.Z strictly greater than `target`; prereleases never count. */
function isNewerRelease(candidate, target) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? '') ? v.split('.').map(Number) : null);
  const a = parse(candidate);
  const b = parse(target);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * Download the published tarball the way a consumer resolves it (`npm pack
 * <pkg>@<target> --ignore-scripts` into an empty temp dir), hash it, and compare
 * with the proof. Nothing from the download is extracted or executed.
 *
 * @returns {{state: 'installable'|'pending'|'failed', reason: string, detail: string}}
 */
export function checkInstallable(target, proof, deps = {}) {
  const runImpl = deps.runImpl ?? run;
  const integrityImpl = deps.integrityImpl ?? archiveIntegrity;
  const dir = (deps.mkTempImpl ?? (() => mkdtempSync(join(tmpdir(), 'so-release-reconcile-'))))();
  try {
    let pack;
    try {
      pack = runImpl('npm', ['pack', `${PACKAGE_NAME}@${target}`, '--json', '--ignore-scripts', '--prefer-online', '--pack-destination', dir], { cwd: dir, timeout: 120000 });
    } catch (err) {
      return { state: 'pending', reason: 'download-failed', detail: `npm pack ${PACKAGE_NAME}@${target} failed: ${err?.message ?? err}` };
    }
    if (pack?.status !== 0) {
      return { state: 'pending', reason: 'download-failed', detail: `npm pack ${PACKAGE_NAME}@${target} exited ${pack?.status}: ${(pack?.stderr || '').trim().slice(0, 300)}` };
    }
    let filename;
    try {
      const records = JSON.parse(pack.stdout);
      filename = Array.isArray(records) && records.length === 1 ? records[0]?.filename : null;
    } catch { filename = null; }
    if (typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) {
      return { state: 'pending', reason: 'download-unparseable', detail: 'npm pack output did not name exactly one downloaded tarball' };
    }
    let integrity;
    try { integrity = integrityImpl(join(dir, filename)); } catch (err) {
      return { state: 'pending', reason: 'download-unreadable', detail: `downloaded tarball unreadable: ${err?.message ?? err}` };
    }
    if (integrity !== proof.integrity) {
      return { state: 'failed', reason: 'integrity-mismatch', detail: `downloaded tarball ${integrity} differs from the checked archive ${proof.integrity}` };
    }
    return { state: 'installable', reason: 'installable', detail: `downloaded ${filename} matches the checked archive integrity` };
  } finally {
    try { (deps.cleanupImpl ?? rmSync)(dir, { recursive: true, force: true }); } catch { /* temp download dir only */ }
  }
}

/**
 * Resume verification of an accepted upload: accepted (proof exists) ->
 * available (exact version served as latest with the checked integrity) ->
 * installable (a consumer download hashes to the checked integrity).
 *
 * Budget defaults to 20 attempts 60 s apart (19 min between first and last
 * query): npm's changelog (2026-07-28, read 2026-10-08) names ~5 min typical
 * and "up to 15 minutes or more" for publish-time scanning, without guarantee.
 * The budget is therefore a bound, not the fix — it is resumable: a `pending`
 * result is not a failure, the next `--reconcile` starts over from the same
 * proof. Only an integrity mismatch is `failed`.
 *
 * @param {string} repoRoot
 * @param {string} target
 * @param {{attempts?: number, delaySeconds?: number, runImpl?: Function, waitImpl?: Function, readImpl?: Function, integrityImpl?: Function, mkTempImpl?: Function, cleanupImpl?: Function}} [deps]
 * @returns {{ok: boolean, state: 'installable'|'superseded'|'pending'|'failed'|'proof-missing', target: string, accepted: boolean, available: boolean, installable: boolean, attempts: number, reason: string, detail: string, proofPath: string}}
 */
export function reconcileRelease(repoRoot, target, deps = {}) {
  const attempts = deps.attempts ?? 20;
  const delaySeconds = deps.delaySeconds ?? 60;
  const runImpl = deps.runImpl ?? run;
  const waitImpl = deps.waitImpl ?? (() => runImpl('sleep', [String(delaySeconds)], { cwd: repoRoot }));
  const base = { target, accepted: false, available: false, installable: false, attempts: 0 };

  const read = readReleaseProof(repoRoot, target, { readImpl: deps.readImpl });
  if (!read.ok) {
    return { ...base, ok: false, state: 'proof-missing', reason: 'proof-missing', detail: read.detail, proofPath: read.path };
  }
  const { proof } = read;
  const done = (state, step, attempt, extra) => ({ ...base, accepted: true, ...extra, ok: state === 'installable' || state === 'superseded', state, attempts: attempt, reason: step.reason, detail: step.detail, proofPath: read.path });

  let last = { reason: 'not-run', detail: 'no attempt ran' };
  let available = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let view;
    try {
      view = runImpl('npm', ['view', `${PACKAGE_NAME}@${target}`, '--json'], { cwd: repoRoot, timeout: 60000 });
    } catch (err) {
      view = { status: null, stdout: '', stderr: err?.message ?? String(err) };
    }
    const manifest = evaluateRegistryManifest(view, target, proof);
    if (manifest.state === 'failed') return done('failed', manifest, attempt, { available: false });
    if (manifest.state === 'available' || manifest.state === 'superseded') {
      available = true;
      const install = checkInstallable(target, proof, deps);
      if (install.state === 'installable') {
        // Superseded keeps its own state (and exit 0): the release's bytes are
        // verified installable, only the `latest` tag moved on — not a failure,
        // but worth saying so the operator does not read it as "is latest".
        if (manifest.state === 'superseded') return done('superseded', { reason: 'superseded', detail: `${manifest.detail}; ${install.detail}` }, attempt, { available: true, installable: true });
        return done('installable', install, attempt, { available: true, installable: true });
      }
      if (install.state === 'failed') return done('failed', install, attempt, { available: true });
      last = install;
    } else {
      available = false;
      last = manifest;
    }
    if (attempt < attempts) {
      let wait;
      try { wait = waitImpl({ attempt, delaySeconds }); } catch (err) { wait = { status: null, error: err }; }
      if (!wait || wait.status !== 0 || wait.error) {
        return done('pending', { reason: 'wait-failed', detail: `wait failed after attempt ${attempt}/${attempts}; last state: ${last.detail}` }, attempt, { available });
      }
    }
  }
  return done('pending', { reason: last.reason, detail: `${last.detail} (after ${attempts} attempts; run \`--reconcile --target ${target}\` again later)` }, attempts, { available });
}

/** Print a reconcile result and return the exit code (0 only when installable or superseded). */
export function printReconcileResult(result, { json = false, log = console.log, error = console.error } = {}) {
  if (json) {
    log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  const mark = (flag) => (flag ? 'yes' : 'no');
  log(`${PACKAGE_NAME}@${result.target}: ${result.state} — accepted ${mark(result.accepted)}, available ${mark(result.available)}, installable ${mark(result.installable)}`);
  if (result.ok) {
    log(`  ${result.detail}`);
    if (result.state === 'superseded') log(`  Note: ${result.target} is installable but no longer \`latest\` — a later release took the tag.`);
    return 0;
  }
  error(`  ${result.reason}: ${result.detail}`);
  if (result.state === 'pending') {
    error(`  Still pending, not failed. Run \`node scripts/release.mjs --reconcile --target ${result.target}\` again later;`);
    error('  the owner-visible package state is on npmjs.com (package page / account notifications). Never rerun --publish.');
  } else if (result.state === 'proof-missing') {
    error('  Without the publish proof there is nothing to verify the registry bytes against; success is never inferred from `latest`.');
  }
  return 1;
}

/**
 * The exact `npm publish` invocation: argv plus spawn options.
 *
 * WHY THE ENV PIN, AND WHY THIS IS A NAMED FUNCTION: `npm_config_loglevel` is
 * INHERITED, and the `+ <pkg>@<version>` receipt line — the ONE piece of
 * evidence `evaluatePublishReceipt` accepts as the irreversible boundary — is
 * printed at `notice` level. Any ancestor that ran under `npm run --silent`
 * (the husky pre-push gate does exactly that) therefore hands this child a
 * silent loglevel, npm publishes successfully and prints nothing, the receipt
 * reads as unconfirmed, `publish()` throws, and `main()` exits 2 = "pre-receipt,
 * safe to rerun" while the registry already holds the version. That is the worst
 * failure this file can produce, and it is the same inherited-silent trap the
 * leakage gate's `npm pack --json` was already pinned against (see preflight
 * step 7). The pin makes the receipt independent of the caller's environment.
 *
 * Exported because `publish()` itself deliberately is not (it is the
 * irreversible act) — the invocation it builds is pure, so the pin is testable
 * without a publishable seam.
 *
 * @param {string} repoRoot
 * @param {string} userconfigPath — the 0600 temp npmrc carrying the token
 * @returns {{cmd: string, args: string[], opts: {cwd: string, env: object}}}
 */
export function publishInvocation(repoRoot, userconfigPath, artifact) {
  if (!artifact?.tarballPath || !artifact.digest || archiveDigest(artifact.tarballPath) !== artifact.digest) throw new Error('refusing publish without unchanged checked archive');
  return {
    cmd: 'npm',
    args: ['publish', artifact.tarballPath, '--ignore-scripts', '--access', 'public', '--userconfig', userconfigPath],
    opts: { cwd: repoRoot, env: { ...process.env, npm_config_loglevel: 'notice' } },
  };
}

// Deliberately NOT exported: this is the irreversible act, and every production
// path to it runs through main() -> preflight() (leakage gate, CI gate, dirty-tree
// gate). Exporting it made the whole gate chain bypassable by any importer, and no
// consumer needs it -- the tests drive runPublishRelease with an injected publisher.
function publish(repoRoot, target, deps = {}) {
  const token = loadNpmToken(repoRoot);
  const runImpl = deps.runImpl ?? run;
  const res = withTempUserconfig(token, (tmpRc) => {
    const call = publishInvocation(repoRoot, tmpRc, deps.artifact);
    return runImpl(call.cmd, call.args, call.opts);
  });
  return settlePublishReceipt(repoRoot, target, res, { ...deps, runImpl });
}

/**
 * Everything `publish()` does AFTER `npm publish` returned: judge the receipt,
 * persist the publish proof, then wait for the registry. Split out of the
 * unexported publisher so the order "proof before registry wait" is testable
 * (#1537) — this function receives an npm result and cannot publish anything.
 * Pre-receipt failures throw; post-receipt propagation failures return.
 *
 * @param {string} repoRoot
 * @param {string} target
 * @param {{status: number|null, stdout?: string, stderr?: string}} res — the `npm publish` result
 * @param {{artifact: {digest: string, integrity: string}, runImpl?: Function, waitImpl?: Function, attempts?: number, delaySeconds?: number}} deps
 * @returns {{receipt: {confirmed: boolean, target: string, detail: string}, propagation: ReturnType<typeof waitForRegistryPropagation>, proof: ReturnType<typeof writeReleaseProof>}}
 */
export function settlePublishReceipt(repoRoot, target, res, deps = {}) {
  const runImpl = deps.runImpl ?? run;
  const receipt = evaluatePublishReceipt(res, target);
  if (!receipt.confirmed) throw new Error(receipt.detail);

  // Persist the proof BEFORE the registry wait: if this process dies while
  // waiting, `--reconcile` can still resume from it (#1537). Never throws.
  let commit = null;
  try {
    const head = runImpl('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    if (head.status === 0) commit = head.stdout.trim();
  } catch { /* commit stays null; the proof is still useful */ }
  const proof = writeReleaseProof(repoRoot, buildReleaseProof({
    target, artifact: deps.artifact, commit, receiptAt: new Date().toISOString(),
  }));

  const propagation = waitForRegistryPropagation(repoRoot, target, {
    attempts: deps.attempts,
    delaySeconds: deps.delaySeconds,
    runImpl,
    waitImpl: deps.waitImpl,
  });
  return { receipt, propagation, proof };
}

function tagAndPush(repoRoot, target) {
  const tag = `v${target}`;
  const progress = { tag, localTagCreated: false, pushed: [], remotes: [] };
  try {
    const excerpt = changelogExcerpt(repoRoot, target);
    const msgDir = mkdtempSync(join(tmpdir(), 'release-tagmsg-'));
    const msgFile = join(msgDir, 'msg');
    try {
      writeFileSync(msgFile, `${tag}\n\n${excerpt}\n`);
      mustRun('git', ['tag', '-a', tag, '-F', msgFile], { cwd: repoRoot });
      progress.localTagCreated = true;
    } finally {
      rmSync(msgDir, { recursive: true, force: true });
    }
    for (const remote of ['origin', 'github']) {
      const remoteProgress = { remote, mainPushed: false, tagPushed: false };
      progress.remotes.push(remoteProgress);
      mustRun('git', ['push', remote, 'main'], { cwd: repoRoot });
      remoteProgress.mainPushed = true;
      mustRun('git', ['push', remote, tag], { cwd: repoRoot });
      remoteProgress.tagPushed = true;
      progress.pushed.push(remote);
    }
    return { tag, pushed: progress.pushed };
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    failure.releaseProgress = progress;
    throw failure;
  }
}

/**
 * Run the irreversible-release tail after npm's target-confirmed receipt.
 * A tag/push failure stops tag-dependent phases; every other post-receipt
 * finding remains a returned reconciliation result rather than a retry signal.
 *
 * @param {string} repoRoot
 * @param {string} target
 * @param {{publishImpl?: Function, tagAndPushImpl?: Function, ensureGithubReleaseImpl?: Function, verifyLiveSiteImpl?: Function}} [deps]
 * @returns {Promise<{status: 'complete'|'post-publish-reconciliation', receipt: object, tag: string|null, pushed: string[], tagProgress?: object, release: object, live: object, propagation: object, reconciliation: Array<{phase: string, kind?: string, detail: string}>}>}
 */
export async function runPublishRelease(repoRoot, target, deps = {}) {
  // Fail-closed: the real publisher must be handed in explicitly. Defaulting to
  // the live `npm publish --access public` meant an importer that merely forgot
  // `publishImpl` performed an irreversible public release with the token from
  // .env.local and no preflight. main() wires it at the one call site that sits
  // behind the gate chain.
  const publishImpl = deps.publishImpl;
  if (typeof publishImpl !== 'function') {
    throw new Error('runPublishRelease requires an explicit publishImpl — refusing to publish by default');
  }
  const tagAndPushImpl = deps.tagAndPushImpl ?? tagAndPush;
  const ensureGithubReleaseImpl = deps.ensureGithubReleaseImpl ?? ensureGithubRelease;
  const verifyLiveSiteImpl = deps.verifyLiveSiteImpl ?? verifyLiveSite;
  const publication = publishImpl(repoRoot, target);

  if (!publication?.receipt?.confirmed || publication.receipt.target !== target) {
    throw new Error(`refusing release tail without a target-confirmed npm publish receipt for ${PACKAGE_NAME}@${target}`);
  }

  const propagation = publication.propagation;
  let tagAndPushResult;
  try {
    tagAndPushResult = tagAndPushImpl(repoRoot, target);
  } catch (err) {
    const rawProgress = err?.releaseProgress;
    const remotes = Array.isArray(rawProgress?.remotes)
      ? rawProgress.remotes
        .filter((remote) => typeof remote?.remote === 'string')
        .map((remote) => ({
          remote: remote.remote,
          mainPushed: remote.mainPushed === true,
          tagPushed: remote.tagPushed === true,
        }))
      : [];
    const tagProgress = {
      tag: typeof rawProgress?.tag === 'string' ? rawProgress.tag : null,
      localTagCreated: rawProgress?.localTagCreated === true,
      remotes,
    };
    const pushed = remotes.filter((remote) => remote.mainPushed && remote.tagPushed).map((remote) => remote.remote);
    const prerequisite = 'skipped because tag-and-push did not complete';
    return {
      status: 'post-publish-reconciliation',
      receipt: publication.receipt,
      tag: tagProgress.tag,
      pushed,
      tagProgress,
      release: { ok: false, skipped: true, state: 'skipped-prerequisite', detail: `GitHub release ${prerequisite}` },
      live: { ok: false, skipped: true, state: 'skipped-prerequisite', detail: `live-site verification ${prerequisite}` },
      propagation,
      proof: publication.proof,
      reconciliation: [
        { phase: 'tag-and-push', kind: 'failed', detail: err instanceof Error ? err.message : String(err) },
        { phase: 'github-release', kind: 'skipped-prerequisite', detail: `GitHub release ${prerequisite}` },
        { phase: 'live-site', kind: 'skipped-prerequisite', detail: `live-site verification ${prerequisite}` },
      ],
    };
  }

  const { tag, pushed } = tagAndPushResult;
  const release = ensureGithubReleaseImpl(repoRoot, target);
  const live = await verifyLiveSiteImpl(target);
  const reconciliation = [];
  if (!propagation?.ok) {
    reconciliation.push({
      phase: 'registry-propagation',
      kind: propagation?.kind ?? 'unknown',
      detail: propagation?.detail ?? 'registry propagation was not verified',
    });
  }
  if (!release.ok) reconciliation.push({ phase: 'github-release', detail: release.detail });
  if (!live.ok) reconciliation.push({ phase: 'live-site', detail: live.detail });

  return {
    status: reconciliation.length === 0 ? 'complete' : 'post-publish-reconciliation',
    receipt: publication.receipt,
    tag,
    pushed,
    release,
    live,
    propagation,
    proof: publication.proof,
    reconciliation,
  };
}

/**
 * Render the partial tag/push state left behind by a failed post-receipt tail.
 *
 * Pure so the reconciliation lines are unit-testable against a synthetic
 * outcome: the branch that produces them only exists after an irreversible npm
 * publish, which no test may perform.
 *
 * Absent progress is reported as absent, never as "nothing happened": a
 * `tagAndPushImpl` that threw before attaching `releaseProgress` leaves state
 * genuinely unknown, and the operator must inspect rather than assume.
 *
 * @param {{tag?: string|null, localTagCreated?: boolean, remotes?: Array<{remote: string, mainPushed?: boolean, tagPushed?: boolean}>}} [tagProgress]
 * @returns {string[]}
 */
export function describeTagProgress(tagProgress) {
  const lines = ['\nPARTIAL TAG/PUSH STATE (the npm receipt is already irreversible):'];
  if (!tagProgress || typeof tagProgress !== 'object') {
    lines.push('  tag/push progress was not recorded — inspect `git tag -l` and both remotes manually.');
    return lines;
  }
  const tag = tagProgress.tag || 'the release tag';
  lines.push(
    tagProgress.localTagCreated === true
      ? `  local tag ${tag}: CREATED (the next \`--check\` will fail \`tag-free-local\` until it is pushed or deleted).`
      : `  local tag ${tag}: not created.`,
  );
  const remotes = Array.isArray(tagProgress.remotes) ? tagProgress.remotes : [];
  if (remotes.length === 0) {
    lines.push('  no remote was reached — neither main nor the tag was pushed anywhere.');
    return lines;
  }
  for (const remote of remotes) {
    lines.push(
      `  ${remote.remote}: main ${remote.mainPushed === true ? 'pushed' : 'NOT pushed'}, ` +
        `tag ${remote.tagPushed === true ? 'pushed' : 'NOT pushed'}.`,
    );
  }
  return lines;
}

/**
 * Print a completed publish-tail outcome and return the CLI exit code.
 *
 * @param {{status: string, propagation: object, tag: string|null, pushed: string[], release: object, live: object, reconciliation: Array<{phase: string, kind?: string, detail: string}>}} outcome
 * @param {string} target
 * @param {{log?: Function, error?: Function}} [io]
 * @returns {number}
 */
export function printPublishOutcome(outcome, target, io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const tagAndPushFailed = outcome.reconciliation.some((item) => item.phase === 'tag-and-push');

  log(`  + ${PACKAGE_NAME}@${target} — target-confirmed npm receipt.`);
  if (outcome.proof) {
    if (outcome.proof.ok) log(`  ${outcome.proof.detail}.`);
    else error(`\nWARN: ${outcome.proof.detail} — \`--reconcile\` cannot verify this release without it.`);
  }
  if (outcome.propagation.ok) {
    log(`  registry verified (${outcome.propagation.detail}).`);
  } else {
    // An accepted upload can stay unserved for many minutes while npm's
    // publish-time checks run (#1537) — this is not a short propagation delay.
    error(`\nRECONCILIATION: registry availability is not yet verified — ${outcome.propagation.detail}`);
    error(`  npm accepted the upload; resume verification with: node scripts/release.mjs --reconcile --target ${target}`);
  }
  if (!tagAndPushFailed) {
    log(`  tagged ${outcome.tag} (AFTER publish) and pushed main+tag to: ${outcome.pushed.join(', ')}.`);
  } else {
    // The npm receipt is already irreversible at this point, so the ONLY thing
    // that helps the operator is the exact partial state tag-and-push reached.
    // `runPublishRelease` collects it (`tagProgress.localTagCreated` plus a
    // per-remote `{mainPushed, tagPushed}`); this printer used to reference
    // none of it and suppressed the `pushed:` line as well, so the operator was
    // told only THAT it failed. The local-tag line matters twice over: a
    // created local tag makes the next `--check` fail `tag-free-local`, which
    // reads as a mysterious collision unless it was announced here.
    for (const line of describeTagProgress(outcome.tagProgress)) error(line);
  }

  if (outcome.release.skipped) {
    error(`\nSKIPPED: ${outcome.release.detail}.`);
  } else if (outcome.release.ok) {
    log(`  ${outcome.release.detail}.`);
  } else {
    error(`\nRECONCILIATION: ${outcome.release.detail}`);
    const recovery = outcome.release.recovery;
    if (recovery?.inspect) {
      error(`  Inspect with: ${renderRecoveryCommand(recovery.inspect)}`);
      if (outcome.release.state === 'create-failed' && recovery.create) {
        error(`  Recover with: ${renderRecoveryCommand(recovery.create)}`);
        error('  The notes file is retained for recovery; remove it after the release is reconciled.');
      }
    } else {
      error('  Resolve the GitHub repository identity before inspecting or creating the release.');
    }
  }

  if (outcome.live.skipped) {
    error(`\nSKIPPED: ${outcome.live.detail}.`);
  } else if (!outcome.live.ok) {
    error(`\nRECONCILIATION: live site did not reach ${target}.`);
    error(`  ${outcome.live.detail}`);
    error('  Check https://vercel.com/kanevrys-projects/session-orchestrator for the deploy.');
  } else {
    log(`  site live at ${target} (${outcome.live.detail}).`);
  }

  if (outcome.status === 'post-publish-reconciliation') {
    error('\nPost-publish reconciliation required: npm has accepted the target release.');
    for (const item of outcome.reconciliation) {
      error(`  - ${item.phase}${item.kind ? ` (${item.kind})` : ''}: ${item.detail}`);
    }
    error('  Do NOT rerun `--publish`; reconcile the listed post-publish state directly.');
    if (!outcome.propagation.ok) error(`  Registry state: \`node scripts/release.mjs --reconcile --target ${target}\` (read-only, resumable).`);
    return 1;
  }

  log(`\nRelease complete: ${PACKAGE_NAME}@${target} is published, tagged, released and live.`);
  log('\nPost-release checklist (manual):');
  log('  1. Rotate/delete the npm token: https://www.npmjs.com/settings/<user>/tokens');
  log('  2. pi.dev gallery indexes asynchronously — do not block on it.');
  log('  3. Install the release on this host: npm run update:local -- --skip-pull, then restart the harness.');
  return 0;
}

/** Render argv for a POSIX shell without interpreting paths as shell code. */
function renderRecoveryCommand(argv) {
  return argv.map((arg) => /^[\w./:@=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
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
 *  - The `gh release view` probe avoids a duplicate-release error when a
 *    release is already present. It does not authorize rerunning `--publish`:
 *    post-receipt failures are reconciled directly.
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
 * @returns {{ok: boolean, created: boolean, tag: string, state: 'exists'|'created'|'unknown'|'create-failed', detail: string, argv?: string[], recovery?: {inspect: string[], create?: string[]}}}
 */
export function ensureGithubRelease(repoRoot, target, deps = {}) {
  const runImpl = deps.runImpl ?? run;
  const tag = `v${target}`;
  let recovery;

  try {
    const spec = deps.repoSpec ?? resolveRepoSpec({ repoRoot, vcs: 'github' });
    if (typeof spec !== 'string' || !spec.trim()) {
      return { ok: false, created: false, tag, state: 'unknown', detail: 'GitHub repository identity could not be resolved' };
    }
    // Recovery must carry the same resolved identity as the real invocation.
    // An absent identity cannot safely fall back to the caller's ambient repo.
    const repoFlag = ['--repo', spec];
    recovery = { inspect: ['gh', 'release', 'view', tag, ...repoFlag] };
    const existing = runImpl(recovery.inspect[0], recovery.inspect.slice(1), { cwd: repoRoot });
    const viewOutput = `${existing.stdout || ''}\n${existing.stderr || ''}`.trim();
    if (existing.status === 0 && viewOutput) {
      return { ok: true, created: false, tag, state: 'exists', detail: `GitHub release ${tag} already exists — no-op` };
    }
    // `gh release view` is tri-state. Only its documented absence response is
    // permission to create; auth, network, empty and malformed responses leave
    // release state unknown and must not trigger a write to GitHub.
    if (!(existing.status === 1 && /^release not found$/i.test(viewOutput))) {
      return {
        ok: false,
        created: false,
        tag,
        state: 'unknown',
        recovery,
        detail: `could not determine whether GitHub release ${tag} exists (gh release view exited ${existing.status}: ${viewOutput.slice(0, 300) || 'empty output'})`,
      };
    }

    const notesDir = mkdtempSync(join(tmpdir(), 'release-ghnotes-'));
    const notesFile = join(notesDir, 'notes.md');
    let argv;
    let retainNotes = false;
    try {
      writeFileSync(notesFile, `${changelogExcerpt(repoRoot, target)}\n`);
      argv = ['release', 'create', tag, ...repoFlag, '--verify-tag', '--title', tag, '--notes-file', notesFile];
      const created = runImpl('gh', argv, { cwd: repoRoot });
      if (created.status !== 0) {
        // A recovery argv pointing to a file deleted by finally is unusable.
        // Preserve only this failed-create excerpt; successful runs still clean up.
        retainNotes = true;
        return {
          ok: false,
          created: false,
          tag,
          state: 'create-failed',
          argv,
          recovery: { ...recovery, create: ['gh', ...argv] },
          detail: `gh release create exited ${created.status}: ${(created.stderr || created.stdout || '').trim().slice(0, 300)}`,
        };
      }
      return { ok: true, created: true, tag, state: 'created', argv, detail: `GitHub release ${tag} created (--verify-tag)` };
    } finally {
      if (!retainNotes) rmSync(notesDir, { recursive: true, force: true });
    }
  } catch (err) {
    return { ok: false, created: false, tag, state: 'unknown', ...(recovery ? { recovery } : {}), detail: `gh could not be run: ${err.message}` };
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
      reconcile: { type: 'boolean', default: false },
      target: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log('Usage: node scripts/release.mjs [--set-version X.Y.Z | --check | --publish | --reconcile [--target X.Y.Z]] [--skip-ci] [--json]');
    console.log('Release als ein Dispatch: surface sync, preflight checks, token publish, tag AFTER publish.');
    console.log('  Receipt boundary: before the confirmed npm receipt, failure aborts; after it, never rerun --publish.');
    console.log('  Tag/push failure after receipt skips GitHub-release and site phases and returns reconciliation guidance.');
    console.log('  --skip-ci  allowed with --check only; REFUSED with --publish (it verifies nothing).');
    console.log('  --reconcile  read-only resume after an accepted upload: proof -> available -> installable. Never publishes, tags or pushes.');
    console.log('               --target defaults to package.json version; needs .orchestrator/runtime/release-<target>.json from --publish.');
    console.log('Exit codes: 0 success (--reconcile: installable or superseded), 1 preflight/check failure, post-publish reconciliation or --reconcile pending/failed/proof missing, 2 pre-receipt system/usage error.');
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

  if (values.reconcile) {
    // Deliberately before and apart from the --check/--publish branch: no
    // preflight, no withCheckedPackage (no pack of the repo), no publisher.
    const target = values.target ?? readPackageVersion(repoRoot);
    if (!/^\d+\.\d+\.\d+$/.test(target)) {
      console.error(`invalid package.json version for --reconcile: ${target} (expected X.Y.Z; pass --target)`);
      return 2;
    }
    return printReconcileResult(reconcileRelease(repoRoot, target), { json: values.json });
  }

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
    console.log('  site/ page cells + site/_census.json + site/sitemap.xml lastmod re-stamped (scripts/site-numbers.mjs --write) — commit ALL of them');
    console.log('\nEditorial TODOs (enforced by --check):');
    console.log(`  1. CHANGELOG.md — write the "## [${target}] - YYYY-MM-DD" entry, fold [Unreleased].`);
    console.log('  2. README.md — rewrite the "Recent highlights" section content.');
    return 0;
  }

  if (values.check || values.publish) {
    const target = readPackageVersion(repoRoot);
    const checks = await preflight(repoRoot, target, { skipCi: values['skip-ci'] });
    const checked = await withCheckedPackage(repoRoot, async (artifact) => {
      checks.push({ name: 'leakage-gate', ok: true, detail: 'packed filenames and required owner-policy content scan verified' });
      const ok = printChecks(checks, values.json && !values.publish, target);
      if (!ok) return 1;
      if (!values.publish) return 0;
      console.log(`\nPublishing ${PACKAGE_NAME}@${target} ...`);
      console.log('  Publish and post-receipt reconciliation may take several minutes; do not kill it mid-run.');
      const outcome = await runPublishRelease(repoRoot, target, {
        publishImpl: (root, version) => publish(root, version, { artifact }),
      });
      return printPublishOutcome(outcome, target);
    });
    if (!checked.ok) {
      checks.push({ name: 'leakage-gate', ok: false, detail: checked.detail });
      printChecks(checks, values.json && !values.publish, target);
      return 1;
    }
    return checked.value;
  }

  console.error('Nothing to do — pass --check, --publish, --reconcile, or --set-version X.Y.Z (see --help).');
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
