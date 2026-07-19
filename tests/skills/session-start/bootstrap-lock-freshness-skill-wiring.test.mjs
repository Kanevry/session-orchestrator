/**
 * tests/skills/session-start/bootstrap-lock-freshness-skill-wiring.test.mjs
 *
 * Regression: GH#57 fixed the bootstrap-lock-freshness probe's no-op
 * remediation — `/bootstrap --retroactive` is an idempotent no-op once the
 * lock already has valid `version`/`tier` fields (see the Retroactive Flow's
 * idempotency guard in skills/bootstrap/SKILL.md), so recommending it
 * unconditionally for a present-but-stale lock sent the operator in a circle.
 *
 * This snapshot pins the prose fix: the present-lock warn/alert banners in
 * session-start Phase 4 must reference `--refresh-lock` (the actual
 * remediation), and only the `missing`-lock case may still recommend
 * `--retroactive` (there is no lock to refresh in that case).
 *
 * Pattern: tests/skills/session-start/vault-staleness-skill-wiring.test.mjs
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills/session-start/SKILL.md');

/** Extract the bootstrap-lock-freshness banner block (between the "Plugin
 * freshness" step-4 lead-in and the vault-staleness step that follows it). */
function extractBootstrapLockBlock(body) {
  const start = body.indexOf('bootstrap-lock-freshness probe');
  const end = body.indexOf('Additionally, if `.orchestrator/metrics/vault-staleness.jsonl`');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

describe('bootstrap-lock-freshness banner wiring (#57, session-start Phase 4)', () => {
  it('skills/session-start/SKILL.md exists at the expected path', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('Phase 4 references the bootstrap-lock-freshness helper module path', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('scripts/lib/bootstrap-lock-freshness.mjs');
  });

  it('the block is reason-aware — references result.details.reason (#57)', () => {
    const block = extractBootstrapLockBlock(readFileSync(SKILL_PATH, 'utf8'));
    expect(block).toMatch(/details\.reason/);
  });

  it('present-lock warn/alert banners recommend /bootstrap --refresh-lock', () => {
    const block = extractBootstrapLockBlock(readFileSync(SKILL_PATH, 'utf8'));
    expect(block).toContain('/bootstrap --refresh-lock');
    // stale-age / unparseable-timestamp remediation
    expect(block).toMatch(/reason`\s*=\s*`stale-age`.*refresh-lock/s);
    // version-mismatch remediation
    expect(block).toMatch(/version-mismatch-unparseable[\s\S]*?--refresh-lock/);
    expect(block).toMatch(/version-mismatch-major[\s\S]*?--refresh-lock/);
  });

  it('the missing-lock case still recommends /bootstrap --retroactive', () => {
    const block = extractBootstrapLockBlock(readFileSync(SKILL_PATH, 'utf8'));
    expect(block).toMatch(/reason`\s*=\s*`missing`[\s\S]*?--retroactive/);
  });

  it('does not unconditionally recommend --retroactive for a present lock — no bare fallback line', () => {
    const block = extractBootstrapLockBlock(readFileSync(SKILL_PATH, 'utf8'));
    // The old unconditional lines this fix replaced:
    //   "consider re-running /bootstrap --retroactive to refresh."
    //   "re-run /bootstrap --retroactive is strongly recommended." (unconditional — any alert)
    expect(block).not.toContain('consider re-running /bootstrap --retroactive to refresh');
    // The only surviving "--retroactive is strongly recommended" occurrence must be
    // scoped to the `missing` reason, not a bare/unconditional alert-level line.
    const retroactiveStronglyRecommendedCount = (
      block.match(/--retroactive is strongly recommended/g) || []
    ).length;
    expect(retroactiveStronglyRecommendedCount).toBe(1);
  });

  it('legacy-lock (no plugin-version) line now stamps a plugin-version reference via --refresh-lock', () => {
    const block = extractBootstrapLockBlock(readFileSync(SKILL_PATH, 'utf8'));
    expect(block).toMatch(/legacy lock without plugin-version[\s\S]*?--refresh-lock to stamp a current plugin-version reference/);
  });
});
