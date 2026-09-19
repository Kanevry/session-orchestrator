/**
 * js-mask.test.mjs — the CONTRACT of the shared lexer `maskSource`
 * (`scripts/lib/js-mask.mjs`), which five scanners delegate their
 * "separate CODE from DATA" step to (#1388).
 *
 * WHY THIS FILE EXISTS (QA REFUTE panel, mutation-based, 2026-09-18): the
 * lexer had no test of its own. Mutating its regex-literal branch to "every
 * `/` is division" (`startsRegex = false`) left `check-validator-registration`,
 * `check-test-git-config-target` and `auq/parse` green — only three cases in
 * two OTHER files died. A shared primitive whose consumers' tests are its only
 * cover is a primitive whose contract nobody states.
 *
 * Every case below names the bug it catches; the regex-branch cases are the
 * ones verified to go RED under that mutant.
 */

import { describe, it, expect } from 'vitest';
import { maskSource } from '@lib/js-mask.mjs';

describe('maskSource — offset + newline preservation', () => {
  // bug_caught: a masker that DELETES instead of blanking shifts every byte
  // offset after the first comment, so a consumer reporting `file:line` (or
  // substring-matching across the seam two deleted fragments now touch) points
  // at the wrong place. Length equality is the property every consumer assumes.
  it('returns a string of the same length as its input', () => {
    const src = "const a = 'hidden'; // trailing\n/* block */ const b = `tpl`;\n";
    expect(maskSource(src)).toHaveLength(src.length);
  });

  // bug_caught: blanking a newline inside a block comment or a multi-line
  // template collapses the line numbering of everything below it — a validator
  // that reports line numbers would then be silently off by the comment's
  // height.
  it('keeps every newline at its original offset', () => {
    const src = '/* one\ntwo\nthree */\ncode();\n';
    const masked = maskSource(src);
    const nlOffsets = (text) => [...text].flatMap((ch, i) => (ch === '\n' ? [i] : []));
    expect(nlOffsets(masked)).toEqual(nlOffsets(src));
  });
});

describe('maskSource — keepLiterals', () => {
  // bug_caught: the default mode is what separates CODE from DATA. A test
  // fixture embedded in a template literal must not be scanned as though it
  // were the scanning file's own body (`check-untracked-test-deps.mjs`).
  it('blanks string, template and regex INTERIORS by default, keeping the delimiters', () => {
    expect(maskSource("const s = 'abc';")).toBe("const s = '   ';");
    expect(maskSource('const t = `abc`;')).toBe('const t = `   `;');
    expect(maskSource('const r = /abc/;')).toBe('const r = /   /;');
  });

  // bug_caught: `check-entry-guard.mjs` must see `endsWith('x.mjs')` and
  // `${process.argv[1]}` VERBATIM (#1383). A keepLiterals mode that still
  // blanked literal interiors would make that guard blind while every
  // structural assertion about it stayed green.
  it('with keepLiterals:true leaves literal interiors intact and blanks ONLY comments', () => {
    const src = "endsWith('x.mjs'); // endsWith('y.mjs')\n";
    // The comment is 20 characters wide and becomes 20 spaces; the literal
    // before it survives byte-for-byte.
    expect(maskSource(src, { keepLiterals: true })).toBe(
      `endsWith('x.mjs'); ${' '.repeat(20)}\n`,
    );
  });

  // bug_caught: recognition must not depend on the mode. A `//` inside a kept
  // string that is read as a comment start truncates the rest of the line —
  // the URL case `'https://example.test/check-b.mjs'`.
  it('with keepLiterals:true still recognises literals, so a `//` inside a string is not a comment', () => {
    const src = "const url = 'https://example.test/check-b.mjs';\n";
    expect(maskSource(src, { keepLiterals: true })).toBe(src);
  });
});

describe('maskSource — the three named ceilings (BV-004)', () => {
  // bug_caught: an unterminated string that ran past its line would blank the
  // rest of the file's code — a validator falling silent. The module documents
  // the EOL bail; nothing asserted it.
  it('bails an unterminated string at end-of-line, leaving the next line as code', () => {
    const src = "const a = 'oops\nconst b = 2;\n";
    const masked = maskSource(src);
    expect(masked).toContain('const b = 2;');
    expect(masked).toHaveLength(src.length);
  });

  // bug_caught: the documented direction of the unterminated-`/*` ceiling is
  // fail-toward-REPORTING. The old unbounded blank hid every guard below a
  // lexer desync; if someone restores it, this case goes red instead of the
  // whole suite staying quietly green.
  it('does NOT treat an UNTERMINATED `/*` as a comment — the rest of the file stays code', () => {
    const src = '/* never closed\nrunCheck("check-foo.mjs");\n';
    const masked = maskSource(src, { keepLiterals: true });
    expect(masked).toContain('check-foo.mjs');
    expect(masked).toHaveLength(src.length);
  });

  // bug_caught: without the one-token keyword lookback, `return /\/*$/` is read
  // as a division and its `/*` reaches the block-comment branch — the exact
  // #1388 defect. The lookback is exactly ONE token; this pins that it exists.
  it('reads `/` after a keyword (`return`) as a regex, not a division', () => {
    expect(maskSource('return /abc/;')).toBe('return /   /;');
  });

  // bug_caught (the OTHER side of the same ceiling): the lookback must not
  // swallow a genuine division chain, and a `/` after an identifier or a `)`
  // is division. Reading it as a regex would blank real code up to the next
  // `/` on the line.
  it('reads `/` after an identifier or `)` as division, blanking nothing', () => {
    expect(maskSource('const x = a / b / c;')).toBe('const x = a / b / c;');
    expect(maskSource('const y = f(1) / 2;')).toBe('const y = f(1) / 2;');
  });
});

describe('maskSource — the regex-literal branch', () => {
  // bug_caught (all four): `startsRegex` keys on the previous significant
  // token. Drop any of these preceding-token cases and a regex body is scanned
  // as CODE — a `/*` in it opens a block comment (the #1388 false
  // UNREGISTERED), a quote in it opens a string that eats the line. Each of
  // these four goes RED under the "every `/` is division" mutant.
  it.each([
    ['after `=`', 'const re = /abc/;', 'const re = /   /;'],
    ['after `(`', 'test(/abc/);', 'test(/   /);'],
    ['after `return`', 'return /abc/;', 'return /   /;'],
    ['after `,`', 'f(x, /abc/);', 'f(x, /   /);'],
  ])('recognises a regex literal %s', (_label, src, expected) => {
    expect(maskSource(src)).toBe(expected);
  });

  // bug_caught: THE motivating defect. `/\/*$/` carries a `/*` in its body; if
  // the regex branch misses it, that `/*` pairs with the next `*/` in the file
  // and blanks everything between — in `scripts/validate-plugin.mjs` that is
  // every `runCheck(...)` below the regex, i.e. a false UNREGISTERED for every
  // checker registered after it.
  it('does not let `/\\/*$/` open a block comment that swallows the code below it', () => {
    const src = 'const re = /\\/*$/;\nrunCheck("check-foo.mjs");\n/** doc */\n';
    const masked = maskSource(src, { keepLiterals: true });
    expect(masked).toContain('runCheck("check-foo.mjs");');
    expect(masked).toHaveLength(src.length);
  });

  // bug_caught: a quote inside a regex body read as a string opener swallows
  // up to the next quote — the AUQ false-negative class (the swallowed region
  // no longer contained `(Recommended)`).
  it('does not let a quote inside a regex body open a string', () => {
    const src = "const re = /'/;\nconst s = 'kept';\n";
    // Correct lexing blanks the regex body and, separately, the string body.
    // A quote read as a string opener instead spans from the regex to the
    // string's opening quote and blanks the code between them.
    expect(maskSource(src)).toBe("const re = / /;\nconst s = '    ';\n");
  });

  // bug_caught: an UNCLOSED `/` must stay division rather than blanking to the
  // line end — the same-line bound is what keeps a misread division from
  // eating the file.
  it('leaves a `/` with no closing `/` on the same line as ordinary source', () => {
    expect(maskSource('const q = (a) / b;\nkeep();\n')).toBe('const q = (a) / b;\nkeep();\n');
  });
});
