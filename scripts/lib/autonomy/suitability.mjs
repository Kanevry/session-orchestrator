/**
 * autonomy/suitability.mjs — pure four-gate suitability verdict for autonomous
 * dispatch (GitLab issue #680, Epic #673 cross-repo dispatcher).
 *
 * `computeSuitabilityVerdict(deps)` answers ONE question: "is this repo/run a
 * SAFE candidate for autonomous action right now?" It is a pure decision function
 * over four AND-composed gates — confidence, kill-switch rate, CI status, and
 * resource verdict. Every signal is INJECTED by the caller (the dispatcher); the
 * engine reads no files and calls nothing external (no checkCiStatus / evaluate /
 * selectMode). The dispatcher supplies the snapshots; this module only judges them.
 *
 * THE FOUR-GATE CONTRACT (suitable = G1 && G2 && G3 && G4):
 *   G1 confidenceOk        = Number.isFinite(confidence) && confidence >= confidenceFloor
 *                            (fail-closed: null/undefined/NaN ⇒ false)
 *   G2 killSwitchOk        = recentRuns.length < 5 ? PASS (omitted, warned)
 *                            : (fired / N) < 0.2
 *                            (non-array recentRuns ⇒ [] ⇒ omitted+warned; malformed
 *                             run records / non-string kill_switch ⇒ NOT-fired)
 *   G3 ciNotRed            = ci.status !== 'red'   (null, 'unknown', AND malformed
 *                            ci — non-object / missing status / non-string status —
 *                            are "no signal" ⇒ pass + warn)
 *   G4 resourceNotCritical = String(resourceVerdict).toLowerCase().trim() !== 'critical'
 *                            (green/warn/degraded/null pass; 'CRITICAL' IS caught;
 *                             non-string ⇒ "no signal" ⇒ pass + warn)
 *
 *   PRD override "CI red OR resource critical ⇒ non-suitable REGARDLESS of
 *   confidence" needs no special branch — it is satisfied by the pure AND. The
 *   `forcedFail` flag is computed ONLY to word the rationale.
 *
 * Mirrors engine.mjs: the `Number.isFinite && >=` fail-closed gate, the
 * [0,1]-clamped floor coercion (default 0.5, NEVER 0), the `detailParts.join('; ')`
 * rationale style (engine.mjs L481-485), and the never-throws contract.
 *
 * Pure + DI, NEVER throws, NO I/O. NOT wired into dispatcher launch this session
 * (that is #682). No imports beyond node builtins (none needed).
 */

const DEFAULT_CONFIDENCE_FLOOR = 0.5;
const KILL_SWITCH_MIN_RUNS = 5; // below this the kill-switch gate is OMITTED (treated as PASS)
const KILL_SWITCH_MAX_RATE = 0.2; // fired/N must be strictly below this

/**
 * @typedef {Object} SuitabilityDeps
 * @property {'off'|'advisory'|'autonomous-gated'} [autonomy]
 *           Autonomy dial. Forward-compat ONLY — does NOT gate `suitable`. When
 *           'off' an advisory warning is pushed, but the verdict is unchanged.
 * @property {number} [confidenceFloor=0.5]
 *           Minimum confidence. Coerced like engine.mjs: finite && in [0,1] else 0.5.
 * @property {number} confidence
 *           mode-selector 0..1 float (injected). null/undefined/NaN ⇒ G1 FAILS.
 * @property {null | { status?: ('green'|'red'|'unknown'), ok?: boolean }} [ci]
 *           checkCiStatus result. null = no signal (passes G3, warns). Malformed
 *           (non-object / missing status / non-string status) is treated as
 *           absent (passes G3 + 'CI signal malformed' warning) — never throws.
 * @property {'green'|'warn'|'degraded'|'critical'|null} [resourceVerdict]
 *           Resource verdict. null = no signal (passes G4, warns). A string is
 *           lowercase-trim-normalized before the !== 'critical' check (so
 *           'CRITICAL' fails). A non-string non-null value is "no signal"
 *           (passes G4 + 'resource signal malformed' warning) — never throws.
 * @property {Array<{ kill_switch?: string|null }>} [recentRuns]
 *           Repo-scoped most-recent-N autopilot run records (caller supplies; the
 *           engine never reads autopilot.jsonl). A non-array value is coerced to
 *           [] (G2 omitted + warning). Null/non-object records and non-string
 *           kill_switch fields count as NOT-fired — never throws.
 */

/**
 * @typedef {Object} SuitabilityVerdict
 * @property {boolean} suitable    The four-gate AND.
 * @property {number} confidence   The validated injected confidence (NaN/missing ⇒ 0 echo).
 * @property {string} rationale    One line, segments joined with '; '.
 * @property {string[]} warnings   Omission / absent-signal / dial advisory notes.
 */

/**
 * Coerce the confidence floor exactly as engine.mjs does: a finite number in the
 * closed interval [0,1] is honoured; everything else (null/undefined/NaN/string/
 * out-of-range) falls back to the safe default 0.5 — NEVER 0.
 * @param {unknown} rawFloor
 * @returns {number}
 */
function coerceFloor(rawFloor) {
  const coerced =
    typeof rawFloor === 'number'
      ? rawFloor
      : typeof rawFloor === 'string' && rawFloor.trim() !== ''
        ? Number(rawFloor)
        : NaN;
  return Number.isFinite(coerced) && coerced >= 0 && coerced <= 1 ? coerced : DEFAULT_CONFIDENCE_FLOOR;
}

/**
 * Compute the autonomous-dispatch suitability verdict over four injected signal
 * gates. PURE, NEVER throws, NO I/O. The caller (dispatcher) is responsible for
 * gathering ci / resourceVerdict / confidence / recentRuns and acting on the
 * verdict (#682 wires this into launch).
 *
 * @param {SuitabilityDeps} [deps]
 * @returns {SuitabilityVerdict}
 */
export function computeSuitabilityVerdict(deps = {}) {
  const {
    autonomy,
    confidenceFloor: rawFloor,
    confidence: rawConfidence,
    ci = null,
    resourceVerdict = null,
    recentRuns = [],
  } = deps && typeof deps === 'object' ? deps : {};

  /** @type {string[]} */
  const warnings = [];

  const floor = coerceFloor(rawFloor);

  // --- G1 — confidence gate (fail-closed: null/undefined/NaN ⇒ false) --------
  const confidenceOk = Number.isFinite(rawConfidence) && rawConfidence >= floor;
  // Echo the validated confidence; NaN/missing ⇒ 0 (G1 already failed regardless).
  const confidenceEcho = Number.isFinite(rawConfidence) ? rawConfidence : 0;

  // --- G2 — kill-switch rate gate (OMITTED below the run-count floor) --------
  // Defensive: a non-array recentRuns (undefined/null/string/object — e.g. a
  // malformed autopilot.jsonl read) is coerced to [] and warned, never thrown.
  const recentRunsIsArray = Array.isArray(recentRuns);
  const runs = recentRunsIsArray ? recentRuns : [];
  if (!recentRunsIsArray && recentRuns !== undefined && recentRuns !== null) {
    warnings.push('recentRuns not an array — kill-switch gate omitted');
  }
  const n = runs.length;
  let killSwitchOk;
  let killSwitchSegment;
  if (n < KILL_SWITCH_MIN_RUNS) {
    killSwitchOk = true; // OMITTED ⇒ treat as PASS (insufficient signal)
    warnings.push(`kill-switch signal omitted: only ${n}<${KILL_SWITCH_MIN_RUNS} runs`);
    killSwitchSegment = `omitted (${n}<${KILL_SWITCH_MIN_RUNS} runs)`;
  } else {
    let fired = 0;
    for (const run of runs) {
      // Defensive: a null / non-object run, a record MISSING kill_switch, or a
      // kill_switch of a non-string type (number/object/boolean) all count as
      // NOT-fired. ONLY a non-empty string counts as fired. Never throws.
      const ks = run && typeof run === 'object' ? run.kill_switch : undefined;
      if (typeof ks === 'string' && ks.length > 0) fired += 1;
    }
    const rate = fired / n;
    killSwitchOk = rate < KILL_SWITCH_MAX_RATE;
    const ratePct = Math.round(rate * 100) / 100;
    killSwitchSegment = `${fired}/${n} fired rate=${ratePct} ${killSwitchOk ? 'ok' : 'FAIL'}`;
  }

  // --- G3 — CI gate (null & 'unknown' pass; only 'red' fails) ----------------
  // Defensive: `ci` present but not an object, an object without `status`, or a
  // non-string `status` ⇒ "no signal" (gate PASSES + warning), NEVER a crash.
  // ONLY a literal `status === 'red'` fails the gate.
  const ciAbsent = ci === null || ci === undefined;
  const ciStatus = !ciAbsent && typeof ci === 'object' && typeof ci.status === 'string' ? ci.status : null;
  const ciMalformed = !ciAbsent && ciStatus === null; // present but unusable
  const ciNotRed = ciStatus !== 'red'; // null status (absent/malformed) passes
  if (ciAbsent) warnings.push('CI signal absent');
  else if (ciMalformed) warnings.push('CI signal malformed — treated as absent');
  const ciSegment = ciAbsent ? 'absent' : ciMalformed ? 'malformed' : `${ciStatus}`;

  // --- G4 — resource gate (green/warn/degraded/null pass; only 'critical' fails)
  // Defensive: normalize a STRING verdict via toLowerCase().trim() so 'CRITICAL'
  // / ' critical ' are correctly caught (only exact lowercase 'critical' fails).
  // A non-string, non-null verdict (number/object/bool) is "no signal" ⇒ PASS +
  // warning, never a crash. null/undefined = absent (passes, warns).
  const resourceAbsent = resourceVerdict === null || resourceVerdict === undefined;
  const resourceIsString = typeof resourceVerdict === 'string';
  const resourceMalformed = !resourceAbsent && !resourceIsString; // present but unusable
  const resourceNorm = resourceIsString ? resourceVerdict.toLowerCase().trim() : null;
  const resourceNotCritical = resourceNorm !== 'critical'; // non-string/absent ⇒ passes
  if (resourceAbsent) warnings.push('resource signal absent');
  else if (resourceMalformed) warnings.push('resource signal malformed — treated as absent');
  const resourceSegment = resourceAbsent
    ? 'absent'
    : resourceMalformed
      ? 'malformed'
      : `${resourceNorm}`;

  // --- Autonomy dial (forward-compat advisory ONLY — never flips `suitable`) -
  if (autonomy === 'off') {
    warnings.push('autonomy off — verdict advisory only; caller will confirm');
  }

  // --- The four-gate AND -----------------------------------------------------
  const suitable = confidenceOk && killSwitchOk && ciNotRed && resourceNotCritical;

  // `forcedFail` exists ONLY to word the rationale — the PRD override is already
  // satisfied by the pure AND above (CI red / resource critical fail their gate).
  const forcedFail = !ciNotRed || !resourceNotCritical;

  // --- Rationale (segments joined with '; ', mirroring engine.mjs L481-485) --
  const detailParts = [`suitable=${suitable}`];
  if (forcedFail) {
    const reasons = [];
    if (!ciNotRed) reasons.push('CI red');
    if (!resourceNotCritical) reasons.push('resource critical');
    detailParts.push(`FORCED: ${reasons.join(' + ')}`);
  }
  detailParts.push(`confidence ${confidenceEcho}>=${floor} ${confidenceOk ? 'ok' : 'FAIL'}`);
  detailParts.push(`kill-switch ${killSwitchSegment}`);
  detailParts.push(`CI ${ciSegment} ${ciNotRed ? 'ok' : 'FAIL'}`);
  detailParts.push(`resource ${resourceSegment} ${resourceNotCritical ? 'ok' : 'FAIL'}`);

  return {
    suitable,
    confidence: confidenceEcho,
    rationale: detailParts.join('; '),
    warnings,
  };
}
