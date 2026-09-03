/**
 * dispatch-common.test.mjs — the shared base for the two foreign-dispatch
 * adapters (#1204).
 *
 * This file pins exactly one real invariant of the module: the never-foreign
 * role list is frozen and non-empty (see the test below for why). Every other
 * exported symbol is exercised through its actual callers — `runChild`'s
 * SIGTERM->SIGKILL escalation via `foreign-dispatch.test.mjs` and
 * `remote-dispatch.test.mjs` (see the pointer comment below), and the two
 * budget constants + `isSafeRunId`/`isNeverForeignRole` via the adapter tests
 * that consume them. A bare `exports X` / `is NOT re-exported` pair over all
 * six symbols was removed here (#1206 W4 MED-3): it survived replacing every
 * function body with `throw new Error()`, so it caught nothing a TypeScript
 * import error wouldn't already catch louder.
 */

import { describe, it, expect } from 'vitest';

import * as dispatchCommon from '@lib/wave-executor/dispatch-common.mjs';

// SIGTERM->SIGKILL escalation (runChild) is exercised end-to-end via the two
// adapters that actually call it — both import runChild from this module:
// tests/lib/wave-executor/foreign-dispatch.test.mjs:498
//   "escalates SIGTERM to SIGKILL for a child that ignores the first signal"
// tests/lib/wave-executor/remote-dispatch.test.mjs:439
//   "escalates SIGTERM to SIGKILL for an uncooperative child"
// No standalone runChild test is added here — it would duplicate those two.

describe('dispatch-common.mjs — the seam between the two dispatch adapters', () => {
  // Real invariant: isNeverForeignRole() and every caller of it trust that
  // this list cannot be mutated at runtime and is never empty (an empty list
  // would silently disable the never-foreign gate for every role).
  it('NEVER_FOREIGN_ROLES is frozen and non-empty', () => {
    expect(Object.isFrozen(dispatchCommon.NEVER_FOREIGN_ROLES)).toBe(true);
    expect(dispatchCommon.NEVER_FOREIGN_ROLES.length).toBeGreaterThan(0);
  });
});
