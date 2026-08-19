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
//                         + Unreleased folded, tag collision (local, origin,
//                         github), npm registry collision, CI green on HEAD,
//                         leakage gate over `npm pack --dry-run`.
//   --publish             Runs --check first, then: token publish via temp
//                         userconfig (NPM_TOKEN from .env.local), registry
//                         verify, annotated tag AFTER successful publish
//                         (never before — eliminates "tagged but unpublished"),
//                         push main + tag to origin AND the github mirror,
//                         then print the post-release checklist (site deploy,
//                         token rotation).
//
// USAGE:
//   node scripts/release.mjs --check [--json]
//   node scripts/release.mjs --set-version 3.19.0
//   node scripts/release.mjs --publish [--json]
//
// EXIT CODES:
//   0  success
//   1  check failure (stale surface, missing CHANGELOG entry, tag/registry
//      collision, CI not green, leakage-gate hit)
//   2  system/usage error (git/npm spawn failure, missing NPM_TOKEN,
//      unknown flag)
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

const PACKAGE_NAME = 'session-orchestrator';
const SPAWN_OPTS = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };

// ---------------------------------------------------------------------------
// Surfaces table — the SSOT both the scan and the rewrite share.
//
// Every entry: { file, patterns: [RegExp] }. Each pattern has exactly one
// capture group holding the version. Matching ZERO occurrences is a hard
// failure ("pattern-dead") — that is the guard against a surface silently
// falling out of the check after a file refactor. All captured versions must
// equal the target.
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
    file: 'site/index.html',
    patterns: [/"softwareVersion":\s*"(\d+\.\d+\.\d+)"/, /v(\d+\.\d+\.\d+)\b/g],
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
 * CHANGELOG.md or package-lock.json (the caller syncs the lock via npm).
 * Returns the list of files actually changed.
 */
export function applyVersion(repoRoot, target) {
  const changed = [];
  for (const surface of SURFACES) {
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
];

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

// ---------------------------------------------------------------------------
// Impure orchestration below — git/npm/network. Not unit-tested; exercised
// by the release runs themselves.
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

  // 1. Git state: on main, clean tree, HEAD pushed.
  const branch = run('git', ['branch', '--show-current'], { cwd: repoRoot }).stdout.trim();
  add('branch-is-main', branch === 'main', branch);
  const dirty = run('git', ['status', '--porcelain'], { cwd: repoRoot }).stdout.trim();
  add('working-tree-clean', dirty === '', dirty ? `${dirty.split('\n').length} dirty path(s)` : '');
  run('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: repoRoot });
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  const originMain = run('git', ['rev-parse', 'origin/main'], { cwd: repoRoot }).stdout.trim();
  add('head-pushed', head === originMain, head === originMain ? head.slice(0, 8) : `HEAD ${head.slice(0, 8)} != origin/main ${originMain.slice(0, 8)}`);

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
  const prevTag = run('git', ['tag', '-l', 'v*', '--sort=-v:refname'], { cwd: repoRoot })
    .stdout.split('\n').map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t) && t !== target)[0];
  if (prevTag) {
    const HISTORY_ALLOWLIST = /^(CHANGELOG\.md|README\.md|docs\/|tests\/|skills\/npm-publish\/|scripts\/release\.mjs|\.orchestrator\/|site\/leaderboard\.json)/;
    const grep = run('git', ['grep', '-l', '--fixed-strings', prevTag, '--', '.'], { cwd: repoRoot });
    const hits = grep.stdout.split('\n').filter(Boolean).filter((f) => !HISTORY_ALLOWLIST.test(f));
    add('drift-sweep', hits.length === 0, hits.length ? `still carry ${prevTag}: ${hits.slice(0, 5).join(', ')}` : `no tracked file outside the allowlist still carries ${prevTag}`);
  } else {
    add('drift-sweep', true, 'no previous tag to sweep against');
  }

  // 4. Tag collision — local, origin, github mirror.
  const tag = `v${target}`;
  const localTag = run('git', ['tag', '-l', tag], { cwd: repoRoot }).stdout.trim();
  add('tag-free-local', localTag === '', localTag && `${tag} already exists locally`);
  for (const remote of ['origin', 'github']) {
    const ls = run('git', ['ls-remote', '--tags', remote, `refs/tags/${tag}`], { cwd: repoRoot });
    const collision = ls.status === 0 && ls.stdout.trim() !== '';
    add(`tag-free-${remote}`, ls.status === 0 && !collision, collision ? `${tag} already on ${remote}` : ls.status !== 0 ? `ls-remote ${remote} failed` : '');
  }

  // 5. npm registry collision (E404 = name free = fine for a first publish).
  const view = run('npm', ['view', PACKAGE_NAME, 'versions', '--json'], { cwd: repoRoot });
  if (view.status === 0) {
    let published = [];
    try {
      const parsed = JSON.parse(view.stdout);
      published = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      /* unparseable view output → treat as unknown, fail below */
    }
    add('registry-version-free', !published.includes(target), published.includes(target) ? `${target} already published` : `latest: ${published[published.length - 1] ?? '?'}`);
  } else {
    add('registry-version-free', /E404/.test(view.stderr || ''), /E404/.test(view.stderr || '') ? 'package not yet on registry (first publish)' : `npm view failed: ${(view.stderr || '').slice(0, 200)}`);
  }

  // 6. CI green on HEAD (the repo's iron session-start rule applies to
  // releases doubly: local green is not evidence — see .claude/rules).
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
  const lines = `${pack.stdout}\n${pack.stderr}`.split('\n');
  const violations = checkLeakage(lines);
  add('leakage-gate', pack.status === 0 && violations.length === 0, violations.length ? violations.map((v) => `${v.name}: ${v.line}`).slice(0, 5).join(' | ') : pack.status !== 0 ? 'npm pack failed' : `${lines.filter((l) => /npm notice.*[0-9]+B /.test(l)).length} packed entries, 0 leaks`);

  return checks;
}

function changelogExcerpt(repoRoot, target) {
  const text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const re = new RegExp(`^## \\[${target.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|$(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  return m ? m[1].trim().split('\n').slice(0, 40).join('\n') : '';
}

function publish(repoRoot, target) {
  // Token: only from gitignored .env.local (verify the ignore before reading).
  const ignored = run('git', ['check-ignore', '.env.local'], { cwd: repoRoot });
  if (ignored.status !== 0) throw new Error('.env.local is NOT gitignored — refusing to read a token from it');
  const envLocal = readFileSync(join(repoRoot, '.env.local'), 'utf8');
  const tokenMatch = envLocal.match(/^NPM_TOKEN=(.+)$/m);
  if (!tokenMatch) throw new Error('NPM_TOKEN not found in .env.local');
  const token = tokenMatch[1].trim();

  const tmpDir = mkdtempSync(join(tmpdir(), 'release-npmrc-'));
  const tmpRc = join(tmpDir, 'npmrc');
  try {
    writeFileSync(tmpRc, `//registry.npmjs.org/:_authToken=${token}\n`);
    chmodSync(tmpRc, 0o600);
    const res = run('npm', ['publish', '--access', 'public', '--userconfig', tmpRc], { cwd: repoRoot });
    const out = `${res.stdout}\n${res.stderr}`;
    if (res.status !== 0 || !out.includes(`+ ${PACKAGE_NAME}@${target}`)) {
      // Never echo the raw output wholesale into logs beyond the error slice —
      // it cannot contain the token (npm masks userconfig), but stay frugal.
      throw new Error(`npm publish failed (exit ${res.status}): ${out.slice(0, 800)}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
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
    console.log('Exit codes: 0 success, 1 check failure, 2 system/usage error.');
    return 0;
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
    console.log('  site census re-stamped (scripts/site-numbers.mjs --write)');
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
      return 1;
    }
    console.log(`  site live at ${target} (${live.detail}).`);

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
