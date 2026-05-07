import { describe, it, expect } from 'vitest';
import {
  MISSION_STATUS_VALUES,
  isValidMissionStatus,
  isValidMissionStatusTransition,
  validateMissionStatusEntry,
} from '../../scripts/lib/mission-status-schema.mjs';

// Test 1: MISSION_STATUS_VALUES is frozen and contains exactly the 5 expected values in order
describe('MISSION_STATUS_VALUES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(MISSION_STATUS_VALUES)).toBe(true);
  });

  it('contains exactly 5 values in the canonical lifecycle order', () => {
    expect(MISSION_STATUS_VALUES).toHaveLength(5);
    expect(MISSION_STATUS_VALUES[0]).toBe('brainstormed');
    expect(MISSION_STATUS_VALUES[1]).toBe('validated');
    expect(MISSION_STATUS_VALUES[2]).toBe('in-dev');
    expect(MISSION_STATUS_VALUES[3]).toBe('testing');
    expect(MISSION_STATUS_VALUES[4]).toBe('completed');
  });
});

// Test 2 & 3: isValidMissionStatus
describe('isValidMissionStatus', () => {
  it('returns true for each of the 5 canonical values', () => {
    expect(isValidMissionStatus('brainstormed')).toBe(true);
    expect(isValidMissionStatus('validated')).toBe(true);
    expect(isValidMissionStatus('in-dev')).toBe(true);
    expect(isValidMissionStatus('testing')).toBe(true);
    expect(isValidMissionStatus('completed')).toBe(true);
  });

  it('returns false for unknown string, null, and undefined', () => {
    expect(isValidMissionStatus('foo')).toBe(false);
    expect(isValidMissionStatus(null)).toBe(false);
    expect(isValidMissionStatus(undefined)).toBe(false);
  });

  it('returns false for empty string and numeric values', () => {
    expect(isValidMissionStatus('')).toBe(false);
    expect(isValidMissionStatus(0)).toBe(false);
  });
});

// Tests 4-7: valid forward transitions
describe('isValidMissionStatusTransition — forward transitions', () => {
  it('brainstormed → validated is allowed', () => {
    expect(isValidMissionStatusTransition('brainstormed', 'validated')).toBe(true);
  });

  it('validated → in-dev is allowed', () => {
    expect(isValidMissionStatusTransition('validated', 'in-dev')).toBe(true);
  });

  it('in-dev → testing is allowed', () => {
    expect(isValidMissionStatusTransition('in-dev', 'testing')).toBe(true);
  });

  it('testing → completed is allowed', () => {
    expect(isValidMissionStatusTransition('testing', 'completed')).toBe(true);
  });
});

// Test 8: idempotent self-transitions
describe('isValidMissionStatusTransition — idempotent same-state', () => {
  it('in-dev → in-dev is allowed (self-transition)', () => {
    expect(isValidMissionStatusTransition('in-dev', 'in-dev')).toBe(true);
  });

  it('brainstormed → brainstormed is allowed (self-transition)', () => {
    expect(isValidMissionStatusTransition('brainstormed', 'brainstormed')).toBe(true);
  });

  it('completed → completed is allowed (self-transition)', () => {
    expect(isValidMissionStatusTransition('completed', 'completed')).toBe(true);
  });
});

// Test 9: rollback to brainstormed from any non-brainstormed state
describe('isValidMissionStatusTransition — rollback to brainstormed', () => {
  it('validated → brainstormed is allowed (rollback)', () => {
    expect(isValidMissionStatusTransition('validated', 'brainstormed')).toBe(true);
  });

  it('in-dev → brainstormed is allowed (rollback)', () => {
    expect(isValidMissionStatusTransition('in-dev', 'brainstormed')).toBe(true);
  });

  it('testing → brainstormed is allowed (rollback)', () => {
    expect(isValidMissionStatusTransition('testing', 'brainstormed')).toBe(true);
  });

  it('completed → brainstormed is allowed (rollback)', () => {
    expect(isValidMissionStatusTransition('completed', 'brainstormed')).toBe(true);
  });
});

// Test 10: invalid forward jumps and backward non-rollback transitions
describe('isValidMissionStatusTransition — invalid transitions', () => {
  it('brainstormed → completed (skip) is rejected', () => {
    expect(isValidMissionStatusTransition('brainstormed', 'completed')).toBe(false);
  });

  it('validated → testing (skip) is rejected', () => {
    expect(isValidMissionStatusTransition('validated', 'testing')).toBe(false);
  });

  it('in-dev → validated (backward non-rollback) is rejected', () => {
    expect(isValidMissionStatusTransition('in-dev', 'validated')).toBe(false);
  });

  it('testing → in-dev (backward non-rollback) is rejected', () => {
    expect(isValidMissionStatusTransition('testing', 'in-dev')).toBe(false);
  });

  it('completed → validated (backward non-rollback) is rejected', () => {
    expect(isValidMissionStatusTransition('completed', 'validated')).toBe(false);
  });

  it('invalid values in either position return false', () => {
    expect(isValidMissionStatusTransition('foo', 'brainstormed')).toBe(false);
    expect(isValidMissionStatusTransition('brainstormed', 'bar')).toBe(false);
  });
});

// Test 11: validateMissionStatusEntry happy path
describe('validateMissionStatusEntry — happy path', () => {
  it('returns {ok: true, errors: []} for a well-formed entry', () => {
    const result = validateMissionStatusEntry({ id: 'm-1', task: 'foo', wave: 1, status: 'brainstormed' });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns {ok: true, errors: []} for every valid status value', () => {
    for (const status of MISSION_STATUS_VALUES) {
      const result = validateMissionStatusEntry({ id: 'm-2', task: 'bar task', wave: 3, status });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });
});

// Test 12: validateMissionStatusEntry error cases
describe('validateMissionStatusEntry — error cases', () => {
  it('returns ok:false when id is missing', () => {
    const result = validateMissionStatusEntry({ task: 'foo', wave: 1, status: 'brainstormed' });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('returns ok:false when task is missing', () => {
    const result = validateMissionStatusEntry({ id: 'm-1', wave: 1, status: 'brainstormed' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('task'))).toBe(true);
  });

  it('returns ok:false when wave is not a positive integer', () => {
    const result = validateMissionStatusEntry({ id: 'm-1', task: 'foo', wave: 'one', status: 'brainstormed' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('wave'))).toBe(true);
  });

  it('returns ok:false when wave is 0 (not positive)', () => {
    const result = validateMissionStatusEntry({ id: 'm-1', task: 'foo', wave: 0, status: 'brainstormed' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('wave'))).toBe(true);
  });

  it('returns ok:false when status is an invalid enum value', () => {
    const result = validateMissionStatusEntry({ id: 'm-1', task: 'foo', wave: 1, status: 'unknown-status' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('returns ok:false when the entry is null (not an object)', () => {
    const result = validateMissionStatusEntry(null);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accumulates multiple errors when multiple fields are invalid', () => {
    const result = validateMissionStatusEntry({ wave: -1, status: 'bad' });
    expect(result.ok).toBe(false);
    // id, task, wave, status all invalid → 4 errors
    expect(result.errors.length).toBe(4);
  });
});
