/**
 * block-preprocess.mjs — THE line-preprocessing contract for the block parsers
 * under `scripts/lib/config/` (#1162).
 *
 * Every block parser here begins with `content.split(/\r?\n/)`, then walks lines
 * looking for its own header and the indented sub-keys under it. Two markdown
 * shapes that are ordinary in a CLAUDE.md / AGENTS.md were invisible to that
 * walk, and both failed in the dangerous direction:
 *
 *   (a) A block commented OUT with a multi-line `<!-- … -->` was read as LIVE
 *       config. Commenting a key out is the most ordinary way to disable it; it
 *       must not arm it. (`_extractConfigSection` learned this in #1097 — the
 *       block parsers never did.)
 *   (b) The bold-bullet rendering of a SUB-key (`- **enabled:** true`) matched
 *       no sub-key regex, so the key was absent and its DEFAULT applied. For a
 *       boolean that default is `false`, which reads exactly like a deliberately
 *       disabled block — no error, in any log. #823 fixed this for the block
 *       HEADER only (see `block-header.mjs`); this fixes it for the body.
 *
 * ZERO IMPORTS beyond the sibling `section-extractor.mjs` skipper, stdlib only —
 * `tests/lib/config/cycle-guard.test.mjs` forbids any `scripts/lib/config/*.mjs`
 * from importing `../config.mjs`, and the RAW-PARITY constraint (block-header.mjs
 * docblock) requires the normalisation to live in the helper each parser calls,
 * never in a preprocessing step in `config.mjs`.
 *
 * DELIBERATE NON-GOAL — fenced code blocks. These parsers are fence-UNAWARE, and
 * that is a pinned contract, not an oversight. Two tests, cited by NAME because
 * line numbers rot: `tests/lib/config/frontend-slop-hook.test.mjs` — "parses a
 * block wrapped in a fenced code block — the parser is fence-unaware", and
 * `tests/lib/config/dispatcher-autonomy-capture.test.mjs` — "treats a header
 * inside a fenced code block as PRESENT". Both assert that a ```-fenced block IS
 * parsed. Teaching this module about
 * fences would flip ~36 parsers at once and break those pins, so it does not.
 * Revisit only as its own change, with those two tests as the blast radius.
 */

import { htmlCommentSkipper } from './section-extractor.mjs';

/**
 * Drop every line that lies inside — or opens — a multi-line `<!-- … -->` HTML
 * comment (#1162a).
 *
 * Wraps `htmlCommentSkipper()` from `section-extractor.mjs` rather than
 * re-deriving the state machine, so the block parsers and the Session Config
 * KV extractor share ONE definition of "this line is commented-out
 * documentation" by construction. A fresh closure is built per call: the skipper
 * carries per-document state, and a shared instance would leak an unterminated
 * comment from one document into the next.
 *
 * Inherits the skipper's deliberate ceiling: the opener must be at the START of
 * a line (`/^\s*<!--/`), so `waves: 5 <!-- note` does NOT swallow the following
 * lines — the trailing single-line comment form this repo's own convention
 * encourages keeps working.
 *
 * Never touches `- ` list markers, indentation, or line content.
 *
 * FAIL-CLOSED on an UNTERMINATED comment. A stray `<!--` with no `-->` after it
 * puts the skipper in the swallowing state for the REST of the document, so
 * every later block silently disappears and each parser falls back to its
 * defaults — for `config-protection` that is `strict` → `warn`, i.e. a guard
 * disarmed by a typo, with no error anywhere. When the skipper would still be
 * inside a comment at EOF, this returns the INPUT lines unfiltered (the
 * pre-#1162 behaviour: the opener is treated as literal text), so nothing can
 * vanish. The condition is reported via `onUnterminated` and is separately
 * observable through {@link findUnterminatedComment}.
 *
 * @param {string[]} lines
 * @param {(lineNo: number) => void} [onUnterminated] — called with the 1-based
 *   line number of the unterminated opener when stripping is disabled.
 * @returns {string[]} a new array; the input is not mutated.
 */
export function stripHtmlCommentBlocks(lines, onUnterminated) {
  if (!Array.isArray(lines)) return [];
  const unterminatedAt = findUnterminatedComment(lines);
  if (unterminatedAt !== null) {
    if (typeof onUnterminated === 'function') onUnterminated(unterminatedAt);
    return lines.slice();
  }
  const skip = htmlCommentSkipper();
  return lines.filter((line) => !skip(typeof line === 'string' ? line : ''));
}

/**
 * The 1-based line number of an `<!--` that is never closed, or `null` when
 * every comment in `lines` is terminated.
 *
 * Derived from the SAME `htmlCommentSkipper()` state machine rather than a
 * second copy of it (the RAW-PARITY constraint): the skipper swallows the
 * closing `-->` line too, so the document ends inside a comment exactly when
 * the LAST swallowed line carries no `-->`. A swallowed line that follows a
 * closing line (or the first one of all) is an opener, which is how the
 * reported line number is obtained.
 *
 * @param {string[]} lines
 * @returns {number|null}
 */
export function findUnterminatedComment(lines) {
  if (!Array.isArray(lines)) return null;
  const skip = htmlCommentSkipper();
  let openerLine = null;
  /** @type {string|null} */
  let lastSwallowed = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = typeof lines[i] === 'string' ? lines[i] : '';
    if (!skip(line)) continue;
    if (lastSwallowed === null || lastSwallowed.includes('-->')) openerLine = i + 1;
    lastSwallowed = line;
  }
  if (lastSwallowed === null || lastSwallowed.includes('-->')) return null;
  return openerLine;
}

/**
 * `- **key:** value` / `- **key**: value` / `**key:** value` → `key: value`,
 * preserving the leading indentation EXACTLY (#1162b).
 *
 * The indent is load-bearing: every block parser ends its block at the first
 * non-empty non-indented line, so an indent-eating rewrite would truncate the
 * block one line early. Only the `**` markers and the optional `- ` bullet
 * immediately around the `key:` token at line start are removed; the value
 * portion (including any literal `**` inside it) is untouched — same rule as the
 * `_matchKVLine` Format-1 branch and the #823 header tolerance.
 *
 * A line that is not a bold key/value pair is returned byte-identical.
 *
 * @internal — exported for this module's own tests. Production callers use
 * {@link preprocessBlockLines} / {@link preprocessBlockLinesNoDash}.
 *
 * NAMED RISK — dash-record blocks. In any block whose body uses `- ` as a RECORD
 * boundary, de-dashing the first key of a record merges it into the PREVIOUS
 * record, silently producing one record where two were written. Those parsers
 * must use
 * `preprocessBlockLinesNoDash` instead. `tests/lib/config/block-preprocess.test.mjs`
 * demonstrates the merge so the next reader sees why the NoDash variant exists.
 *
 * @param {string[]} lines
 * @returns {string[]} a new array; the input is not mutated.
 */
export function normalizeBoldSubkeys(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    if (typeof line !== 'string') return line;
    // (1) indent  (2) optional bullet  (3) **key:**  or  **key**:  (4) rest
    const m = line.match(/^(\s*)(?:-\s+)?\*\*([^*:]+?)(?::\*\*|\*\*:)\s*(.*)$/);
    if (!m) return line;
    const value = m[3];
    return value === '' ? `${m[1]}${m[2]}:` : `${m[1]}${m[2]}: ${value}`;
  });
}

/**
 * THE drop-in replacement for `content.split(/\r?\n/)` in a flat or
 * nested-OBJECT block parser: strip commented-out lines, then normalise bold
 * sub-keys.
 *
 * @param {string} content — full file contents
 * @returns {string[]} preprocessed lines (empty array for non-string input)
 */
export function preprocessBlockLines(content) {
  if (typeof content !== 'string') return [];
  return normalizeBoldSubkeys(stripHtmlCommentBlocks(content.split(/\r?\n/)));
}

/**
 * THE drop-in for every dash-RECORD parser — any parser whose block body uses
 * `- ` as a record boundary, so the dash must survive: HTML-comment stripping
 * only, no bold-subkey normalisation. (Enumerating them here goes stale; the
 * rule is the criterion. `grep -l preprocessBlockLinesNoDash scripts/lib/config/`
 * lists the current set.)
 *
 * @param {string} content — full file contents
 * @returns {string[]} preprocessed lines (empty array for non-string input)
 */
export function preprocessBlockLinesNoDash(content) {
  if (typeof content !== 'string') return [];
  return stripHtmlCommentBlocks(content.split(/\r?\n/));
}
