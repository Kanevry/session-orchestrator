// js-mask.mjs — ONE JavaScript lexer for every "blank the comments / separate
// code from data" scanner in this repo.
//
// WHY IT LIVES HERE. `maskSource` grew inside
// `scripts/lib/validate/check-untracked-test-deps.mjs`, where it is used to
// separate CODE from DATA. Three OTHER modules had hand-rolled
// `stripComments` copies with NO regex-literal branch, and each one was
// measurably wrong for the same input shape (`/\/*$/` — a regex whose body
// contains `/*`), measured 2026-09-18 @ 20a4cbff:
//   - `check-validator-registration.mjs` — the regex's `/*` opened a block
//     comment that swallowed the rest of the surface text → a FALSE
//     "UNREGISTERED" finding.
//   - `check-test-git-config-target.mjs` — same swallow inside a call tail →
//     `wrapperHasCwd` returned false → a false alarm.
//   - `auq/parse.mjs` — the swallowed region no longer contained
//     `(Recommended)` → a silent FALSE NEGATIVE in the AUQ clarity measurement.
// One lexer, five consumers: the regex branch and its three named ceilings are
// maintained once.
//
// Import-safety: importing this module executes nothing.

/**
 * Keywords after which a `/` opens a REGEX LITERAL, never a division. The
 * single-character `prev` below cannot tell `return /x/` from `n / x`, because
 * the character it sees (`n`) is a word character in both. This set is the
 * one-token lookback that closes the difference; it is deliberately the usual
 * short list rather than a parser (BV-001.6/BV-004 — a full expression parser
 * for a masker is the abstraction this file exists to avoid).
 *
 * Named ceiling (BV-004), in the other direction: a genuine DIVISION CHAIN after
 * one of these words (`return a / b / c`) is now read as a regex and its middle
 * blanked. Measured 2026-09-18 over `git ls-files '*.mjs'` (1245 files): 0
 * occurrences — all 18 files whose masking this lookback changes carry a real
 * `return /…/` literal. REVISIT TRIGGER: the first such division chain.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'yield',
  'await', 'instanceof', 'do', 'else',
]);

/** Word characters, for the one-token lookback above. */
const WORD_CHAR_RE = /[A-Za-z0-9_$]/;

/**
 * Blank out the INTERIOR of every string literal, template literal, comment and
 * regex literal, preserving byte offsets and newlines. Delimiters are kept so
 * paren/comma balance and identifier boundaries survive.
 *
 * This is what separates CODE from DATA. A test that embeds fixture source in a
 * template literal (`check-untracked-test-deps.mjs`'s own test file does) must
 * not be scanned as though that fixture were its own body — masking makes that
 * structural instead of relying on a self-exemption marker.
 *
 * With `keepLiterals: true` only COMMENTS are blanked: string, template and
 * regex literals are still recognised (so a `//` or `/*` inside one is never read
 * as a comment, and a quote inside a regex never opens a string) but their
 * contents stay intact. `check-entry-guard.mjs` needs exactly that — it must see
 * `endsWith('x.mjs')` and `${process.argv[1]}` verbatim (#1383) — and it is the
 * mode the three `stripComments` consumers delegate in (#1388).
 *
 * @param {string} text
 * @param {{ keepLiterals?: boolean }} [options]
 * @returns {string} same-length masked source
 */
export function maskSource(text, { keepLiterals = false } = {}) {
  const out = text.split('');
  const n = out.length;
  let i = 0;
  // Last significant (non-space) char before `i`, and its offset, used for the
  // regex/division disambiguation below (the offset carries the one-token
  // keyword lookback).
  let prev = '';
  let prevIdx = -1;

  /** The whole word ending at `idx`, or '' when `idx` is not a word char. */
  const wordEndingAt = (idx) => {
    if (idx < 0 || !WORD_CHAR_RE.test(text[idx])) return '';
    let k = idx;
    while (k > 0 && WORD_CHAR_RE.test(text[k - 1])) k--;
    return text.slice(k, idx + 1);
  };

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Literal interiors go through this one; comments always use `blank`.
  const blankLiteral = keepLiterals ? () => {} : blank;

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    // Line comment.
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    // Block comment — ONLY when it is actually closed.
    //
    // Named ceiling (BV-004), replacing an unbounded blank: an UNTERMINATED
    // `/*` used to blank everything to EOF. In valid source that shape is a
    // syntax error, so in practice it only ever arises from a lexer desync —
    // a `/*` inside a regex literal the branch below failed to recognise
    // (`return /\/*$/`). Blanking the rest of the file then hides every guard
    // under it, which is a validator falling SILENT. The direction is therefore
    // chosen fail-toward-REPORTING: an unclosed `/*` is not a comment at all,
    // and the few bytes of a genuine one get scanned as code — at worst that
    // produces a finding a human dismisses, never a silent pass.
    // REVISIT TRIGGER: a tracked file that legitimately ends inside an
    // unterminated block comment (i.e. the moment `node --check` accepts one).
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      if (j < n) {
        blank(i, j + 2);
        i = j + 2;
        continue;
      }
      // Unterminated — fall through and treat the `/` as ordinary source.
    }
    // Single/double-quoted string — keep the quotes, blank the interior.
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        if (text[j] === '\n') break; // unterminated — bail at EOL
        j++;
      }
      blankLiteral(i + 1, j);
      i = Math.min(j + 1, n);
      prev = c;
      prevIdx = i - 1;
      continue;
    }
    // Template literal — blank everything including `${…}` substitutions.
    if (c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') j++;
        j++;
      }
      blankLiteral(i + 1, j);
      i = Math.min(j + 1, n);
      prev = c;
      prevIdx = i - 1;
      continue;
    }
    // Regex literal — only when the previous significant TOKEN cannot end an
    // expression, AND a closing unescaped `/` exists on the SAME line. The
    // same-line bound keeps a misread division from swallowing the file.
    //
    // The token is either the single char `prev`, or — when that char is a word
    // character — the whole word ending at it, checked against
    // REGEX_PRECEDING_KEYWORDS. Without that lookback `return /\/*$/` read as a
    // division and its `/*` reached the block-comment branch above, which blanked
    // the rest of the file: a validator silently passing (measured 2026-09-18).
    //
    // Named ceiling (BV-004): the lookback is exactly ONE token. A regex after
    // any other non-expression-ending context — a `)` that closes `if (…)`, a
    // statement label, `function` — is still read as division and its body
    // scanned as code. That desync is now bounded on BOTH sides: a quote in it
    // opens a string that bails at EOL, and a `/*` in it no longer blanks past
    // the file (unterminated block comments are not comments — see above).
    // REVISIT TRIGGER: a census finding that needs `)`-aware lookback, i.e. a
    // regex used directly as the body of `if (…) /re/.test(x)`.
    const startsRegex = c === '/' && (
      prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev)
      || REGEX_PRECEDING_KEYWORDS.has(wordEndingAt(prevIdx))
    );
    if (startsRegex) {
      let j = i + 1;
      let inClass = false;
      let closed = -1;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) { closed = j; break; }
        j++;
      }
      if (closed > i) {
        blankLiteral(i + 1, closed);
        i = closed + 1;
        prev = '/';
        prevIdx = closed;
        continue;
      }
    }

    if (!/\s/.test(c)) { prev = c; prevIdx = i; }
    i++;
  }
  return out.join('');
}
