/**
 * tests/lib/shared/profiles/registry.test.mjs
 *
 * Unit tests for scripts/lib/shared/profiles/registry.mjs.
 *
 * Coverage:
 *   - loadProfiles: happy path, FILE_NOT_FOUND, PARSE_ERROR, SCHEMA_INVALID,
 *     DI seam with mock fs, default path usage
 *   - listProfileNames: returns sorted keys, handles non-object gracefully
 *   - getProfile: happy path, UNKNOWN_PROFILE on missing name
 *   - validateProfile: happy path, failures per regex/enum/required
 *   - ProfileRegistryError: has .code property
 *
 * Uses DI seam (opts.fs) for fs testing — no vi.mock for fs.
 * All expected values are hardcoded literals.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProfiles,
  listProfileNames,
  getProfile,
  validateProfile,
  ProfileRegistryError,
} from '../../../../scripts/lib/shared/profiles/registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Path to the seed registry shipped in the repo
const SEED_PROFILES_PATH = path.resolve(
  __dirname,
  '../../../../.orchestrator/policy/test-profiles.json',
);

// ---------------------------------------------------------------------------
// ProfileRegistryError — class contract
// ---------------------------------------------------------------------------

describe('ProfileRegistryError', () => {
  it('has a .code property matching what was passed to the constructor', () => {
    const err = new ProfileRegistryError('FILE_NOT_FOUND', 'file not found');
    expect(err.code).toBe('FILE_NOT_FOUND');
  });

  it('is an instance of Error', () => {
    const err = new ProfileRegistryError('PARSE_ERROR', 'bad json');
    expect(err).toBeInstanceOf(Error);
  });

  it('carries the message argument', () => {
    const err = new ProfileRegistryError('SCHEMA_INVALID', 'schema mismatch');
    expect(err.message).toBe('schema mismatch');
  });
});

// ---------------------------------------------------------------------------
// loadProfiles — happy path (real seed file on disk)
// ---------------------------------------------------------------------------

describe('loadProfiles — happy path', () => {
  it('loads the seed registry and returns ok: true with 2 profiles', async () => {
    const result = await loadProfiles({ profilesPath: SEED_PROFILES_PATH });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.profiles)).toHaveLength(2);
  });

  it('loaded profiles include web-gate and mac-gate', async () => {
    const result = await loadProfiles({ profilesPath: SEED_PROFILES_PATH });
    expect(result.ok).toBe(true);
    expect(result.profiles['web-gate']).toBeDefined();
    expect(result.profiles['mac-gate']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// loadProfiles — FILE_NOT_FOUND
// ---------------------------------------------------------------------------

describe('loadProfiles — FILE_NOT_FOUND', () => {
  it('returns ok: false when the file does not exist', async () => {
    const result = await loadProfiles({
      profilesPath: '/does/not/exist/test-profiles-xyz.json',
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('FILE_NOT_FOUND');
  });

  it('error is a ProfileRegistryError instance', async () => {
    const result = await loadProfiles({
      profilesPath: '/does/not/exist/xyz.json',
    });
    expect(result.error).toBeInstanceOf(ProfileRegistryError);
  });
});

// ---------------------------------------------------------------------------
// loadProfiles — PARSE_ERROR (invalid JSON via DI)
// ---------------------------------------------------------------------------

describe('loadProfiles — PARSE_ERROR', () => {
  it('returns ok: false with code PARSE_ERROR when the file contains invalid JSON', async () => {
    const mockFs = {
      readFile: async () => 'this is not json {{{',
    };
    const result = await loadProfiles({ profilesPath: 'any-path', fs: mockFs });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PARSE_ERROR');
  });
});

// ---------------------------------------------------------------------------
// loadProfiles — SCHEMA_INVALID (valid JSON but invalid schema via DI)
// ---------------------------------------------------------------------------

describe('loadProfiles — SCHEMA_INVALID', () => {
  it('returns ok: false with code SCHEMA_INVALID when JSON is valid but schema fails', async () => {
    const mockFs = {
      readFile: async () =>
        JSON.stringify({
          'bad-profile': { name: 'bad-profile', driver: 'selenium' },
        }),
    };
    const result = await loadProfiles({ profilesPath: 'any-path', fs: mockFs });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('SCHEMA_INVALID');
  });
});

// ---------------------------------------------------------------------------
// loadProfiles — DI seam: inject mock fs with deterministic content
// ---------------------------------------------------------------------------

describe('loadProfiles — DI seam', () => {
  it('uses the injected fs.readFile and returns the parsed profiles', async () => {
    const mockContent = JSON.stringify({
      'smoke-test': {
        name: 'smoke-test',
        driver: 'playwright',
        mode: 'headless',
        rubric: 'skills/test-runner/rubric-v1.md',
        timeout_ms: 60000,
      },
    });
    const mockFs = { readFile: async () => mockContent };
    const result = await loadProfiles({ profilesPath: 'mock-path', fs: mockFs });
    expect(result.ok).toBe(true);
    expect(result.profiles['smoke-test'].driver).toBe('playwright');
    expect(result.profiles['smoke-test'].timeout_ms).toBe(60000);
  });
});

// ---------------------------------------------------------------------------
// listProfileNames
// ---------------------------------------------------------------------------

describe('listProfileNames', () => {
  it('returns a sorted array of profile names', () => {
    const profiles = {
      'z-profile': { name: 'z-profile', driver: 'playwright' },
      'a-profile': { name: 'a-profile', driver: 'peekaboo' },
      'm-profile': { name: 'm-profile', driver: 'playwright' },
    };
    const names = listProfileNames(profiles);
    expect(names).toEqual(['a-profile', 'm-profile', 'z-profile']);
  });

  it('returns an empty array for an empty profiles object', () => {
    expect(listProfileNames({})).toEqual([]);
  });

  it('returns an empty array when given a non-object (null guard)', () => {
    expect(listProfileNames(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getProfile — happy path
// ---------------------------------------------------------------------------

describe('getProfile — happy path', () => {
  const profiles = {
    'web-gate': {
      name: 'web-gate',
      driver: 'playwright',
      mode: 'headless',
      rubric: 'skills/test-runner/rubric-v1.md',
      timeout_ms: 120000,
    },
  };

  it('returns ok: true and the profile entry when the name exists', () => {
    const result = getProfile(profiles, 'web-gate');
    expect(result.ok).toBe(true);
    expect(result.profile.driver).toBe('playwright');
    expect(result.profile.timeout_ms).toBe(120000);
  });
});

// ---------------------------------------------------------------------------
// getProfile — UNKNOWN_PROFILE
// ---------------------------------------------------------------------------

describe('getProfile — UNKNOWN_PROFILE', () => {
  it('returns ok: false with code UNKNOWN_PROFILE for a missing name', () => {
    const result = getProfile({ 'web-gate': {} }, 'nonexistent-profile');
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_PROFILE');
  });

  it('UNKNOWN_PROFILE message includes the requested name', () => {
    const result = getProfile({ 'web-gate': {} }, 'missing-thing');
    expect(result.error.message).toContain('missing-thing');
  });
});

// ---------------------------------------------------------------------------
// validateProfile — happy path
// ---------------------------------------------------------------------------

describe('validateProfile — happy path', () => {
  it('returns ok: true and the validated value for a minimal valid entry', () => {
    const result = validateProfile({
      name: 'quick-smoke',
      driver: 'playwright',
    });
    expect(result.ok).toBe(true);
    expect(result.value.name).toBe('quick-smoke');
    expect(result.value.driver).toBe('playwright');
  });
});

// ---------------------------------------------------------------------------
// validateProfile — failures (table-driven)
// ---------------------------------------------------------------------------

describe('validateProfile — schema failures', () => {
  it.each([
    [
      'name with uppercase letters',
      { name: 'BadName', driver: 'playwright' },
      'SCHEMA_INVALID',
    ],
    [
      'invalid enum driver value',
      { name: 'valid-name', driver: 'cypress' },
      'SCHEMA_INVALID',
    ],
    [
      'missing required driver field',
      { name: 'no-driver' },
      'SCHEMA_INVALID',
    ],
  ])('returns ok: false with code SCHEMA_INVALID when %s', (_label, entry, expectedCode) => {
    const result = validateProfile(entry);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(expectedCode);
  });
});
