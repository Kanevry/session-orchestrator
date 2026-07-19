import { matchBlockHeader } from './block-header.mjs';

/**
 * custom-phases.mjs — Parser for the `custom-phases:` Session Config block (#637).
 *
 * Lets a repo declare opt-in deterministic phases that run during session close
 * (and/or housekeeping) as a CONTRACT: each phase has a name, a `when` trigger,
 * a shell `command`, a `mode` (warn|hard|off) that gates the close, and an
 * optional `review` file the coordinator reads after the command.
 *
 * Exports:
 *   _parseCustomPhases(content) — PURE, no side effects beyond a stderr WARN when
 *                                 a record is dropped for failing validation.
 *                                 Returns [] when the block is absent/empty.
 *
 * Block shape:
 *   custom-phases:
 *     - name: eval-learn-aggregate     # required, non-empty, SAFE slug
 *       when: housekeeping              # housekeeping | session-end | both (default: session-end)
 *       command: npm run eval:aggregate # required; NO interpolation from records
 *       mode: hard                      # warn | hard | off (default: warn)
 *       review: docs/eval/last-run.md   # optional; SAFE_PATH_RE-validated; default null
 *
 * Modelled on cross-repo.mjs (per-entry SAFE_PATH_RE validation, drop-with-warn)
 * and gitlab-portfolio.mjs (nested list/column-0 block scan). Enum fallbacks are
 * SILENT to the default per block-parser convention (vault-sync.mjs precedent).
 *
 * NOTE on the mode enum: it is ['warn','hard','off'] — `hard` is the correct
 * blocking value for THIS new key. Do NOT copy vault-sync's ['strict','warn','off']
 * (see #217 regression: `hard` was a silent-default bug THERE, intentional HERE).
 */

/** Per-phase defaults. */
export const CUSTOM_PHASE_DEFAULTS = Object.freeze({
  when: 'session-end',
  mode: 'warn',
  review: null,
});

const VALID_WHEN = new Set(['housekeeping', 'session-end', 'both']);
const VALID_MODE = new Set(['warn', 'hard', 'off']);

// Allowlist: a phase `name` is a SAFE slug — lowercase/uppercase letters, digits,
// hyphen, underscore, dot. No spaces, no shell metacharacters.
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

// Allowlist for `command` and `review`: rejects shell metacharacters (; $ ` | & > <
// ( ) newline) that would break the exit-code-gated execution / file-read contract.
// `command` legitimately contains spaces, slashes, colons (e.g. "npm run eval:aggregate"),
// so the allowlist is broader than SAFE_NAME_RE but still excludes injection vectors.
const SAFE_COMMAND_RE = /^[A-Za-z0-9._\-/: =]+$/;

// `review` is a repo-relative or absolute file path — no spaces, no metacharacters.
const SAFE_PATH_RE = /^[A-Za-z0-9._~/-]+$/;

/**
 * Parse the top-level `custom-phases:` YAML list block from markdown content.
 *
 * Each list item is a record. Records are validated per-entry; a record missing
 * a required field (`name`, `command`) or carrying a shell-metacharacter in
 * `command`/`review`/`name` is DROPPED with a stderr WARN. Invalid `when`/`mode`
 * enum values fall back SILENTLY to their defaults.
 *
 * @param {string} content — full CLAUDE.md / AGENTS.md file content
 * @returns {Array<{name: string, when: string, command: string, mode: string, review: string|null}>}
 */
export function _parseCustomPhases(content) {
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (!inBlock) {
      // Detect `custom-phases:` at column 0 with optional trailing spaces.
      if (matchBlockHeader(line, 'custom-phases')) inBlock = true;
      continue;
    }

    // Block terminates at the first non-indented, non-empty line (next top-level key).
    if (line.length > 0 && !/^\s/.test(line)) break;

    blockLines.push(line);
  }

  if (blockLines.length === 0) return [];

  /** @type {Array<{name: string, when: string, command: string, mode: string, review: string|null}>} */
  const records = [];
  /** @type {Record<string, string>|null} */
  let current = null;

  const flush = () => {
    if (current === null) return;
    const rec = _validateRecord(current);
    if (rec !== null) records.push(rec);
    current = null;
  };

  for (const rawLine of blockLines) {
    // Strip inline comments + trailing whitespace, preserve leading indent.
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // A new list item starts with a dash. The first key may sit on the dash line:
    //   - name: foo
    const dashMatch = clean.match(/^\s*-\s+(.*)$/);
    if (dashMatch) {
      flush();
      current = {};
      const inlineKv = dashMatch[1].match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
      if (inlineKv) {
        _assignKv(current, inlineKv[1], inlineKv[2]);
      }
      continue;
    }

    // Continuation key for the current record (deeper indent, no dash).
    const kvMatch = clean.match(/^\s+([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (kvMatch && current !== null) {
      _assignKv(current, kvMatch[1], kvMatch[2]);
    }
  }

  flush();

  return records;
}

/**
 * Assign a raw key/value onto a record being built, stripping surrounding quotes.
 * Only known keys are stored; unknown keys are silently ignored (additive-friendly).
 *
 * @param {Record<string, string>} record
 * @param {string} key
 * @param {string} rawValue
 */
function _assignKv(record, key, rawValue) {
  let v = rawValue.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
  else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

  switch (key) {
    case 'name':
    case 'when':
    case 'command':
    case 'mode':
    case 'review':
      record[key] = v;
      break;
    default:
      // Unknown keys are silently ignored — additive-friendly.
      break;
  }
}

/**
 * Validate + normalise a raw record. Returns the fully-defaulted record, or null
 * (with a stderr WARN) when a required field is missing or a SAFE-regex fails.
 *
 * @param {Record<string, string>} raw
 * @returns {{name: string, when: string, command: string, mode: string, review: string|null}|null}
 */
function _validateRecord(raw) {
  const name = (raw.name ?? '').trim();
  if (name === '') {
    process.stderr.write('custom-phases: dropped record missing required field: name\n');
    return null;
  }
  if (!SAFE_NAME_RE.test(name)) {
    process.stderr.write(
      `custom-phases: dropped record with unsafe name: ${JSON.stringify(name)}\n`,
    );
    return null;
  }

  const command = (raw.command ?? '').trim();
  if (command === '') {
    process.stderr.write(
      `custom-phases: dropped record '${name}' missing required field: command\n`,
    );
    return null;
  }
  if (!SAFE_COMMAND_RE.test(command)) {
    process.stderr.write(
      `custom-phases: dropped record '${name}' with shell metacharacter in command: ${JSON.stringify(command)}\n`,
    );
    return null;
  }

  // when: enum fallback SILENT to default.
  const when = VALID_WHEN.has(raw.when) ? raw.when : CUSTOM_PHASE_DEFAULTS.when;

  // mode: enum fallback SILENT to default.
  const mode = VALID_MODE.has(raw.mode) ? raw.mode : CUSTOM_PHASE_DEFAULTS.mode;

  // review: optional; validated against SAFE_PATH_RE. An unsafe path DROPS the
  // whole record (it is a security-relevant field the coordinator will read).
  let review = CUSTOM_PHASE_DEFAULTS.review;
  const rawReview = (raw.review ?? '').trim();
  if (rawReview !== '' && rawReview !== 'null' && rawReview !== 'none') {
    if (!SAFE_PATH_RE.test(rawReview)) {
      process.stderr.write(
        `custom-phases: dropped record '${name}' with shell metacharacter in review path: ${JSON.stringify(rawReview)}\n`,
      );
      return null;
    }
    review = rawReview;
  }

  return { name, when, command, mode, review };
}
