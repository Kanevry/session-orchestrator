import { matchBlockHeader } from './block-header.mjs';

/**
 * remote-hosts.mjs — Parser for the `remote-hosts:` Session Config block (#1160).
 *
 * Lets a repo DECLARE ssh-reachable hosts that heavy wave roles (test / ui / perf)
 * may be offloaded to instead of shrinking the wave under local resource pressure.
 * This module only declares — it never probes the network, never dispatches, and
 * never decides. Placement is `scripts/lib/wave-resource-gate.mjs`; the dispatch
 * adapter lives in `scripts/lib/wave-executor/`.
 *
 * Exports:
 *   REMOTE_HOST_DEFAULTS  — per-host defaults
 *   ALLOWED_REMOTE_ROLES  — the agent-mapping roles a host may accept
 *   _parseRemoteHosts(content) — PURE, no side effects beyond a stderr WARN when a
 *                                record is dropped. Returns [] when absent/empty.
 *
 * Block shape:
 *   remote-hosts:
 *     - alias: m5                        # required; becomes `-H <alias>` argv
 *       roles-allowed: [test, ui, perf]  # subset of ALLOWED_REMOTE_ROLES
 *       repo-path: ~/Projects/Alice   # optional
 *       claude-path: ~/.local/bin/claude # optional
 *
 * Modelled on custom-phases.mjs (per-entry SAFE-regex validation, drop-with-warn,
 * column-0 block termination, silent enum fallback). The one shape it adds is the
 * inline `[a, b]` list for `roles-allowed`.
 */

/** Per-host defaults. */
export const REMOTE_HOST_DEFAULTS = Object.freeze({
  'roles-allowed': ['test', 'ui', 'perf'],
  'repo-path': null,
  'claude-path': null,
});

/**
 * The roles a remote host may accept. A deliberate SUBSET of `ALLOWED_ROLES` in
 * scripts/lib/config.mjs — impl / db / security / compliance / docs stay local.
 *
 * NOT the wave-role enum ("Impl-Core", "Quality", …): those are two different
 * enums and conflating them is the documented trap (see resolveApwCap's docstring
 * in wave-resource-gate.mjs). The wave→agent-mapping-role translation is
 * `OFFLOADABLE_WAVE_ROLES` in that same module.
 *
 * @type {readonly string[]}
 */
export const ALLOWED_REMOTE_ROLES = Object.freeze(['test', 'ui', 'perf']);

// A host `alias` is an ssh destination that reaches argv as `-H <alias>`: letters,
// digits, hyphen, underscore, dot only. No spaces, no shell metacharacters.
//
// The first character is anchored separately from the rest because a charset
// cannot express a POSITION: an alias of `-H` passes any hyphen-inclusive
// allowlist and then reaches argv as an OPTION token, where the CLI swallows the
// operand behind it. Interior hyphens (`m5-box`) stay legal.
const SAFE_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

// `repo-path` / `claude-path` are filesystem paths handed to a remote shell —
// same allowlist as custom-phases' `review`, with the same leading-hyphen anchor
// as SAFE_NAME_RE above (`--x` is a flag, not a path).
const SAFE_PATH_RE = /^[A-Za-z0-9._~/][A-Za-z0-9._~/-]*$/;

/**
 * Parse the top-level `remote-hosts:` YAML list block from markdown content.
 *
 * A record missing `alias`, or carrying an unsafe `alias` / `repo-path` /
 * `claude-path`, is DROPPED with a stderr WARN. Unknown entries in
 * `roles-allowed` are filtered out with a WARN; a record whose list is empty
 * after filtering is dropped (it could never be selected anyway).
 *
 * @param {string} content — full CLAUDE.md / AGENTS.md file content
 * @returns {Array<{alias: string, 'roles-allowed': string[], 'repo-path': string|null, 'claude-path': string|null}>}
 */
export function _parseRemoteHosts(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (!inBlock) {
      if (matchBlockHeader(line, 'remote-hosts')) inBlock = true;
      continue;
    }

    // Block terminates at the first non-indented, non-empty line (next top-level key).
    if (line.length > 0 && !/^\s/.test(line)) break;

    blockLines.push(line);
  }

  if (blockLines.length === 0) return [];

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

    const dashMatch = clean.match(/^\s*-\s+(.*)$/);
    if (dashMatch) {
      flush();
      current = {};
      const inlineKv = dashMatch[1].match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
      if (inlineKv) _assignKv(current, inlineKv[1], inlineKv[2]);
      continue;
    }

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
 * Unknown keys are silently ignored (additive-friendly).
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
    case 'alias':
    case 'roles-allowed':
    case 'repo-path':
    case 'claude-path':
      record[key] = v;
      break;
    default:
      break;
  }
}

/**
 * Parse an inline `[a, b]` (or bare `a, b`) list into trimmed non-empty strings.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function _parseInlineList(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s !== '');
}

/**
 * Validate + normalise a raw record.
 *
 * @param {Record<string, string>} raw
 * @returns {{alias: string, 'roles-allowed': string[], 'repo-path': string|null, 'claude-path': string|null}|null}
 */
function _validateRecord(raw) {
  const alias = (raw.alias ?? '').trim();
  if (alias === '') {
    process.stderr.write('remote-hosts: dropped record missing required field: alias\n');
    return null;
  }
  if (!SAFE_NAME_RE.test(alias)) {
    process.stderr.write(
      `remote-hosts: dropped record with unsafe alias: ${JSON.stringify(alias)}\n`,
    );
    return null;
  }

  let rolesAllowed = [...REMOTE_HOST_DEFAULTS['roles-allowed']];
  const rawRoles = (raw['roles-allowed'] ?? '').trim();
  if (rawRoles !== '') {
    const declared = _parseInlineList(rawRoles);
    const kept = declared.filter((r) => ALLOWED_REMOTE_ROLES.includes(r));
    const dropped = declared.filter((r) => !ALLOWED_REMOTE_ROLES.includes(r));
    if (dropped.length > 0) {
      process.stderr.write(
        `remote-hosts: host '${alias}' declares unknown role(s) ${dropped.join(', ')} ` +
          `(allowed: ${ALLOWED_REMOTE_ROLES.join(', ')}) — ignored\n`,
      );
    }
    if (kept.length === 0) {
      process.stderr.write(
        `remote-hosts: dropped record '${alias}' — roles-allowed is empty after filtering\n`,
      );
      return null;
    }
    rolesAllowed = kept;
  }

  const paths = {};
  for (const key of ['repo-path', 'claude-path']) {
    let value = REMOTE_HOST_DEFAULTS[key];
    const rawPath = (raw[key] ?? '').trim();
    if (rawPath !== '' && rawPath !== 'null' && rawPath !== 'none') {
      if (!SAFE_PATH_RE.test(rawPath)) {
        process.stderr.write(
          `remote-hosts: dropped record '${alias}' with shell metacharacter in ${key}: ${JSON.stringify(rawPath)}\n`,
        );
        return null;
      }
      value = rawPath;
    }
    paths[key] = value;
  }

  return {
    alias,
    'roles-allowed': rolesAllowed,
    'repo-path': paths['repo-path'],
    'claude-path': paths['claude-path'],
  };
}
