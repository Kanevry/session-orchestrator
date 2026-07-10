/**
 * tests/skills/session-end/what-not-to-retry-wiring.test.mjs
 *
 * Regression: GL#623 "What Not To Retry" cross-session continuity slot — the
 * session-end POPULATE wiring. session-end Phase 1.6 (the SPIRAL/FAILED walk)
 * must reference `appendWhatNotToRetryOnDisk` so that every SPIRAL/FAILED agent
 * records a durable "do not re-attempt" entry into STATE.md.
 *
 * Phase 1.6.6 is a documented procedure (not directly executable JS from the
 * SKILL), so this test asserts the doc wiring is present and correctly scoped
 * to the SPIRAL/FAILED region — mirroring
 * tests/skills/session-end/phase-2-3-vault-staleness.test.mjs (dimension C).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills/session-end/SKILL.md');

describe('What Not To Retry populate wiring (#623, session-end)', () => {
  const body = readFileSync(SKILL_PATH, 'utf8');

  it('skills/session-end/SKILL.md exists at the expected path', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('Phase 1.6 contains a 1.6.6 "What Not To Retry" sub-step heading', () => {
    expect(body).toContain('#### 1.6.6 Record "What Not To Retry" entries (#623)');
  });

  it('the populate step references appendWhatNotToRetryOnDisk', () => {
    expect(body).toContain('appendWhatNotToRetryOnDisk');
  });

  it('the populate step imports from the state-md barrel', () => {
    const idx16 = body.indexOf('#### 1.6.6');
    const idx17 = body.indexOf('### 1.7 Metrics Collection', idx16);
    const region = body.slice(idx16, idx17);
    expect(region).toContain('scripts/lib/state-md.mjs');
  });

  it('the populate step sits inside Phase 1.6, before Phase 1.7', () => {
    const idx16Heading = body.indexOf('### 1.6 Safety Review');
    const idx166 = body.indexOf('#### 1.6.6 Record "What Not To Retry"');
    const idx17 = body.indexOf('### 1.7 Metrics Collection');
    expect(idx16Heading).toBeGreaterThan(-1);
    expect(idx166).toBeGreaterThan(idx16Heading);
    expect(idx17).toBeGreaterThan(idx166);
  });

  it('the entry payload documents the {approach, why_failed, session_id, date} shape', () => {
    const idx166 = body.indexOf('#### 1.6.6');
    const idx17 = body.indexOf('### 1.7 Metrics Collection', idx166);
    const region = body.slice(idx166, idx17);
    expect(region).toContain('approach:');
    expect(region).toContain('why_failed:');
    expect(region).toContain('session_id:');
    expect(region).toContain('date:');
  });

  it('the populate step ties entries to SPIRAL/FAILED agents', () => {
    const idx166 = body.indexOf('#### 1.6.6');
    const idx17 = body.indexOf('### 1.7 Metrics Collection', idx166);
    const region = body.slice(idx166, idx17);
    expect(region).toMatch(/SPIRAL/);
    expect(region).toMatch(/FAILED/);
  });

  it('the populate step requires why_failed to cite file-level evidence (#730)', () => {
    const idx166 = body.indexOf('#### 1.6.6');
    const idx17 = body.indexOf('### 1.7 Metrics Collection', idx166);
    const region = body.slice(idx166, idx17);
    expect(region).toContain('evidence');
    expect(region).toMatch(/file/i);
  });
});
