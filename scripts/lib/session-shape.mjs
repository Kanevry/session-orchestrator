/**
 * session-shape.mjs — the ONE place where a session mode becomes an execution
 * shape, plus the record that it did (#1146 pattern, applied to wave shaping).
 *
 * ## Why this module exists at all
 *
 * "How many waves does a `deep` session have, how many agents may each wave
 * dispatch, does Discovery run, what is the per-agent turn budget" was answered
 * in PROSE, in 27 places (measured 2026-09-09), and those places contradicted
 * each other in 8 of the answers. Prose cannot be called, cannot be tested, and
 * cannot record what it decided — so a housekeeping session that ran five waves
 * (6 such sessions measured across consumer repos) looked exactly like one that
 * ran the documented single loop.
 *
 * The shape therefore lives HERE, as a pure function, and records itself as it
 * is resolved. Wave 3 rewires the prose to CITE this module; the prose must not
 * re-derive the numbers, because a second derivation is a ninth contradiction
 * waiting to happen.
 *
 * ## Where the rules come from
 *
 * The ultradeep 7-wave table is the one `skills/session-plan/SKILL.md` § Role-to-Wave Mapping carried until 2026-09-09; since then this module is its SSOT and the prose cites it.
 * The deep raw caps 8/10/8/6/4 are the former `deep | complex` row of the
 * session-plan sizing table (retired from prose 2026-09-09; this module is the SSOT). Everything else is the operator's
 * decision of 2026-09-09, which OVERRIDES the prose it replaces — most notably:
 *
 *   - the `waves`-to-role mapping rows for 3 / 4 / 6+ waves are RETIRED. One
 *     session type has one natural wave count; a differing `waves` value is
 *     recorded in `notes`, never used to re-combine roles.
 *   - PRD AC-9 ("`waves < 7` is an error under the ultradeep profile") is
 *     DROPPED. Ultradeep ignores `waves` outright and says so in the result
 *     (`wavesConfigHonored: false`), which is strictly more useful than an
 *     error the operator has to repair before the session may start.
 *
 * ## Profile branching — the revisit trigger this module fires
 *
 * `scripts/lib/state-md.mjs:80-89` states that the `session-profile` vocabulary
 * is deliberately open "unlike `session_type`", with an explicit revisit
 * trigger: *"the first consumer that BRANCHES on a specific profile value — at
 * that point the set becomes load-bearing and belongs in a shared constant."*
 * `resolveSessionShape` is that first consumer, and this is that trigger firing.
 * It validates against `VALID_SESSION_PROFILES` (already a closed set in
 * `session-schema/constants.mjs`) and THROWS on an unknown profile rather than
 * degrading, because an unrecognised profile here would silently produce the
 * plain-deep 5-wave shape for a session the operator asked to run as 7.
 */

import { VALID_SESSION_TYPES, VALID_SESSION_PROFILES } from './session-schema/constants.mjs';
// The isolation/enforcement decision is NOT re-derived here. `wave-sizing.mjs`
// has owned it since #194 and imports only `session-schema/constants.mjs`
// (a declared leaf), so this stays a two-module chain with no cycle — which
// matters because this file is reachable from the SessionStart hook.
import { resolveIsolation, resolveEnforcement } from './wave-sizing.mjs';

/**
 * The one event name this module emits. A plain string LITERAL on purpose: the
 * events-schema census (`tests/lib/events-schema.test.mjs`) greps the source for
 * literals and cannot see a composed or imported name.
 */
export const SESSION_SHAPE_EVENT = 'orchestrator.session.shape_resolved';

/**
 * Shape-contract version. Bump when the returned object's SHAPE changes in a
 * way a consumer could break on; it travels in the event payload so a ledger
 * reader can tell which contract produced a record.
 */
export const SESSION_SHAPE_VERSION = 1;

/** Per-type default turn budget, applied when `max-turns` is `'auto'`. */
const MAX_TURNS_DEFAULT = Object.freeze({ housekeeping: 8, feature: 15, deep: 25 });

/**
 * The maintenance loop a housekeeping session IS. Recorded in `notes` so the
 * single-wave shape carries its own justification: this is not "a deep session
 * with four waves missing", it is a different kind of work.
 *
 * The array is in EXECUTION order, matching the numbered table in
 * `skills/wave-executor/SKILL.md` § "Housekeeping Sessions — the Maintenance
 * Loop". Order is load-bearing, not presentational: `drift-check` runs FIRST
 * because `evolve`/`reconcile`/`memory-cleanup` mutate the learnings store the
 * drift check reads, so a drift check running after them measures the tree the
 * loop just rewrote rather than the one the session inherited.
 */
const HOUSEKEEPING_LOOP = Object.freeze([
  'drift-check',
  'sweep',
  'evolve',
  'reconcile',
  'dialectic',
  'memory-cleanup',
]);

// ---------------------------------------------------------------------------
// Agent-cap resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the `agents-per-wave` Session Config value for one session type.
 *
 * The value is `number | {default: number, [type]: number}` — the second form
 * is what `_coerceInteger` in `scripts/lib/config/coercers.mjs` produces from
 * the documented override syntax `6 (deep: 18)`.
 *
 * THIS IS THE ONLY resolver of that shape (consolidated 2026-09-09). Its two
 * former private copies — `resolveApwCap` in `scripts/lib/wave-resource-gate.mjs`
 * and `resolveAgentsPerWaveCap` in `scripts/lib/resource-probe/evaluate.mjs` —
 * now import this function and call it with `MODE_BLIND_SESSION_TYPE`
 * (`undefined`), which falls back to `cap.default`: the SAFE direction for a
 * resource ceiling (never exceed the base cap). Wave shaping passes the real
 * session type, where `deep: 18` is exactly the number the operator configured.
 *
 * @param {number|{default?: number, [k: string]: number}|unknown} cap
 * @param {string} sessionType
 * @returns {number|null} the resolved cap, or null when nothing usable was given
 */
export function resolveAgentCap(cap, sessionType) {
  if (typeof cap === 'number') return Number.isFinite(cap) ? cap : null;
  if (cap === null || typeof cap !== 'object' || Array.isArray(cap)) return null;

  const record = /** @type {Record<string, unknown>} */ (cap);
  const specific = record[sessionType];
  if (typeof specific === 'number' && Number.isFinite(specific)) return specific;
  const fallback = record.default;
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : null;
}

/**
 * Ultradeep's cap lookup order: `ultradeep` → `deep` → `default`. An ultradeep
 * session IS a deep session (`session_type: 'deep'` + a profile), so a repo that
 * configured `6 (deep: 18)` and never heard of the profile must still get 18.
 *
 * @param {unknown} cap
 * @returns {number|null}
 */
function resolveUltradeepCap(cap) {
  if (cap !== null && typeof cap === 'object' && !Array.isArray(cap)) {
    const specific = /** @type {Record<string, unknown>} */ (cap).ultradeep;
    if (typeof specific === 'number' && Number.isFinite(specific)) return specific;
  }
  return resolveAgentCap(cap, 'deep');
}

// ---------------------------------------------------------------------------
// Wave tables
// ---------------------------------------------------------------------------

/**
 * Deep, no profile. Raw caps are the `deep | complex` row of the sizing table
 * (formerly `skills/session-plan/SKILL.md` § Agent Count by Tier, now owned here). ONE tier on purpose: the three-tier
 * simple/moderate/complex split was never resolvable from any value a caller
 * actually has, so it produced a range the coordinator picked from by feel —
 * which is where several of the 8 measured contradictions came from.
 */
const DEEP_WAVES = Object.freeze([
  { role: 'Discovery', raw: 8, writes: false, verification: 'none', allowedPaths: [] },
  { role: 'Impl-Core', raw: 10, writes: true, verification: 'incremental' },
  { role: 'Impl-Polish', raw: 8, writes: true, verification: 'incremental' },
  { role: 'Quality', raw: 6, writes: true, verification: 'full', qualityEarned: true },
  { role: 'Finalization', raw: 4, writes: true, verification: 'git-status' },
]);

/** Feature. No Discovery — a feature session starts from an agreed scope. */
const FEATURE_WAVES = Object.freeze([
  { role: 'Impl-Core', raw: 4, writes: true, verification: 'incremental' },
  {
    role: 'Impl-Polish+Quality',
    raw: 4,
    writes: true,
    verification: 'full',
    qualityEarned: true,
  },
  { role: 'Finalization', raw: 2, writes: true, verification: 'git-status' },
]);

/** Ultradeep — EXACTLY 7 waves (SSOT here; session-plan § Role-to-Wave Mapping cites this table). */
const ULTRADEEP_WAVES = Object.freeze([
  {
    role: 'Research+Code-Discovery',
    raw: 18,
    writes: false,
    verification: 'none',
    allowedPaths: [],
    maxTurns: 40,
  },
  {
    role: 'Synthesis-Gate',
    raw: 0,
    writes: false,
    verification: 'none',
    coordinatorDirect: true,
    maxTurns: null,
    blockingAsk: true,
    artifact: 'docs/audits/<YYYY-MM-DD>-<slug>.md',
  },
  { role: 'Impl-Core', raw: 8, writes: true, verification: 'incremental' },
  { role: 'Impl-Polish', raw: 8, writes: true, verification: 'incremental' },
  { role: 'Review-Panel', raw: 3, writes: false, verification: 'none', allowedPaths: [] },
  { role: 'Quality', raw: 6, writes: true, verification: 'full', qualityEarned: true },
  { role: 'Release/Finalization', raw: 4, writes: true, verification: 'git-status', maxTurns: 15 },
]);

// ---------------------------------------------------------------------------
// The resolution
// ---------------------------------------------------------------------------

/**
 * Build one wave record from a table row.
 *
 * @param {object} row
 * @param {number} n — 1-based wave number AFTER any renumbering
 * @param {number|null} capLimit — `agents-per-wave` ceiling, or null for none
 * @param {number} resolvedMaxTurns — the session-level per-agent turn budget
 * @param {object} isoOpts
 * @param {string} isoOpts.sessionType — the SHAPE type (never `'unknown'`)
 * @param {string} isoOpts.configIsolation — Session Config `isolation`
 * @param {string} isoOpts.configEnforcement — Session Config `enforcement`
 * @returns {object}
 */
function buildWave(row, n, capLimit, resolvedMaxTurns, isoOpts) {
  const coordinatorDirect = row.coordinatorDirect === true;
  const agentCapRaw = row.raw;
  const agentCap = coordinatorDirect
    ? 0
    : capLimit === null
      ? agentCapRaw
      : Math.min(agentCapRaw, capLimit);

  // A per-role override in the table wins over the session-level budget, in
  // BOTH directions: `maxTurns: null` on the Synthesis-Gate is a measured "no
  // agent runs here", not a missing value to be filled from the default.
  const maxTurns = Object.hasOwn(row, 'maxTurns') ? row.maxTurns : resolvedMaxTurns;

  // Isolation is PER WAVE, because the input that decides it — the agent count —
  // is per wave. A single session-level default was the bug: it read `none` for
  // a ten-agent deep Impl-Core wave, i.e. ten writing agents in ONE working
  // copy, while `resolveIsolation` (the real resolver, #194) says `worktree` for
  // every wave of ≥5 agents.
  //
  // Three cases resolve `none` WITHOUT asking `resolveIsolation`, because they
  // are not dispatches at all: a coordinator-direct wave, a read-only wave, and
  // a wave whose cap resolved below one agent (`resolveIsolation` rejects an
  // agentCount < 1 outright, and a worktree for nobody isolates nothing).
  const isolation =
    coordinatorDirect || row.writes !== true || agentCap < 1
      ? 'none'
      : resolveIsolation({
          agentCount: agentCap,
          sessionType: isoOpts.sessionType,
          collisionRisk: 'low',
          configIsolation: isoOpts.configIsolation,
        });
  const enforcement = resolveEnforcement({
    isolation,
    configEnforcement: isoOpts.configEnforcement,
  });

  return {
    n,
    role: row.role,
    coordinatorDirect,
    agentCap,
    agentCapRaw,
    writes: row.writes,
    maxTurns,
    isolation,
    enforcement,
    verification: row.verification,
    ...(row.qualityEarned === true ? { qualityEarned: true } : {}),
    ...(row.allowedPaths === undefined ? {} : { allowedPaths: [...row.allowedPaths] }),
    ...(row.blockingAsk === true ? { blockingAsk: true } : {}),
    ...(row.artifact === undefined ? {} : { artifact: row.artifact }),
  };
}

/**
 * Resolve a session mode into its execution shape. PURE — no I/O, no clock, no
 * ambient env. `resolveAndRecordSessionShape` is the wrapper that records it.
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionType] — one of `VALID_SESSION_TYPES`. `'unknown'`
 *   is the ABSENCE of a measurement (see the constant's docstring) and is shaped
 *   as `deep`: the widest shape is the safe reading of "nobody said".
 * @param {string|null} [opts.profile] — one of `VALID_SESSION_PROFILES`, or null.
 * @param {number} [opts.waves] — the Session Config `waves` value. Honoured only
 *   as a comparison baseline; see the module docstring.
 * @param {number|object} [opts.agentsPerWave] — the Session Config
 *   `agents-per-wave` value, in either of its two shapes.
 * @param {number|'auto'} [opts.maxTurns] — the Session Config `max-turns` value.
 * @param {boolean} [opts.knownScope] — deep only: the scope is already known, so
 *   the Discovery wave has nothing to discover and is dropped.
 * @param {'auto'|'worktree'|'none'} [opts.configIsolation] — the Session Config
 *   `isolation` value; default `'auto'`. Fed straight to `resolveIsolation`.
 * @param {'strict'|'warn'|'off'} [opts.configEnforcement] — the Session Config
 *   `enforcement` value; default `'warn'`. Fed straight to `resolveEnforcement`.
 * @returns {object} the shape
 * @throws {TypeError} on an unknown `sessionType`, `profile`, `configIsolation`
 *   or `configEnforcement`
 */
export function resolveSessionShape(opts = {}) {
  const {
    sessionType,
    profile = null,
    waves = 5,
    agentsPerWave = 6,
    maxTurns = 'auto',
    knownScope = false,
    configIsolation = 'auto',
    configEnforcement = 'warn',
  } = opts;

  if (typeof sessionType !== 'string' || !VALID_SESSION_TYPES.includes(sessionType)) {
    throw new TypeError(
      `session-shape: unknown sessionType ${JSON.stringify(sessionType)} ` +
        `(expected one of ${VALID_SESSION_TYPES.join(', ')})`,
    );
  }
  if (profile !== null && profile !== undefined) {
    if (typeof profile !== 'string' || !VALID_SESSION_PROFILES.includes(profile)) {
      throw new TypeError(
        `session-shape: unknown profile ${JSON.stringify(profile)} ` +
          `(expected one of ${VALID_SESSION_PROFILES.join(', ')}, or null)`,
      );
    }
  }

  const effectiveProfile = profile ?? null;
  // `unknown` is not a fourth mode — it is "not measured". Shape it as deep.
  const shapeType = sessionType === 'unknown' ? 'deep' : sessionType;
  const maxTurnsDefault = MAX_TURNS_DEFAULT[shapeType];
  const resolvedMaxTurns =
    typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0
      ? maxTurns
      : maxTurnsDefault;

  /** @type {string[]} */ const notes = [];
  const isUltradeep = effectiveProfile === 'ultradeep';

  let table;
  let discovery;
  let coordinatorDirect = false;
  let wavesConfigHonored = true;
  let wavesConfigIgnoredValue;

  if (shapeType === 'housekeeping') {
    table = [
      {
        role: 'Housekeeping',
        raw: 0,
        writes: true,
        verification: 'full',
        coordinatorDirect: true,
        maxTurns: null,
      },
    ];
    discovery = false;
    coordinatorDirect = true;
    notes.push(
      `housekeeping is the maintenance loop, in execution order: ${HOUSEKEEPING_LOOP.join(', ')}`,
    );
  } else if (shapeType === 'feature') {
    table = FEATURE_WAVES;
    discovery = false;
  } else if (isUltradeep) {
    table = ULTRADEEP_WAVES;
    discovery = true;
    wavesConfigHonored = false;
    wavesConfigIgnoredValue = waves;
    notes.push(
      `waves: ${waves} configured; the ultradeep profile is a fixed 7-wave shape ` +
        '(scripts/lib/session-shape.mjs, ULTRADEEP table) and ignores the value. PRD AC-9 ' +
        '("waves < 7 is an error") was dropped 2026-09-09.',
    );
  } else {
    table = knownScope ? DEEP_WAVES.slice(1) : DEEP_WAVES;
    discovery = !knownScope;
    if (knownScope) {
      notes.push('knownScope: true — the Discovery wave is dropped and the rest renumbered.');
    }
  }

  const capLimit = isUltradeep
    ? resolveUltradeepCap(agentsPerWave)
    : resolveAgentCap(agentsPerWave, shapeType);

  // A cap of 0 is not a small plan, it is a plan that dispatches NOBODY — and
  // without this note the resulting shape (every `agentCap: 0`) is textually
  // indistinguishable from a normal one, so the coordinator reads it as agreed.
  if (capLimit !== null && capLimit < 1) {
    notes.push(
      `agents-per-wave resolves to ${capLimit} — every wave would dispatch nobody; ` +
        'check Session Config',
    );
  }

  const waveRecords = table.map((row, i) =>
    buildWave(row, i + 1, capLimit, resolvedMaxTurns, {
      sessionType: shapeType,
      configIsolation,
      configEnforcement,
    }),
  );
  const totalWaves = waveRecords.length;

  // A `waves` value that disagrees with the shape's natural count is RECORDED,
  // never obeyed — the role-combination rows it used to drive (3 / 4 / 6+) were
  // retired 2026-09-09 because they were a second, contradicting definition of
  // what each role does.
  if (wavesConfigHonored && Number.isFinite(waves) && waves !== totalWaves) {
    notes.push(
      `waves: ${waves} configured; ${shapeType} shape is ${totalWaves} ` +
        '(role-combination splitting retired 2026-09-09)',
    );
  }

  return {
    version: SESSION_SHAPE_VERSION,
    sessionType,
    profile: effectiveProfile,
    totalWaves,
    wavesConfigHonored,
    ...(wavesConfigIgnoredValue === undefined ? {} : { wavesConfigIgnoredValue }),
    discovery,
    coordinatorDirect,
    maxTurnsDefault,
    waves: waveRecords,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * Read a Session Config value, tolerating a non-object config.
 *
 * @param {unknown} config
 * @param {string} key
 * @returns {unknown}
 */
function readConfigKey(config, key) {
  if (config === null || typeof config !== 'object') return undefined;
  return /** @type {Record<string, unknown>} */ (config)[key];
}

/**
 * Append the shape record. Best-effort in the strict sense — it can never
 * change, delay past its own await, or throw into the shape.
 *
 * `events.mjs` is imported LAZILY for the same measured reason
 * `scripts/lib/express-path.mjs` gives: a static import drags in `platform.mjs`,
 * which runs filesystem walk-ups at MODULE LOAD, onto every consumer that only
 * wants the pure resolver. The lazy form also puts the telemetry module's own
 * load inside the try/catch.
 *
 * @param {string|undefined} repoRoot
 * @param {object} shape
 * @param {number|null|undefined} taskCount
 * @returns {Promise<void>}
 */
async function _emitShapeResolved(repoRoot, shape, taskCount) {
  // Refuse the SO_PROJECT_DIR fallback rather than guess a destination: without
  // an explicit repoRoot, `emitEvent` writes to whatever tree the ambient env
  // resolves to. A skipped record is recoverable; a record in the wrong ledger
  // is not (#941).
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    process.stderr.write(
      `session-shape: skipped ${SESSION_SHAPE_EVENT} — no repoRoot given; ` +
        'refusing the ambient SO_PROJECT_DIR destination (#941).\n',
    );
    return;
  }

  const payload = {
    session_type: shape.sessionType,
    // Omitted, never written as null/'' — an absent key is the only honest
    // encoding of "this session has no profile".
    ...(shape.profile === null ? {} : { session_profile: shape.profile }),
    total_waves: shape.totalWaves,
    waves_config_honored: shape.wavesConfigHonored,
    discovery: shape.discovery,
    agent_caps: shape.waves.map((w) => w.agentCap),
    coordinator_direct_waves: shape.waves.filter((w) => w.coordinatorDirect).map((w) => w.n),
    shape_version: shape.version,
    ...(Number.isInteger(taskCount) && taskCount >= 0 ? { task_count: taskCount } : {}),
  };

  try {
    const { emitEvent, sessionAttribution } = await import('./events.mjs');
    await emitEvent(SESSION_SHAPE_EVENT, { ...payload, ...sessionAttribution(repoRoot) }, { repoRoot });
  } catch {
    // Best-effort telemetry — the shape is authoritative whether or not the
    // ledger accepted the record.
  }
}

/**
 * Resolve the shape from a `parseSessionConfig()` result AND record it.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — repo whose `.orchestrator/metrics/events.jsonl`
 *   receives the record. REQUIRED for the record; the shape is returned regardless.
 * @param {object} [opts.config] — a `parseSessionConfig()` result. Read for
 *   `waves`, `agents-per-wave`, `max-turns`, `isolation` and `enforcement` only.
 * @param {string} [opts.sessionType]
 * @param {string|null} [opts.profile]
 * @param {boolean} [opts.knownScope]
 * @param {number|null} [opts.taskCount]
 * @param {boolean} [opts.emit] — default true. `false` resolves without touching
 *   the ledger; the CLI's `--no-event` planning dry-run is the only caller that
 *   sets it, and it exists so a dry-run cannot leave a record claiming a session
 *   was shaped.
 * @returns {Promise<object>} the shape
 */
export async function resolveAndRecordSessionShape(opts = {}) {
  const { repoRoot, config, sessionType, profile, knownScope, taskCount, emit = true } = opts;

  const wavesValue = readConfigKey(config, 'waves');
  const agentsValue = readConfigKey(config, 'agents-per-wave');
  const maxTurnsValue = readConfigKey(config, 'max-turns');
  const isolationValue = readConfigKey(config, 'isolation');
  const enforcementValue = readConfigKey(config, 'enforcement');

  const shape = resolveSessionShape({
    sessionType,
    profile: profile ?? null,
    ...(wavesValue === undefined ? {} : { waves: wavesValue }),
    ...(agentsValue === undefined ? {} : { agentsPerWave: agentsValue }),
    ...(maxTurnsValue === undefined ? {} : { maxTurns: maxTurnsValue }),
    ...(isolationValue === undefined ? {} : { configIsolation: isolationValue }),
    ...(enforcementValue === undefined ? {} : { configEnforcement: enforcementValue }),
    knownScope: knownScope === true,
  });

  if (emit !== false) await _emitShapeResolved(repoRoot, shape, taskCount);

  return shape;
}
