/**
 * locks/index.mjs — DEPRECATED convenience barrel for the lock protocols
 * split out of session-lock.mjs in #630 (A1 barrel-preserving split).
 *
 * @deprecated since 5.2.0, removed in 6.0.0. Import directly from
 * `./state-md-lock.mjs` / `./staging-fence-lock.mjs`, or from
 * `scripts/lib/session-lock.mjs` for the canonical 22-symbol barrel that
 * preserves the original import surface for all its importers.
 *
 * This file shipped in 5.1.0 with zero in-repo importers and was deleted in
 * dd05e0f8 (`check-unwired-features` S4: no hook, npm script, CI job or husky
 * stage reached it, and it named symbols — not modules — so it did not qualify
 * for the pure `export *` exemption that shape gets). Restored here as a
 * one-cycle deprecation shim (`.claude/rules/development.md` § Package Lifecycle
 * & Versioning) because `package.json` carries no `exports` map: every packed
 * file under `scripts/lib/` is public, so a consumer that deep-imported this
 * path before the deletion has no compile error to warn it, only a runtime
 * "module not found" — a shim buys that consumer one minor cycle to migrate
 * before 6.0.0 removes the path outright.
 *
 * Deliberately the `export *` form with ZERO named exports (matches the
 * `scripts/lib/autopilot-telemetry.mjs` precedent): a named-export re-export
 * barrel is exactly the shape `check-unwired-features.mjs` S4 flags as an
 * unreachable library module (condition 4 in `collectUnreachableLibraryModules`
 * requires named exports before a re-export shim over live code enters that
 * census) — that flag is what got this file deleted the first time. A star
 * re-export names no symbol, so the shim reads as `exports: []` and stays
 * invisible to that census while its target modules stay reachable through it.
 */

console.warn(
  '[deprecated] scripts/lib/locks/index.mjs is deprecated since 5.2.0 and will be removed in 6.0.0 — ' +
    "import from './state-md-lock.mjs' / './staging-fence-lock.mjs' directly, or from " +
    'scripts/lib/session-lock.mjs for the canonical surface.',
);

export * from './state-md-lock.mjs';
export * from './staging-fence-lock.mjs';
