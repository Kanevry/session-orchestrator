/**
 * scope-echo.mjs — the RECEIVE-side half of the FILE-SCOPE observability chain (#1092).
 *
 * `hooks/pre-task-scope-disjoint.mjs` observes the SEND side: it emits
 * `orchestrator.wave_dispatch.scope_checked` describing what the guard saw in the
 * prompt the coordinator handed to the dispatch tool. Nothing in this repo can
 * observe the other half — whether the `FILE-SCOPE` block reached the agent's
 * assembled context — because no platform boundary exposes the final prompt
 * (`docs/scope-collision-guard.md` § 4.2).
 *
 * What IS feasible is a self-reported echo: the coordinator appends one
 * instruction line naming the expected digest of the agent's own scope file, and
 * the agent ends its report with `SCOPE-DIGEST: <8-hex>`. Post-wave, the
 * coordinator compares the two and emits
 * `orchestrator.wave_dispatch.scope_echo_checked`.
 *
 * CEILING (BV-004, named deliberately): this is a SOFT signal. The digest is
 * handed to the agent in the prompt, so an agent that never read the scope block
 * can still copy the line — it proves the report carried the digest the
 * coordinator handed it, never that the model read or obeyed the scope. Revisit
 * when the platform exposes a stable prompt-assembly boundary; at that point the
 * digest can be computed against the real assembled prompt instead of echoed.
 *
 * CALLERS (#1298): the CLI modes run only from prose — `--instruction` in
 * `skills/wave-executor/references/wave-loop-dispatch.md`, `--emit` and `--verify`
 * in `wave-loop-review.md`. Ceiling: `check-unwired-features` S4 cannot notice both
 * dropping that citation — it judges modules, not CLI modes, and reads this one wired
 * as a CLI entrypoint AND via its hook importer (`scopeDigest`). Revisit on a third
 * prose caller, or when the census learns to track prose-invoked CLI entrypoints.
 *
 * Pure + stdlib only. Nothing here throws on malformed input — a broken echo
 * check must never change a wave's outcome.
 *
 * Exports:
 *   scopeDigest(paths)                       → 8-hex string (deterministic, never throws)
 *   renderScopeEchoInstruction(paths)        → the ONE prompt line to append
 *   extractScopeEcho(reportText)             → { echoed, digest }
 *   checkScopeEcho({ scopeFilePath, reportText }) → { echoed, match, expected, actual, reason? }
 *
 * CLI:
 *   node scripts/lib/scope-echo.mjs --scope-file <path> --instruction
 *   node scripts/lib/scope-echo.mjs --scope-file <path> --report-file <path> \
 *        [--wave N --agent-id ID --emit]
 *   node scripts/lib/scope-echo.mjs --verify --wave <N> --state-dir <dir> \
 *        [--session <id> --events <path> --json --emit]
 *   node scripts/lib/scope-echo.mjs --help
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { digestSha256Short } from './crypto-digest-utils.mjs';
import { isMainModule } from './is-main-module.mjs';

/** Marker the agent must emit. Case-sensitive by design — a lowercase lookalike is not an echo. */
export const SCOPE_ECHO_MARKER = 'SCOPE-DIGEST:';

/** Event name for the post-wave verdict. */
export const SCOPE_ECHO_EVENT = 'orchestrator.wave_dispatch.scope_echo_checked';

/** The SEND-side record `hooks/pre-task-scope-disjoint.mjs` writes per dispatch. */
export const SCOPE_CHECKED_EVENT = 'orchestrator.wave_dispatch.scope_checked';

/** The DEGRADATION record `scripts/materialize-wave-scope.mjs` writes per wave. */
export const SCOPE_MATERIALIZED_EVENT = 'orchestrator.wave_dispatch.scope_materialized';

/** The per-WAVE join verdict `--verify` emits. */
export const SCOPE_VERIFIED_EVENT = 'orchestrator.wave_dispatch.scope_verified';

/** Max characters retained for `agent_id` in the payload (same clamp as the send-side hook). */
const AGENT_ID_MAX = 120;

/**
 * The LAST `SCOPE-DIGEST: <8 hex>` occurrence wins. Optional surrounding backticks
 * (agents like to fence the line) and trailing whitespace are tolerated. The
 * negative lookahead is load-bearing: without it `SCOPE-DIGEST: 123456789` would
 * match its first eight characters and report a false echo.
 */
const ECHO_RE = /SCOPE-DIGEST:[ \t]*`{0,3}([0-9a-fA-F]{8})(?![0-9a-fA-F])/g;

/**
 * Normalize a declared scope into the canonical digest input: trimmed, empties
 * dropped, deduplicated, sorted, joined with `\n`. Order and incidental
 * whitespace therefore never change the digest — two coordinators that wrote the
 * same set of paths in a different order agree.
 *
 * @param {unknown} paths
 * @returns {string[]}
 */
function normalizeScopePaths(paths) {
  if (!Array.isArray(paths)) return [];
  const out = new Set();
  for (const entry of paths) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out].sort();
}

/**
 * Digest of a declared file scope: sha256 over the normalized paths, first 8 hex.
 * An empty (or unusable) scope digests the empty string — deterministic, and it
 * never throws, so a Discovery wave's empty scope has a stable answer rather than
 * an error path.
 *
 * @param {unknown} paths  array of path strings (anything else → empty scope).
 * @returns {string} 8-character lowercase hex digest.
 */
export function scopeDigest(paths) {
  return digestSha256Short(normalizeScopePaths(paths).join('\n'));
}

/**
 * The single line the coordinator appends to an agent prompt after the fenced
 * `FILE-SCOPE` block. It names the expected digest outright, so the agent only
 * has to echo it — the check is about the line surviving the round trip, not
 * about making the agent compute a hash.
 *
 * @param {unknown} paths
 * @returns {string}
 */
export function renderScopeEchoInstruction(paths) {
  return `End your final report with the line: ${SCOPE_ECHO_MARKER} ${scopeDigest(paths)}`;
}

/**
 * Find the LAST scope-echo marker in an agent's report.
 *
 * The MARKER stays case-sensitive by design (a lowercase `scope-digest:` is not
 * an echo), but the HEX PAYLOAD is accepted case-insensitively and normalized to
 * lowercase: `0123ABCD` and `0123abcd` are the same 32 bits, and an agent that
 * upper-cases the digest has demonstrably carried the line through — which is
 * the only thing this signal measures.
 *
 * @param {unknown} reportText
 * @returns {{ echoed: boolean, digest: string|null }}
 */
export function extractScopeEcho(reportText) {
  if (typeof reportText !== 'string' || reportText.length === 0) {
    return { echoed: false, digest: null };
  }
  let last = null;
  ECHO_RE.lastIndex = 0;
  for (const match of reportText.matchAll(ECHO_RE)) last = match[1].toLowerCase();
  return last === null ? { echoed: false, digest: null } : { echoed: true, digest: last };
}

/**
 * Read a per-agent scope file (`<state-dir>/filescopes/wave-<N>/<agent-id>.json`,
 * a JSON array of path strings — shape (a) of the two scope shapes, see
 * CLAUDE.md / AGENTS.md § allowedPaths) and compare its digest against the agent's echo.
 *
 * Never throws: an unreadable or wrongly-shaped scope file yields
 * `{ match: false, reason: 'scope-file-unreadable' }` so the caller logs an
 * informational line instead of failing a wave.
 *
 * An EMPTY declared scope (a Discovery wave, `[]`) is NOT a failed echo: no
 * instruction line was ever injected, so the agent had nothing to echo. Those
 * verdicts carry `applicable: false` + `reason: 'scope-empty'` so a consumer can
 * exclude them from the echo-rate instead of counting every uninstructed agent
 * as a miss. `applicable` is OMITTED (never `true`) on the instructed path — the
 * same "absent is not zero" discipline `wave` follows.
 *
 * @param {{ scopeFilePath?: string, reportText?: string }} args
 * @returns {{ echoed: boolean, match: boolean, expected: string|null, actual: string|null, applicable?: boolean, reason?: string }}
 */
export function checkScopeEcho({ scopeFilePath, reportText } = {}) {
  const { echoed, digest } = extractScopeEcho(reportText);
  /** @type {string|null} */
  let expected;
  try {
    const parsed = JSON.parse(readFileSync(String(scopeFilePath), 'utf8'));
    if (!Array.isArray(parsed)) throw new TypeError('scope file is not a JSON array');
    if (normalizeScopePaths(parsed).length === 0) {
      return {
        echoed,
        match: false,
        expected: null,
        actual: digest,
        applicable: false,
        reason: 'scope-empty',
      };
    }
    expected = scopeDigest(parsed);
  } catch {
    return { echoed, match: false, expected: null, actual: digest, reason: 'scope-file-unreadable' };
  }
  if (!echoed) return { echoed, match: false, expected, actual: null, reason: 'echo-absent' };
  const match = digest === expected;
  return { echoed, match, expected, actual: digest, ...(match ? {} : { reason: 'digest-mismatch' }) };
}

/**
 * Build the telemetry payload for a verdict. Counts, closed enums and digests
 * only — NO path and NO prompt text (issue #1092 acceptance criterion 3): this
 * record also travels over the optional Clank Event-Bus webhook with no
 * redaction, and declared paths carry private project slugs.
 *
 * NO path here means no path in THIS function's own object literal, before the
 * standard `sessionAttribution` spread, which adds the session ids like every
 * event — that spread is applied by the caller and is out of this promise's
 * scope.
 *
 * `wave` follows the "absent is not zero" rule (`docs/events-schema.md`): it is
 * omitted rather than defaulted when the caller has no wave number. `applicable`
 * follows the same rule in the other direction — it is emitted ONLY as `false`,
 * for a verdict whose agent was never instructed (empty declared scope), so a
 * consumer computing an echo-rate can filter those rows out. Its absence means
 * "instructed", never "unknown". (Events-schema row owned elsewhere: the
 * `orchestrator.wave_dispatch.scope_echo_checked` catalogue entry needs an
 * `applicable` field row.)
 *
 * @param {{ echoed: boolean, match: boolean, expected: string|null, actual: string|null, applicable?: boolean, reason?: string }} verdict
 * @param {{ wave?: unknown, agentId?: unknown }} [meta]
 * @returns {Record<string, unknown>}
 */
export function scopeEchoPayload(verdict, meta = {}) {
  const wave = Number(meta.wave);
  const agentId = typeof meta.agentId === 'string' ? meta.agentId.slice(0, AGENT_ID_MAX) : null;
  return {
    ...(Number.isFinite(wave) && wave > 0 ? { wave } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    echoed: verdict.echoed,
    match: verdict.match,
    ...(verdict.applicable === false ? { applicable: false } : {}),
    expected_digest: verdict.expected ?? null,
    actual_digest: verdict.actual ?? null,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// --verify — join the two halves of one wave ON THE DIGEST (#1092)
// ---------------------------------------------------------------------------

/**
 * Closed verdict enum. Order is PRECEDENCE, not preference — the first matching
 * row wins, and every (file, dispatch, echo) triple lands on exactly one row:
 *
 *   duplicate-claim      ≥2 DISTINCT agent ids claimed one digest at dispatch.
 *                        That is agent A's scope reported for agent B, and it is
 *                        a defect whatever the other two bits say — so it is
 *                        checked first.
 *   echoed-not-injected  an echo names a digest NO dispatch claimed.
 *   digest-unknown       no scope FILE on disk carries this digest: the record
 *                        exists but the artefact that would ground it does not
 *                        (a scope file rewritten or reconciled away after the
 *                        dispatch).
 *   matched              file ∧ dispatch ∧ echo.
 *   injected-not-echoed  file ∧ dispatch, no echo — the normal state DURING a
 *                        wave, before the reports land.
 *   injection-missing    file ∧ neither — a scope file no dispatch claimed and
 *                        no agent echoed. This is AC-2: the omitted injection.
 *
 * Every member is kebab-case. `echo-only` is NOT one of the six: it is the
 * DEGRADED value every verdict collapses to when the wave's transport is
 * unobservable (see {@link verifyWaveScope}), so it is never produced by the
 * precedence chain above and never belongs in this array.
 *
 * `injection-missing` was spelled `injection_missing` until 2026-09-16 — the
 * one snake_case member of an otherwise kebab-case enum. Ledger records written
 * before that date may still carry the old spelling in `by_verdict`; there is no
 * dual-emit, so a consumer reading historical rows must accept both keys.
 */
export const SCOPE_VERDICTS = Object.freeze([
  'duplicate-claim',
  'echoed-not-injected',
  'digest-unknown',
  'matched',
  'injected-not-echoed',
  'injection-missing',
]);

/** A well-formed digest. Anything else is ignored rather than joined on. */
const DIGEST_RE = /^[0-9a-f]{8}$/;

/**
 * Parse a JSONL ledger leniently: a malformed line is skipped, never thrown on
 * — and COUNTED, which is the load-bearing half.
 *
 * A crashed writer leaves a truncated final line (`{"event":"…","wave":4` with
 * no closing brace) — a measured shape in this repo's own ledger. Skipping it
 * silently truncates the join, and a truncated join reports
 * `dispatches N / injected N / echoed N` with every digest `matched`: a CLEAN
 * wave, from the instrument built to detect silent failure. The count is what
 * separates "nothing was wrong" from "I could not read part of the evidence".
 *
 * A malformed line is any NON-BLANK line that does not yield a plain object:
 * one that does not start with `{`, one `JSON.parse` rejects, and one that
 * parses to an array or a scalar. Blank lines are not malformed — a trailing
 * newline is the normal end of a JSONL file.
 *
 * @param {string} raw
 * @returns {{records: Array<Record<string, unknown>>, malformed: number}}
 */
function parseJsonl(raw) {
  /** @type {Array<Record<string, unknown>>} */
  const records = [];
  let malformed = 0;
  if (typeof raw !== 'string') return { records, malformed };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed[0] !== '{') {
      malformed += 1;
      continue;
    }
    try {
      const rec = JSON.parse(trimmed);
      if (rec !== null && typeof rec === 'object' && !Array.isArray(rec)) records.push(rec);
      else malformed += 1;
    } catch {
      malformed += 1; // a half-written line is not a verdict — but it is not nothing either
    }
  }
  return { records, malformed };
}

/**
 * Digest every per-agent scope file of one wave — shape (a) of the two scope
 * shapes (CLAUDE.md / AGENTS.md § allowedPaths).
 *
 * A file that cannot be read or parsed is the FILE-side counterpart of a
 * truncated ledger line: skipping it silently makes a wave whose scope files are
 * corrupt indistinguishable from one that was never injected (`digest-unknown` /
 * `injection-missing`). The count therefore rides back on the returned Map as
 * `malformedFiles` — an additive own property, so every existing consumer that
 * only iterates the entries is unaffected. (A file that parses to a non-array or
 * to an empty scope stays a silent skip: an empty scope is legitimate.)
 *
 * @param {string} stateDir
 * @param {number} wave
 * @param {{readDir?: typeof readdirSync, readFile?: typeof readFileSync}} [io]
 * @returns {Map<string, string[]> & {malformedFiles: number}} digest → agent ids (file basenames)
 */
export function digestScopeFiles(stateDir, wave, { readDir = readdirSync, readFile = readFileSync } = {}) {
  const out = new Map();
  out.malformedFiles = 0;
  const dir = resolve(String(stateDir), 'filescopes', `wave-${wave}`);
  let names;
  try {
    names = readDir(dir);
  } catch {
    return out; // no directory yet is not a failure — it is "nothing materialized"
  }
  for (const name of names) {
    const file = typeof name === 'string' ? name : name?.name;
    if (typeof file !== 'string' || !file.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFile(join(dir, file), 'utf8'));
    } catch {
      out.malformedFiles += 1; // unreadable or unparseable — not nothing
      continue;
    }
    if (!Array.isArray(parsed) || normalizeScopePaths(parsed).length === 0) continue;
    const digest = scopeDigest(parsed);
    const ids = out.get(digest) ?? [];
    ids.push(file.slice(0, -'.json'.length));
    out.set(digest, ids);
  }
  return out;
}

/**
 * Verify ONE wave's FILE-SCOPE injection end to end.
 *
 * ## Why the join key is the DIGEST and never `agent_id`
 *
 * Measured 2026-09-16 over this host's `.orchestrator/metrics/events.jsonl`
 * corpus: 609 `scope_checked` records against 51 `scope_echo_checked`, and the
 * two agent-id sets OVERLAP IN ZERO ELEMENTS — the send side records the
 * dispatch tool's `description` plus `subagent_type`
 * (`"i-3 #1353 refund event (session-orchestrator:code-implementer)"`), the
 * receive side the coordinator's short handle (`"i-3"`). One session showed 23
 * echoes against 18 injections and the halves could not be joined at all. The
 * digest is the one value both halves derive from the SAME artefact, so it joins
 * them by construction.
 *
 * ## Observability, not enforcement
 *
 * Every verdict exits 0. This tool reports; the wave-executor turns
 * `injection-missing` / `duplicate-claim` into a STATE.md deviation
 * (`wave-loop-review.md` step 3d-bis), never into a block.
 *
 * ## A partial read is never a clean wave
 *
 * `malformed_lines` counts the ledger lines that could not be parsed (a crashed
 * writer's truncated append is the measured shape). It is ALWAYS present,
 * including as `0`: the ledger read either happened or the file was absent, and
 * both are measurements. A non-zero count means the join ran on INCOMPLETE
 * evidence — the counts and verdicts below are a floor, not a census — and the
 * human table says so beside them.
 *
 * `malformed_scope_files` is the same measurement on the FILE side (#1379 P2):
 * a scope file that cannot be read or parsed was silently skipped, which made a
 * corrupt wave yield `digest-unknown` / `injection-missing` verdicts
 * indistinguishable from a genuinely missing injection. Always present,
 * including as `0`.
 *
 * ## Transport degradation
 *
 * On a platform with no `PreToolUse` `Agent` matcher (Codex, Cursor, Pi) the
 * send-side record cannot exist at all, so a missing dispatch is NOT evidence of
 * a missing injection. When the wave's `scope_materialized` record says
 * `transport_observable: false`, `transport` reads `unobservable` and every
 * verdict degrades to `echo-only` — the receive half is all the platform can
 * carry, and reporting `injection-missing` there would be an accusation derived
 * from an instrument that is not installed.
 *
 * @param {object} params
 * @param {number} params.wave
 * @param {string} params.stateDir
 * @param {string} [params.session]    semantic (or raw) session id to filter on
 * @param {string} [params.eventsPath] defaults to `.orchestrator/metrics/events.jsonl`
 * @param {typeof readFileSync} [params.readFile]
 * @param {typeof readdirSync} [params.readDir]
 * @returns {{wave: number, transport: 'observable'|'unobservable', dispatches: number,
 *            injected: number, echoed: number, malformed_lines: number,
 *            by_verdict: Record<string, number>,
 *            agents: Array<{agent_id: string, verdict: string, digest: string}>}}
 */
export function verifyWaveScope({
  wave,
  stateDir,
  session,
  eventsPath,
  readFile = readFileSync,
  readDir = readdirSync,
}) {
  const ledgerPath = eventsPath || join('.orchestrator', 'metrics', 'events.jsonl');
  let records = [];
  let malformedLines = 0;
  try {
    ({ records, malformed: malformedLines } = parseJsonl(readFile(ledgerPath, 'utf8')));
  } catch { /* no ledger yet — every count is legitimately 0 */ }

  const mine = (rec) => {
    if (rec.wave !== wave) return false;
    if (!session) return true;
    return rec.semantic_session_id === session || rec.session_id === session;
  };

  /** @type {Map<string, Set<string>>} digest → distinct dispatching agent ids */
  const dispatchIds = new Map();
  /** @type {Map<string, string>} digest → first echoing agent id */
  const echoIds = new Map();
  let dispatches = 0;
  let injected = 0;
  let echoed = 0;
  // A wave may be materialized more than once (#1103); the LAST record wins,
  // because that is the state the dispatches below actually ran against.
  let transportObservable = null;

  for (const rec of records) {
    if (rec.event === SCOPE_MATERIALIZED_EVENT && mine(rec)) {
      if (typeof rec.transport_observable === 'boolean') transportObservable = rec.transport_observable;
      continue;
    }
    if (rec.event === SCOPE_CHECKED_EVENT && mine(rec)) {
      dispatches += 1;
      if (rec.injected === true) injected += 1;
      const digest = rec.scope_digest;
      if (typeof digest === 'string' && DIGEST_RE.test(digest)) {
        const ids = dispatchIds.get(digest) ?? new Set();
        ids.add(typeof rec.agent_id === 'string' ? rec.agent_id : 'unnamed-agent');
        dispatchIds.set(digest, ids);
      }
      continue;
    }
    if (rec.event === SCOPE_ECHO_EVENT && mine(rec)) {
      if (rec.echoed === true) echoed += 1;
      // The agent's OWN claim first (`actual_digest`); the coordinator-side
      // expectation only as a fallback, so a mismatched echo still joins to the
      // scope file it was checked against rather than vanishing from the report.
      const digest = [rec.actual_digest, rec.expected_digest]
        .find((d) => typeof d === 'string' && DIGEST_RE.test(d));
      if (digest !== undefined && !echoIds.has(digest)) {
        echoIds.set(digest, typeof rec.agent_id === 'string' ? rec.agent_id : 'unnamed-agent');
      }
    }
  }

  const fileIds = digestScopeFiles(stateDir, wave, { readDir, readFile });
  const digests = [...new Set([...fileIds.keys(), ...dispatchIds.keys(), ...echoIds.keys()])].sort();

  const unobservable = transportObservable === false;
  /** @type {Record<string, number>} */
  const byVerdict = {};
  const agents = digests.map((digest) => {
    const claimants = dispatchIds.get(digest);
    const hasDispatch = claimants !== undefined && claimants.size > 0;
    const hasEcho = echoIds.has(digest);
    const hasFile = fileIds.has(digest);

    let verdict;
    if (hasDispatch && claimants.size > 1) verdict = 'duplicate-claim';
    else if (hasEcho && !hasDispatch) verdict = 'echoed-not-injected';
    else if (!hasFile) verdict = 'digest-unknown';
    else if (hasDispatch && hasEcho) verdict = 'matched';
    else if (hasDispatch) verdict = 'injected-not-echoed';
    else verdict = 'injection-missing';
    if (unobservable) verdict = 'echo-only';

    byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
    const agentId = (hasDispatch ? [...claimants].sort().join(' + ') : null)
      ?? echoIds.get(digest)
      ?? (fileIds.get(digest) ?? []).join(' + ')
      ?? 'unknown';
    return { agent_id: agentId, verdict, digest };
  });

  return {
    wave,
    transport: unobservable ? 'unobservable' : 'observable',
    dispatches,
    injected,
    echoed,
    malformed_lines: malformedLines,
    malformed_scope_files: fileIds.malformedFiles ?? 0,
    by_verdict: byVerdict,
    agents,
  };
}

/**
 * Telemetry payload for a `--verify` run. Counts, closed enums and 8-hex digests
 * ONLY — no agent id, no path, no prompt text: this record travels over the same
 * unredacted Clank Event-Bus webhook as its two halves, and an `agent_id` is a
 * free-form coordinator string that has carried private project slugs before.
 *
 * `malformed_lines` travels with the counts and, like them, is ALWAYS present
 * including as `0` — it is the denominator's honesty check: without it a join
 * that silently dropped half the ledger is indistinguishable in the record from
 * a wave where nothing went wrong (`.claude/rules/host-resources.md` § HR-105).
 * `malformed_scope_files` carries the same guarantee for the scope files the
 * join reads (#1379 P2).
 *
 * @param {ReturnType<typeof verifyWaveScope>} report
 * @returns {Record<string, unknown>}
 */
export function scopeVerifiedPayload(report) {
  return {
    wave: report.wave,
    transport_observable: report.transport === 'observable',
    dispatches: report.dispatches,
    injected: report.injected,
    echoed: report.echoed,
    malformed_lines: report.malformed_lines ?? 0,
    malformed_scope_files: report.malformed_scope_files ?? 0,
    by_verdict: report.by_verdict,
    digests: report.agents.map((a) => a.digest),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** `--help` text. Exit codes are named here per `.claude/rules/cli-design.md` § Discoverability. */
const USAGE = `Usage:
  scope-echo --scope-file <path> --instruction
      Print the ONE prompt line instructing an agent to echo its scope digest.
      Prints nothing for an empty or unreadable scope file.

  scope-echo --scope-file <path> [--report-file <path>] [--wave N]
             [--agent-id ID] [--emit]
      Compare the agent report's SCOPE-DIGEST echo against the scope file and
      print the verdict payload as JSON on stdout. --emit additionally appends
      an ${SCOPE_ECHO_EVENT} row to .orchestrator/metrics/events.jsonl
      (best-effort: a failed emit never changes the verdict or the exit code).

  scope-echo --verify --wave <N> --state-dir <dir> [--session <id>]
             [--events <path>] [--json] [--emit]
      Join ONE wave's send side (${SCOPE_CHECKED_EVENT}),
      its scope files and its echoes ON THE DIGEST, and print the per-agent
      verdict table. --emit additionally appends one ${SCOPE_VERIFIED_EVENT}
      row per wave (counts and 8-hex digests only).
      Verdicts: ${SCOPE_VERDICTS.join(' · ')} — plus echo-only when the wave's
      transport is unobservable.

  scope-echo --help

Exit codes: 0 for every verdict, 1 for a missing --scope-file (or, under
--verify, a missing --wave / --state-dir).
`;

/**
 * Minimal `--flag value` / `--flag` parser (no dependency, same shape as the
 * other `scripts/lib/*` CLIs in this repo).
 *
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgv(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * `--verify` mode — the per-wave join (see {@link verifyWaveScope}).
 *
 * Exit 0 for EVERY verdict, including `injection-missing`: this is an
 * observability tool, and the wave-executor decides what a verdict costs
 * (`wave-loop-review.md` step 3d-bis writes a STATE.md deviation, never a
 * block). Exit 1 is reserved for the caller's own mistake — a missing required
 * flag — per `.claude/rules/cli-design.md`.
 *
 * @param {Record<string, string|boolean>} args
 * @returns {Promise<number>}
 */
async function mainVerify(args) {
  const wave = Number(args.wave);
  const stateDir = typeof args['state-dir'] === 'string' ? args['state-dir'] : '';
  if (!Number.isSafeInteger(wave) || wave <= 0 || stateDir === '') {
    process.stderr.write('scope-echo: --verify requires --wave <positive-int> and --state-dir <dir>\n');
    process.stderr.write(USAGE);
    return 1;
  }

  const report = verifyWaveScope({
    wave,
    stateDir,
    session: typeof args.session === 'string' ? args.session : undefined,
    eventsPath: typeof args.events === 'string' ? args.events : undefined,
  });

  if (args.emit) {
    try {
      const repoRoot = resolve(stateDir, '..');
      const { emitEvent, sessionAttribution } = await import('./events.mjs');
      await emitEvent(
        SCOPE_VERIFIED_EVENT,
        { ...scopeVerifiedPayload(report), ...sessionAttribution(repoRoot) },
        { repoRoot },
      );
    } catch (err) {
      process.stderr.write(`scope-echo: emit failed — ${err?.message ?? err}\n`);
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }
  const lines = [
    `wave ${report.wave} — transport: ${report.transport} — `
      + `${report.injected}/${report.dispatches} injected, ${report.echoed} echoed`,
    // A partial read must never read as a clean wave: the counts above are a
    // FLOOR when lines were dropped, and this is the only place the human table
    // can say so.
    ...(report.malformed_lines > 0
      ? [`  WARNING: ${report.malformed_lines} malformed ledger line(s) skipped — `
        + 'counts and verdicts below are a floor, not a census']
      : []),
    // Same honesty check on the FILE side: an unparseable scope file makes a
    // corrupt wave look exactly like one that was never injected.
    ...(report.malformed_scope_files > 0
      ? [`  WARNING: ${report.malformed_scope_files} malformed scope file(s) skipped — `
        + 'digest-unknown / injection-missing below may be corruption, not a missing injection']
      : []),
    ...report.agents.map((a) => `  ${a.digest}  ${a.verdict.padEnd(20)}  ${a.agent_id}`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} process exit code: 0 for every verdict (this is an
 *   observability tool — a broken echo check never fails a wave), or 1 for a
 *   missing `--scope-file`, which is a USER error per `.claude/rules/cli-design.md`
 *   (1 = user/input error; 2 is reserved for system errors).
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  // --verify is its own mode and takes no --scope-file: it reads EVERY scope
  // file of the wave, so the check below must not reject it first.
  if (args.verify) return mainVerify(args);

  const scopeFilePath = typeof args['scope-file'] === 'string' ? args['scope-file'] : '';
  if (!scopeFilePath) {
    process.stderr.write('scope-echo: --scope-file <path> is required\n');
    process.stderr.write(USAGE);
    return 1;
  }

  if (args.instruction) {
    let paths = [];
    try {
      const parsed = JSON.parse(readFileSync(scopeFilePath, 'utf8'));
      if (Array.isArray(parsed)) paths = parsed;
    } catch {
      // Unreadable scope file → no instruction. Silent on stdout, because the
      // caller splices stdout straight into the prompt. But it must NOT be
      // silent altogether: a corrupt scope file and a legitimate empty Discovery
      // scope both produced exit 0 with no output at all, so the operator could
      // not tell an injected-nothing-by-design run from a broken one. One stderr
      // line separates them (#1092 review R3).
      process.stderr.write(
        `scope-echo: scope file unreadable (${scopeFilePath}) — no echo line injected\n`,
      );
      return 0;
    }
    if (paths.length === 0) return 0;
    process.stdout.write(`${renderScopeEchoInstruction(paths)}\n`);
    return 0;
  }

  const reportFile = typeof args['report-file'] === 'string' ? args['report-file'] : '';
  /** @type {string} */
  let reportText;
  try {
    reportText = reportFile ? readFileSync(reportFile, 'utf8') : '';
  } catch {
    reportText = '';
  }

  const verdict = checkScopeEcho({ scopeFilePath, reportText });
  const payload = scopeEchoPayload(verdict, {
    wave: args.wave,
    agentId: typeof args['agent-id'] === 'string' ? args['agent-id'] : undefined,
  });

  if (args.emit) {
    try {
      const repoRoot = process.cwd();
      const { emitEvent, sessionAttribution } = await import('./events.mjs');
      await emitEvent(
        SCOPE_ECHO_EVENT,
        { ...payload, ...sessionAttribution(repoRoot) },
        { repoRoot },
      );
    } catch (err) {
      // Telemetry never changes the verdict (same discipline as the send-side
      // hook): an unwritable ledger — a full disk, or `events.jsonl` existing as
      // a DIRECTORY — still prints the verdict on stdout and still exits 0.
      process.stderr.write(`scope-echo: emit failed — ${err?.message ?? err}\n`);
    }
  }

  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

const invokedAsCli = isMainModule(import.meta.url);

if (invokedAsCli) {
  process.exitCode = await main();
}
