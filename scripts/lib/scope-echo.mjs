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
 *   node scripts/lib/scope-echo.mjs --help
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestSha256Short } from './crypto-digest-utils.mjs';

/** Marker the agent must emit. Case-sensitive by design — a lowercase lookalike is not an echo. */
export const SCOPE_ECHO_MARKER = 'SCOPE-DIGEST:';

/** Event name for the post-wave verdict. */
export const SCOPE_ECHO_EVENT = 'orchestrator.wave_dispatch.scope_echo_checked';

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

  scope-echo --help

Exit codes: 0 for every verdict, 1 for a missing --scope-file.
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

const invokedAsCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedAsCli) {
  process.exitCode = await main();
}
