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
 *     'max-proposals-per-run': number,
 *   }
 *
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumers: `scripts/lib/config.mjs`, `skills/session-end/SKILL.md` Phase 3.6.8.
 */

/**
 * CLOSED set of valid `reconcile.targets` members.
 *
 * At module scope on purpose: `targets` has TWO parse sites (the bracket-list
 * branch and the bare-scalar `case 'targets'`), whereas `mode` has one. An
 * inline literal duplicated across two sites is a second register that drifts —
 * the shape mirrors `VALID_MODES` below, hoisted because the duplication is real.
 *
 * `global` is documented-but-unimplemented and is deliberately NOT a member:
 * admitting a value nothing implements is the same defect class as the
 * unvalidated pass-through this constant replaces.
 */
const VALID_TARGETS = Object.freeze(['repo-local', 'baseline']);

/** Fallback when every declared target was dropped (mirrors the `defaults` object). */
const DEFAULT_TARGETS = Object.freeze(['repo-local']);

/**
 * Report dropped `reconcile.targets` members on stderr.
 *
 * stderr, NEVER stdout: `scripts/lib/config.mjs` consumers parse this parser's
 * downstream output as JSON, so a diagnostic on stdout would corrupt it.
 *
 * Prior art for "make an attributable drop VISIBLE, not merely recorded":
 * `warnDroppedStoreRecords` in `scripts/lib/reconcile/engine.mjs`.
 *
 * @param {string[]} dropped
 */
function warnUnknownTargets(dropped) {
  try {
    console.warn(
      `⚠️  reconcile.targets: dropped unknown value(s) ${dropped.map((d) => JSON.stringify(d)).join(', ')} — ` +
        `valid targets are ${VALID_TARGETS.join(' | ')}. The unknown value is IGNORED (no rule is ` +
        `written for it); if every declared target was dropped, the parser falls back to ` +
        `[${DEFAULT_TARGETS.join(', ')}].`,
    );
  } catch {
    // A diagnostic must never become the failure it reports on.
  }
}

/**
 * Keep only {@link VALID_TARGETS} members, de-duplicated, order-preserving.
 *
 * Rejection is DROP + WARN, never a throw — not even under `enforcement: strict`:
 *  (a) this module's stated contract ("Tolerant parser: malformed values silently
 *      fall back to defaults") is obeyed by every other key here; making one key
 *      throw is an internal inconsistency;
 *  (b) `_parseReconcile` runs from `scripts/lib/config.mjs` at session-start, so a
 *      throw would fail session-start on a config typo;
 *  (c) the SILENCE was the defect, not the tolerance — the WARN closes it.
 *
 * Fail-loud belongs one layer up (`claude-md-drift-check` Check 6 could ERROR on
 * an unknown value); that is deliberately NOT bundled here.
 *
 * @param {string[]} items
 * @returns {string[]}
 */
function filterTargets(items) {
  const kept = [];
  const dropped = [];
  for (const item of items) {
    if (VALID_TARGETS.includes(item)) kept.push(item);
    else dropped.push(item);
  }
  if (dropped.length > 0) warnUnknownTargets(dropped);
  const uniq = [...new Set(kept)];
  return uniq.length > 0 ? uniq : [...DEFAULT_TARGETS];
}

/**
 * Parse the top-level `reconcile:` YAML block from markdown content.
 *
 * Defaults:
 *   reconcile.enabled:           false   — opt-in (FA3 reads this to gate Phase 3.6.8)
 *   reconcile.mode:              'warn'  — advisory only; rules NEVER auto-applied,
 *                                          every write is operator-AUQ-gated (enum: off|warn)
 *   reconcile.targets:           ['repo-local']
 *                                         — where approved rules are written.
 *                                           CLOSED enum, see {@link VALID_TARGETS}:
 *                                           repo-local = `.claude/rules/` in this repo;
 *                                           baseline   = `<baselineRoot>/proposals/`
 *                                           (issue #1099). An unknown member is DROPPED
 *                                           with a stderr WARN — see {@link filterTargets}
 *                                           for why a drop and not a throw.
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
 *   reconcile.max-proposals-per-run: 10  — positive integer (min 1); volume brake (issue
 *                                          #900 D) — the reconcile engine sorts eligible
 *                                          learnings by confidence DESC and proposes at
 *                                          most this many per run, recording the cut count
 *                                          in the run summary (`summary.capped`). Malformed,
 *                                          absent, or non-positive values fall back to 10.
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
 *     max-proposals-per-run: 10
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
 *   'max-proposals-per-run': number,
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
    'max-proposals-per-run': 10,
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
  let maxProposalsPerRun = 10;

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
      if (items.length > 0) targets = filterTargets(items);
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

      case 'max-proposals-per-run': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 1) maxProposalsPerRun = n;
          // 0 or malformed: silently ignore, keep default 10
        }
        break;
      }

      // targets inline-list with no brackets (e.g. targets: repo-local) — single value
      case 'targets': {
        if (v && !v.startsWith('[')) {
          targets = filterTargets([v]);
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
    'max-proposals-per-run': maxProposalsPerRun,
  };
}
