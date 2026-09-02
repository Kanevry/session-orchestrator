#!/usr/bin/env node
/**
 * post-bash-write-verify.mjs — PostToolUse hook (matcher `Bash`): report
 * working-tree changes a Bash call made OUTSIDE the wave's `allowedPaths` —
 * except a path a PEER session declared through a `peer-session-*` record in
 * the wave's aggregate scope sidecar (#1195), which is named as a peer write.
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
 * With no TRUSTWORTHY snapshot, G4/G5 evaluate as `strict` (#944/#945) — never
 * from the live file. The old live fallback read as a first-call convenience but
 * was a one-command silencer: the sidecar path is `sha1(repoRoot)` and therefore
 * exactly computable, so `rm -f` on it re-creates the "no snapshot" precondition
 * ON DEMAND, not only on the genuine first call. One Bash call could delete the
 * sidecar, write `enforcement: "off"`, and write out of scope — and be judged
 * under the value it had just installed.
 *
 * "Trustworthy" is a statement about the record's CONTENT, not the file's
 * existence. Keyed on `snapshot === null`, the #944 repair closed one state of
 * four at unchanged attacker cost — `rm -f <path>` simply becomes `echo '{}' >
 * <path>`, and `{}` / `{"scopeState":{"hash":"…"}}` were both back to total
 * silence. `trustedScopeState()` requires a `SNAPSHOT_SCHEMA` marker this build
 * writes plus a well-formed `scopeState`, so a forgery has to state the very
 * value it wants unstated. Both effects of that condition — evaluating the call
 * strict AND emitting the lost-state notice — ride the same predicate; splitting
 * them restores the path report while silently dropping the tamper trail.
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
 * 4. **A lost snapshot is named, not assumed benign (#945).** "Sidecar deleted"
 *    and "genuine first call" are bit-identical at the read (`readSnapshot()`
 *    returns null for both), so the difference must come from an out-of-band
 *    clock. Two are consulted: the wave-scope.json mtime (#938) and — because
 *    a `touch` on the scope file neutralises exactly that one — the session
 *    start time from `.orchestrator/current-session.json`. A legitimate first
 *    Bash call sits seconds-to-minutes after session start; a mid-session
 *    `rm -f` sits hours after it, and no `touch` moves that marker.
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
// #1057 — `sessionAgeMs` and its private `clockAgeMs` helper MOVED to the lib so
// hooks/enforce-scope.mjs can read the same session clock without a hook->hook
// import. Re-exported below, so this hook's public surface — and
// tests/hooks/post-bash-write-verify.test.mjs, which imports the named export —
// is unchanged. Two byte-identical copies of a clock is exactly the one-fact-two-
// copies class this repo keeps paying for.
import { sessionAgeMs, PEER_RECORD_PREFIX, isPeerRecordId } from '../scripts/lib/scope-gate.mjs';

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
 * Sidecar schema version, written by `writeSnapshot` on EVERY write and required
 * by `trustedScopeState` before any recorded value is believed.
 *
 * Its job is not versioning — it is making the alt-schema exception forgeable
 * only by writing the thing it wants to hide. The exception exists so that a
 * sidecar left by an OLDER build (no `scopeState` at all) does not make every
 * in-flight session emit once on deploy. Keyed on the ABSENCE of a field, that
 * exception is free to an attacker: `echo '{}' > <sidecar>` reproduces the
 * old-build shape exactly. Keyed on the PRESENCE of a marker only the current
 * build writes, a forgery must supply `schema` AND a plausible `scopeState`
 * containing the enforcement value — i.e. it must state the value it is trying
 * to keep unstated.
 *
 * Cost of the bump: one strict-evaluated call (and, if a clock finds the state
 * old, one advisory line) per repo on the deploy that lands it. Bump this
 * whenever the recorded shape changes; never read a version other than this one
 * as trustworthy.
 */
const SNAPSHOT_SCHEMA = 2;

/**
 * A missing snapshot while the WAVE SCOPE is at least this old is suspicious
 * (#938 fix 3): a genuine first Bash call happens minutes after the coordinator
 * wrote wave-scope.json, whereas a long-running wave whose sidecar suddenly
 * vanished points at `rm -f $TMPDIR/so-bash-write-verify/…`.
 *
 * Known blind spot, and the reason the session-age signal below exists: this
 * clock is the mtime of a file the observed actor can write. `touch
 * .claude/wave-scope.json` (content unchanged → no control notice either)
 * resets the age to zero and neutralises the very heuristic meant to catch the
 * deletion it accompanies (#945).
 */
const SNAPSHOT_MISSING_SUSPICION_MS = 10 * 60 * 1000;

/**
 * A missing snapshot this long after the SESSION started is suspicious (#945).
 *
 * The complement to the constant above, chosen because it is not the mtime of
 * anything the scope-file write touches: `.orchestrator/current-session.json`
 * carries the session start timestamp, so a `touch` on wave-scope.json moves it
 * not at all. The threshold matches the scope-age one — both encode "a genuine
 * first Bash call is minutes away from its trigger, not tens of minutes".
 *
 * Honest about what it is NOT: this marker is a plain file, writable by the
 * same Bash call. It raises the cost of a silent deletion from one `rm` to a
 * second, differently-shaped forgery; it is not tamper-proofing. And like the
 * scope-age signal it produces exactly one false alarm after a `$TMPDIR` purge
 * or a reboot mid-session — the same trade already accepted for #938 fix 3.
 */
const SESSION_AGE_SUSPICION_MS = 10 * 60 * 1000;

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
 * Re-exported for readers of this hook: the prefix that marks an
 * aggregate-sidecar record as a PEER SESSION's declared scope rather than one
 * of this wave's own agents (#1195). The DEFINITION lives in
 * `scripts/lib/scope-gate.mjs`, next to `unionFileScopes`, which must exclude
 * exactly these records from `allowedPaths` for the peer branch below to be
 * reachable at all.
 */
export { PEER_RECORD_PREFIX };

/**
 * The peer-session records of a wave's aggregate scope sidecar.
 *
 * Shape, as written by `scripts/materialize-wave-scope.mjs`
 * (`<state-dir>/filescopes/wave-<N>.scopes.json`): ONE JSON array of
 * `{ id, files }` records — the per-agent files under
 * `<state-dir>/filescopes/wave-<N>/<id>.json` are path STRINGS and are a
 * different artefact (see `docs/scope-collision-guard.md` § 2.2). Only records
 * whose `id` starts with `peer-session-` are returned: those are paths a peer
 * session announced and this session's coordinator carried into the manifest
 * union (`skills/wave-executor/wave-loop.md` § Scope Manifest).
 *
 * Absent, unreadable or malformed sidecar ⇒ `[]`, which restores the exact
 * pre-#1195 behaviour. Never throws.
 *
 * @param {string} stateDir absolute path of the harness state dir (the
 *   directory holding `wave-scope.json`)
 * @param {unknown} wave the manifest's `wave` field
 * @returns {Array<{ id: string, files: string[] }>}
 */
export function readPeerScopeRecords(stateDir, wave) {
  if (typeof stateDir !== 'string' || stateDir === '') return [];
  if (typeof wave !== 'number' || !Number.isInteger(wave) || wave <= 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(
      readFileSync(path.join(stateDir, 'filescopes', `wave-${wave}.scopes.json`), 'utf8'),
    );
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (r) => r && typeof r === 'object'
        && isPeerRecordId(r.id)
        && Array.isArray(r.files),
    )
    .map((r) => ({ id: r.id, files: r.files.filter((f) => typeof f === 'string') }));
}

/**
 * Which peer record — if any — declared this path?
 *
 * Same matcher as `isInScope`, so a peer's declaration is read exactly the way
 * the wave's own `allowedPaths` are.
 *
 * @param {string} relPath
 * @param {Array<{ id: string, files: string[] }>} peerRecords
 * @returns {string|null} the peer record id, or null
 */
export function peerRecordFor(relPath, peerRecords) {
  if (!Array.isArray(peerRecords)) return null;
  for (const record of peerRecords) {
    if (record.files.some((p) => pathMatchesPattern(relPath, p))) return record.id;
  }
  return null;
}

/**
 * Render the peer-write notice (#1195) — deliberately a NOTICE and not part of
 * the violation report: a peer record is EXCLUDED from the union that computes
 * `allowedPaths` (`unionFileScopes`, `scripts/lib/scope-gate.mjs`), so a peer
 * path is outside `allowedPaths` and reaches this branch; naming it as a
 * violation would re-file an agreed peer write as an alarm.
 *
 * @param {string} relPath
 * @param {string} peerId the `peer-session-<id>` record id
 * @returns {string}
 */
export function formatPeerWriteNotice(relPath, peerId) {
  return `bash-write-verify: ${relPath} inside ${peerId} scope — peer write, not a violation`;
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

/**
 * Render the lost-snapshot notice (#938 fix 3, extended by #945), or null when
 * neither clock finds the absence suspicious.
 *
 * Both inputs are ages in ms and both are OPTIONAL: an unknown clock
 * contributes nothing rather than a guess. Two independent clocks are ORed
 * because each has a different blind spot — the scope-file mtime is resettable
 * by the observed actor (`touch`), and the session start time is unknown
 * outside an orchestrated session. Either one alone is evadable; both together
 * cost the actor two forgeries instead of one.
 *
 * Fail-safe direction is SILENCE. Neither clock readable ⇒ null. This hook is
 * warn-only, and noise is precisely what gets a guard switched off — the #915
 * bypass pressure it exists to fight.
 *
 * `reason` names WHICH untrusted state was observed. Both are the same finding —
 * "this call had no trustworthy prior state" — and differ only in what the
 * operator will find on disk when they look: nothing (`absent`), or a file whose
 * contents this build did not write (`untrusted`). Keeping the substring "state
 * snapshot" in both keeps one grep across the pair.
 *
 * @param {object} args
 * @param {number|null} [args.sessionAge] ms since session start, or null
 * @param {number|null} [args.scopeAge]   ms since the wave-scope.json mtime, or null
 * @param {'absent'|'untrusted'} [args.reason] which untrusted state was observed
 * @returns {string|null}
 */
export function formatSnapshotMissingNotice({ sessionAge = null, scopeAge = null, reason = 'absent' } = {}) {
  const reasons = [];
  if (typeof sessionAge === 'number' && Number.isFinite(sessionAge) && sessionAge > SESSION_AGE_SUSPICION_MS) {
    reasons.push(`the session started ${Math.round(sessionAge / 60_000)} min ago`);
  }
  if (typeof scopeAge === 'number' && Number.isFinite(scopeAge) && scopeAge > SNAPSHOT_MISSING_SUSPICION_MS) {
    reasons.push(`the wave scope is ${Math.round(scopeAge / 60_000)} min old`);
  }
  if (reasons.length === 0) return null;
  const head = reason === 'untrusted'
    ? 'a state snapshot exists but carries no scope state this build wrote'
    : 'no state snapshot found';
  return `bash-write-verify: ${head} although ${reasons.join(' and ')} — `
    + 'a deleted or overwritten state file ($TMPDIR/so-bash-write-verify) cannot be ruled out; '
    + 're-baselined with mtime attribution (#938/#945).';
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

/**
 * Milliseconds since the current session started, or null when unknown — the
 * MINIMUM of two independently-written session clocks (#957 finding 2):
 *
 *   - `.orchestrator/current-session.json` `timestamp`, written once per
 *     session by `hooks/on-session-start.mjs`;
 *   - `.orchestrator/session.lock` `started_at`, written by session-start
 *     Phase 1.2 via `scripts/lib/session-lock.mjs` `acquire()`.
 *
 * Both share the two properties that make them the right clocks here: each is
 * `.gitignore`d AND on this hook's own ignore list (see IGNORED_PATH_PATTERNS),
 * so reading one can never turn into reporting it; and neither is touched by
 * any write to wave-scope.json, which is exactly the evasion the scope-mtime
 * clock lost to (#945).
 *
 * ## Why the minimum, and why NOT a staleness cap
 *
 * A single clock reads an age of HOURS whenever its file is a leftover from a
 * previous session on a harness that never rewrote it — firing the lost-snapshot
 * notice on the first Bash call of a session seconds old. The obvious repair, a
 * hard "ignore ages above N hours" cap, is the wrong one: it blinds the guard
 * in precisely the regime it was built for (its own docblock names "a mid-session
 * `rm -f` sits hours after session start"), so a legitimate long deep session
 * ages into the blind spot with no attacker action at all — and it converts a
 * one-sided threshold into a two-sided one, giving a forged timestamp two
 * winning ranges instead of one.
 *
 * `Math.min` fixes the leftover-file case: a session that actually started
 * acquired a FRESH `session.lock`, so the stale clock is outvoted by the young
 * one ⇒ silence. After 14 h of a genuine deep session both clocks read 14 h ⇒
 * the notice fires.
 *
 * ## What min() actually costs an attacker (#957/F2 — corrected)
 *
 * The notice fires only ABOVE the threshold (`sessionAge >
 * SESSION_AGE_SUSPICION_MS`), so silence is bought by a YOUNG value, not an old
 * one. min() therefore narrows the FIRING set (it now takes BOTH clocks reading
 * old) and correspondingly WIDENS the forgeable target set: a young value in
 * EITHER file suffices. The price is still one forgery — but the attacker now
 * chooses which of two files to write, where before there was one. (`max()` is
 * the operator that would cost two forgeries; it was not chosen, because it
 * re-admits the leftover-file false positive this change exists to remove. An
 * earlier draft of this docblock asserted the min() variant cost two — it does
 * not.) Both files are `.gitignore`d and unwritable-by-convention rather than
 * by permission, so this is a real widening, judged an acceptable trade against
 * a guard that otherwise cried wolf on the first Bash call of every session.
 *
 * KNOWN SILENCE RANGE (non-adversarial): `acquire()` writes a fresh `started_at`
 * only when no lock is present — it classifies and returns when one exists
 * (`scripts/lib/session-lock.mjs`), while `forceAcquire()` overwrites
 * unconditionally. A session that released and re-acquired, or took over a stale
 * lock, therefore carries a YOUNG `started_at` against an OLD
 * `current-session.json`; min() picks the young one and the sessionAge clock
 * stays blind for the rest of that session however long it runs. Contrary to an
 * earlier claim here, this change DOES create a new silence range — just not an
 * adversarial one.
 *
 * If that range proves load-bearing, the follow-up worth considering is
 * per-clock evaluation (fire when ANY clock reads old AND is corroborated)
 * rather than a single combined age. That is a behaviour change, not a
 * documentation one, and is deliberately NOT made here.
 *
 * Negative ages are dropped rather than kept (see `clockAgeMs`): without that,
 * a single timestamp in the FUTURE would win the min() and silence the notice
 * unboundedly — a strictly worse range than the two above.
 *
 * Never throws. No clock readable ⇒ null ⇒ silence.
 *
 * @param {string} repoRoot
 * @param {number} [now]
 * @returns {number|null}
 */
export { sessionAgeMs };

/** @returns {object|null} */
function readSnapshot(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The recorded scope state, but ONLY when the whole record is one this build
 * wrote and can act on. Anything else ⇒ null ⇒ the caller evaluates strict.
 *
 * This is the single trust decision of the hook, and it is deliberately about
 * CONTENT, never about the sidecar's existence. Keying it on `snapshot === null`
 * (the #944 shape) closed one state of four at unchanged attacker cost — `rm -f
 * <path>` became `echo '{}' > <path>`, same computable path, same Bash round —
 * and left `{}` and `{"scopeState":{"hash":"…"}}` completely silent. Each clause
 * below therefore names a forgery it refuses:
 *
 *   schema !== SNAPSHOT_SCHEMA   `{}` / any older or hand-written shape
 *   scopeState not an object     `{"schema":2}`
 *   enforcement not a string     `{"schema":2,"scopeState":{"hash":"deadbeef"}}`
 *   hash not a string            a half-written record the control-notice path
 *                                would otherwise compare against
 *
 * Residual, named rather than implied: a forgery that supplies a COMPLETE record
 * (marker, hash, `enforcement: "off"`) is still believed. That costs the actor
 * the one thing the cheap forgeries bought silence to avoid — writing the
 * disabling value where the next call reads it as a prior state and reports the
 * transition. The gap this closes is the free one.
 *
 * @param {object|null} snapshot
 * @returns {{ hash: string, enforcement: string, gateOn?: boolean }|null}
 */
function trustedScopeState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.schema !== SNAPSHOT_SCHEMA) return null;
  const state = snapshot.scopeState;
  if (!state || typeof state !== 'object') return null;
  if (typeof state.enforcement !== 'string') return null;
  if (typeof state.hash !== 'string') return null;
  return state;
}

/**
 * Atomic tmp+rename write; failure is non-fatal (worst case: a re-baseline).
 *
 * The schema marker is stamped HERE, not at the call sites: it is the property
 * that makes a record trustworthy, so the one place that produces records is the
 * one place that may claim it.
 */
function writeSnapshot(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...data, schema: SNAPSHOT_SCHEMA }), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
  // The ONE trust decision (see `trustedScopeState`). Every downstream use of a
  // "previous" value reads this binding, so no code path can accidentally act on
  // a recorded value that failed the check.
  const prevScopeState = trustedScopeState(snapshot);
  // The rest of an untrusted record is untrusted too. `signature` + `paths` drive
  // computeReport's report-once suppression, so a forged
  // `{"signature":"<sig>","paths":["out-of-scope.mjs"]}` would buy silence on the
  // path axis by the same one-line write — the report-once list is a claim about
  // what was ALREADY reported, and this build reported nothing. Untrusted ⇒ the
  // same empty base the absent-sidecar case starts from.
  const prevRecord = prevScopeState === null ? null : snapshot;
  const carriedRecord = prevRecord ?? { signature: null, paths: [] };

  // G3 — no wave scope → nothing defines "outside". #938: if a previous call
  // RECORDED a scope state, the control file's disappearance is itself a
  // control-file change and gets one visible (non-alarming) notice.
  const scopePath = findScopeFile(repoRoot);
  if (!scopePath) {
    if (prevScopeState && prevScopeState.hash !== 'absent') {
      writeSnapshot(snapFile, {
        ...carriedRecord,
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

  let scopeMtimeMs = null;
  try {
    scopeMtimeMs = statSync(scopePath).mtimeMs;
  } catch {
    /* stat failure → computeReport degrades to the silent re-baseline */
  }

  // The lost-snapshot signal is computed HERE — ahead of every early return
  // below (#944/#945). It used to sit at the very end of the reporting path,
  // which made it worthless against the attack it was built for: `enforcement:
  // "off"` returns at G5, so a single Bash call that deleted the sidecar AND
  // disabled the gate skipped the suspicion line as well as the path report.
  // A guard whose "I may have been tampered with" notice is itself behind the
  // gate the tampering opens is not a guard.
  //
  // Every return point reachable from here writes a snapshot, which is what
  // keeps this to ONE line: the next call sees a snapshot and the condition is
  // false. Without that, a genuinely purged $TMPDIR would warn on every Bash
  // call for the rest of the session.
  //
  // The condition is `prevScopeState === null` — no TRUSTWORTHY prior state —
  // not `snapshot === null`. The two effects of that condition (evaluating the
  // call strict, and saying so) must ride the SAME predicate: keyed on file
  // existence, this line stayed silent for `echo '{}' > <sidecar>` while the
  // path report was restored, which drops the tamper trail and leaves a green
  // `toContain('out-of-scope.mjs')` test to say otherwise.
  const missingSnapshotNotice = prevScopeState === null
    ? formatSnapshotMissingNotice({
      sessionAge: sessionAgeMs(repoRoot),
      scopeAge: typeof scopeMtimeMs === 'number' ? Date.now() - scopeMtimeMs : null,
      reason: snapshot === null ? 'absent' : 'untrusted',
    })
    : null;

  // Unparseable control file: nothing to evaluate paths against, but the
  // CHANGE is still reported (#938 vector 1 variant — `echo garbage >
  // wave-scope.json` must not be a free total silencer).
  if (!scope) {
    writeSnapshot(snapFile, { ...carriedRecord, scopeState: currentScopeState });
    const messages = [];
    if (prevScopeState && prevScopeState.hash !== currentScopeState.hash) {
      messages.push(formatControlNotice(relScopePath, prevScopeState, currentScopeState).text);
    }
    // `echo garbage > wave-scope.json` + `rm -f <sidecar>` in one call left
    // prevScopeState null and produced total silence before #945.
    if (missingSnapshotNotice) messages.push(missingSnapshotNotice);
    if (messages.length > 0) emitMessages(messages, true);
    return;
  }

  // G4+G5 — evaluated on the PRE-CALL scope state from the snapshot (#938
  // vector 1); the live values only take effect from the NEXT call on. G4 is ON
  // unless explicitly disabled — the contrast with `bash-write-guard`
  // (=== true) stands: this detector observes the filesystem rather than
  // parsing a command. G5: enforcement:off means nothing is enforced, including
  // advisories.
  //
  // #944/#945 — NO TRUSTWORTHY PRIOR STATE is evaluated as `strict`, never from
  // the live file. There is no live-value fallback left on this path at all,
  // which is the whole repair: the #944 shape kept one (`snapshot !== null` but
  // no usable `scopeState` ⇒ read `currentScopeState`) as an anti-noise carve-out
  // for sidecars from an older build, and that carve-out was keyed on the
  // ABSENCE of a field — free to reproduce with `echo '{}' > <sidecar>`. The
  // carve-out's purpose survives, moved onto `SNAPSHOT_SCHEMA`: an old build's
  // record fails the marker check and is judged strict for ONE call, after which
  // this build's write makes it trustworthy again.
  //
  // Cost, unchanged from #944 and now also paid once per deploy: a repo that
  // legitimately runs `enforcement: "off"` may get ONE advisory line on its
  // first Bash call, then silence from call 2 on (the snapshot now records
  // `off`). One line is the cheaper half of the trade against a guard that a
  // single `echo` can switch off in silence.
  const effEnforcement = prevScopeState ? prevScopeState.enforcement : 'strict';
  const effGateOn = prevScopeState ? prevScopeState.gateOn !== false : true;
  if (!effGateOn || effEnforcement === 'off') {
    // Refresh only the recorded scope state so a later re-enable is honored on
    // the next call; signature/paths stay untouched.
    writeSnapshot(snapFile, { ...carriedRecord, scopeState: currentScopeState });
    // Unreachable while the strict branch above holds (a null prevScopeState
    // never returns here). Kept as the structural guarantee rather than a
    // comment: if a future edit reintroduces any live-value path, the tamper
    // notice still escapes ahead of the gate instead of silently going with it.
    if (missingSnapshotNotice) emitMessages([missingSnapshotNotice], false);
    return;
  }

  const controlNotice = prevScopeState
    && prevScopeState.hash !== 'absent'
    && prevScopeState.hash !== currentScopeState.hash
    ? formatControlNotice(relScopePath, prevScopeState, currentScopeState)
    : null;

  const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];

  const dirtyPaths = readDirtyPaths(repoRoot);
  if (dirtyPaths === null) {
    // git unavailable → no path signal; the control-file and lost-snapshot
    // notices do not depend on git and still stand.
    writeSnapshot(snapFile, { ...carriedRecord, scopeState: currentScopeState });
    const messages = [];
    if (controlNotice) messages.push(controlNotice.text);
    if (missingSnapshotNotice) messages.push(missingSnapshotNotice);
    if (messages.length > 0) emitMessages(messages, Boolean(controlNotice?.weakened));
    return;
  }

  const signature = scopeSignature(allowedPaths);

  const { report, nextSnapshot } = computeReport({
    dirtyPaths,
    allowedPaths,
    // `prevRecord`, not `snapshot`: an untrusted record's report-once list is a
    // forgeable claim about what was already reported (see the binding above).
    snapshot: prevRecord,
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
  // #938 fix 3 + #945 — a missing sidecar that neither clock can call a clean
  // first run is named, not silently trusted. Computed before the G4/G5 gate
  // above so the gate cannot swallow it.
  if (missingSnapshotNotice) messages.push(missingSnapshotNotice);
  // #1195 — a path a PEER session declared (a `peer-session-*` record in this
  // wave's aggregate sidecar) is outside `allowedPaths` because `--union`
  // EXCLUDES peer records when computing it (`unionFileScopes`,
  // `scripts/lib/scope-gate.mjs`) — that exclusion is what keeps this branch
  // reachable. Such a write is agreed, not a bypass. Split it out of the violation report and
  // name it, so the peer's file is countable without being an alarm. Sidecar
  // absent ⇒ `peerRecords` is empty ⇒ every path stays a violation, unchanged.
  const peerRecords = readPeerScopeRecords(path.dirname(scopePath), scope.wave);
  const violations = [];
  for (const relPath of report) {
    const peerId = peerRecordFor(relPath, peerRecords);
    if (peerId) messages.push(formatPeerWriteNotice(relPath, peerId));
    else violations.push(relPath);
  }
  if (violations.length > 0) {
    messages.push(formatMessage(violations, allowedPaths.length));
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
