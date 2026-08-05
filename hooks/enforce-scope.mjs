#!/usr/bin/env node
/**
 * enforce-scope.mjs — PreToolUse hook: block Edit/Write/MultiEdit outside allowed wave paths.
 *
 * Replaces enforce-scope.sh (87-line Bash). Part of v3.0.0 Windows-native migration.
 * Issue: github.com/Kanevry/session-orchestrator/issues/137
 *
 * Decision flow (8 gates + one pre-gate, early-exit):
 *   G1  tool filter — only Edit/Write/MultiEdit are gated
 *   G2  file_path present + string
 *   G3  wave-scope.json exists
 *   G4  path-guard gate enabled
 *   G5  enforcement != "off"
 *   G5b (#792) allowlist-first: an EXPLICIT absolute allowedPaths entry that
 *       matches the fully realpath-resolved candidate → allow, BEFORE G6.
 *       Runs before G6 so a deliberate out-of-repo grant (e.g. a vault path)
 *       is reachable at all — G6 would otherwise deny every out-of-repo path
 *       without ever consulting allowedPaths. See matchesAbsoluteAllowlist.
 *   G6  resolved path inside project root
 *   G7  relative path matches an allowedPaths pattern
 *   G8  (all passed) → allow
 *
 * Exit codes:  0 = allow   2 = deny
 *
 * SECURITY notes (inline refs):
 *   REQ-01  top-level try/catch → emitDeny on unexpected error (fail-closed)
 *   REQ-03  realpath(dirname) to resolve symlinks; ENOENT → fall back to path.resolve
 *   REQ-04  relativeFromRoot() === null → deny as outside-root
 *   REQ-05  normalize path separators to "/" before pathMatchesPattern (Windows compat)
 *   REQ-06  relative file_path resolved against projectRoot, not process.cwd()
 *   REQ-08  wave-scope.json read once; parsed object passed to all gate checks
 *   REQ-09  (#792) G5b out-of-repo carveout is structurally safe: RELATIVE
 *           allowedPaths entries can NEVER match an out-of-repo path (the
 *           isAbsolute filter drops them), so `**` / `../**` cannot be used to
 *           escape the repo; only entries that are themselves absolute match,
 *           and only against their own literal (canonical/realpath) subtree.
 *           Empty absolute set → the pre-gate is inert (byte-identical to the
 *           pre-#792 behaviour).
 *
 * Coordinator carveout (#245): a short, explicit list of harness-owned files
 * bypasses Gate 7 (allowedPaths glob) — specifically STATE.md across all platform
 * state dirs and the wave-scope.json manifest itself. Coordinators write these
 * between waves as part of the harness protocol; subjecting them to per-wave
 * allowedPaths would force every wave plan to re-list harness infrastructure.
 * Project-root containment (Gate 6) and enforcement-off (Gate 5) still apply.
 * No wildcards — exact string match only.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('enforce-scope')) process.exit(0);

// ---------------------------------------------------------------------------
// #993 — late-bound repo dependencies
//
// These used to be STATIC imports. A SyntaxError in any of them failed at ESM
// LINK time, before the first statement here ran: node exited 1 with 0 bytes on
// stdout, and the `main().catch(...)` handler at the bottom of this file was
// structurally unreachable. Under the exit-0 PreToolUse protocol (#906) that
// crash is, on the only decision-bearing channel, INDISTINGUISHABLE from an
// explicit `emitAllow()` — the guard failed open and SILENTLY. This is the
// sibling defect #992 fixed for pre-bash-destructive-guard; #993 generalises the
// same repair here.
//
// Binding them late (dynamic `import()` inside `bootstrap()`, below) turns that
// link-time crash into a catchable runtime error, which is what makes the
// GUARD INACTIVE banner in `_lib/guard-source-loader.mjs` reachable at all.
//
// BANNER-ONLY (#993 D1): this hook consumes ZERO command-blocker symbols, so no
// module here opts into the `git show HEAD:` fallback — every load failure
// degrades straight to GUARD INACTIVE, never DEGRADED.
//
// `profile-gate.mjs` and `node:*` builtins stay static — they cannot be the
// broken repo module.
// ---------------------------------------------------------------------------
/** @type {typeof import('../scripts/lib/io.mjs').readStdin} */ let readStdin;
/** @type {typeof import('../scripts/lib/io.mjs').emitAllow} */ let emitAllow;
/** @type {typeof import('../scripts/lib/io.mjs').emitDeny} */ let emitDeny;
/** @type {typeof import('../scripts/lib/io.mjs').emitWarn} */ let emitWarn;
let isPathInside;
let relativeFromRoot;
let resolveProjectDir;
let findScopeFile;
let pathMatchesPattern;
let suggestForScopeViolation;
let readJson;

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/** This hook's name — threaded into the guard banner (#993: no hard-wired literal). */
const HOOK_NAME = 'enforce-scope';

/**
 * The consequence block spliced VERBATIM into the GUARD INACTIVE banner (#993),
 * naming the enforcement this hook's outage stops applying. No `degraded` block:
 * this hook has no headFallback module, so it can never DEGRADE — only go INACTIVE.
 */
const GUARD_CONSEQUENCE = {
  inactive: [
    '    Consequence: Edit/Write/MultiEdit scope enforcement is OFF — writes',
    '    outside the wave allowedPaths (and outside the project root) are NOT',
    '    being blocked. This is a BROKEN GUARD, not a policy decision — do not',
    '    route around it, repair it.',
  ],
};

/**
 * Project dir for banner keying, resolved WITHOUT `platform.mjs` — that module
 * is one of the ones that may have failed to load.
 *
 * @returns {string}
 */
function bannerProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Bind every repo dependency late, making a load failure VISIBLE (GUARD INACTIVE
 * banner) instead of a silent exit-1 / 0-byte disarm. Throws on any load failure;
 * the entry-point catch banners. No entry opts into headFallback — this hook is
 * banner-only (#993 D1).
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  const lib = (...seg) => pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', ...seg)).href;

  const { armGuard } = await import('./_lib/guard-source-loader.mjs');
  const { modules } = await armGuard(
    {
      io: { specifier: lib('io.mjs') },
      pathUtils: { specifier: lib('path-utils.mjs') },
      platform: { specifier: lib('platform.mjs') },
      hardening: { specifier: lib('hardening.mjs') },
      common: { specifier: lib('common.mjs') },
    },
    {
      hookName: HOOK_NAME,
      repoRoot: PLUGIN_ROOT,
      projectDir: bannerProjectDir(),
      consequence: GUARD_CONSEQUENCE,
    }
  );

  ({ readStdin, emitAllow, emitDeny, emitWarn } = modules.io);
  ({ isPathInside, relativeFromRoot } = modules.pathUtils);
  ({ resolveProjectDir } = modules.platform);
  ({ findScopeFile, pathMatchesPattern, suggestForScopeViolation } = modules.hardening);
  ({ readJson } = modules.common);
}

async function main() {
  // SECURITY-REQ-01: null-guard empty stdin — treat as allow (no input = not a real hook call)
  const input = await readStdin();
  if (!input) return emitAllow();

  const toolName = input.tool_name;
  const filePath = input?.tool_input?.file_path;

  // Gate 1: only Edit, Write, and MultiEdit are path-gated
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') return emitAllow();

  // Gate 2: file_path must be a non-empty string
  if (!filePath || typeof filePath !== 'string') return emitAllow();

  const projectRootRaw = resolveProjectDir();

  // Resolve symlinks in the project root itself so that realpath(file) comparisons
  // are consistent. On macOS /tmp → /private/tmp; mismatches would cause false denials.
  let projectRoot;
  try {
    projectRoot = await fs.realpath(projectRootRaw);
  } catch {
    projectRoot = projectRootRaw;
  }

  // Gate 3: no wave-scope.json → nothing to enforce
  const scopePath = findScopeFile(projectRoot);
  if (!scopePath) return emitAllow();

  // SECURITY-REQ-08: read scope file once; pass parsed object to all subsequent checks
  let scope;
  try {
    scope = await readJson(scopePath);
  } catch {
    scope = {};
  }

  const enforcement = scope.enforcement ?? 'strict';
  const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];
  const gatesEnabled = scope.gates?.['path-guard'] !== false;

  // Gate 4: path-guard gate explicitly disabled
  if (!gatesEnabled) return emitAllow();

  // Gate 5: enforcement is turned off
  if (enforcement === 'off') return emitAllow();

  // SECURITY-REQ-06: resolve relative file_path against projectRoot, not process.cwd()
  const absPathInput = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectRoot, filePath);

  // SECURITY-REQ-03: resolve symlinks to prevent symlink-escape.
  // Strategy:
  //   1. Try fs.realpath on the file itself — follows symlinks (blocks `src/evil → /etc/passwd`).
  //   2. On ENOENT (file doesn't exist yet — common for Write), walk up to the
  //      nearest existing ancestor, realpath it, then re-attach the non-existent
  //      suffix. Keeps projectRoot and resolvedPath in the same canonical namespace
  //      (e.g. both under /private/tmp on macOS).
  //   3. Any non-ENOENT fs error → fail-closed.
  let resolvedPath;
  try {
    resolvedPath = await fs.realpath(absPathInput);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return emitDeny(
        'Scope check failed — unable to resolve file path',
        `Internal: ${err?.code ?? 'unknown'}`,
      );
    }
    // File doesn't exist yet — walk up to nearest existing ancestor.
    try {
      const segments = [path.basename(absPathInput)];
      let ancestor = path.dirname(absPathInput);
      while (true) {
        try {
          const realAncestor = await fs.realpath(ancestor);
          segments.reverse();
          resolvedPath = path.join(realAncestor, ...segments);
          break;
        } catch (e) {
          if (e?.code !== 'ENOENT') throw e;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) {
            // Hit filesystem root (should not occur for paths under projectRoot).
            resolvedPath = absPathInput;
            break;
          }
          segments.push(path.basename(ancestor));
          ancestor = parent;
        }
      }
    } catch (e) {
      return emitDeny(
        'Scope check failed — unable to resolve file path',
        `Internal: ${e?.code ?? 'unknown'}`,
      );
    }
  }

  // Gate 5b (#792): allowlist-first for explicit absolute (out-of-repo) grants.
  // An EXPLICIT absolute allowedPaths entry (e.g. a coordinator-granted vault
  // path) is structurally unreachable under Gate 6, which denies every
  // out-of-repo path before allowedPaths is ever consulted. Honour such grants
  // here — matching ONLY absolute entries against the fully realpath-resolved
  // candidate, so relative entries can never be used to escape the repo (REQ-09).
  if (matchesAbsoluteAllowlist(resolvedPath, allowedPaths)) return emitAllow();

  // Gate 6: path must be inside the project root
  if (!isPathInside(resolvedPath, projectRoot)) {
    const reason = `Scope violation: path outside project root`;
    const suggestion = suggestForScopeViolation(filePath, allowedPaths.join(', '));
    return enforcement === 'strict'
      ? emitDeny(reason, suggestion)
      : emitWarn(`${reason} — ${suggestion}`);
  }

  // Compute the relative path from project root to the resolved file path
  const relPath = relativeFromRoot(projectRoot, resolvedPath);

  // SECURITY-REQ-04: null return means outside root — deny rather than pass null to pathMatchesPattern
  if (relPath === null) {
    const reason = `Scope violation: '${filePath}' outside project root`;
    const suggestion = suggestForScopeViolation(filePath, allowedPaths.join(', '));
    return enforcement === 'strict'
      ? emitDeny(reason, suggestion)
      : emitWarn(`${reason} — ${suggestion}`);
  }

  // SECURITY-REQ-05: normalize Windows path separators to '/' before glob matching
  const normalizedRel = relPath.split(path.sep).join('/');

  // Coordinator carveout (#245): exact-path allowlist for harness-owned files.
  // STATE.md and wave-scope.json are written by the coordinator between waves;
  // per-wave allowedPaths lists should not need to enumerate harness infrastructure.
  if (isCoordinatorCarveout(normalizedRel, projectRoot, scopePath)) {
    return emitAllow();
  }

  // Gate 7: check normalised relative path against each allowedPaths pattern
  const matched = allowedPaths.some((pattern) => pathMatchesPattern(normalizedRel, pattern));

  if (!matched) {
    const reason = `Scope violation: '${normalizedRel}' not in allowed paths [${allowedPaths.join(', ')}]`;
    const suggestion = suggestForScopeViolation(normalizedRel, allowedPaths.join(', '));
    return enforcement === 'strict'
      ? emitDeny(reason, suggestion)
      : emitWarn(`${reason} — ${suggestion}`);
  }

  // Gate 8 / all gates passed → allow
  return emitAllow();
}

const COORDINATOR_CARVEOUT_PATHS = Object.freeze([
  '.claude/STATE.md',
  '.codex/STATE.md',
  '.cursor/STATE.md',
  '.pi/STATE.md',
]);

/**
 * Returns true if the given project-relative, forward-slash-normalized path is
 * one of the harness-owned files the coordinator writes between waves.
 *
 * Matches STATE.md across all platform state dirs and the wave-scope.json the
 * hook just read (its exact, resolved relative path — no wildcard). Exact
 * string comparison only; any glob semantics belong in Gate 7.
 */
function isCoordinatorCarveout(normalizedRel, projectRoot, scopePath) {
  if (COORDINATOR_CARVEOUT_PATHS.includes(normalizedRel)) return true;
  const scopeRel = relativeFromRoot(projectRoot, scopePath);
  if (scopeRel === null) return false;
  return scopeRel.split(path.sep).join('/') === normalizedRel;
}

/**
 * #792: Honour EXPLICIT absolute allowedPaths entries that point OUTSIDE the repo
 * (a deliberate coordinator grant, e.g. "/Users/x/Projects/vault/**").
 * Such entries are structurally unreachable under the default relative-only
 * matcher because Gate 6 denies out-of-repo paths first, and Gate 7 only ever
 * matches the ROOT-RELATIVE candidate (an absolute pattern can never match it).
 *
 * SECURITY (REQ-09): matches ONLY entries that are themselves absolute, against
 * the fully realpath-resolved candidate — so RELATIVE entries (`**`, `../**`)
 * can NEVER be used to escape the repo. When no absolute entry exists the helper
 * returns false and the caller falls through to Gate 6 unchanged (inert pre-gate).
 * An absolute entry matches only its own literal (canonical/realpath) subtree;
 * the operator is responsible for supplying a canonical absolute path.
 *
 * @param {string} resolvedPath — fully realpath-resolved candidate (absolute)
 * @param {string[]} allowedPaths — raw allowedPaths array from wave-scope.json
 * @returns {boolean}
 */
function matchesAbsoluteAllowlist(resolvedPath, allowedPaths) {
  const abs = allowedPaths.filter((p) => typeof p === 'string' && path.isAbsolute(p));
  if (abs.length === 0) return false;
  const normalizedAbs = resolvedPath.split(path.sep).join('/');
  return abs.some((pat) => pathMatchesPattern(normalizedAbs, pat.split(path.sep).join('/')));
}

// ---------------------------------------------------------------------------
// Entry point (#993)
//
// TWO distinct failure classes, two distinct handlers — do NOT merge them:
//
//   1. LOAD failure (`bootstrap()` throws): the guard never armed. Under the
//      exit-0 protocol a bare exit-1 crash with 0 bytes of stdout is, on the
//      only decision-bearing channel, indistinguishable from an allow. Now it
//      exits 0 (still fail-OPEN — a broken module must not brick the session,
//      and emitDeny itself may be the module that failed to load) but SAYS SO:
//      GUARD INACTIVE. Banner-only — no headFallback module here (#993 D1).
//   2. RUNTIME failure inside `main()`: pre-existing behaviour, unchanged. The
//      guard armed and then tripped over a specific path; that fails CLOSED via
//      emitDeny (SECURITY-REQ-01). The two paths MUST stay separate.
// ---------------------------------------------------------------------------
try {
  await bootstrap();
} catch (loadError) {
  try {
    const { emitGuardInactiveBanner } = await import('./_lib/guard-source-loader.mjs');
    // hookName is threaded explicitly (#993 — no hard-wired literal in the loader).
    emitGuardInactiveBanner({ hookName: HOOK_NAME, error: loadError, consequence: GUARD_CONSEQUENCE });
  } catch {
    // Last resort: even the banner helper failed to load. Emit unconditionally —
    // repeated noise beats a silent disarm.
    process.stderr.write(
      '🚨 enforce-scope: GUARD INACTIVE — module load failed ' +
        `(${String(loadError?.message || loadError).split('\n')[0]}). ` +
        'Edit/Write/MultiEdit scope enforcement is OFF. See issue #993.\n'
    );
  }
  process.exit(0); // fail-open, but no longer fail-silent
}

// SECURITY-REQ-01 (fail-closed): any unhandled rejection → structured deny, never bare exit 1
main().catch((e) => {
  emitDeny(
    'Internal hook error — request blocked for safety',
    `${e?.message ?? String(e)}`,
  );
});
