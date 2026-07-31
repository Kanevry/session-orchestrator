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
 *   G3  wave-scope.json exists (disappearance after a recorded scope → notice)
 *   G4  gates['bash-write-verify'] !== false   (absent ⇒ ENABLED)
 *   G5  enforcement !== 'off'
 *   G6  git status delta vs. snapshot → filter → report NEW out-of-scope paths
 *
 * G4/G5 are evaluated on the scope state RECORDED IN THE SNAPSHOT — the state
 * in effect BEFORE the observed call — never on the live file (#938 vector 1):
 * a Bash call that rewrites wave-scope.json to `enforcement: "off"` cannot
 * silence the hook for its own evaluation. The rewrite itself is always
 * reported (content-hash comparison against the snapshot, because the file is
 * typically gitignored and thus invisible to `git status`), and the new value
 * takes effect from the NEXT call on.
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
 * 3. **Re-baseline without amnesia (#938).** No snapshot yet (first Bash call
 *    of a session — or a deleted sidecar, vector 2), or a changed
 *    `allowedPaths` signature (new wave, vector 3): fold the current dirty set
 *    into the snapshot, but stay silent ONLY about paths whose mtime predates
 *    the wave-scope.json write. That dirt predates the wave; blaming the
 *    observed call for it is a false positive. Dirt NEWER than the scope file
 *    appeared during this wave — a re-baseline (which the observed actor can
 *    force by deleting the `$TMPDIR` sidecar) must not swallow it.
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
 *   | coordinator status files       | `.claude|.codex|.cursor|.pi/{STATE.md,hooks.json,metrics/**,worktrees/**,*.lock}` |
 *   | package-manager artefacts      | `node_modules/**`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` |
 *   | build / coverage output        | `coverage/**`, `dist/**`, `build/**`, `.next/**`, `junit.xml`, `*.log` |
 *   | tmp+rename residue             | `*.tmp`, `*.tmp-*`, `*.tmp.*`, `.tmp.*` (io.mjs `writeJsonAtomicSync`, `post-tool-failure-corrective-context.mjs` `.tmp-ptf-*`) |
 *   | OS noise                       | `.DS_Store`, `Thumbs.db`                            |
 *
 * `wave-scope.json` is deliberately ABSENT from the list since #938: the
 * scope-control file is the one path whose change must ALWAYS be surfaced. An
 * ignore entry here plus a `.gitignore` entry made it doubly invisible, so the
 * observed actor could rewrite the gate unreported. Because the file is
 * typically gitignored, `git status` cannot see it anyway — change detection
 * for it is content-hash-based against the snapshot (`formatControlNotice`).
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
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync, realpathSync, statSync } from 'node:fs';

import { readStdin, writeStdoutLineSync } from '../scripts/lib/io.mjs';
import { resolveProjectDir } from '../scripts/lib/platform.mjs';
import { findScopeFile, pathMatchesPattern } from '../scripts/lib/hardening.mjs';

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
  // coordinator status files, all four harness state dirs.
  // `wave-scope.json` is deliberately NOT here (#938 vector 1): the guard's
  // own control file must never be exempt from reporting.
  /^\.(claude|codex|cursor|pi)\/(STATE\.md|hooks\.json)$/,
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
 * On a re-baseline (no snapshot, or a changed scope signature) the pre-#938
 * behaviour was total silence. That let the observed actor buy blindness by
 * deleting the `$TMPDIR` sidecar (vector 2), and made the first call after
 * every wave rollover blind (vector 3). The mtime rule closes both: dirt
 * whose mtime is NEWER than the wave-scope.json write happened during THIS
 * wave and is reported even on a re-baseline; older dirt predates the wave
 * and stays silent (pre-wave dirt is never blamed on the observed call).
 *
 * @param {object} args
 * @param {string[]} args.dirtyPaths     repo-relative paths from git status
 * @param {string[]} args.allowedPaths   wave allowedPaths
 * @param {object|null} args.snapshot    previous `{ signature, paths[] }`, or null
 * @param {string} args.signature        current scope signature
 * @param {number|null} [args.scopeMtimeMs] mtime (ms) of wave-scope.json, or null
 * @param {(relPath: string) => (number|null)} [args.mtimeMs] mtime lookup for a
 *   dirty path; null = not attributable (deleted path / stat failure)
 * @returns {{ report: string[], nextSnapshot: { signature: string, paths: string[] }, rebaselined: boolean }}
 */
export function computeReport({ dirtyPaths, allowedPaths, snapshot, signature, scopeMtimeMs = null, mtimeMs = null, scopeRelPath = null }) {
  const outOfScope = dirtyPaths
    .filter((p) => !isIgnoredPath(p))
    .filter((p) => !isInScope(p, allowedPaths))
    // The wave-scope.json control file is out-of-scope by construction (it is
    // never under allowedPaths) but its CHANGES are reported via the content-hash
    // control-notice path, not here. Excluding it keeps the mtime re-baseline
    // filter from reporting the scope file against ITSELF — its mtime always
    // equals scopeMtimeMs, so the MED-3 `>=` boundary would otherwise flag it on
    // every first run (#938 MED-3 follow-through).
    .filter((p) => p !== scopeRelPath);

  const rebaselined = !snapshot || snapshot.signature !== signature;
  const seen = rebaselined || !Array.isArray(snapshot?.paths) ? new Set() : new Set(snapshot.paths);

  let report;
  if (!rebaselined) {
    // Report-once: only paths absent from the previous snapshot.
    report = outOfScope.filter((p) => !seen.has(p));
  } else if (typeof scopeMtimeMs === 'number' && typeof mtimeMs === 'function') {
    // #938 vectors 2+3: a re-baseline is only silent about PRE-WAVE dirt.
    // MED-3 (W4 panel): `>=`, not `>`. A write whose mtime lands on the SAME
    // coarse-FS tick as the scope file (or the same instant) is dirt from THIS
    // wave, not pre-wave — a strict `>` silently dropped it (equal-mtime
    // false-negative). The deeper evasion (an actor bumping the scope file's
    // mtime ABOVE its own out-of-scope write to force a silent re-baseline)
    // remains a warn-only detection-integrity gap — see follow-up.
    report = outOfScope.filter((p) => {
      const m = mtimeMs(p);
      return typeof m === 'number' && m >= scopeMtimeMs;
    });
  } else {
    // No mtime signal (scope-file stat failed / caller supplied none): degrade
    // to the conservative silent re-baseline rather than blame pre-wave dirt.
    report = [];
  }

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

/**
 * Render the control-file-change notice (#938 vector 1).
 *
 * Fired whenever the wave-scope.json CONTENT differs from the state recorded
 * in the snapshot. The coordinator's per-wave rollover legitimately triggers
 * this once per wave — that case reads as information, not alarm
 * (`weakened: false`). A change that turns enforcement off, disables the
 * bash-write-verify gate, or makes the file unparseable is a weakening
 * (`weakened: true`): exactly the write an actor silencing the guard must
 * make, so it is the one line the operator must not miss.
 *
 * @param {string} relScopePath repo-relative path of the scope file
 * @param {{ hash: string, enforcement: string, gateOn: boolean }} prev
 * @param {{ hash: string, enforcement: string, gateOn: boolean }} cur
 * @returns {{ text: string, weakened: boolean }}
 */
export function formatControlNotice(relScopePath, prev, cur) {
  const prevGateOn = prev.gateOn !== false;
  const curGateOn = cur.gateOn !== false;
  const deltas = [];
  if (prev.enforcement !== cur.enforcement) deltas.push(`enforcement ${prev.enforcement}→${cur.enforcement}`);
  if (prevGateOn !== curGateOn) deltas.push(`gates.bash-write-verify ${prevGateOn ? 'on' : 'off'}→${curGateOn ? 'on' : 'off'}`);
  const weakened = (cur.enforcement === 'off' && prev.enforcement !== 'off')
    || cur.enforcement === 'unparseable'
    || (prevGateOn && !curGateOn);
  const what = deltas.length > 0 ? deltas.join(', ') : 'allowedPaths/content change';
  const text = `bash-write-verify: control file ${relScopePath} changed since the last Bash call (${what}). `
    + (weakened
      ? 'This weakens or disables the bash-write guard from the NEXT call on; the current call was still evaluated under the previous scope state (#938).'
      : 'Expected once per wave rollover; scope-control changes are never exempt from reporting (#938).');
  return { text: text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…` : text, weakened };
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

/**
 * A missing snapshot while the scope file is at least this old is flagged as
 * suspicious (#938 fix 3): a genuine first Bash call happens minutes after the
 * coordinator wrote wave-scope.json, whereas a long-running wave whose sidecar
 * suddenly vanished points at `rm -f $TMPDIR/so-bash-write-verify/…`.
 * Informational only — a TMPDIR purge or reboot produces the same signal once.
 */
const SNAPSHOT_MISSING_SUSPICION_MS = 10 * 60 * 1000;

/**
 * Emit stderr line(s) for the operator + one PostToolUse envelope for Claude.
 * `warn` selects the stderr glyph: violations and control-file weakenings
 * alarm (⚠); a plain rollover/teardown notice informs (ℹ).
 *
 * @param {string[]} messages
 * @param {boolean} warn
 */
function emitMessages(messages, warn) {
  const glyph = warn ? '⚠' : 'ℹ';
  try {
    for (const m of messages) process.stderr.write(`${glyph} ${m}\n`);
  } catch {
    /* stderr may be closed */
  }
  writeStdoutLineSync(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: messages.join('\n'),
    },
  }));
}

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

  const snapFile = snapshotPathFor(repoRoot);
  const snapshot = readSnapshot(snapFile);
  const prevScopeState = snapshot && typeof snapshot.scopeState === 'object' && snapshot.scopeState !== null
    ? snapshot.scopeState
    : null;

  // G3 — no wave scope → nothing defines "outside". #938: if a previous call
  // RECORDED a scope state, the control file's disappearance is itself a
  // control-file change and gets one visible (non-alarming) notice.
  const scopePath = findScopeFile(repoRoot);
  if (!scopePath) {
    if (prevScopeState && prevScopeState.hash !== 'absent') {
      writeSnapshot(snapFile, {
        ...(snapshot ?? { signature: null, paths: [] }),
        scopeState: { hash: 'absent', enforcement: 'strict', gateOn: true },
      });
      emitMessages([
        'bash-write-verify: control file wave-scope.json was REMOVED since the last Bash call — '
        + 'the bash-write guard is inert until a new wave scope is written. '
        + 'Expected at session teardown; scope-control changes are never exempt from reporting (#938).',
      ], false);
    }
    return;
  }

  let raw = null;
  let scope = null;
  try {
    raw = readFileSync(scopePath, 'utf8');
    scope = JSON.parse(raw);
  } catch {
    /* raw stays null (unreadable) or scope stays null (unparseable) */
  }
  if (raw === null) return; // file vanished between findScopeFile and read

  const relScopePath = path.relative(repoRoot, scopePath) || scopePath;
  const currentScopeState = {
    hash: createHash('sha1').update(raw).digest('hex').slice(0, 16),
    enforcement: scope
      ? (typeof scope.enforcement === 'string' ? scope.enforcement : 'strict')
      : 'unparseable',
    gateOn: scope ? scope?.gates?.['bash-write-verify'] !== false : true,
  };

  // Unparseable control file: nothing to evaluate paths against, but the
  // CHANGE is still reported (#938 vector 1 variant — `echo garbage >
  // wave-scope.json` must not be a free total silencer).
  if (!scope) {
    if (prevScopeState && prevScopeState.hash !== currentScopeState.hash) {
      writeSnapshot(snapFile, { ...(snapshot ?? { signature: null, paths: [] }), scopeState: currentScopeState });
      const notice = formatControlNotice(relScopePath, prevScopeState, currentScopeState);
      emitMessages([notice.text], true);
    }
    return;
  }

  // G4+G5 — evaluated on the PRE-CALL scope state from the snapshot (#938
  // vector 1); the live values only take effect from the NEXT call on. Falls
  // back to the live values when no snapshot exists (true first run) or the
  // snapshot predates the scopeState schema. G4 is ON unless explicitly
  // disabled — the contrast with `bash-write-guard` (=== true) stands: this
  // detector observes the filesystem rather than parsing a command. G5:
  // enforcement:off means nothing is enforced, including advisories.
  const effEnforcement = prevScopeState && typeof prevScopeState.enforcement === 'string'
    ? prevScopeState.enforcement
    : currentScopeState.enforcement;
  const effGateOn = prevScopeState ? prevScopeState.gateOn !== false : currentScopeState.gateOn;
  if (!effGateOn || effEnforcement === 'off') {
    // Refresh only the recorded scope state so a later re-enable is honored on
    // the next call; signature/paths stay untouched.
    writeSnapshot(snapFile, { ...(snapshot ?? { signature: null, paths: [] }), scopeState: currentScopeState });
    return;
  }

  const controlNotice = prevScopeState
    && typeof prevScopeState.hash === 'string'
    && prevScopeState.hash !== 'absent'
    && prevScopeState.hash !== currentScopeState.hash
    ? formatControlNotice(relScopePath, prevScopeState, currentScopeState)
    : null;

  const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];

  const dirtyPaths = readDirtyPaths(repoRoot);
  if (dirtyPaths === null) {
    // git unavailable → no path signal; the control-file notice still stands.
    writeSnapshot(snapFile, { ...(snapshot ?? { signature: null, paths: [] }), scopeState: currentScopeState });
    if (controlNotice) emitMessages([controlNotice.text], controlNotice.weakened);
    return;
  }

  const signature = scopeSignature(allowedPaths);
  let scopeMtimeMs = null;
  try {
    scopeMtimeMs = statSync(scopePath).mtimeMs;
  } catch {
    /* stat failure → computeReport degrades to the silent re-baseline */
  }

  const { report, nextSnapshot } = computeReport({
    dirtyPaths,
    allowedPaths,
    snapshot,
    signature,
    scopeMtimeMs,
    scopeRelPath: relScopePath,
    mtimeMs: (rel) => {
      try {
        return statSync(path.join(repoRoot, rel)).mtimeMs;
      } catch {
        return null; // deleted path → not mtime-attributable on a re-baseline
      }
    },
  });

  writeSnapshot(snapFile, { ...nextSnapshot, scopeState: currentScopeState });

  const messages = [];
  let warn = false;
  if (controlNotice) {
    messages.push(controlNotice.text);
    warn = warn || controlNotice.weakened;
  }
  if (!snapshot && typeof scopeMtimeMs === 'number'
    && Date.now() - scopeMtimeMs > SNAPSHOT_MISSING_SUSPICION_MS) {
    // #938 fix 3 — a missing sidecar under an OLD scope file is not a clean
    // first run; say so instead of silently trusting the re-baseline.
    messages.push(
      'bash-write-verify: no state snapshot found although the wave scope is '
      + `${Math.round((Date.now() - scopeMtimeMs) / 60_000)} min old — a deleted state file `
      + '($TMPDIR/so-bash-write-verify) cannot be ruled out; re-baselined with mtime attribution (#938).',
    );
  }
  if (report.length > 0) {
    messages.push(formatMessage(report, allowedPaths.length));
    warn = true;
  }
  if (messages.length === 0) return; // silence is the common case (0.91 % fire rate)

  emitMessages(messages, warn);
}

// Self-execution guard — run only when invoked directly as a hook, never when
// imported (the test suite imports named exports; a top-level main() then runs
// on import and its .finally(process.exit(0)) trips vitest's process.exit guard,
// surfacing as an unhandled rejection that can cause false-positive tests).
//
// #938 MED-2 (W4 panel): compare the REAL path of BOTH sides. `process.argv[1]`
// carries the path as passed (symlink-bearing under a symlinked plugin install),
// while `import.meta.url` is realpath-resolved by Node's default loader — a bare
// string compare then reads false and silently no-ops the whole scope-detector
// under a symlinked `$CLAUDE_PLUGIN_ROOT`. realpath'ing both sides also survives
// `--preserve-symlinks` (where import.meta.url stays symlinked instead).
function invokedAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    // argv[1] unresolvable (deleted/renamed mid-run) — best-effort raw compare.
    return entry === self;
  }
}
const isMain = invokedAsScript();
if (isMain) {
  // Advisory hook: never block, never surface an error to the tool call.
  main().catch(() => {}).finally(() => process.exit(0));
}
