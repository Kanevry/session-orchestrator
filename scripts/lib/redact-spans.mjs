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
 * DELIBERATE SECOND COPY — `check-owner-leakage.mjs` still carries its OWN inline
 * `redactSpans()` and must keep it. That scanner is a documented standalone
 * single-file vendoring target (`.claude/rules/security.md` § "Owner-Privacy
 * Pre-Commit Hook"): consumer repos copy that ONE file, so a static import of this
 * module throws ERR_MODULE_NOT_FOUND in every vendored copy and blocks all commits
 * (proven by the three cases in `tests/husky/pre-commit-owner-leakage.test.mjs`).
 * Unlike CP11's confidential-names helpers, a redaction sink cannot degrade to
 * inert — an absent redaction prints confidential names into a PUBLIC CI log.
 * So: THIS module serves in-tree consumers, the inline copy serves the vendored
 * path, and `tests/lib/redact-spans.test.mjs` pins the two byte-for-byte against
 * each other. Edit one → that drift guard goes red until both agree again.
 */

/**
 * Redact every confidential-name span from `line`, ORDER-INDEPENDENTLY (Fix 1 + Fix 2).
 *
 * This is the single redaction sink for the confidential-names privacy invariant.
 * In `check-owner-leakage.mjs` it is applied at the print choke-point over EVERY
 * violation's lineContent — not only CP11 hits — because that scanner runs in a
 * PUBLIC GitHub-Actions mirror: a confidential customer/repo name that co-occurs
 * with a CP1–CP10 hit on the same line (e.g. a name beside an RFC1918 IP that
 * fails CP8) would otherwise be echoed verbatim to the public CI log (Fix 1).
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
