/**
 * dispatcher-autonomy.mjs — Parser + resolver for the top-level
 * `dispatcher-autonomy:` YAML block (Epic #673 / issue #679).
 *
 * Returns `{ autonomy, "confidence-floor" }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * NOTE: `dispatcher-autonomy:` is a DISTINCT top-level sibling block, parsed
 * independent of the `## Session Config` section boundary (same posture as the
 * `skill-evolution:` block in skill-evolution.mjs). Do not confuse the two
 * blocks; this module only touches the `dispatcher-autonomy:` header.
 *
 * CAPS: cap keys are intentionally NOT parsed here — they belong to a later
 * issue (#682). This module owns `autonomy` + `confidence-floor` only.
 *
 * Consumers:
 *  - `scripts/lib/config.mjs` (wired in a later wave — reads parsed object and
 *    passes loadOwnerConfig() into resolveDispatcherAutonomy)
 *  - Skills that implement the cross-repo dispatcher autonomy gate
 */

const ALLOWED_AUTONOMY = ['off', 'advisory', 'autonomous-gated'];

/**
 * Parse the top-level `dispatcher-autonomy:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   autonomy:        'off'   (enum: off | advisory | autonomous-gated)
 *   confidence-floor: 0.5    (float in [0.0, 1.0])
 *
 * @param {string} content — full file contents
 * @returns {{ autonomy: string, "confidence-floor": number }}
 */
export function _parseDispatcherAutonomy(content) {
  const defaults = {
    autonomy: 'off',
    'confidence-floor': 0.5,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^dispatcher-autonomy:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let autonomy = 'off';
  let confidenceFloor = 0.5;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'autonomy': {
        const lower = v.toLowerCase();
        if (ALLOWED_AUTONOMY.includes(lower)) autonomy = lower;
        // else: silently fall back to default 'off'
        break;
      }
      case 'confidence-floor': {
        if (/^\d+(\.\d+)?$/.test(v)) {
          const f = parseFloat(v);
          if (Number.isFinite(f) && f >= 0.0 && f <= 1.0) confidenceFloor = f;
          // else: silently fall back to default 0.5
        }
        break;
      }
    }
  }

  return {
    autonomy,
    'confidence-floor': confidenceFloor,
  };
}

/**
 * Coerce a candidate autonomy value to a valid lowercase enum, or `undefined`
 * if it is unset/empty/whitespace/invalid (so the caller can fall through to
 * the next precedence tier — mirrors host-paths' empty-string-is-unset rule).
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function coerceAutonomy(value) {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).toLowerCase().trim();
  if (normalized === '') return undefined;
  return ALLOWED_AUTONOMY.includes(normalized) ? normalized : undefined;
}

/**
 * Resolve the EFFECTIVE dispatcher `autonomy` enum with precedence (highest
 * first). Mirrors the resolveHostPath precedence pattern from host-paths.mjs:
 * an invalid/empty/whitespace value at any tier is treated as "unset" and falls
 * through to the next tier.
 *
 * Precedence (highest first):
 *   1. env.SO_DISPATCHER_AUTONOMY  (host-local env-var override)
 *   2. ownerConfig.dispatcher.autonomy  (host-local owner.yaml — never committed)
 *   3. committed  (the `autonomy` value from _parseDispatcherAutonomy)
 *   4. 'off'  (fail-closed floor)
 *
 * The CALLER passes `ownerConfig` (config.mjs calls loadOwnerConfig) — this
 * module imports nothing, so there is zero cycle risk. Never throws.
 *
 * @param {{ committed?: unknown, env?: Record<string, string|undefined>, ownerConfig?: object }} [opts]
 * @returns {string} resolved lowercase enum string
 */
export function resolveDispatcherAutonomy({ committed, env = process.env, ownerConfig } = {}) {
  // Tier 1 — env-var override.
  const envVal = coerceAutonomy(env?.SO_DISPATCHER_AUTONOMY);
  if (envVal !== undefined) return envVal;

  // Tier 2 — owner.yaml dispatcher.autonomy (defensive: access may throw).
  let ownerRaw;
  try {
    ownerRaw = ownerConfig?.dispatcher?.autonomy;
  } catch {
    ownerRaw = undefined;
  }
  const ownerVal = coerceAutonomy(ownerRaw);
  if (ownerVal !== undefined) return ownerVal;

  // Tier 3 — committed Session Config value.
  const committedVal = coerceAutonomy(committed);
  if (committedVal !== undefined) return committedVal;

  // Tier 4 — fail-closed floor.
  return 'off';
}
