/**
 * tests/lib/test-runner/artifact-paths.test.mjs
 *
 * Unit tests for scripts/lib/test-runner/artifact-paths.mjs.
 *
 * Coverage:
 *   - makeRunId: PID-leading format, uniqueness across calls
 *   - runDirPath: path shape, argument validation
 *   - findingsPath / reportPath / screenshotsDir / axSnapshotsDir / consoleLogPath: suffix shapes
 *   - jsonlRollupPath: exact constant value
 *
 * All expected path strings are hardcoded literals.
 * No path.join calls in assertions (test-quality.md anti-pattern #3).
 */

import { describe, it, expect } from 'vitest';
import {
  makeRunId,
  runDirPath,
  findingsPath,
  reportPath,
  screenshotsDir,
  axSnapshotsDir,
  consoleLogPath,
  jsonlRollupPath,
  RUN_ID_PATTERN,
} from '@lib/test-runner/artifact-paths.mjs';
import {
  RUN_ID_PATTERN as UX_GRILL_RUN_ID_PATTERN,
  makeRunId as uxGrillMakeRunId,
  runDirPath as uxGrillRunDirPath,
} from '../../../scripts/lib/ux-grill/paths.mjs';

// ---------------------------------------------------------------------------
// makeRunId
// ---------------------------------------------------------------------------

describe('makeRunId', () => {
  it('format matches /^\\d+-\\d+$/ (pid-timestamp)', () => {
    const runId = makeRunId();
    expect(runId).toMatch(/^\d+-\d+$/);
  });

  it('leading integer equals process.pid', () => {
    const runId = makeRunId();
    expect(parseInt(runId.split('-')[0], 10)).toBe(process.pid);
  });

  it('trailing integer is a valid millisecond timestamp (>= 2024-01-01)', () => {
    const runId = makeRunId();
    const ts = parseInt(runId.split('-')[1], 10);
    // 2024-01-01T00:00:00.000Z = 1704067200000
    expect(ts).toBeGreaterThanOrEqual(1704067200000);
  });

  it('two calls produce different values when timestamps differ', async () => {
    const first = makeRunId();
    // Yield to allow Date.now() to advance at least 1ms
    await new Promise((r) => setTimeout(r, 2));
    const second = makeRunId();
    expect(first).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// runDirPath — path shape
// ---------------------------------------------------------------------------

describe('runDirPath', () => {
  it('returns the correct path for a well-formed runId', () => {
    expect(runDirPath('12345-1715688000123')).toBe(
      '.orchestrator/metrics/test-runs/12345-1715688000123',
    );
  });

  it('returns a path that starts with the test-runs prefix', () => {
    const p = runDirPath('99-000');
    expect(p.startsWith('.orchestrator/metrics/test-runs/')).toBe(true);
  });

  it('does not append a trailing slash', () => {
    const p = runDirPath('12345-1715688000123');
    expect(p.endsWith('/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDirPath — argument validation
// ---------------------------------------------------------------------------

describe('runDirPath — argument validation', () => {
  it('throws TypeError for empty string runId', () => {
    expect(() => runDirPath('')).toThrow(TypeError);
  });

  it('throws TypeError for null runId', () => {
    expect(() => runDirPath(null)).toThrow(TypeError);
  });

  it('throws TypeError for undefined runId', () => {
    expect(() => runDirPath(undefined)).toThrow(TypeError);
  });

  it('throws TypeError for numeric runId', () => {
    expect(() => runDirPath(12345)).toThrow(TypeError);
  });

  // #1330: runId reaches path.join unescaped — these would leave test-runs/.
  it.each(['../x', 'a/b', '..', '.', '../../etc'])(
    'throws TypeError for path-traversal runId %j',
    (runId) => {
      expect(() => runDirPath(runId)).toThrow(TypeError);
    },
  );

  it('accepts a run id produced by makeRunId()', () => {
    const runId = makeRunId();
    expect(runDirPath(runId)).toBe(`.orchestrator/metrics/test-runs/${runId}`);
  });
});

// Bug: ux-grill/paths.mjs carried its own copy of the run-id guard, and the
// `.`/`..` hole was open in both until each was patched separately (#1330).
// Two copies drift; ux-grill must validate with THIS module's pattern.
describe('run-id invariant — shared with ux-grill/paths.mjs', () => {
  it('ux-grill re-exports the same RUN_ID_PATTERN object, not a copy', () => {
    expect(UX_GRILL_RUN_ID_PATTERN).toBe(RUN_ID_PATTERN);
  });

  it.each(['../x', 'a/b', '.', '..'])('both validators reject %j', (runId) => {
    expect(() => runDirPath(runId)).toThrow(TypeError);
    expect(() => uxGrillRunDirPath('/tmp/repo', runId)).toThrow(TypeError);
  });

  it('both validators accept either module\'s generated run id', () => {
    const ids = [makeRunId(), uxGrillMakeRunId()];
    for (const runId of ids) {
      expect(runDirPath(runId)).toBe(`.orchestrator/metrics/test-runs/${runId}`);
      expect(uxGrillRunDirPath('/tmp/repo', runId)).toBe(`/tmp/repo/.orchestrator/metrics/ux-grill/${runId}`);
    }
  });
});

// Every artifact builder must route through runDirPath's validation.
describe('artifact builders — path-traversal runId', () => {
  it.each([
    ['findingsPath', findingsPath],
    ['reportPath', reportPath],
    ['screenshotsDir', screenshotsDir],
    ['axSnapshotsDir', axSnapshotsDir],
    ['consoleLogPath', consoleLogPath],
  ])('%s throws TypeError for "../x"', (_name, builder) => {
    expect(() => builder('../x')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Per-artifact path shapes
// ---------------------------------------------------------------------------

describe('findingsPath', () => {
  it('returns the runDir with /findings.jsonl appended', () => {
    expect(findingsPath('12345-1715688000123')).toBe(
      '.orchestrator/metrics/test-runs/12345-1715688000123/findings.jsonl',
    );
  });
});

describe('reportPath', () => {
  it('returns the runDir with /report.md appended', () => {
    expect(reportPath('12345-1715688000123')).toBe(
      '.orchestrator/metrics/test-runs/12345-1715688000123/report.md',
    );
  });
});

describe('screenshotsDir', () => {
  it('returns the runDir with /screenshots appended', () => {
    expect(screenshotsDir('12345-1715688000123')).toBe(
      '.orchestrator/metrics/test-runs/12345-1715688000123/screenshots',
    );
  });
});

describe('axSnapshotsDir', () => {
  it('returns the runDir with /ax-snapshots appended', () => {
    expect(axSnapshotsDir('12345-1715688000123')).toBe(
      '.orchestrator/metrics/test-runs/12345-1715688000123/ax-snapshots',
    );
  });
});

describe('consoleLogPath', () => {
  it('returns the runDir with /console.log appended', () => {
    expect(consoleLogPath('12345-1715688000123')).toBe(
      '.orchestrator/metrics/test-runs/12345-1715688000123/console.log',
    );
  });
});

// ---------------------------------------------------------------------------
// jsonlRollupPath — exact constant
// ---------------------------------------------------------------------------

describe('jsonlRollupPath', () => {
  it('returns exactly the shared JSONL rollup path', () => {
    expect(jsonlRollupPath()).toBe('.orchestrator/metrics/test-runs.jsonl');
  });

  it('does not include a run-specific subdirectory segment', () => {
    const p = jsonlRollupPath();
    // Must be the flat rollup file, not inside test-runs/<runId>/
    expect(p).not.toContain('test-runs/');
  });
});
