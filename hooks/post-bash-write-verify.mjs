#!/usr/bin/env node
/**
 * post-bash-write-verify.mjs — PostToolUse hook (matcher `Bash`): report
 * working-tree changes a Bash call made OUTSIDE the wave's `allowedPaths`.
 *
 * ## Why this hook exists (#915, follow-up to #906 / #800)
 *
 * `hooks/enforce-scope.mjs` returns `emitAllow()` for every tool that is not
 * `Edit` / `Write` / `MultiEdit`. A Bash call therefore never reaches a path
 * check, and `echo x > out-of-scope.mjs` bypasses the entire scope-enforcement
 * layer. The PreToolUse half of the fix (`bash-write-guard` in
 * `hooks/enforce-commands.mjs`, #800) parses write targets out of the command
 * string — which is heuristic, which is why it ships OFF by default.
 *
 * This hook is the non-heuristic complement: it does not guess what the command
 * meant, it observes what the filesystem actually shows afterwards. That is why
 * it can default to ENABLED where `bash-write-guard` cannot.
 *
 * ## Warn-only, by construction
 *
 * PostToolUse fires AFTER the command ran; there is nothing left to block. The
 * hook writes one stderr line and one PostToolUse `additionalContext` string,
 * and always exits 0. Escalation to a blocking guard is not a switch on THIS
 * hook — it is flipping `enforcement-gates.bash-write-guard` to `true`, which
 * this hook exists to supply the evidence for. See
 * `docs/session-config-reference.md` § Bash-Write Verify.
 *
 * ## Decision flow (early-exit)
 *
 *   G1  profile gate (`SO_HOOK_PROFILE` / `SO_DISABLED_HOOKS`)
 *   G2  tool_name === 'Bash'
 *   G3  wave-scope.json exists
 *   G4  gates['bash-write-verify'] !== false   (absent ⇒ ENABLED)
 *   G5  enforcement !== 'off'
 *   G6  git status delta vs. snapshot → filter → report NEW out-of-scope paths
 *
 * ## Three properties that keep this from becoming noise
 *
 * 1. **Delta, not absolute.** A bare `git status` per Bash call reports the
 *    CUMULATIVE dirty tree: once one file is edited, every later Bash call in
 *    the session fires. Noise on that scale gets the guard switched off, which
 *    reproduces exactly the bypass pressure #915 fights. Only paths new
 *    relative to the previous invocation are reported.
 * 2. **Report-once.** A reported path is folded into the snapshot, so a file
 *    written by ten consecutive `sed -i` calls warns once, not ten times.
 * 3. **Silent re-baseline.** No snapshot yet (first Bash call of a session), or
 *    a changed `allowedPaths` signature (new wave): record the current dirty
 *    set WITHOUT warning. That dirt predates the call being observed; blaming
 *    the observed call for it is a false positive.
 *
 * ## Ignore list (contract, not implementation detail)
 *
 * `git status --porcelain` already omits `.gitignore`d files, which in THIS
 * repo covers most sibling-hook writes. The explicit list below exists because
 * the guard must not depend on a consumer repo's `.gitignore` being complete.
 *
 *   | class                          | patterns                                            |
 *   |--------------------------------|-----------------------------------------------------|
 *   | sibling-hook + own event writes| `.orchestrator/{metrics,debug,eval}/**`, `current-session.json`, `host.json`, `session.lock`, `state.lock`, `STATE.md` |
 *   | coordinator status files       | `.claude|.codex|.cursor|.pi/{STATE.md,wave-scope.json,metrics/**,worktrees/**,*.lock}` |
 *   | package-manager artefacts      | `node_modules/**`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` |
 *   | build / coverage output        | `coverage/**`, `dist/**`, `build/**`, `.next/**`, `junit.xml`, `*.log` |
 *   | tmp+rename residue             | `*.tmp`, `*.tmp-*`, `*.tmp.*`, `.tmp.*` (io.mjs `writeJsonAtomicSync`, `post-tool-failure-corrective-context.mjs` `.tmp-ptf-*`) |
 *   | OS noise                       | `.DS_Store`, `Thumbs.db`                            |
 *
 * The hook's OWN snapshot lives in `$TMPDIR`, never inside the repo, so it is
 * structurally incapable of reporting its own bookkeeping.
 *
 * ## Measured (2026-07-30, this repo, 1 507 tracked files)
 *
 *   hook end-to-end, per Bash call                 94.8 ms
 *     ├─ node cold start (every hook pays this)    ~67 ms  (enforce-commands.mjs: 66.9 ms)
 *     └─ marginal cost of the git status added here ~28 ms
 *   git … --porcelain -z --untracked-files=all     25.0 ms   (=normal: 28.7 ms)
 *   corpus: 2 528 Bash calls across 41 of 51 archived transcripts
 *   → 732 calls (29.0 %) contain any write construct
 *   → 23 calls (0.91 %) wrote a real in-repo non-ignored path
 *   → per session: median 1 distinct path, max 5 (⇒ ~1 warning/session)
 *
 * ## stdout discipline
 *
 * The payload names changed files, so it is genuinely capable of growing past
 * the 65 536-byte kernel pipe buffer. `console.log` + `process.exit()` would
 * silently drop the tail on macOS (Node docs, "process I/O": pipes are async on
 * macOS) — the #906 fail-open class. Two independent bounds apply: the payload
 * is clamped (MAX_REPORTED_PATHS / MAX_CONTEXT_CHARS) and the write goes
 * through `writeStdoutLineSync`, which loops `fs.writeSync(1, …)` to
 * completion.
 *
 * ## PSA
 *
 * `git status` only. `--no-optional-locks` is load-bearing: without it `git
 * status` opportunistically refreshes (and locks) `.git/index`, which races a
 * parallel session's index write — PSA-007's whole concern. No git-write
 * command is ever issued.
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately (silent no-op) when disabled via profile/env (#211).
if (!shouldRunHook('post-bash-write-verify')) process.exit(0);

import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';

import { readStdin, writeStdoutLineSync } from '../scripts/lib/io.mjs';
import { resolveProjectDir } from '../scripts/lib/platform.mjs';
import { findScopeFile, pathMatchesPattern } from '../scripts/lib/hardening.mjs';
import { readJson } from '../scripts/lib/common.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wall-clock ceiling for the `git status` child process. */
const GIT_TIMEOUT_MS = 3_000;

/** Ceiling for `git status` stdout (a pathological tree is not worth reporting). */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/** Max paths named in the report; the rest collapse into a "+N more" tail. */
export const MAX_REPORTED_PATHS = 20;

/** Hard ceiling on the emitted `additionalContext` string. */
export const MAX_CONTEXT_CHARS = 1_500;

/** Snapshot entries retained; bounds the sidecar for a pathological tree. */
const MAX_SNAPSHOT_PATHS = 5_000;

/**
 * Repo-relative paths whose changes are never attributable to a scope
 * violation. Applied ON TOP of `.gitignore` — see the header table for the
 * class each entry belongs to and why the redundancy with `.gitignore` is
 * deliberate.
 */
export const IGNORED_PATH_PATTERNS = Object.freeze([
  // sibling-hook + own event writes
  /^\.orchestrator\/(metrics|debug|eval)\//,
  /^\.orchestrator\/(current-session\.json|host\.json|session\.lock|state\.lock|STATE\.md)$/,
  // coordinator status files, all four harness state dirs
  /^\.(claude|codex|cursor|pi)\/(STATE\.md|wave-scope\.json|hooks\.json)$/,
  /^\.(claude|codex|cursor|pi)\/(metrics|worktrees)\//,
  /^\.(claude|codex|cursor|pi)\/[^/]*\.lock$/,
  // package-manager artefacts
  /^node_modules\//,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/,
  // build / coverage output
  /^(coverage|dist|build|\.next|\.turbo|out)\//,
  /(^|\/)junit\.xml$/,
  /\.log$/,
  // tmp+rename residue (writeJsonAtomicSync, atomicMutateJson, …)
  /\.tmp$/,
  /\.tmp[-.][^/]*$/,
  /(^|\/)\.tmp[-.][^/]*$/,
  // OS noise
  /(^|\/)(\.DS_Store|Thumbs\.db)$/,
  // Collapsed-directory records. `--untracked-files=all` should prevent these,
  // but a git version or config that still collapses must not turn a fresh
  // harness state dir into a scope violation. A trailing-slash record means the
  // WHOLE directory is untracked — for these four that is first-run harness
  // scaffolding, never a Bash write into someone else's file scope.
  /^\.(orchestrator|claude|codex|cursor|pi)\/$/,
]);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Is this repo-relative path exempt from reporting?
 *
 * @param {string} relPath forward-slash repo-relative path
 * @returns {boolean}
 */
export function isIgnoredPath(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return true;
  return IGNORED_PATH_PATTERNS.some((re) => re.test(relPath));
}

/**
 * Parse `git status --porcelain -z` output into repo-relative paths.
 *
 * The `-z` form is NUL-separated with no quoting/escaping, so a path containing
 * a newline or a quote survives intact — the reason `-z` is not optional here.
 * Each record is `XY<space><path>`; `--no-renames` is passed so the two-path
 * rename record shape never occurs.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parsePorcelainZ(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  const out = [];
  for (const record of raw.split('\0')) {
    if (record.length < 4) continue; // "XY p" is the shortest possible record
    out.push(record.slice(3));
  }
  return out;
}

/**
 * Is a repo-relative path covered by the wave's `allowedPaths`?
 *
 * Reuses `pathMatchesPattern` — the same matcher `enforce-scope.mjs` Gate 7
 * applies — so a path this hook reports is exactly a path the Edit/Write gate
 * would have denied. No bespoke matching.
 *
 * @param {string} relPath
 * @param {string[]} allowedPaths
 * @returns {boolean}
 */
export function isInScope(relPath, allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return false;
  return allowedPaths.some((p) => typeof p === 'string' && pathMatchesPattern(relPath, p));
}

/**
 * Stable signature of the wave's scope. A change means a new wave, which must
 * re-baseline silently rather than blame the next Bash call for the previous
 * wave's dirt.
 *
 * @param {string[]} allowedPaths
 * @returns {string}
 */
export function scopeSignature(allowedPaths) {
  const list = Array.isArray(allowedPaths) ? [...allowedPaths].filter((p) => typeof p === 'string') : [];
  list.sort();
  return createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Absolute path of the snapshot sidecar for a given repo root.
 *
 * Deliberately under `os.tmpdir()`, never inside the repo: an in-repo sidecar
 * would itself appear in `git status` and the guard would report its own
 * bookkeeping on the next call.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function snapshotPathFor(repoRoot) {
  const key = createHash('sha1').update(String(repoRoot)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'so-bash-write-verify', `${key}.json`);
}

/**
 * Core decision: which out-of-scope paths are NEW since the last invocation?
 *
 * @param {object} args
 * @param {string[]} args.dirtyPaths     repo-relative paths from git status
 * @param {string[]} args.allowedPaths   wave allowedPaths
 * @param {object|null} args.snapshot    previous `{ signature, paths[] }`, or null
 * @param {string} args.signature        current scope signature
 * @returns {{ report: string[], nextSnapshot: { signature: string, paths: string[] }, rebaselined: boolean }}
 */
export function computeReport({ dirtyPaths, allowedPaths, snapshot, signature }) {
  const outOfScope = dirtyPaths
    .filter((p) => !isIgnoredPath(p))
    .filter((p) => !isInScope(p, allowedPaths));

  const rebaselined = !snapshot || snapshot.signature !== signature;
  const seen = rebaselined || !Array.isArray(snapshot?.paths) ? new Set() : new Set(snapshot.paths);

  // Report-once: only paths absent from the previous snapshot.
  const report = rebaselined ? [] : outOfScope.filter((p) => !seen.has(p));

  // Fold everything observed into the next snapshot, so a path reported now is
  // never reported again for this wave.
  const nextPaths = [...new Set([...seen, ...outOfScope])].slice(-MAX_SNAPSHOT_PATHS);
  return { report, nextSnapshot: { signature, paths: nextPaths }, rebaselined };
}

/**
 * Render the operator/Claude-facing message, clamped on BOTH axes (path count
 * and total chars) so the envelope can never approach the 64 KiB pipe buffer.
 *
 * @param {string[]} report
 * @param {number} allowedCount
 * @returns {string}
 */
export function formatMessage(report, allowedCount) {
  const shown = report.slice(0, MAX_REPORTED_PATHS);
  const more = report.length - shown.length;
  const tail = more > 0 ? ` (+${more} more)` : '';
  const msg =
    `bash-write-verify: ${report.length} file(s) changed by a Bash call OUTSIDE the wave's `
    + `${allowedCount} allowedPaths — ${shown.join(', ')}${tail}. `
    + 'Warn-only (#915): PostToolUse cannot block a command that already ran. '
    + 'If this was unintended, revert it; Bash writes are NOT covered by the PreToolUse path gate.';
  return msg.length > MAX_CONTEXT_CHARS ? `${msg.slice(0, MAX_CONTEXT_CHARS - 1)}…` : msg;
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/**
 * Collect the working-tree dirty set. Returns null when git is unavailable, the
 * directory is not a repo, or the call times out — all of which mean "no signal
 * to report", never a warning.
 *
 * @param {string} repoRoot
 * @returns {string[]|null}
 */
function readDirtyPaths(repoRoot) {
  try {
    const raw = execFileSync(
      'git',
      // `--untracked-files=all` is load-bearing, not a tuning knob: the default
      // `normal` COLLAPSES a wholly-untracked directory into a single `dir/`
      // record, which defeats every file-level ignore pattern below (a fresh
      // `.orchestrator/` arrives as `.orchestrator/`, not as
      // `.orchestrator/metrics/events.jsonl`). Measured on this repo it is also
      // not slower — 25.0 ms/call vs 28.7 ms for `normal` — because the
      // expensive subtrees (node_modules/, coverage/) are .gitignore'd and git
      // never descends into them.
      ['--no-optional-locks', 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'],
      { cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return parsePorcelainZ(raw);
  } catch {
    return null;
  }
}

/** @returns {object|null} */
function readSnapshot(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic tmp+rename write; failure is non-fatal (worst case: a re-baseline). */
function writeSnapshot(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return;

  // G2 — only Bash calls carry the bypass risk this hook watches.
  if (input.tool_name !== 'Bash') return;

  const repoRootRaw = resolveProjectDir();
  let repoRoot;
  try {
    repoRoot = realpathSync(repoRootRaw);
  } catch {
    repoRoot = repoRootRaw;
  }

  // G3 — no wave scope → nothing defines "outside".
  const scopePath = findScopeFile(repoRoot);
  if (!scopePath) return;

  let scope;
  try {
    scope = await readJson(scopePath);
  } catch {
    return;
  }

  // G4 — gate is ON unless explicitly disabled. Note the contrast with
  // `bash-write-guard` (=== true): this detector observes the filesystem rather
  // than parsing a command, so it has no parse-artefact false positives and
  // does not need the opt-in default.
  if (scope?.gates?.['bash-write-verify'] === false) return;

  // G5 — enforcement:off means nothing is enforced, including advisories.
  if ((scope.enforcement ?? 'strict') === 'off') return;

  const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];

  const dirtyPaths = readDirtyPaths(repoRoot);
  if (dirtyPaths === null) return; // git unavailable → no signal, never a warning

  const snapFile = snapshotPathFor(repoRoot);
  const signature = scopeSignature(allowedPaths);
  const { report, nextSnapshot } = computeReport({
    dirtyPaths,
    allowedPaths,
    snapshot: readSnapshot(snapFile),
    signature,
  });

  writeSnapshot(snapFile, nextSnapshot);

  if (report.length === 0) return; // silence is the common case (0.91 % fire rate)

  const message = formatMessage(report, allowedPaths.length);

  // stderr for the operator; additionalContext for Claude's next turn.
  try {
    process.stderr.write(`⚠ ${message}\n`);
  } catch {
    /* stderr may be closed */
  }
  writeStdoutLineSync(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  }));
}

// Advisory hook: never block, never surface an error to the tool call.
main().catch(() => {}).finally(() => process.exit(0));
