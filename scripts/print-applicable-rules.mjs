#!/usr/bin/env node
/**
 * print-applicable-rules.mjs — thin CLI wrapper around the #336 rule-loader.
 *
 * Wires the dormant `loadApplicableRules()` (scripts/lib/rule-loader.mjs) into
 * the wave-executor's per-wave agent-prompt assembly (Epic #693 FA1 / #694).
 * The wave-executor is coordinator-LLM prose, not an executable — so this CLI
 * is the concrete, testable bridge: the coordinator runs it once per wave
 * (after `wave-scope.json` is written, before assembling the Agent() prompt),
 * captures stdout as the injectable `<APPLICABLE-RULES>` block, and prepends
 * it to each dispatched agent's prompt.
 *
 * Resolution:
 *   - scopePaths ← `allowedPaths` from `.claude/wave-scope.json`
 *                  (override: --wave-scope <path>)
 *   - mode       ← `session-type:` frontmatter in `.claude/STATE.md`
 *                  (override: --mode <m>; unreadable → null = no mode gating)
 *   - hostClass  ← `host_class` from `.orchestrator/host.json` via readHostClass
 *                  (override: --host-class <c>; unreadable → null = no gating)
 *   - rulesDir   ← <repoRoot>/.claude/rules
 *
 * Output:
 *   - default      → an injectable Markdown block (header + each rule's raw
 *                    content, separated by `\n\n---\n\n`). Empty match set →
 *                    no output (exit 0) so the caller injects nothing.
 *   - --json       → `{ count, rules: [{path, alwaysOn, matchedGlobs}] }`
 *
 * Exit codes (per .claude/rules/cli-design.md):
 *   0 — success, INCLUDING EPIPE (the reader closed its end of the pipe
 *       early — `| head`, `| grep -q`, any truncating consumer — before the
 *       full payload drained; see the process.stdout 'error' handler below)
 *   1 — user/input error (bad --wave-scope path, malformed wave-scope JSON)
 *   2 — system error (unexpected internal failure)
 * Data → stdout, diagnostics → stderr.
 *
 * Best-effort by design: a missing rules dir, missing STATE.md, or missing
 * host.json each degrade to "no gating / no rules" rather than failing — the
 * wave-executor caller treats any non-zero exit as "inject nothing, continue".
 * EPIPE is deliberately EXCLUDED from that "non-zero = inject nothing"
 * contract: the actual wave-executor caller drains stdout fully
 * (execFileSync/spawnSync-style capture) and never closes the pipe early, so
 * EPIPE can only be triggered by an exploratory or truncating reader — never
 * by the real caller this CLI exists to serve.
 *
 * Related: issue #336 (glob-scoped rules), #694 (rule-activation / FA1),
 *   scripts/lib/rule-loader.mjs (loadApplicableRules),
 *   scripts/lib/autopilot/telemetry.mjs (readHostClass),
 *   docs/rule-authoring.md (frontmatter authoring guide).
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findProjectRoot } from './lib/common.mjs';
import { loadApplicableRules } from './lib/rule-loader.mjs';
import { readHostClass } from './lib/autopilot/telemetry.mjs';

// ---------------------------------------------------------------------------
// EPIPE hardening (regression follow-up on #876)
// ---------------------------------------------------------------------------
//
// process.stdout.write() to a pipe is ASYNCHRONOUS in Node. When the reader
// closes its end early — `| head`, `| grep -q`, any truncating consumer —
// before the writer has finished draining, the deferred write fails and
// process.stdout emits an 'error' event carrying err.code === 'EPIPE'. Left
// unhandled, that is an UNCAUGHT EXCEPTION: Node prints a stack trace to
// stderr ("Unhandled 'error' event") and exits 1 — even though nothing
// actually failed on the producer side; the reader simply chose to stop
// consuming. Registered before any stdout write below so it covers every
// output branch (--help, --json, Markdown, and the empty-match no-op).
//
// Exit 0 on EPIPE, matching conventional Unix CLI behaviour (`cat file |
// head` reports no error to its caller) and restoring the pre-#876 exit
// contract for this specific case. Any other stdout write error is
// unexpected and is re-thrown rather than swallowed.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
});

const HELP = `Usage: node scripts/print-applicable-rules.mjs [options]

Prints the glob-scoped + always-on rule set applicable to the current wave,
as an injectable Markdown block, for the wave-executor to prepend to each
dispatched agent's prompt (#336 / #694).

Options:
  --wave-scope <path>   Path to wave-scope.json (default: .claude/wave-scope.json).
                        Its "allowedPaths" array is used as scopePaths.
  --mode <m>            Override session mode (default: session-type: from
                        .claude/STATE.md; unreadable -> no mode gating).
  --host-class <c>      Override host class (default: host_class from
                        .orchestrator/host.json; unreadable -> no gating).
  --context <c>         Caller context for tier gating: 'wave' | 'coordinator'.
                        When absent (default), tier gating is disabled and all
                        rules are included regardless of their tier: frontmatter.
                        Pass --context wave to exclude coordinator-only rules;
                        pass --context coordinator to exclude wave-only rules.
  --json                Emit { count, rules:[{path,alwaysOn,matchedGlobs}] }
                        instead of the Markdown block.
  --help, -h            Show this help and exit 0.

Exit codes:
  0  success
  1  user/input error (bad --wave-scope path or malformed JSON)
  2  system error
`;

/**
 * Print an error to stderr and exit with the given code.
 * @param {string} message
 * @param {number} code
 * @returns {never}
 */
function fail(message, code) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Parse argv
// ---------------------------------------------------------------------------

const rawArgv = process.argv.slice(2);
if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

let parsed;
try {
  parsed = parseArgs({
    args: rawArgv,
    options: {
      'wave-scope':  { type: 'string' },
      mode:          { type: 'string' },
      'host-class':  { type: 'string' },
      context:       { type: 'string' },
      json:          { type: 'boolean', default: false },
    },
    strict: true,
  });
} catch (err) {
  fail(`Failed to parse arguments: ${err.message}`, 1);
}

const opts = parsed.values;

// ---------------------------------------------------------------------------
// Resolve repo root + canonical paths
// ---------------------------------------------------------------------------

const repoRoot = findProjectRoot(process.cwd());
const rulesDir = join(repoRoot, '.claude', 'rules');
const waveScopePath = opts['wave-scope']
  ? opts['wave-scope']
  : join(repoRoot, '.claude', 'wave-scope.json');
const stateMdPath = join(repoRoot, '.claude', 'STATE.md');
const hostJsonPath = join(repoRoot, '.orchestrator', 'host.json');

// ---------------------------------------------------------------------------
// scopePaths ← wave-scope.json allowedPaths
// ---------------------------------------------------------------------------
//
// A user-supplied --wave-scope that does not exist or is malformed is a
// user/input error (exit 1). The DEFAULT path is allowed to be absent — some
// waves run before wave-scope.json is written — in which case we degrade to an
// empty scope (only always-on rules match) rather than failing.

let scopePaths = [];
const waveScopeExplicit = Boolean(opts['wave-scope']);
let waveScopeRaw;
try {
  waveScopeRaw = readFileSync(waveScopePath, 'utf8');
} catch (err) {
  if (waveScopeExplicit) {
    fail(`Cannot read --wave-scope ${waveScopePath}: ${err.message}`, 1);
  }
  // Default path absent → no scope (always-on only). Diagnostic to stderr.
  process.stderr.write(
    `[print-applicable-rules] wave-scope not found at ${waveScopePath} — using empty scope (always-on rules only)\n`,
  );
  waveScopeRaw = null;
}

if (waveScopeRaw !== null) {
  let waveScope;
  try {
    waveScope = JSON.parse(waveScopeRaw);
  } catch (err) {
    fail(`Malformed JSON in wave-scope ${waveScopePath}: ${err.message}`, 1);
  }
  const allowed = waveScope?.allowedPaths;
  if (Array.isArray(allowed)) {
    scopePaths = allowed.filter((p) => typeof p === 'string' && p.length > 0);
  }
}

// ---------------------------------------------------------------------------
// mode ← --mode override | session-type: from STATE.md | null
// ---------------------------------------------------------------------------

/** @type {string|null} */
let mode = null;
if (opts.mode !== undefined && opts.mode !== '') {
  mode = opts.mode;
} else {
  try {
    const stateRaw = readFileSync(stateMdPath, 'utf8');
    // STATE.md frontmatter is a simple `key: value` block delimited by `---`.
    // Read only the `session-type:` scalar — no full YAML parse needed.
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(stateRaw);
    const fmText = fmMatch ? fmMatch[1] : stateRaw;
    const typeMatch = /^session-type:\s*(.+?)\s*$/m.exec(fmText);
    if (typeMatch) {
      const v = typeMatch[1].replace(/^["']|["']$/g, '').trim();
      if (v) mode = v;
    }
  } catch {
    // STATE.md unreadable → leave mode null (no mode gating).
  }
}

// ---------------------------------------------------------------------------
// hostClass ← --host-class override | host.json | null
// ---------------------------------------------------------------------------

/** @type {string|null} */
const hostClass =
  opts['host-class'] !== undefined && opts['host-class'] !== ''
    ? opts['host-class']
    : readHostClass(hostJsonPath); // null on any I/O or parse error

// ---------------------------------------------------------------------------
// context ← --context override | null (default = no tier gating)
// ---------------------------------------------------------------------------
//
// CRITICAL: when --context is NOT passed, context remains null and tier gating
// is fully disabled — existing behaviour is preserved, existing tests stay green.

/** @type {string|null} */
const context = opts.context !== undefined && opts.context !== '' ? opts.context : null;

// ---------------------------------------------------------------------------
// Load + emit
// ---------------------------------------------------------------------------

let rules;
try {
  rules = loadApplicableRules({ rulesDir, scopePaths, mode, hostClass, context });
} catch (err) {
  fail(`Rule loading failed: ${err.message}`, 2);
}

// NOTE (#876): deliberately no `process.exit(0)` after these stdout writes.
// process.stdout.write() to a pipe is ASYNCHRONOUS in Node — an explicit
// process.exit() terminates the process before the kernel pipe buffer (64KiB
// on macOS) has been fully drained, silently truncating any payload beyond
// that threshold with exit code still 0. Letting the script fall off the end
// lets Node's event loop wait for the pending write to flush before the
// process exits naturally (default exit code 0) — the fix generalizes to any
// payload size, not just today's measured ~105KB. The three branches below
// are mutually exclusive (if/else-if/else) so only one ever writes to stdout.
// When the reader closes early instead of draining to completion, the write
// fails with EPIPE — handled asynchronously by the process.stdout 'error'
// listener registered near the top of this file, not by anything here.
if (opts.json) {
  const out = {
    count: rules.length,
    rules: rules.map((r) => ({
      path: r.path,
      alwaysOn: r.alwaysOn,
      matchedGlobs: r.matchedGlobs,
    })),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else if (rules.length === 0) {
  // Empty match set → print nothing (caller injects nothing).
} else {
  const header = '## Applicable Rules (scoped to this wave)';
  const body = rules.map((r) => r.content.trimEnd()).join('\n\n---\n\n');
  process.stdout.write(`${header}\n\n${body}\n`);
}
