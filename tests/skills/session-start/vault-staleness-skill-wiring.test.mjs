/**
 * tests/skills/session-start/vault-staleness-skill-wiring.test.mjs
 *
 * Regression: GH#319 vault-staleness banner wiring in session-start Phase 4.
 * The banner block must remain present, sit between the bootstrap-lock-freshness
 * block and the "All banners are non-blocking" terminator, reference the helper
 * module path, and document both severity levels (warn + alert).
 *
 * Without this snapshot test the doc wiring is invisible to CI — the helper
 * (`scripts/lib/vault-staleness-banner.mjs`) and JSONL writer ship green even
 * when SKILL.md drops the wiring, and the banner stops rendering in production.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills/session-start/SKILL.md');

describe('vault-staleness banner wiring (#319, session-start Phase 4)', () => {
  it('skills/session-start/SKILL.md exists at the expected path', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('Phase 4 references the vault-staleness JSONL artifact', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('.orchestrator/metrics/vault-staleness.jsonl');
  });

  it('vault-staleness block sits between bootstrap-lock-freshness and the "All banners are non-blocking" terminator', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    const idxBootstrapLock = body.indexOf('bootstrap-lock-freshness');
    const idxVaultStaleness = body.indexOf('vault-staleness.jsonl');
    const idxTerminator = body.indexOf('All banners are non-blocking');

    expect(idxBootstrapLock).toBeGreaterThan(-1);
    expect(idxVaultStaleness).toBeGreaterThan(-1);
    expect(idxTerminator).toBeGreaterThan(-1);
    expect(idxBootstrapLock).toBeLessThan(idxVaultStaleness);
    expect(idxVaultStaleness).toBeLessThan(idxTerminator);
  });

  it('block references the helper module path scripts/lib/vault-staleness-banner.mjs', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('scripts/lib/vault-staleness-banner.mjs');
  });

  it('block documents both severity levels (warn + alert) with their delta_hours thresholds', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toMatch(/\*\*warn\*\*\s*\(`stale_count\s*>\s*0`,\s*max\s*`delta_hours\s*<=\s*48`\)/);
    expect(body).toMatch(/\*\*alert\*\*\s*\(`stale_count\s*>\s*0`,\s*max\s*`delta_hours\s*>\s*48`\)/);
  });
});
