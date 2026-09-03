/**
 * dispatch-common.test.mjs — the shared base for the two foreign-dispatch
 * adapters (#1204).
 *
 * Bug this pins: a future edit that copies one of these six symbols back into
 * `foreign-dispatch.mjs` (or `remote-dispatch.mjs`) — instead of importing it
 * from here — would silently re-fork the enforcement point the module header
 * describes, and nothing else in the suite would catch it (both adapters would
 * still work, having their own local copy). Asserting the exact export set of
 * `dispatch-common.mjs` AND the absence of a re-export from `foreign-dispatch.mjs`
 * makes that re-fork loud instead of silent.
 */

import { describe, it, expect } from 'vitest';

import * as dispatchCommon from '@lib/wave-executor/dispatch-common.mjs';
import * as foreignDispatch from '@lib/wave-executor/foreign-dispatch.mjs';

const MOVE_SET = [
  'NEVER_FOREIGN_ROLES',
  'DEFAULT_TIMEOUT_SEC',
  'DEFAULT_KILL_GRACE_MS',
  'isSafeRunId',
  'isNeverForeignRole',
  'runChild',
];

describe('dispatch-common.mjs — the seam between the two dispatch adapters', () => {
  it.each(MOVE_SET)('exports %s', (name) => {
    expect(name in dispatchCommon).toBe(true);
    expect(dispatchCommon[name]).toBeDefined();
  });

  // The load-bearing assertion: a re-merge of any of these six back into
  // foreign-dispatch.mjs's own export surface must fail this test.
  it.each(MOVE_SET)('is NOT re-exported from foreign-dispatch.mjs (%s)', (name) => {
    expect(name in foreignDispatch).toBe(false);
  });

  it('NEVER_FOREIGN_ROLES is frozen and non-empty', () => {
    expect(Object.isFrozen(dispatchCommon.NEVER_FOREIGN_ROLES)).toBe(true);
    expect(dispatchCommon.NEVER_FOREIGN_ROLES.length).toBeGreaterThan(0);
  });
});
