/**
 * section-extractor.mjs — Extract and parse the ## Session Config KV block.
 *
 * Ported from config-yaml-parser.sh (v2). Used by parseSessionConfig in config.mjs.
 */

// ---------------------------------------------------------------------------
// Section extraction (ported from config-yaml-parser.sh)
// ---------------------------------------------------------------------------

/**
 * THE canonical predicate for "this line opens the `## Session Config` block".
 *
 * Exported (#959 follow-up) because this repo previously carried FIVE
 * independent copies of this fact, and the loosest of them —
 * `scripts/lib/claude-md-budget-lint.mjs` — was the module whose whole job is
 * to MEASURE the block. That asymmetry was not academic: the lint accepted a
 * heading decorated with a trailing HTML comment (`## Session Config <!-- … -->`,
 * a decoration this repo's own convention encourages on sibling headings),
 * while `_extractConfigSection` below rejected it. An author following the
 * cited convention therefore got a CLAUDE.md (or AGENTS.md on Codex CLI —
 * transparent aliases, see skills/_shared/instruction-file-resolution.md)
 * whose every runtime config key
 * silently fell back to its default, while the lint simultaneously reported
 * "148 exempt: '## Session Config'" — the instrument affirming the block is
 * present and runtime-critical at the exact moment the runtime cannot see it.
 *
 * The invariant this export exists to hold: **no consumer's predicate may
 * accept a heading this one rejects.** Importing beats re-deriving; a copy
 * that drifts loose is worse than no check at all.
 *
 * Intentionally EXACT (not a fuzzy regex) apart from CRLF tolerance — it is
 * the literal comparison `_extractConfigSection` has always used, merely
 * given a name. `##  Session Config` (two spaces), a trailing HTML comment,
 * and `## Session Config Convention` are all correctly rejected.
 *
 * Dependency note: this module imports NOTHING. Keep it that way — the budget
 * lint consumes this predicate at bootstrap-scaffold time, before
 * `.claude/rules/` (or most of the repo) exists.
 *
 * @param {string} line - a single line, with or without a trailing '\r'.
 * @returns {boolean}
 */
export function isSessionConfigHeading(line) {
  return typeof line === 'string' && line.replace(/\r$/, '') === SESSION_CONFIG_HEADING;
}

/**
 * The literal heading text, for the one site that legitimately WRITES it
 * (`scripts/lib/ecosystem-wizard/config-writer.mjs` appends a fresh
 * `## Session Config` section when none exists).
 *
 * A producer and a comparator agreeing by coincidence is the same disease
 * `isSessionConfigHeading` exists to cure, one level down: a writer that
 * emits a heading the reader rejects manufactures exactly the silent
 * everything-falls-back-to-defaults failure described above. Writers import
 * this; comparators import the predicate. Neither re-types the string.
 *
 * @type {string}
 */
export const SESSION_CONFIG_HEADING = '## Session Config';

/**
 * Locate the `## Session Config` block and return its body span.
 *
 * THE canonical block-extractor, and the companion to
 * `isSessionConfigHeading` above. Four consumers previously re-derived this
 * span with four different regexes, and the divergence was not academic:
 * `harness-audit/categories/category4.mjs` used
 * `/^## Session Config\s*\n([\s\S]*?)(?=^## |\s*$)/m`, whose `\s*$` lookahead
 * (with `/m`, `$` matches at every line end) makes the lazy body quantifier
 * stop at the FIRST line of the block. On this repo's own CLAUDE.md that
 * captured 17 characters — `persistence: true` — instead of 2877, so the
 * `vault-integration:` block three lines below was structurally invisible and
 * the c4.4 check scored 2/2 with "vault-integration not enabled — skip" in a
 * repo where it is enabled. A capture bug in a scoring instrument reads as a
 * pass, never as an error.
 *
 * The body runs from the line AFTER the heading up to (not including) the
 * next `## ` heading, or EOF. Line-based over `isSessionConfigHeading`, so
 * the heading predicate cannot drift from the span extractor.
 *
 * Offsets are indices into the ORIGINAL `content` string, so callers that
 * need to splice (insert/replace) can do so without re-finding the block.
 *
 * @param {string} content - full markdown document
 * @param {{ occurrence?: 'first'|'last' }} [options] - which heading to match
 *   when a document carries several (docs/session-config-template.md carries
 *   two, both inside fenced examples).
 * @returns {{ body: string, bodyStart: number, bodyEnd: number,
 *   headingLine: number } | null} null when no heading matches.
 */
export function findSessionConfigBlock(content, { occurrence = 'first' } = {}) {
  if (typeof content !== 'string' || content.length === 0) return null;

  const lines = content.split('\n');

  // Byte offset of the start of each line in `content`.
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1; // +1 for the '\n' consumed by split
  }

  const headingIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (isSessionConfigHeading(lines[i])) headingIdxs.push(i);
  }
  if (headingIdxs.length === 0) return null;

  const targetIdx = occurrence === 'last' ? headingIdxs[headingIdxs.length - 1] : headingIdxs[0];

  // Body ends at the next `## ` heading (any H2 closes the block), or EOF.
  let endIdx = lines.length;
  for (let i = targetIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i].replace(/\r$/, ''))) { endIdx = i; break; }
  }

  const bodyStart = targetIdx + 1 < lines.length ? lineStarts[targetIdx + 1] : content.length;
  const bodyEnd = endIdx < lines.length ? lineStarts[endIdx] : content.length;

  return {
    body: lines.slice(targetIdx + 1, endIdx).join('\n'),
    bodyStart,
    bodyEnd,
    headingLine: targetIdx + 1, // 1-based, for error reporting
  };
}

/**
 * Extract the raw ## Session Config block lines from markdown content.
 * - CRLF-tolerant
 * - Skips code fence lines (``` alone or with an info string)
 * - Skips lines inside a multi-line `<!-- … -->` block (`htmlCommentSkipper`)
 * - Strips trailing whitespace from each line
 * @param {string} content
 * @returns {string[]} lines of the Session Config block
 */
export function _extractConfigSection(content) {
  const lines = content.split(/\r?\n/);
  const result = [];
  let inSection = false;
  const skipHtmlComment = htmlCommentSkipper();

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (isSessionConfigHeading(line)) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Next ## header closes the section
      if (/^## /.test(line)) break;
      // Commented-out config is documentation, not config (#1097 review).
      // Shared with `collectUnparsableLines` so the two accept-sets cannot
      // drift — see `htmlCommentSkipper`.
      if (skipHtmlComment(line)) continue;
      // Skip code fences — opener WITH an info string included (#1097).
      // The old predicate was `line.trim() === '```'`, which skips a bare
      // fence but lets ```` ```yaml ```` through as a config line. Harmless
      // while an unmatched line was silently dropped; a false "unparsable"
      // report the moment `collectUnparsableLines` below started naming them —
      // and the fenced form is what one fleet repo actually writes.
      if (isCodeFence(line)) continue;
      // Strip trailing whitespace and collect
      result.push(line.replace(/\s+$/, ''));
    }
  }

  return result;
}

/**
 * True when `line` is a fenced-code-block delimiter — a bare ``` / ~~~ or an
 * opener carrying an info string (```yaml).
 *
 * @param {string} line
 * @returns {boolean}
 */
function isCodeFence(line) {
  return /^\s*(?:```|~~~)/.test(line);
}

/**
 * THE multi-line `<!-- … -->` state machine for the Session Config block —
 * the one place that knows whether a line is commented-out documentation.
 *
 * Exported-by-use (same argument as `_matchKVLine`): `_extractConfigSection`
 * feeds `_parseKV`, and `collectUnparsableLines` classifies — so both call this
 * and their accept-sets are identical BY CONSTRUCTION. They were not, and the
 * divergence ran in exactly the dangerous direction: the collector skipped
 * commented blocks while the extractor read them, so
 *
 *     persistence: true
 *     <!--
 *     enforcement: strict
 *     -->
 *
 * yielded a LIVE `enforcement: strict` (measured: `_parseKV` returned it) that
 * `collectUnparsableLines` reported as a clean block — and `parse-config.mjs`
 * branches its own #1097 gate on `config.enforcement`. Commenting a key out is
 * the most ordinary way to disable it; it must not arm the strictest path.
 *
 * Returns a fresh closure per call — it carries per-document state, so a shared
 * instance would leak an unterminated comment from one document into the next.
 *
 * Ceiling (deliberate): the opener must be at the START of a line
 * (`/^\s*<!--/`). A comment opened mid-line (`waves: 5 <!--`) therefore does
 * NOT swallow the following lines — which keeps every single-line trailing
 * `<!-- … -->` on a heading or key line behaving exactly as before, the form
 * this repo's own convention encourages. Revisit if a fleet CLAUDE.md is ever
 * measured opening a multi-line comment after a value.
 *
 * EXPORTED since #1162 for a third consumer: `block-preprocess.mjs`, which
 * gives the ~36 block parsers under `scripts/lib/config/` the same
 * commented-out-is-not-live-config semantics. Same argument as the export of
 * `isSessionConfigHeading` — a fourth copy of this state machine that drifts
 * loose is worse than no check at all. Behaviour is unchanged by the export.
 *
 * @returns {(line: string) => boolean} true when the line is inside (or opens)
 *   a multi-line HTML comment and must be ignored by both consumers.
 */
export function htmlCommentSkipper() {
  let inComment = false;
  return function skipHtmlComment(line) {
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      return true;
    }
    if (/^\s*<!--/.test(line) && !line.includes('-->')) {
      inComment = true;
      return true;
    }
    return false;
  };
}

/**
 * Replace C0/C1 control characters with `?` before a line is handed to a
 * reporter.
 *
 * `collectUnparsableLines` returns text taken verbatim from a file that is
 * itself the thing being reported as malformed, and its only consumer prints
 * it on stderr after a `WARN unparsable Session Config line N:` prefix. A
 * planted `\x1b[2K…\r` erases that prefix and rewrites the operator's terminal
 * line — the report of a defect becoming the vehicle for hiding it. Sanitising
 * at the SOURCE (rather than at the one printer) means every future consumer
 * inherits the safe form.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeReportText(text) {
  // eslint-disable-next-line no-control-regex -- the control chars ARE the target
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '?');
}

/**
 * THE key/value predicate for a Session Config line — the one place that knows
 * which of the two accepted spellings a line is in.
 *
 * Exported-by-use rather than by name: `_parseKV` builds the map from it and
 * `collectUnparsableLines` decides "this line carries a key" from it, so the
 * accept-set of the two can never drift. A classifier with its own regex would
 * eventually report a line the map DID parse (noise) or stay silent on one it
 * did not (the #1097 defect, unchanged).
 *
 * Format 1: `- **key:** value`
 * Format 2: `key: value`, incl. the YAML list-item form `- key: value` (#497)
 *   and any leading indentation (sub-keys of a nested block land here too).
 *
 * @param {string} line
 * @returns {{ key: string, value: string } | null} null when the line carries
 *   no key/value pair in either format.
 */
function _matchKVLine(line) {
  let key;
  let value;

  // Format 1: - **key:** value
  const fmt1 = line.match(/^\s*-\s+\*\*([^*:]+):\*\*\s*(.*)/);
  if (fmt1) {
    key = fmt1[1].trim();
    value = fmt1[2].trim();
  } else {
    // Format 2: key: value — supports both plain "key: value" and
    // YAML list-item form "- key: value" (issue #497). Key starts with
    // letter; rest is alphanum/hyphen/underscore.
    const fmt2 = line.match(/^\s*(?:-\s+)?([a-zA-Z][a-zA-Z0-9_-]+):\s+(.*)/);
    if (!fmt2) return null;
    key = fmt2[1].trim();
    value = fmt2[2].trim();
  }

  if (!key) return null;

  // Strip inline YAML comment (matches block-parser behaviour in _parseVaultSync etc.)
  value = value.replace(/\s+#.*$/, '').trim();

  // Strip surrounding double quotes from value
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

/**
 * Parse the key-value pairs from extracted Session Config lines.
 * Supports Format 1: `- **key:** value`
 * Supports Format 2: plain `key: value`
 * Last occurrence of a key wins.
 * @param {string[]} lines
 * @returns {Map<string, string>}
 */
export function _parseKV(lines) {
  // We accumulate all matches, last-match wins per key
  const allPairs = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const match = _matchKVLine(line);
    if (!match) continue;
    allPairs.push([match.key, match.value]);
  }

  // Last match wins: build the map by iterating in order
  const kv = new Map();
  for (const [k, v] of allPairs) {
    kv.set(k, v);
  }
  return kv;
}

// ---------------------------------------------------------------------------
// Fail-loud: lines inside the block that carry no meaning (#1097)
// ---------------------------------------------------------------------------

/**
 * A line that opens a nested block: `vault-integration:` with no value, in any
 * of the four fleet spellings (column-zero, `- key:`, `**key:**`, `- **key:**`)
 * and at any indent. Deliberately NOT imported from block-header.mjs: that
 * matcher answers "does this line open the block for THIS key" for a known key,
 * while here the key is unknown by construction.
 */
const NESTED_BLOCK_HEADER_RE = /^\s*(?:-\s+)?(?:\*\*)?[a-zA-Z][a-zA-Z0-9_.-]*:(?:\*\*)?\s*$/;

/** A YAML sequence element that is not a `key: value` pair (`  - some-value`). */
const LIST_ITEM_RE = /^\s*-\s+\S/;

/** Documentation, not config: `# yaml comment` and `<!-- html -->` / `> quote`. */
const COMMENT_RE = /^\s*(?:#|<!--|>)/;

/**
 * Collect the lines inside `## Session Config` that carry no meaning for any
 * parser — the fail-loud half of #1097.
 *
 * The measured defect this exists to end: a key the extractor cannot read is
 * simply absent from the KV map, and every consumer then applies its DEFAULT.
 * For a boolean that default is `false`, so a mis-spelled `vault-integration`
 * block reads exactly like a deliberately disabled one — no error, anywhere, in
 * any log (fleet evidence: a repo whose vault mirror sat at
 * `skipped-vault-disabled` for two months with the key present in its CLAUDE.md).
 *
 * A line is accounted for — and therefore NOT reported — when it is:
 *   blank · a code fence · a `#`/`<!--`/`>` documentation line · a key/value
 *   pair in either accepted format (`_matchKVLine`) · a nested-block header
 *   (`key:` with no value) · a bare YAML list element (`- value`).
 * Everything else is prose sitting where config is expected, which is the only
 * shape a broken key can take once the six forms above are excluded.
 *
 * Line numbers are 1-based and count from the START OF THE DOCUMENT, not from
 * the block — they are for an operator opening the file at that line. The text
 * is run through `sanitizeReportText`, because it is quoted straight into a
 * terminal by the one consumer that prints it.
 *
 * The accept-set is shared with the reader, not merely aligned with it: the
 * `#`/`>` and blank/fence forms are literal here, and the multi-line HTML
 * comment goes through the same `htmlCommentSkipper` call `_extractConfigSection`
 * makes. A form the reader accepts but the classifier does not is noise; a form
 * the READER accepts and the classifier waves through as documentation is the
 * live-commented-out-key defect this shape exists to make unreachable.
 *
 * @param {string} content — full markdown document
 * @returns {Array<{ line: number, text: string }>} empty when the block is
 *   well-formed, absent, or the content is not a string.
 */
export function collectUnparsableLines(content) {
  if (typeof content !== 'string' || content === '') return [];

  const lines = content.split(/\r?\n/);
  const unparsable = [];
  let inSection = false;
  const skipHtmlComment = htmlCommentSkipper();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');

    if (isSessionConfigHeading(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^## /.test(line)) break;

    // A multi-line HTML comment: everything up to `-->` is documentation.
    // Same call, same order, as `_extractConfigSection` — that shared call is
    // what makes the two accept-sets identical rather than merely similar.
    if (skipHtmlComment(line)) continue;

    if (!line.trim()) continue;
    if (isCodeFence(line)) continue;
    if (COMMENT_RE.test(line)) continue;
    if (_matchKVLine(line)) continue;
    if (NESTED_BLOCK_HEADER_RE.test(line)) continue;
    if (LIST_ITEM_RE.test(line)) continue;

    unparsable.push({ line: i + 1, text: sanitizeReportText(line.trim()) });
  }

  return unparsable;
}
