/**
 * shared/profiles/schema.mjs — Validation schemas for test profile entries.
 *
 * Zod was not available in this project's node_modules at implementation time
 * (issue #383 part 3), so validation is implemented as a hand-rolled validator
 * that mirrors the Zod schema contract specified in the task brief.
 *
 * Exports:
 *   profileEntrySchema  — validator for a single profile entry
 *   profileRegistrySchema — validator for a full profiles record
 *
 * Both exports expose a `.safeParse(value)` method returning
 * `{ success: true, data }` or `{ success: false, error: ZodLike }`.
 */

import { isPathInside } from '../../path-utils.mjs';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_DRIVERS = new Set(['playwright', 'peekaboo']);
const VALID_MODES = new Set(['headless', 'headed']);
const NAME_REGEX = /^[a-z0-9-]+$/;

/**
 * Build a ZodLike error object matching Zod's safeParse error shape.
 * @param {string} message
 * @returns {{ issues: Array<{message: string}> }}
 */
function makeError(message) {
  return { issues: [{ message }], message };
}

/**
 * Validate a single profile entry and return the parsed (defaulted) value.
 * Mirrors the Zod schema:
 *
 *   name:        string, matches /^[a-z0-9-]+$/, min 1, max 50
 *   target:      string | null | undefined
 *   driver:      'playwright' | 'peekaboo'
 *   mode:        'headless' | 'headed', default 'headless'
 *   rubric:      string, default 'skills/test-runner/rubric-v1.md'
 *   checks:      string[] | undefined
 *   tags:        string[] | undefined
 *   timeout_ms:  positive integer, default 120000
 *   description: string | undefined
 *
 * @param {unknown} value
 * @returns {{ success: true, data: object } | { success: false, error: object }}
 */
function parseProfileEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { success: false, error: makeError('profile entry must be a non-null object') };
  }

  const v = /** @type {Record<string, unknown>} */ (value);

  // name
  if (typeof v.name !== 'string') {
    return { success: false, error: makeError('name must be a string') };
  }
  if (v.name.length < 1 || v.name.length > 50) {
    return { success: false, error: makeError('name must be between 1 and 50 characters') };
  }
  if (!NAME_REGEX.test(v.name)) {
    return { success: false, error: makeError('name must match /^[a-z0-9-]+$/') };
  }

  // target
  if (v.target !== undefined && v.target !== null && typeof v.target !== 'string') {
    return { success: false, error: makeError('target must be a string, null, or undefined') };
  }

  // driver
  if (!VALID_DRIVERS.has(/** @type {string} */ (v.driver))) {
    return {
      success: false,
      error: makeError(`driver must be one of: ${[...VALID_DRIVERS].join(', ')}`),
    };
  }

  // mode (with default)
  const mode = v.mode === undefined ? 'headless' : v.mode;
  if (!VALID_MODES.has(/** @type {string} */ (mode))) {
    return {
      success: false,
      error: makeError(`mode must be one of: ${[...VALID_MODES].join(', ')}`),
    };
  }

  // rubric (with default)
  const rubric = v.rubric === undefined ? 'skills/test-runner/rubric-v1.md' : v.rubric;
  if (typeof rubric !== 'string') {
    return { success: false, error: makeError('rubric must be a string') };
  }
  // SEC-IR-LOW-3: rubric must stay within project root
  const projectRoot = process.cwd();
  if (!isPathInside(rubric, projectRoot)) {
    return { success: false, error: makeError('rubric path escapes project root') };
  }

  // checks (optional array of strings)
  if (v.checks !== undefined) {
    if (!Array.isArray(v.checks) || v.checks.some((c) => typeof c !== 'string')) {
      return { success: false, error: makeError('checks must be an array of strings') };
    }
  }

  // tags (optional array of strings)
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags) || v.tags.some((t) => typeof t !== 'string')) {
      return { success: false, error: makeError('tags must be an array of strings') };
    }
  }

  // timeout_ms (positive integer, with default)
  const timeout_ms = v.timeout_ms === undefined ? 120000 : v.timeout_ms;
  if (
    typeof timeout_ms !== 'number' ||
    !Number.isInteger(timeout_ms) ||
    timeout_ms <= 0
  ) {
    return { success: false, error: makeError('timeout_ms must be a positive integer') };
  }
  // SEC-PD-LOW-3: V8 setTimeout uses int32 — values > 2^31-1 silently overflow to immediate-fire.
  // Practical ceiling is 1 hour for test profiles.
  const MAX_TIMEOUT_MS = 3_600_000;  // 1 hour
  if (timeout_ms > MAX_TIMEOUT_MS) {
    return { success: false, error: makeError(`timeout_ms must not exceed ${MAX_TIMEOUT_MS} (1 hour)`) };
  }

  // description (optional string)
  if (v.description !== undefined && typeof v.description !== 'string') {
    return { success: false, error: makeError('description must be a string') };
  }

  /** @type {Record<string, unknown>} */
  const data = {
    name: v.name,
    driver: v.driver,
    mode,
    rubric,
    timeout_ms,
  };

  if (v.target !== undefined) data.target = v.target;
  if (v.checks !== undefined) data.checks = v.checks;
  if (v.tags !== undefined) data.tags = v.tags;
  if (v.description !== undefined) data.description = v.description;

  return { success: true, data };
}

/**
 * Validate a full profiles registry (Record<string, profileEntry>).
 *
 * @param {unknown} value
 * @returns {{ success: true, data: Record<string, object> } | { success: false, error: object }}
 */
function parseProfileRegistry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { success: false, error: makeError('profile registry must be a non-null object') };
  }

  /** @type {Record<string, object>} */
  const data = {};

  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const result = parseProfileEntry(entry);
    if (!result.success) {
      return {
        success: false,
        error: makeError(`profile '${key}': ${result.error.message}`),
      };
    }
    data[key] = result.data;
  }

  return { success: true, data };
}

// ---------------------------------------------------------------------------
// Exports — Zod-compatible safeParse interface
// ---------------------------------------------------------------------------

export const profileEntrySchema = {
  /** @param {unknown} value */
  safeParse: (value) => parseProfileEntry(value),
};

export const profileRegistrySchema = {
  /** @param {unknown} value */
  safeParse: (value) => parseProfileRegistry(value),
};
