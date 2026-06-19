// SPDX-License-Identifier: MIT
// Tests for scripts/lib/autopilot/recent-runs.mjs (Epic #673 P3, issue #682).
//
// readRecentAutopilotRuns({ repoRoot, limit }) — pure, no-throw tail reader for
// <repoRoot>/.orchestrator/metrics/autopilot.jsonl. Contract verified here:
//   - missing/unreadable file ⇒ [] (never throws)
//   - TRUE count preserved (NICE-a: 6-on-disk → 6, never clamped down to <5)
//   - corrupt JSONL lines skipped; valid records survive with correct count
//   - `limit` is an UPPER BOUND only (caps tail; never clamps UP)
//   - newest-LAST ordering (tail slice preserves on-disk append order)
//   - kill_switch field ('spiral' / null) read back intact
//
// Portability: every fixture lives under mkdtempSync(tmpdir()) — NO hardcoded
// home/absolute paths (owner-leakage hook blocks them). Cleaned in afterEach.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRecentAutopilotRuns } from '../../../scripts/lib/autopilot/recent-runs.mjs';

/** Track tmp dirs created per-test so afterEach can remove them. */
const createdDirs = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create a fresh tmp repoRoot. If `lines` is provided, write them (joined with
 * '\n') to <repoRoot>/.orchestrator/metrics/autopilot.jsonl. If `lines` is
 * undefined, the metrics dir is NOT created — simulating a missing file.
 * Returns the repoRoot path. NOT test logic — fixture setup only.
 */
function makeRepo(lines) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'recent-runs-'));
  createdDirs.push(repoRoot);
  if (lines !== undefined) {
    const metricsDir = path.join(repoRoot, '.orchestrator', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(path.join(metricsDir, 'autopilot.jsonl'), lines.join('\n'), 'utf8');
  }
  return repoRoot;
}

/** Build one JSONL line for a run record with a given kill_switch field. */
function runLine(killSwitch) {
  return JSON.stringify({ kill_switch: killSwitch });
}

describe('readRecentAutopilotRuns — missing / unreadable file', () => {
  it('returns [] when autopilot.jsonl does not exist (no throw)', () => {
    const repoRoot = makeRepo(undefined); // no metrics dir → no file
    expect(readRecentAutopilotRuns({ repoRoot })).toEqual([]);
  });

  it('returns [] for a falsy repoRoot', () => {
    expect(readRecentAutopilotRuns({ repoRoot: '' })).toEqual([]);
  });

  it('returns [] for a non-string repoRoot', () => {
    expect(readRecentAutopilotRuns({ repoRoot: 42 })).toEqual([]);
  });

  it('returns [] when called with no arguments', () => {
    expect(readRecentAutopilotRuns()).toEqual([]);
  });

  it('returns [] for an empty autopilot.jsonl file', () => {
    const repoRoot = makeRepo([]);
    expect(readRecentAutopilotRuns({ repoRoot })).toEqual([]);
  });
});

describe('readRecentAutopilotRuns — TRUE count preserved (NICE-a)', () => {
  it('0 records on disk → returns 0 records', () => {
    const repoRoot = makeRepo(['', '   ']); // only blank lines
    expect(readRecentAutopilotRuns({ repoRoot })).toHaveLength(0);
  });

  it('3 records on disk → returns exactly 3', () => {
    const repoRoot = makeRepo([runLine(null), runLine(null), runLine('spiral')]);
    expect(readRecentAutopilotRuns({ repoRoot })).toHaveLength(3);
  });

  it('6 records on disk → returns exactly 6 (NOT capped to 4 or 5)', () => {
    const repoRoot = makeRepo(Array.from({ length: 6 }, () => runLine(null)));
    expect(readRecentAutopilotRuns({ repoRoot })).toHaveLength(6);
  });

  it('6 records → none of the kill_switch fields are lost (NICE-a regression guard)', () => {
    const repoRoot = makeRepo([
      runLine(null),
      runLine('spiral'),
      runLine(null),
      runLine(null),
      runLine('max-hours'),
      runLine(null),
    ]);
    const runs = readRecentAutopilotRuns({ repoRoot });
    expect(runs.map((r) => r.kill_switch)).toEqual([
      null,
      'spiral',
      null,
      null,
      'max-hours',
      null,
    ]);
  });
});

describe('readRecentAutopilotRuns — corrupt line tolerance', () => {
  it('skips a corrupt line interleaved with valid records, keeping the rest', () => {
    const repoRoot = makeRepo([
      runLine(null),
      '{ this is not valid json',
      runLine('spiral'),
      runLine(null),
    ]);
    expect(readRecentAutopilotRuns({ repoRoot })).toHaveLength(3);
  });

  it('valid records after a corrupt line are returned intact', () => {
    const repoRoot = makeRepo([runLine('spiral'), 'not-json-{{', runLine(null)]);
    const runs = readRecentAutopilotRuns({ repoRoot });
    expect(runs.map((r) => r.kill_switch)).toEqual(['spiral', null]);
  });

  it('drops a JSON primitive (number) line — not a run record', () => {
    const repoRoot = makeRepo(['42', runLine(null)]);
    expect(readRecentAutopilotRuns({ repoRoot })).toEqual([{ kill_switch: null }]);
  });

  it('drops a JSON array line — not a run record', () => {
    const repoRoot = makeRepo(['[1,2,3]', runLine('spiral')]);
    expect(readRecentAutopilotRuns({ repoRoot })).toEqual([{ kill_switch: 'spiral' }]);
  });

  it('returns [] when EVERY line is corrupt (no throw)', () => {
    const repoRoot = makeRepo(['{bad', 'also-bad', '}{']);
    expect(readRecentAutopilotRuns({ repoRoot })).toEqual([]);
  });
});

describe('readRecentAutopilotRuns — limit is an UPPER BOUND only', () => {
  it('limit=2 on a 6-record file → returns 2', () => {
    const repoRoot = makeRepo(Array.from({ length: 6 }, () => runLine(null)));
    expect(readRecentAutopilotRuns({ repoRoot, limit: 2 })).toHaveLength(2);
  });

  it('limit=2 → returns the MOST-RECENT tail (last 2 on disk)', () => {
    const repoRoot = makeRepo([
      runLine('a-old'),
      runLine('b'),
      runLine('c'),
      runLine('d'),
      runLine('e'),
      runLine('f-new'),
    ]);
    const runs = readRecentAutopilotRuns({ repoRoot, limit: 2 });
    expect(runs.map((r) => r.kill_switch)).toEqual(['e', 'f-new']);
  });

  it('limit=4 on a 3-record file → returns 3 (does NOT clamp UP to 4)', () => {
    const repoRoot = makeRepo([runLine(null), runLine(null), runLine('spiral')]);
    expect(readRecentAutopilotRuns({ repoRoot, limit: 4 })).toHaveLength(3);
  });

  it('limit larger than record count returns all records unchanged', () => {
    const repoRoot = makeRepo([runLine('spiral'), runLine(null)]);
    expect(readRecentAutopilotRuns({ repoRoot, limit: 100 })).toEqual([
      { kill_switch: 'spiral' },
      { kill_switch: null },
    ]);
  });

  it('non-finite limit falls back to default (returns all of a small file)', () => {
    const repoRoot = makeRepo([runLine(null), runLine('spiral'), runLine(null)]);
    expect(readRecentAutopilotRuns({ repoRoot, limit: NaN })).toHaveLength(3);
  });

  it('limit <= 0 falls back to default (returns all of a small file)', () => {
    const repoRoot = makeRepo([runLine(null), runLine('spiral')]);
    expect(readRecentAutopilotRuns({ repoRoot, limit: 0 })).toHaveLength(2);
  });
});

describe('readRecentAutopilotRuns — newest-LAST ordering', () => {
  it('returns records in on-disk (append) order, newest last', () => {
    const repoRoot = makeRepo([
      runLine('first'),
      runLine('second'),
      runLine('third'),
    ]);
    const runs = readRecentAutopilotRuns({ repoRoot });
    expect(runs.map((r) => r.kill_switch)).toEqual(['first', 'second', 'third']);
  });
});

describe('readRecentAutopilotRuns — kill_switch field fidelity', () => {
  it("reads a kill_switch:'spiral' record back intact", () => {
    const repoRoot = makeRepo([runLine('spiral')]);
    expect(readRecentAutopilotRuns({ repoRoot })).toEqual([{ kill_switch: 'spiral' }]);
  });

  it('reads a kill_switch:null record back intact', () => {
    const repoRoot = makeRepo([runLine(null)]);
    expect(readRecentAutopilotRuns({ repoRoot })).toEqual([{ kill_switch: null }]);
  });

  it('preserves extra fields alongside kill_switch', () => {
    const repoRoot = makeRepo([
      JSON.stringify({ kill_switch: 'spiral', repo: 'demo', elapsed_steps: 7 }),
    ]);
    expect(readRecentAutopilotRuns({ repoRoot })).toEqual([
      { kill_switch: 'spiral', repo: 'demo', elapsed_steps: 7 },
    ]);
  });
});
