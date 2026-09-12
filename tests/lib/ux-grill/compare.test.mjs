/**
 * tests/lib/ux-grill/compare.test.mjs
 *
 * Contract tests for `scripts/lib/ux-grill/compare.mjs`. The headline case is a
 * WIRING test (test-value.md TV-005): `collect()` writes `findings.jsonl` and
 * the run-record ledger with its OWN `fs` calls, while `compare` reads both
 * through `run-record.mjs`. A divergence in path or line shape makes every
 * previous finding invisible and reports the whole baseline as `fixed` — an
 * unchanged app would read as "everything resolved". So the test drives the
 * REAL `collect()` twice rather than hand-writing fixtures.
 *
 * The remaining cases are the classification rule itself: a previous finding
 * whose scope THIS run skipped must never be `fixed` (an outage read as a
 * resolved issue).
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareRuns } from '../../../scripts/lib/ux-grill/compare.mjs';
import { collect } from '../../../scripts/lib/ux-grill/collect.mjs';
import {
  OVERFLOW_EVAL,
  TARGET_SIZE_EVAL,
  VIEWPORT_WIDTH_EVAL,
} from '../../../scripts/lib/ux-grill/measures.mjs';
import { findingsPath, runRecordPath } from '../../../scripts/lib/ux-grill/paths.mjs';

/** @type {string[]} */
const tmpDirs = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-grill-compare-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const BASE_URL = 'http://127.0.0.1:4311';
const RUBRIC_HASH = 'rubric-hash-abc';
const MANIFEST_HASH = 'manifest-hash-xyz';

/** Two axe rules violated on ONE selector — two findings, stable across runs. */
const TWO_RULES_ONE_SELECTOR = {
  counts: { violations: 2 },
  violations: [
    {
      id: 'color-contrast',
      impact: 'serious',
      help: 'Elements must have sufficient colour contrast',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.9/color-contrast',
      tags: ['wcag2aa'],
      nodeCount: 1,
      nodes: [{ target: ['#cta'], html: '<button id="cta">', failureSummary: 'fix contrast' }],
    },
    {
      id: 'button-name',
      impact: 'critical',
      help: 'Buttons must have discernible text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.9/button-name',
      tags: ['wcag2a'],
      nodeCount: 1,
      nodes: [{ target: ['#cta'], html: '<button id="cta">', failureSummary: 'add a name' }],
    },
  ],
};

const envelope = (data) => `${JSON.stringify({ success: true, data, error: null })}\n`;

/** The measured `agent-browser --json` envelope shape (v0.37.1, 2026-09-12). */
function makeExec() {
  return async (args) => {
    const [a0, a1] = args;
    if (a0 === 'session' && a1 === 'id') return { stdout: '', stderr: '', code: 1 };
    if (a0 === 'close') return { stdout: '', stderr: '', code: 0 };
    if (a0 === 'set') return { stdout: '', stderr: '', code: 0 };
    if (a0 === 'open') return { stdout: '', stderr: '', code: 0 };
    if (a0 === 'errors' && a1 === '--clear') return { stdout: '', stderr: '', code: 0 };
    if (a0 === 'errors') return { stdout: envelope({ errors: [] }), stderr: '', code: 0 };
    if (a0 === 'get' && a1 === 'title') return { stdout: envelope({ title: 'Home' }), stderr: '', code: 0 };
    if (a0 === 'get' && a1 === 'url') return { stdout: envelope({ url: `${BASE_URL}/` }), stderr: '', code: 0 };
    if (a0 === 'get') return { stdout: '', stderr: '', code: 0 };
    if (a0 === 'a11y') return { stdout: envelope(TWO_RULES_ONE_SELECTOR), stderr: '', code: 0 };
    if (a0 === 'eval') {
      const script = String(a1);
      if (script === VIEWPORT_WIDTH_EVAL) return { stdout: envelope({ result: 1440 }), stderr: '', code: 0 };
      if (script === TARGET_SIZE_EVAL) {
        return { stdout: envelope({ result: { targets: [], scanned: 0, truncated: false } }), stderr: '', code: 0 };
      }
      if (script === OVERFLOW_EVAL) {
        return {
          stdout: envelope({ result: { scrollWidth: 1440, innerWidth: 1440, bodyScrollWidth: 1440 } }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: envelope({ result: null }), stderr: '', code: 0 };
    }
    if (a0 === 'screenshot') {
      fs.writeFileSync(String(a1), 'PNG-STUB', 'utf8');
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}

const MANIFEST = {
  manifestHash: MANIFEST_HASH,
  frontmatter: {
    build: 'prod',
    'base-url': BASE_URL,
    viewports: [{ name: 'desktop', viewport: '1440x900' }],
    routes: [{ path: '/' }],
    journeys: [],
    personas: [],
  },
};

const runCollect = (repoRoot, runId, iso) =>
  collect({
    repoRoot,
    manifest: MANIFEST,
    envMap: new Map(),
    rubricHash: RUBRIC_HASH,
    exec: makeExec(),
    runId,
    now: () => new Date(iso),
  });

/** Write a `findings.jsonl` for a run without going through `collect()`. */
function seedFindings(repoRoot, runId, lines) {
  const file = findingsPath(repoRoot, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
}

/** Append raw ledger lines. */
function seedLedger(repoRoot, lines) {
  const ledger = runRecordPath(repoRoot);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.appendFileSync(ledger, `${lines.join('\n')}\n`, 'utf8');
}

const previousFinding = {
  scope: 'ux-grill',
  checkId: 'axe-color-contrast',
  locator: '/a|desktop|#cta',
  severity: 'high',
  provisional: false,
  fingerprint: 'aaaaaaaaaaaaaaaa',
  message: 'contrast',
  evidence: {},
};

describe('compareRuns() — end-to-end against the writer collect() actually uses', () => {
  it('classifies an unchanged second run as all-persisting and patches its ledger record', async () => {
    const repoRoot = makeRepo();
    const first = await runCollect(repoRoot, '1757635200000-aaaaaa', '2026-09-12T10:00:00.000Z');
    const second = await runCollect(repoRoot, '1757635300000-bbbbbb', '2026-09-12T10:01:00.000Z');

    expect(first.findings).toHaveLength(2);
    expect(second.findings).toHaveLength(2);

    const result = compareRuns({
      repoRoot,
      runId: second.runId,
      manifestHash: MANIFEST_HASH,
      build: 'prod',
      rubricHash: RUBRIC_HASH,
    });

    expect(result.previousRunId).toBe('1757635200000-aaaaaa');
    expect(result.baseline).toBe(false);
    expect(result.rubricChanged).toBe(false);
    expect(result.counts).toEqual({ new: 0, persisting: 2, fixed: 0 });
    expect(result.fixed).toEqual([]);
    expect(result.new).toEqual([]);
    expect(result.unmeasured).toEqual([]);
    expect(result.recordUpdated).toBe(1);
    expect(result.skippedLines).toEqual({ current: 0, previous: 0, ledger: 0 });

    const ledgerLines = fs
      .readFileSync(runRecordPath(repoRoot), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(ledgerLines).toHaveLength(2);
    expect(ledgerLines[0].run_id).toBe('1757635200000-aaaaaa');
    expect(ledgerLines[0].compare).toEqual({ new: 0, persisting: 0, fixed: 0 });
    expect(ledgerLines[1].run_id).toBe('1757635300000-bbbbbb');
    expect(ledgerLines[1].compare).toEqual({ new: 0, persisting: 2, fixed: 0 });
  });
});

describe('compareRuns() — a skipped scope is never `fixed`', () => {
  const cases = [
    {
      name: 'route:<path>|<viewport> — the route-unreachable shape',
      locator: '/a|desktop|#cta',
      skipped: [{ what: 'route:/a|desktop', reason: 'route-unreachable' }],
    },
    {
      name: 'viewport:<vp> — the device-mismatch shape',
      locator: '/a|mobile|#cta',
      skipped: [{ what: 'viewport:mobile', reason: 'device-mismatch' }],
    },
    {
      name: 'journey:<name> — all viewports',
      locator: 'journey|desktop|checkout',
      skipped: [{ what: 'journey:checkout', reason: 'route-unreachable' }],
    },
    {
      name: 'bare <path>|<vp>|<call> — the measure-failed shape',
      locator: '/a|desktop|#cta',
      skipped: [{ what: '/a|desktop|eval:target-size', reason: 'measure-failed' }],
    },
  ];

  it.each(cases)('moves a previous finding to `unmeasured` for $name', ({ locator, skipped }) => {
    const repoRoot = makeRepo();
    seedFindings(repoRoot, 'prev-1', [JSON.stringify({ ...previousFinding, locator })]);
    seedFindings(repoRoot, 'curr-1', []);
    seedLedger(repoRoot, [
      JSON.stringify({ run_id: 'prev-1', manifest_hash: MANIFEST_HASH, build: 'prod', rubric_hash: RUBRIC_HASH }),
      JSON.stringify({ run_id: 'curr-1', manifest_hash: MANIFEST_HASH, build: 'prod', rubric_hash: RUBRIC_HASH }),
    ]);

    const result = compareRuns({
      repoRoot,
      runId: 'curr-1',
      manifestHash: MANIFEST_HASH,
      build: 'prod',
      rubricHash: RUBRIC_HASH,
      skipped,
    });

    expect(result.fixed).toEqual([]);
    expect(result.counts.fixed).toBe(0);
    expect(result.unmeasured).toHaveLength(1);
    expect(result.unmeasured[0].fingerprint).toBe('aaaaaaaaaaaaaaaa');
  });

  it('still reports `fixed` when the skip names an unrelated scope', () => {
    const repoRoot = makeRepo();
    seedFindings(repoRoot, 'prev-1', [JSON.stringify(previousFinding)]);
    seedFindings(repoRoot, 'curr-1', []);
    seedLedger(repoRoot, [
      JSON.stringify({ run_id: 'prev-1', manifest_hash: MANIFEST_HASH, build: 'prod', rubric_hash: RUBRIC_HASH }),
      JSON.stringify({ run_id: 'curr-1', manifest_hash: MANIFEST_HASH, build: 'prod', rubric_hash: RUBRIC_HASH }),
    ]);

    const result = compareRuns({
      repoRoot,
      runId: 'curr-1',
      manifestHash: MANIFEST_HASH,
      build: 'prod',
      rubricHash: RUBRIC_HASH,
      skipped: [{ what: 'route:/other|desktop', reason: 'route-unreachable' }],
    });

    expect(result.unmeasured).toEqual([]);
    expect(result.counts.fixed).toBe(1);
    expect(result.fixed[0].fingerprint).toBe('aaaaaaaaaaaaaaaa');
  });
});

describe('compareRuns() — dropped-line accounting', () => {
  it('surfaces a corrupt line in the PREVIOUS findings file instead of counting it as fixed', () => {
    const repoRoot = makeRepo();
    seedFindings(repoRoot, 'prev-1', [JSON.stringify(previousFinding), '{"fingerprint":']);
    seedFindings(repoRoot, 'curr-1', []);
    seedLedger(repoRoot, [
      JSON.stringify({ run_id: 'prev-1', manifest_hash: MANIFEST_HASH, build: 'prod', rubric_hash: RUBRIC_HASH }),
      JSON.stringify({ run_id: 'curr-1', manifest_hash: MANIFEST_HASH, build: 'prod', rubric_hash: RUBRIC_HASH }),
    ]);

    const result = compareRuns({
      repoRoot,
      runId: 'curr-1',
      manifestHash: MANIFEST_HASH,
      build: 'prod',
      rubricHash: RUBRIC_HASH,
    });

    expect(result.skippedLines.previous).toBe(1);
    expect(result.skippedLines.current).toBe(0);
    expect(result.skippedLines.ledger).toBe(0);
    expect(result.counts.fixed).toBe(1);
  });
});
