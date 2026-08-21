import { describe, it, expect } from 'vitest';

import {
  probe,
  evaluate,
  countProcessMatches,
  parseSwapUsageOutput,
  parseMemoryPressureOutput,
  parseEtimeToMinutes,
  countZombieProcesses,
  DEFAULT_RESOURCE_THRESHOLDS,
} from '@lib/resource-probe.mjs';

describe('resource-probe', () => {
  describe('probe()', () => {
    it('returns the expected shape (skipProcessCounts=true for speed)', async () => {
      const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
      expect(s).toMatchObject({
        timestamp: expect.any(String),
        ram_free_gb: expect.any(Number),
        ram_used_pct: expect.any(Number),
        cpu_load_1m: expect.any(Number),
        cpu_load_pct: expect.any(Number),
        claude_processes_count: null,
        codex_processes_count: null,
        other_node_processes: null,
        probe_duration_ms: expect.any(Number),
      });
    });

    it('shape includes swap_used_mb and memory_pressure_pct_free fields', async () => {
      const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
      expect(Object.prototype.hasOwnProperty.call(s, 'swap_used_mb')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(s, 'memory_pressure_pct_free')).toBe(true);
      // When skipExtendedSignals=true both must be null
      expect(s.swap_used_mb).toBe(null);
      expect(s.memory_pressure_pct_free).toBe(null);
    });

    it('skipExtendedSignals=true returns null for swap_used_mb and memory_pressure_pct_free', async () => {
      const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
      expect(s.swap_used_mb).toBe(null);
      expect(s.memory_pressure_pct_free).toBe(null);
    });

    it('extended signals are number|null when skipExtendedSignals is omitted', async () => {
      const s = await probe({ skipProcessCounts: true });
      const isValid = (v) => v === null || (typeof v === 'number' && v >= 0);
      expect(isValid(s.swap_used_mb)).toBe(true);
      expect(isValid(s.memory_pressure_pct_free)).toBe(true);
    }, 5000);

    it('emits cpu_load_5m (number) and cpu_load_5m_pct (0..100 or null) — the #943 gate input', async () => {
      // Bug this catches: probe() stops emitting the 5m fields → evaluate() and
      // wave-resource-gate silently fall back to 1m-only judging forever, and
      // the #943 transient-suppression is dead without any test going red.
      // Reference real output (this host, 2026-07-31): loadavg [13.27, 14.31]
      // on 18 cores → cpu_load_5m 14.3, cpu_load_5m_pct 79.
      const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
      expect(typeof s.cpu_load_5m).toBe('number');
      const validPct = s.cpu_load_5m_pct === null
        || (typeof s.cpu_load_5m_pct === 'number' && s.cpu_load_5m_pct >= 0 && s.cpu_load_5m_pct <= 100);
      expect(validPct).toBe(true);
      // On Unix hosts with any uptime the 5m average is > 0 → pct is numeric;
      // null is the Windows/zero-load carve-out.
      if (process.platform !== 'win32') {
        expect(typeof s.cpu_load_5m_pct).toBe('number');
      }
    });

    it('probe_duration_ms is below 200 in the fast path', async () => {
      const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
      expect(s.probe_duration_ms).toBeLessThan(200);
    });

    it('ram_used_pct is between 0 and 100 inclusive', async () => {
      const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
      expect(s.ram_used_pct).toBeGreaterThanOrEqual(0);
      expect(s.ram_used_pct).toBeLessThanOrEqual(100);
    });

    it('cpu_load_pct is between 0 and 100 inclusive', async () => {
      const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
      expect(s.cpu_load_pct).toBeGreaterThanOrEqual(0);
      expect(s.cpu_load_pct).toBeLessThanOrEqual(100);
    });

    it('produces a valid ISO 8601 timestamp', async () => {
      const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
      const t = Date.parse(s.timestamp);
      expect(Number.isNaN(t)).toBe(false);
    });

    // Full probe with process counts — still under 1 second on typical hosts.
    it('with real process listing, returns numeric counts (or null on failure)', async () => {
      const s = await probe();
      const ok = (v) => v === null || (typeof v === 'number' && v >= 0);
      expect(ok(s.claude_processes_count)).toBe(true);
      expect(ok(s.codex_processes_count)).toBe(true);
      expect(ok(s.other_node_processes)).toBe(true);
    }, 3000);
  });

  describe('countProcessMatches', () => {
    const patterns = [
      { key: 'claude', match: (l) => /(^|[\s/,"])claude([\s",]|$)/.test(l) },
      { key: 'node', match: (l) => /(^|[\s/,"])node([\s",]|$)/.test(l) },
    ];

    it('counts matches per pattern', () => {
      const input = [
        'claude',
        'node',
        '/usr/bin/claude',
        'node /app/server.js',
        'bash',
      ].join('\n');
      expect(countProcessMatches(input, patterns)).toEqual({ claude: 2, node: 2 });
    });

    it('returns null when input is null', () => {
      expect(countProcessMatches(null, patterns)).toBe(null);
    });

    it('returns zero counts when no match found', () => {
      expect(countProcessMatches('foo\nbar\nbaz', patterns)).toEqual({ claude: 0, node: 0 });
    });

    it('handles CRLF line endings', () => {
      expect(countProcessMatches('claude\r\nnode\r\n', patterns)).toEqual({ claude: 1, node: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // evaluate() — barrel re-export only
  // -------------------------------------------------------------------------
  //
  // #1089: five describe blocks here duplicated the rule tests that live in
  // tests/lib/resource-probe/evaluate.test.mjs. They were removed rather than
  // updated (test-value.md TV-002/TV-004): a second copy of the same rules
  // catches no bug the first copy misses, and it doubled the cost of every rule
  // change — which is part of why the previous rule set survived so long.
  //
  // What the FACADE genuinely owes its callers is that the barrel re-export
  // points at the real implementation. That is what is pinned here.
  describe('evaluate() — barrel re-export', () => {
    it('re-exports the same function object as the submodule', async () => {
      const submodule = await import('@lib/resource-probe/evaluate.mjs');
      expect(evaluate).toBe(submodule.evaluate);
    });

    it('re-exports the canonical threshold defaults', async () => {
      const submodule = await import('@lib/resource-probe/evaluate.mjs');
      expect(DEFAULT_RESOURCE_THRESHOLDS).toBe(submodule.DEFAULT_RESOURCE_THRESHOLDS);
    });

    it('evaluates a real Darwin snapshot through the barrel without throwing', async () => {
      // Smoke only — rule semantics are asserted in evaluate.test.mjs.
      const result = evaluate(
        {
          ram_free_gb: 0.3,
          ram_available_gb: 6.6,
          memory_pressure_pct_free: 53,
          cpu_load_pct: 30,
          cpu_load_5m_pct: 28,
          peer_sessions_count: 1,
          claude_processes_count: 16,
        },
        DEFAULT_RESOURCE_THRESHOLDS,
      );
      expect(result.verdict).toBe('green');
    });
  });

  describe('parseSwapUsageOutput()', () => {
    it('parses typical macOS sysctl vm.swapusage output', () => {
      const text = 'vm.swapusage: total = 4096.00M  used = 1234.50M  free = 2861.50M  (encrypted)';
      const result = parseSwapUsageOutput(text);
      // Math.round(1234.50) === 1235
      expect(result).toBe(1235);
    });

    it('parses zero swap usage', () => {
      const text = 'vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M';
      expect(parseSwapUsageOutput(text)).toBe(0);
    });

    it('returns null for garbage output', () => {
      expect(parseSwapUsageOutput('garbage output')).toBe(null);
    });

    it('returns null for null input', () => {
      expect(parseSwapUsageOutput(null)).toBe(null);
    });

    it('returns null for undefined input', () => {
      expect(parseSwapUsageOutput(undefined)).toBe(null);
    });
  });

  describe('parseMemoryPressureOutput()', () => {
    it('parses standard memory_pressure output', () => {
      expect(parseMemoryPressureOutput('System-wide memory free percentage: 42%')).toBe(42);
    });

    it('parses 0% free', () => {
      expect(parseMemoryPressureOutput('System-wide memory free percentage: 0%')).toBe(0);
    });

    it('returns null for garbage output', () => {
      expect(parseMemoryPressureOutput('garbage')).toBe(null);
    });

    it('returns null for null input', () => {
      expect(parseMemoryPressureOutput(null)).toBe(null);
    });
  });
});


describe('parseEtimeToMinutes()', () => {
  it('parses MM:SS format', () => {
    expect(parseEtimeToMinutes('05:30')).toBe(5);
  });

  it('parses HH:MM:SS format', () => {
    expect(parseEtimeToMinutes('02:15:00')).toBe(135);
  });

  it('parses DD-HH:MM:SS format', () => {
    expect(parseEtimeToMinutes('1-02:30:00')).toBe(1590); // 1440 + 150
  });

  it('parses DD-MM:SS (no hours component)', () => {
    // "1-05:00" → days=1, hours=0, mins=5
    expect(parseEtimeToMinutes('1-05:00')).toBe(1445);
  });

  it('returns null for empty string', () => {
    expect(parseEtimeToMinutes('')).toBe(null);
  });

  it('returns null for non-string input', () => {
    expect(parseEtimeToMinutes(123)).toBe(null);
  });

  it('returns null for garbage string', () => {
    expect(parseEtimeToMinutes('not-a-time')).toBe(null);
  });
});

describe('countZombieProcesses()', () => {
  // ps -A -o pid,comm,etime,%cpu output (header + rows)
  const makePsOutput = (rows) =>
    ['  PID COMM             ELAPSED  %CPU', ...rows].join('\n');

  it('counts claude process older than threshold with idle CPU', () => {
    const output = makePsOutput([
      '  101 claude           01:00:00   0.0',  // 60 min, 0% CPU → zombie at threshold=30
    ]);
    expect(countZombieProcesses(output, 30)).toBe(1);
  });

  it('does not count claude process younger than threshold', () => {
    const output = makePsOutput([
      '  102 claude           10:00   0.0',  // 10 min < 30 threshold
    ]);
    expect(countZombieProcesses(output, 30)).toBe(0);
  });

  it('does not count claude process with active CPU', () => {
    const output = makePsOutput([
      '  103 claude           01:00:00  45.0',  // old but busy
    ]);
    expect(countZombieProcesses(output, 30)).toBe(0);
  });

  it('counts node process older than threshold with idle CPU', () => {
    const output = makePsOutput([
      '  104 node             02:00:00   0.5',  // 120 min, 0.5% → at default maxCpuPct=1.0
    ]);
    expect(countZombieProcesses(output, 30)).toBe(1);
  });

  it('does not count non-claude/node processes', () => {
    const output = makePsOutput([
      '  105 bash             05:00:00   0.0',  // old idle bash — not zombie candidate
    ]);
    expect(countZombieProcesses(output, 30)).toBe(0);
  });

  it('counts multiple zombie candidates', () => {
    const output = makePsOutput([
      '  106 claude           01:00:00   0.0',
      '  107 node             02:00:00   0.0',
      '  108 claude           00:05:00  55.0',  // active — not zombie
    ]);
    expect(countZombieProcesses(output, 30)).toBe(2);
  });

  it('returns null when psOutput is null', () => {
    expect(countZombieProcesses(null, 30)).toBe(null);
  });

  it('returns 0 for empty output (header only)', () => {
    const output = makePsOutput([]);
    expect(countZombieProcesses(output, 30)).toBe(0);
  });
});

describe('probe() — zombie_processes_count field (#178)', () => {
  it('snapshot shape includes zombie_processes_count when skipProcessCounts=true → null', async () => {
    const s = await probe({ skipProcessCounts: true, skipExtendedSignals: true });
    expect(Object.prototype.hasOwnProperty.call(s, 'zombie_processes_count')).toBe(true);
    expect(s.zombie_processes_count).toBe(null);
  });

  it('zombie_processes_count is null when zombieThresholdMin not provided', async () => {
    const s = await probe({ skipProcessCounts: false, skipExtendedSignals: true });
    // No zombieThresholdMin → feature disabled → null
    expect(s.zombie_processes_count).toBe(null);
  }, 3000);

  it('zombie_processes_count is number|null when zombieThresholdMin is provided', async () => {
    const s = await probe({ skipExtendedSignals: true, zombieThresholdMin: 30 });
    const isValid = (v) => v === null || (typeof v === 'number' && v >= 0);
    expect(isValid(s.zombie_processes_count)).toBe(true);
  }, 3000);
});
