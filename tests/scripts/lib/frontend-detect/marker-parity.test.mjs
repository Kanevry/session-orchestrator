/**
 * tests/scripts/lib/frontend-detect/marker-parity.test.mjs
 *
 * Prose↔detector parity gate. The deterministic frontend-slop detector
 * (`scripts/lib/frontend-detect/rules.mjs`) is only half the "Disziplin statt
 * Mechanik" loop — the prose in `rules/opt-in-stack/frontend.md` (moved out of
 * `.claude/rules/` by #743 Option A) is the other half: it teaches the model
 * what NOT to emit, the detector catches what slips through. Each detector
 * rule MUST have a `<!-- rule:<id> -->` marker in the prose, and every marker
 * MUST map to a live rule. This test enforces both directions so the two
 * never silently drift apart.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RULE_IDS } from '@lib/frontend-detect/rules.mjs';

// Resolve repo root portably: this file lives at
// <repo>/tests/scripts/lib/frontend-detect/marker-parity.test.mjs (4 dirs deep).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const FRONTEND_RULES_PATH = path.join(repoRoot, 'rules', 'opt-in-stack', 'frontend.md');
const frontendMd = readFileSync(FRONTEND_RULES_PATH, 'utf8');

/** Every `<!-- rule:<id> -->` marker id found in frontend.md, in document order. */
function extractMarkerIds(content) {
  const ids = [];
  const re = /<!-- rule:(\S+) -->/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

describe('frontend-detect prose↔detector marker parity', () => {
  it('every detector rule id has exactly one prose marker', () => {
    for (const id of RULE_IDS) {
      const occurrences = (frontendMd.match(new RegExp(`<!-- rule:${id} -->`, 'g')) ?? []).length;
      expect(occurrences, `marker count for rule "${id}" in frontend.md`).toBe(1);
    }
  });

  it('every prose marker id maps to a live detector rule', () => {
    const markerIds = extractMarkerIds(frontendMd);
    const liveIds = new Set(RULE_IDS);
    for (const id of markerIds) {
      expect(liveIds.has(id), `marker "${id}" must be a member of RULE_IDS (stale/typo'd marker?)`).toBe(true);
    }
  });

  it('no marker id is duplicated', () => {
    const markerIds = extractMarkerIds(frontendMd);
    expect(new Set(markerIds).size).toBe(markerIds.length);
  });

  it('marker set exactly equals the detector rule-id set (bidirectional)', () => {
    const markerIds = extractMarkerIds(frontendMd);
    expect([...markerIds].sort()).toEqual([...RULE_IDS].sort());
  });
});
