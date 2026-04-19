import { describe, it, expect } from 'vitest';

import {
  probe,
  evaluate,
  countProcessMatches,
} from '../../scripts/lib/resource-probe.mjs';

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
      const s = await probe({ skipProcessCounts: true });
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

    it('probe_duration_ms is below 200 in the fast path', async () => {
      const s = await probe({ skipProcessCounts: true });
      expect(s.probe_duration_ms).toBeLessThan(200);
    });

    it('ram_used_pct is between 0 and 100 inclusive', async () => {
      const s = await probe({ skipProcessCounts: true });
      expect(s.ram_used_pct).toBeGreaterThanOrEqual(0);
      expect(s.ram_used_pct).toBeLessThanOrEqual(100);
    });

    it('cpu_load_pct is between 0 and 100 inclusive', async () => {
      const s = await probe({ skipProcessCounts: true });
      expect(s.cpu_load_pct).toBeGreaterThanOrEqual(0);
      expect(s.cpu_load_pct).toBeLessThanOrEqual(100);
    });

    it('produces a valid ISO 8601 timestamp', async () => {
      const s = await probe({ skipProcessCounts: true });
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
});
