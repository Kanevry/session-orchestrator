/**
 * evolve.mjs — Parser for the `evolve:` Session Config block (#638).
 *
 * Lets a repo declare opt-in EXTRA learning sources for /evolve: sidecar JSON
 * files produced OUT-OF-BAND by a domain measurement (e.g. an eval-learn harness
 * regression report). /evolve READS these sidecars and emits `domain-regression`
 * learning candidates — it NEVER runs the measurement itself (read-only contract).
 *
 * Exports:
 *   _parseEvolve(content)      — PURE, no side effects beyond a stderr WARN when an
 *                                entry is dropped for failing schema validation.
 *                                Returns [] when the block is absent/empty.
 *   _parseEvolveDecay(content) — PURE memory time-decay tuning parser (#670).
 *                                Returns `{ enabled, half-life-days, floor-factor }`
 *                                with conservative defaults; malformed values
 *                                silently fall back to the default (tolerant).
 *
 * Block shape:
 *   evolve:
 *     extra-sources:
 *       - path: eval/learn/reports/latest.json   # required; SAFE_PATH_RE-validated
 *         kind: regression-flags                  # enum: regression-flags (only value)
 *         learning-type: domain-regression        # enum: domain-regression (only value)
 *     decay-enabled: true                          # #670 — gate the recency factor
 *     decay-half-life-days: 90                      # #670 — half-life (conservative)
 *     decay-floor-factor: 0.1                       # #670 — catastrophic-loss floor
 *
 * Modelled on cross-repo.mjs (column-0 block scan + nested list + per-entry
 * SAFE_PATH_RE validation, drop-with-warn) and custom-phases.mjs (nested record
 * list parse). Unknown `kind` / `learning-type` enum values DROP the entry with a
 * stderr WARN (schema gate — never guess), mirroring custom-phases' security posture
 * for security-relevant fields the consumer will read.
 */

import pathModule from 'node:path';

import { matchBlockHeader } from './block-header.mjs';

/** Per-entry defaults (none beyond the required field-set; documented for symmetry). */
export const EVOLVE_EXTRA_SOURCE_DEFAULTS = Object.freeze({
  kind: 'regression-flags',
  'learning-type': 'domain-regression',
});

// Enum allow-lists. Each currently has a single legal value; unknown values DROP
// the entry (schema gate) rather than silently defaulting — the consumer reads the
// `kind` to pick a sidecar schema and the `learning-type` to stamp the candidate,
// so a guessed value would produce a wrong-shaped learning.
const VALID_KIND = new Set(['regression-flags']);
const VALID_LEARNING_TYPE = new Set(['domain-regression']);

// Allowlist: a sidecar `path` is a repo-relative file path — no spaces, no shell
// metacharacters, and no `..` scope escape. Mirrors cross-repo.mjs /
// custom-phases.mjs SAFE_PATH_RE for shell-injection filtering, then adds
// evolve-specific confinement because /evolve resolves sidecars against repo root.
const SAFE_PATH_RE = /^[A-Za-z0-9._~/-]+$/;

/**
 * Parse the top-level `evolve:` block and its nested `extra-sources:` YAML list.
 *
 * Each list item is a record `{path, kind, learning-type}`. Records are validated
 * per-entry; a record missing a required `path`, carrying a shell-metacharacter in
 * `path`, or carrying an unknown `kind`/`learning-type` enum value is DROPPED with a
 * stderr WARN.
 *
 * @param {string} content — full CLAUDE.md / AGENTS.md file content
 * @returns {Array<{path: string, kind: string, 'learning-type': string}>}
 */
export function _parseEvolve(content) {
  const lines = content.split(/\r?\n/);
  let inEvolve = false;
  let inExtraSources = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (!inEvolve) {
      // Detect `evolve:` at column 0 with optional trailing spaces.
      if (matchBlockHeader(line, 'evolve')) inEvolve = true;
      continue;
    }

    // The `evolve:` block terminates at the first non-indented, non-empty line
    // (next top-level key).
    if (line.length > 0 && !/^\s/.test(line)) break;

    if (!inExtraSources) {
      // Detect the `extra-sources:` sub-key (any indent depth ≥ 1).
      if (/^\s+extra-sources:\s*$/.test(line)) inExtraSources = true;
      continue;
    }

    // Within extra-sources: collect list-item lines. A sibling sub-key of evolve:
    // at the SAME indent as extra-sources: (shallower than the list dash) ends the
    // sub-block. We detect this by a non-dash key whose indent matches extra-sources'.
    blockLines.push(line);
  }

  if (blockLines.length === 0) return [];

  /** @type {Array<{path: string, kind: string, 'learning-type': string}>} */
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
    //   - path: foo.json
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
    case 'path':
    case 'kind':
    case 'learning-type':
      record[key] = v;
      break;
    default:
      // Unknown keys are silently ignored — additive-friendly.
      break;
  }
}

/**
 * Validate + normalise a raw extra-source record. Returns the record, or null
 * (with a stderr WARN) when `path` is missing / SAFE_PATH_RE-failing, or when
 * `kind` / `learning-type` carries an unknown enum value.
 *
 * @param {Record<string, string>} raw
 * @returns {{path: string, kind: string, 'learning-type': string}|null}
 */
function _validateRecord(raw) {
  const path = (raw.path ?? '').trim();
  if (path === '') {
    process.stderr.write('evolve: dropped extra-source missing required field: path\n');
    return null;
  }
  if (!SAFE_PATH_RE.test(path)) {
    process.stderr.write(
      `evolve: dropped extra-source with shell metacharacter in path: ${JSON.stringify(path)}\n`,
    );
    return null;
  }
  if (pathModule.isAbsolute(path) || path.split('/').includes('..')) {
    process.stderr.write(
      `evolve: dropped extra-source outside repo-relative scope: ${JSON.stringify(path)}\n`,
    );
    return null;
  }

  // kind: enum gate — unknown value DROPS the record (never guess).
  const kind = (raw.kind ?? EVOLVE_EXTRA_SOURCE_DEFAULTS.kind).trim();
  if (!VALID_KIND.has(kind)) {
    process.stderr.write(
      `evolve: dropped extra-source '${path}' with unknown kind: ${JSON.stringify(kind)} ` +
        `(allowed: ${[...VALID_KIND].join(', ')})\n`,
    );
    return null;
  }

  // learning-type: enum gate — unknown value DROPS the record (never guess).
  const learningType = (raw['learning-type'] ?? EVOLVE_EXTRA_SOURCE_DEFAULTS['learning-type']).trim();
  if (!VALID_LEARNING_TYPE.has(learningType)) {
    process.stderr.write(
      `evolve: dropped extra-source '${path}' with unknown learning-type: ${JSON.stringify(learningType)} ` +
        `(allowed: ${[...VALID_LEARNING_TYPE].join(', ')})\n`,
    );
    return null;
  }

  return { path, kind, 'learning-type': learningType };
}

// ---------------------------------------------------------------------------
// Memory time-decay tuning (#670)
// ---------------------------------------------------------------------------

/**
 * Conservative decay defaults — nested UNDER the existing `evolve:` block so they
 * do NOT add a new top-level Session Config key (claude-md-drift-check Check 6
 * parity is unaffected). Floor means nothing vanishes; long half-life means decay
 * is a tiebreaker, not a cliff. See #670.
 */
export const EVOLVE_DECAY_DEFAULTS = Object.freeze({
  enabled: true,
  'half-life-days': 90,
  'floor-factor': 0.1,
});

/**
 * Parse the memory time-decay tuning keys nested under the `evolve:` block.
 *
 * Scans the same column-0 `evolve:` block as `_parseEvolve` but reads three flat
 * sub-keys (siblings of `extra-sources:`):
 *   - `decay-enabled`        (boolean; default true)
 *   - `decay-half-life-days` (positive number; default 90)
 *   - `decay-floor-factor`   (float in [0,1]; default 0.1)
 *
 * Tolerant: malformed/out-of-range values silently fall back to the default
 * (mirrors auto-dream.mjs). Returns the defaults when the block is absent.
 *
 * @param {string} content — full CLAUDE.md / AGENTS.md file content
 * @returns {{enabled: boolean, 'half-life-days': number, 'floor-factor': number}}
 */
export function _parseEvolveDecay(content) {
  const result = {
    enabled: EVOLVE_DECAY_DEFAULTS.enabled,
    'half-life-days': EVOLVE_DECAY_DEFAULTS['half-life-days'],
    'floor-factor': EVOLVE_DECAY_DEFAULTS['floor-factor'],
  };

  const lines = content.split(/\r?\n/);
  let inEvolve = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inEvolve) {
      if (matchBlockHeader(line, 'evolve')) inEvolve = true;
      continue;
    }
    // Terminate at the first non-indented, non-empty line (next top-level key).
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return result;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Flat `  key: value` sub-key (skip list-item dash lines under extra-sources:).
    const kvMatch = clean.match(/^\s+([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    if (key === 'decay-enabled') {
      const lower = v.toLowerCase();
      if (lower === 'true') result.enabled = true;
      else if (lower === 'false') result.enabled = false;
      // any other value → keep default (tolerant)
    } else if (key === 'decay-half-life-days') {
      // Positive number; reject 0/negative/non-numeric → keep default.
      if (/^\d+(\.\d+)?$/.test(v)) {
        const f = parseFloat(v);
        if (Number.isFinite(f) && f > 0) result['half-life-days'] = f;
      }
    } else if (key === 'decay-floor-factor') {
      // Float in [0,1] → keep default otherwise.
      if (/^\d+(\.\d+)?$/.test(v)) {
        const f = parseFloat(v);
        if (Number.isFinite(f) && f >= 0 && f <= 1) result['floor-factor'] = f;
      }
    }
  }

  return result;
}
