/**
 * vault-integration.mjs — Parsers for vault-integration and resource-thresholds
 * sub-keys.
 *
 * `_parseVaultIntegration(content)` reads its block scoped from the raw markdown
 * content (cold-start.mjs style), matching the pattern used by every other
 * block-scoped parser in `scripts/lib/config/`. Pre-#593 this parser took a
 * flat KV map shared with all other blocks — a name-collision time bomb
 * because `enabled:` is also used by 15+ other blocks (`docs-orchestrator`,
 * `vault-staleness`, `slopcheck`, etc.). The last `enabled:` line in the file
 * silently overwrote `vault-integration.enabled: true`.
 *
 * `_parseResourceThresholds(kv)` is unchanged: its sub-keys
 * (`ram-free-min-gb`, `ram-free-critical-gb`, `cpu-load-max-pct`,
 * `concurrent-sessions-warn`, `ssh-no-docker`) are unique across all blocks,
 * so a shared KV map has no collision risk.
 *
 * Issue #497 inline-object form is preserved on the content-based path —
 * a `vault-integration: { ... }` line takes precedence over a same-named
 * block form when both are present.
 */

import { _coerceBoolean, _coerceInteger } from './coercers.mjs';
import { matchBlockHeader } from './block-header.mjs';
import { preprocessBlockLines } from './block-preprocess.mjs';

// ---------------------------------------------------------------------------
// vault-integration
// ---------------------------------------------------------------------------

const MODE_ALLOWED = ['warn', 'strict', 'off'];

/**
 * Parse the top-level `vault-integration:` YAML block (or inline-object literal)
 * from the markdown content. Independent of the `## Session Config` section
 * boundary so a baseline using either CLAUDE.md / AGENTS.md baseline-list-item form
 * (`- vault-integration: { ... }`) or block form is handled identically.
 *
 * Supports two source shapes:
 *   1. Inline object literal on a single line (issue #497):
 *      `vault-integration: { enabled: true, vault-dir: ~/Projects/vault, mode: warn }`
 *      (with or without a leading `- ` list-item dash)
 *   2. Block form with indented sub-keys (default):
 *      ```
 *      vault-integration:
 *        enabled: true
 *        vault-dir: ~/Projects/vault
 *        mode: warn
 *      ```
 *
 * The inline form takes precedence when both are present.
 *
 * Accepted forms: the bold-bullet markdown rendering of either shape above —
 * `- **vault-integration:** { ... }` or a `- **vault-integration:**` header
 * followed by an indented block — is also accepted (#823). The optional `**`
 * is stripped only immediately around the `key:` token at line start; the
 * value portion (including any literal `**` inside it) is untouched.
 *
 * Defaults:
 *   enabled:       false
 *   vault-dir:     null
 *   mode:          "warn" (invalid values silently fall back to "warn")
 *   vault-name:    null   (absent = downstream callers use deriveRepo() default)
 *   gitlab-groups: null   (#1094 — non-empty string[] or null; see _groupsFromScalar)
 *
 * `gitlab-groups` accepts a comma string (`a, b`), a flow array (`[a, b]`) and,
 * in block form only, a YAML block list (`gitlab-groups:` + indented `- a`
 * lines — the shape docs/session-config-template.md documents). Inside the
 * inline-object form more than one group needs the `[a, b]` array, because the
 * literal is split on commas.
 *
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, "vault-dir": string|null, mode: string, "vault-name": string|null, "gitlab-groups": string[]|null}}
 */
export function _parseVaultIntegration(content) {
  const defaults = {
    enabled: false,
    'vault-dir': null,
    mode: 'warn',
    'vault-name': null,
    'gitlab-groups': null,
  };
  if (typeof content !== 'string' || content === '') return defaults;

  // #1162: NOT a raw split. `preprocessBlockLines` drops HTML-commented lines
  // (a commented-out block was read as live config) and rewrites bold-bullet
  // sub-keys (`- **enabled:** true` fell back to the `false` default). This
  // parser has no dash-RECORD body, so the bold pass is safe here — see the
  // named risk in block-preprocess.mjs.
  const lines = preprocessBlockLines(content);

  // Pass 1: inline-object form. Matches `vault-integration: { ... }` with or
  // without a leading `- ` (baseline list-item form per #497).
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const inlineMatch = line.match(/^(?:-\s+)?(?:\*\*)?vault-integration:(?:\*\*)?\s*(\{[^}]*\})\s*(?:#.*)?$/);
    if (inlineMatch) {
      return _parseInlineObject(inlineMatch[1]);
    }
  }

  // Pass 2: block form. Find `^vault-integration:\s*$` (header-only line) and
  // accumulate indented continuation lines until a non-indented line breaks
  // out of the block.
  let inBlock = false;
  const blockLines = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'vault-integration')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }
  if (blockLines.length === 0) return defaults;

  let enabled = false;
  let vaultDir = null;
  let mode = 'warn';
  let vaultName = null;
  let gitlabGroups = null;
  // Items of a YAML block list under a value-less `gitlab-groups:` line; null
  // while no such list is open.
  let groupItems = null;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    if (groupItems !== null) {
      const item = clean.match(/^\s+-(?:\s+(.*))?$/);
      if (item) {
        const value = _stripQuotes((item[1] ?? '').trim());
        if (value !== '') groupItems.push(value);
        continue;
      }
    }

    // Sub-keys at any indent. A list-item line (`- x`) never matches, so list
    // items under a key this parser does not own are skipped here.
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)$/);
    if (!kvMatch) continue;

    if (groupItems !== null) {
      if (groupItems.length > 0) gitlabGroups = groupItems;
      groupItems = null;
    }

    const k = kvMatch[1];
    const v = _stripQuotes(kvMatch[2].trim());

    switch (k) {
      case 'enabled':
        // Strict booleans only. Anything other than "true"/"false" stays at default (false).
        if (v.toLowerCase() === 'true') enabled = true;
        else if (v.toLowerCase() === 'false') enabled = false;
        break;
      case 'vault-dir':
        if (v === '' || v === 'none' || v === 'null') vaultDir = null;
        else vaultDir = v;
        break;
      case 'mode':
        if (MODE_ALLOWED.includes(v.toLowerCase())) mode = v.toLowerCase();
        else mode = 'warn'; // silent fallback (parity with pre-#593 behaviour)
        break;
      case 'vault-name':
        if (v === '' || v === 'none' || v === 'null') vaultName = null;
        else vaultName = v;
        break;
      case 'gitlab-groups':
        // A value replaces any earlier one; an empty value opens a block list,
        // which replaces it only once it has collected an item.
        if (v === '') groupItems = [];
        else gitlabGroups = _groupsFromScalar(v);
        break;
    }
  }
  if (groupItems !== null && groupItems.length > 0) gitlabGroups = groupItems;

  return {
    enabled,
    'vault-dir': vaultDir,
    mode,
    'vault-name': vaultName,
    'gitlab-groups': gitlabGroups,
  };
}

/**
 * Strip ONE pair of matching surrounding quotes (`"x"` / `'x'`). A lone quote
 * character is returned unchanged.
 *
 * @param {string} v — an already-trimmed value
 * @returns {string}
 */
function _stripQuotes(v) {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Normalise a scalar `gitlab-groups` value to a group list — byte-for-byte the
 * normalisation `scripts/vault-backfill.mjs` applied before #1094: drop one
 * leading `[` and one trailing `]`, split on commas, trim, drop empty entries.
 * Elements are NOT unquoted and `none`/`null` are NOT sentinels here (both were
 * literal group names to the backfill CLI); an empty result is `null`, the
 * documented default.
 *
 * @param {string} v
 * @returns {string[]|null}
 */
function _groupsFromScalar(v) {
  const groups = v
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  return groups.length > 0 ? groups : null;
}

/**
 * `gitlab-groups: [ ... ]` inside an inline object literal (braces already
 * removed). Taken out BEFORE the comma split, which would otherwise cut the
 * array apart; every other pair is split exactly as before.
 */
const INLINE_GROUPS_ARRAY_RE = /(^|,)\s*gitlab-groups\s*:\s*(\[[^\]]*\])\s*(?=,|$)/;

/**
 * Parse an inline YAML object literal `{ key: val, key: val }` into the
 * vault-integration return shape. Supports unquoted values including `~/` paths.
 *
 * @param {string} raw — full literal including braces
 * @returns {{enabled: boolean, "vault-dir": string|null, mode: string, "vault-name": string|null, "gitlab-groups": string[]|null}}
 */
function _parseInlineObject(raw) {
  let stripped = raw.replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
  let groupsArray = null;
  const arrayMatch = stripped.match(INLINE_GROUPS_ARRAY_RE);
  if (arrayMatch) {
    groupsArray = arrayMatch[2];
    stripped =
      stripped.slice(0, arrayMatch.index) +
      arrayMatch[1] +
      stripped.slice(arrayMatch.index + arrayMatch[0].length);
  }
  const kv = new Map();
  if (stripped !== '') {
    for (const pair of stripped.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) continue;
      const k = pair.slice(0, colonIdx).trim();
      const v = pair.slice(colonIdx + 1).trim();
      if (k) kv.set(k, v);
    }
  }

  const enabledRaw = kv.get('enabled');
  const enabled = enabledRaw === 'true' ? true : false;
  const vaultDirRaw = kv.get('vault-dir');
  const vaultDir =
    vaultDirRaw === undefined || vaultDirRaw === '' || vaultDirRaw === 'none' || vaultDirRaw === 'null'
      ? null
      : vaultDirRaw;
  const modeRaw = kv.get('mode') ?? 'warn';
  const mode = MODE_ALLOWED.includes(modeRaw.toLowerCase()) ? modeRaw.toLowerCase() : 'warn';
  const vaultNameRaw = kv.get('vault-name');
  const vaultName =
    vaultNameRaw === undefined || vaultNameRaw === '' || vaultNameRaw === 'none' || vaultNameRaw === 'null'
      ? null
      : vaultNameRaw;
  const groupsRaw = groupsArray ?? kv.get('gitlab-groups');
  const gitlabGroups = groupsRaw === undefined ? null : _groupsFromScalar(groupsRaw);
  return {
    enabled,
    'vault-dir': vaultDir,
    mode,
    'vault-name': vaultName,
    'gitlab-groups': gitlabGroups,
  };
}

// ---------------------------------------------------------------------------
// resource-thresholds
// ---------------------------------------------------------------------------

// Sub-key names are deliberately unique across all blocks (no collision with
// vault-integration / vault-sync / others) because they are flattened into the
// same KV map by the Session Config parser. See the A5 note in parse-config.sh.

/**
 * Extract resource-thresholds sub-keys from the Session Config KV map.
 * @param {Map<string, string>} kv
 * @returns {{[key: string]: number|boolean}}
 */
export function _parseResourceThresholds(kv) {
  return {
    // Memory thresholds are denominated in the signal `evaluate()` actually
    // judges on — memory_pressure > ram_available > ram_free, in that order
    // (#1089). They are NOT compared against Darwin's `os.freemem()` unless
    // nothing better is published, which on Darwin never happens.
    'ram-free-min-gb': _coerceInteger(kv, 'ram-free-min-gb', 4),
    'ram-free-critical-gb': _coerceInteger(kv, 'ram-free-critical-gb', 2),
    // 80 → 90 (#1089). At 80 this fired on 15.6% of 1477 measured session
    // starts, largely on the decaying tail of the coordinator's own gate run;
    // at 90 it fires on 12.8%, and under the two-signal rule it no longer caps
    // anything on its own. Both numbers are measurements, not preferences.
    'cpu-load-max-pct': _coerceInteger(kv, 'cpu-load-max-pct', 90),
    // Unchanged at 5 — but now compared against LIVE PEER SESSIONS rather than
    // the Claude process count. Same number, different denominator: measured
    // firing rate drops from 93.6% to 4.2% (median processes:sessions = 6.0).
    'concurrent-sessions-warn': _coerceInteger(kv, 'concurrent-sessions-warn', 5),
    'ssh-no-docker': _coerceBoolean(kv, 'ssh-no-docker', true),
  };
}
