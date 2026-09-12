/**
 * tests/lib/ux-grill/measures.test.mjs
 *
 * Contract tests for scripts/lib/ux-grill/measures.mjs (PRD
 * docs/prd/2026-09-12-ux-grill.md § 2 S2/S3, § 3 AC "Stufe 1").
 *
 * Each `it()` names the concrete bug it catches (test-value.md TV-001). The
 * expensive one is the eval-constant parity check: `TARGET_SIZE_EVAL` is a
 * SOURCE STRING that runs in the page and therefore cannot import the exported
 * thresholds — so the two copies can drift with nothing going red. The test
 * extracts the inlined literals and compares them against the exports.
 *
 * The last describe drives a real browser and is SKIPPED unless
 * `UX_GRILL_BROWSER_TESTS=1` (CI has no browser; agent-browser is a host tool).
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  TARGET_SIZE_FLOOR_PX,
  TARGET_SIZE_TARGET_PX,
  TARGET_SIZE_MAX_ENTRIES,
  SELECTOR_MAX_DEPTH,
  SELECTOR_MAX_LENGTH,
  INTERACTIVE_TARGET_SELECTOR,
  TARGET_SIZE_EVAL,
  classifyTargetSize,
  hasHorizontalOverflow,
  titleMatches,
  parseEvalOutput,
} from '../../../scripts/lib/ux-grill/measures.mjs';

/** @type {string[]} */
const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-grill-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

/**
 * Read one `const <NAME> = <int>;` literal out of the page-side eval source.
 * @param {string} name
 * @returns {number}
 */
function evalConstant(name) {
  const match = new RegExp(`\\bconst ${name} = (\\d+);`).exec(TARGET_SIZE_EVAL);
  if (match === null) throw new Error(`TARGET_SIZE_EVAL no longer inlines "const ${name} = <int>;"`);
  return Number(match[1]);
}

describe('ux-grill measures — eval/constant parity', () => {
  // Bug: the page script cannot import, so its 24/44/200/5/160 are a SECOND
  // copy of the exported thresholds. Changing one side (say the WCAG floor in
  // the exports) leaves the browser still measuring the old number, and every
  // node-side assertion stays green because it never reads the eval string.
  it.each([
    ['FLOOR', () => TARGET_SIZE_FLOOR_PX, 24],
    ['TARGET', () => TARGET_SIZE_TARGET_PX, 44],
    ['MAX_ENTRIES', () => TARGET_SIZE_MAX_ENTRIES, 200],
    ['MAX_DEPTH', () => SELECTOR_MAX_DEPTH, 5],
    ['MAX_SELECTOR', () => SELECTOR_MAX_LENGTH, 160],
  ])('inlines %s equal to the exported constant', (evalName, exported, expectedValue) => {
    expect(exported()).toBe(expectedValue);
    expect(evalConstant(evalName)).toBe(expectedValue);
  });

  // Bug: the selector population is the DENOMINATOR of every target-size count.
  // A hand-retyped copy inside the eval would silently measure a different set
  // of elements than INTERACTIVE_TARGET_SELECTOR documents.
  it('embeds the exported interactive selector verbatim', () => {
    expect(TARGET_SIZE_EVAL).toContain(`const SELECTOR = ${JSON.stringify(INTERACTIVE_TARGET_SELECTOR)};`);
    expect(INTERACTIVE_TARGET_SELECTOR).toContain('input:not([type=hidden])');
  });
});

describe('ux-grill classifyTargetSize', () => {
  // Bug (F13): rounding BEFORE classifying promotes a 23.6 px box to 24 px and
  // downgrades a `floor` violation (high) to `target` (medium) — or, at 43.6,
  // to no finding at all. The eval reports rounded numbers, so only the
  // classifier's own float handling stands between the measurement and a
  // wrong severity.
  it.each([
    [{ width: 23.9, height: 30 }, 'floor'],
    [{ width: 147, height: 20 }, 'floor'],
    [{ width: 23.6, height: 23.6 }, 'floor'],
    [{ width: 24, height: 24 }, 'target'],
    [{ width: 43.9, height: 44 }, 'target'],
    [{ width: 44, height: 44 }, null],
    [{ width: 60, height: 60 }, null],
    [{ width: Number.NaN, height: 44 }, null],
    [{ width: 44 }, null],
    [{}, null],
  ])('classifies %j as %s', (box, expected) => {
    expect(classifyTargetSize(box)).toBe(expected);
  });
});

describe('ux-grill hasHorizontalOverflow', () => {
  // Bug: a strict `scrollWidth > innerWidth` reports overflow for every page
  // whose layout rounds up by a subpixel — a medium finding per route per
  // viewport, on pages with no scrollbar at all. Dropping the tolerance
  // instead would hide nothing real (a scrollbar is several px wide), so the
  // 1281/1280 case is the one that must stay false.
  it.each([
    [{ scrollWidth: 2000, innerWidth: 1280 }, true],
    [{ scrollWidth: 1281, innerWidth: 1280 }, false],
    [{ scrollWidth: 1282, innerWidth: 1280 }, true],
    [{ scrollWidth: 1280, innerWidth: 1280 }, false],
    [{ scrollWidth: Number.NaN, innerWidth: 1280 }, false],
    [{ innerWidth: 1280 }, false],
  ])('reports %j as overflow=%s', (measure, expected) => {
    expect(hasHorizontalOverflow(measure)).toBe(expected);
  });
});

describe('ux-grill titleMatches', () => {
  // Bug: an uncompilable `title-pattern` is a MANIFEST defect. Throwing would
  // abort the whole route; returning `matched: false` would file a
  // `title-mismatch` finding against the page for the operator's typo. And an
  // absent pattern must never produce a finding at all.
  it.each([
    ['Dashboard — App', '^Dashboard', { ok: true, matched: true }],
    ['Dashboard — App', '^Documents$', { ok: true, matched: false }],
    ['Dashboard — App', '', { ok: true, matched: true }],
    ['Dashboard — App', undefined, { ok: true, matched: true }],
    [undefined, '^Dashboard', { ok: true, matched: false }],
    ['Dashboard — App', '(', { ok: false, reason: 'invalid-pattern' }],
    ['Dashboard — App', '[a-', { ok: false, reason: 'invalid-pattern' }],
  ])('title %j against pattern %j', (title, pattern, expected) => {
    expect(titleMatches(title, pattern)).toEqual(expected);
  });
});

describe('ux-grill parseEvalOutput', () => {
  // Bug: parsing only the LAST line of stdout (the habit from line-oriented
  // CLIs) reads `}` from agent-browser's pretty-printed multi-line output and
  // discards every measurement. Conversely, failing to unwrap the
  // double-encoded shape hands collect.mjs a STRING where it expects an object.
  it.each([
    ['a pretty-printed multi-line object', '{\n  "scrollWidth": 2000,\n  "innerWidth": 1280\n}\n',
      { ok: true, value: { scrollWidth: 2000, innerWidth: 1280 } }],
    ['a JSON-quoted string value', '"Dashboard"\n', { ok: true, value: 'Dashboard' }],
    ['a double-encoded JSON object', '"{\\"n\\":1}"', { ok: true, value: { n: 1 } }],
    ['non-JSON stdout, without throwing', 'Error: no page\n', { ok: false, raw: 'Error: no page\n' }],
    ['empty stdout', '', { ok: false, raw: '' }],
    ['whitespace-only stdout', '   \n', { ok: false, raw: '   \n' }],
    ['a non-string stdout', undefined, { ok: false, raw: '' }],
  ])('parses %s', (_label, stdout, expected) => {
    expect(parseEvalOutput(stdout)).toEqual(expected);
  });
});

/**
 * PRD § 3 AC "Stufe 1" fixture: a 147x20 button (floor), a 1x1 opacity-0
 * select behind a 200x40 custom trigger (must NOT be reported), a 30x30 link
 * (target) and a 60x60 control (compliant).
 */
const AC_FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ux-grill AC fixture</title>
<style>
  body { margin: 0; padding: 40px; font: 16px system-ui; }
  #cta { width: 147px; height: 20px; display: block; padding: 0; border: 0; }
  .custom-select { position: relative; width: 200px; height: 40px; border: 1px solid #333; }
  .custom-select select { position: absolute; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; }
  #small-link { display: block; width: 30px; height: 30px; background: #eee; }
  #big-button { width: 60px; height: 60px; }
</style></head>
<body>
  <button id="cta">Send</button>
  <div class="custom-select"><span>Pick one</span><select id="hidden-select"><option>a</option></select></div>
  <a id="small-link" href="#x">x</a>
  <button id="big-button">ok</button>
</body></html>`;

const browserTests = process.env.UX_GRILL_BROWSER_TESTS === '1';

describe.skipIf(!browserTests)('ux-grill TARGET_SIZE_EVAL in a real browser', () => {
  // Bug: every exclusion in the eval (opacity-0 ancestor walk, the 1x1
  // select-behind-a-trigger idiom, elementFromPoint coverage) is page-API
  // behaviour that no node-side unit test can exercise. A regression there
  // either files a finding for an invisible native control (noise on every
  // route with a custom select) or drops a real undersized target.
  it('reports exactly the floor + target violations of the PRD AC fixture', () => {
    const dir = makeTmpDir();
    const page = path.join(dir, 'ac-fixture.html');
    fs.writeFileSync(page, AC_FIXTURE_HTML, 'utf8');
    const session = `uxgrill-test-${process.pid}`;
    const run = (args) => execFileSync('agent-browser', ['--session', session, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });

    let stdout;
    try {
      run(['set', 'viewport', '1440', '900']);
      run(['open', `file://${page}`]);
      stdout = run(['eval', TARGET_SIZE_EVAL]);
    } finally {
      try {
        run(['close']);
      } catch {
        /* closing a session that never opened is not a test failure */
      }
    }

    const parsed = parseEvalOutput(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.value.truncated).toBe(false);

    const byTag = parsed.value.targets.map((t) => [t.tag, t.verdict, t.width, t.height]);
    expect(byTag).toEqual([
      ['button', 'floor', 147, 20],
      ['a', 'target', 30, 30],
    ]);
    // The 1x1 opacity-0 select must not even be COUNTED in the denominator.
    expect(parsed.value.targets.some((t) => t.tag === 'select')).toBe(false);
    expect(parsed.value.scanned).toBe(3);
  }, 120_000);
});
