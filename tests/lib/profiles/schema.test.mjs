/**
 * tests/lib/profiles/schema.test.mjs
 *
 * Unit tests for scripts/lib/profiles/schema.mjs.
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  profileEntrySchema,
  profileRegistrySchema,
} from '@lib/profiles/schema.mjs';

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
    // After SEC-Q2-LOW-2 (deep-5): rubric is stored as resolved absolute path (realpath when exists).
    expect(result.data.rubric).toBe(
      fs.realpathSync(path.resolve(process.cwd(), 'skills/test-runner/rubric-v1.md'))
    );
    expect(result.data.timeout_ms).toBe(120000);
  });
});

// ---------------------------------------------------------------------------
// Rubric path-traversal validation (#391)
// ---------------------------------------------------------------------------

describe('profileEntrySchema — rubric path-traversal rejection', () => {
  it('accepts the default rubric value skills/test-runner/rubric-v1.md (critical regression guard)', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      rubric: 'skills/test-runner/rubric-v1.md',
    });
    expect(result.success).toBe(true);
    // After SEC-Q2-LOW-2 (deep-5): rubric stored as realpath when target exists.
    expect(result.data.rubric).toBe(
      fs.realpathSync(path.resolve(process.cwd(), 'skills/test-runner/rubric-v1.md'))
    );
  });

  it('accepts an explicit relative rubric path inside the project', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      rubric: 'docs/custom-rubric.md',
    });
    expect(result.success).toBe(true);
    // docs/custom-rubric.md doesn't exist → falls back to lexicalPath (path.resolve).
    expect(result.data.rubric).toBe(
      path.resolve(process.cwd(), 'docs/custom-rubric.md')
    );
  });

  it('rejects a relative traversal rubric path (../../../etc/passwd)', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      rubric: '../../../etc/passwd',
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('rubric');
  });

  it('rejects an absolute rubric path outside the project (/etc/passwd)', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      rubric: '/etc/passwd',
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('rubric');
  });

  it('rejects an empty string rubric (validatePathInsideProject rejects empty input)', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      rubric: '',
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('rubric');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 symlink-escape guard for rubric field (#397 / SEC-Q2-LOW-1)
//
// When the rubric path EXISTS on disk and is a symlink pointing outside the
// project root, Phase 2 (realpathSync) must reject it and return an error.
// The test creates a real temp directory, a real symlink, and cleans up after.
// Skipped automatically on platforms where fs.symlinkSync fails.
// ---------------------------------------------------------------------------

describe('profileEntrySchema — rubric Phase 2 symlink-escape guard (#397)', () => {
  it('rejects a rubric path that is a symlink pointing outside the project root', () => {
    // Create a temp dir outside the project root.
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-schema-symlink-'));
    } catch {
      return; // Can't create temp dir — skip silently.
    }

    // Place the symlink inside the project root (so Phase 1 lexical check passes)
    // but point it to the external tmpDir target (so Phase 2 rejects it).
    const symlinkName = `rubric-escape-test-${Date.now()}.md`;
    const symlinkPath = path.join(process.cwd(), symlinkName);

    // Create the actual file inside tmpDir so the symlink is NOT dangling.
    // Without the target file, realpathSync throws ENOENT → the catch block
    // falls through to "lexical check sufficient" → no rejection.
    const targetFile = path.join(tmpDir, 'escape.md');
    try {
      fs.writeFileSync(targetFile, '# escape target\n', 'utf8');
      fs.symlinkSync(targetFile, symlinkPath);
    } catch {
      // symlinkSync not available on this platform — skip test.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return;
    }

    try {
      // Lexically the symlink name is inside the project root (Phase 1 passes).
      // Phase 2 (realpathSync) resolves the symlink → outside the root → rejected.
      const result = profileEntrySchema.safeParse({
        name: 'test',
        driver: 'playwright',
        rubric: symlinkName,
      });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toContain('rubric');
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
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

// ---------------------------------------------------------------------------
// timeout_ms boundary validation (SEC-PD-LOW-3 regression guard)
// ---------------------------------------------------------------------------

describe('profileEntrySchema — timeout_ms boundary cases', () => {
  it('rejects timeout_ms = 0', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      timeout_ms: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('timeout_ms');
  });

  it('rejects timeout_ms = -1', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      timeout_ms: -1,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('timeout_ms');
  });

  it('rejects non-integer timeout_ms (120000.5)', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      timeout_ms: 120000.5,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toContain('timeout_ms');
  });

  it('rejects timeout_ms exceeding 1-hour ceiling (3_600_001)', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      timeout_ms: 3_600_001,
    });
    expect(result.success).toBe(false);
    // The exact MAX_TIMEOUT_MS value 3600000 should appear in the error message
    // per SEC-PD-LOW-3 inline rationale
    expect(result.error.issues[0].message).toMatch(/3600000|ceiling|exceed/);
  });

  it('accepts timeout_ms at exactly the 1-hour ceiling (3_600_000)', () => {
    const result = profileEntrySchema.safeParse({
      name: 'test',
      driver: 'playwright',
      timeout_ms: 3_600_000,
    });
    expect(result.success).toBe(true);
    expect(result.data.timeout_ms).toBe(3_600_000);
  });
});
