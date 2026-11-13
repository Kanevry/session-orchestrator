/**
 * offline-flags.mjs — the standard "no non-essential traffic" environment flags.
 *
 * One list for every default-on outbound request this plugin makes on its own:
 * the SessionStart update check (`plugin-update-banner.mjs`) and the
 * security-pulse background refresher (`security-pulse/spawn.mjs`). An operator
 * who sets `DO_NOT_TRACK` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` did not
 * consent to either request; before this module the refresher ignored both
 * flags while the update check honoured them.
 *
 * Zero imports on purpose: both consumers sit on the SessionStart hook path.
 *
 * Ceiling: `scripts/lib/telemetry/consent.mjs` keeps its own module-private
 * copy of the truthiness test and reads `DO_NOT_TRACK` inside its consent
 * precedence chain. Fold it in here when that chain is next touched.
 */

/** Flags that ask for no non-essential outbound traffic. */
export const OFFLINE_ENV_KEYS = ['DO_NOT_TRACK', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];

/**
 * Truthiness for an env switch: set, non-empty, not `0`, not `false`.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isTruthyFlag(raw) {
  if (raw === undefined || raw === null) return false;
  const t = String(raw).trim();
  if (t === '' || t === '0') return false;
  return t.toLowerCase() !== 'false';
}

/**
 * The first offline flag that is set in `env`, else `null`.
 *
 * @param {Record<string, string|undefined>|undefined|null} env
 * @returns {string|null}
 */
export function firstOfflineFlag(env) {
  for (const key of OFFLINE_ENV_KEYS) {
    if (isTruthyFlag(env?.[key])) return key;
  }
  return null;
}
