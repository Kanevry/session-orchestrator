/**
 * skills/discovery/probes/insecure-infra-defaults.mjs
 *
 * Probe (#1770): surfaces insecure infrastructure defaults — publicly bound
 * Compose ports, disabled SSH host-key checking, admin panels behind Caddy
 * without an access guard — by RUNNING the pattern SSOT, never by carrying a
 * copy of its patterns. The SSOT is `scripts/check-insecure-defaults.sh` in the
 * private companion baseline; this module only reads its `--json` output.
 * New classes arrive through the SSOT and are passed through unchanged.
 *
 * Discovery-only: never wired into session-end Phase 2.4.
 *
 * SSOT contract (script header): `--json` prints an array of
 * {file, line, class, text}. Exit 0 = clean (≥1 checkable file scanned),
 * 1 = findings, 2 = usage/read error, zero checkable files, or python3 missing.
 *
 * Mapping:
 *   no baseline configured          → skipped `no-baseline` (public fallback)
 *   baseline resolver throws        → skipped `baseline-unavailable` (also: not a dir, symlink)
 *   baseline inside the scanned repo → skipped `baseline-inside-repo`
 *   script absent in the baseline   → skipped `no-ssot-script`
 *   script path unsafe (symlink …)  → skipped `ssot-script-unsafe`
 *   exit 0                          → status ok, no findings
 *   exit 1 + valid records          → one medium finding per (class, file)
 *   exit 1 + unparseable/no records → degraded, never "zero findings"
 *   exit 2 / other exit             → skipped `ssot-exit-2` / `ssot-exit-other`
 *   timeout / spawn error / buffer  → skipped `ssot-timeout` / `ssot-spawn-error` / `ssot-output-too-large`
 * The script's stderr never enters the result — only the fixed reason strings.
 *
 * Record fields come from the scanned repo's files and are untrusted DATA:
 * `text` is stripped of C0/C1 controls, ANSI escapes and bidi controls,
 * collapsed to one line and truncated; `file` must be a relative path without
 * `..` or control characters; `line` a positive integer; invalid records are
 * dropped and counted in `metrics.dropped_records`.
 *
 * Baseline: HOST-LOCAL only (env SO_BASELINE_PATH > owner.yaml paths.baseline-path);
 * the scanned repo's committed Session Config is never consulted. The script runs
 * with cwd = baseline root and PYTHONSAFEPATH=1, never with the repo as cwd.
 * The SSOT prints `file` as ROOT + relative path; the probe relativizes it.
 *
 * Signature matches the sibling probes: runProbe(projectRoot, config, deps).
 * `deps` (tests only): { resolveBaseline(repoRoot), hostPaths: {env, ownerConfig},
 * runScript(scriptPath, repoRoot, {timeoutMs, cwd}), timeoutMs }.
 *
 * Output: {findings[], metrics, duration_ms, [skipped_reason]}. Never throws.
 */

import { execFile } from '../../../scripts/lib/native-command.mjs';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { baselineSourcePath } from '../../../scripts/lib/baseline-archetypes.mjs';
import { loadHostPaths, resolveHostPath } from '../../../scripts/lib/config/host-paths.mjs';

const PROBE = 'insecure-infra-defaults';
const SSOT_SCRIPT = 'scripts/check-insecure-defaults.sh';
const DEFAULT_TIMEOUT_MS = 20_000;
// Ceiling: 4 MiB of JSON (~20k records). Revisit if a real repo ever trips
// `ssot-output-too-large` — the SSOT would then need a summary mode, not a bigger buffer.
const MAX_BUFFER = 4 * 1024 * 1024;
const TEXT_MAX = 200;
const FILE_MAX = 512;
// Ceiling: at most 50 line numbers kept per (class, file) group; `count` stays exact.
// Revisit if triage needs the full list (it can re-run the SSOT locally).
const LINES_MAX = 50;
const CLASS_RE = /^[a-z][a-z0-9-]{0,63}$/;

// ANSI CSI (ESC [ … final) and OSC (ESC ] … BEL|ST) sequences, then any lone ESC pair.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
// C0, DEL, C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
// Bidi embedding/override/isolate marks and the Arabic letter mark.
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Unicode LINE / PARAGRAPH SEPARATOR: line breaks in model-read output. sanitizeText's
// `\s+` collapse already turns them into spaces; validateFile must reject them.
const LINE_SEP_RE = /[\u2028\u2029]/;

/** Untrusted repo content → one printable line of at most TEXT_MAX chars. */
export function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  const flat = value
    .replace(ANSI_RE, '')
    .replace(/[\r\n\t\v\f]+/g, ' ')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
}

/** A relative, `..`-free, control-free path — otherwise null. */
export function validateFile(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > FILE_MAX) return null;
  // Non-global copies: a /g regex keeps lastIndex state between .test() calls.
  if (new RegExp(CONTROL_RE.source).test(value) || new RegExp(BIDI_RE.source).test(value)) return null;
  if (LINE_SEP_RE.test(value)) return null;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return null;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  if (value.split(/[\\/]/).some((segment) => segment === '..')) return null;
  return value;
}

function fingerprint(cls, file) {
  return createHash('sha256').update(`${PROBE}\0${cls}\0${file}`).digest('hex').slice(0, 16);
}

/**
 * Host-local baseline only: env `SO_BASELINE_PATH` > owner.yaml `paths.baseline-path`.
 * The scanned repo's committed `plan-baseline-path` is deliberately NOT consulted —
 * otherwise a foreign repo could point the probe at a script it ships itself.
 * Returns the realpath, or null when nothing is configured or the path is missing.
 */
function resolveHostBaseline(hostPaths) {
  const configured = resolveHostPath('baseline-path', null, hostPaths);
  if (typeof configured !== 'string' || !configured.trim()) return null;
  const root = path.resolve(configured.trim().replace(/^~(?=\/|$)/u, homedir()));
  let stat;
  try { stat = lstatSync(root); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('baseline-unavailable');
  return realpathSync(root);
}

/** True when `inner` equals `outer` or lies below it (both realpaths). */
function isInside(inner, outer) {
  return inner === outer || inner.startsWith(`${outer}${path.sep}`);
}

/**
 * SSOT `file` → repo-relative POSIX path, or null. The SSOT prints ROOT joined
 * with the relative path (ROOT exactly as passed), so an absolute value must
 * start with `repoRoot + sep`; an absolute path outside the root is dropped.
 */
function relativizeFile(value, repoRoot) {
  if (typeof value !== 'string') return null;
  if (!path.isAbsolute(value)) return validateFile(value);
  const prefix = `${repoRoot}${path.sep}`;
  if (!value.startsWith(prefix)) return null;
  return validateFile(value.slice(prefix.length).split(path.sep).join('/'));
}

/**
 * Default runner: execFile, never a shell string. Normalises every outcome.
 * `cwd` is the (owner-controlled) baseline root, never the scanned repo: the SSOT
 * ends in `python3 -`, which puts the cwd first on sys.path, so a `json.py` in the
 * repo would run. PYTHONSAFEPATH=1 (Python ≥3.11) drops that entry as defence in depth.
 */
function defaultRunScript(scriptPath, repoRoot, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath, '--json', repoRoot],
      {
        cwd,
        env: { ...process.env, PYTHONSAFEPATH: '1' },
        timeout: timeoutMs, maxBuffer: MAX_BUFFER, shell: false, killSignal: 'SIGKILL', encoding: 'utf8',
      },
      (error, stdout) => {
        if (!error) return resolve({ exitCode: 0, stdout, failure: null });
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ exitCode: null, stdout: '', failure: 'max-buffer' });
        if (error.killed || error.signal) return resolve({ exitCode: null, stdout: '', failure: 'timeout' });
        if (typeof error.code === 'number') return resolve({ exitCode: error.code, stdout, failure: null });
        return resolve({ exitCode: null, stdout: '', failure: 'spawn-error' });
      },
    );
  });
}

/** Group valid records into one finding per (class, file). */
function buildFindings(records, repoRoot) {
  const groups = new Map();
  let dropped = 0;
  for (const record of records) {
    const file = record && typeof record === 'object' ? relativizeFile(record.file, repoRoot) : null;
    const cls = record && typeof record.class === 'string' && CLASS_RE.test(record.class) ? record.class : null;
    const line = record && Number.isInteger(record.line) && record.line > 0 ? record.line : null;
    if (!file || !cls || !line) { dropped++; continue; }
    const key = `${cls}\0${file}`;
    let group = groups.get(key);
    if (!group) {
      group = { cls, file, lines: [], count: 0, sample: sanitizeText(record.text) };
      groups.set(key, group);
    }
    group.count++;
    if (group.lines.length < LINES_MAX) group.lines.push(line);
  }
  const findings = [...groups.values()].map(({ cls, file, lines, count, sample }) => ({
    probe: PROBE,
    category: 'infra',
    severity: 'medium',
    confidence: 0.8,
    fingerprint: fingerprint(cls, file),
    title: `[${PROBE}] ${cls} in ${file} (${count} line${count === 1 ? '' : 's'})`,
    evidence: { class: cls, file, lines: lines.sort((a, b) => a - b), count, sample },
  }));
  return { findings, dropped };
}

/**
 * @param {string} projectRoot  Absolute path to the repo running discovery.
 * @param {object} [_config]    Parsed Session Config (unused; the probe is ungated).
 * @param {object} [deps]       Injection seam for tests.
 * @returns {Promise<object>}   { findings, metrics, duration_ms [, skipped_reason] }
 */
export async function runProbe(projectRoot, _config = {}, deps = {}) {
  const startMs = Date.now();
  const resolveBaseline = deps.resolveBaseline ?? (() => resolveHostBaseline(deps.hostPaths ?? loadHostPaths()));
  const runScript = deps.runScript ?? defaultRunScript;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = (status, { findings = [], records = 0, dropped = 0, reason } = {}) => ({
    findings,
    metrics: { status, records, findings: findings.length, dropped_records: dropped },
    duration_ms: Date.now() - startMs,
    ...(reason && { skipped_reason: reason }),
  });

  try {
    const repoRoot = path.resolve(projectRoot);

    let baseline;
    try { baseline = await resolveBaseline(repoRoot); } catch { return result('skipped', { reason: 'baseline-unavailable' }); }
    if (!baseline) return result('skipped', { reason: 'no-baseline' });
    // A baseline inside the scanned repo is repo-controlled code, whatever the resolver.
    let baselineReal;
    try { baselineReal = realpathSync(baseline); } catch { return result('skipped', { reason: 'baseline-unavailable' }); }
    if (isInside(baselineReal, realpathSync(repoRoot))) return result('skipped', { reason: 'baseline-inside-repo' });

    let scriptPath;
    try {
      scriptPath = baselineSourcePath(baseline, SSOT_SCRIPT, false, { missingReason: 'no-ssot-script' });
    } catch (error) {
      return result('skipped', { reason: error?.reason === 'no-ssot-script' ? 'no-ssot-script' : 'ssot-script-unsafe' });
    }

    const run = await runScript(scriptPath, repoRoot, { timeoutMs, cwd: baselineReal });
    if (run.failure === 'timeout') return result('skipped', { reason: 'ssot-timeout' });
    if (run.failure === 'max-buffer') return result('skipped', { reason: 'ssot-output-too-large' });
    if (run.failure || run.exitCode === null || run.exitCode === undefined) return result('skipped', { reason: 'ssot-spawn-error' });
    if (run.exitCode === 0) return result('ok');
    if (run.exitCode === 2) return result('skipped', { reason: 'ssot-exit-2' });
    if (run.exitCode !== 1) return result('skipped', { reason: 'ssot-exit-other' });

    // Exit 1 means "findings": anything that does not yield at least one valid
    // record is degraded, never reported as a clean run.
    let records;
    try { records = JSON.parse(run.stdout); } catch { return result('degraded', { reason: 'ssot-unparseable' }); }
    if (!Array.isArray(records)) return result('degraded', { reason: 'ssot-unparseable' });
    const { findings, dropped } = buildFindings(records, repoRoot);
    if (findings.length === 0) return result('degraded', { records: records.length, dropped, reason: 'ssot-no-valid-records' });
    return result('findings', { findings, records: records.length, dropped });
  } catch {
    // Top-level safety net — probe must never throw; no host path in the reason.
    return result('skipped', { reason: 'probe-error' });
  }
}

export default runProbe;
