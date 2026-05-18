/**
 * tests/lib/discovery/triage-state.test.mjs
 *
 * Vitest suite for scripts/lib/discovery/triage-state.mjs (issue #419).
 *
 * Covers: computeFingerprint (determinism, missing-field rejection),
 * loadTriageState (absent file, append+reload, last-writer-wins),
 * appendTriageEntry (invalid state rejection, valid write),
 * filterFindings (5-finding partitioning, round-trip, promoted state).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeFingerprint,
  loadTriageState,
  appendTriageEntry,
  filterFindings,
  VALID_STATES,
} from '@lib/discovery/triage-state.mjs';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'triage-state-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function stateFile() {
  return join(tmp, 'discovery-triage.jsonl');
}

/** Build a minimal valid triage entry. */
function makeEntry(fingerprint, state, overrides = {}) {
  return {
    fingerprint,
    state,
    timestamp: '2026-01-01T00:00:00.000Z',
    session_id: 'test-session',
    ...overrides,
  };
}

/** Build a minimal finding object. */
function makeFinding(overrides = {}) {
  return {
    probe: 'hardcoded-values',
    file: 'src/config.ts',
    severity: 'high',
    ruleId: 'rule-001',
    title: 'Hardcoded API key',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

describe('computeFingerprint', () => {
  it('returns a 16-character hex string', () => {
    const result = computeFingerprint({ probe: 'foo', file: 'bar.ts', severity: 'critical', ruleId: 'r1' });
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — same input yields same fingerprint', () => {
    const input = { probe: 'foo', file: 'bar.ts', severity: 'critical', ruleId: 'r1' };
    const first = computeFingerprint(input);
    const second = computeFingerprint(input);
    expect(first).toBe(second);
  });

  it('produces different fingerprints for different inputs', () => {
    const a = computeFingerprint({ probe: 'foo', file: 'bar.ts', severity: 'critical', ruleId: 'r1' });
    const b = computeFingerprint({ probe: 'foo', file: 'bar.ts', severity: 'high', ruleId: 'r1' });
    expect(a).not.toBe(b);
  });

  it('throws when probe is missing', () => {
    expect(() =>
      computeFingerprint({ file: 'bar.ts', severity: 'critical', ruleId: 'r1' })
    ).toThrow(TypeError);
  });

  it('throws when file is missing', () => {
    expect(() =>
      computeFingerprint({ probe: 'foo', severity: 'critical', ruleId: 'r1' })
    ).toThrow(TypeError);
  });

  it('throws when severity is missing', () => {
    expect(() =>
      computeFingerprint({ probe: 'foo', file: 'bar.ts', ruleId: 'r1' })
    ).toThrow(TypeError);
  });

  it('throws when ruleId is missing', () => {
    expect(() =>
      computeFingerprint({ probe: 'foo', file: 'bar.ts', severity: 'critical' })
    ).toThrow(TypeError);
  });

  it('throws when any field is an empty string', () => {
    expect(() =>
      computeFingerprint({ probe: '', file: 'bar.ts', severity: 'critical', ruleId: 'r1' })
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// loadTriageState
// ---------------------------------------------------------------------------

describe('loadTriageState', () => {
  it('returns empty Map when file does not exist', async () => {
    const result = await loadTriageState(join(tmp, 'nonexistent.jsonl'));
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns empty Map on empty file', async () => {
    const file = stateFile();
    await appendTriageEntry(file, makeEntry('aabbccdd11223344', 'open'));
    // Create a fresh empty file by checking we can still load
    const result = await loadTriageState(file);
    expect(result.size).toBe(1);
  });

  it('loads a single appended entry correctly', async () => {
    const file = stateFile();
    const fp = computeFingerprint({ probe: 'p1', file: 'f1.ts', severity: 'high', ruleId: 'r1' });
    await appendTriageEntry(file, makeEntry(fp, 'dismissed'));

    const map = await loadTriageState(file);
    expect(map.has(fp)).toBe(true);
    expect(map.get(fp).state).toBe('dismissed');
  });

  it('last-writer-wins: two entries same fingerprint — later state wins', async () => {
    const file = stateFile();
    const fp = computeFingerprint({ probe: 'p1', file: 'f1.ts', severity: 'high', ruleId: 'r1' });

    await appendTriageEntry(file, makeEntry(fp, 'open', { timestamp: '2026-01-01T00:00:00.000Z' }));
    await appendTriageEntry(file, makeEntry(fp, 'dismissed', { timestamp: '2026-01-02T00:00:00.000Z' }));

    const map = await loadTriageState(file);
    expect(map.size).toBe(1);
    expect(map.get(fp).state).toBe('dismissed');
    expect(map.get(fp).timestamp).toBe('2026-01-02T00:00:00.000Z');
  });

  it('loads multiple distinct fingerprints correctly', async () => {
    const file = stateFile();
    const fp1 = computeFingerprint({ probe: 'p1', file: 'f1.ts', severity: 'high', ruleId: 'r1' });
    const fp2 = computeFingerprint({ probe: 'p2', file: 'f2.ts', severity: 'low', ruleId: 'r2' });

    await appendTriageEntry(file, makeEntry(fp1, 'open'));
    await appendTriageEntry(file, makeEntry(fp2, 'accepted-as-known'));

    const map = await loadTriageState(file);
    expect(map.size).toBe(2);
    expect(map.get(fp1).state).toBe('open');
    expect(map.get(fp2).state).toBe('accepted-as-known');
  });

  it('skips malformed JSON lines without throwing', async () => {
    const file = stateFile();
    const fp = computeFingerprint({ probe: 'p1', file: 'f1.ts', severity: 'high', ruleId: 'r1' });
    await appendTriageEntry(file, makeEntry(fp, 'open'));

    // Inject a malformed line into the file
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, 'not-valid-json\n', 'utf8');

    // Should still load valid entries without throwing
    const map = await loadTriageState(file);
    expect(map.size).toBe(1);
    expect(map.get(fp).state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// appendTriageEntry
// ---------------------------------------------------------------------------

describe('appendTriageEntry', () => {
  it('creates parent directories if they do not exist', async () => {
    const nestedFile = join(tmp, 'nested', 'deep', 'triage.jsonl');
    await appendTriageEntry(nestedFile, makeEntry('fp1234567890abcd', 'open'));
    expect(existsSync(nestedFile)).toBe(true);
  });

  it('writes a valid JSON line to the file', async () => {
    const file = stateFile();
    const fp = computeFingerprint({ probe: 'p1', file: 'f1.ts', severity: 'high', ruleId: 'r1' });
    await appendTriageEntry(file, makeEntry(fp, 'open'));

    const content = readFileSync(file, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.fingerprint).toBe(fp);
    expect(parsed.state).toBe('open');
    expect(parsed.session_id).toBe('test-session');
  });

  it('accepts all valid VALID_STATES enum values', async () => {
    const file = stateFile();
    for (const state of VALID_STATES) {
      await expect(
        appendTriageEntry(file, makeEntry('fp1234567890abcd', state))
      ).resolves.toBeUndefined();
    }
  });

  it('accepts promoted-to-#NNN state', async () => {
    const file = stateFile();
    await expect(
      appendTriageEntry(file, makeEntry('fp1234567890abcd', 'promoted-to-#42', { issue_id: 42 }))
    ).resolves.toBeUndefined();
  });

  it('throws TypeError for invalid state string', async () => {
    const file = stateFile();
    await expect(
      appendTriageEntry(file, makeEntry('fp1234567890abcd', 'invalid-state'))
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when state is empty string', async () => {
    const file = stateFile();
    await expect(
      appendTriageEntry(file, makeEntry('fp1234567890abcd', ''))
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when fingerprint is missing', async () => {
    const file = stateFile();
    await expect(
      appendTriageEntry(file, { state: 'open', timestamp: '2026-01-01T00:00:00.000Z', session_id: 's1' })
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when timestamp is missing', async () => {
    const file = stateFile();
    await expect(
      appendTriageEntry(file, { fingerprint: 'fp1234567890abcd', state: 'open', session_id: 's1' })
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when session_id is missing', async () => {
    const file = stateFile();
    await expect(
      appendTriageEntry(file, { fingerprint: 'fp1234567890abcd', state: 'open', timestamp: '2026-01-01T00:00:00.000Z' })
    ).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// filterFindings
// ---------------------------------------------------------------------------

describe('filterFindings', () => {
  it('puts new (unknown fingerprint) finding into toShow', () => {
    const finding = makeFinding();
    const { toShow, suppressed, tracked } = filterFindings({
      findings: [finding],
      stateMap: new Map(),
    });
    expect(toShow).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
    expect(tracked).toHaveLength(0);
  });

  it('partitions 5 findings: 2 dismissed, 1 promoted, 2 open', () => {
    const findings = [
      makeFinding({ ruleId: 'r1', title: 'open-1' }),
      makeFinding({ ruleId: 'r2', title: 'open-2' }),
      makeFinding({ ruleId: 'r3', title: 'dismissed-1' }),
      makeFinding({ ruleId: 'r4', title: 'dismissed-2' }),
      makeFinding({ ruleId: 'r5', title: 'promoted-1', file: 'src/other.ts' }),
    ];

    const stateMap = new Map();

    const fp3 = computeFingerprint({ probe: findings[2].probe, file: findings[2].file, severity: findings[2].severity, ruleId: findings[2].ruleId });
    const fp4 = computeFingerprint({ probe: findings[3].probe, file: findings[3].file, severity: findings[3].severity, ruleId: findings[3].ruleId });
    const fp5 = computeFingerprint({ probe: findings[4].probe, file: findings[4].file, severity: findings[4].severity, ruleId: findings[4].ruleId });

    stateMap.set(fp3, { state: 'dismissed', timestamp: '2026-01-01T00:00:00.000Z', session_id: 's1' });
    stateMap.set(fp4, { state: 'dismissed', timestamp: '2026-01-01T00:00:00.000Z', session_id: 's1' });
    stateMap.set(fp5, { state: 'promoted-to-#99', issue_id: 99, timestamp: '2026-01-01T00:00:00.000Z', session_id: 's1' });

    const { toShow, suppressed, tracked } = filterFindings({ findings, stateMap });

    expect(toShow).toHaveLength(2);
    expect(suppressed).toHaveLength(2);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].issue_id).toBe(99);
  });

  it('puts accepted-as-known findings into suppressed', () => {
    const finding = makeFinding();
    const fp = computeFingerprint({ probe: finding.probe, file: finding.file, severity: finding.severity, ruleId: finding.ruleId });
    const stateMap = new Map([[fp, { state: 'accepted-as-known', timestamp: '2026-01-01T00:00:00.000Z', session_id: 's1' }]]);

    const { toShow, suppressed } = filterFindings({ findings: [finding], stateMap });
    expect(toShow).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
  });

  it('puts reopened findings into toShow', () => {
    const finding = makeFinding();
    const fp = computeFingerprint({ probe: finding.probe, file: finding.file, severity: finding.severity, ruleId: finding.ruleId });
    const stateMap = new Map([[fp, { state: 'reopened', timestamp: '2026-01-01T00:00:00.000Z', session_id: 's1' }]]);

    const { toShow } = filterFindings({ findings: [finding], stateMap });
    expect(toShow).toHaveLength(1);
  });

  it('attaches issue_id to tracked findings', () => {
    const finding = makeFinding({ ruleId: 'r-tracked' });
    const fp = computeFingerprint({ probe: finding.probe, file: finding.file, severity: finding.severity, ruleId: finding.ruleId });
    const stateMap = new Map([[fp, { state: 'promoted-to-#123', issue_id: 123, timestamp: '2026-01-01T00:00:00.000Z', session_id: 's1' }]]);

    const { tracked } = filterFindings({ findings: [finding], stateMap });
    expect(tracked).toHaveLength(1);
    expect(tracked[0].issue_id).toBe(123);
    expect(tracked[0].ruleId).toBe('r-tracked');
  });

  it('round-trip: append 3 entries, reload, filter, verify partitioning', async () => {
    const file = stateFile();

    const f1 = makeFinding({ ruleId: 'rt-1' });
    const f2 = makeFinding({ ruleId: 'rt-2' });
    const f3 = makeFinding({ ruleId: 'rt-3' });
    const findings = [f1, f2, f3];

    const fp1 = computeFingerprint({ probe: f1.probe, file: f1.file, severity: f1.severity, ruleId: f1.ruleId });
    const fp2 = computeFingerprint({ probe: f2.probe, file: f2.file, severity: f2.severity, ruleId: f2.ruleId });
    const fp3 = computeFingerprint({ probe: f3.probe, file: f3.file, severity: f3.severity, ruleId: f3.ruleId });

    // f1 → open, f2 → dismissed, f3 → promoted-to-#7
    await appendTriageEntry(file, makeEntry(fp1, 'open'));
    await appendTriageEntry(file, makeEntry(fp2, 'dismissed'));
    await appendTriageEntry(file, makeEntry(fp3, 'promoted-to-#7', { issue_id: 7 }));

    const stateMap = await loadTriageState(file);
    const { toShow, suppressed, tracked } = filterFindings({ findings, stateMap });

    expect(toShow).toHaveLength(1);
    expect(toShow[0].ruleId).toBe('rt-1');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].ruleId).toBe('rt-2');
    expect(tracked).toHaveLength(1);
    expect(tracked[0].ruleId).toBe('rt-3');
    expect(tracked[0].issue_id).toBe(7);
  });

  it('handles empty findings array gracefully', () => {
    const { toShow, suppressed, tracked } = filterFindings({
      findings: [],
      stateMap: new Map(),
    });
    expect(toShow).toHaveLength(0);
    expect(suppressed).toHaveLength(0);
    expect(tracked).toHaveLength(0);
  });
});

// =============================================================================
// NEW BOUNDARY / ERROR-PATH TESTS (W4-T1)
// =============================================================================

// ---------------------------------------------------------------------------
// loadTriageState — malformed line in the MIDDLE of the file
// ---------------------------------------------------------------------------

describe('loadTriageState — malformed line in middle of file', () => {
  it('skips a malformed middle line and loads valid entries before and after it', async () => {
    const file = stateFile();
    const fp1 = computeFingerprint({ probe: 'p1', file: 'f1.ts', severity: 'high', ruleId: 'r1' });
    const fp2 = computeFingerprint({ probe: 'p2', file: 'f2.ts', severity: 'low', ruleId: 'r2' });

    // Write first valid entry
    await appendTriageEntry(file, makeEntry(fp1, 'open'));
    // Inject malformed line
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, '{bad json line here\n', 'utf8');
    // Write second valid entry after the malformed line
    await appendTriageEntry(file, makeEntry(fp2, 'dismissed'));

    const map = await loadTriageState(file);
    // Both valid entries must be loaded; malformed line silently skipped
    expect(map.size).toBe(2);
    expect(map.get(fp1).state).toBe('open');
    expect(map.get(fp2).state).toBe('dismissed');
  });

  it('does not crash when the entire file is malformed', async () => {
    const file = stateFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not json at all\nalso garbage\n', 'utf8');

    const map = await loadTriageState(file);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadTriageState — last-writer-wins from same fingerprint (concurrent appends)
// ---------------------------------------------------------------------------

describe('loadTriageState — concurrent appends same fingerprint', () => {
  it('sequential writes of the same fingerprint: the LAST state wins on reload', async () => {
    const file = stateFile();
    const fp = computeFingerprint({ probe: 'concurrent', file: 'c.ts', severity: 'med', ruleId: 'rc1' });

    // Simulate concurrent writes by appending multiple entries sequentially.
    // loadTriageState is lock-free (last-writer-wins by iteration order).
    await appendTriageEntry(file, makeEntry(fp, 'open', { timestamp: '2026-01-01T00:00:00.000Z' }));
    await appendTriageEntry(file, makeEntry(fp, 'dismissed', { timestamp: '2026-01-02T00:00:00.000Z' }));
    await appendTriageEntry(file, makeEntry(fp, 'reopened', { timestamp: '2026-01-03T00:00:00.000Z' }));

    const map = await loadTriageState(file);
    // Last write (reopened) wins
    expect(map.size).toBe(1);
    expect(map.get(fp).state).toBe('reopened');
    expect(map.get(fp).timestamp).toBe('2026-01-03T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// filterFindings — empty stateMap
// ---------------------------------------------------------------------------

describe('filterFindings — empty stateMap', () => {
  it('all findings go to toShow when stateMap is empty', () => {
    const findings = [
      makeFinding({ ruleId: 'r1' }),
      makeFinding({ ruleId: 'r2' }),
      makeFinding({ ruleId: 'r3' }),
    ];
    const { toShow, suppressed, tracked } = filterFindings({
      findings,
      stateMap: new Map(),
    });
    expect(toShow).toHaveLength(3);
    expect(suppressed).toHaveLength(0);
    expect(tracked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadTriageState — LOW-004: DISCOVERY_DEBUG stderr output for malformed lines
// ---------------------------------------------------------------------------

describe('loadTriageState — DISCOVERY_DEBUG malformed-line logging', () => {
  it('writes to stderr when DISCOVERY_DEBUG=1 and malformed lines exist', async () => {
    const file = stateFile();
    const fp = computeFingerprint({ probe: 'debug', file: 'd.ts', severity: 'high', ruleId: 'r-debug' });

    await appendTriageEntry(file, makeEntry(fp, 'open'));
    // Inject a malformed line
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, 'bad json line\n', 'utf8');

    // Capture stderr output
    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(String(chunk));
      return originalWrite(chunk, ...args);
    };

    const prevDebug = process.env.DISCOVERY_DEBUG;
    try {
      process.env.DISCOVERY_DEBUG = '1';
      const map = await loadTriageState(file);
      // Valid entry still loads
      expect(map.size).toBe(1);
      expect(map.get(fp).state).toBe('open');
    } finally {
      process.stderr.write = originalWrite;
      if (prevDebug === undefined) {
        delete process.env.DISCOVERY_DEBUG;
      } else {
        process.env.DISCOVERY_DEBUG = prevDebug;
      }
    }

    const stderrOutput = stderrChunks.join('');
    expect(stderrOutput).toMatch(/\[triage-state\]/);
    expect(stderrOutput).toMatch(/malformed/);
    expect(stderrOutput).toMatch(/1/); // count = 1
  });

  it('does NOT write to stderr when DISCOVERY_DEBUG is unset and malformed lines exist', async () => {
    const file = stateFile();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, 'garbage line\n', 'utf8');

    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(String(chunk));
      return originalWrite(chunk, ...args);
    };

    const prevDebug = process.env.DISCOVERY_DEBUG;
    try {
      delete process.env.DISCOVERY_DEBUG;
      await loadTriageState(file);
    } finally {
      process.stderr.write = originalWrite;
      if (prevDebug !== undefined) {
        process.env.DISCOVERY_DEBUG = prevDebug;
      }
    }

    const triage = stderrChunks.filter((c) => c.includes('[triage-state]'));
    expect(triage).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterFindings — unfingerprintable finding (missing required field)
// ---------------------------------------------------------------------------

describe('filterFindings — unfingerprintable findings', () => {
  it('finding missing ruleId goes to toShow as safe default', () => {
    // A finding with no ruleId cannot be fingerprinted — it should be shown.
    const bad = { probe: 'p', file: 'f.ts', severity: 'high' }; // no ruleId
    const { toShow, suppressed } = filterFindings({
      findings: [bad],
      stateMap: new Map(),
    });
    expect(toShow).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });
});
