/**
 * owner-config-loader.mjs — File-system loader for owner.yaml (Issue #174).
 *
 * Companion to the pure schema/validator in `owner-config.mjs`. Resolves the
 * canonical config path (XDG-spec aware), reads the YAML, parses it, runs it
 * through the validator, and returns a `{ok, value, errors, source, path}`
 * envelope.
 *
 * ── PATH RESOLUTION ──────────────────────────────────────────────────────
 *
 *   Default path: `${XDG_CONFIG_HOME ?? ${HOME}/.config}/session-orchestrator/owner.yaml`
 *   - macOS / Linux: `~/.config/session-orchestrator/owner.yaml`
 *   - Windows:       `%APPDATA%\session-orchestrator\owner.yaml` when
 *                    APPDATA is set and XDG_CONFIG_HOME is not (Node uses
 *                    USERPROFILE for os.homedir() — falls back gracefully).
 *
 *   Callers may pass an explicit `{path}` override (used by tests + D4
 *   baseline-propagation when the canonical path is overridden by env).
 *
 * ── RETURN SHAPE ─────────────────────────────────────────────────────────
 *
 *   {
 *     ok: boolean,                    // false on any failure
 *     value: object|null,             // normalized config when ok=true
 *     errors: string[],               // populated on any failure
 *     source: 'file'|'missing'|'parse-error'|'validation-error',
 *     path: string,                   // resolved absolute path
 *   }
 *
 *   `source: 'missing'` is NOT an error — owner.yaml is opt-in (the bootstrap
 *   interview in D2 creates it). Callers should treat `source: 'missing'` as
 *   "no owner persona configured; fall back to plugin defaults".
 *
 * ── PLATFORM PORTABILITY ─────────────────────────────────────────────────
 *
 *   - Uses `os.homedir()` (Node-stdlib, OS-aware) rather than $HOME so the
 *     Windows path resolves correctly even when only USERPROFILE is set.
 *   - File reads are UTF-8 only. Owner.yaml is ASCII-safe by spec; non-UTF-8
 *     content yields `source: 'parse-error'`.
 *   - YAML parsing via `js-yaml` (devDep already pulled in by W2 quality-fix).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

import { validate } from './owner-config.mjs';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const APP_DIR = 'session-orchestrator';
const CONFIG_FILE = 'owner.yaml';

/**
 * Resolve the canonical owner.yaml path on disk. Honours XDG_CONFIG_HOME
 * when set (Linux convention), otherwise falls back to `${HOME}/.config`.
 * Returns an absolute path string. Does NOT touch the filesystem.
 *
 * @returns {string} absolute path to owner.yaml
 */
export function resolveOwnerConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, APP_DIR, CONFIG_FILE);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the owner.yaml config from disk.
 *
 * Defensive — never throws. Distinguishes four outcomes via the `source`
 * field so callers can react differently to "missing file" (opt-in feature
 * not yet enabled by the user) vs "malformed YAML" (broken state, surface
 * to user).
 *
 * @param {{path?: string}} [opts]
 * @returns {Promise<{ok: boolean, value: object|null, errors: string[], source: string, path: string}>}
 */
export async function loadOwnerConfig(opts = {}) {
  const path = opts.path ?? resolveOwnerConfigPath();

  if (!existsSync(path)) {
    return {
      ok: false,
      value: null,
      errors: [],
      source: 'missing',
      path,
    };
  }

  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      value: null,
      errors: [`failed to read owner config: ${err.message}`],
      source: 'parse-error',
      path,
    };
  }

  let parsed;
  try {
    // js-yaml's default schema (CORE_SCHEMA) is safe — it explicitly excludes
    // the !!js/function and !!js/regexp tags from the legacy DEFAULT_SCHEMA
    // that would let a malicious YAML file execute code or pollute prototypes.
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      ok: false,
      value: null,
      errors: [`YAML parse error: ${err.message}`],
      source: 'parse-error',
      path,
    };
  }

  // Empty file or YAML "null" → treat as parse-error so the caller knows
  // there's nothing to merge (vs a missing file which opts the user out
  // entirely).
  if (parsed === null || parsed === undefined) {
    return {
      ok: false,
      value: null,
      errors: ['owner config is empty'],
      source: 'parse-error',
      path,
    };
  }

  const validation = validate(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      value: null,
      errors: validation.errors,
      source: 'validation-error',
      path,
    };
  }

  return {
    ok: true,
    value: validation.value,
    errors: [],
    source: 'file',
    path,
  };
}
