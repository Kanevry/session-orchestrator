/**
 * tests/lib/test-runner/profile-schema.test.mjs
 *
 * Unit tests for scripts/lib/test-runner/profile-schema.mjs.
 *
 * Coverage:
 *   - profileEntrySchema.safeParse: happy paths (seed profiles), field validation,
 *     enum validation, defaults applied (mode/rubric/timeout_ms)
 *   - profileRegistrySchema.safeParse: rejects entry that fails entry-schema
 *
 * Expected values are hardcoded literals — no production-logic mirroring.
 * All tests are behavioral (input → output contract), not structural.
 */

import { describe, it, expect } from 'vitest';
import {
  profileEntrySchema,
  profileRegistrySchema,
} from '../../../scripts/lib/test-runner/profile-schema.mjs';

// ---------------------------------------------------------------------------
// Happy path — seed profiles parse cleanly
// ---------------------------------------------------------------------------

describe('profileEntrySchema — happy path (seed profiles)', () => {
  it('parses a complete web-gate profile entry', () => {
    const input = {
      name: 'web-gate',
      target: null,
      driver: 'playwright',
      mode: 'headless',
      rubric: 'skills/test-runner/rubric-v1.md',
      checks: ['onboarding', 'axe', 'console'],
      tags: ['smoke', 'web'],
      timeout_ms: 120000,
      description: 'Default web target smoke test profile via Playwright',
    };
    const result = profileEntrySchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data.name).toBe('web-gate');
    expect(result.data.driver).toBe('playwright');
    expect(result.data.mode).toBe('headless');
    expect(result.data.timeout_ms).toBe(120000);
  });

  it('parses a complete mac-gate profile entry', () => {
    const input = {
      name: 'mac-gate',
      target: null,
      driver: 'peekaboo',
      mode: 'headed',
      rubric: 'skills/test-runner/rubric-v1.md',
      checks: ['onboarding', 'glass'],
      tags: ['smoke', 'mac'],
      timeout_ms: 180000,
      description: 'macOS app smoke test profile via peekaboo',
    };
    const result = profileEntrySchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data.driver).toBe('peekaboo');
    expect(result.data.mode).toBe('headed');
    expect(result.data.timeout_ms).toBe(180000);
  });
});

// ---------------------------------------------------------------------------
// Field validation — name regex
// ---------------------------------------------------------------------------

describe('profileEntrySchema — name field validation', () => {
  it('accepts a valid lowercase-alphanumeric-hyphen name', () => {
    const result = profileEntrySchema.safeParse({
      name: 'my-smoke-test',
      driver: 'playwright',
    });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe('my-smoke-test');
  });

  it('rejects a name with uppercase letters', () => {
    const result = profileEntrySchema.safeParse({
      name: 'WebGate',
      driver: 'playwright',
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('name must match');
  });

  it('rejects a name with special characters', () => {
    const result = profileEntrySchema.safeParse({
      name: 'web_gate!',
      driver: 'playwright',
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('name must match');
  });

  it('rejects a name exceeding 50 characters', () => {
    const longName = 'a'.repeat(51);
    const result = profileEntrySchema.safeParse({
      name: longName,
      driver: 'playwright',
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('50 characters');
  });
});

// ---------------------------------------------------------------------------
// Enum validation — driver and mode
// ---------------------------------------------------------------------------

describe('profileEntrySchema — enum field validation', () => {
  it('rejects an unknown driver value', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'cypress',
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('driver must be one of');
  });

  it('rejects an unknown mode value', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      mode: 'invisible',
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('mode must be one of');
  });
});

// ---------------------------------------------------------------------------
// Defaults applied — mode, rubric, timeout_ms
// ---------------------------------------------------------------------------

describe('profileEntrySchema — defaults applied', () => {
  it('applies mode=headless, rubric=skills/test-runner/rubric-v1.md, and timeout_ms=120000 when omitted', () => {
    const result = profileEntrySchema.safeParse({
      name: 'minimal',
      driver: 'playwright',
    });
    expect(result.success).toBe(true);
    expect(result.data.mode).toBe('headless');
    expect(result.data.rubric).toBe('skills/test-runner/rubric-v1.md');
    expect(result.data.timeout_ms).toBe(120000);
  });
});

// ---------------------------------------------------------------------------
// profileRegistrySchema — rejects registry with an invalid entry
// ---------------------------------------------------------------------------

describe('profileRegistrySchema', () => {
  it('rejects a registry containing an entry with an invalid driver', () => {
    const input = {
      'bad-profile': {
        name: 'bad-profile',
        driver: 'selenium',
      },
    };
    const result = profileRegistrySchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error.message).toContain('bad-profile');
  });
});
