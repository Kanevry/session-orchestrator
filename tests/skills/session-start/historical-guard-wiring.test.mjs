/**
 * tests/skills/session-start/historical-guard-wiring.test.mjs
 *
 * Regression: GL#621 stale-replay HISTORICAL guard wiring in session-start.
 * The HISTORICAL guard banner must remain present in SKILL.md prose at the four
 * injection points where prior-session context is surfaced — the `active`/`paused`
 * resume branch (Phase 1.5), the Recommendations Banner, the Snapshot Recovery
 * subsection, and the Phase 6.5 Previous Sessions subsection — so the coordinator
 * never treats a stale record as a live instruction.
 *
 * Without this snapshot test the doc wiring is invisible to CI — the SSOT module
 * (`scripts/lib/historical-guard.mjs`) ships green even when SKILL.md drops the
 * banner, and the documented crashed-session-resume incident class re-opens.
 *
 * Mirrors tests/skills/session-start/vault-staleness-skill-wiring.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HISTORICAL_GUARD_BANNER } from '@lib/historical-guard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills/session-start/SKILL.md');

describe('HISTORICAL guard wiring (#621, session-start)', () => {
  it('skills/session-start/SKILL.md exists at the expected path', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('the banner literal "NOT LIVE INSTRUCTIONS" is present in SKILL.md', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('NOT LIVE INSTRUCTIONS');
  });

  it('embeds the byte-identical canonical banner literal from the SSOT module', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain(HISTORICAL_GUARD_BANNER);
  });

  it('cites the SSOT module path scripts/lib/historical-guard.mjs', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    expect(body).toContain('scripts/lib/historical-guard.mjs');
  });

  it('the guard appears in the `status: active` resume region, before the Recommendations Banner heading', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    const idxActive = body.indexOf('`status: active` — previous session crashed');
    const idxGuard = body.indexOf('NOT LIVE INSTRUCTIONS');
    const idxNextHeading = body.indexOf('### Recommendations Banner (Epic #271 Phase A)');

    expect(idxActive).toBeGreaterThan(-1);
    expect(idxGuard).toBeGreaterThan(-1);
    expect(idxNextHeading).toBeGreaterThan(-1);
    expect(idxGuard).toBeGreaterThan(idxActive);
    expect(idxGuard).toBeLessThan(idxNextHeading);
  });

  it('the guard is present near the Snapshot Recovery subsection', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    const idxSnapshot = body.indexOf('### Snapshot Recovery (#196)');
    const guardInSnapshot = body.indexOf('NOT LIVE INSTRUCTIONS', idxSnapshot);
    const idxCurrentTaskBanner = body.indexOf('### Current-Task Banner', idxSnapshot);

    expect(idxSnapshot).toBeGreaterThan(-1);
    expect(guardInSnapshot).toBeGreaterThan(idxSnapshot);
    expect(idxCurrentTaskBanner).toBeGreaterThan(-1);
    expect(guardInSnapshot).toBeLessThan(idxCurrentTaskBanner);
  });

  it('the guard is present near the Recommendations Banner subsection', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    const idxRecBanner = body.indexOf('### Recommendations Banner (Epic #271 Phase A)');
    const guardInRec = body.indexOf('NOT LIVE INSTRUCTIONS', idxRecBanner);
    const idxIdleReset = body.indexOf('### Idle Reset', idxRecBanner);

    expect(idxRecBanner).toBeGreaterThan(-1);
    expect(guardInRec).toBeGreaterThan(idxRecBanner);
    expect(idxIdleReset).toBeGreaterThan(-1);
    expect(guardInRec).toBeLessThan(idxIdleReset);
  });

  it('the guard is present in the Phase 6.5 Previous Sessions subsection', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');
    const idxPhase65 = body.indexOf('## Phase 6.5: Memory Recall');
    const idxPrevSessions = body.indexOf('**Previous Sessions** subsection', idxPhase65);
    const guardAfterPrevSessions = body.indexOf('NOT LIVE INSTRUCTIONS', idxPrevSessions);
    const idxPhase66 = body.indexOf('## Phase 6.6', idxPhase65);

    expect(idxPhase65).toBeGreaterThan(-1);
    expect(idxPrevSessions).toBeGreaterThan(-1);
    expect(guardAfterPrevSessions).toBeGreaterThan(idxPrevSessions);
    expect(idxPhase66).toBeGreaterThan(-1);
    expect(guardAfterPrevSessions).toBeLessThan(idxPhase66);
  });
});
