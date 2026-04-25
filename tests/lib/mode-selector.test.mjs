import { describe, it, expect } from 'vitest';
import { selectMode } from '../../scripts/lib/mode-selector.mjs';

describe('selectMode — scaffold contract', () => {
  describe('fallback paths', () => {
    it('null signals → feature fallback at confidence 0.0', () => {
      const r = selectMode(null);
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.rationale).toMatch(/scaffold.*null/i);
      expect(r.alternatives).toEqual([]);
    });

    it('undefined signals → feature fallback at confidence 0.0', () => {
      const r = selectMode(undefined);
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.rationale).toMatch(/scaffold.*null/i);
      expect(r.alternatives).toEqual([]);
    });

    it('empty object → feature fallback at confidence 0.0', () => {
      const r = selectMode({});
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.rationale).toMatch(/missing|invalid/i);
      expect(r.alternatives).toEqual([]);
    });

    it('unknown recommendedMode string → feature fallback at confidence 0.0', () => {
      const r = selectMode({ recommendedMode: 'unknown-mode-foo' });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.rationale).toMatch(/missing|invalid/i);
      expect(r.alternatives).toEqual([]);
    });

    it.each([42, {}, [], true])(
      'non-string recommendedMode %j → feature fallback at confidence 0.0',
      (value) => {
        const r = selectMode({ recommendedMode: value });
        expect(r.mode).toBe('feature');
        expect(r.confidence).toBe(0.0);
        expect(r.alternatives).toEqual([]);
      },
    );
  });

  describe('passthrough path', () => {
    it.each(['housekeeping', 'feature', 'deep', 'discovery', 'evolve', 'plan-retro'])(
      'valid recommendedMode %s → passthrough at confidence 0.5',
      (mode) => {
        const r = selectMode({ recommendedMode: mode });
        expect(r.mode).toBe(mode);
        expect(r.confidence).toBe(0.5);
        expect(r.rationale).toMatch(/passthrough/i);
        expect(r.alternatives).toEqual([]);
      },
    );
  });

  describe('shape contract', () => {
    const cases = [
      null,
      undefined,
      {},
      { recommendedMode: 'deep' },
      { recommendedMode: 'garbage' },
    ];

    it('every return has exactly 4 keys: alternatives, confidence, mode, rationale', () => {
      for (const input of cases) {
        const r = selectMode(input);
        expect(Object.keys(r).sort()).toEqual(['alternatives', 'confidence', 'mode', 'rationale']);
      }
    });

    it('alternatives is always an empty array', () => {
      for (const input of cases) {
        const r = selectMode(input);
        expect(Array.isArray(r.alternatives)).toBe(true);
        expect(r.alternatives.length).toBe(0);
      }
    });

    it('rationale is at most 120 chars', () => {
      for (const input of cases) {
        const r = selectMode(input);
        expect(r.rationale.length).toBeLessThanOrEqual(120);
      }
    });
  });

  describe('reserved fields', () => {
    it('ignores learnings/recentSessions/backlog/bootstrapLock/vaultStaleness', () => {
      const withReserved = selectMode({
        recommendedMode: 'deep',
        learnings: [{}],
        recentSessions: [{}],
        backlog: [{}],
        bootstrapLock: {},
        vaultStaleness: {},
      });
      const withoutReserved = selectMode({ recommendedMode: 'deep' });
      expect(withReserved).toEqual(withoutReserved);
    });
  });
});
