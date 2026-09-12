/**
 * tests/lib/ux-grill/pencil-coverage.test.mjs
 *
 * Contract tests for `scripts/lib/ux-grill/pencil-coverage.mjs` — a pure
 * classifier, so no seams and no filesystem. What is worth pinning is the
 * PRECEDENCE: the four branches of `classifyFrameCoverage` answer the same
 * question with different authority, and the two device signals (a name suffix
 * and a pixel width) are allowed to disagree. A silent precedence flip reports
 * design coverage that does not exist, which is worse than reporting none.
 */

import { describe, it, expect } from 'vitest';

import {
  MOBILE_WIDTH_CEILING_PX,
  classifyFrameCoverage,
  describePencilStep,
} from '../../../scripts/lib/ux-grill/pencil-coverage.mjs';

describe('classifyFrameCoverage() — routes[].frame precedence', () => {
  it('takes a coverage literal as the answer, without consulting the frames at all', () => {
    expect(classifyFrameCoverage({ routes: [{ path: '/a', frame: 'Desktop' }], frames: [] })).toEqual([
      { route: '/a', frame: 'desktop', matchedBy: 'routes[].frame' },
    ]);
  });

  it('reports `none` for a declared frame reference that resolves to nothing, still attributed to the declaration', () => {
    expect(classifyFrameCoverage({ routes: [{ path: '/b', frame: 'Missing' }], frames: [] })).toEqual([
      { route: '/b', frame: 'none', matchedBy: 'routes[].frame' },
    ]);
  });

  it('reports `none` with matchedBy null for a route that declared nothing — distinguishable from an honoured declaration', () => {
    expect(classifyFrameCoverage({ routes: [{ path: '/c' }], frames: [] })).toEqual([
      { route: '/c', frame: 'none', matchedBy: null },
    ]);
  });

  it('matches a frame by name when no frame is declared', () => {
    expect(
      classifyFrameCoverage({
        routes: [{ path: '/dashboard' }],
        frames: [{ id: 'f1', name: 'Dashboard', width: 1440 }],
      }),
    ).toEqual([{ route: '/dashboard', frame: 'desktop', matchedBy: 'name' }]);
  });
});

describe('classifyFrameCoverage() — device classification', () => {
  const cases = [
    { label: 'width one below the ceiling', frames: [{ name: 'Dashboard', width: 599 }], expected: 'mobile' },
    { label: 'width exactly at the ceiling', frames: [{ name: 'Dashboard', width: 600 }], expected: 'desktop' },
    {
      label: 'a name suffix contradicting a desktop width',
      frames: [{ name: 'Dashboard (mobile)', width: 1440 }],
      expected: 'mobile',
    },
    { label: 'no width at all', frames: [{ name: 'Dashboard' }], expected: 'desktop' },
    {
      label: 'one desktop and one mobile frame on the same route',
      frames: [
        { name: 'Dashboard', width: 1440 },
        { name: 'Dashboard (mobile)', width: 393 },
      ],
      expected: 'both',
    },
  ];

  it.each(cases)('classifies $label as $expected', ({ frames, expected }) => {
    expect(MOBILE_WIDTH_CEILING_PX).toBe(600);
    expect(classifyFrameCoverage({ routes: [{ path: '/dashboard' }], frames })).toEqual([
      { route: '/dashboard', frame: expected, matchedBy: 'name' },
    ]);
  });
});

describe('describePencilStep() — manifest unwrapping', () => {
  it.each([
    { label: 'a loadManifest() envelope', manifest: { frontmatter: { pencil: { file: 'x.pen' } } } },
    { label: 'a bare frontmatter object with padding', manifest: { pencil: { file: ' x.pen ' } } },
  ])('enables the step for $label', ({ manifest }) => {
    expect(describePencilStep({ manifest })).toEqual({ enabled: true, file: 'x.pen' });
  });

  it('disables the step when no pencil file is configured', () => {
    expect(describePencilStep({ manifest: {} })).toEqual({ enabled: false, file: null });
  });
});
