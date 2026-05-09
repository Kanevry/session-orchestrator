/**
 * autopilot/flags.mjs — Flag parsing and bounds constants for the autopilot loop.
 *
 * Extracted from autopilot.mjs as part of the W1A6 decomposition.
 * Leaf module: no imports from other autopilot submodules.
 *
 * Exports:
 *   FLAG_BOUNDS                — frozen bounds+defaults for numeric CLI flags
 *   DEFAULT_PEER_ABORT_THRESHOLD
 *   DEFAULT_JSONL_PATH
 *   DEFAULT_CARRYOVER_THRESHOLD
 *   parseFlags(argv)           — silent-clamp argv → opts object
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FLAG_BOUNDS = Object.freeze({
  maxSessions: { min: 1, max: 50, default: 5 },
  maxHours: { min: 0.5, max: 24.0, default: 4.0 },
  confidenceThreshold: { min: 0.0, max: 1.0, default: 0.85 },
  maxTokens: { min: 0, max: 10_000_000, default: 500_000 },
});

/** Default peer Claude-process count above which `resource-overload` fires when verdict is critical. */
export const DEFAULT_PEER_ABORT_THRESHOLD = 6;

/** Default JSONL path for autopilot loop records. */
export const DEFAULT_JSONL_PATH = '.orchestrator/metrics/autopilot.jsonl';

/** Default carryover ratio threshold above which `carryover-too-high` fires post-session. */
export const DEFAULT_CARRYOVER_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clampNumber(value, { min, max, fallback }) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseNumeric(raw) {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/**
 * Parse `/autopilot` argv into an opts object. Out-of-range numeric flags clamp
 * silently to bounds. Unknown flags are ignored. `--dry-run` is a boolean flag.
 *
 * @param {string[]} argv — argument tokens (e.g. ['--max-sessions=3', '--dry-run'])
 * @returns {{maxSessions: number, maxHours: number, confidenceThreshold: number, dryRun: boolean}}
 */
export function parseFlags(argv) {
  const tokens = Array.isArray(argv) ? argv : [];

  let rawSessions = null;
  let rawHours = null;
  let rawConfidence = null;
  let dryRun = false;

  for (const tok of tokens) {
    if (typeof tok !== 'string') continue;
    if (tok === '--dry-run' || tok === '--dryRun') {
      dryRun = true;
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq === -1) continue;
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    if (key === '--max-sessions') rawSessions = parseNumeric(val);
    else if (key === '--max-hours') rawHours = parseNumeric(val);
    else if (key === '--confidence-threshold') rawConfidence = parseNumeric(val);
  }

  return {
    maxSessions: Math.floor(clampNumber(rawSessions, {
      min: FLAG_BOUNDS.maxSessions.min,
      max: FLAG_BOUNDS.maxSessions.max,
      fallback: FLAG_BOUNDS.maxSessions.default,
    })),
    maxHours: clampNumber(rawHours, {
      min: FLAG_BOUNDS.maxHours.min,
      max: FLAG_BOUNDS.maxHours.max,
      fallback: FLAG_BOUNDS.maxHours.default,
    }),
    confidenceThreshold: clampNumber(rawConfidence, {
      min: FLAG_BOUNDS.confidenceThreshold.min,
      max: FLAG_BOUNDS.confidenceThreshold.max,
      fallback: FLAG_BOUNDS.confidenceThreshold.default,
    }),
    dryRun,
  };
}
