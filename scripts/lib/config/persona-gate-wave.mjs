/**
 * persona-gate-wave.mjs — Parser for the `persona-gate-wave:` Session Config block (#458).
 *
 * Mirrors `wave-reviewers.mjs` pattern: pure parser, no I/O, no side effects.
 * Returns `null` when the block is absent; returns a normalised config object
 * when present. Throws on malformed input (e.g. unparseable threshold).
 *
 * Fields:
 *   enabled         — boolean              (default: false)
 *   after           — 'quality' | 'impl-polish'  (default: 'quality')
 *   threshold       — string spec parsed via parseThreshold (default: 'all')
 *   personas        — string[] (each matches SAFE_PERSONA_NAME_RE)  (default: [])
 *   dispatch-model  — model alias or full ID  (default: 'claude-opus-4-7')
 *   mode            — 'off' | 'warn' | 'strict'  (default: 'off')
 *
 * Used by skills/wave-executor/wave-loop.md § 3b: Persona-Gate Hook to decide
 * whether to fan out a persona-panel review after a wave completes.
 */

import { parseThreshold } from '../persona-panel/threshold.mjs';
import { ALLOWED_MODEL_ALIASES, MODEL_ID_RE } from '../agent-frontmatter.mjs';
import { matchBlockHeader } from './block-header.mjs';

const ALLOWED_AFTER = new Set(['quality', 'impl-polish']);
const ALLOWED_MODE = new Set(['off', 'warn', 'strict']);
const SAFE_PERSONA_NAME_RE = /^[a-z0-9-]{1,64}$/;

const DEFAULTS = Object.freeze({
  enabled: false,
  after: 'quality',
  threshold: 'all',
  threshold_parsed: null,  // cached ParsedThreshold result; populated by _normalizePersonaGateWave
  personas: [],
  'dispatch-model': 'claude-opus-4-7',
  mode: 'off',
});

/**
 * Parse the `persona-gate-wave:` YAML block from markdown content.
 *
 * Returns `null` when the block is absent. Returns a normalised config object
 * (with defaults applied) when present. Throws on validation failure so the
 * caller can surface the precise error to the operator.
 *
 * @param {string} content — full CLAUDE.md / AGENTS.md file content
 * @returns {null | {enabled: boolean, after: string, threshold: string, threshold_parsed: {kind: string, m?: number, n?: number}, personas: string[], 'dispatch-model': string, mode: string}}
 */
export function _parsePersonaGateWave(content) {
  const blockLines = _extractBlock(content, 'persona-gate-wave');
  if (blockLines.length === 0) return null;

  const parsed = _parseBlockLines(blockLines);
  return _normalizePersonaGateWave(parsed);
}

/**
 * Validate and normalise a parsed config object. Pure function — applies
 * defaults and throws on any field that fails validation.
 *
 * @param {object} parsed — raw parsed object (possibly missing fields)
 * @returns {{enabled: boolean, after: string, threshold: string, threshold_parsed: {kind: string, m?: number, n?: number}, personas: string[], 'dispatch-model': string, mode: string}}
 */
export function _normalizePersonaGateWave(parsed) {
  const out = { ...DEFAULTS };

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `persona-gate-wave: expected an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    );
  }

  // enabled
  if (parsed.enabled !== undefined) {
    if (typeof parsed.enabled !== 'boolean') {
      throw new Error(
        `persona-gate-wave.enabled must be a boolean (got ${JSON.stringify(parsed.enabled)})`,
      );
    }
    out.enabled = parsed.enabled;
  }

  // after
  if (parsed.after !== undefined) {
    if (typeof parsed.after !== 'string' || !ALLOWED_AFTER.has(parsed.after)) {
      throw new Error(
        `persona-gate-wave.after must be one of ${[...ALLOWED_AFTER].map((a) => JSON.stringify(a)).join('|')} (got ${JSON.stringify(parsed.after)})`,
      );
    }
    out.after = parsed.after;
  }

  // threshold — parsed via parseThreshold (throws InvalidThresholdError on failure)
  if (parsed.threshold !== undefined) {
    if (typeof parsed.threshold !== 'string') {
      throw new Error(
        `persona-gate-wave.threshold must be a string (got ${typeof parsed.threshold})`,
      );
    }
    // parseThreshold throws InvalidThresholdError on bad spec; let it propagate
    // Store the result as threshold_parsed so callers avoid re-parsing at dispatch time.
    out.threshold_parsed = parseThreshold(parsed.threshold);
    out.threshold = parsed.threshold;
  } else {
    // Populate threshold_parsed from the default threshold string so it is always non-null.
    out.threshold_parsed = parseThreshold(DEFAULTS.threshold);
  }

  // personas — array of strings each matching SAFE_PERSONA_NAME_RE
  if (parsed.personas !== undefined) {
    if (!Array.isArray(parsed.personas)) {
      throw new Error(
        `persona-gate-wave.personas must be an array (got ${typeof parsed.personas})`,
      );
    }
    for (const p of parsed.personas) {
      if (typeof p !== 'string') {
        throw new Error(
          `persona-gate-wave.personas[] entries must be strings (got ${typeof p})`,
        );
      }
      if (!SAFE_PERSONA_NAME_RE.test(p)) {
        throw new Error(
          `persona-gate-wave.personas[] entry ${JSON.stringify(p)} must match ${SAFE_PERSONA_NAME_RE} (lowercase, digits, hyphens, ≤64 chars)`,
        );
      }
    }
    out.personas = [...parsed.personas];
  }

  // dispatch-model — alias OR full model ID (reuses agent-frontmatter.mjs semantics)
  if (parsed['dispatch-model'] !== undefined) {
    const m = parsed['dispatch-model'];
    if (typeof m !== 'string' || m === '') {
      throw new Error(
        `persona-gate-wave.dispatch-model must be a non-empty string (got ${JSON.stringify(m)})`,
      );
    }
    if (!ALLOWED_MODEL_ALIASES.has(m) && !MODEL_ID_RE.test(m)) {
      throw new Error(
        `persona-gate-wave.dispatch-model must be one of ${[...ALLOWED_MODEL_ALIASES].map((a) => JSON.stringify(a)).join('|')} or a full model ID like "claude-opus-4-7" (got ${JSON.stringify(m)})`,
      );
    }
    out['dispatch-model'] = m;
  }

  // mode
  if (parsed.mode !== undefined) {
    if (typeof parsed.mode !== 'string' || !ALLOWED_MODE.has(parsed.mode)) {
      throw new Error(
        `persona-gate-wave.mode must be one of ${[...ALLOWED_MODE].map((a) => JSON.stringify(a)).join('|')} (got ${JSON.stringify(parsed.mode)})`,
      );
    }
    out.mode = parsed.mode;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers — block extraction + line parsing
// ---------------------------------------------------------------------------

/**
 * Extract the indented block lines for a given top-level key from markdown
 * content. Returns an empty array when the key is not present.
 *
 * @param {string} content
 * @param {string} key — e.g. 'persona-gate-wave'
 * @returns {string[]}
 */
function _extractBlock(content, key) {
  const lines = content.split(/\r?\n/);
  const blockLines = [];
  let inBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, key)) {
        inBlock = true;
      }
      continue;
    }
    // Stop at a non-empty line with no leading whitespace (next top-level key)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  return blockLines;
}

/**
 * Parse the indented block lines into a raw object (defaults NOT applied here —
 * normalisation happens in _normalizePersonaGateWave).
 *
 * Accepts:
 *   - scalars: `enabled: true`, `mode: warn`, `after: quality`
 *   - inline arrays: `personas: []`, `personas: [a, b, c]`
 *   - quoted strings: `threshold: "5-of-6"` or `threshold: '5-of-6'`
 *
 * @param {string[]} blockLines
 * @returns {object}
 */
function _parseBlockLines(blockLines) {
  /** @type {Record<string, unknown>} */
  const out = {};

  for (const rawLine of blockLines) {
    // Strip inline comments + trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();

    // Strip surrounding quotes
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled': {
        const low = v.toLowerCase();
        if (low === 'true') out.enabled = true;
        else if (low === 'false') out.enabled = false;
        else out.enabled = v; // let normaliser raise the precise error
        break;
      }
      case 'after':
      case 'mode':
      case 'threshold':
      case 'dispatch-model':
        out[k] = v;
        break;
      case 'personas': {
        // Inline array notation: [] or [a, b, c]
        const stripped = v.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();
        if (stripped === '') {
          out.personas = [];
        } else {
          out.personas = stripped
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        break;
      }
      default:
        // Unknown keys are silently ignored — additive-friendly. The
        // normaliser does not check for unknown keys (mirrors wave-reviewers).
        break;
    }
  }

  return out;
}
