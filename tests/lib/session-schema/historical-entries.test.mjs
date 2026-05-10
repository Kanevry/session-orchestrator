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
import { validateSession } from '../../../scripts/lib/session-schema/validator.mjs';
import { aliasLegacyEndedAt } from '../../../scripts/lib/session-schema/aliases.mjs';
import { migrateEntry } from '../../../scripts/migrate-sessions-jsonl.mjs';

const path = '.orchestrator/metrics/sessions.jsonl';

let lines;
try {
  lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
} catch {
  lines = []; // CI may run without metrics; skip gracefully
}

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
});
