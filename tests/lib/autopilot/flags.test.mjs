/**
 * tests/lib/autopilot/flags.test.mjs
 * Unit tests for autopilot/flags.mjs — flag parsing, bounds constants, defaults.
 */

import { describe, it, expect } from 'vitest';
import {
  FLAG_BOUNDS,
  DEFAULT_PEER_ABORT_THRESHOLD,
  DEFAULT_JSONL_PATH,
  DEFAULT_CARRYOVER_THRESHOLD,
  parseFlags,
} from '../../../scripts/lib/autopilot/flags.mjs';

// ---------------------------------------------------------------------------
// FLAG_BOUNDS — frozen identity + content
// ---------------------------------------------------------------------------

describe('FLAG_BOUNDS — frozen object identity', () => {
  it('is a frozen object (Object.isFrozen)', () => {
    expect(Object.isFrozen(FLAG_BOUNDS)).toBe(true);
  });

  it('mutation attempt on FLAG_BOUNDS throws in strict mode (or silently fails)', () => {
    // In strict mode ESM, assignment to a frozen property throws TypeError.
    // We verify the value is unchanged either way.
    try { FLAG_BOUNDS.maxSessions = { min: 0, max: 1, default: 0 }; } catch { /* expected */ }
    expect(FLAG_BOUNDS.maxSessions).toEqual({ min: 1, max: 50, default: 5 });
  });

  it('maxSessions bounds are {min:1, max:50, default:5}', () => {
    expect(FLAG_BOUNDS.maxSessions).toEqual({ min: 1, max: 50, default: 5 });
  });

  it('maxHours bounds are {min:0.5, max:24.0, default:4.0}', () => {
    expect(FLAG_BOUNDS.maxHours).toEqual({ min: 0.5, max: 24.0, default: 4.0 });
  });

  it('confidenceThreshold bounds are {min:0.0, max:1.0, default:0.85}', () => {
    expect(FLAG_BOUNDS.confidenceThreshold).toEqual({ min: 0.0, max: 1.0, default: 0.85 });
  });

  it('maxTokens bounds are {min:0, max:10_000_000, default:500_000}', () => {
    expect(FLAG_BOUNDS.maxTokens).toEqual({ min: 0, max: 10_000_000, default: 500_000 });
  });
});

// ---------------------------------------------------------------------------
// Scalar constants
// ---------------------------------------------------------------------------

describe('DEFAULT_PEER_ABORT_THRESHOLD', () => {
  it('is 6', () => {
    expect(DEFAULT_PEER_ABORT_THRESHOLD).toBe(6);
  });
});

describe('DEFAULT_JSONL_PATH', () => {
  it('points to the orchestrator metrics file', () => {
    expect(DEFAULT_JSONL_PATH).toBe('.orchestrator/metrics/autopilot.jsonl');
  });
});

describe('DEFAULT_CARRYOVER_THRESHOLD', () => {
  it('is 0.5', () => {
    expect(DEFAULT_CARRYOVER_THRESHOLD).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// parseFlags — defaults
// ---------------------------------------------------------------------------

describe('parseFlags — default values on empty argv', () => {
  it('returns all defaults when argv is empty []', () => {
    expect(parseFlags([])).toEqual({
      maxSessions: 5,
      maxHours: 4.0,
      confidenceThreshold: 0.85,
      dryRun: false,
    });
  });

  it('returns all defaults when argv is null (non-array coerced to [])', () => {
    expect(parseFlags(null)).toEqual({
      maxSessions: 5,
      maxHours: 4.0,
      confidenceThreshold: 0.85,
      dryRun: false,
    });
  });

  it('returns all defaults when argv is undefined', () => {
    expect(parseFlags(undefined).maxSessions).toBe(5);
    expect(parseFlags(undefined).dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFlags — maxSessions clamping
// ---------------------------------------------------------------------------

describe('parseFlags — maxSessions clamping', () => {
  it('clamps --max-sessions=999 to 50 (upper bound)', () => {
    expect(parseFlags(['--max-sessions=999']).maxSessions).toBe(50);
  });

  it('clamps --max-sessions=0 to 1 (lower bound)', () => {
    expect(parseFlags(['--max-sessions=0']).maxSessions).toBe(1);
  });

  it('clamps --max-sessions=-5 to 1 (below lower bound)', () => {
    expect(parseFlags(['--max-sessions=-5']).maxSessions).toBe(1);
  });

  it('floors --max-sessions=3.7 to 3 (integer floor)', () => {
    expect(parseFlags(['--max-sessions=3.7']).maxSessions).toBe(3);
  });

  it('passes through --max-sessions=10 in-bounds unchanged', () => {
    expect(parseFlags(['--max-sessions=10']).maxSessions).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// parseFlags — maxHours clamping
// ---------------------------------------------------------------------------

describe('parseFlags — maxHours clamping', () => {
  it('clamps --max-hours=0 to 0.5 (lower bound)', () => {
    expect(parseFlags(['--max-hours=0']).maxHours).toBe(0.5);
  });

  it('clamps --max-hours=-1 to 0.5 (below lower bound)', () => {
    expect(parseFlags(['--max-hours=-1']).maxHours).toBe(0.5);
  });

  it('clamps --max-hours=100 to 24.0 (upper bound)', () => {
    expect(parseFlags(['--max-hours=100']).maxHours).toBe(24.0);
  });

  it('passes through --max-hours=2.5 in-bounds unchanged', () => {
    expect(parseFlags(['--max-hours=2.5']).maxHours).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// parseFlags — confidenceThreshold clamping
// ---------------------------------------------------------------------------

describe('parseFlags — confidenceThreshold clamping', () => {
  it('clamps --confidence-threshold=2 to 1.0 (upper bound)', () => {
    expect(parseFlags(['--confidence-threshold=2']).confidenceThreshold).toBe(1);
  });

  it('clamps --confidence-threshold=-0.5 to 0.0 (lower bound)', () => {
    expect(parseFlags(['--confidence-threshold=-0.5']).confidenceThreshold).toBe(0);
  });

  it('passes through --confidence-threshold=0.7 in-bounds unchanged', () => {
    expect(parseFlags(['--confidence-threshold=0.7']).confidenceThreshold).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// parseFlags — dry-run flag
// ---------------------------------------------------------------------------

describe('parseFlags — --dry-run boolean flag', () => {
  it('--dry-run sets dryRun=true', () => {
    expect(parseFlags(['--dry-run']).dryRun).toBe(true);
  });

  it('--dryRun (camelCase alias) sets dryRun=true', () => {
    expect(parseFlags(['--dryRun']).dryRun).toBe(true);
  });

  it('absent --dry-run leaves dryRun=false', () => {
    expect(parseFlags(['--max-sessions=3']).dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFlags — non-numeric and combined
// ---------------------------------------------------------------------------

describe('parseFlags — non-numeric values fall back to defaults', () => {
  it('non-numeric --max-sessions falls back to default 5', () => {
    expect(parseFlags(['--max-sessions=abc']).maxSessions).toBe(5);
  });

  it('non-numeric --max-hours falls back to default 4.0', () => {
    expect(parseFlags(['--max-hours=NaN']).maxHours).toBe(4.0);
  });

  it('non-numeric --confidence-threshold falls back to default 0.85', () => {
    expect(parseFlags(['--confidence-threshold=foo']).confidenceThreshold).toBe(0.85);
  });
});

describe('parseFlags — unknown flags ignored', () => {
  it('unknown flags do not affect known flags', () => {
    const result = parseFlags(['--max-sessions=2', '--unknown-flag=foo', '--bogus']);
    expect(result.maxSessions).toBe(2);
    expect(result.maxHours).toBe(4.0);
  });
});

describe('parseFlags — mixed valid + clamped flags', () => {
  it('resolves each flag independently', () => {
    expect(parseFlags(['--max-sessions=3', '--max-hours=999', '--dry-run'])).toEqual({
      maxSessions: 3,
      maxHours: 24.0,
      confidenceThreshold: 0.85,
      dryRun: true,
    });
  });
});
