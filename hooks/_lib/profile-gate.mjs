/**
 * profile-gate.mjs — runtime hook control via SO_HOOK_PROFILE + SO_DISABLED_HOOKS.
 *
 * Issue #211. Allows operators to disable hook handlers at runtime without editing
 * hooks.json or settings files.
 *
 * Env vars:
 *   SO_HOOK_PROFILE      "full" | "minimal" | "off"  (default: "full")
 *   SO_DISABLED_HOOKS    comma-separated hook names to disable individually
 *
 * Profile mapping:
 *   full    — all hooks enabled (default, preserves existing behaviour)
 *   minimal — only on-session-start + pre-bash-destructive-guard enabled
 *   off     — no hooks enabled
 *
 * SO_DISABLED_HOOKS overrides the profile for the listed names.
 * Unknown profiles default to "full" and emit a single stderr warning.
 *
 * Usage in each hook handler (at the very top, before any other logic):
 *   import { shouldRunHook } from './_lib/profile-gate.mjs';
 *   if (!shouldRunHook('on-session-start')) process.exit(0);
 */

/** Hook names enabled in the "minimal" profile. */
const MINIMAL_HOOKS = new Set([
  'on-session-start',
  'pre-bash-destructive-guard',
]);

/** Valid profile names. */
const VALID_PROFILES = new Set(['full', 'minimal', 'off']);

/**
 * Warn once per process (hook subprocess is single-use, so this is effectively
 * warn-once per invocation).
 */
let _unknownProfileWarned = false;

/**
 * Resolve the active profile from SO_HOOK_PROFILE.
 * Unknown values → "full" + single stderr warning.
 *
 * @returns {"full"|"minimal"|"off"}
 */
function resolveProfile() {
  const raw = (process.env.SO_HOOK_PROFILE ?? '').trim().toLowerCase();
  if (!raw || raw === 'full') return 'full';
  if (VALID_PROFILES.has(raw)) return /** @type {"full"|"minimal"|"off"} */ (raw);

  // Unknown profile — warn once, fall back to full
  if (!_unknownProfileWarned) {
    process.stderr.write(
      `⚠ SO_HOOK_PROFILE="${process.env.SO_HOOK_PROFILE}" is unknown — defaulting to "full". ` +
      `Valid values: full | minimal | off\n`
    );
    _unknownProfileWarned = true;
  }
  return 'full';
}

/**
 * Parse SO_DISABLED_HOOKS into a Set of lowercase hook names.
 *
 * @returns {Set<string>}
 */
function resolveDisabledHooks() {
  const raw = process.env.SO_DISABLED_HOOKS ?? '';
  if (!raw.trim()) return new Set();
  return new Set(
    raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
}

/**
 * Determine whether a named hook should run given the current env configuration.
 *
 * @param {string} hookName       - canonical hook file stem (e.g. "on-session-start")
 * @param {boolean} [defaultEnabled=true]  - fallback when no profile/disable-list applies
 * @returns {boolean}  true = run the hook; false = skip (exit 0)
 */
export function shouldRunHook(hookName, defaultEnabled = true) {
  const name = hookName.trim().toLowerCase();

  // SO_DISABLED_HOOKS takes precedence over profile for listed names.
  const disabled = resolveDisabledHooks();
  if (disabled.has(name)) return false;

  const profile = resolveProfile();

  if (profile === 'off') return false;
  if (profile === 'minimal') return MINIMAL_HOOKS.has(name);

  // profile === 'full' — use defaultEnabled (always true in practice)
  return defaultEnabled;
}
