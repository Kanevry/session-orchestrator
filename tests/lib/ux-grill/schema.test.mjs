/**
 * tests/lib/ux-grill/schema.test.mjs
 *
 * Contract tests for scripts/lib/ux-grill/{schema,paths}.mjs.
 *
 * Each test names the concrete bug it catches (test-value.md TV-001):
 *   1. An implementer hashing the whole finding record would make the
 *      fingerprint depend on build/severity/message — the same violation would
 *      then read as `new` on every dev→prod switch, and compare.mjs could never
 *      report `persisting`. Also pins provisional=true for dev target-size.
 *   2. A run id reaches path.join unescaped; `../x` would write artifacts
 *      outside the run directory (path traversal).
 *   3. Emitting the catalogue id `axe-violations` instead of `axe-<ruleId>`
 *      would collapse two axe rules on one selector into one finding.
 *   4. `makeRunRecord()` validates `skipped[].reason` against its own view of
 *      the reason set. An implementer adding a SKIP_REASONS constant while that
 *      validator keeps a separate list produces a collect() run that throws on
 *      the very skip it just learned to record — green in schema.mjs, red only
 *      in a real run.
 *
 * Expected fingerprint literal is pre-computed externally; the test never
 * mirrors production hashing logic.
 */

import { describe, it, expect } from 'vitest';

import { makeFinding, makeRunRecord, CHECK_IDS, SKIP_REASONS } from '../../../scripts/lib/ux-grill/schema.mjs';
import { runDirPath } from '../../../scripts/lib/ux-grill/paths.mjs';

const LOCATOR = '/dashboard|mobile|button.cta';

describe('ux-grill schema/paths contract', () => {
  it('fingerprints only scope+checkId+locator, and flags dev target-size findings provisional', () => {
    const dev = makeFinding({
      checkId: CHECK_IDS.TARGET_SIZE_FLOOR,
      locator: LOCATOR,
      severity: 'high',
      build: 'dev',
      message: 'button is 147x20 CSS px',
    });
    const prod = makeFinding({
      checkId: CHECK_IDS.TARGET_SIZE_FLOOR,
      locator: LOCATOR,
      severity: 'low',
      build: 'prod',
      message: 'entirely different message',
      evidence: { widthPx: 147 },
    });

    expect(dev.provisional).toBe(true);
    expect(prod.provisional).toBe(false);
    expect(dev.fingerprint).toBe('62906eec23be4923');
    expect(prod.fingerprint).toBe(dev.fingerprint);
  });

  it('rejects a traversing run id in runDirPath', () => {
    expect(() => runDirPath('/tmp/repo', '../x')).toThrow(TypeError);
    expect(() => runDirPath('/tmp/repo', 'a/b')).toThrow(TypeError);
    expect(runDirPath('/tmp/repo', '1757635200123-9f3a01')).toBe(
      '/tmp/repo/.orchestrator/metrics/ux-grill/1757635200123-9f3a01',
    );
  });

  it('rejects the catalogue id axe-violations as an emitted checkId', () => {
    expect(() =>
      makeFinding({
        checkId: CHECK_IDS.AXE_VIOLATIONS,
        locator: LOCATOR,
        severity: 'high',
        build: 'prod',
      }),
    ).toThrow(/axe-<ruleId>/);

    const ok = makeFinding({
      checkId: 'axe-color-contrast',
      locator: LOCATOR,
      severity: 'high',
      build: 'prod',
    });
    expect(ok.checkId).toBe('axe-color-contrast');
    expect(ok.provisional).toBe(false);
  });

  // Bug (LOW-5): makeFinding validated newline/CR/NUL in `locator` two lines
  // below and NOTHING in `checkId`, although checkId is fingerprint input and
  // is rendered into JSONL lines and issue bodies — one newline splits one
  // record into two. reconcile.oneLine() contained it downstream; the
  // constructor is where the rejection belongs.
  it('rejects a checkId carrying newline, CR or NUL', () => {
    for (const bad of ['axe-a\nb', 'axe-a\rb', 'axe-a\0b']) {
      expect(() =>
        makeFinding({ checkId: bad, locator: LOCATOR, severity: 'high', build: 'prod' }),
      ).toThrow(/checkId must not contain newline/);
    }
  });

  it('accepts every SKIP_REASONS value in makeRunRecord — including measure-failed', () => {
    expect(SKIP_REASONS.MEASURE_FAILED).toBe('measure-failed');

    const record = makeRunRecord({
      runId: '1757635200123-9f3a01',
      manifestHash: 'a'.repeat(64),
      rubricHash: 'b'.repeat(64),
      build: 'prod',
      skipped: Object.values(SKIP_REASONS).map((reason) => ({ what: `x|y|${reason}`, reason })),
    });
    expect(record.skipped).toHaveLength(Object.values(SKIP_REASONS).length);
    expect(record.skipped.map((entry) => entry.reason)).toContain('measure-failed');

    expect(() =>
      makeRunRecord({
        runId: '1757635200123-9f3a01',
        manifestHash: 'a'.repeat(64),
        rubricHash: 'b'.repeat(64),
        build: 'prod',
        skipped: [{ what: 'x|y|z', reason: 'measure-fialed' }],
      }),
    ).toThrow(TypeError);
  });
});
