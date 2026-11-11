/**
 * profile-gate.mjs — runtime hook control: which hooks run, and how hard the
 * destructive guard blocks.
 *
 * Issue #211; profiles reworked in #1881.
 *
 * Sources, highest first:
 *   1. env `SO_HOOK_PROFILE` / `SO_DISABLED_HOOKS` (comma-separated names)
 *   2. host-local owner.yaml `hooks.profile` / `hooks.disabled`
 *      (`~/.config/session-orchestrator/owner.yaml`, never committed)
 *   3. the default profile `standard`
 * The disabled lists of env and owner.yaml are unioned; a listed name is off
 * under every profile.
 *
 * ## owner.yaml can relax, never disarm
 *
 * owner.yaml is a plain file an agent can append to, and it takes effect on the
 * next tool call. So it may only choose a profile in OWNER_PROFILES and disable
 * hooks outside SAFETY_HOOKS; anything else from owner.yaml is ignored here (and
 * rejected by owner-yaml validation, so the operator sees a WARN). Switching a
 * safety hook off, or `minimal`/`off`, stays with the env of the process the
 * operator launched. Without this, `hooks: {profile: off}` appended by one Bash
 * call turned the destructive guard off for every later call (review 2026-10-31).
 *
 * Profiles:
 *   strict   — every hook, every destructive-guard rule at its policy severity.
 *              `full` is the pre-#1881 name of this profile and stays an alias.
 *   standard — DEFAULT. strict without the hooks in STANDARD_OFF_HOOKS; the
 *              destructive-guard cases in RELAXED_WARN_RULES warn instead of block.
 *   minimal  — only on-session-start + pre-bash-destructive-guard (rules as in standard)
 *   off      — no hooks enabled
 *
 * Why `standard` is the default (#1881, measured 2026-10-31 over 7 days of
 * transcripts on the owner's host: 792 PreToolUse denials in 185,316 tool
 * calls): templates-first (146) is a quality nudge, not a protection. Of the
 * 136 worktree-remove-unsafe denials 110 had a target the guard could not
 * measure; only that case warns, a measured hit (valuable ignored state: 8,
 * `--force`: 18) still blocks. The STATE.md path guard (6) prevents a misplaced
 * STATE.md that /close then misses; the owner chose fewer interruptions over
 * that check. strict keeps all three.
 *
 * An unknown env profile is ignored with one stderr warning (owner.yaml or the
 * default then decides). An invalid owner.yaml `hooks` section is dropped by
 * `loadOwnerConfig()` (stderr WARN there), so the default decides.
 *
 * Usage in each hook handler (at the very top, before any other logic):
 *   import { shouldRunHook } from './_lib/profile-gate.mjs';
 *   if (!shouldRunHook('on-session-start')) process.exit(0);
 *
 * ## No static repo imports (#992)
 *
 * The destructive guard imports this module statically and binds every other
 * repo module late, so a broken module cannot crash it at ESM link time (exit 1
 * = fail OPEN). This module therefore imports only `node:` builtins and loads
 * owner.yaml through a synchronous `require()` inside a try: a broken
 * `owner-yaml.mjs` means "no host override", never a dead guard.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Hook names enabled in the "minimal" profile. */
const MINIMAL_HOOKS = new Set([
  'on-session-start',
  'pre-bash-destructive-guard',
]);

/** Hooks the "standard" profile leaves off (they run under strict). */
export const STANDARD_OFF_HOOKS = Object.freeze([
  'pre-bash-templates-first',
  'pre-tool-state-md-path-guard',
]);

/**
 * Destructive-guard cases (`<rule id>` or `<rule id>/<case>`) that warn instead
 * of block under every profile but strict.
 */
export const RELAXED_WARN_RULES = Object.freeze([
  'worktree-remove-unsafe/unmeasurable',
]);

/** Profiles owner.yaml may choose (`minimal` and `off` switch safety hooks off). */
export const OWNER_PROFILES = Object.freeze(['strict', 'full', 'standard']);

/**
 * Hooks owner.yaml cannot disable: they stop an agent from destroying data,
 * escaping its wave scope or loosening a quality gate. Env can.
 */
export const SAFETY_HOOKS = Object.freeze([
  'pre-bash-destructive-guard',
  'enforce-scope',
  'enforce-commands',
  'pre-bash-sessions-ledger-guard',
  'pre-edit-sessions-ledger-guard',
  'config-protection',
  'pre-task-scope-disjoint',
  'pre-bash-staging-fence',
  // Codex route to enforce-scope / config-protection / the ledger guard (#1913):
  // disabling it would disarm all three there.
  'codex-apply-patch-guard',
]);

/** The profile that applies when neither env nor owner.yaml names one. */
export const DEFAULT_PROFILE = 'standard';

/** Valid profile names (`full` = legacy alias of `strict`). */
export const VALID_PROFILES = Object.freeze(['strict', 'full', 'standard', 'minimal', 'off']);

const STANDARD_OFF = new Set(STANDARD_OFF_HOOKS);
const RELAXED_WARN = new Set(RELAXED_WARN_RULES);
const SAFETY = new Set(SAFETY_HOOKS);

/** Per-process memo of the owner.yaml `hooks` section (hook processes are single-use). */
let _ownerHooks;

/**
 * Warn once per process (hook subprocess is single-use, so this is effectively
 * warn-once per invocation).
 */
let _unknownProfileWarned = false;

/**
 * Normalize a profile name; `full` maps to `strict`. Unknown → null.
 *
 * @param {unknown} raw
 * @returns {"strict"|"standard"|"minimal"|"off"|null}
 */
function normalizeProfile(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'full') return 'strict';
  if (VALID_PROFILES.includes(value)) return /** @type {"strict"|"standard"|"minimal"|"off"} */ (value);
  return null;
}

/**
 * The owner.yaml `hooks` section, or null. The YAML parse only runs when the
 * raw file names a top-level `hooks:` key, so a host without the section pays
 * one small file read, not a parse. Never throws.
 *
 * @returns {{ profile?: unknown, disabled?: unknown } | null}
 */
function ownerHooks() {
  if (_ownerHooks !== undefined) return _ownerHooks;
  _ownerHooks = null;
  try {
    const { loadOwnerConfig, resolveOwnerYamlPath } = require('../../scripts/lib/owner-yaml.mjs');
    const ownerYaml = resolveOwnerYamlPath();
    if (!/^hooks[ \t]*:/m.test(readFileSync(ownerYaml, 'utf8'))) return _ownerHooks;
    const hooks = loadOwnerConfig({ path: ownerYaml }).config?.hooks;
    if (hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) _ownerHooks = hooks;
  } catch {
    // Missing/unreadable owner.yaml or a module that fails to load → no host override.
  }
  return _ownerHooks;
}

/** Test seam: forget the memoized owner.yaml section and the unknown-profile warning. */
export function _resetHookProfileCache() {
  _ownerHooks = undefined;
  _unknownProfileWarned = false;
}

/**
 * Resolve the active profile: env > owner.yaml > default.
 *
 * @returns {"strict"|"standard"|"minimal"|"off"}
 */
export function resolveHookProfile() {
  const rawEnv = (process.env.SO_HOOK_PROFILE ?? '').trim();
  if (rawEnv) {
    const fromEnv = normalizeProfile(rawEnv);
    if (fromEnv) return fromEnv;
    if (!_unknownProfileWarned) {
      process.stderr.write(
        `⚠ SO_HOOK_PROFILE="${process.env.SO_HOOK_PROFILE}" is unknown — ignored. ` +
        `Valid values: ${VALID_PROFILES.join(' | ')}\n`
      );
      _unknownProfileWarned = true;
    }
  }
  const fromOwner = ownerHooks()?.profile;
  return OWNER_PROFILES.includes(fromOwner) ? normalizeProfile(fromOwner) : DEFAULT_PROFILE;
}

/**
 * Union of SO_DISABLED_HOOKS and the owner.yaml `hooks.disabled` entries that
 * are no SAFETY_HOOKS, lowercased.
 *
 * @returns {Set<string>}
 */
function resolveDisabledHooks() {
  const lower = (s) => s.trim().toLowerCase();
  const names = (process.env.SO_DISABLED_HOOKS ?? '').split(',').map(lower);
  const fromOwner = ownerHooks()?.disabled;
  if (Array.isArray(fromOwner)) {
    names.push(...fromOwner.filter((n) => typeof n === 'string').map(lower).filter((n) => !SAFETY.has(n)));
  }
  return new Set(names.filter(Boolean));
}

/**
 * Determine whether a named hook should run given the current configuration.
 *
 * @param {string} hookName       - canonical hook file stem (e.g. "on-session-start")
 * @param {boolean} [defaultEnabled=true]  - fallback when no profile/disable-list applies
 * @returns {boolean}  true = run the hook; false = skip (exit 0)
 */
export function shouldRunHook(hookName, defaultEnabled = true) {
  const name = hookName.trim().toLowerCase();

  // A disabled list takes precedence over the profile for listed names.
  if (resolveDisabledHooks().has(name)) return false;

  const profile = resolveHookProfile();

  if (profile === 'off') return false;
  if (profile === 'minimal') return MINIMAL_HOOKS.has(name);
  if (profile === 'standard' && STANDARD_OFF.has(name)) return false;

  return defaultEnabled;
}

/**
 * The severity a destructive-guard case applies under the active profile:
 * a `block` case listed in RELAXED_WARN_RULES warns unless the profile is strict.
 *
 * @param {string} ruleId — `<rule id>` or `<rule id>/<case>`
 * @param {string} severity — the policy severity
 * @returns {string}
 */
export function effectiveRuleSeverity(ruleId, severity) {
  if (severity !== 'block' || !RELAXED_WARN.has(ruleId)) return severity;
  return resolveHookProfile() === 'strict' ? severity : 'warn';
}
