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
} from '@lib/test-runner/artifact-paths.mjs';

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
