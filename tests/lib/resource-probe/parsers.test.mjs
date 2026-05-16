/**
 * tests/lib/resource-probe/parsers.test.mjs
 *
 * Per-submodule unit tests for scripts/lib/resource-probe/parsers.mjs.
 *
 * The facade test (tests/lib/resource-probe.test.mjs) already covers
 * parseEtimeToMinutes, countZombieProcesses, parseSwapUsageOutput, and
 * parseMemoryPressureOutput via the re-exported symbols. This file adds
 * additional branches and edge cases that the facade test does not reach,
 * and also covers countProcessMatches (which the facade tests via the
 * resource-probe.mjs barrel, not directly from parsers.mjs).
 *
 * All functions are pure — no mocks required. All expected values are
 * hardcoded literals (test-quality.md anti-pattern #3 avoided).
 */

import { describe, it, expect } from 'vitest';
import {
  parseEtimeToMinutes,
  countZombieProcesses,
  countProcessMatches,
  parseSwapUsageOutput,
  parseMemoryPressureOutput,
} from '@lib/resource-probe/parsers.mjs';

// ---------------------------------------------------------------------------
// parseEtimeToMinutes
// ---------------------------------------------------------------------------

describe('parseEtimeToMinutes', () => {
  it('parses MM:SS — returns whole minutes, drops seconds', () => {
    expect(parseEtimeToMinutes('05:30')).toBe(5);
  });

  it('parses MM:SS with zero seconds', () => {
    expect(parseEtimeToMinutes('10:00')).toBe(10);
  });

  it('parses HH:MM:SS — converts to total minutes', () => {
    // 2h 15m 0s → 135 minutes
    expect(parseEtimeToMinutes('02:15:00')).toBe(135);
  });

  it('parses HH:MM:SS with non-zero seconds (seconds are dropped)', () => {
    // 1h 0m 59s → 60 minutes (seconds ignored)
    expect(parseEtimeToMinutes('01:00:59')).toBe(60);
  });

  it('parses DD-HH:MM:SS — converts days + hours + minutes', () => {
    // 1 day 2h 30m → 1440 + 120 + 30 = 1590 minutes
    expect(parseEtimeToMinutes('1-02:30:00')).toBe(1590);
  });

  it('parses DD-MM:SS (no hours component) — days-minutes-seconds', () => {
    // "1-05:00" → days=1, hours=0, mins=5 → 1440 + 0 + 5 = 1445
    expect(parseEtimeToMinutes('1-05:00')).toBe(1445);
  });

  it('parses 0-00:00:00 as 0 minutes', () => {
    expect(parseEtimeToMinutes('0-00:00:00')).toBe(0);
  });

  it('handles leading/trailing whitespace via trim', () => {
    expect(parseEtimeToMinutes('  03:00  ')).toBe(3);
  });

  it('returns null for an empty string', () => {
    expect(parseEtimeToMinutes('')).toBe(null);
  });

  it('returns null for a whitespace-only string', () => {
    expect(parseEtimeToMinutes('   ')).toBe(null);
  });

  it('returns null for a non-string number', () => {
    expect(parseEtimeToMinutes(123)).toBe(null);
  });

  it('returns null for null', () => {
    expect(parseEtimeToMinutes(null)).toBe(null);
  });

  it('returns null for undefined', () => {
    expect(parseEtimeToMinutes(undefined)).toBe(null);
  });

  it('returns null for a garbage string', () => {
    expect(parseEtimeToMinutes('not-a-time')).toBe(null);
  });

  it('returns null for a partial format (minutes only, no colon)', () => {
    expect(parseEtimeToMinutes('42')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// countZombieProcesses
// ---------------------------------------------------------------------------

describe('countZombieProcesses', () => {
  const HEADER = '  PID COMM             ELAPSED  %CPU';

  const makeOutput = (...rows) => [HEADER, ...rows].join('\n');

  it('counts a single idle claude process older than threshold as zombie', () => {
    const output = makeOutput('  101 claude           01:00:00   0.0');
    // 60 min elapsed, 0% CPU, threshold 30 → zombie
    expect(countZombieProcesses(output, 30)).toBe(1);
  });

  it('does not count a claude process younger than threshold', () => {
    const output = makeOutput('  102 claude           10:00   0.0');
    // 10 min < 30 min threshold → not a zombie
    expect(countZombieProcesses(output, 30)).toBe(0);
  });

  it('does not count a claude process with active CPU (> 1.0%)', () => {
    const output = makeOutput('  103 claude           01:00:00  45.0');
    // Old but busy → not a zombie candidate
    expect(countZombieProcesses(output, 30)).toBe(0);
  });

  it('counts an idle node process older than threshold', () => {
    const output = makeOutput('  104 node             02:00:00   0.5');
    // 120 min, 0.5% CPU ≤ maxCpuPct(1.0) → zombie
    expect(countZombieProcesses(output, 30)).toBe(1);
  });

  it('does not count non-claude/node processes regardless of age', () => {
    const output = makeOutput('  105 bash             05:00:00   0.0');
    expect(countZombieProcesses(output, 30)).toBe(0);
  });

  it('counts multiple zombie candidates, skips active ones', () => {
    const output = makeOutput(
      '  106 claude           01:00:00   0.0',  // zombie
      '  107 node             02:00:00   0.0',  // zombie
      '  108 claude           00:05:00  55.0',  // active — skip
    );
    expect(countZombieProcesses(output, 30)).toBe(2);
  });

  it('returns null when psOutput is null', () => {
    expect(countZombieProcesses(null, 30)).toBe(null);
  });

  it('returns null when psOutput is undefined', () => {
    expect(countZombieProcesses(undefined, 30)).toBe(null);
  });

  it('returns 0 for output containing only the header', () => {
    const output = makeOutput();
    expect(countZombieProcesses(output, 30)).toBe(0);
  });

  it('respects a custom maxCpuPct — process at 1.5% CPU is not zombie at default but is at maxCpuPct=2', () => {
    const output = makeOutput('  109 claude           01:00:00   1.5');
    expect(countZombieProcesses(output, 30)).toBe(0);          // default maxCpuPct=1.0 → not zombie
    expect(countZombieProcesses(output, 30, 2.0)).toBe(1);     // maxCpuPct=2.0 → zombie
  });

  it('handles CRLF line endings', () => {
    const output = [HEADER, '  110 claude           01:00:00   0.0'].join('\r\n');
    expect(countZombieProcesses(output, 30)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// countProcessMatches
// ---------------------------------------------------------------------------

describe('countProcessMatches', () => {
  const PATTERNS = [
    { key: 'claude', match: (l) => /(^|[\s/,"])claude([\s",]|$)/.test(l) },
    { key: 'node', match: (l) => /(^|[\s/,"])node([\s",]|$)/.test(l) },
  ];

  it('counts pattern matches per key across lines', () => {
    const input = ['claude', 'node', '/usr/bin/claude', 'node /app/server.js', 'bash'].join('\n');
    expect(countProcessMatches(input, PATTERNS)).toEqual({ claude: 2, node: 2 });
  });

  it('returns null when psOutput is null', () => {
    expect(countProcessMatches(null, PATTERNS)).toBe(null);
  });

  it('returns null when psOutput is undefined', () => {
    expect(countProcessMatches(undefined, PATTERNS)).toBe(null);
  });

  it('returns zero counts when no lines match any pattern', () => {
    expect(countProcessMatches('bash\nzsh\npython', PATTERNS)).toEqual({ claude: 0, node: 0 });
  });

  it('handles CRLF line endings', () => {
    expect(countProcessMatches('claude\r\nnode\r\n', PATTERNS)).toEqual({ claude: 1, node: 1 });
  });

  it('returns zero counts for an empty string', () => {
    expect(countProcessMatches('', PATTERNS)).toEqual({ claude: 0, node: 0 });
  });
});

// ---------------------------------------------------------------------------
// parseSwapUsageOutput
// ---------------------------------------------------------------------------

describe('parseSwapUsageOutput', () => {
  it('parses typical macOS sysctl vm.swapusage output', () => {
    const text = 'vm.swapusage: total = 4096.00M  used = 1234.50M  free = 2861.50M  (encrypted)';
    // Math.round(1234.50) === 1235
    expect(parseSwapUsageOutput(text)).toBe(1235);
  });

  it('parses zero swap usage', () => {
    const text = 'vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M';
    expect(parseSwapUsageOutput(text)).toBe(0);
  });

  it('parses large swap values', () => {
    const text = 'vm.swapusage: total = 8192.00M  used = 5219.75M  free = 2972.25M  (encrypted)';
    // Math.round(5219.75) === 5220
    expect(parseSwapUsageOutput(text)).toBe(5220);
  });

  it('returns null for garbage output', () => {
    expect(parseSwapUsageOutput('garbage output without numbers')).toBe(null);
  });

  it('returns null for null input', () => {
    expect(parseSwapUsageOutput(null)).toBe(null);
  });

  it('returns null for undefined input', () => {
    expect(parseSwapUsageOutput(undefined)).toBe(null);
  });

  it('returns null for an empty string', () => {
    expect(parseSwapUsageOutput('')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// parseMemoryPressureOutput
// ---------------------------------------------------------------------------

describe('parseMemoryPressureOutput', () => {
  it('parses the standard memory_pressure output format', () => {
    expect(parseMemoryPressureOutput('System-wide memory free percentage: 42%')).toBe(42);
  });

  it('parses 0% free (fully saturated)', () => {
    expect(parseMemoryPressureOutput('System-wide memory free percentage: 0%')).toBe(0);
  });

  it('parses 100% free (completely idle system)', () => {
    expect(parseMemoryPressureOutput('System-wide memory free percentage: 100%')).toBe(100);
  });

  it('is case-insensitive in the regex match', () => {
    // The regex uses /i flag
    expect(parseMemoryPressureOutput('system-wide memory free percentage: 55%')).toBe(55);
  });

  it('returns null for garbage output', () => {
    expect(parseMemoryPressureOutput('some random output')).toBe(null);
  });

  it('returns null for null input', () => {
    expect(parseMemoryPressureOutput(null)).toBe(null);
  });

  it('returns null for undefined input', () => {
    expect(parseMemoryPressureOutput(undefined)).toBe(null);
  });

  it('returns null for an empty string', () => {
    expect(parseMemoryPressureOutput('')).toBe(null);
  });
});
