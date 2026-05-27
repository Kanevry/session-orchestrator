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
 * Defaults:
 *   enabled:    false
 *   vault-dir:  null
 *   mode:       "warn" (invalid values silently fall back to "warn")
 *
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, "vault-dir": string|null, mode: string}}
 */
export function _parseVaultIntegration(content) {
  const defaults = { enabled: false, 'vault-dir': null, mode: 'warn' };
  if (typeof content !== 'string' || content === '') return defaults;

  const lines = content.split(/\r?\n/);

  // Pass 1: inline-object form. Matches `vault-integration: { ... }` with or
  // without a leading `- ` (baseline list-item form per #497).
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const inlineMatch = line.match(/^(?:-\s+)?vault-integration:\s*(\{[^}]*\})\s*(?:#.*)?$/);
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
      if (/^(?:-\s+)?vault-integration:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }
  if (blockLines.length === 0) return defaults;

  let enabled = false;
  let vaultDir = null;
  let mode = 'warn';

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Only first-level sub-keys (single indent). Skip deeper nested keys like
    // `gitlab-groups:` list items (handled as a no-op — they aren't in this
    // parser's return shape).
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)$/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

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
    }
  }

  return { enabled, 'vault-dir': vaultDir, mode };
}

/**
 * Parse an inline YAML object literal `{ key: val, key: val }` into the
 * vault-integration return shape. Supports unquoted values including `~/` paths.
 *
 * @param {string} raw — full literal including braces
 * @returns {{enabled: boolean, "vault-dir": string|null, mode: string}}
 */
function _parseInlineObject(raw) {
  const stripped = raw.replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
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
  return { enabled, 'vault-dir': vaultDir, mode };
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
    'ram-free-min-gb': _coerceInteger(kv, 'ram-free-min-gb', 4),
    'ram-free-critical-gb': _coerceInteger(kv, 'ram-free-critical-gb', 2),
    'cpu-load-max-pct': _coerceInteger(kv, 'cpu-load-max-pct', 80),
    'concurrent-sessions-warn': _coerceInteger(kv, 'concurrent-sessions-warn', 5),
    'ssh-no-docker': _coerceBoolean(kv, 'ssh-no-docker', true),
  };
}
