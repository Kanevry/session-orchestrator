/**
 * block-header.mjs — Shared bold-tolerant top-level block-header matcher (#830).
 *
 * Session Config blocks in CLAUDE.md / AGENTS.md may render as a bold-bullet
 * `- **key:**` markdown form rather than a plain `key:` line. Parsers that used
 * the strict `/^<key>:\s*$/` regex silently MISSED the bold form → the block was
 * never entered → all defaults applied with no error surfaced anywhere. #823
 * fixed only vault-integration.mjs; this module generalises the tolerance so
 * every block parser matches the same set of header forms.
 *
 * ZERO IMPORTS by design: tests/lib/config/cycle-guard.test.mjs forbids any
 * scripts/lib/config/*.mjs from importing ../config.mjs. This module keeps a
 * clean leaf with no dependencies at all so every sub-parser can adopt it
 * without any cycle risk.
 *
 * RAW-PARITY constraint (#830 / claude-md-drift-check): the checker imports these
 * parsers directly and feeds RAW file content. Normalisation therefore lives
 * INSIDE the helper each parser calls — never in a preprocessing step in
 * config.mjs — so both the config.mjs path and the direct-import checker path
 * see identical tolerance by construction.
 *
 * LOAD-BEARING semantics — the accepted / rejected form set is a contract:
 *   MATCH (top-level block header for `key`), each with optional trailing ws:
 *     key:            - key:            **key:**            - **key:**
 *   NO MATCH (intentionally):
 *     key: value      — a header carrying a value is not a block-opener
 *     key:  # note    — inline comment on the header line (the documented
 *                       custom-phases / eval gotcha stays broken-by-design)
 *     '  key:'        — indented line (a sub-key of some other block)
 *     other-key:      — a different key
 *
 * The two `**` markers are independent (`**key:` and `key:**` both match),
 * mirroring the tolerant #823 vault-integration regex.
 */

/**
 * Escape regex metacharacters in a literal key so a key like `a.b` or `a+b`
 * is matched literally rather than as a pattern. Defensive: current keys are
 * plain `[a-z-]` slugs (`-` is a literal outside a character class), but the
 * dynamic callers (persona-gate-wave / wave-reviewers) pass a variable `key`.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the single-line block-header regex for a key.
 *
 * Equivalent to: `^(?:-\s+)?(?:\*\*)?<key>:(?:\*\*)?\s*$`. Not multiline — it is
 * tested against one already-split line.
 *
 * @param {string} key
 * @returns {RegExp}
 */
function blockHeaderRe(key) {
  return new RegExp('^(?:-\\s+)?(?:\\*\\*)?' + escapeRegExp(key) + ':(?:\\*\\*)?\\s*$');
}

/**
 * True when `line` opens the top-level block for `key` — tolerant of the
 * bold-bullet markdown rendering (`- **key:**`). Pure boolean, no side effects.
 *
 * @param {string} line — a single line (callers strip the trailing `\n`; a stray
 *   trailing `\r` is tolerated by the `\s*$` tail)
 * @param {string} key — the literal block key (e.g. 'eval', 'broken-window-budget')
 * @returns {boolean}
 */
export function matchBlockHeader(line, key) {
  if (typeof line !== 'string' || typeof key !== 'string' || key === '') return false;
  return blockHeaderRe(key).test(line);
}

/**
 * Multiline presence variant: true when ANY line of `content` opens the
 * top-level block for `key`. For whole-file PRESENCE guards (e.g.
 * dispatcher-autonomy-capture's `BLOCK_HEADER_RE`). Pure boolean.
 *
 * @param {string} content — full file contents
 * @param {string} key
 * @returns {boolean}
 */
export function hasBlockHeader(content, key) {
  if (typeof content !== 'string' || content === '' || typeof key !== 'string' || key === '') {
    return false;
  }
  const re = blockHeaderRe(key);
  for (const rawLine of content.split(/\r?\n/)) {
    if (re.test(rawLine)) return true;
  }
  return false;
}
