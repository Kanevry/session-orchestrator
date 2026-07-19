/**
 * hostpaths-guard.test.mjs — meta-test pinning the #783 hostPaths-omission
 * hardening (issue #829 Finding 1 recurrence prevention).
 *
 * mirrorBoard / sweepBoard / mirrorNarrative all read Session Config via
 * parseSessionConfig's `hostPaths` DI seam. Omitting `hostPaths` in a test
 * call falls back to the REAL host `owner.yaml`, whose `paths.vault-dir`
 * override (if set) silently wins over the fixture's committed vault-dir and
 * can write into the operator's REAL vault (#783 incident). Every sibling
 * test file in this directory was hardened to always pass an explicit
 * `hostPaths` ctx — this file mechanically PINS that hardening so a future
 * test added to this directory without `hostPaths` fails CI instead of
 * silently reintroducing the leak.
 *
 * HEURISTIC (documented, deliberately simple — not a JS parser):
 *   1. Scan each sibling `*.test.mjs` file's raw source (this file excluded)
 *      for every occurrence of `mirrorBoard(`, `sweepBoard(`, or
 *      `mirrorNarrative(` (word-boundary exact match).
 *   2. A match only counts as a CALL SITE when the first non-whitespace
 *      character after the `(` is `{` — every real call in this suite passes
 *      a single opts object, so this filters out prose mentions like a bare
 *      `` `mirrorBoard()` `` inside a comment (no `{` follows) while still
 *      catching a comment that happens to quote a full call with braces
 *      (e.g. `` `mirrorBoard({ ..., hostPaths })` `` — which itself contains
 *      `hostPaths`, so it passes trivially either way).
 *   3. From that `{`, extract the brace-BALANCED span up to its matching
 *      `}` (nested `{ }` — e.g. a `deps: { ... }` sub-object — are handled by
 *      depth-counting; characters inside a `'`, `"`, or `` ` `` string are
 *      skipped so a stray brace in a string literal can never desync the
 *      count). NOTE: this does not special-case `${…}` template-literal
 *      interpolation — no current call site in this directory uses one; if a
 *      future call site does, re-verify this heuristic before trusting it.
 *   4. Assert the extracted span contains the literal substring `hostPaths`.
 *
 * This is a pragmatic text-scan, not a JS parser — it is scoped to this one
 * directory's known call shapes on purpose (see `.claude/rules/testing.md`
 * "Dynamic Artifact Counts" — this is a fixed, enumerable file set, not a
 * growing catalog, so exact per-file/per-function assertions are correct
 * here rather than a floor/ceiling).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF_FILENAME = 'hostpaths-guard.test.mjs';
const TARGET_FUNCTIONS = ['mirrorBoard', 'sweepBoard', 'mirrorNarrative'];

/**
 * Extract a brace-balanced `{ ... }` span starting at `openIdx` (the index of
 * the opening `{` in `text`). String-literal-aware: characters inside a `'`,
 * `"`, or `` ` `` string (with backslash-escape handling) never contribute to
 * the depth count. Returns the substring from `openIdx` through the matching
 * closing `}` inclusive, or `null` if the braces never balance before the end
 * of the text (should not happen for syntactically valid JS source).
 *
 * @param {string} text
 * @param {number} openIdx
 * @returns {string|null}
 */
function extractBalancedBraces(text, openIdx) {
  let depth = 0;
  let inString = null; // one of "'", '"', '`', or null when not in a string
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++; // skip the escaped character entirely
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

/**
 * Find every `functionName(` call site in `source` whose argument is an
 * object literal (first non-whitespace char after `(` is `{`) and return the
 * balanced `{ ... }` argument span for each. See the module doc for the full
 * heuristic rationale.
 *
 * @param {string} source
 * @param {string} functionName
 * @returns {string[]}
 */
function findCallArgSpans(source, functionName) {
  const spans = [];
  const re = new RegExp(`\\b${functionName}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length;
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== '{') continue; // no object-literal argument — not a tracked call site
    const span = extractBalancedBraces(source, i);
    if (span) spans.push(span);
  }
  return spans;
}

describe('hostPaths-omission guard (#829 Finding 1 recurrence prevention)', () => {
  const testFiles = readdirSync(__dirname).filter(
    (f) => f.endsWith('.test.mjs') && f !== SELF_FILENAME,
  );

  it('found at least one sibling test file to scan (a guard scanning zero files proves nothing)', () => {
    expect(testFiles.length).toBeGreaterThan(0);
  });

  for (const file of testFiles) {
    for (const fn of TARGET_FUNCTIONS) {
      it(`every ${fn}(...) call site in ${file} passes an explicit hostPaths key`, () => {
        const source = readFileSync(join(__dirname, file), 'utf8');
        const spans = findCallArgSpans(source, fn);
        const offenders = spans.filter((span) => !span.includes('hostPaths'));
        expect(offenders).toEqual([]);
      });
    }
  }
});
