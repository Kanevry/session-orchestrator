import { describe, it, expect } from 'vitest';
import { computeSuitabilityVerdict } from '../../../scripts/lib/autonomy/suitability.mjs';

// Test data, not test logic: a >=5-length all-clean recent-runs array. Each
// record has kill_switch:null (NOT fired), so the kill-switch gate passes.
const RUNS_OK = Array.from({ length: 6 }, () => ({ kill_switch: null }));

// A fully green base: confidence above the default floor, CI green, resource
// green, six clean runs. suitable=true. Individual tests override one field.
const GREEN = {
  confidence: 0.72,
  ci: { status: 'green' },
  resourceVerdict: 'green',
  recentRuns: RUNS_OK,
};

describe('computeSuitabilityVerdict — suitable truth-table', () => {
  it('all-green inputs → suitable true', () => {
    const r = computeSuitabilityVerdict(GREEN);
    expect(r.suitable).toBe(true);
  });

  it('all-green rationale starts with suitable=true', () => {
    const r = computeSuitabilityVerdict(GREEN);
    expect(r.rationale).toContain('suitable=true');
  });

  it('confidence below floor (0.4 < 0.5) → not suitable', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: 0.4 });
    expect(r.suitable).toBe(false);
  });

  it('confidence below floor → rationale carries the confidence FAIL segment', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: 0.4 });
    expect(r.rationale).toContain('confidence 0.4>=0.5 FAIL');
  });

  it('confidence above floor → rationale carries the confidence ok segment', () => {
    const r = computeSuitabilityVerdict(GREEN);
    expect(r.rationale).toContain('confidence 0.72>=0.5 ok');
  });

  it('confidence exactly at floor (0.5 >= 0.5) → passes G1, suitable true', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: 0.5, confidenceFloor: 0.5 });
    expect(r.suitable).toBe(true);
  });

  it('confidence exactly at floor → rationale shows confidence ok', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: 0.5, confidenceFloor: 0.5 });
    expect(r.rationale).toContain('confidence 0.5>=0.5 ok');
  });

  it('confidence NaN → fail-closed, not suitable', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: NaN });
    expect(r.suitable).toBe(false);
  });

  it('confidence missing (undefined) → fail-closed, not suitable', () => {
    const r = computeSuitabilityVerdict({
      ci: { status: 'green' },
      resourceVerdict: 'green',
      recentRuns: RUNS_OK,
    });
    expect(r.suitable).toBe(false);
  });

  it('CI red overrides high confidence (0.99) → not suitable', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: 0.99, ci: { status: 'red' } });
    expect(r.suitable).toBe(false);
  });

  it('CI red → rationale names the FORCED CI-red reason', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: 0.99, ci: { status: 'red' } });
    expect(r.rationale).toContain('FORCED: CI red');
  });

  it("CI 'unknown' → passes G3, suitable true", () => {
    const r = computeSuitabilityVerdict({ ...GREEN, ci: { status: 'unknown' } });
    expect(r.suitable).toBe(true);
  });

  it('CI null → passes G3, suitable true', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, ci: null });
    expect(r.suitable).toBe(true);
  });

  it('CI null → pushes the "CI signal absent" warning', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, ci: null });
    expect(r.warnings).toContain('CI signal absent');
  });

  it("resourceVerdict 'critical' overrides high confidence + green CI → not suitable", () => {
    const r = computeSuitabilityVerdict({
      ...GREEN,
      confidence: 0.99,
      ci: { status: 'green' },
      resourceVerdict: 'critical',
    });
    expect(r.suitable).toBe(false);
  });

  it("resourceVerdict 'critical' → rationale names FORCED resource critical", () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: 0.99, resourceVerdict: 'critical' });
    expect(r.rationale).toContain('FORCED: resource critical');
  });

  it("resourceVerdict 'CRITICAL' (uppercase) → normalized and caught, not suitable", () => {
    const r = computeSuitabilityVerdict({ ...GREEN, resourceVerdict: 'CRITICAL' });
    expect(r.suitable).toBe(false);
  });

  it("resourceVerdict 'degraded' → passes G4, suitable true", () => {
    const r = computeSuitabilityVerdict({ ...GREEN, resourceVerdict: 'degraded' });
    expect(r.suitable).toBe(true);
  });

  it("resourceVerdict 'warn' → passes G4, suitable true", () => {
    const r = computeSuitabilityVerdict({ ...GREEN, resourceVerdict: 'warn' });
    expect(r.suitable).toBe(true);
  });

  it('resourceVerdict null → passes G4, suitable true', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, resourceVerdict: null });
    expect(r.suitable).toBe(true);
  });

  it('resourceVerdict null → pushes the "resource signal absent" warning', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, resourceVerdict: null });
    expect(r.warnings).toContain('resource signal absent');
  });

  it('CI red AND resource critical → combined FORCED reason', () => {
    const r = computeSuitabilityVerdict({
      ...GREEN,
      confidence: 0.99,
      ci: { status: 'red' },
      resourceVerdict: 'critical',
    });
    expect(r.rationale).toContain('FORCED: CI red + resource critical');
  });
});

describe('computeSuitabilityVerdict — kill-switch gate', () => {
  it.each([1, 2, 3, 4])('only %i run(s) (<5) → gate omitted, suitable still true', (len) => {
    const runs = Array.from({ length: len }, () => ({ kill_switch: null }));
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.suitable).toBe(true);
  });

  it('1 run (<5) → pushes the exact omission warning', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: [{ kill_switch: null }] });
    expect(r.warnings).toContain('kill-switch signal omitted: only 1<5 runs');
  });

  it('4 runs (<5) → pushes the omission warning with n=4', () => {
    const runs = Array.from({ length: 4 }, () => ({ kill_switch: null }));
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.warnings).toContain('kill-switch signal omitted: only 4<5 runs');
  });

  it('exactly 5 runs, 0 fired (rate 0 < 0.2) → passes G2, suitable true', () => {
    const runs = Array.from({ length: 5 }, () => ({ kill_switch: null }));
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.suitable).toBe(true);
  });

  it('5 runs, 1 fired (rate 0.2 — NOT < 0.2) → fails G2, not suitable', () => {
    const runs = [
      { kill_switch: 'SPIRAL' },
      { kill_switch: null },
      { kill_switch: null },
      { kill_switch: null },
      { kill_switch: null },
    ];
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.suitable).toBe(false);
  });

  it('5 runs, 1 fired → rationale shows kill-switch 1/5 fired rate=0.2 FAIL', () => {
    const runs = [
      { kill_switch: 'SPIRAL' },
      { kill_switch: null },
      { kill_switch: null },
      { kill_switch: null },
      { kill_switch: null },
    ];
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.rationale).toContain('kill-switch 1/5 fired rate=0.2 FAIL');
  });

  it('5 runs, 2 fired (rate 0.4) → fails G2, not suitable', () => {
    const runs = [
      { kill_switch: 'SPIRAL' },
      { kill_switch: 'FAILED-wave' },
      { kill_switch: null },
      { kill_switch: null },
      { kill_switch: null },
    ];
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.suitable).toBe(false);
  });

  it('10 runs, 1 fired (rate 0.1 < 0.2) → passes G2, suitable true', () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({ kill_switch: i === 0 ? 'SPIRAL' : null }));
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.suitable).toBe(true);
  });

  it('10 runs, 1 fired → rationale shows rate=0.1 ok', () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({ kill_switch: i === 0 ? 'SPIRAL' : null }));
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.rationale).toContain('kill-switch 1/10 fired rate=0.1 ok');
  });

  it('non-empty-string kill_switch counts as fired → fails the gate at rate 0.2', () => {
    const runs = [
      { kill_switch: 'x' },
      { kill_switch: null },
      { kill_switch: null },
      { kill_switch: null },
      { kill_switch: null },
    ];
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.rationale).toContain('kill-switch 1/5 fired rate=0.2 FAIL');
  });

  it('empty-string kill_switch does NOT count as fired → 0/5, gate passes', () => {
    const runs = Array.from({ length: 5 }, () => ({ kill_switch: '' }));
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.rationale).toContain('kill-switch 0/5 fired rate=0 ok');
  });

  it('non-string kill_switch (number) does NOT count as fired → 0/5, gate passes', () => {
    const runs = Array.from({ length: 5 }, () => ({ kill_switch: 1 }));
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.rationale).toContain('kill-switch 0/5 fired rate=0 ok');
  });

  it('missing kill_switch field does NOT count as fired → 0/5, gate passes', () => {
    const runs = Array.from({ length: 5 }, () => ({}));
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.rationale).toContain('kill-switch 0/5 fired rate=0 ok');
  });
});

describe('computeSuitabilityVerdict — returned shape & robustness', () => {
  it('returns an object with the four documented keys', () => {
    const r = computeSuitabilityVerdict(GREEN);
    expect(Object.keys(r).sort()).toEqual(['confidence', 'rationale', 'suitable', 'warnings']);
  });

  it('suitable is a boolean', () => {
    const r = computeSuitabilityVerdict(GREEN);
    expect(typeof r.suitable).toBe('boolean');
  });

  it('confidence is a number', () => {
    const r = computeSuitabilityVerdict(GREEN);
    expect(typeof r.confidence).toBe('number');
  });

  it('rationale is a string', () => {
    const r = computeSuitabilityVerdict(GREEN);
    expect(typeof r.rationale).toBe('string');
  });

  it('warnings is an array', () => {
    const r = computeSuitabilityVerdict(GREEN);
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('confidence echoes the validated injected number for a valid input', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: 0.72 });
    expect(r.confidence).toBe(0.72);
  });

  it('confidence echo is 0 when injected confidence is NaN', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, confidence: NaN });
    expect(r.confidence).toBe(0);
  });

  it('confidence echo is 0 when injected confidence is missing', () => {
    const r = computeSuitabilityVerdict({
      ci: { status: 'green' },
      resourceVerdict: 'green',
      recentRuns: RUNS_OK,
    });
    expect(r.confidence).toBe(0);
  });

  it('non-array recentRuns (string) does not throw', () => {
    expect(() => computeSuitabilityVerdict({ ...GREEN, recentRuns: 'oops' })).not.toThrow();
  });

  it('non-array recentRuns (string) returns a verdict object with the omission warning', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: 'oops' });
    expect(r.warnings).toContain('recentRuns not an array — kill-switch gate omitted');
  });

  it('ci that is not an object (string) does not throw', () => {
    expect(() => computeSuitabilityVerdict({ ...GREEN, ci: 'green' })).not.toThrow();
  });

  it('malformed ci (string) is treated as absent → CI malformed warning', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, ci: 'green' });
    expect(r.warnings).toContain('CI signal malformed — treated as absent');
  });

  it('malformed ci (string) still yields a verdict object with a boolean suitable', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, ci: 'green' });
    expect(typeof r.suitable).toBe('boolean');
  });

  it('malformed resourceVerdict (number) is treated as absent → resource malformed warning', () => {
    const r = computeSuitabilityVerdict({ ...GREEN, resourceVerdict: 5 });
    expect(r.warnings).toContain('resource signal malformed — treated as absent');
  });

  it('null run records do not throw and count as not-fired', () => {
    const runs = Array.from({ length: 5 }, () => null);
    expect(() => computeSuitabilityVerdict({ ...GREEN, recentRuns: runs })).not.toThrow();
  });

  it('null run records → 0/5 fired, gate passes', () => {
    const runs = Array.from({ length: 5 }, () => null);
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.rationale).toContain('kill-switch 0/5 fired rate=0 ok');
  });

  it('number run records do not throw and count as not-fired', () => {
    const runs = Array.from({ length: 5 }, () => 42);
    expect(() => computeSuitabilityVerdict({ ...GREEN, recentRuns: runs })).not.toThrow();
  });

  it('number run records → 0/5 fired, gate passes', () => {
    const runs = Array.from({ length: 5 }, () => 42);
    const r = computeSuitabilityVerdict({ ...GREEN, recentRuns: runs });
    expect(r.rationale).toContain('kill-switch 0/5 fired rate=0 ok');
  });

  it('called with no arguments does not throw and returns a verdict object', () => {
    expect(() => computeSuitabilityVerdict()).not.toThrow();
    const r = computeSuitabilityVerdict();
    expect(typeof r.suitable).toBe('boolean');
  });

  it('no-argument call is not suitable (no confidence ⇒ G1 fails closed)', () => {
    const r = computeSuitabilityVerdict();
    expect(r.suitable).toBe(false);
  });
});

describe('computeSuitabilityVerdict — autonomy dial (advisory, never flips suitable)', () => {
  it("autonomy 'off' on an otherwise-suitable input → suitable still true", () => {
    const r = computeSuitabilityVerdict({ ...GREEN, autonomy: 'off' });
    expect(r.suitable).toBe(true);
  });

  it("autonomy 'off' → pushes the advisory warning", () => {
    const r = computeSuitabilityVerdict({ ...GREEN, autonomy: 'off' });
    expect(r.warnings).toContain('autonomy off — verdict advisory only; caller will confirm');
  });

  it("autonomy 'autonomous-gated' → no advisory off-warning", () => {
    const r = computeSuitabilityVerdict({ ...GREEN, autonomy: 'autonomous-gated' });
    expect(r.warnings).not.toContain('autonomy off — verdict advisory only; caller will confirm');
  });
});
