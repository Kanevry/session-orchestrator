#!/usr/bin/env node
// hooks/wave-scope-commit-guard.mjs
//
// PSA-004 sub-mode B + sub-mode C guard: runs at pre-commit time and rejects
// the commit when staged paths violate either the active wave-scope.json
// allowedPaths (sub-mode B) or the cross-agent staging-fence (sub-mode C).
//
// Sub-mode B — lint-staged sweep
//   lint-staged's eslint --fix / prettier --write step touches files matching
//   its globs in package.json (not just the agent's staged set) and re-stages
//   them via internal `git add`. PreToolUse Edit/Write gates never see these
//   files. This guard catches them at the very last moment before the commit
//   object is created.
//
// Sub-mode C — concurrent git-add race (issue #552)
//   Two wave-agents in the same repo can both `git add` overlapping paths
//   between each other's `git diff --cached` and `git commit`. Each individual
//   `git add` is recorded by hooks/pre-bash-staging-fence.mjs in a per-agent
//   fence file under .orchestrator/staging-fence/<agent-id>.json. At commit
//   time this guard walks ALL fence files (under a withStagingFenceLock mutex)
//   and rejects the commit when ANY staged path is also recorded in a SIBLING
//   agent's fence — i.e. another agent's intent to stage that path.
//
// Behavior summary
//   - No wave-scope.json → exit 0 (no active wave; sub-mode B short-circuits).
//     Sub-mode C still runs if a fence directory exists.
//   - Sub-mode B, in order (#1493.1): a manifest bound to ANOTHER session is
//     not this commit's scope (stand down, one stderr note); `enforcement:
//     "off"` skips.
//   - Non-empty allowedPaths: a staged path outside it BLOCKS (exit 1) under
//     every enforcement level, `warn` included. Deliberately not tied to
//     `enforcement`: in a warn-mode wave enforce-scope lets out-of-scope writes
//     through, so this guard is the only hard PSA-004 stop left for a
//     lint-staged sweep — softening it would weaken detection for the very
//     class it exists to catch.
//   - EMPTY allowedPaths is no longer a silent pass: a Discovery (read-only)
//     manifest means no agent is committing, i.e. a coordinator commit between
//     waves → allow with a note; a manifest older than the newest session
//     clock may be a leftover or a parallel session's live one → report,
//     never block; any other role means the `--union` step never completed →
//     `strict` (the default when the field is absent, as in enforce-scope)
//     blocks, `warn` reports and lets the commit through. Only this new
//     verdict follows `enforcement`: it judges the coordinator's own
//     bookkeeping, not a staged foreign file.
//   - Cross-agent fence overlap → exit 1 with "staging-fence: cross-agent
//     overlap" stderr.
//   - --no-verify bypass: this hook is invoked as a git pre-commit hook;
//     `git commit --no-verify` skips it entirely (operator opts out by name).

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

// Re-use existing helpers from scripts/lib/hardening.mjs.
// IMPORTANT: import is resolved relative to THIS file's location (the hook
// ships with the session-orchestrator package), NOT relative to the git
// repo it is protecting. The two diverge when the hook is invoked from a
// consumer repo or a test tmp-dir.
import { pathMatchesPattern } from '../scripts/lib/hardening.mjs';
import { withStagingFenceLock } from '../scripts/lib/session-lock.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
import { resolveSessionRoot } from '../scripts/lib/platform.mjs';
import { classifyEmptyScope, findOwnScopeFile, sessionAgeMs } from '../scripts/lib/scope-gate.mjs';
import {
  classifyManifestSession,
  readProcessLocalSessionIds,
} from '../scripts/lib/session-identity/own-session.mjs';

// Resolve the "current" agent id from SO_WAVE_AGENT_ID (when set by the
// caller) or fall back to a PID-derived marker. The fence files themselves
// embed the agent_id; the env-var is only used to skip THIS agent's own
// fence entries (we cross-check against SIBLINGS, not ourselves).
const ownAgentId = process.env.SO_WAVE_AGENT_ID ?? null;

/**
 * Recorded by the writer when a staging command stages a set no path operand
 * names (`git add -A`, `git add .`, `git add -u`). Overlaps everything.
 * Mirrors ALL_PATHS_MARKER in hooks/pre-bash-staging-fence.mjs.
 */
const ALL_PATHS_MARKER = '*';

/**
 * Normalise a path token so reader and writer compare the same spelling.
 *
 * DELIBERATE DUPLICATE of the identically-named function in
 * hooks/pre-bash-staging-fence.mjs: this guard is a husky pre-commit hook
 * outside the Claude-Code hook import set, and the two sides must agree byte
 * for byte. Change one, change both.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeStagedPath(raw) {
  let p = String(raw).trim();
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Does a path a sibling recorded overlap one of OUR staged files? Both sides
 * arrive already normalised. A DIRECTORY entry overlaps every file beneath it
 * (`src` overlaps `src/foo.ts`); the marker overlaps everything.
 *
 * @param {string} fencePath
 * @param {string} ourPath
 * @returns {boolean}
 */
function pathsOverlap(fencePath, ourPath) {
  if (fencePath === ALL_PATHS_MARKER) return true;
  if (fencePath === ourPath) return true;
  return ourPath.startsWith(`${fencePath}/`);
}

/**
 * Walk a single sibling fence file and return the staged paths a sibling
 * agent also recorded an intent to stage.
 *
 * One entry shape is read: the #1404 `{ paths, command_hash, timestamp }`,
 * whose path LIST is compared against our staged set. An entry without a
 * `paths` array is skipped — that includes the pre-#1404 `{ command }` shape,
 * whose raw-command regex fallback was removed in 5.4.x as its own revisit
 * trigger demanded (#1487 point 16): the only fence writer,
 * hooks/pre-bash-staging-fence.mjs, has written `paths` + `command_hash` and
 * never `command` since 5.3.0, and no other hook or bridge writes fence files.
 */
function findOverlaps(fenceJsonPath, ourStaged) {
  let body;
  try {
    body = JSON.parse(readFileSync(fenceJsonPath, 'utf8'));
  } catch {
    return [];
  }
  if (!body || typeof body !== 'object') return [];
  if (!Array.isArray(body.staged_paths)) return [];
  if (ownAgentId && body.agent_id === ownAgentId) return []; // skip self

  const siblingAgent = body.agent_id ?? '<unknown>';
  const matches = [];
  for (const entry of body.staged_paths) {
    if (!Array.isArray(entry?.paths)) continue;
    const hash = typeof entry.command_hash === 'string' ? entry.command_hash : '<no-hash>';
    for (const raw of entry.paths) {
      if (typeof raw !== 'string') continue;
      const fencePath = normalizeStagedPath(raw);
      for (const ours of ourStaged) {
        if (pathsOverlap(fencePath, normalizeStagedPath(ours))) {
          matches.push({ ourPath: ours, siblingAgent, fencePath, hash });
        }
      }
    }
  }
  return matches;
}

/** Remediation for an allowedPaths violation, printed once per commit. */
const ALLOWED_PATHS_HINT = [
  '',
  'These files were likely added by lint-staged eslint --fix / prettier --write.',
  'To proceed:',
  '  1) git restore --staged <path>   # for each foreign path',
  '  2) git commit                    # retry',
];

/**
 * A manifest path for messages: relative to the repo root, the absolute path
 * when it does not lie beneath it (#1514.2 — two candidate manifests, so a
 * message must say which one it means).
 *
 * @param {string} repoRoot
 * @param {string} scopePath
 * @returns {string}
 */
function manifestLabel(repoRoot, scopePath) {
  const rel = relative(repoRoot, scopePath);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? scopePath : rel;
}

/** mtime of a file in ms, or `null` when it cannot be stat'ed. */
function mtimeMsOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Sub-mode B's decision, pure: which lines to print and whether to block.
 *
 * Until #1493.1 an empty `allowedPaths` skipped the check outright, the
 * manifest's `role` and `enforcement: "off"` were never read, and a PEER
 * session's manifest governed this session's commits. Each rung below closes
 * one of those; the order is load-bearing — ownership first (a foreign
 * manifest's enforcement level is not ours to honour), then `off`, then the
 * verdict. `warn` softens ONLY the empty-union verdict; a non-empty violation
 * blocks at every level (header § Behavior summary).
 *
 * @param {object} p
 * @param {Record<string, unknown>} p.scope parsed manifest
 * @param {string[]} p.stagedFiles  repo-relative, as `git diff --cached` prints them
 * @param {(f: string) => string|null} [p.scopePathOf]  a staged path as the
 *   manifest names it — relative to the SESSION root; identity when that is the
 *   repo root. `null` = the path lies OUTSIDE the session root: a violation
 *   without pattern matching, since a `../`-prefixed path would match a glob
 *   like `**\/*.mjs` and enforce-scope denies every write outside its root
 *   (REQ-04).
 * @param {string} p.scopeRel manifest path for messages, repo-relative (absolute
 *   when outside the repo root) — `manifestLabel`
 * @param {Set<string>} p.ownIds this process's session ids
 * @param {number|null} p.scopeMtimeMs
 * @param {number|null} p.sessionAge ms since the newest session clock
 * @returns {{action: 'pass'|'report'|'block', lines: string[], hint?: string[]}}
 *   `hint` = the remediation block; `main()` prints it ONCE after every
 *   manifest was judged, so two blocking manifests do not repeat it (#1514.3).
 */
function scopeCommitVerdict({ scope, stagedFiles, scopePathOf = (f) => f, scopeRel, ownIds, scopeMtimeMs, sessionAge }) {
  if (stagedFiles.length === 0) return { action: 'pass', lines: [] };

  // Same classifier and same disposition as enforce-scope Gate 3b: only a
  // PROVABLY foreign manifest stands down; unknown ownership enforces.
  if (classifyManifestSession(scope, ownIds).verdict === 'foreign') {
    return {
      action: 'pass',
      lines: [`wave-scope-commit-guard: ${scopeRel} belongs to another session — its allowedPaths do not apply to this commit.`],
    };
  }

  const enforcement = scope.enforcement ?? 'strict';
  if (enforcement === 'off') return { action: 'pass', lines: [] };

  const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];
  if (allowedPaths.length > 0) {
    const violations = stagedFiles.filter(
      (f) => {
        const scoped = scopePathOf(f);
        return scoped === null || !allowedPaths.some((pattern) => pathMatchesPattern(scoped, pattern));
      },
    );
    if (violations.length === 0) return { action: 'pass', lines: [] };
    // Blocks under `warn` too — see the header: in a warn-mode wave this is
    // the only hard stop a lint-staged sweep meets before the commit exists.
    return {
      action: 'block',
      lines: [
        `✗ wave-scope-commit-guard: staged paths outside wave-scope.allowedPaths (${scopeRel}):`,
        ...violations.map((v) => `  - ${v}`),
      ],
      hint: ALLOWED_PATHS_HINT,
    };
  }

  // From here on the verdict judges the coordinator's own bookkeeping (an empty
  // union), not a staged foreign file — only this part follows `enforcement`.
  const failAction = enforcement === 'strict' ? 'block' : 'report';

  const role = typeof scope.role === 'string' ? scope.role.trim() : '';
  const reason = classifyEmptyScope({
    role,
    parseOk: true,
    scopeMtimeMs,
    sessionStartMs: typeof sessionAge === 'number' ? Date.now() - sessionAge : null,
  });
  if (reason === 'read-only-role') {
    // No wave agent commits (PSA-007), so a commit under a read-only manifest
    // is the coordinator's own, between waves.
    return {
      action: 'pass',
      lines: [`wave-scope-commit-guard: ${scopeRel} is a ${role} (read-only) manifest — treated as a coordinator commit between waves; allowedPaths not checked.`],
    };
  }
  if (reason === 'stale-manifest') {
    // Older than the newest session clock of this working copy: a leftover OR a
    // parallel session's live manifest, which the clocks cannot tell apart
    // (scope-gate.mjs § "…and the reader may not be the OWNER") — so it is
    // never grounds to block this commit.
    return {
      action: 'report',
      lines: [`⚠ wave-scope-commit-guard: ${scopeRel} grants no paths and predates the newest session start in this working copy — a leftover or a parallel session's live manifest; allowedPaths not checked for this commit.`],
    };
  }
  return {
    action: failAction,
    lines: [
      `${failAction === 'block' ? '✗' : '⚠'} wave-scope-commit-guard: ${scopeRel} grants no paths${role ? ` for role \`${role}\`` : ''} — the coordinator's \`--union\` step did not complete, so none of the ${stagedFiles.length} staged path(s) can be checked against this wave's scope.`,
      'Re-run the union step (skills/wave-executor/references/wave-loop-scope-manifest.md § 3.3), then retry the commit; do not hand-edit allowedPaths.',
      ...(failAction === 'block' ? [] : ['(enforcement: warn — reported, the commit proceeds)']),
    ],
  };
}

/**
 * The session root a commit at `repoRoot` is judged against when it lies
 * STRICTLY inside the repo, else `null` (judge at `repoRoot`, as before) — see
 * the call site in `main()` (#1511 point d). Both sides realpath-resolved, so
 * macOS `/var` vs `/private/var` cannot split one directory in two.
 *
 * @param {string} repoRoot  `git rev-parse --show-toplevel`
 * @returns {{sessionRoot: string, realRepoRoot: string}|null}
 */
function subdirSessionRoot(repoRoot) {
  const canon = (p) => {
    // `.native` canonicalises letter case on case-insensitive APFS (as
    // enforce-scope's clamp does since #1504 pt 8); the JS realpath keeps a
    // case-different CLAUDE_PROJECT_DIR verbatim, which relativises to `../..`
    // against the git toplevel and switches the subdirectory mode off silently.
    try { return realpathSync.native(p); } catch { return p; }
  };
  const realRepoRoot = canon(repoRoot);
  const sessionRoot = canon(resolveSessionRoot(repoRoot, repoRoot));
  const rel = relative(realRepoRoot, sessionRoot);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return { sessionRoot, realRepoRoot };
}

/**
 * Both sub-modes, in the order the pre-commit hook needs them. Every statement
 * here used to sit at module top level, which meant a bare `import()` of this
 * file ran `git rev-parse` / `git diff --cached` and could exit the IMPORTING
 * process with 1 (#1393). Moved into a function so the entry guard below can
 * gate it; the logic and its exit codes are unchanged.
 */
async function main() {
  const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  // #801: resolve wave-scope.json via the same precedence every other reader
  // uses (.pi/.cursor/.codex/.claude — scope-gate.mjs findScopeFile). The prior
  // hardcoded `.orchestrator/wave-scope.json` path was DEAD — the coordinator
  // writes wave-scope.json to the state dir (.claude/ on Claude Code; see
  // skills/wave-executor/wave-loop.md), so this guard never fired. findScopeFile
  // returns null when no scope file exists at any precedence dir, preserving
  // the "no active wave → exit 0" semantics below.
  //
  // #1504 point 6: the first manifest that is not provably a peer's, so a
  // peer's higher-precedence manifest no longer hides this session's own one;
  // when every candidate is foreign the first comes back and
  // `scopeCommitVerdict` passes it as before. The git process inherits the
  // committing session's env; there is no hook payload here, so the env tier is
  // the only process-local identity. CEILING (#1504 point 7b): a shell that
  // exports a foreign CLAUDE_CODE_SESSION_ID makes this session's manifest read
  // `foreign` and the guard stands down: the same power `--no-verify` grants, so it
  // stays named, not fixed (docs/scope-collision-guard.md § 6 item 12).
  const ownIds = new Set(readProcessLocalSessionIds());

  // #1511 point d — ALSO read the manifest at the SESSION root the scope guards
  // resolve (`resolveSessionRoot`, enforce-scope.mjs): a session launched in a
  // repo SUBDIRECTORY keeps its manifest there, so the repo root held none and
  // sub-mode B never ran for it. git runs this hook at the worktree top level
  // and the committing session's env (the launch dir) is inherited, so the
  // toplevel stands in for the payload `cwd` the Edit/Write guards get. Only a
  // root STRICTLY inside the repo is adopted: the one rung that answers above it
  // (a harness `agent-<hex>` worktree lifted to its launch checkout) would judge
  // this repo's staged paths against another tree's manifest.
  //
  // The repo-root manifest is ALWAYS judged exactly as before #1511 d, and the
  // subdirectory manifest is judged IN ADDITION, each against its own path
  // mapping; either one blocking blocks. So the verdict is never laxer than the
  // repo-root-only guard it extends — choosing ONE of the two manifests let an
  // unbound or `enforcement: off` subdirectory manifest silence a repo-root wave
  // that blocked the same commit (second review, MED-1).
  const subdir = subdirSessionRoot(repoRoot);
  const judgements = [{ root: repoRoot, scopePathOf: (f) => f }];
  if (subdir !== null) {
    judgements.push({
      root: subdir.sessionRoot,
      scopePathOf: (f) => {
        const rel = relative(subdir.sessionRoot, join(subdir.realRepoRoot, f));
        return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
      },
    });
  }
  const fenceDir = join(repoRoot, '.orchestrator', 'staging-fence');

  // -------------------------------------------------------------------------
  // Sub-mode B — allowedPaths check
  // -------------------------------------------------------------------------

  const stagedOutput = execSync('git diff --cached --name-only', { encoding: 'utf8' });
  const stagedFiles = stagedOutput.split('\n').filter(Boolean);

  let blocked = false;
  /** @type {string[]|null} printed once after the loop (#1514.3) */
  let hint = null;
  const flushHint = () => {
    if (hint !== null) for (const line of hint) process.stderr.write(`${line}\n`);
  };
  for (const { root, scopePathOf } of judgements) {
    const located = findOwnScopeFile(root, ownIds, classifyManifestSession);
    const scopePath = located.path ?? located.foreignPath;
    if (!scopePath) continue;
    const scopeRel = manifestLabel(repoRoot, scopePath);
    let scope;
    try {
      scope = JSON.parse(readFileSync(scopePath, 'utf8'));
    } catch (err) {
      process.stderr.write(`wave-scope-commit-guard: failed to parse ${scopeRel}: ${err.message}\n`);
      flushHint();
      process.exit(1);
    }

    const verdict = scopeCommitVerdict({
      scope: scope !== null && typeof scope === 'object' ? scope : {},
      stagedFiles,
      scopePathOf,
      scopeRel,
      ownIds,
      scopeMtimeMs: mtimeMsOf(scopePath),
      sessionAge: sessionAgeMs(root),
    });
    for (const line of verdict.lines) process.stderr.write(`${line}\n`);
    if (verdict.hint) hint = verdict.hint;
    if (verdict.action === 'block') blocked = true;
  }
  flushHint();
  if (blocked) process.exit(1);

  // -------------------------------------------------------------------------
  // Sub-mode C — cross-agent staging-fence reconciliation (issue #552)
  // -------------------------------------------------------------------------
  //
  // Skip entirely when no fence dir exists OR no staged files. The fence dir
  // only appears when a wave-agent invoked `git add` while SO_WAVE_AGENT=1.
  // Manual / coordinator commits never write a fence file, so this branch
  // short-circuits to exit 0 for them (AC5 safe-default).
  if (!existsSync(fenceDir) || stagedFiles.length === 0) {
    process.exit(0);
  }

  let overlaps = [];

  try {
    await withStagingFenceLock(
      repoRoot,
      async () => {
        let entries;
        try {
          entries = readdirSync(fenceDir);
        } catch {
          return;
        }
        for (const name of entries) {
          if (!name.endsWith('.json')) continue;
          if (name.startsWith('.')) continue; // skip .commit.lock, tmp files
          const overlapsFromFile = findOverlaps(join(fenceDir, name), stagedFiles);
          overlaps = overlaps.concat(overlapsFromFile);
        }
      },
      { timeoutMs: 5000 },
    );
  } catch (err) {
    // Lock acquisition failed — emit a warning but do NOT block the commit.
    // The race-detection layer is opportunistic; a lock-acquire timeout is
    // strictly less severe than blocking a legitimate commit on flaky FS.
    process.stderr.write(
      `⚠ wave-scope-commit-guard: staging-fence lock failed — ${err?.message ?? err}\n`,
    );
    process.exit(0);
  }

  if (overlaps.length > 0) {
    process.stderr.write('✗ wave-scope-commit-guard: staging-fence: cross-agent overlap detected:\n');
    for (const o of overlaps) {
      process.stderr.write(
        `  - ${o.ourPath} (sibling agent ${o.siblingAgent} recorded ${o.fencePath}, command ${o.hash})\n`,
      );
    }
    process.stderr.write('\nAnother wave-agent recorded a `git add` for one or more of your staged paths.\n');
    process.stderr.write('To proceed:\n');
    process.stderr.write('  1) Coordinate with the sibling agent OR\n');
    process.stderr.write('  2) git restore --staged <path>   # for each conflicting path, then retry\n');
    process.stderr.write('  3) git commit --no-verify        # bypass (PSA-001/PSA-003 risk — operator opt-out)\n');
    process.exit(1);
  }

  process.exit(0);
}

// Entry guard (#1393): run only as the node script `.husky/pre-commit` execs —
// a bare `import()` must run no git command and must not exit the importing
// process. No shouldRunHook gate here: this file is NOT registered in
// hooks/hooks.json, so the profile-gate never governed it.
if (isMainModule(import.meta.url)) {
  await main();
}
