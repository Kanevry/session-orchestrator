/**
 * tests/telemetry/roster.test.mjs
 *
 * Unit tests for the roster whitelist loader + name filter (Epic #841, S2 /
 * GitLab #843):
 *   scripts/lib/telemetry/schema.mjs — loadRoster / filterRosterNames
 *
 * Privacy invariant under test: any skill/command name NOT in the shipped plugin
 * roster projects to the opaque token "other", so custom/third-party/repo-specific
 * names never leave the machine. Off-roster inputs must never survive.
 *
 * loadRoster is exercised against the REAL repo surface (floor/ceiling counts, not
 * an exact pin, per the dynamic-artifact-count carve-out) and against a missing
 * surface (fail-closed → empty sets). Temp dirs are mkdtempSync — no personal
 * paths in fixtures.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoster, filterRosterNames } from '../../scripts/lib/telemetry/schema.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('loadRoster — real repo surface', () => {
  it('loads skills within a stable floor/ceiling range', () => {
    const roster = loadRoster({ pluginRoot: REPO_ROOT });
    // Floor/ceiling, not an exact pin — the surface grows over time.
    expect(roster.skills.size).toBeGreaterThanOrEqual(20);
    expect(roster.skills.size).toBeLessThanOrEqual(200);
  });

  it('prefixes skill names with session-orchestrator:', () => {
    const roster = loadRoster({ pluginRoot: REPO_ROOT });
    expect(roster.skills.has('session-orchestrator:session-start')).toBe(true);
  });

  it('loads commands as bare names within a floor/ceiling range', () => {
    const roster = loadRoster({ pluginRoot: REPO_ROOT });
    expect(roster.commands.size).toBeGreaterThanOrEqual(10);
    expect(roster.commands.size).toBeLessThanOrEqual(200);
    expect(roster.commands.has('session')).toBe(true);
  });
});

describe('loadRoster — fail-closed', () => {
  let tmp;
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
    vi.restoreAllMocks();
  });

  it('returns empty sets when the surface directory is absent', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'telemetry-roster-'));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const roster = loadRoster({ pluginRoot: tmp });
    expect(roster.skills.size).toBe(0);
    expect(roster.commands.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

describe('filterRosterNames', () => {
  it('replaces an off-roster name with "other"', () => {
    const roster = new Set(['session-orchestrator:session-start']);
    expect(filterRosterNames(['my-private-skill'], roster)).toEqual(['other']);
  });

  it('keeps roster names verbatim', () => {
    const roster = new Set(['session-orchestrator:session-start']);
    expect(filterRosterNames(['session-orchestrator:session-start'], roster)).toEqual([
      'session-orchestrator:session-start',
    ]);
  });

  it('deduplicates and sorts', () => {
    const roster = new Set(['a', 'b']);
    expect(filterRosterNames(['b', 'a', 'a', 'b'], roster)).toEqual(['a', 'b']);
  });

  it('collapses many off-roster names into a single "other"', () => {
    const roster = new Set(['a']);
    expect(filterRosterNames(['x', 'y', 'z', 'a'], roster)).toEqual(['a', 'other']);
  });

  it('maps a name longer than 64 chars to "other" even if it were on the roster', () => {
    const longName = 'x'.repeat(65);
    const roster = new Set([longName]);
    expect(filterRosterNames([longName], roster)).toEqual(['other']);
  });

  it('keeps a name of exactly 64 chars that is on the roster', () => {
    const name = 'y'.repeat(64);
    const roster = new Set([name]);
    expect(filterRosterNames([name], roster)).toEqual([name]);
  });

  it('maps non-string entries to "other"', () => {
    const roster = new Set(['a']);
    expect(filterRosterNames(['a', 42, null, undefined], roster)).toEqual(['a', 'other']);
  });

  it('caps the result at 100 entries', () => {
    const names = Array.from({ length: 150 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const roster = new Set(names);
    const result = filterRosterNames(names, roster);
    expect(result).toHaveLength(100);
    // sorted → the first 100 lexicographically are n000..n099
    expect(result[0]).toBe('n000');
    expect(result[99]).toBe('n099');
  });

  it('returns [] for empty input', () => {
    expect(filterRosterNames([], new Set(['a']))).toEqual([]);
  });
});
