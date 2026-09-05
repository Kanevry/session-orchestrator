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
 *
 * COMMENT-STRIPPING IS THE CALLER'S JOB (#1222). Every matcher here sees RAW
 * lines: a header inside a `<!-- … -->` HTML comment matches exactly like a live
 * one. That is deliberate — stripping comments needs the `block-preprocess.mjs`
 * state machine, and importing it would end this module's zero-import leaf
 * status. A caller that must agree with a comment-STRIPPING parser preprocesses
 * its content first (`preprocessBlockLinesNoDash(content).join('\n')`) — see
 * `dispatcher-autonomy-capture.mjs` `isDispatcherAutonomyBlockPresent()`.
 *
 * `matchBlockHeaderDetailed` (#1185) is a SEPARATE, additive matcher below for
 * parsers that need what this contract deliberately rejects — an indented
 * (nested) header and/or an inline value. It does not change the contract
 * above; `matchBlockHeader`/`hasBlockHeader` keep exactly this behaviour.
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
 * Build the indent-aware, inline-value-capturing block-header regex for a key.
 * A strict SUPERSET of `blockHeaderRe`: it additionally matches an ARBITRARY
 * leading indent (group 1) and an optional inline value trailing the colon
 * (group 2) — the two things `matchBlockHeader` deliberately rejects (a
 * nested sub-key, and a header carrying a value, per the module docblock).
 *
 * @param {string} key
 * @returns {RegExp}
 */
function detailedBlockHeaderRe(key) {
  return new RegExp(
    '^(\\s*)(?:-\\s+)?(?:\\*\\*)?' + escapeRegExp(key) + ':(?:\\*\\*)?(?:[ \\t]+(.*))?$'
  );
}

/**
 * Indent + inline-value variant of `matchBlockHeader` (#1185). Additive —
 * `matchBlockHeader`/`hasBlockHeader` are unchanged and every existing caller
 * keeps its current behaviour untouched.
 *
 * Built for parsers whose header can be NESTED under a parent block (e.g.
 * `health-endpoints:` one level under `ecosystem-health:`) and/or carry an
 * INLINE value (`health-endpoints: [{name: …}]`) on the same line — exactly
 * the two forms `matchBlockHeader` treats as "not a top-level block-opener".
 * This is a separate, purpose-built matcher, not a relaxed replacement: a
 * caller that only needs the boolean top-level check keeps using
 * `matchBlockHeader`.
 *
 * The captured value is RAW text, never comment-stripped — `key:  # note`
 * reports `value: '# note'`, exactly as the pre-#1185 `health-endpoints.mjs`
 * `HEADER_RE` did. A caller that needs comment semantics strips them itself
 * (as `health-endpoints.mjs` already does for its block BODY via its own
 * `stripComment()` — only the header line's raw capture moved here).
 *
 * @param {string} line — a single line (callers strip the trailing `\n`)
 * @param {string} key — the literal block key
 * @returns {{indent: number, value: string|null}|null} `null` on no match;
 *   `value` is `null` for a bare header (`key:`, optionally trailing
 *   whitespace only), else the trimmed text following the colon.
 */
export function matchBlockHeaderDetailed(line, key) {
  if (typeof line !== 'string' || typeof key !== 'string' || key === '') return null;
  const m = line.match(detailedBlockHeaderRe(key));
  if (!m) return null;
  const indent = m[1].length;
  const trimmed = (m[2] ?? '').trim();
  return { indent, value: trimmed === '' ? null : trimmed };
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
