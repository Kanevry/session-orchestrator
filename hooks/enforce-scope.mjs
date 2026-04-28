#!/usr/bin/env node
/**
 * enforce-scope.mjs — PreToolUse hook: block Edit/Write outside allowed wave paths.
 *
 * Replaces enforce-scope.sh (87-line Bash). Part of v3.0.0 Windows-native migration.
 * Issue: gitlab.gotzendorfer.at/infrastructure/session-orchestrator#137
 *
 * Decision flow (8 gates, early-exit):
 *   G1  tool filter — only Edit/Write are gated
 *   G2  file_path present + string
 *   G3  wave-scope.json exists
 *   G4  path-guard gate enabled
 *   G5  enforcement != "off"
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

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('enforce-scope')) process.exit(0);

import { readStdin, emitAllow, emitDeny, emitWarn } from '../scripts/lib/io.mjs';
import { isPathInside, relativeFromRoot } from '../scripts/lib/path-utils.mjs';
import { resolveProjectDir } from '../scripts/lib/platform.mjs';
import {
  findScopeFile,
  pathMatchesPattern,
  suggestForScopeViolation,
} from '../scripts/lib/hardening.mjs';
import { readJson } from '../scripts/lib/common.mjs';

async function main() {
  // SECURITY-REQ-01: null-guard empty stdin — treat as allow (no input = not a real hook call)
  const input = await readStdin();
  if (!input) return emitAllow();

  const toolName = input.tool_name;
  const filePath = input?.tool_input?.file_path;

  // Gate 1: only Edit and Write are path-gated
  if (toolName !== 'Edit' && toolName !== 'Write') return emitAllow();

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

// SECURITY-REQ-01 (fail-closed): any unhandled rejection → structured deny, never bare exit 1
main().catch((e) => {
  emitDeny(
    'Internal hook error — request blocked for safety',
    `${e?.message ?? String(e)}`,
  );
});
