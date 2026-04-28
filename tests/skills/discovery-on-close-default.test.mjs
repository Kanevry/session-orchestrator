/**
 * tests/skills/discovery-on-close-default.test.mjs
 *
 * Regression: #264 — discovery-on-close default flipped to true for feature/deep.
 * Verifies:
 *  1. Housekeeping default is false (preserved)
 *  2. Feature default is true (new)
 *  3. Deep default is true (new)
 *  4. Explicit user config override wins for all three session types
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('discovery-on-close default (#264)', () => {
  it('discovery-scan.md resolves default as false for housekeeping', () => {
    const body = read('skills/session-end/discovery-scan.md');
    expect(body).toMatch(/sessionType\s*===\s*['"]housekeeping['"]\s*\?\s*false\s*:\s*true/);
  });

  it('discovery-scan.md resolves default as true for feature/deep (non-housekeeping)', () => {
    const body = read('skills/session-end/discovery-scan.md');
    // The ternary produces true for all non-housekeeping types (feature + deep)
    expect(body).toMatch(/sessionType\s*===\s*['"]housekeeping['"]\s*\?\s*false\s*:\s*true/);
    // And must document that feature and deep are the changed defaults
    expect(body).toMatch(/feature/);
    expect(body).toMatch(/deep/);
  });

  it('discovery-scan.md documents that explicit user config override always wins', () => {
    const body = read('skills/session-end/discovery-scan.md');
    // Must mention that user-configured value takes precedence
    expect(body).toMatch(/config\.discoveryOnClose\s*\?\?/);
    expect(body).toMatch(/always wins|always overrides|always override/i);
  });

  it('docs/session-config-reference.md documents the session-type-aware default and issue reference', () => {
    const body = read('docs/session-config-reference.md');
    // Updated field description must reference #264 and the new defaults
    expect(body).toMatch(/#264/);
    expect(body).toMatch(/housekeeping/);
    // Both new defaults documented
    expect(body).toMatch(/feature.*deep|deep.*feature/i);
  });
});
