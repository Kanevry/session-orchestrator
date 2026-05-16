import { describe, it, expect } from 'vitest';

import {
  probe,
  evaluate,
  countProcessMatches,
  parseSwapUsageOutput,
  parseMemoryPressureOutput,
  parseEtimeToMinutes,
  countZombieProcesses,
} from '@lib/resource-probe.mjs';

const DEFAULT_THRESHOLDS = {
  'ram-free-min-gb': 4,
  'ram-free-critical-gb': 2,
  'cpu-load-max-pct': 80,
  'concurrent-sessions-warn': 5,
  'ssh-no-docker': true,
};

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

  describe('evaluate()', () => {
    const baseSnapshot = {
      ram_free_gb: 8,
      ram_used_pct: 40,
      cpu_load_1m: 1.2,
      cpu_load_pct: 30,
      claude_processes_count: 1,
      codex_processes_count: 0,
      other_node_processes: 5,
    };

    it('returns green when all metrics are healthy', () => {
      const result = evaluate(baseSnapshot, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('green');
      expect(result.reasons).toEqual([]);
      expect(result.recommended_agents_per_wave_cap).toBe(null);
    });

    it('returns warn + cap=2 when RAM is below min threshold', () => {
      const snap = { ...baseSnapshot, ram_free_gb: 3 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('warn');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
      expect(result.reasons[0]).toMatch(/RAM free 3/);
    });

    it('returns critical + cap=0 when RAM is below critical threshold', () => {
      const snap = { ...baseSnapshot, ram_free_gb: 1 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('critical');
      expect(result.recommended_agents_per_wave_cap).toBe(0);
    });

    it('returns warn + cap=2 when CPU load exceeds threshold', () => {
      const snap = { ...baseSnapshot, cpu_load_pct: 90 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('warn');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
    });

    it('returns warn when claude processes meet the concurrent threshold', () => {
      const snap = { ...baseSnapshot, claude_processes_count: 5 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('warn');
      expect(result.reasons[0]).toMatch(/5 Claude processes/);
    });

    it('combines multiple warning signals and keeps the most conservative cap', () => {
      const snap = { ...baseSnapshot, ram_free_gb: 3, cpu_load_pct: 95 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('warn');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
      expect(result.reasons.length).toBe(2);
    });

    it('critical RAM beats warn CPU — cap stays at 0', () => {
      const snap = { ...baseSnapshot, ram_free_gb: 1, cpu_load_pct: 95 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('critical');
      expect(result.recommended_agents_per_wave_cap).toBe(0);
    });

    it('null claude_processes_count does not trigger a warning', () => {
      const snap = { ...baseSnapshot, claude_processes_count: null };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('green');
    });
  });

  describe('evaluate() — macOS pressure-first override', () => {
    const baseSnapshot = {
      ram_free_gb: 0.5, // simulates os.freemem() under-reporting on macOS
      ram_used_pct: 95,
      cpu_load_1m: 1.2,
      cpu_load_pct: 30,
      claude_processes_count: 1,
      codex_processes_count: 0,
      other_node_processes: 5,
      zombie_processes_count: null,
      swap_used_mb: null,
    };

    it('suppresses critical RAM verdict when memory_pressure reports system healthy (≥30% free)', () => {
      // Real-world macOS scenario: Pages free is tiny (compressor + caches eat it)
      // but pressure reports 65% free → system is fine. Old logic would say critical;
      // new logic trusts pressure.
      const snap = { ...baseSnapshot, memory_pressure_pct_free: 65 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('green');
      expect(result.recommended_agents_per_wave_cap).toBe(null);
      expect(result.reasons[0]).toMatch(/macOS memory_pressure healthy.*Pages-free underreports/);
    });

    it('does NOT suppress when pressure indicates yellow (<30% free)', () => {
      const snap = { ...baseSnapshot, memory_pressure_pct_free: 25 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      // pressure 15..30 triggers warn via memory_pressure rule;
      // and ram_free_gb 0.5 < critical 2 also still triggers critical.
      expect(result.verdict).toBe('critical');
      expect(result.recommended_agents_per_wave_cap).toBe(0);
    });

    it('does NOT suppress when memory_pressure_pct_free is null (Linux/Windows)', () => {
      const snap = { ...baseSnapshot, memory_pressure_pct_free: null };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('critical');
      expect(result.recommended_agents_per_wave_cap).toBe(0);
    });

    it('healthy pressure suppresses RAM signal but other signals (CPU, swap) still fire', () => {
      const snap = {
        ...baseSnapshot,
        memory_pressure_pct_free: 65,
        cpu_load_pct: 95, // > cpuMax 80
      };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('warn');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
      expect(result.reasons.some((r) => /CPU load 95/.test(r))).toBe(true);
    });

    it('healthy pressure ALSO suppresses swap signal (macOS swap is historical, not a real-time pressure indicator)', () => {
      // Real-world: macOS often accumulates 5+ GB swap over a multi-day session
      // even when current memory_pressure is very healthy. Activity Monitor
      // does not flag this as a problem.
      const snap = {
        ...baseSnapshot,
        memory_pressure_pct_free: 81,
        swap_used_mb: 5219, // > 3072 critical threshold
      };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      // Should NOT be critical — pressure is healthy, swap is informational only.
      expect(result.verdict).not.toBe('critical');
      expect(result.recommended_agents_per_wave_cap).not.toBe(0);
      expect(result.reasons.some((r) => /Swap usage 5219 MB present.*informational/.test(r))).toBe(true);
    });

    it('unhealthy pressure (<30%) lets swap critical signal through', () => {
      const snap = {
        ...baseSnapshot,
        memory_pressure_pct_free: 10, // pressure-degraded range
        swap_used_mb: 4000,
      };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('critical');
      expect(result.recommended_agents_per_wave_cap).toBe(0);
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

  describe('evaluate() — zombie signal (#178)', () => {
    const baseSnapshot = {
      ram_free_gb: 8,
      ram_used_pct: 40,
      cpu_load_1m: 1.2,
      cpu_load_pct: 30,
      claude_processes_count: 3,
      codex_processes_count: 0,
      other_node_processes: 5,
      swap_used_mb: null,
      memory_pressure_pct_free: null,
    };
    const thresholdsWithZombie = {
      ...DEFAULT_THRESHOLDS,
      'zombie-threshold-min': 30,
    };

    it('zombie_processes_count >= 1 AND claude > 0 → escalates to warn', () => {
      const snap = { ...baseSnapshot, zombie_processes_count: 2 };
      const result = evaluate(snap, thresholdsWithZombie);
      expect(result.verdict).toBe('warn');
      expect(result.reasons.some((r) => r.includes('2 zombie') && r.includes('30 min'))).toBe(true);
    });

    it('zombie_processes_count >= 1 BUT claude_processes_count = 0 → no escalation', () => {
      const snap = { ...baseSnapshot, claude_processes_count: 0, zombie_processes_count: 5 };
      const result = evaluate(snap, thresholdsWithZombie);
      expect(result.verdict).toBe('green');
      expect(result.reasons.some((r) => r.includes('zombie'))).toBe(false);
    });

    it('zombie_processes_count = 0 → no escalation', () => {
      const snap = { ...baseSnapshot, zombie_processes_count: 0 };
      const result = evaluate(snap, thresholdsWithZombie);
      expect(result.verdict).toBe('green');
    });

    it('zombie_processes_count = null → feature disabled, no escalation', () => {
      const snap = { ...baseSnapshot, zombie_processes_count: null };
      const result = evaluate(snap, thresholdsWithZombie);
      expect(result.verdict).toBe('green');
    });

    it('defaults applied when zombie-threshold-min absent — zombie field treated as null', () => {
      const snap = { ...baseSnapshot, zombie_processes_count: null };
      // Thresholds without zombie-threshold-min key
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('green');
    });

    it('zombie warn does not override a higher existing verdict (degraded stays degraded)', () => {
      // Swap at degraded level + zombies
      const snap = {
        ...baseSnapshot,
        swap_used_mb: 2500,
        memory_pressure_pct_free: null,
        zombie_processes_count: 3,
      };
      const result = evaluate(snap, thresholdsWithZombie);
      // degraded from swap + warn from zombie → degraded wins via bumpVerdict
      expect(result.verdict).toBe('degraded');
      expect(result.reasons.some((r) => r.includes('zombie'))).toBe(true);
    });
  });

  describe('evaluate() — swap and memory_pressure signals', () => {
    const baseSnapshot = {
      ram_free_gb: 8,
      ram_used_pct: 40,
      cpu_load_1m: 1.2,
      cpu_load_pct: 30,
      claude_processes_count: 1,
      codex_processes_count: 0,
      other_node_processes: 5,
    };

    it('swap > 3072 MB → critical regardless of healthy RAM', () => {
      const snap = { ...baseSnapshot, swap_used_mb: 3500, memory_pressure_pct_free: null };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('critical');
      expect(result.recommended_agents_per_wave_cap).toBe(0);
      expect(result.reasons.some((r) => r.includes('3500 MB above critical threshold 3072 MB'))).toBe(true);
    });

    it('swap 2048..3072 MB → degraded', () => {
      const snap = { ...baseSnapshot, swap_used_mb: 2500, memory_pressure_pct_free: null };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('degraded');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
      expect(result.reasons.some((r) => r.includes('2500 MB in degraded range'))).toBe(true);
    });

    it('swap 1024..2048 MB → warn', () => {
      const snap = { ...baseSnapshot, swap_used_mb: 1500, memory_pressure_pct_free: null };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('warn');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
      expect(result.reasons.some((r) => r.includes('1500 MB in warn range'))).toBe(true);
    });

    it('swap ≤ 1024 MB → no swap rule fires (green from all signals)', () => {
      const snap = { ...baseSnapshot, swap_used_mb: 500, memory_pressure_pct_free: null };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('green');
      expect(result.recommended_agents_per_wave_cap).toBe(null);
    });

    it('memory_pressure_pct_free < 5 → critical regardless of swap', () => {
      const snap = { ...baseSnapshot, swap_used_mb: null, memory_pressure_pct_free: 3 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('critical');
      expect(result.recommended_agents_per_wave_cap).toBe(0);
      expect(result.reasons.some((r) => r.includes('3% below critical threshold 5%'))).toBe(true);
    });

    it('memory_pressure_pct_free 5..15 → degraded', () => {
      const snap = { ...baseSnapshot, swap_used_mb: null, memory_pressure_pct_free: 10 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('degraded');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
      expect(result.reasons.some((r) => r.includes('10% in degraded range (5..15%)'))).toBe(true);
    });

    it('memory_pressure_pct_free 15..30 → warn', () => {
      const snap = { ...baseSnapshot, swap_used_mb: null, memory_pressure_pct_free: 20 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('warn');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
      expect(result.reasons.some((r) => r.includes('20% in warn range (15..30%)'))).toBe(true);
    });

    it('memory_pressure_pct_free null (Linux) → no memory_pressure rule fires', () => {
      const snap = { ...baseSnapshot, swap_used_mb: null, memory_pressure_pct_free: null };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('green');
    });

    it('critical RAM beats degraded swap → final verdict critical, cap=0', () => {
      const snap = { ...baseSnapshot, ram_free_gb: 1, swap_used_mb: 2500, memory_pressure_pct_free: null };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('critical');
      expect(result.recommended_agents_per_wave_cap).toBe(0);
    });

    it('warn swap + degraded memory_pressure → final verdict degraded, cap=2', () => {
      const snap = { ...baseSnapshot, swap_used_mb: 1500, memory_pressure_pct_free: 10 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('degraded');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
    });

    it('most-restrictive wins: both warn signals → final warn', () => {
      const snap = { ...baseSnapshot, ram_free_gb: 8, swap_used_mb: 1500, memory_pressure_pct_free: 25 };
      const result = evaluate(snap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('warn');
      expect(result.recommended_agents_per_wave_cap).toBe(2);
    });

    it('backward compat: snapshot without new fields does not throw and produces same legacy result', () => {
      // Simulate a legacy snapshot without swap_used_mb / memory_pressure_pct_free
      const legacySnap = {
        ram_free_gb: 8,
        ram_used_pct: 40,
        cpu_load_1m: 1.2,
        cpu_load_pct: 30,
        claude_processes_count: 1,
        codex_processes_count: 0,
        other_node_processes: 5,
      };
      expect(() => evaluate(legacySnap, DEFAULT_THRESHOLDS)).not.toThrow();
      const result = evaluate(legacySnap, DEFAULT_THRESHOLDS);
      expect(result.verdict).toBe('green');
      expect(result.recommended_agents_per_wave_cap).toBe(null);
    });
  });
});

// ---------------------------------------------------------------------------
// Zombie detection (#178) — parseEtimeToMinutes + countZombieProcesses + probe shape
// ---------------------------------------------------------------------------

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
