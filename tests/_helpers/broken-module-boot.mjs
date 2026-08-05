/**
 * tests/_helpers/broken-module-boot.mjs
 *
 * Shared spawn-probe for the #992/#993 late-binding contract across all four
 * deny-capable hooks (destructive-guard, enforce-scope, enforce-commands,
 * sessions-ledger-guard). Builds an `execArgv` (`--import` bootstrap data: URL)
 * that installs a module loader corrupting a chosen repo module at ESM LINK time
 * — the exact failure `armGuard()` + the `git show HEAD:` fallback must render
 * VISIBLE (a GUARD INACTIVE / DEGRADED banner) instead of a silent exit-1 /
 * 0-byte disarm.
 *
 * The break is injected by a loader over a data: URL rather than by damaging the
 * real file: nothing is written to disk, so the hook still takes its REAL import
 * path (an env-var pointing at a broken tmp fixture would test the fixture, not
 * the import).
 *
 * Parametrised over WHICH module basename to break, so every hook drives the
 * identical probe against the module it late-binds:
 *   - destructive-guard → `command-blocker.mjs`
 *   - enforce-commands / enforce-scope / sessions-ledger-guard → whichever
 *     dependency-free module they arm (`io.mjs`, `command-blocker.mjs`, …).
 *
 * Contract-lock note (#993): A2/A3 import `brokenModuleBoot` from HERE — do not
 * fork a per-hook copy. The `moduleBasename` argument is the only knob that
 * differs between hooks.
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.moduleBasename='command-blocker.mjs'] - basename of the
 *   module whose working-tree copy is replaced with unparseable source at load
 *   time (matched via `url.endsWith(basename)`).
 * @param {boolean} [opts.alsoBreakHeadFallback=false] - also corrupt every
 *   data:-URL module, which is how the `git show HEAD:` fallback (it imports the
 *   committed source through a data: URL) is broken in the same run.
 * @param {string|null} [opts.headSource=null] - replace the HEAD copy with a
 *   WELL-FORMED but incomplete module (the shape-check case: a HEAD copy older
 *   than the working tree, missing a newly added export) instead of breaking it
 *   outright. Overrides `alsoBreakHeadFallback`'s default broken source.
 * @param {string|null} [opts.workingSource=null] - replace the WORKING-TREE copy
 *   with this source instead of the unparseable default. Additive: omit it and
 *   the helper behaves exactly as before.
 *
 *   This is the door to the DEGRADED state for a hook whose parse-error door is
 *   closed. `armGuard` degrades on EITHER a parse error OR an `assertShape`
 *   failure, and for `hooks/enforce-commands.mjs` only the second is reachable:
 *   its `hardening` spec has no fallback and imports `command-blocker.mjs`
 *   transitively (via `scope-gate.mjs`), so a SyntaxError there kills bootstrap
 *   FIRST and yields GUARD INACTIVE, never DEGRADED. A working copy that PARSES
 *   but is missing one `requires` export fails only the shape check, so the
 *   fallback runs and the guard arms from HEAD. For that hook (requires:
 *   `commandMatchesBlocked` + `suggestForCommandBlock`):
 *
 *   ```js
 *   brokenModuleBoot({
 *     moduleBasename: 'command-blocker.mjs',
 *     workingSource: 'export function commandMatchesBlocked() { return false; }',
 *     headSource: 'export function commandMatchesBlocked(c, p) { return c.includes(p); }\n'
 *       + 'export function suggestForCommandBlock() { return "use the sanctioned path"; }',
 *   })
 *   ```
 *
 *   `headSource` must then be a VALID module carrying the complete required set —
 *   otherwise the HEAD copy fails its own shape check too and the hook banners
 *   GUARD INACTIVE instead.
 * @returns {string[]} execArgv, e.g. `['--import', 'data:text/javascript;base64,…']`
 */
export function brokenModuleBoot({
  moduleBasename = 'command-blocker.mjs',
  alsoBreakHeadFallback = false,
  headSource = null,
  workingSource = null,
} = {}) {
  // `headSource` (a WELL-FORMED but incomplete module) takes precedence over the
  // outright-broken default that `alsoBreakHeadFallback` selects.
  const headOverride = headSource ?? (alsoBreakHeadFallback ? 'export const broken = ;' : null);
  // `workingSource` opts the working-tree copy out of the unparseable default —
  // the only way to reach `assertShape`'s DEGRADED door (see the param docs).
  const workingOverride = workingSource ?? 'export const broken = ;';
  const loader = `
export async function load(url, context, next) {
  if (url.endsWith(${JSON.stringify(moduleBasename)})) {
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(workingOverride)} };
  }
  ${
    headOverride !== null
      ? `if (url.startsWith('data:text/javascript')) {
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(headOverride)} };
  }`
      : ''
  }
  return next(url, context);
}`;
  const loaderUrl = `data:text/javascript;base64,${Buffer.from(loader, 'utf8').toString('base64')}`;
  const boot = `import { register } from 'node:module';\nregister(${JSON.stringify(loaderUrl)});\n`;
  return ['--import', `data:text/javascript;base64,${Buffer.from(boot, 'utf8').toString('base64')}`];
}
