/**
 * express-path.mjs — the Express Path activation DECISION plus its record (#214, #1119).
 *
 * ## Why this module exists at all
 *
 * The Express Path (session-start Phase 8.5) was built as prose and nothing else.
 * Two measurements on 2026-08-23 pinned what that cost:
 *
 *   grep -c "express" scripts/lib/config.mjs                       → 0   (506 lines)
 *   grep -c "express" .orchestrator/metrics/events.jsonl           → 0   (whole history)
 *
 * The second number is the real defect. `express-path.enabled` had no parser, so
 * the documented default was prose rather than a value — but even a wired key only
 * answers "what was configured". Nothing anywhere answered "did it fire?", and
 * 22 of the last 30 sessions ran wave-less housekeeping without a single record
 * saying whether the path applied to any of them.
 *
 * So the decision lives HERE, in code, and records itself as it is made. The prose
 * in `skills/session-start/phase-8-5-express-path.md` points at this function; it
 * does not re-implement the rule and it does not emit the event. A telemetry
 * emitter that fires only when a coordinator reads the right paragraph is not
 * wired — that is the same class of defect wave 2 of this session repaired for 18
 * discovery probes.
 *
 * ## Where the rule comes from
 *
 * The three activation conditions are quoted verbatim from
 * `skills/session-start/phase-8-5-express-path.md:9-11` and cross-checked against
 * `docs/session-config-reference.md:1532-1536`. Both sources agree. The condition
 * matrix in the same two files (spec `:47-53`, reference `:1557-1563`) supplies the
 * fourth input, `parallelAgentsRequired`, which condition 3 carries as its second
 * clause ("AND no parallel agents are required").
 *
 * ## Module placement — a deviation, and its cause
 *
 * Every other top-level Session Config block parser lives at
 * `scripts/lib/config/<key>.mjs` (42 files). `_parseExpressPath` sits here instead
 * because this agent's declared file scope for #1119 named `scripts/lib/express-path.mjs`
 * and did not include `scripts/lib/config/`. The parser is otherwise a byte-for-byte
 * sibling of `config/state-md-lock.mjs` — same block walk, same `matchBlockHeader`
 * adoption (#830), same tolerant fallbacks. It imports only `./config/block-header.mjs`,
 * which has zero imports by design, so no cycle is possible in either direction.
 * Revisit trigger: if a later session is free to touch `scripts/lib/config/`, move
 * `_parseExpressPath` to `scripts/lib/config/express-path.mjs` and leave only
 * `evaluateExpressPath` here.
 */

import { matchBlockHeader } from './config/block-header.mjs';

/**
 * The one event name this module emits. Named, not inlined, so a consumer that
 * queries the ledger and the producer that writes it cannot drift apart.
 * Matches `ORCHESTRATOR_EVENT_RE` in `events-schema.mjs`.
 */
export const EXPRESS_PATH_EVENT = 'orchestrator.express_path.evaluated';

/**
 * Condition 3, first clause: "Agreed issue scope is ≤ 3 issues"
 * (`skills/session-start/phase-8-5-express-path.md:11`).
 */
export const EXPRESS_PATH_MAX_TASKS = 3;

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Parse the top-level `express-path:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary, exactly like the
 * sibling block parsers under `scripts/lib/config/`.
 *
 * Defaults:
 *   enabled: true   (documented in docs/session-config-reference.md:1528 —
 *                   "opt-in by default, opt-out via express-path.enabled: false")
 *
 * Because the default is `true`, only a literal `false` flips it — mirroring
 * `config/state-md-lock.mjs`, whose `enabled` default is also `true`. (The
 * `=== 'true'` form used by `config/discovery-validator.mjs` is the opposite
 * convention and belongs to a default-`false` key.)
 *
 * Tolerant parser: malformed values silently fall back to the default.
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean }}
 */
export function _parseExpressPath(content) {
  const defaults = {
    enabled: true,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'express-path')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let epEnabled = true;

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
      case 'enabled':
        // Default is true → only flip to false on explicit "false"
        epEnabled = v.toLowerCase() !== 'false';
        break;
    }
  }

  return {
    enabled: epEnabled,
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Read `express-path.enabled` out of a `parseSessionConfig()` result.
 *
 * Returns `undefined` — NOT `true` — when the flag was never measured, so the
 * caller can distinguish "the operator set true" from "nobody looked". The
 * documented default is applied to the DECISION; the absent measurement is kept
 * out of the RECORD.
 *
 * @param {unknown} config — a `parseSessionConfig()` result, or anything else
 * @returns {boolean|undefined}
 */
function _readEnabledFlag(config) {
  if (config === null || typeof config !== 'object') return undefined;
  const block = /** @type {Record<string, unknown>} */ (config)['express-path'];
  if (block === null || typeof block !== 'object') return undefined;
  const value = /** @type {Record<string, unknown>} */ (block).enabled;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Build the event payload. Every optional field is spread conditionally:
 * a value that was not measured is OMITTED, never encoded as `0`/`false`.
 * An absent key is the only honest encoding of "not measured" — the same
 * contract `sessionAttribution()` in `events.mjs` follows for session ids.
 *
 * @param {object} ctx
 * @returns {Record<string, unknown>}
 */
function _buildPayload(ctx) {
  const { activated, reasons, enabledMeasured, sessionType, taskCount, parallelAgentsRequired } = ctx;
  const sessionTypeMeasured = typeof sessionType === 'string' && sessionType.trim() !== '';
  const taskCountMeasured = Number.isInteger(taskCount) && taskCount >= 0;

  return {
    activated,
    reasons,
    ...(enabledMeasured === undefined ? {} : { enabled: enabledMeasured }),
    ...(sessionTypeMeasured ? { session_type: sessionType.trim() } : {}),
    ...(taskCountMeasured ? { task_count: taskCount } : {}),
    ...(typeof parallelAgentsRequired === 'boolean'
      ? { parallel_agents_required: parallelAgentsRequired }
      : {}),
  };
}

/**
 * Append the evaluation record. Best-effort in the strict sense: it can never
 * change, delay past its own await, or throw into the verdict.
 *
 * `events.mjs` is imported LAZILY on purpose, and the reason is measured rather
 * than stylistic. `scripts/lib/config.mjs` imports this module for its parser,
 * and its static import graph is 48 files today with no telemetry or platform
 * modules in it. A static `import './events.mjs'` would add `platform.mjs`,
 * which runs filesystem walk-ups at MODULE LOAD (`SO_PROJECT_DIR =
 * resolveProjectDir(...)`) — paid by every hook and script that merely reads
 * config. The lazy form also puts the telemetry module's own load inside the
 * try/catch, so a broken events stack cannot stop the decision from being made.
 *
 * @param {object} ctx — see `_buildPayload`, plus `repoRoot`
 * @returns {Promise<void>}
 */
async function _emitEvaluated(ctx) {
  const { repoRoot } = ctx;

  // Refuse the SO_PROJECT_DIR fallback rather than guess a destination. Without
  // an explicit repoRoot, `emitEvent` writes to whatever tree the ambient env
  // resolves to — which in wave 1 of this session put a synthetic record into
  // the operator's real fleet ledger. A skipped record is recoverable; a record
  // in the wrong ledger is not. Diagnostics on stderr, never stdout.
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    process.stderr.write(
      `express-path: skipped ${EXPRESS_PATH_EVENT} — no repoRoot given; ` +
        'refusing the ambient SO_PROJECT_DIR destination (#941).\n',
    );
    return;
  }

  try {
    const { emitEvent, sessionAttribution } = await import('./events.mjs');
    await emitEvent(
      EXPRESS_PATH_EVENT,
      { ..._buildPayload(ctx), ...sessionAttribution(repoRoot) },
      { repoRoot },
    );
  } catch {
    // Best-effort telemetry — the verdict below is authoritative and is
    // returned whether or not the ledger accepted the record.
  }
}

/**
 * @typedef {object} ExpressPathVerdict
 * @property {boolean} activated — true only when every condition below holds.
 * @property {string[]} reasons — when NOT activated, the blocking condition
 *   codes and nothing else: the answer to "why didn't it fire". When activated,
 *   the satisfied codes, since all of them decided jointly. Stable, greppable
 *   slugs — they are the query key for the ledger.
 */

/**
 * Evaluate the Express Path activation conditions and record the evaluation.
 *
 * The three conditions, quoted from `skills/session-start/phase-8-5-express-path.md:9-11`:
 *
 *   1. "`express-path.enabled` is `true` in Session Config (default: `true` —
 *      opt-in by default, opt-out via `express-path.enabled: false`)."
 *   2. "Session type is `housekeeping` (the user confirmed `housekeeping` in Phase 8)."
 *   3. "Agreed issue scope is ≤ 3 issues AND no parallel agents are required
 *      (i.e., tasks are sequential, no wave decomposition needed)."
 *
 * Every condition is evaluated — none short-circuits — because a run blocked by
 * two conditions is a different fact from one blocked by a single condition, and
 * the ledger is the only place that difference can ever be read.
 *
 * Fail-closed on an unmeasured input: an unknown session type or an unknown task
 * count BLOCKS activation (`session-type-unknown` / `task-count-unknown`) rather
 * than defaulting into a fast path that skips every quality gate. `enabled` is
 * the one exception — its documented default is `true`, so an absent config
 * applies that default to the decision while omitting `enabled` from the record.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — repo whose `.orchestrator/metrics/events.jsonl`
 *   receives the record. REQUIRED for the record to be written; when absent the
 *   verdict is still returned and a WARN goes to stderr (see `_emitEvaluated`).
 * @param {object} [opts.config] — a `parseSessionConfig()` result. Read for
 *   `config['express-path'].enabled` only.
 * @param {string} [opts.sessionType] — the session type confirmed in Phase 8.
 * @param {number} [opts.taskCount] — agreed issue/task scope (non-negative integer).
 * @param {boolean} [opts.parallelAgentsRequired] — whether the agreed tasks need
 *   parallel agents. Omitting it asserts nothing: the condition is treated as
 *   satisfied (`parallel-agents-not-asserted`) and the field is left out of the
 *   record, because "nobody said parallel agents are needed" is not the same
 *   claim as "it was measured that none are needed".
 * @returns {Promise<ExpressPathVerdict>}
 */
export async function evaluateExpressPath(opts = {}) {
  const { repoRoot, config, sessionType, taskCount, parallelAgentsRequired } = opts;

  const enabledMeasured = _readEnabledFlag(config);
  const enabled = enabledMeasured === undefined ? true : enabledMeasured;

  /** @type {string[]} */ const satisfied = [];
  /** @type {string[]} */ const blocking = [];

  // Condition 1 — express-path.enabled
  if (enabled) satisfied.push('enabled');
  else blocking.push('disabled-by-config');

  // Condition 2 — session type is housekeeping
  if (typeof sessionType !== 'string' || sessionType.trim() === '') {
    blocking.push('session-type-unknown');
  } else if (sessionType.trim() === 'housekeeping') {
    satisfied.push('session-type-housekeeping');
  } else {
    blocking.push('session-type-not-housekeeping');
  }

  // Condition 3a — scope ≤ EXPRESS_PATH_MAX_TASKS issues
  if (!Number.isInteger(taskCount) || taskCount < 0) {
    blocking.push('task-count-unknown');
  } else if (taskCount > EXPRESS_PATH_MAX_TASKS) {
    blocking.push('scope-exceeds-limit');
  } else {
    satisfied.push('scope-within-limit');
  }

  // Condition 3b — no parallel agents required
  if (parallelAgentsRequired === true) {
    blocking.push('parallel-agents-required');
  } else if (parallelAgentsRequired === false) {
    satisfied.push('no-parallel-agents');
  } else {
    satisfied.push('parallel-agents-not-asserted');
  }

  const activated = blocking.length === 0;
  const reasons = activated ? satisfied : blocking;

  await _emitEvaluated({
    repoRoot,
    activated,
    reasons,
    enabledMeasured,
    sessionType,
    taskCount,
    parallelAgentsRequired,
  });

  return { activated, reasons };
}
