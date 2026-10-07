/**
 * redact-spans.mjs — order-independent, overlap-safe span redaction primitive.
 *
 * Extracted verbatim from `scripts/lib/validate/check-owner-leakage.mjs` (issue
 * #974) so that every redaction sink in the repo shares ONE implementation of the
 * overlap-safe span merge rather than each re-deriving it (and each re-deriving
 * the prefix/suffix bug described below). Pure and synchronous — no I/O, no
 * module state, no dependencies — because hot-path consumers import it.
 *
 * Behaviour is unchanged from the original: this module is a move, not a rewrite.
 *
 * The owner-leakage scanner remains a standalone vendoring target. Since #1530
 * it omits offending line content entirely and redacts private filename segments,
 * so it no longer carries a second copy of this primitive. In-tree consumers
 * that retain surrounding text use this module; its overlap and ordering
 * contracts are covered by tests/lib/redact-spans.test.mjs.
 */

/**
 * Redact every confidential-name span from `line`, ORDER-INDEPENDENTLY (Fix 1 + Fix 2).
 *
 * Consumers must pass every relevant confidential pattern before emitting text.
 * This helper matches the supplied text literally; callers handling reversible
 * encodings must normalize first or omit the sensitive text entirely.
 *
 * ORDER-INDEPENDENCE (Fix 2): a naïve chain of `.replace()` calls is order-dependent
 * — when one configured name is a PREFIX of another (`['acme','acme-corp-secret']`),
 * redacting the shorter first destroys the longer's match and leaks a suffix residue
 * (`[REDACTED]-corp-secret`). Instead we compute ALL match spans against the ORIGINAL
 * (unmutated) string across every pattern, merge overlapping/adjacent intervals, and
 * splice `[REDACTED]` per merged interval. No pattern ever sees a string another
 * pattern already rewrote, so prefix/suffix overlap cannot leak regardless of list
 * order.
 *
 * @param {string} line — the raw (already-trimmed) violation lineContent.
 * @param {RegExp[]} patterns — confidential-name regexes (word-boundary, case-insensitive).
 * @returns {string} the line with every configured name span replaced by [REDACTED].
 */
export function redactSpans(line, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return line;

  // 1. Collect [start, end) spans of every match of every pattern against the
  //    ORIGINAL line (never a partially-mutated one). Global clone so exec() walks
  //    all matches; zero-width guard prevents an infinite loop on a degenerate regex.
  const spans = [];
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(line)) !== null) {
      if (m[0].length === 0) {
        g.lastIndex += 1;
        continue;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  if (spans.length === 0) return line;

  // 2. Merge overlapping / adjacent intervals (sorted by start).
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }

  // 3. Splice [REDACTED] per merged interval, left-to-right over the ORIGINAL line.
  let out = '';
  let cursor = 0;
  for (const [s, e] of merged) {
    out += line.slice(cursor, s) + '[REDACTED]';
    cursor = e;
  }
  out += line.slice(cursor);
  return out;
}
