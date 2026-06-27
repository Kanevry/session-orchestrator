/**
 * hardening.mjs — re-export barrel for the hardening primitives.
 *
 * The original 691-line module bundled THREE structurally-independent concerns.
 * They now live in dedicated modules (Epic A4 split); this file is a pure
 * re-export barrel that preserves the original import surface (all 11 symbols)
 * so existing importers keep working UNCHANGED:
 *   - hooks/enforce-commands.mjs, hooks/enforce-scope.mjs,
 *     hooks/post-edit-validate.mjs, hooks/pre-bash-destructive-guard.mjs,
 *     hooks/pre-bash-memory-propose-audit.mjs, hooks/wave-scope-commit-guard.mjs
 *   - scripts/lib/io.mjs, scripts/lib/pre-dispatch-check.mjs,
 *     scripts/lib/worktree-freshness.mjs
 *
 * Concern split:
 *   A) Env / runtime checks                → ./env-check.mjs
 *   B) Scope / pattern primitives          → ./scope-gate.mjs
 *   C) Command-blocking tokenizer + matcher → ./command-blocker.mjs
 *
 * The new modules MUST NOT import from this barrel (would cycle).
 *
 * Layering: hook-safe — pure functions only; no I/O at import time;
 * ESM-pure for fast hook hot-paths. Hooks (under `hooks/`) import from
 * this lib; this lib MUST NOT reverse-import from `hooks/`. Cross-cutting
 * invariant for all exports below — see #554 A2.
 *
 * Part of v3.0.0 migration (Epic #124, issue #135).
 */

// A) Env / runtime checks
export { assertNodeVersion, assertDepInstalled, checkEnvironment } from './env-check.mjs';

// B) Scope / pattern primitives
export {
  findScopeFile,
  getEnforcementLevel,
  gateEnabled,
  pathMatchesPattern,
  suggestForScopeViolation,
} from './scope-gate.mjs';

// C) Command-blocking tokenizer + matcher
export { tokenizeCommand, commandMatchesBlocked, suggestForCommandBlock } from './command-blocker.mjs';
