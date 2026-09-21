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
//   - No .orchestrator/wave-scope.json → exit 0 (no active wave; sub-mode B
//     short-circuits). Sub-mode C still runs if a fence directory exists.
//   - Allowed paths violation → exit 1 with restore hint.
//   - Cross-agent fence overlap → exit 1 with "staging-fence: cross-agent
//     overlap" stderr.
//   - --no-verify bypass: this hook is invoked as a git pre-commit hook;
//     `git commit --no-verify` skips it entirely (operator opts out by name).

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Re-use existing helpers from scripts/lib/hardening.mjs.
// IMPORTANT: import is resolved relative to THIS file's location (the hook
// ships with the session-orchestrator package), NOT relative to the git
// repo it is protecting. The two diverge when the hook is invoked from a
// consumer repo or a test tmp-dir.
import { pathMatchesPattern, findScopeFile } from '../scripts/lib/hardening.mjs';
import { withStagingFenceLock } from '../scripts/lib/session-lock.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';

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
 * Build a regex that finds a staged path inside a `git add` command string.
 * Word-boundary on both sides so `src/foo.ts` does not match `src/foo.ts.bak`.
 * The path is escaped so glob metacharacters (`*`, `?`) and shell metas
 * cannot be reinterpreted.
 *
 * LEGACY PATH ONLY since #1404 — see the fallback branch in findOverlaps.
 */
function pathRegex(p) {
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s'"])${escaped}(?:$|[\\s'"])`);
}

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
 * Two entry shapes are accepted:
 *  - #1404 shape `{ paths, command_hash, timestamp }` — path LISTS compared
 *    against our staged set.
 *  - LEGACY shape `{ command, timestamp }` — a fence file written by a
 *    pre-#1404 hook version. Live sessions on this host may hold such files
 *    RIGHT NOW, and dropping them would read as "no overlap" — silently
 *    weaker than before the change. So the old raw-command regex still runs
 *    for an entry that has `command` and no `paths`.
 *    NAMED CEILING (BV-004): this fallback exists only to span the sessions
 *    running across the upgrade. REVISIT TRIGGER — remove it one minor
 *    release after 5.3.0 (i.e. in 5.4.0), by which point no process started
 *    before the upgrade can still be writing fence files. The command text it
 *    reads is never PRINTED (issue #1404) — only the fact of the match is.
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
    if (Array.isArray(entry?.paths)) {
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
      continue;
    }

    const cmd = entry?.command;
    if (typeof cmd !== 'string') continue;
    for (const ours of ourStaged) {
      if (pathRegex(ours).test(cmd)) {
        matches.push({
          ourPath: ours,
          siblingAgent,
          fencePath: '<legacy entry, pre-#1404>',
          hash: '<legacy entry, pre-#1404>',
        });
      }
    }
  }
  return matches;
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
  const scopePath = findScopeFile(repoRoot);
  const fenceDir = join(repoRoot, '.orchestrator', 'staging-fence');

  // -------------------------------------------------------------------------
  // Sub-mode B — allowedPaths check
  // -------------------------------------------------------------------------

  const stagedOutput = execSync('git diff --cached --name-only', { encoding: 'utf8' });
  const stagedFiles = stagedOutput.split('\n').filter(Boolean);

  if (scopePath) {
    let scope;
    try {
      scope = JSON.parse(readFileSync(scopePath, 'utf8'));
    } catch (err) {
      process.stderr.write(`wave-scope-commit-guard: failed to parse wave-scope.json: ${err.message}\n`);
      process.exit(1);
    }

    const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];
    if (allowedPaths.length > 0) {
      const violations = stagedFiles.filter(
        (f) => !allowedPaths.some((pattern) => pathMatchesPattern(f, pattern)),
      );

      if (violations.length > 0) {
        process.stderr.write('✗ wave-scope-commit-guard: staged paths outside wave-scope.allowedPaths:\n');
        for (const v of violations) process.stderr.write(`  - ${v}\n`);
        process.stderr.write('\nThese files were likely added by lint-staged eslint --fix / prettier --write.\n');
        process.stderr.write('To proceed:\n');
        process.stderr.write('  1) git restore --staged <path>   # for each foreign path\n');
        process.stderr.write('  2) git commit                    # retry\n');
        process.exit(1);
      }
    }
  }

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
