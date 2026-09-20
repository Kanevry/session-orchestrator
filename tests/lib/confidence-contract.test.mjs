import { describe, it, expect } from 'vitest';

import { selectMode } from '@lib/mode-selector.mjs';
import { ALL_MODES, TIER_MODE_MAP } from '@lib/mode-selector/constants.mjs';
import { isNonExecutionMode } from '@lib/mode-selector/scoring.mjs';
import { FLAG_BOUNDS } from '@lib/autopilot/flags.mjs';
import { _parseDispatcherAutonomy } from '@lib/config/dispatcher-autonomy.mjs';

/**
 * Producer/consumer contract for the mode-selector confidence number.
 *
 * One producer (`selectMode`) emits a confidence; several consumers gate on it
 * with their own thresholds. Until this file nothing connected the two sides:
 * the autopilot tests lower the threshold to 0.3–0.5 and so never notice when
 * the producer's ceiling sinks below the shipped default. In 19 recorded
 * autopilot runs the default was never reached, and no test went red.
 *
 * What this catches that the rest of the suite does not (measured by mutation
 * against the 214 mode-selector + autopilot tests at 307ca800):
 *  - a consumer default raised above what the producer can emit — the old
 *    suite stays 214/214 green, because no test reads both sides;
 *  - a new mode added without deciding whether autopilot can ever run it.
 * Shrinking a bonus in scoring.mjs already turns unit tests red (6–8 of 214);
 * what those cannot say is that the change takes an executable mode below a
 * shipped threshold. The ceiling cases here state that consequence.
 *
 * Only thresholds that live in code are registered. session-start's 0.5 banner
 * cut-off exists solely as prose in skills/session-start/ and cannot be bound
 * here without pinning documentation (TV-002c).
 */

const CONSUMERS = Object.freeze({
  autopilot: FLAG_BOUNDS.confidenceThreshold.default,
  dispatcher: _parseDispatcherAutonomy('')['confidence-floor'],
});

const TIER_FOR_MODE = Object.fromEntries(
  Object.entries(TIER_MODE_MAP).map(([tier, mode]) => [mode, tier]),
);

/** Best realistic case: every bonus source present, no penalty triggered. */
function bestCaseSignals(mode, omit = null) {
  const signals = {
    recommendedMode: mode,
    completionRate: 1,
    carryoverRatio: 0,
    recentSessions: [1, 2, 3].map(() => ({ session_type: mode, completion_rate: 1 })),
    bootstrapLock: TIER_FOR_MODE[mode] ? { tier: TIER_FOR_MODE[mode] } : null,
    learnings: [
      { type: 'effective-sizing', subject: `${mode} scope` },
      { type: 'scope-guidance', subject: `${mode} sizing` },
    ],
    topPriorities: [],
  };
  if (omit !== null) delete signals[omit];
  return signals;
}

const ceiling = (mode, omit = null) => selectMode(bestCaseSignals(mode, omit)).confidence;

const EXECUTABLE_MODES = ALL_MODES.filter((m) => !isNonExecutionMode(m));

describe('confidence contract — producer ceiling vs. consumer thresholds', () => {
  it('registers consumer thresholds that are real numbers in [0, 1]', () => {
    for (const [name, threshold] of Object.entries(CONSUMERS)) {
      expect(typeof threshold, name).toBe('number');
      expect(threshold, name).toBeGreaterThanOrEqual(0);
      expect(threshold, name).toBeLessThanOrEqual(1);
    }
  });

  it('pins the producer ceiling per mode', () => {
    const ceilings = Object.fromEntries(ALL_MODES.map((m) => [m, ceiling(m)]));
    expect(ceilings).toEqual({
      housekeeping: 0.85,
      feature: 0.9,
      deep: 0.85,
      discovery: 0.75,
      evolve: 0.75,
      'plan-retro': 0.75,
    });
  });

  it('every executable mode can reach the dispatcher floor', () => {
    for (const mode of EXECUTABLE_MODES) {
      expect(ceiling(mode), mode).toBeGreaterThanOrEqual(CONSUMERS.dispatcher);
    }
  });

  it('lists exactly which executable modes can reach the autopilot default', () => {
    const reachable = EXECUTABLE_MODES.filter((m) => ceiling(m) >= CONSUMERS.autopilot);
    // `evolve` is missing on purpose: no bootstrap tier maps to it, so the tier
    // bonus is unobtainable and its ceiling stays at 0.75. Autopilot can never
    // run it at the shipped default. If you close that gap, add it here.
    expect(reachable).toEqual(['housekeeping', 'feature', 'deep']);
  });

  it('autopilot headroom is zero for housekeeping and deep — no bonus is spare', () => {
    for (const mode of ['housekeeping', 'deep']) {
      expect(ceiling(mode), mode).toBe(CONSUMERS.autopilot);
      for (const source of ['recentSessions', 'bootstrapLock', 'learnings']) {
        expect(ceiling(mode, source), `${mode} without ${source}`).toBeLessThan(CONSUMERS.autopilot);
      }
    }
  });

  it('feature clears the autopilot default only through the context-pressure bonus', () => {
    expect(ceiling('feature')).toBeGreaterThan(CONSUMERS.autopilot);
    expect(ceiling('feature', 'topPriorities')).toBe(CONSUMERS.autopilot);
  });
});
