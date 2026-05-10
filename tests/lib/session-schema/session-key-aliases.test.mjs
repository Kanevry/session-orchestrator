/**
 * tests/lib/session-schema/session-key-aliases.test.mjs
 *
 * Table-driven coverage for SESSION_KEY_ALIASES (#373 — adds mode →
 * session_type so the historical-entries pipeline no longer needs an
 * inline workaround for 2026-05-10 entries that wrote `mode` instead of
 * `session_type`).
 *
 * Why this test catches a real bug:
 * - If `normalizeSession` stopped iterating SESSION_KEY_ALIASES, every
 *   `it.each` row would fail (expected canonical key would be missing).
 * - If someone removed `mode: 'session_type'` from the alias map, the
 *   dedicated `mode → session_type alias is registered` test would fail.
 * - Hardcoded literal expected values per `.claude/rules/test-quality.md`
 *   (no tautological computation — we do NOT replicate the normalizer's
 *   logic to derive the expected value).
 */

import { describe, it, expect } from 'vitest';
import { SESSION_KEY_ALIASES } from '../../../scripts/lib/session-schema/constants.mjs';
import { normalizeSession } from '../../../scripts/lib/session-schema/normalizer.mjs';

describe('SESSION_KEY_ALIASES — per-alias normalization', () => {
  /** @type {Array<[string, string]>} */
  const cases = Object.entries(SESSION_KEY_ALIASES);

  it('every alias maps an old key to a non-empty canonical key', () => {
    for (const [oldKey, newKey] of cases) {
      expect(typeof oldKey).toBe('string');
      expect(typeof newKey).toBe('string');
      expect(oldKey.length).toBeGreaterThan(0);
      expect(newKey.length).toBeGreaterThan(0);
      expect(oldKey).not.toBe(newKey);
    }
  });

  it.each(cases)('normalizeSession lifts %s → %s additively', (oldKey, newKey) => {
    const value = `value-for-${oldKey}`;
    const out = normalizeSession({ session_id: 's1', [oldKey]: value });
    expect(out[newKey]).toBe(value);
    // Additive contract: original key preserved (non-destructive rename).
    expect(out[oldKey]).toBe(value);
  });

  it('does NOT clobber an existing canonical value when both old and new keys are present', () => {
    const out = normalizeSession({
      session_id: 's1',
      mode: 'legacy-value',
      session_type: 'canonical-value',
    });
    expect(out.session_type).toBe('canonical-value');
    expect(out.mode).toBe('legacy-value');
  });

  it('mode → session_type alias is registered (#373)', () => {
    expect(SESSION_KEY_ALIASES.mode).toBe('session_type');
  });

  it('normalizeSession lifts mode → session_type end-to-end (#373)', () => {
    const out = normalizeSession({ session_id: 's-2026-05-10', mode: 'deep' });
    expect(out.session_type).toBe('deep');
    expect(out.mode).toBe('deep');
  });
});
