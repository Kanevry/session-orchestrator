/**
 * snapshot-probe.mjs — run the suite on the CURATED public snapshot tree (#1712).
 *
 * The curated GitHub export drops the paths in `.orchestrator/policy/public-export.json`.
 * A test that depends on one of those paths is green in the private repo and red on the
 * public mirror — release 5.13.0 found that out on its first curated push (test B5 in
 * `tests/lib/vault-mirror/namespace.test.mjs` needed `.vault.yaml`). This probe builds the
 * snapshot tree through the SAME helper the export uses (`writeSnapshotTree`),
 * materializes it OUTSIDE the repo as its own one-commit git repo without any remote,
 * and runs validate-plugin and the test command there. Under a policy with an `include` list
 * (the slim mirror, #1594) the `test` step is `npm run test:mirror`, the same command GitHub's
 * `test` job runs: what GitHub runs passes on what GitHub gets.
 *
 * Only runs with a suite step write a receipt. Receipts are keyed by the snapshot TREE: a source commit that changes only excluded
 * files maps to the same tree and reuses the receipt; any change to a public file or to
 * the policy yields a new tree and invalidates it.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGitRunner, readSourcePolicy, writeSnapshotTree } from './github-export.mjs';
import { isPublicExportExcluded } from './validate/check-owner-leakage.mjs';
import { writeJsonAtomicSync } from './io.mjs';
import { runRemoteGate } from './pre-push-remote-gate.mjs';
import { registerExitCleanup, spawnInGroup } from './process-group.mjs';
import { spawnSync } from './native-command.mjs';

export const RECEIPT_SCHEMA = 1;
export const RECEIPT_DIR_REL = '.orchestrator/tmp/snapshot-probe';
/** Basename of the materialized tree — offload derives the repo name from it. */
export const SNAPSHOT_DIRNAME = 'session-orchestrator';
export const KNOWN_STEPS = ['validate-plugin', 'test'];
/** Name of the step that replaces `test` when the suite runs on a remote host. */
export const REMOTE_STEP = 'remote-gate';
const HOST_ALIAS_SHAPE = /^[A-Za-z0-9._-]+$/;
// SHA-1 (40) or SHA-256 (64) object id — the receipt file name is built from it.
const TREE_ID_SHAPE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const TAIL_LINES = 40;
const STEP_SPECS = {
  'validate-plugin': { cmd: process.execPath, args: ['scripts/validate-plugin.mjs'], timeoutMs: 600_000 },
  // The repo's Session Config test-command (`npm test`).
  test: { cmd: 'npm', args: ['test'], timeoutMs: 1_800_000 },
};
/**
 * The `test` step under a policy with an `include` list (#1594): that mirror carries no
 * tests/, vitest or eslint config, and GitHub's `test` job runs this smoke instead. Same step
 * NAME, so the release preflight's receipt check reads it unchanged.
 */
const MIRROR_TEST_SPEC = { cmd: 'npm', args: ['run', 'test:mirror'], timeoutMs: 600_000 };
const PROBE_IDENTITY = ['-c', 'user.name=snapshot-probe', '-c', 'user.email=snapshot-probe@example.invalid'];
const PROBE_GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false'];
// Git location variables would point every git call in the snapshot back at the source repo.
const GIT_LOCATION_VARS = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);

/** Thrown for git/tar/mkdtemp failures — the CLI maps it to exit 2. */
export class SnapshotProbeSystemError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotProbeSystemError';
  }
}

/**
 * Environment for everything run inside the snapshot: drops the platform root variables
 * (`*PROJECT_DIR`, `*PLUGIN_ROOT`, `*RULES_DIR` — they win over cwd in path resolution,
 * same sweep as `.husky/pre-push`) and the git location variables.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {Record<string, string>}
 */
export function buildProbeEnv(base = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/(PROJECT_DIR|PLUGIN_ROOT|RULES_DIR)$/.test(key) || GIT_LOCATION_VARS.has(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Default step runner: own process group, so a timeout kills npm AND its vitest workers.
 * @param {string} cmd @param {string[]} args
 * @param {{ cwd: string, env: Record<string,string>, timeoutMs: number }} opts
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string, durationMs: number, timedOut: boolean }>}
 */
export async function defaultRunner(cmd, args, { cwd, env, timeoutMs }) {
  const res = await spawnInGroup([cmd, ...args], { cwd, env, timeoutMs, maxOutputBytes: 64 * 1024 * 1024 });
  return { status: res.exitCode, stdout: res.fullOutput, stderr: '', durationMs: res.durationMs, timedOut: res.timedOut };
}

/**
 * Best-effort list of failed test files from vitest output (`FAIL  <file> > …`).
 * @param {string} output
 * @returns {string[]}
 */
export function parseFailedFiles(output) {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const files = new Set();
  for (const m of plain.matchAll(/^\s*(?:[×❯]\s*)?FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/gm)) files.add(m[1]);
  return [...files];
}

function tailOf(text, lines = TAIL_LINES) {
  return text.split('\n').slice(-lines - 1).join('\n').trimEnd();
}

/** Resolve source and write the snapshot tree. @param {import('./github-export.mjs').GitRunner} git */
function snapshotTreeOf(git, source) {
  const rev = git(['rev-parse', '--verify', '--quiet', `${source}^{commit}`]);
  if (rev.status !== 0) return { ok: false, reason: `source '${source}' does not resolve to a commit` };
  const sourceSha = rev.stdout.trim();
  const policy = readSourcePolicy(git, sourceSha);
  if (!policy.ok) return { ok: false, reason: policy.reason, sourceSha };
  // `includes` must reach the tree writer: without it the probe tests a wider tree than the export publishes.
  const includes = policy.includes ?? null;
  const snap = writeSnapshotTree({ git, sourceSha, excludes: policy.excludes, includes });
  if (!snap.ok) return { ok: false, reason: snap.reason, sourceSha };
  return { ok: true, sourceSha, excludes: policy.excludes, includes, ...snap };
}

/**
 * Snapshot tree of a source commit, without materializing it or running anything.
 * Stable shape — the release preflight keys its receipt lookup on it.
 * @param {{ repoRoot: string, source?: string, git?: import('./github-export.mjs').GitRunner }} opts
 * @returns {{ ok: true, sourceSha: string, snapshotTree: string } | { ok: false, reason: string, sourceSha?: string }}
 */
export function computeSnapshotTree({ repoRoot, source = 'HEAD', git = createGitRunner(repoRoot) }) {
  const snap = snapshotTreeOf(git, source);
  if (!snap.ok) return snap;
  return { ok: true, sourceSha: snap.sourceSha, snapshotTree: snap.tree };
}

/**
 * @param {string} repoRoot @param {string} snapshotTree
 * @throws {TypeError} when `snapshotTree` is not a git object id (it becomes a path segment)
 */
export function receiptPath(repoRoot, snapshotTree) {
  if (typeof snapshotTree !== 'string' || !TREE_ID_SHAPE.test(snapshotTree)) {
    throw new TypeError(`snapshot tree '${snapshotTree}' is not a git object id`);
  }
  return join(repoRoot, RECEIPT_DIR_REL, `${snapshotTree}.json`);
}

/**
 * Read the probe receipt for a snapshot tree. Absent, unreadable and schema-mismatched
 * receipts are distinguished in `reason`; all three mean "not proven".
 * @param {{ repoRoot: string, snapshotTree: string }} opts
 * @returns {{ ok: true, receipt: object } | { ok: false, receipt: null, reason: 'invalid-tree'|'absent'|'unreadable'|'schema-mismatch' }}
 */
export function readSnapshotProbeReceipt({ repoRoot, snapshotTree }) {
  if (typeof snapshotTree !== 'string' || !TREE_ID_SHAPE.test(snapshotTree)) return { ok: false, receipt: null, reason: 'invalid-tree' };
  const file = receiptPath(repoRoot, snapshotTree);
  if (!existsSync(file)) return { ok: false, receipt: null, reason: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, receipt: null, reason: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schema !== RECEIPT_SCHEMA || parsed.snapshotTree !== snapshotTree) {
    return { ok: false, receipt: null, reason: 'schema-mismatch' };
  }
  return { ok: true, receipt: parsed };
}

/** Count non-directory entries below `dir`. */
function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

/** Key for removed paths that no exclude entry names but the include list leaves out. */
export const NOT_INCLUDED_KEY = '(not in include)';

/** Removed paths grouped by the policy entry that matched them. */
function groupByPrefix(removed, excludes, includes) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const p of removed) {
    const key = excludes.find((e) => isPublicExportExcluded(p, [e], null))
      ?? (isPublicExportExcluded(p, [], includes) ? NOT_INCLUDED_KEY : p);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * git inside the materialized snapshot, with the probe env (no location vars).
 * @param {string} cwd @param {string[]} args @param {Record<string,string>} env
 */
function snapshotGit(cwd, args, env) {
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new SnapshotProbeSystemError(`git ${args.filter((a) => !a.includes('=')).join(' ')} failed in the snapshot: ${(res.stderr || String(res.error?.message ?? '')).trim()}`);
  return res.stdout;
}

/**
 * Materialize `tree` into `<dir>/session-orchestrator` as a one-commit repo with no remote.
 * @returns {{ root: string, commit: string, exported: number }}
 */
function materialize({ git, tree, dir, nodeModules, env }) {
  const root = join(dir, SNAPSHOT_DIRNAME);
  mkdirSync(root);
  const tarFile = join(dir, 'snapshot.tar');
  const arch = git(['archive', '--format=tar', '-o', tarFile, tree]);
  if (arch.status !== 0) throw new SnapshotProbeSystemError(`git archive ${tree} failed: ${arch.stderr.trim()}`);
  const tar = spawnSync('tar', ['-x', '-f', tarFile, '-C', root], { encoding: 'utf8' });
  if (tar.status !== 0) throw new SnapshotProbeSystemError(`tar -x failed: ${(tar.stderr || String(tar.error?.message ?? '')).trim()}`);
  rmSync(tarFile, { force: true });
  const exported = countFiles(root);

  snapshotGit(root, [...PROBE_GIT_CONFIG, 'init', '-q', '-b', 'main'], env);
  // A symlink is a FILE to git, so `.gitignore`'s `node_modules/` does not cover it.
  writeFileSync(join(root, '.git', 'info', 'exclude'), '/node_modules\n', { flag: 'a' });
  if (existsSync(nodeModules)) symlinkSync(nodeModules, join(root, 'node_modules'), 'dir');
  snapshotGit(root, [...PROBE_GIT_CONFIG, 'add', '-A'], env);
  snapshotGit(root, [...PROBE_IDENTITY, ...PROBE_GIT_CONFIG, 'commit', '-q', '--no-verify', '-m', `snapshot ${tree}`], env);
  const commit = snapshotGit(root, ['rev-parse', 'HEAD'], env).trim();
  // The committed tree must BE the snapshot tree: catches a lossy extract or a stray file.
  const committedTree = snapshotGit(root, ['rev-parse', 'HEAD^{tree}'], env).trim();
  if (committedTree !== tree) throw new SnapshotProbeSystemError(`materialized tree ${committedTree} differs from snapshot tree ${tree}`);
  return { root, commit, exported };
}

/**
 * The suite step on a remote host: the pre-push router's gate against the snapshot commit.
 * Code 0 passes and code 1 with a finished suite is red. Every other code (2: host unknown
 * or not ready, none ran; 10: fallback), and code 1 from a gate that did not finish, means
 * no verdict on the snapshot, so it is thrown as a system error before any receipt is written.
 */
async function runRemoteStep({ remoteGate, root, commit, repoRoot, host }) {
  const started = Date.now();
  const r = await remoteGate({
    tree: root, sha: commit, ledgerRoot: repoRoot,
    // Telemetry off: a snapshot commit is not a pushed sha.
    env: { ...process.env, SO_GATE_HOSTS: host }, emit: false, jobPrefix: 'snapshot-probe',
    // The probe's stdout carries its own result (one JSON object with --json); the remote
    // gate's output is diagnostics here.
    stdout: process.stderr,
  });
  if (r.code !== 0 && r.code !== 1) {
    const why = r.code === 2 ? `host '${host}' unknown or not ready`
      : r.code === 10 ? 'fallback, the gate did not run remotely' : 'unexpected exit code';
    throw new SnapshotProbeSystemError(`remote gate code ${r.code}: ${why} — the suite did not run, no receipt written`);
  }
  // Code 1 from a gate that never finished is a missing measurement, not a red snapshot:
  // the gate hit its own budget (gate-timeout), a check timed out, or no test result exists
  // at all. A dying suite (`suite_died`) stays red — the snapshot itself can cause it.
  const report = r.report;
  if (r.code === 1 && (report?.error === 'gate-timeout' || !report?.test ||
      [report.test, report.typecheck, report.lint].some((check) => check?.timed_out === true))) {
    const alias = r.alias ?? host;
    const detail = report?.error === 'gate-timeout'
      ? `gate-timeout after ${report.duration_ms ?? report.timeout_ms ?? '?'} ms`
      : !report?.test ? 'no test result in the remote receipt' : 'a check timed out';
    throw new SnapshotProbeSystemError(`remote gate did not finish on ${alias} (${detail}) — the suite did not run to completion, no receipt written; retry on a less loaded host, e.g. --host win-wsl`);
  }
  /** @type {Record<string, unknown>} */
  const step = { name: REMOTE_STEP, status: r.code === 0 ? 'pass' : 'fail', exitCode: r.code, durationMs: Date.now() - started };
  if (r.code === 1) {
    step.reason = `remote gate failed on ${r.alias ?? host}`;
    const failedFiles = r.report?.test?.failed_files;
    if (Array.isArray(failedFiles) && failedFiles.length > 0) step.failedFiles = failedFiles;
  }
  return step;
}

/** Errors a killed child can still cause while its tree is removed (#1723). */
const RM_RETRY_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

/**
 * Remove `dir` on the exit path, retrying up to 3 times with a real synchronous pause of
 * 50, 100 and 150 ms. The exit handler sends SIGKILL to the gate's group without awaiting
 * it, so a vitest worker can still write here for a few milliseconds (#1723). `rmSync`'s
 * own `retryDelay` does not help: Node 24 truncates it to whole seconds (measured on
 * v24.22.0: 3 retries at 50 ms waited 0 ms, at 400 ms 2004 ms over two failing operations).
 * Ceiling: a child still writing after ~300 ms leaves its rest in TMPDIR; the last error
 * reaches the exit path, which swallows it.
 *
 * @param {string} dir
 * @returns {void}
 */
function removeTreeOnExit(dir) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt > 3 || !RM_RETRY_CODES.has(err?.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

/**
 * Build the curated snapshot of `source`, materialize it outside the repo and run the
 * requested steps there.
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.source='HEAD']
 * @param {boolean} [opts.keep=false] keep the materialized directory (returned as `dir`)
 * @param {string} [opts.tmpRoot]
 * @param {string[]|null} [opts.steps] default (null): `test` alone when the policy has an
 *   `include` list (validate-plugin reads CLAUDE.md, AGENTS.md, .husky/ and .gitlab-ci.yml,
 *   which that mirror does not carry), else `validate-plugin` and `test`. Under an `include`
 *   list the `test` step runs `npm run test:mirror`, what GitHub's `test` job runs.
 * @param {import('./github-export.mjs').GitRunner} [opts.git]
 * @param {typeof defaultRunner} [opts.runner]
 * @param {string} [opts.nodeModules]
 * @param {boolean} [opts.writeReceipt=true] write the tree-keyed receipt — only when a suite
 *   step (`test` or `remote-gate`) ran; a validate-plugin-only run leaves any receipt untouched
 * @param {() => Date} [opts.now]
 * @param {string|null} [opts.host=null] offload host alias: the `test` step then runs as one
 *   `remote-gate` step there (validate-plugin stays local). Refused with a system error for a
 *   policy with an `include` list: the remote gate runs the full quality gate, which cannot
 *   pass on a tree without tests/ and eslint config.
 * @param {typeof runRemoteGate} [opts.remoteGate]
 * @returns {Promise<object>} probe result; throws SnapshotProbeSystemError on git/tar/fs failure
 */
export async function runSnapshotProbe({
  repoRoot,
  source = 'HEAD',
  keep = false,
  tmpRoot = tmpdir(),
  steps = null,
  git = createGitRunner(repoRoot),
  runner = defaultRunner,
  nodeModules = join(repoRoot, 'node_modules'),
  writeReceipt = true,
  now = () => new Date(),
  host = null,
  remoteGate = runRemoteGate,
}) {
  if (steps !== null) for (const s of steps) if (!KNOWN_STEPS.includes(s)) throw new TypeError(`unknown step '${s}' (known: ${KNOWN_STEPS.join(', ')})`);
  if (host !== null && (typeof host !== 'string' || !HOST_ALIAS_SHAPE.test(host) || host === '.' || host === '..')) {
    throw new TypeError(`invalid host alias '${host}'`);
  }
  const route = host === null ? 'local' : `remote:${host}`;
  const startedAt = now().toISOString();
  const snap = snapshotTreeOf(git, source);
  if (!snap.ok) throw new SnapshotProbeSystemError(snap.reason);
  const mirror = snap.includes !== null;
  const runSteps = steps ?? (mirror ? ['test'] : [...KNOWN_STEPS]);
  if (mirror && host !== null && runSteps.includes('test')) {
    throw new SnapshotProbeSystemError('--host runs the full quality gate, which cannot pass on the curated mirror (the policy has an include list: no tests/, no eslint config); run the mirror smoke with --local instead');
  }

  let dir;
  try {
    dir = mkdtempSync(join(tmpRoot, 'so-snapshot-probe-'));
  } catch (err) {
    throw new SnapshotProbeSystemError(`mkdtemp in ${tmpRoot} failed: ${err.message}`);
  }
  // The finally below never runs on SIGINT/SIGTERM/SIGHUP (#1715): register exactly this dir.
  const unregisterCleanup = keep ? () => {} : registerExitCleanup(() => removeTreeOnExit(dir));
  const env = buildProbeEnv();
  try {
    const { root, commit, exported } = materialize({ git, tree: snap.tree, dir, nodeModules, env });
    const expected = snap.sourceFiles - snap.removed.length;
    if (exported !== expected) throw new SnapshotProbeSystemError(`materialized ${exported} files, expected ${expected}`);
    // No `origin`: a test that reaches the source repo through a remote must fail here.
    if (snapshotGit(root, ['remote'], env).trim() !== '') {
      throw new SnapshotProbeSystemError('the snapshot repo has a remote');
    }

    const stepResults = [];
    for (const name of runSteps) {
      if (name === 'test' && host !== null) {
        stepResults.push(await runRemoteStep({ remoteGate, root, commit, repoRoot, host }));
        continue;
      }
      const spec = name === 'test' && mirror ? MIRROR_TEST_SPEC : STEP_SPECS[name];
      const res = await runner(spec.cmd, spec.args, { cwd: root, env, timeoutMs: spec.timeoutMs });
      const status = res.timedOut ? 'timeout' : res.status === 0 ? 'pass' : 'fail';
      /** @type {Record<string, unknown>} */
      const step = { name, status, exitCode: res.status, durationMs: res.durationMs };
      if (status !== 'pass') {
        const output = `${res.stdout ?? ''}${res.stderr ? `\n${res.stderr}` : ''}`;
        const failedFiles = parseFailedFiles(output);
        if (failedFiles.length > 0) step.failedFiles = failedFiles;
        step.tail = tailOf(output);
      }
      stepResults.push(step);
    }

    const ok = stepResults.every((s) => s.status === 'pass');
    // Receipts are keyed by tree only: a run without a suite step must not replace a fuller one.
    const receiptWritten = writeReceipt && stepResults.some((s) => s.name === 'test' || s.name === REMOTE_STEP);
    const finishedAt = now().toISOString();
    const result = {
      ok,
      sourceSha: snap.sourceSha,
      snapshotTree: snap.tree,
      snapshotCommit: commit,
      route,
      counts: { source: snap.sourceFiles, excluded: snap.removed.length, exported },
      excludedByPrefix: groupByPrefix(snap.removed, snap.excludes, snap.includes),
      hasOrigin: false,
      ...(keep ? { dir: root } : {}),
      steps: stepResults,
      receiptWritten,
      startedAt,
      finishedAt,
    };

    if (receiptWritten) {
      const receipt = {
        schema: RECEIPT_SCHEMA,
        sourceSha: snap.sourceSha,
        snapshotTree: snap.tree,
        ok,
        route,
        steps: stepResults.map(({ name, status, exitCode, durationMs }) => ({ name, status, exitCode, durationMs })),
        finishedAt,
      };
      const file = receiptPath(repoRoot, snap.tree);
      mkdirSync(join(repoRoot, RECEIPT_DIR_REL), { recursive: true });
      const written = writeJsonAtomicSync(file, receipt, { tmpPrefix: '.snapshot-probe' });
      if (!written.ok) throw new SnapshotProbeSystemError(`writing the receipt failed: ${written.error}`);
    }
    return result;
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
    unregisterCleanup();
  }
}
