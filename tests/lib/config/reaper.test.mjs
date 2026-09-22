/**
 * tests/lib/config/reaper.test.mjs
 *
 * Tests for scripts/lib/config/reaper.mjs (`_parseReaper`, #1432 B4).
 *
 * Each case names the bug it catches — a parser default that drifts from the
 * runtime default, a malformed value that silently arms a kill path, or a block
 * the parser cannot find because it sits outside `## Session Config`.
 */

import { describe, it, expect } from 'vitest';

import { _parseReaper } from '../../../scripts/lib/config/reaper.mjs';
import { REAPER_DEFAULTS } from '../../../scripts/lib/orphan-reaper.mjs';

describe('_parseReaper — defaults', () => {
  it('returns the documented defaults for content with no reaper block', () => {
    // Bug: a repo that never opted in silently inherits an ARMED watchdog.
    expect(_parseReaper('# just a heading\n')).toEqual({
      enabled: false,
      mode: 'report',
      'min-age-seconds': 300,
      'min-scan-interval-seconds': 30,
      'kill-grace-ms': 10_000,
      'verify-wait-ms': 500,
      'max-hook-latency-ms': 50,
      'false-alarm-window': 50,
    });
  });

  it('defaults mirror REAPER_DEFAULTS in scripts/lib/orphan-reaper.mjs', () => {
    // Bug: the parser literals and the runtime literals are two copies (the
    // import would drag process-group.mjs into every parseSessionConfig call),
    // so a default changed on one side only would ship two different numbers —
    // the hook throttling on 30 s while the scan ages on something else.
    const parsed = _parseReaper('');
    expect(parsed['min-age-seconds']).toBe(REAPER_DEFAULTS.minAgeSeconds);
    expect(parsed['min-scan-interval-seconds']).toBe(REAPER_DEFAULTS.minScanIntervalSeconds);
    expect(parsed['kill-grace-ms']).toBe(REAPER_DEFAULTS.killGraceMs);
    expect(parsed['verify-wait-ms']).toBe(REAPER_DEFAULTS.verifyWaitMs);
    expect(parsed['max-hook-latency-ms']).toBe(REAPER_DEFAULTS.maxHookLatencyMs);
    expect(parsed['false-alarm-window']).toBe(REAPER_DEFAULTS.falseAlarmWindow);
  });

  it('an empty reaper block keeps every default', () => {
    expect(_parseReaper('reaper:\n')).toEqual(_parseReaper(''));
  });
});

describe('_parseReaper — values', () => {
  it('reads a fully populated block', () => {
    const md = [
      'reaper:',
      '  enabled: true',
      '  mode: kill',
      '  min-age-seconds: 600',
      '  min-scan-interval-seconds: 45',
      '  kill-grace-ms: 2000',
      '  verify-wait-ms: 0',
      '  max-hook-latency-ms: 25',
      '  false-alarm-window: 100',
      '',
    ].join('\n');
    expect(_parseReaper(md)).toEqual({
      enabled: true,
      mode: 'kill',
      'min-age-seconds': 600,
      'min-scan-interval-seconds': 45,
      'kill-grace-ms': 2000,
      'verify-wait-ms': 0,
      'max-hook-latency-ms': 25,
      'false-alarm-window': 100,
    });
  });

  it('only an explicit `true` arms it — every other value stays off', () => {
    // Bug: a `enabled: yes` / `enabled: 1` typo reading as armed would start
    // signalling processes on a repo that never asked for it.
    for (const raw of ['yes', '1', 'on', 'TRUE ', '']) {
      expect(_parseReaper(`reaper:\n  enabled: ${raw}\n`).enabled)
        .toBe(raw.trim().toLowerCase() === 'true');
    }
  });

  it('an unrecognised mode falls back to report, never to kill', () => {
    // Bug: a typo'd mode defaulting to the destructive branch.
    expect(_parseReaper('reaper:\n  mode: klil\n').mode).toBe('report');
    expect(_parseReaper('reaper:\n  mode: KILL\n').mode).toBe('kill');
  });

  it('strips inline comments and quotes', () => {
    const md = 'reaper:\n  mode: "kill"   # armed\n  min-scan-interval-seconds: 15  # faster\n';
    expect(_parseReaper(md).mode).toBe('kill');
    expect(_parseReaper(md)['min-scan-interval-seconds']).toBe(15);
  });
});

describe('_parseReaper — malformed values fall back', () => {
  it.each([
    ['min-scan-interval-seconds', 'abc', 30],
    ['min-scan-interval-seconds', '0', 30],
    ['min-scan-interval-seconds', '-5', 30],
    ['kill-grace-ms', '1.5', 10_000],
    ['verify-wait-ms', '-1', 500],
    ['max-hook-latency-ms', '0', 50],
    ['false-alarm-window', '0', 50],
  ])('%s: %s → default %i', (key, raw, expected) => {
    // Bug: a non-integer or out-of-range value coercing to NaN/0 would make the
    // throttle fire on every hook (interval 0) or the ladder skip its grace.
    expect(_parseReaper(`reaper:\n  ${key}: ${raw}\n`)[key]).toBe(expected);
  });
});

describe('_parseReaper — clamps', () => {
  it('widens min-age-seconds to at least one scan interval', () => {
    // Bug: a min-age below the scan period lets the watchdog judge processes it
    // has never seen in a previous scan — born and reaped between two scans.
    const md = 'reaper:\n  min-age-seconds: 5\n  min-scan-interval-seconds: 60\n';
    expect(_parseReaper(md)['min-age-seconds']).toBe(60);
  });

  it('leaves min-age-seconds alone when it already exceeds the interval', () => {
    const md = 'reaper:\n  min-age-seconds: 120\n  min-scan-interval-seconds: 30\n';
    expect(_parseReaper(md)['min-age-seconds']).toBe(120);
  });
});

describe('_parseReaper — block boundaries', () => {
  it('finds the block OUTSIDE the ## Session Config section', () => {
    // Bug: a parser keyed on the Session Config section boundary silently reads
    // defaults for a repo that put the block anywhere else in CLAUDE.md.
    const md = [
      '# Project',
      '',
      '## Session Config',
      '',
      'test-command: npm test',
      '',
      '## Some other heading',
      '',
      'reaper:',
      '  enabled: true',
      '',
    ].join('\n');
    expect(_parseReaper(md).enabled).toBe(true);
  });

  it('stops at the next unindented line', () => {
    // Bug: a runaway block swallowing the NEXT top-level key's values.
    const md = [
      'reaper:',
      '  min-scan-interval-seconds: 45',
      'loop-guard:',
      '  window: 99',
      '',
    ].join('\n');
    const parsed = _parseReaper(md);
    expect(parsed['min-scan-interval-seconds']).toBe(45);
    expect(parsed['max-hook-latency-ms']).toBe(50);
  });
});
