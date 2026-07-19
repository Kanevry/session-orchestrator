import { matchBlockHeader } from './block-header.mjs';

/**
 * reconcile.mjs — Parser for the top-level `reconcile:` YAML block.
 *
 * Drives:
 *   - FA3 (#696) advisory rule-proposal delivery at session-end Phase 3.6.8.
 *   - FA4 (#697) this config foundation: `reconcile.enabled` gates the delivery.
 *
 * Returns:
 *   {
 *     enabled: boolean,
 *     mode: 'warn' | 'off',
 *     targets: string[],
 *     'rule-expiry-days': number | null,
 *     'confidence-floor': number,
 *     'min-rule-days': number,
 *     'min-insight-chars': number,
 *   }
 *
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumers: `scripts/lib/config.mjs`, `skills/session-end/SKILL.md` Phase 3.6.8.
 */

/**
 * Parse the top-level `reconcile:` YAML block from markdown content.
 *
 * Defaults:
 *   reconcile.enabled:           false   — opt-in (FA3 reads this to gate Phase 3.6.8)
 *   reconcile.mode:              'warn'  — advisory only; rules NEVER auto-applied,
 *                                          every write is operator-AUQ-gated (enum: off|warn)
 *   reconcile.targets:           ['repo-local']
 *                                         — where approved rules are written;
 *                                           repo-local = `.claude/rules/` in v1
 *   reconcile.rule-expiry-days:  null    — CRITICAL: must default to null so the
 *                                          reconcile engine (`emitter.mjs`
 *                                          `computeExpiresAt`) falls back to per-type
 *                                          TTL (`deriveExpiresAt`, default 60d).
 *                                          A non-null committed default would silently
 *                                          force flat expiry and change FA2 behaviour.
 *                                          Set to a positive integer to override.
 *   reconcile.confidence-floor:  0.5    — float 0.0..1.0; min learning confidence
 *                                          before a learning is eligible for rule proposal
 *   reconcile.min-rule-days:     7       — positive integer; floor window (days) applied
 *                                          to a proposed rule's `expires-at` so a near-dead
 *                                          or already-elapsed natural expiry never produces
 *                                          a born-dead rule (issue #741.1). Malformed,
 *                                          absent, or non-positive values fall back to 7.
 *   reconcile.min-insight-chars: 24      — integer >= 0; opt-in minimum insight length
 *                                          gating the eligibility placeholder-insight check
 *                                          (issue #741.2). Malformed, absent, or negative
 *                                          values fall back to 24.
 *
 * YAML shape:
 *   reconcile:
 *     enabled: false
 *     mode: warn
 *     targets: [repo-local]
 *     rule-expiry-days: null        # default null — falls back to per-type TTL
 *     confidence-floor: 0.5
 *     min-rule-days: 7
 *     min-insight-chars: 24
 *
 * @param {string} content — full file contents
 * @returns {{
 *   enabled: boolean,
 *   mode: string,
 *   targets: string[],
 *   'rule-expiry-days': number | null,
 *   'confidence-floor': number,
 *   'min-rule-days': number,
 *   'min-insight-chars': number,
 * }}
 */
export function _parseReconcile(content) {
  const defaults = {
    enabled: false,
    mode: 'warn',
    targets: ['repo-local'],
    'rule-expiry-days': null,
    'confidence-floor': 0.5,
    'min-rule-days': 7,
    'min-insight-chars': 24,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'reconcile')) inBlock = true;
      continue;
    }
    // Stop at next column-0 non-empty line (sibling top-level key or H2 heading)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let enabled = false;
  let mode = 'warn';
  let targets = ['repo-local'];
  let ruleExpiryDays = null;
  let confidenceFloor = 0.5;
  let minRuleDays = 7;
  let minInsightChars = 24;

  for (const rawLine of blockLines) {
    // Strip inline comments and trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Parse YAML list value: targets: [repo-local] or targets: [a, b]
    const listMatch = clean.match(/^\s+(targets):\s*\[([^\]]*)\]/);
    if (listMatch) {
      const items = listMatch[2]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length > 0) targets = items;
      continue;
    }

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();

    // Strip surrounding quotes
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        // Default is false → only flip to true on explicit "true"
        enabled = v.toLowerCase() === 'true';
        break;

      case 'mode': {
        const VALID_MODES = ['off', 'warn'];
        if (VALID_MODES.includes(v)) mode = v;
        // else: silently fall back to default 'warn'
        break;
      }

      case 'rule-expiry-days': {
        if (v === 'null' || v === '') {
          ruleExpiryDays = null;
        } else if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n > 0) ruleExpiryDays = n;
          // 0 or negative: silently ignore, keep null
        }
        break;
      }

      case 'confidence-floor': {
        const f = parseFloat(v);
        if (!isNaN(f) && f >= 0.0 && f <= 1.0) confidenceFloor = f;
        break;
      }

      case 'min-rule-days': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n > 0) minRuleDays = n;
          // 0 or negative: silently ignore, keep default 7
        }
        break;
      }

      case 'min-insight-chars': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) minInsightChars = n;
          // negative (unrepresentable by \d+ anyway) or malformed: keep default 24
        }
        break;
      }

      // targets inline-list with no brackets (e.g. targets: repo-local) — single value
      case 'targets': {
        if (v && !v.startsWith('[')) {
          targets = [v];
        }
        break;
      }
    }
  }

  return {
    enabled,
    mode,
    targets,
    'rule-expiry-days': ruleExpiryDays,
    'confidence-floor': confidenceFloor,
    'min-rule-days': minRuleDays,
    'min-insight-chars': minInsightChars,
  };
}
