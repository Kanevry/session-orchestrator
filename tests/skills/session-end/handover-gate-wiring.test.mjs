/**
 * tests/skills/session-end/handover-gate-wiring.test.mjs
 *
 * Regression: #769 Close Handover-Alignment-Gate — the feature's architecture
 * is skill-prose-first (per the PRD): the AUQ interaction and candidate
 * collection logic live in SKILL.md / wave-loop.md prose that references
 * `.mjs` function names and Session Config keys by string. A future rename in
 * the libs (scripts/lib/handover-gate.mjs, scripts/lib/state-md.mjs) would
 * silently break the prose with no test catching it, because the prose is
 * never executed directly.
 *
 * Mirrors tests/skills/session-end/what-not-to-retry-wiring.test.mjs (the
 * #623 sibling feature's wiring test): asserts the doc wiring is present and
 * correctly scoped, PLUS ties the string assertions to the real exports so a
 * rename on either side of the seam fails this test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeCandidates, normalizeCandidate } from '../../../scripts/lib/handover-gate.mjs';
import {
  readOpenQuestions,
  appendOpenQuestion,
  markOpenQuestionAnswered,
  appendOpenQuestionOnDisk,
  markOpenQuestionAnsweredOnDisk,
} from '../../../scripts/lib/state-md.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SESSION_END_PATH = path.join(REPO_ROOT, 'skills/session-end/SKILL.md');
const WAVE_LOOP_PATH = path.join(REPO_ROOT, 'skills/wave-executor/wave-loop.md');
const SESSION_START_PATH = path.join(REPO_ROOT, 'skills/session-start/SKILL.md');

describe('Handover Alignment Gate prose↔code wiring (#769, session-end)', () => {
  const sessionEndBody = readFileSync(SESSION_END_PATH, 'utf8');
  const waveLoopBody = readFileSync(WAVE_LOOP_PATH, 'utf8');
  const sessionStartBody = readFileSync(SESSION_START_PATH, 'utf8');

  it('skills/session-end/SKILL.md exists at the expected path', () => {
    expect(existsSync(SESSION_END_PATH)).toBe(true);
  });

  it('skills/wave-executor/wave-loop.md exists at the expected path', () => {
    expect(existsSync(WAVE_LOOP_PATH)).toBe(true);
  });

  it('skills/session-start/SKILL.md exists at the expected path', () => {
    expect(existsSync(SESSION_START_PATH)).toBe(true);
  });

  describe('session-end: Phase 1.65 Handover Alignment Gate', () => {
    it('contains the 1.65 Handover Alignment Gate phase heading', () => {
      expect(sessionEndBody).toContain('### 1.65 Handover Alignment Gate (#769)');
    });

    it('the 1.65 region references routeCandidates from scripts/lib/handover-gate.mjs', () => {
      const idx165 = sessionEndBody.indexOf('### 1.65 Handover Alignment Gate (#769)');
      const idx17 = sessionEndBody.indexOf('### 1.7 Metrics Collection', idx165);
      const region = sessionEndBody.slice(idx165, idx17);
      expect(region).toContain('routeCandidates');
      expect(region).toContain('scripts/lib/handover-gate.mjs');
    });

    it("the 1.65 region references the cfg['handover-gate'] config key", () => {
      const idx165 = sessionEndBody.indexOf('### 1.65 Handover Alignment Gate (#769)');
      const idx17 = sessionEndBody.indexOf('### 1.7 Metrics Collection', idx165);
      const region = sessionEndBody.slice(idx165, idx17);
      expect(region).toContain("cfg['handover-gate']");
    });

    it('the 1.65 region sits between Phase 1.6.6 and Phase 1.7', () => {
      const idx166 = sessionEndBody.indexOf('#### 1.6.6 Record "What Not To Retry"');
      const idx165 = sessionEndBody.indexOf('### 1.65 Handover Alignment Gate (#769)');
      const idx17 = sessionEndBody.indexOf('### 1.7 Metrics Collection');
      expect(idx166).toBeGreaterThan(-1);
      expect(idx165).toBeGreaterThan(idx166);
      expect(idx17).toBeGreaterThan(idx165);
    });
  });

  describe('session-end: durable open-question mark lives in Phase 5, not Phase 1.65', () => {
    it('Phase 5: Issue Cleanup heading exists', () => {
      expect(sessionEndBody).toContain('## Phase 5: Issue Cleanup');
    });

    it('the markOpenQuestionAnsweredOnDisk import site appears AFTER the Phase 5 heading (atomicity fix)', () => {
      const idxPhase5 = sessionEndBody.indexOf('## Phase 5: Issue Cleanup');
      const idxImport = sessionEndBody.indexOf(
        'import { markOpenQuestionAnsweredOnDisk }',
        idxPhase5
      );
      expect(idxPhase5).toBeGreaterThan(-1);
      expect(idxImport).toBeGreaterThan(idxPhase5);
    });

    it('Phase 1.65 explicitly defers the on-disk mark (do NOT call it in this phase)', () => {
      const idx165 = sessionEndBody.indexOf('### 1.65 Handover Alignment Gate (#769)');
      const idx17 = sessionEndBody.indexOf('### 1.7 Metrics Collection', idx165);
      const region = sessionEndBody.slice(idx165, idx17);
      expect(region).toContain('Do **NOT** call `markOpenQuestionAnsweredOnDisk` in this phase');
    });
  });

  describe('wave-executor: open-question collection wiring', () => {
    it('wave-loop.md references appendOpenQuestionOnDisk', () => {
      expect(waveLoopBody).toContain('appendOpenQuestionOnDisk');
    });

    it('wave-loop.md contains an OPEN-QUESTIONS: agent-report-line instruction', () => {
      expect(waveLoopBody).toContain('OPEN-QUESTIONS:');
    });
  });

  describe('session-start: Phase 6.5.2 forced-read wiring', () => {
    it('contains the Phase 6.5.2 Open Questions heading', () => {
      expect(sessionStartBody).toContain('## Phase 6.5.2: Open Questions (forced-read, #772)');
    });

    it('the 6.5.2 region references readOpenQuestions AND wrapHistorical', () => {
      const idx652 = sessionStartBody.indexOf('## Phase 6.5.2: Open Questions (forced-read, #772)');
      const idx66 = sessionStartBody.indexOf('## Phase 6.6: Project Intelligence', idx652);
      const region = sessionStartBody.slice(idx652, idx66);
      expect(region).toContain('readOpenQuestions');
      expect(region).toContain('wrapHistorical');
    });
  });

  describe('load-bearing guard: prose-referenced symbols are ACTUALLY exported', () => {
    it('routeCandidates is exported from scripts/lib/handover-gate.mjs as a function', () => {
      expect(typeof routeCandidates).toBe('function');
    });

    it('normalizeCandidate is exported from scripts/lib/handover-gate.mjs as a function', () => {
      expect(typeof normalizeCandidate).toBe('function');
    });

    it('readOpenQuestions is exported from scripts/lib/state-md.mjs as a function', () => {
      expect(typeof readOpenQuestions).toBe('function');
    });

    it('appendOpenQuestion is exported from scripts/lib/state-md.mjs as a function', () => {
      expect(typeof appendOpenQuestion).toBe('function');
    });

    it('markOpenQuestionAnswered is exported from scripts/lib/state-md.mjs as a function', () => {
      expect(typeof markOpenQuestionAnswered).toBe('function');
    });

    it('appendOpenQuestionOnDisk is exported from scripts/lib/state-md.mjs as a function', () => {
      expect(typeof appendOpenQuestionOnDisk).toBe('function');
    });

    it('markOpenQuestionAnsweredOnDisk is exported from scripts/lib/state-md.mjs as a function', () => {
      expect(typeof markOpenQuestionAnsweredOnDisk).toBe('function');
    });
  });
});
