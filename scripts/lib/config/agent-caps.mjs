import { matchBlockHeader } from './block-header.mjs';
import { preprocessBlockLines } from './block-preprocess.mjs';
import {
  BRAKE_ENGAGE_PCT,
  BRAKE_RELEASE_PCT,
  CLASS_READING,
  CLASS_STARTING,
  ORIGIN_DEFAULT,
  ORIGIN_SESSION_CONFIG,
  STANDARD_CAPS,
} from '../agent-cap.mjs';

/**
 * agent-caps.mjs — Parser + resolver for the top-level `agent-caps:` YAML block:
 * the configurable values behind `hooks/pre-agent-cap.mjs`.
 *
 * Every field resolves on its own, highest first (the #653 pattern of
 * `dispatcher-autonomy.mjs`):
 *   1. env (`SO_AGENT_CAP_PROCESS_STARTING`, `SO_AGENT_CAP_READING`,
 *      `SO_AGENT_BRAKE_ENGAGE_PCT`, `SO_AGENT_BRAKE_RELEASE_PCT`)
 *   2. owner.yaml `agent-caps.*` (host-local, never committed)
 *   3. committed `agent-caps:` block
 *   4. the default (6 + 6, brake 15/20)
 *
 * Empty means unset. An invalid value warns on stderr and falls through to the
 * next tier, so a typo never crashes a dispatch and never switches a guard off.
 *
 * Values: a cap is an integer from 1, or `off`; 0 is rejected because it would
 * block every dispatch of the class. `brake-engage-pct` is 1..99 or `off`,
 * `brake-release-pct` is 1..99 and must not lie below the engage value.
 */

/** Keys of the block. Mirrored in `owner-yaml.mjs`, which must stay import-light. */
export const AGENT_CAP_KEYS = Object.freeze(['process-starting', 'reading', 'brake-engage-pct', 'brake-release-pct']);

/** Re-arm band when only `brake-engage-pct` is set: the 15/20 of the default. */
const RELEASE_GAP_PCT = 5;

const MAX_PCT = 99;

/** Longer lines are skipped: the regexes below backtrack quadratically on long runs of spaces. */
const MAX_LINE_LENGTH = 200;

/** Rank of a value no tier set (the tiers are 0, 1, 2). */
const RANK_DEFAULT = 3;

const UNSET = Symbol('unset');
const INVALID = Symbol('invalid');

/**
 * Parse the top-level `agent-caps:` block from markdown content. Independent of
 * the `## Session Config` section boundary. Returns the raw strings of the keys
 * present; the resolver judges them, so all tiers warn the same way.
 *
 * @param {string} content — full file contents
 * @returns {Record<string, string>}
 */
export function _parseAgentCaps(content) {
  const out = {};
  let inBlock = false;
  for (const rawLine of preprocessBlockLines(content)) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'agent-caps')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    if (line.length > MAX_LINE_LENGTH) continue;
    const m = line.replace(/\s*#.*$/, '').match(/^\s+([a-zA-Z_-]+):\s*(.*?)\s*$/);
    if (m && AGENT_CAP_KEYS.includes(m[1])) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * @param {unknown} raw
 * @param {'cap'|'engage'|'release'} kind
 * @returns {number|null|typeof UNSET|typeof INVALID} a cap's `off` is `Infinity`, the brake's is `null`
 */
function parseValue(raw, kind) {
  if (raw === null || raw === undefined) return UNSET;
  const text = String(raw).trim().toLowerCase();
  if (text === '') return UNSET;
  // `false` too: a YAML 1.1 reader turns a bare `off` into a boolean.
  if ((text === 'off' || text === 'false') && kind !== 'release') return kind === 'cap' ? Infinity : null;
  if (!/^\d+$/.test(text)) return INVALID;
  const n = Number.parseInt(text, 10);
  const inRange = kind === 'cap' ? n >= 1 : n >= 1 && n <= MAX_PCT;
  return inRange ? n : INVALID;
}

/**
 * @param {{ key: string, envName: string, kind: 'cap'|'engage'|'release', fallback: number }} field
 * @param {{ env: Record<string, string|undefined>, owner: Record<string, unknown>, committed: Record<string, unknown>,
 *   warn: (line: string) => void }} ctx
 * @returns {{ value: number|null, origin: string, rank: number }}
 */
function resolveField({ key, envName, kind, fallback }, { env, owner, committed, warn }) {
  const tiers = [
    [`Env ${envName}`, env?.[envName]],
    [`owner.yaml agent-caps.${key}`, owner[key]],
    [`${ORIGIN_SESSION_CONFIG} agent-caps.${key}`, committed[key]],
  ];
  for (const [rank, [origin, raw]] of tiers.entries()) {
    const value = parseValue(raw, kind);
    if (value === UNSET) continue;
    if (value === INVALID) {
      warn(`⚠ agent-caps: ${origin} = ${JSON.stringify(raw)} is invalid and ignored\n`);
      continue;
    }
    return { value, origin, rank };
  }
  return { value: fallback, origin: ORIGIN_DEFAULT, rank: RANK_DEFAULT };
}

/**
 * Resolve the effective settings. Never throws.
 *
 * @param {{ committed?: Record<string, unknown>, env?: Record<string, string|undefined>, ownerConfig?: object,
 *   warn?: (line: string) => void }} [opts]
 * @returns {import('../agent-cap.mjs').CapSettings}
 */
export function resolveAgentCapSettings({ committed = {}, env = process.env, ownerConfig, warn = (l) => process.stderr.write(l) } = {}) {
  let owner = {};
  try {
    const section = /** @type {any} */ (ownerConfig)?.['agent-caps'];
    if (section !== null && typeof section === 'object') owner = section;
  } catch { /* no owner tier */ }
  const ctx = { env, owner, committed, warn };

  const starting = resolveField({ key: 'process-starting', envName: 'SO_AGENT_CAP_PROCESS_STARTING', kind: 'cap', fallback: STANDARD_CAPS[CLASS_STARTING] }, ctx);
  const reading = resolveField({ key: 'reading', envName: 'SO_AGENT_CAP_READING', kind: 'cap', fallback: STANDARD_CAPS[CLASS_READING] }, ctx);
  let engage = resolveField({ key: 'brake-engage-pct', envName: 'SO_AGENT_BRAKE_ENGAGE_PCT', kind: 'engage', fallback: BRAKE_ENGAGE_PCT }, ctx);
  let release = resolveField({ key: 'brake-release-pct', envName: 'SO_AGENT_BRAKE_RELEASE_PCT', kind: 'release', fallback: BRAKE_RELEASE_PCT }, ctx);

  const engageDefault = { value: BRAKE_ENGAGE_PCT, origin: ORIGIN_DEFAULT, rank: RANK_DEFAULT };
  const bandAbove = (/** @type {{ value: number, origin: string, rank: number }} */ e) => (
    { value: Math.min(MAX_PCT, e.value + RELEASE_GAP_PCT), origin: e.origin, rank: e.rank }
  );

  if (engage.value === null) {
    release = { value: null, origin: engage.origin, rank: engage.rank };
  } else if (release.origin === ORIGIN_DEFAULT) {
    // Only the engage value was set: keep the default band, so raising it alone
    // can never invert the pair.
    if (engage.origin !== ORIGIN_DEFAULT) release = bandAbove(/** @type {any} */ (engage));
  } else if (/** @type {number} */ (release.value) < engage.value) {
    warn(`⚠ agent-caps: brake-release-pct (${release.value}, ${release.origin}) must not lie below brake-engage-pct (${engage.value}, ${engage.origin}) — the lower-ranked value is dropped\n`);
    if (engage.rank < release.rank) {
      release = bandAbove(/** @type {any} */ (engage));
    } else if (release.rank < engage.rank && BRAKE_ENGAGE_PCT <= /** @type {number} */ (release.value)) {
      engage = engageDefault;
    } else {
      // Same rank, or the default engage value is itself above the release value.
      engage = engageDefault;
      release = { value: BRAKE_RELEASE_PCT, origin: ORIGIN_DEFAULT, rank: RANK_DEFAULT };
    }
  }

  return {
    caps: /** @type {any} */ ({ [CLASS_STARTING]: starting.value, [CLASS_READING]: reading.value }),
    brake: { engagePct: engage.value, releasePct: release.value },
    origins: /** @type {any} */ ({
      [CLASS_STARTING]: starting.origin,
      [CLASS_READING]: reading.origin,
      engagePct: engage.origin,
      releasePct: release.origin,
    }),
  };
}
