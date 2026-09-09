import { matchBlockHeader } from './block-header.mjs';
import { preprocessBlockLines } from './block-preprocess.mjs';
import { _coerceInteger } from './coercers.mjs';

/**
 * issue-budget.mjs — Parser for the `issue-budget:` block-style Session Config key.
 *
 * Bounds how many issues ONE session may create. Motivation (measured on the
 * private instance over four weeks): 1784 issues created against 1285 closed
 * (net +499), median inter-creation gap 2.6 s, 62 % of creations inside bursts
 * of >= 5 per minute. The pre-existing `discovery-confidence-threshold` /
 * `discovery-severity-threshold` knobs do NOT bound this: they are per-finding
 * QUALITY filters (and the `low` default filters nothing), they are only read
 * in skill prose, and the largest producers never consult them at all.
 *
 * This key is a QUANTITY cap, enforced mechanically by
 * `hooks/pre-bash-issue-budget.mjs` (shell path) and
 * `scripts/lib/spiral-carryover.mjs` `runCli()` (programmatic path), both via
 * `scripts/lib/issue-budget.mjs`.
 *
 * Returns `{ "max-per-session", "max-per-session-raw", mode, overflow }`.
 * Tolerant parser: malformed values fall back to defaults (the
 * `reconcile.min-rule-days` posture, NOT the noisier handover-gate WARN) —
 * a hook must never spam stderr on every single Bash call. ONE exception, and
 * it is a safety one: a malformed per-session OVERRIDE with a valid base number
 * (`7 (feature: x)`) keeps the base 7 and WARNs on stderr, because falling back
 * to the built-in 12 there would silently LOOSEN a cap the operator tightened.
 *
 * Consumers: `scripts/lib/config.mjs`, `scripts/lib/issue-budget.mjs`,
 * `hooks/pre-bash-issue-budget.mjs`, `skills/session-end/SKILL.md` Phase 5.
 */

/** Valid `mode` values. */
const MODES = ['strict', 'warn', 'off'];

/** Valid `overflow` values. */
const OVERFLOW_SINKS = ['collect-issue', 'vault-note'];

/**
 * Parse the `issue-budget:` block from markdown content.
 *
 * Like every sibling block parser this scans the FULL content rather than the
 * `## Session Config` fence, so the block resolves identically whether it is
 * nested inside `## Session Config` (the documented home) or lifted to a
 * top-level block. Bold-bullet headers (`- **issue-budget:**`) are tolerated
 * via the shared `matchBlockHeader` (#830).
 *
 * Defaults:
 *   max-per-session: 12        integer >= 0; 0 means "no issue may be created"
 *                              (a valid, deliberately harsh setting). Malformed
 *                              or negative input falls back to 12 — EXCEPT a
 *                              malformed override over a valid base (`7 (x: y)`),
 *                              which keeps 7 and WARNs.
 *   mode:            strict    strict | warn | off
 *   overflow:        collect-issue   collect-issue | vault-note
 *
 * YAML shape:
 *   issue-budget:
 *     max-per-session: 12
 *     mode: strict
 *     overflow: collect-issue
 *
 * NEW POLICY (not a restatement of an existing rule): `max-per-session` accepts
 * the SAME per-session-type override syntax `agents-per-wave` already uses —
 * `12 (feature: 6)` parses via `_coerceInteger` into
 * `{ default: 12, feature: 6 }`. The key set is OPEN (any session-type label
 * the operator writes), because the session-type vocabulary lives in
 * session-start, not here.
 *
 * The parsed override object is returned under `"max-per-session-raw"`, while
 * `"max-per-session"` stays STRICTLY NUMERIC (the `.default`). That split is
 * load-bearing: three consumers read the key as a number
 * (`scripts/lib/issue-budget.mjs` `chargeIssueBudget`,
 * `hooks/pre-bash-issue-budget.mjs`, and the config-parity docs), and handing
 * any of them an object would surface as `[object Object]` in a cap comparison
 * rather than as an error. Resolution against the CURRENT session type is
 * `resolveMaxPerSession()` in `scripts/lib/issue-budget.mjs`.
 *
 * @param {string} content — full file contents
 * @returns {{ "max-per-session": number, "max-per-session-raw": number|{default: number, [k: string]: number}, mode: string, overflow: string }}
 */
export function _parseIssueBudget(content) {
  const defaults = {
    'max-per-session': 12,
    'max-per-session-raw': 12,
    mode: 'strict',
    overflow: 'collect-issue',
  };

  if (typeof content !== 'string' || content === '') return { ...defaults };

  const lines = preprocessBlockLines(content);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'issue-budget')) inBlock = true;
      continue;
    }
    // Stop at next column-0 non-empty line (sibling top-level key or H2 heading)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return { ...defaults };

  let maxPerSession = defaults['max-per-session'];
  let maxPerSessionRaw = defaults['max-per-session-raw'];
  let mode = defaults.mode;
  let overflow = defaults.overflow;

  for (const rawLine of blockLines) {
    // Strip inline comments and trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'max-per-session': {
        // Non-negative integer, or the `N (type: M)` override form. A leading
        // '-' fails \d+ inside `_coerceInteger`, which throws → default.
        // Tolerant by contract: this parser runs on every Bash call via the
        // hook, so a malformed value must fall back silently, never throw.
        let coerced;
        try {
          coerced = _coerceInteger(new Map([['max-per-session', v]]), 'max-per-session', 12);
        } catch {
          // A malformed OVERRIDE (`7 (feature: x)`) must never restore the
          // built-in 12: the operator wrote a base cap of 7, and discarding the
          // whole value because the parenthesised part is unparseable LOOSENS
          // the cap by three on one typo — silently, in the direction nobody
          // would choose. Keep the base number, drop the override, and say so
          // once (this branch is reachable only on a malformed value, so it
          // cannot become per-Bash-call stderr spam).
          const base = v.match(/^(\d+)\s*\(/);
          if (base) {
            const n = Number.parseInt(base[1], 10);
            if (Number.isInteger(n) && n >= 0) {
              maxPerSession = n;
              maxPerSessionRaw = n;
              process.stderr.write(
                `⚠ issue-budget: malformed per-session override in 'max-per-session': '${v}' — ` +
                  `kept the base cap ${n} and dropped the override.\n`,
              );
            }
          }
          break;
        }
        if (typeof coerced === 'number') {
          maxPerSession = coerced;
          maxPerSessionRaw = coerced;
        } else if (Number.isInteger(coerced?.default) && coerced.default >= 0) {
          maxPerSession = coerced.default;
          maxPerSessionRaw = coerced;
        }
        break;
      }

      case 'mode':
        if (MODES.includes(v.toLowerCase())) mode = v.toLowerCase();
        break;

      case 'overflow':
        if (OVERFLOW_SINKS.includes(v.toLowerCase())) overflow = v.toLowerCase();
        break;
    }
  }

  return {
    'max-per-session': maxPerSession,
    'max-per-session-raw': maxPerSessionRaw,
    mode,
    overflow,
  };
}
