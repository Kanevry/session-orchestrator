#!/usr/bin/env node
/**
 * pre-tool-state-md-path-guard.mjs — PreToolUse `Edit|Write|MultiEdit` + `Bash`
 * hook: denies writing `STATE.md` under `.orchestrator/` (GitLab #1790).
 *
 * STATE.md lives in the platform state dir (`resolveStateDir()` in
 * `scripts/lib/platform.mjs`: `.claude` / `.codex` / `.cursor` / `.pi`), never in
 * `.orchestrator/`, which holds the session lock and metrics. Two measured
 * sessions (2026-10-24) wrote their wave plan to `<repo>/.orchestrator/STATE.md`
 * — one through the Write tool, one through a Bash heredoc — and `/close`, which
 * reads `.claude/STATE.md`, recorded a false `closed-without-plan`. No legitimate
 * writer of `.orchestrator/STATE.md` exists (0 tracked files; test fixtures write
 * through `fs`, which hooks never see).
 *
 * ## Fleet safety — allow is the default, deny is the exception
 *
 * This hook runs on EVERY Edit/Write/MultiEdit/Bash call of every session on the
 * host. Only a positively identified `.orchestrator/STATE.md` target is denied.
 * Every internal failure — empty or unparsable stdin, a missing `tool_input`, an
 * unknown `tool_name`, a repo module that fails to import, a parser throw — exits
 * 0 with no decision (allow). Repo modules are imported lazily inside `main()` so
 * a broken one lands in the fail-open catch, not an ESM link-time crash.
 *
 * `SO_STATE_DIR=.orchestrator` (the state-dir override read by
 * `stateArtifactCandidates()` in `scripts/lib/state-md/frontmatter-mutators.mjs`)
 * makes `.orchestrator/STATE.md` the real state file, so it allows.
 *
 * ## Named limits (BV-004 ceiling — revisit if a third incident uses a route below)
 *
 * The Bash side reuses `extractBashWriteTargets()` (`scripts/lib/scope-gate.mjs`)
 * instead of a second parser. Measured with that parser: `cat > … <<EOF`,
 * `cat >> …` and `tee …` are caught; reads (`head …`) return no target. NOT
 * detected: `cp <src> .orchestrator/STATE.md`, a bare `sed -i … .orchestrator/
 * STATE.md`, `mv`, writes from inside a script or interpreter (`node -e`,
 * `bash -c "…"`), a target built from any variable other than `$PWD`, and
 * `cd .orchestrator && … > STATE.md`. Since #1793 the shared parser also catches
 * `&>` / `&>>`, the filename form `>& …` / `N>& …`, a `"$PWD/…"` target
 * (resolved against the payload `cwd`) and an unquoted `~/…` target (resolved
 * against the home directory). `$PWD/` and `~/` are left UNRESOLVED (not
 * detected) whenever the shell's value is not provable: after a statement that
 * may move the cwd (`cd`, `pushd`, `popd`, `PWD=`, `export PWD`, `source`, `.`,
 * `eval`) or rebind HOME, for a quoted `$PWD/…` when the command holds any `'`,
 * for any quoted `~…`, and when the command holds any backslash — the parser
 * never reports a path the shell would not write.
 * A payload over 1 MB fails open (`readStdin` rejects it). The match is
 * case-insensitive (macOS/Windows filesystems are), so on Linux a distinct
 * `.Orchestrator/state.md` is denied too — fails closed; override below.
 *
 * ## Platforms
 *
 * Claude Code: both matchers. Cursor and Pi reach it through their bridges
 * (`scripts/lib/cursor-hook-bridge.mjs`, `scripts/lib/pi-hook-bridge.mjs`), which
 * rewrite native tool names to `Edit`/`Write`/`MultiEdit`/`Bash`. Codex: the Bash
 * side is wired in `hooks/hooks-codex.json` (enforcing row in
 * `tests/hooks/codex-bash-guards-wiring.test.mjs`); the edit side is a documented
 * gap in `scripts/lib/validate/check-hooks-symmetry.mjs` (Codex edits through
 * `apply_patch`, a tool name this hook never matches).
 *
 * ## Override
 *
 *   SO_DISABLED_HOOKS=pre-tool-state-md-path-guard   (session-level)
 *   SO_HOOK_PROFILE=minimal|off
 *
 * Documented here only, never in the deny reason: the fleet does not advertise
 * hook bypasses to the model, and the one legitimate case
 * (`SO_STATE_DIR=.orchestrator`) already allows without it.
 */

import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';

/** This hook's name — the `SO_DISABLED_HOOKS` key. */
const HOOK_NAME = 'pre-tool-state-md-path-guard';

/** File tools judged by `tool_input.file_path`. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * `STATE.md` directly inside a `.orchestrator` directory, at the END of a
 * normalized (forward-slash) path. Anchored on a separator or the start so
 * `x.orchestrator/STATE.md` does not match. Group 1 keeps the prefix for the
 * suggested replacement path.
 */
const STATE_UNDER_ORCHESTRATOR_RE = /(^|\/)\.orchestrator\/STATE\.md$/i;

/** Upper bound on the echoed target in the deny reason (emitDeny clamps the whole reason). */
const TARGET_ECHO_MAX = 200;

/**
 * Normalize a path-like string: backslashes to `/`, then fold `..`, `//`, `./`.
 *
 * @param {unknown} p
 * @returns {string|null} the normalized path, or null for a non-string / empty value
 */
function normalizeTarget(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  return path.posix.normalize(p.replace(/\\/g, '/'));
}

/**
 * Does this target name `STATE.md` inside `.orchestrator/`?
 *
 * @param {unknown} target
 * @returns {boolean}
 */
export function isOrchestratorStateMd(target) {
  const normalized = normalizeTarget(target);
  return normalized !== null && STATE_UNDER_ORCHESTRATOR_RE.test(normalized);
}

/**
 * The path the write should have gone to: the same parent directory, with
 * `.orchestrator/STATE.md` replaced by `<stateDir>/STATE.md`. A relative target
 * stays relative (it resolves against the directory the command writes from).
 *
 * @param {string} target — a path for which {@link isOrchestratorStateMd} is true
 * @param {string} stateDir — e.g. `.claude`
 * @returns {string}
 */
export function correctStatePath(target, stateDir) {
  return normalizeTarget(target).replace(STATE_UNDER_ORCHESTRATOR_RE, `$1${stateDir}/STATE.md`);
}

/**
 * Is the SO_STATE_DIR override pointing at `.orchestrator`? Then that path IS the
 * state file. Same normalization as `stateArtifactCandidates()` (trim), plus
 * trailing-slash and `./` folding.
 *
 * @returns {boolean}
 */
function stateDirOverrideIsOrchestrator() {
  const override = (process.env.SO_STATE_DIR ?? '').trim();
  if (!override) return false;
  return path.posix.normalize(override.replace(/\\/g, '/')).replace(/\/+$/, '') === '.orchestrator';
}

/**
 * Collect the `.orchestrator/STATE.md` targets of this payload (empty = allow).
 *
 * @param {Record<string, unknown>} input
 * @returns {Promise<string[]>}
 */
async function findViolations(input) {
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return [];

  if (FILE_TOOLS.has(input.tool_name)) {
    return isOrchestratorStateMd(toolInput.file_path) ? [toolInput.file_path] : [];
  }
  if (input.tool_name === 'Bash') {
    const command = toolInput.command;
    if (typeof command !== 'string' || !/STATE\.md/i.test(command)) return [];
    const { extractBashWriteTargets } = await import('../scripts/lib/scope-gate.mjs');
    const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
    return extractBashWriteTargets(command, { cwd }).filter(isOrchestratorStateMd);
  }
  return [];
}

/**
 * Read the payload and decide. Every non-violation outcome returns without
 * output (exit 0 = no decision = allow).
 *
 * @returns {Promise<void>}
 */
async function main() {
  const { readStdin, emitDeny } = await import('../scripts/lib/io.mjs');

  let input;
  try {
    input = await readStdin();
  } catch {
    return; // unparsable / oversized / timed-out stdin → allow
  }
  if (!input || typeof input !== 'object') return;
  if (stateDirOverrideIsOrchestrator()) return;

  const violations = await findViolations(input);
  if (violations.length === 0) return;

  const { resolveStateDir } = await import('../scripts/lib/platform.mjs');
  const stateDir = resolveStateDir();
  const target = violations[0];
  const shown = target.length > TARGET_ECHO_MAX ? `${target.slice(0, TARGET_ECHO_MAX)}…` : target;
  const relativeNote = path.posix.isAbsolute(normalizeTarget(target)) ? '' : ' (relative to the directory the command writes in)';

  emitDeny(
    [
      `${input.tool_name}: writing STATE.md under .orchestrator/ blocked: '${shown}'`,
      `Write it to the platform state dir instead: ${correctStatePath(target, stateDir)}${relativeNote}`,
      `.orchestrator/ holds the session lock and metrics, not STATE.md (#1790).`,
    ].join('\n'),
  );
}

// Entry guard (#1393): run only as the node script the harness execs — a bare
// `import()` must run no handler and must not exit the importing process.
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook(HOOK_NAME)) process.exit(0);

  // Fail-OPEN on any internal error: exit 0 with no stdout is "no decision".
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      process.stderr.write(`⚠ ${HOOK_NAME}: internal error — ${e?.message || e}\n`);
      process.exit(0);
    });
}
