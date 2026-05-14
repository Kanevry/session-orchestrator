/**
 * test-runner/profile-registry.mjs — Pure loader for test profile registry.
 *
 * Reads `.orchestrator/policy/test-profiles.json`, validates each entry
 * against profileRegistrySchema, and exposes pure helper accessors.
 * DI-friendly: accepts an `fs` seam so callers can inject mock file systems.
 *
 * Issue: #383 (part 3) — /test command: profile registry schema + seed profiles
 *
 * Exports:
 *   loadProfiles({ profilesPath?, fs? })  → Promise<{ok, profiles?, error?}>
 *   listProfileNames(profiles)            → string[]
 *   getProfile(profiles, name)            → {ok, profile?, error?}
 *   validateProfile(entry)                → {ok, value?, error?}
 *   ProfileRegistryError
 */

import fsPromises from 'node:fs/promises';
import { profileEntrySchema, profileRegistrySchema } from './profile-schema.mjs';

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

const DEFAULT_PROFILES_PATH = '.orchestrator/policy/test-profiles.json';

// ---------------------------------------------------------------------------
// ProfileRegistryError
// ---------------------------------------------------------------------------

/**
 * Typed error for profile registry failures.
 * Codes: 'FILE_NOT_FOUND' | 'PARSE_ERROR' | 'SCHEMA_INVALID' | 'UNKNOWN_PROFILE'
 */
export class ProfileRegistryError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ProfileRegistryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// loadProfiles
// ---------------------------------------------------------------------------

/**
 * Load and validate the profiles registry from disk.
 *
 * @param {object} [opts]
 * @param {string} [opts.profilesPath] - path to the JSON registry file;
 *   defaults to `.orchestrator/policy/test-profiles.json`
 * @param {{ readFile: Function }} [opts.fs] - injected fs/promises (DI seam);
 *   defaults to the real `fs/promises`
 * @returns {Promise<{ ok: true, profiles: Record<string, object> } | { ok: false, error: ProfileRegistryError }>}
 */
export async function loadProfiles({ profilesPath, fs: fsImpl } = {}) {
  const filePath = profilesPath ?? DEFAULT_PROFILES_PATH;
  const fsRead = fsImpl ?? fsPromises;

  let raw;
  try {
    raw = await fsRead.readFile(filePath, 'utf8');
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'PARSE_ERROR';
    return {
      ok: false,
      error: new ProfileRegistryError(code, `Cannot read profiles file '${filePath}': ${err.message}`),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: new ProfileRegistryError('PARSE_ERROR', `Invalid JSON in '${filePath}': ${err.message}`),
    };
  }

  const result = profileRegistrySchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: new ProfileRegistryError(
        'SCHEMA_INVALID',
        `Profile registry schema validation failed: ${result.error.message}`,
      ),
    };
  }

  return { ok: true, profiles: result.data };
}

// ---------------------------------------------------------------------------
// listProfileNames
// ---------------------------------------------------------------------------

/**
 * Return the sorted list of profile names in the registry.
 *
 * @param {Record<string, object>} profiles
 * @returns {string[]}
 */
export function listProfileNames(profiles) {
  if (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles)) {
    return [];
  }
  return Object.keys(profiles).sort();
}

// ---------------------------------------------------------------------------
// getProfile
// ---------------------------------------------------------------------------

/**
 * Retrieve a single profile by name.
 *
 * @param {Record<string, object>} profiles
 * @param {string} name
 * @returns {{ ok: true, profile: object } | { ok: false, error: ProfileRegistryError }}
 */
export function getProfile(profiles, name) {
  if (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles)) {
    return {
      ok: false,
      error: new ProfileRegistryError('SCHEMA_INVALID', 'profiles must be a non-null object'),
    };
  }

  if (typeof name !== 'string' || name.length === 0) {
    return {
      ok: false,
      error: new ProfileRegistryError('UNKNOWN_PROFILE', 'profile name must be a non-empty string'),
    };
  }

  if (!Object.prototype.hasOwnProperty.call(profiles, name)) {
    const available = Object.keys(profiles).sort().join(', ') || '(none)';
    return {
      ok: false,
      error: new ProfileRegistryError(
        'UNKNOWN_PROFILE',
        `Profile '${name}' not found. Available: ${available}`,
      ),
    };
  }

  return { ok: true, profile: profiles[name] };
}

// ---------------------------------------------------------------------------
// validateProfile
// ---------------------------------------------------------------------------

/**
 * Validate a raw profile entry object against the schema.
 *
 * @param {unknown} entry
 * @returns {{ ok: true, value: object } | { ok: false, error: ProfileRegistryError }}
 */
export function validateProfile(entry) {
  const result = profileEntrySchema.safeParse(entry);
  if (!result.success) {
    return {
      ok: false,
      error: new ProfileRegistryError('SCHEMA_INVALID', result.error.message),
    };
  }
  return { ok: true, value: result.data };
}
