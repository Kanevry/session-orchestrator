import { describe, it, expect } from 'vitest';
import { parseMissionStatusStrict, MISSION_STATUS_VALUES } from '@lib/state-md.mjs';

/**
 * The bug this test catches: `scripts/lib/state-md.mjs` is the documented entry
 * point ("thin barrel — re-exports every public symbol"), but the two strict
 * mission-status symbols added in #1111 were never added to its re-export list.
 * A consumer following the documented path therefore got a link-time failure
 * (static import) or `undefined` (the `await import()` form hooks use) for
 * `parseMissionStatusStrict` / `MISSION_STATUS_VALUES`, while the identical
 * import from `@lib/state-md/mission-status.mjs` worked — so no existing test
 * of the submodule could see the gap.
 *
 * Deliberately ONE test: the parse SEMANTICS are covered by
 * tests/lib/state-md-mission-status.test.mjs against the submodule; what is
 * unverified elsewhere is that the barrel forwards them at all, and that what
 * it forwards is the real function rather than a same-named stub.
 */
describe('state-md barrel — mission-status re-exports', () => {
  it('forwards parseMissionStatusStrict and MISSION_STATUS_VALUES', () => {
    expect(typeof parseMissionStatusStrict).toBe('function');
    expect(MISSION_STATUS_VALUES).toContain('in-dev');

    const result = parseMissionStatusStrict({
      'mission-status': [
        { id: 'impl-1', task: 'ship it', wave: 1, status: 'in-dev' },
        'not-a-mapping',
      ],
    });

    expect(result).toEqual({
      items: [{ id: 'impl-1', task: 'ship it', wave: 1, status: 'in-dev' }],
      invalid: [{ index: 1, reason: 'not-a-mapping' }],
      warnings: [],
    });
  });
});
