/**
 * tests/unit/test-profiles-mail-assistant.test.mjs
 *
 * Asserts that .orchestrator/policy/test-profiles.json:
 *   1. Is valid JSON (parse-level check)
 *   2. Contains the new mail-assistant-onboarding entry with all required fields
 *   3. The new entry has correct driver, checks, scenarios, and flags
 *   4. Pre-existing web-gate and mac-gate entries are unmodified (regression guard)
 *
 * Issue: #386 — skeleton proof for /test --target MailAssistant --profile onboarding
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILES_PATH = path.join(REPO_ROOT, '.orchestrator', 'policy', 'test-profiles.json');

// Parse once; individual tests reference this object.
// If JSON.parse throws, every test fails — which is correct: bad JSON = nothing passes.
const profiles = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));
const entry = profiles['mail-assistant-onboarding'];

// ---------------------------------------------------------------------------
// File-level validation
// ---------------------------------------------------------------------------

describe('test-profiles.json — file integrity', () => {
  it('parses as valid JSON without throwing', () => {
    // JSON.parse already executed above; if we reached this line, it succeeded.
    expect(typeof profiles).toBe('object');
  });

  it('is a plain object (not an array)', () => {
    expect(Array.isArray(profiles)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression guard — pre-existing entries unchanged
// ---------------------------------------------------------------------------

describe('test-profiles.json — pre-existing entries (regression guard)', () => {
  it('web-gate entry is still present', () => {
    expect(profiles).toHaveProperty('web-gate');
  });

  it('web-gate driver is still playwright', () => {
    expect(profiles['web-gate'].driver).toBe('playwright');
  });

  it('mac-gate entry is still present', () => {
    expect(profiles).toHaveProperty('mac-gate');
  });

  it('mac-gate driver is still peekaboo', () => {
    expect(profiles['mac-gate'].driver).toBe('peekaboo');
  });
});

// ---------------------------------------------------------------------------
// New entry — presence
// ---------------------------------------------------------------------------

describe('mail-assistant-onboarding profile — presence', () => {
  it('mail-assistant-onboarding key exists in the profiles map', () => {
    expect(profiles).toHaveProperty('mail-assistant-onboarding');
  });

  it('entry is a non-null object', () => {
    expect(typeof entry).toBe('object');
    expect(entry).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

describe('mail-assistant-onboarding profile — required fields', () => {
  it('has driver field', () => {
    expect(entry).toHaveProperty('driver');
  });

  it('has target_name field', () => {
    expect(entry).toHaveProperty('target_name');
  });

  it('has checks field', () => {
    expect(entry).toHaveProperty('checks');
  });

  it('has scenarios field', () => {
    expect(entry).toHaveProperty('scenarios');
  });

  it('has timeout_ms field', () => {
    expect(entry).toHaveProperty('timeout_ms');
  });
});

// ---------------------------------------------------------------------------
// Field values — driver
// ---------------------------------------------------------------------------

describe('mail-assistant-onboarding profile — driver', () => {
  it('driver is peekaboo (macOS-native, not playwright)', () => {
    expect(entry.driver).toBe('peekaboo');
  });

  it('target_name is MailAssistant (the .app product name)', () => {
    expect(entry.target_name).toBe('MailAssistant');
  });
});

// ---------------------------------------------------------------------------
// Field values — checks
// ---------------------------------------------------------------------------

describe('mail-assistant-onboarding profile — checks array', () => {
  it('checks is an array', () => {
    expect(Array.isArray(entry.checks)).toBe(true);
  });

  it('checks includes onboarding-step-count', () => {
    expect(entry.checks).toContain('onboarding-step-count');
  });

  it('checks does NOT include axe-violations (N/A for native SwiftUI)', () => {
    expect(entry.checks).not.toContain('axe-violations');
  });

  it('checks does NOT include console-errors (N/A for native SwiftUI)', () => {
    expect(entry.checks).not.toContain('console-errors');
  });
});

// ---------------------------------------------------------------------------
// Field values — scenarios
// ---------------------------------------------------------------------------

describe('mail-assistant-onboarding profile — scenarios array', () => {
  it('scenarios is an array', () => {
    expect(Array.isArray(entry.scenarios)).toBe(true);
  });

  it('scenarios has exactly 4 entries (LLM-Provider, Test-Run, Keychain, Mail-Surface)', () => {
    expect(entry.scenarios).toHaveLength(4);
  });

  it('scenarios[0] is LLM-Provider', () => {
    expect(entry.scenarios[0]).toBe('LLM-Provider');
  });

  it('scenarios[1] is Test-Run', () => {
    expect(entry.scenarios[1]).toBe('Test-Run');
  });

  it('scenarios[2] is Keychain', () => {
    expect(entry.scenarios[2]).toBe('Keychain');
  });

  it('scenarios[3] is Mail-Surface', () => {
    expect(entry.scenarios[3]).toBe('Mail-Surface');
  });
});

// ---------------------------------------------------------------------------
// Field values — liquid glass flag
// ---------------------------------------------------------------------------

describe('mail-assistant-onboarding profile — liquid_glass_skipped', () => {
  it('liquid_glass_skipped is exactly true (boolean)', () => {
    expect(entry.liquid_glass_skipped).toBe(true);
  });

  it('liquid_glass_skip_reason is a non-empty string', () => {
    expect(typeof entry.liquid_glass_skip_reason).toBe('string');
    expect(entry.liquid_glass_skip_reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Field values — timeout and metadata
// ---------------------------------------------------------------------------

describe('mail-assistant-onboarding profile — timeout and metadata', () => {
  it('timeout_ms is a number', () => {
    expect(typeof entry.timeout_ms).toBe('number');
  });

  it('timeout_ms is 180000 (3 minutes)', () => {
    expect(entry.timeout_ms).toBe(180000);
  });

  it('swift_ref_note is a non-empty string mentioning b29ea71', () => {
    expect(typeof entry.swift_ref_note).toBe('string');
    expect(entry.swift_ref_note).toContain('b29ea71');
  });

  it('app_source path contains mail-assistant', () => {
    expect(typeof entry.app_source).toBe('string');
    expect(entry.app_source).toContain('mail-assistant');
  });
});
