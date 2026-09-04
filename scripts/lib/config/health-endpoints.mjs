/**
 * health-endpoints.mjs — Content-scoped parser for the `health-endpoints:`
 * Session Config key, plus the block-form reading of `ecosystem-health:`.
 *
 * WHY THIS EXISTS (#1174): `health-endpoints` was read off the FLAT KV map via
 * `_coerceList`, which bails to `null` the moment a value contains `{` and
 * cannot see a nested YAML block at all. The ecosystem wizard
 * (`scripts/lib/ecosystem-wizard/config-writer.mjs` `_buildEcosystemSnippetLines`)
 * writes exactly the block form:
 *
 *   ecosystem-health:
 *     health-endpoints:
 *       - name: API
 *         url: https://api.example.com/health
 *
 * Measured before the fix: the flat KV map ended up with bare `name` / `url`
 * entries (last one wins → silent data loss), `health-endpoints` resolved to
 * `null`, and because the header line `ecosystem-health:` carries no value it
 * never matched the KV regex either — so the whole feature stayed dark while
 * the wizard reported success. Consumers (`skills/ecosystem-health/SKILL.md`,
 * `docs/session-config-reference.md`) expect an array of `{ name, url }`.
 *
 * ACCEPTED FORMS (contract — every one of these is written by some producer in
 * this repo today):
 *
 *   A) inline object array (docs/USER-GUIDE.md):
 *      health-endpoints: [{name: "API", url: "https://a/health"}, {name: "W", url: "http://w:8080/z"}]
 *
 *   B) nested block, top-level OR one level under `ecosystem-health:`
 *      (the wizard's output, skills/ecosystem-health/wizard.md):
 *      health-endpoints:
 *        - name: API
 *          url: https://a/health
 *      Block list items may themselves be inline objects
 *      (`- { name: API, url: … }`) — the form docs/session-config-template.md
 *      uses.
 *
 *   C) bare list of URLs — each URL becomes its own name
 *      (`{ name: <url>, url: <url> }`). Both spellings are accepted, because
 *      an operator extending the wizard's BLOCK by hand writes the block one:
 *        health-endpoints: [https://a/health, https://b/health]
 *      and
 *        health-endpoints:
 *          - https://a/health
 *
 *   Empty list (`[]`) → `[]`. `none` / `null` / key absent → `null`.
 *
 * NOT accepted (deliberately): the `name=url` shorthand. An item carrying `=`
 * is treated verbatim as a Form-C URL, never split.
 *
 * Malformed input (an entry missing `name` or `url`, an unmatched brace) →
 * `null` plus exactly ONE `console.warn` line prefixed `config: health-endpoints:`.
 * Never throws: a broken config key must not take down every session-start.
 *
 * Consumers: `scripts/lib/config.mjs` (`health-endpoints`, `ecosystem-health`).
 *
 * The header line itself (indent + optional inline value) is matched via the
 * shared `matchBlockHeaderDetailed()` (#1185) rather than a private regex —
 * this was the one parser in `scripts/lib/config/` whose header needed BOTH
 * arbitrary indent (nested under `ecosystem-health:`) AND an inline value
 * (Form A/C), which the plain `matchBlockHeader()` contract deliberately
 * excludes. See `scripts/lib/config/block-header.mjs` for the shared matcher.
 */

import { matchBlockHeader, matchBlockHeaderDetailed } from './block-header.mjs';
import { preprocessBlockLines, preprocessBlockLinesNoDash } from './block-preprocess.mjs';
import { _coerceBoolean } from './coercers.mjs';

/**
 * A scalar that is a URL: a scheme followed by `//`. Used to tell a Form-C
 * bare-URL list item (`- https://a/health`) from a `key: value` pair
 * (`- name: API`) inside a block. `https://…` would otherwise match the
 * key/value regex with key `https`, which is why the check must come first.
 */
const URL_SCALAR_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Strip a trailing YAML comment. Only a `#` PRECEDED BY WHITESPACE counts, so a
 * URL fragment (`https://a/health#frag`) survives untouched.
 * @param {string} s
 * @returns {string}
 */
function stripComment(s) {
  return s.replace(/\s+#.*$/, '');
}

/**
 * Strip one layer of matching surrounding quotes.
 * @param {string} v
 * @returns {string}
 */
function unquote(v) {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Split on commas that sit at brace/bracket depth 0 and outside quotes — so a
 * comma inside a quoted URL never splits an entry.
 * @param {string} s
 * @returns {string[]}
 */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Split `{…}, {…}` into the inner text of each object. Quote-aware, so a `}`
 * inside a quoted value does not close an object.
 * @param {string} s
 * @returns {string[]|null} null on an unmatched brace.
 */
function splitObjects(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of s) {
    if (quote) {
      if (depth > 0) cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (depth > 0) cur += ch;
      continue;
    }
    if (ch === '{') {
      depth++;
      if (depth === 1) { cur = ''; continue; }
    } else if (ch === '}') {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) { out.push(cur); cur = ''; continue; }
    }
    if (depth > 0) cur += ch;
  }
  if (depth !== 0 || quote) return null;
  return out;
}

/**
 * Parse the inner text of one `{ name: X, url: Y }` object.
 * @param {string} inner
 * @returns {{name: string, url: string}|null} null when name or url is missing.
 */
function parseObjectBody(inner) {
  let name = null;
  let url = null;
  for (const pair of splitTopLevel(inner)) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim().toLowerCase();
    const v = unquote(pair.slice(colonIdx + 1).trim());
    if (k === 'name') name = v;
    else if (k === 'url') url = v;
  }
  if (!name || !url) return null;
  return { name, url };
}

/**
 * Parse an inline value (everything right of `health-endpoints:` on one line).
 * @param {string} raw
 * @returns {{ok: true, value: {name: string, url: string}[]|null} | {ok: false}}
 */
function parseInlineValue(raw) {
  let v = raw.trim();
  // A trailing comment is only stripped when the value ends with `]` — that
  // keeps `#` inside an unbracketed value (a URL fragment) intact.
  const bracketed = v.match(/^(\[.*\])\s*(?:#.*)?$/s);
  if (bracketed) v = bracketed[1];

  if (v === '' || v === 'none' || v === 'null') return { ok: true, value: null };

  const stripped = v.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (stripped === '') return { ok: true, value: [] };

  if (stripped.includes('{')) {
    const bodies = splitObjects(stripped);
    if (bodies === null) return { ok: false };
    const entries = [];
    for (const body of bodies) {
      const entry = parseObjectBody(body);
      if (entry === null) return { ok: false };
      entries.push(entry);
    }
    return entries.length === 0 ? { ok: false } : { ok: true, value: entries };
  }

  // Form C — bare list of URLs; the URL is its own name.
  const urls = splitTopLevel(stripped).map((s) => unquote(s.trim())).filter((s) => s.length > 0);
  if (urls.length === 0) return { ok: true, value: [] };
  return { ok: true, value: urls.map((u) => ({ name: u, url: u })) };
}

/**
 * Parse the indented block that follows a valueless `health-endpoints:` header.
 * Terminates at the first non-blank line indented no deeper than the header —
 * the same rule `issue-budget.mjs` uses, generalised so a header nested under
 * `ecosystem-health:` terminates correctly too.
 *
 * @param {string[]} lines — all document lines
 * @param {number} start — index of the first line after the header
 * @param {number} headerIndent — indent width of the header line
 * @returns {{ok: true, value: {name: string, url: string}[]|null} | {ok: false}}
 */
function parseBlock(lines, start, headerIndent) {
  /** @type {{name: string|null, url: string|null}[]} */
  const entries = [];
  let cur = null;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '') continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent <= headerIndent) break;

    const clean = stripComment(line).replace(/\s+$/, '');
    if (clean.trim() === '') continue;

    const itemMatch = clean.match(/^[ \t]*-\s*(.*)$/);
    if (itemMatch) {
      const rest = itemMatch[1].trim();
      if (rest.startsWith('{')) {
        const bodies = splitObjects(rest);
        if (bodies === null || bodies.length === 0) return { ok: false };
        for (const body of bodies) {
          const entry = parseObjectBody(body);
          if (entry === null) return { ok: false };
          entries.push(entry);
        }
        cur = null;
        continue;
      }
      // Form C inside a block: a bare URL item is its own name — the same rule
      // the inline form applies. Without this, `- https://a/health` fell into
      // assignKV, matched as key `https`, and the whole key WARNed to null
      // while the identical inline list parsed fine.
      const scalar = unquote(rest);
      if (URL_SCALAR_RE.test(scalar)) {
        entries.push({ name: scalar, url: scalar });
        cur = null;
        continue;
      }
      cur = { name: null, url: null };
      entries.push(cur);
      if (rest === '') continue;
      if (!assignKV(cur, rest)) return { ok: false };
      continue;
    }

    const kvMatch = clean.match(/^[ \t]*[a-zA-Z][a-zA-Z0-9_-]*:\s*/);
    if (!kvMatch) return { ok: false };
    if (cur === null) return { ok: false };
    if (!assignKV(cur, clean.trim())) return { ok: false };
  }

  if (entries.length === 0) return { ok: true, value: null };
  for (const e of entries) {
    if (!e.name || !e.url) return { ok: false };
  }
  return { ok: true, value: entries.map((e) => ({ name: e.name, url: e.url })) };
}

/**
 * Assign one `key: value` line into an in-progress entry. Unknown keys are
 * ignored (forward-compatible with a future `timeout:` sub-key); a line that
 * is not a `key: value` pair at all is a parse failure.
 *
 * @param {{name: string|null, url: string|null}} entry
 * @param {string} text
 * @returns {boolean} false when the line is not a key/value pair.
 */
function assignKV(entry, text) {
  const m = text.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
  if (!m) return false;
  const k = m[1].toLowerCase();
  const v = unquote(m[2].trim());
  if (k === 'name') entry.name = v;
  else if (k === 'url') entry.url = v;
  return true;
}

/**
 * Parse `health-endpoints` from the raw markdown content.
 *
 * Scans the FULL document (not just the `## Session Config` fence), matching
 * every sibling block parser in this directory, and takes the FIRST
 * `health-endpoints:` occurrence — top-level or nested under `ecosystem-health:`.
 *
 * @param {string} content — full file contents
 * @returns {{name: string, url: string}[]|null} `null` when absent, explicitly
 *   `none`/`null`, or malformed (malformed additionally emits one WARN).
 */
export function _parseHealthEndpoints(content) {
  if (typeof content !== 'string' || content === '') return null;

  // NoDash: `- name:` / `- url:` / `- {name, url}` list items are RECORD
  // boundaries here — de-dashing would merge two endpoints into one (#1162).
  const lines = preprocessBlockLinesNoDash(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const m = matchBlockHeaderDetailed(line, 'health-endpoints');
    if (!m) continue;

    const headerIndent = m.indent;
    const inline = m.value ?? '';
    const result = inline !== ''
      ? parseInlineValue(inline)
      : parseBlock(lines, i + 1, headerIndent);

    if (!result.ok) {
      console.warn(
        `config: health-endpoints: malformed value at line ${i + 1} — expected a list of {name, url} entries; ignoring.`
      );
      return null;
    }
    return result.value;
  }
  return null;
}

/**
 * Read `ecosystem-health` in its BLOCK form (`ecosystem-health:` with no value,
 * followed by an indented body — what the wizard writes). The scalar form
 * (`ecosystem-health: true`) is read by the caller off the KV map and takes
 * precedence; this function only answers the case the KV map cannot see.
 *
 * A non-empty block means the feature is configured, hence enabled — unless the
 * block carries an explicit `enabled: false`.
 *
 * @param {string} content — full file contents
 * @returns {boolean|null} `null` when no block form is present (caller keeps its default).
 */
export function _parseEcosystemHealthBlockEnabled(content) {
  if (typeof content !== 'string' || content === '') return null;

  // Standard variant: this parser reads only the flat `enabled:` sub-key and
  // builds no records (#1162).
  const lines = preprocessBlockLines(content);
  let inBlock = false;
  const blockLines = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'ecosystem-health')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  const meaningful = blockLines.filter((l) => stripComment(l).trim() !== '');
  if (!inBlock || meaningful.length === 0) return null;

  for (const l of meaningful) {
    const m = stripComment(l).trim().match(/^enabled:\s*(\S+)$/i);
    // Same truth table as the scalar path — `_coerceBoolean` accepts only
    // true/false (case-insensitively) and THROWS on anything else. A local
    // `=== 'true'` comparison silently mapped `yes` to false, so the block form
    // disagreed with `ecosystem-health: yes` on the very same document.
    // NB: `_coerceBoolean` uses its `key` argument for BOTH the map lookup and
    // the error text, so the synthetic map must be keyed by that same string.
    if (m) return _coerceBoolean(new Map([['ecosystem-health.enabled', m[1]]]), 'ecosystem-health.enabled', false);
  }
  return true;
}
