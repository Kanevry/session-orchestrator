/**
 * tests/lib/session-schema/historical-entries.test.mjs
 *
 * ADR-364 DoD-1: validates that all historical entries in
 * .orchestrator/metrics/sessions.jsonl pass the post-ADR-364 validator.
 * This is the canonical additive-contract proof for the thin-slice.
 *
 * Design notes:
 * - Reads the real production JSONL on disk. If the file is absent (CI
 *   runner without metrics), all assertions are skipped via it.skipIf.
 * - Uses migrateEntry (which calls normalizeSession internally) to mirror
 *   the production full read-path, including reconstruction of legacy
 *   required-field shapes (total_agents, waves array, etc.).
 * - No exact counts pinned — count is dynamic; floor/ceiling guards added
 *   to satisfy test-quality.md dynamic-artifact rule.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { validateSession, ValidationError } from '@lib/session-schema/validator.mjs';
import { aliasLegacyEndedAt } from '@lib/session-schema/aliases.mjs';
import { migrateEntry } from '../../../scripts/migrate-sessions-jsonl.mjs';

const path = '.orchestrator/metrics/sessions.jsonl';

let lines;
try {
  lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
} catch {
  lines = []; // CI may run without metrics; skip gracefully
}

/**
 * Canonical ISO-8601 UTC timestamp regex — mirrors the one in
 * scripts/lib/session-schema/validator.mjs. Accepts `YYYY-MM-DDTHH:MM:SSZ`
 * and `YYYY-MM-DDTHH:MM:SS.SSSZ` (3 fractional digits).
 *
 * Issue #540 defense-in-depth layer (c): test-time guarantee that no
 * historical entry slipped through with a non-canonical timestamp (e.g.
 * `.3NZ`). Combined with the writer-side regex in validator.mjs, this
 * closes the loop.
 */
const ISO_8601_UTC_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

describe('historical sessions.jsonl entries — additive contract (ADR-364 DoD-1)', () => {
  it.skipIf(lines.length === 0)(
    `validates all ${lines.length} historical entries with the post-ADR-364 validator`,
    () => {
      const failures = [];
      lines.forEach((line, idx) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          failures.push(`line ${idx + 1}: JSON parse failed — ${err.message}`);
          return;
        }
        try {
          // Apply the full production read-path in the correct order:
          // 1. aliasLegacyEndedAt: ended_at → completed_at (issue #321)
          // 2. migrateEntry: normalizeSession aliases + legacy-shape
          //    reconstruction (total_agents, waves array synthesis, etc.).
          //    normalizeSession applies SESSION_KEY_ALIASES, including
          //    `mode → session_type` (#373).
          const withEndedAt = aliasLegacyEndedAt(parsed);
          const migrated = migrateEntry(withEndedAt);
          validateSession(migrated);
        } catch (err) {
          failures.push(`line ${idx + 1} (session_id=${parsed.session_id ?? '?'}): ${err.message}`);
        }
      });
      if (failures.length > 0) {
        throw new Error(
          `${failures.length}/${lines.length} entries failed validation:\n${failures.join('\n')}`
        );
      }
    }
  );

  it.skipIf(lines.length === 0)(
    'asserts no v2 schema_version literal exists in current entries',
    () => {
      const v2Hits = lines.filter((line) => /"schema_version"\s*:\s*("v2"|2[^0-9])/.test(line));
      expect(v2Hits).toEqual([]);
    }
  );

  it.skipIf(lines.length === 0)(
    'has a reasonable number of entries (floor/ceiling sanity — test-quality.md dynamic-artifact rule)',
    () => {
      // Floor: ≥1 (at least one entry exists if the file is present).
      // Ceiling: 10 000 (guards against accidental duplication / file corruption).
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(10_000);
    }
  );

  it.skipIf(lines.length === 0)(
    `all historical sessions.jsonl entries have canonical ISO-8601 timestamps (#540 regression guard)`,
    () => {
      // Issue #540: every entry's `started_at` and `completed_at` MUST match
      // the canonical UTC ms regex (no `.3NZ`-class malformed-fraction values).
      // The validator now enforces this at write-time; this test enforces it
      // at the file level so any drift in the existing JSONL surfaces here.
      const failures = [];
      lines.forEach((line, idx) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // JSON parse failures are already caught by the prior test — skip
          // this entry here to keep error attribution clean.
          return;
        }
        // Apply the legacy-aliasing read-path so `ended_at`-only entries are
        // checked under their canonical `completed_at` value.
        const withEndedAt = aliasLegacyEndedAt(parsed);
        const sessId = parsed.session_id ?? `line ${idx + 1}`;
        if (
          typeof withEndedAt.started_at === 'string' &&
          !ISO_8601_UTC_MS_RE.test(withEndedAt.started_at)
        ) {
          failures.push(`${sessId}: started_at "${withEndedAt.started_at}" not canonical`);
        }
        if (
          typeof withEndedAt.completed_at === 'string' &&
          !ISO_8601_UTC_MS_RE.test(withEndedAt.completed_at)
        ) {
          failures.push(`${sessId}: completed_at "${withEndedAt.completed_at}" not canonical`);
        }
      });
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} timestamp(s) failed canonical ISO-8601 check:\n${failures.join('\n')}`
        );
      }
    }
  );
});

// ---------------------------------------------------------------------------
// #540 defense-in-depth layer (b) — writer-side regex guard.
// Negative + positive cases on the public validator entry point. We use
// validateSession (the only export) with a minimal-VALID base entry, mutating
// only the timestamp under test. This guarantees we exercise the new regex
// branch in _validateTimestamps without making the helper public.
// ---------------------------------------------------------------------------

const VALID_BASE = () => ({
  session_id: 'sess-540-regression',
  session_type: 'deep',
  started_at: '2026-05-23T10:00:00Z',
  completed_at: '2026-05-23T11:00:00Z',
  total_waves: 1,
  waves: [{ wave: 1, role: 'implement' }],
  agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
  total_agents: 1,
  total_files_changed: 1,
});

describe('#540 writer-side ISO-8601 canonical regex guard', () => {
  it('validateSession rejects .3NZ-shaped completed_at (#540)', () => {
    // Note: `Date.parse('2026-05-23T10:40:06.3NZ')` returns NaN, so the
    // upstream parsable-timestamp guard fires before the new regex check.
    // Either message satisfies the #540 acceptance criterion — both reject.
    const entry = { ...VALID_BASE(), completed_at: '2026-05-23T10:40:06.3NZ' };
    expect(() => validateSession(entry)).toThrow(ValidationError);
    expect(() => validateSession(entry)).toThrow(/not a parsable timestamp|ISO-8601/);
  });

  it('validateSession rejects .3NZ-shaped started_at (#540)', () => {
    const entry = { ...VALID_BASE(), started_at: '2026-05-23T10:40:06.3NZ' };
    expect(() => validateSession(entry)).toThrow(ValidationError);
    expect(() => validateSession(entry)).toThrow(/not a parsable timestamp|ISO-8601/);
  });

  it('validateSession accepts canonical .SSSZ form', () => {
    const entry = {
      ...VALID_BASE(),
      started_at: '2026-05-23T10:40:06.300Z',
      completed_at: '2026-05-23T10:40:06.300Z',
    };
    expect(() => validateSession(entry)).not.toThrow();
  });

  it('validateSession accepts canonical no-fraction Z form', () => {
    const entry = {
      ...VALID_BASE(),
      started_at: '2026-05-23T10:40:06Z',
      completed_at: '2026-05-23T10:40:06Z',
    };
    expect(() => validateSession(entry)).not.toThrow();
  });

  it('validateSession rejects non-3-digit fraction (e.g. .30Z) via the new regex', () => {
    // Defense against under/over-precision drift. `Date.parse` ACCEPTS `.30Z`
    // (treats it as 300ms) — the new regex is the layer catching it. This is
    // the canonical proof that the regex adds value beyond `Date.parse` alone.
    const entry = { ...VALID_BASE(), completed_at: '2026-05-23T10:40:06.30Z' };
    expect(() => validateSession(entry)).toThrow(/ISO-8601/);
  });

  it('validateSession rejects non-UTC timezone offset (e.g. +02:00) via the new regex', () => {
    // `Date.parse` ACCEPTS `+02:00` (treats as valid offset). The new regex
    // rejects it because canonical writer (`new Date().toISOString()`) ALWAYS
    // emits UTC `Z`, never an offset — grep/sort semantics downstream depend
    // on this invariant.
    const entry = { ...VALID_BASE(), completed_at: '2026-05-23T10:40:06+02:00' };
    expect(() => validateSession(entry)).toThrow(/ISO-8601/);
  });
});
