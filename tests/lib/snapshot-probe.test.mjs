/**
 * tests/lib/snapshot-probe.test.mjs — suite run on the curated public snapshot (#1712).
 *
 * Fixture: a throwaway source repo whose policy excludes one file and one directory.
 * The injected runner inspects the materialized tree instead of running a real suite.
 * Every test names the bug it catches.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGitRunner } from '../../scripts/lib/github-export.mjs';
import { validatePublicExportPolicy } from '../../scripts/lib/validate/check-owner-leakage.mjs';
import {
  SnapshotProbeSystemError,
  computeSnapshotTree,
  readSnapshotProbeReceipt,
  receiptPath,
  runSnapshotProbe,
} from '../../scripts/lib/snapshot-probe.mjs';
import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

// win32: runSnapshotProbe spawns `offload run …` by name in a snapshot dir it
// creates itself; the fake is a node shebang script Windows cannot start, and a
// node.exe fake would need its `run` script in that not-yet-existing cwd.
const offloadTitle = (title) => (process.platform === 'win32' ? `${title} [skipped on win32: needs the shebang offload fake on PATH]` : title);

const ID_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const POLICY = {
  version: 1,
  rationale: 'fixture',
  exclude: [
    { path: '.vault.yaml', reason: 'fixture', issue: '#1712' },
    { path: 'docs/audits/', reason: 'fixture', issue: '#1712' },
  ],
};

const dirs = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) removeTree(dirs.pop());
});

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}
function commitAll(dir, msg) {
  fixtureGit(['add', '-A'], dir);
  fixtureGit(['commit', '-q', '-m', msg], dir, { env: ID_ENV });
}

function makeFixture() {
  const root = makeTmpDir('so-snapshot-probe-test-');
  dirs.push(root);
  const repo = join(root, 'repo');
  const tmpRoot = join(root, 'tmp');
  const nodeModules = join(root, 'node_modules');
  mkdirSync(tmpRoot);
  mkdirSync(nodeModules);
  fixtureGit(['init', '-q', '-b', 'main', repo]);
  write(repo, {
    'README.md': 'public\n',
    'tests/a.test.mjs': 'export {};\n',
    '.vault.yaml': 'private: true\n',
    'docs/audits/report.md': 'private\n',
    '.orchestrator/policy/public-export.json': JSON.stringify(POLICY),
  });
  commitAll(repo, 'source');
  const base = createGitRunner(repo);
  const git = (args, o = {}) => base(args, { ...o, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...(o.env ?? {}) } });
  return { repo, tmpRoot, nodeModules, git };
}

describe('runSnapshotProbe', () => {
  it('fixture policy is a valid public-export policy', () => {
    // Bug: an invalid fixture policy would make every probe test fail for the wrong reason.
    expect(validatePublicExportPolicy(POLICY)).toEqual({ ok: true, excludes: ['.vault.yaml', 'docs/audits/'] });
  });

  it('materializes the curated tree outside the repo as a clean one-commit repo with no remote, and a validate-plugin-only run leaves the tree receipt untouched', async () => {
    // Bugs: excluded files reaching the probe tree (the B5 class goes unseen), an `origin`
    // remote that lets tests read the private repo, a dirty tree from the node_modules
    // symlink, platform root vars leaking in, a run without a suite step overwriting the
    // fuller green receipt of the same tree (receipts are keyed by tree only).
    const { repo, tmpRoot, nodeModules, git } = makeFixture();
    const { snapshotTree, sourceSha } = computeSnapshotTree({ repoRoot: repo, git });
    const fuller = {
      schema: 1, sourceSha, snapshotTree, ok: true, route: 'remote:m5',
      steps: [{ name: 'remote-gate', status: 'pass', exitCode: 0, durationMs: 9 }], finishedAt: '2026-10-20T00:00:00.000Z',
    };
    write(repo, { [join('.orchestrator/tmp/snapshot-probe', `${snapshotTree}.json`)]: JSON.stringify(fuller) });
    vi.stubEnv('CLAUDE_PROJECT_DIR', repo);
    const seen = {};
    const runner = async (cmd, args, { cwd, env }) => {
      seen.cwd = cwd;
      seen.vault = existsSync(join(cwd, '.vault.yaml'));
      seen.audits = existsSync(join(cwd, 'docs/audits'));
      seen.readme = existsSync(join(cwd, 'README.md'));
      seen.remotes = fixtureGit(['remote'], cwd).trim();
      seen.commits = fixtureGit(['rev-list', '--count', 'HEAD'], cwd).trim();
      seen.status = fixtureGit(['status', '--porcelain'], cwd).trim();
      seen.projectDir = env.CLAUDE_PROJECT_DIR;
      return { status: 0, stdout: 'ok\n', stderr: '', durationMs: 5, timedOut: false };
    };

    const r = await runSnapshotProbe({ repoRoot: repo, tmpRoot, steps: ['validate-plugin'], git, runner, nodeModules, now: () => new Date('2026-10-21T00:00:00Z') });

    expect(seen).toEqual({
      cwd: expect.stringContaining(tmpRoot),
      vault: false, audits: false, readme: true,
      remotes: '', commits: '1', status: '', projectDir: undefined,
    });
    expect(basename(seen.cwd)).toBe('session-orchestrator');
    expect(existsSync(seen.cwd)).toBe(false);
    expect(r).toMatchObject({
      ok: true, route: 'local', hasOrigin: false,
      counts: { source: 5, excluded: 2, exported: 3 },
      excludedByPrefix: { '.vault.yaml': 1, 'docs/audits/': 1 },
      steps: [{ name: 'validate-plugin', status: 'pass', exitCode: 0, durationMs: 5 }],
      receiptWritten: false,
    });
    expect(computeSnapshotTree({ repoRoot: repo, git })).toEqual({ ok: true, sourceSha: r.sourceSha, snapshotTree: r.snapshotTree });
    expect(readSnapshotProbeReceipt({ repoRoot: repo, snapshotTree: r.snapshotTree })).toEqual({ ok: true, receipt: fuller });
  });

  it('reports a failing step as a red snapshot with the failed files, and keeps the tree only with keep', async () => {
    // Bug: a red suite read as green (status keyed on anything but the exit code), or the
    // failing file lost from the report.
    const { repo, tmpRoot, nodeModules, git } = makeFixture();
    const output = ' ✓ tests/ok.test.mjs (3 tests)\n FAIL  tests/lib/vault-mirror/namespace.test.mjs > B5 > reads .vault.yaml\n';
    const runner = async () => ({ status: 1, stdout: output, stderr: '', durationMs: 7, timedOut: false });

    const r = await runSnapshotProbe({ repoRoot: repo, tmpRoot, steps: ['test'], git, runner, nodeModules, keep: true, writeReceipt: false });

    expect(r.ok).toBe(false);
    expect(r.steps).toEqual([{
      name: 'test', status: 'fail', exitCode: 1, durationMs: 7,
      failedFiles: ['tests/lib/vault-mirror/namespace.test.mjs'],
      tail: output.trimEnd(),
    }]);
    expect(existsSync(join(r.dir, 'README.md'))).toBe(true);
    expect(readSnapshotProbeReceipt({ repoRoot: repo, snapshotTree: r.snapshotTree })).toEqual({ ok: false, receipt: null, reason: 'absent' });
  });

  it('runs the suite as one remote-gate step against the snapshot commit, without telemetry, and records a blocked gate (code 1) as red', async () => {
    // Bugs: the gate pointed at the source sha or the source checkout instead of the
    // snapshot, a probe run emitting quality_gate events with a snapshot sha as pushed_sha,
    // validate-plugin sent remote too, or a red remote suite read as green.
    const { repo, tmpRoot, nodeModules, git } = makeFixture();
    const calls = [];
    const remoteGate = async (opts) => {
      calls.push({ ...opts, treeBase: basename(opts.tree), commit: fixtureGit(['rev-parse', 'HEAD'], opts.tree).trim() });
      return { code: 1, passed: false, alias: 'm5', report: { test: { failed_files: ['tests/b5.test.mjs'] } }, hostSource: 'override' };
    };
    const runner = async () => ({ status: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false });

    const r = await runSnapshotProbe({ repoRoot: repo, tmpRoot, git, runner, nodeModules, host: 'm5', remoteGate });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sha: r.snapshotCommit, commit: r.snapshotCommit, treeBase: 'session-orchestrator', ledgerRoot: repo,
      emit: false, jobPrefix: 'snapshot-probe', env: expect.objectContaining({ SO_GATE_HOSTS: 'm5' }),
    });
    expect(r.ok).toBe(false);
    expect(r.route).toBe('remote:m5');
    expect(r.steps.map((s) => [s.name, s.status, s.exitCode, s.failedFiles])).toEqual([
      ['validate-plugin', 'pass', 0, undefined], ['remote-gate', 'fail', 1, ['tests/b5.test.mjs']],
    ]);
    expect(readSnapshotProbeReceipt({ repoRoot: repo, snapshotTree: r.snapshotTree }).receipt).toMatchObject({ ok: false, route: 'remote:m5' });
  });

  // The code-1 report is the real receipt of a 2026-10-21 m5-remote run under load (redacted to the report).
  const GATE_TIMEOUT = { variant: 'full-gate', error: 'gate-timeout', timeout_ms: 960000, duration_ms: 960014, kill_signals: ['SIGTERM'], survivors: [] };
  it.each([
    ['code 2', 2, null, /code 2: host 'm5' unknown or not ready/],
    ['code 10', 10, null, /code 10: fallback/],
    ['code 1 + gate-timeout', 1, GATE_TIMEOUT, /did not finish on m5 \(gate-timeout after 960014 ms\).*--host win-wsl/],
    ['code 1 + timed-out test', 1, { variant: 'full-gate', test: { status: 'fail', timed_out: true }, typecheck: { status: 'pass' }, lint: { status: 'pass' } }, /did not finish on m5 \(a check timed out\)/],
  ])('treats %s (the suite did not run to completion) as a system error and leaves the green receipt untouched', async (_label, code, report, message) => {
    // Bugs: "host unknown / not ready / fallback" or a gate that hit its own budget reported
    // as a red snapshot (CLI exit 3) — a missing measurement disguised as a finding — and a
    // green receipt for the same tree overwritten with ok:false.
    const { repo, tmpRoot, nodeModules, git } = makeFixture();
    const { snapshotTree, sourceSha } = computeSnapshotTree({ repoRoot: repo, git });
    const green = {
      schema: 1, sourceSha, snapshotTree, ok: true, route: 'local',
      steps: [{ name: 'test', status: 'pass', exitCode: 0, durationMs: 9 }], finishedAt: '2026-10-20T00:00:00.000Z',
    };
    write(repo, { [join('.orchestrator/tmp/snapshot-probe', `${snapshotTree}.json`)]: JSON.stringify(green) });
    const remoteGate = async () => ({ code, passed: false, alias: code === 1 ? 'm5' : null, report, hostSource: 'override' });
    const runner = async () => ({ status: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false });

    const run = runSnapshotProbe({ repoRoot: repo, tmpRoot, git, runner, nodeModules, host: 'm5', remoteGate });
    await expect(run).rejects.toThrow(SnapshotProbeSystemError);
    await expect(run).rejects.toThrow(message);
    expect(readSnapshotProbeReceipt({ repoRoot: repo, snapshotTree })).toEqual({ ok: true, receipt: green });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(offloadTitle('keeps the remote gate output off stdout, so --json prints exactly one JSON object'), async () => {
    // Bug: runRemoteGate wrote the offload run's stdout (gate output, SO_PRE_PUSH_RESULT=…)
    // to process.stdout ahead of the probe's own JSON.
    const { repo, tmpRoot, nodeModules, git } = makeFixture();
    const bin = join(dirname(tmpRoot), 'bin');
    write(bin, { offload: '#!/usr/bin/env node\nif (process.argv[2] === "run") { process.stdout.write("REMOTE-NOISE\\nSO_PRE_PUSH_RESULT={\\"report\\":{\\"variant\\":\\"full-gate\\",\\"test\\":{\\"status\\":\\"fail\\"}}}\\n"); process.exit(1); }\n' });
    chmodSync(join(bin, 'offload'), 0o755);
    const offloadConfig = join(dirname(tmpRoot), 'offload-config');
    write(offloadConfig, { 'hosts/fakehost.env': '' });
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
    vi.stubEnv('OFFLOAD_CONFIG_DIR', offloadConfig);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const runner = async () => ({ status: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false });

    let r;
    let stdout;
    let stderr;
    try {
      r = await runSnapshotProbe({ repoRoot: repo, tmpRoot, git, runner, nodeModules, host: 'fakehost', steps: ['test'], writeReceipt: false });
    } finally {
      // mockRestore also clears the recorded calls — read them first.
      stdout = out.mock.calls.flat().join('');
      stderr = err.mock.calls.flat().join('');
      out.mockRestore();
      err.mockRestore();
    }

    expect(r.steps.map((s) => [s.name, s.status, s.exitCode])).toEqual([['remote-gate', 'fail', 1]]);
    expect(stdout).not.toContain('REMOTE-NOISE');
    expect(stderr).toContain('REMOTE-NOISE');
  });
  it.skipIf(process.platform === 'win32')('removes its snapshot dir when SIGTERM arrives mid-step, and still dies by the signal', () => {
    // Bug: dropping (or putting under `keep`) the registerExitCleanup call in runSnapshotProbe
    // leaves the ~2,400-file snapshot in TMPDIR after a signal (#1715/#1719); the finally
    // block never runs on a signal, and process-group.test.mjs only proves the mechanism.
    const { repo, tmpRoot, nodeModules } = makeFixture();
    const probeUrl = pathToFileURL(join(process.cwd(), 'scripts/lib/snapshot-probe.mjs')).href;
    const script = [
      `const { runSnapshotProbe } = await import(${JSON.stringify(probeUrl)});`,
      `const [repoRoot, tmpRoot, nodeModules] = process.argv.slice(1);`,
      `const runner = async (cmd, args, { cwd }) => {`,
      `  process.stderr.write('RUNNER_CWD=' + cwd + '\\n');`,
      `  process.kill(process.pid, 'SIGTERM');`,
      `  setInterval(() => {}, 1000);`,
      `  return new Promise(() => {});`,
      `};`,
      `await runSnapshotProbe({ repoRoot, tmpRoot, nodeModules, steps: ['validate-plugin'], writeReceipt: false, runner });`,
    ].join('\n');

    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script, repo, tmpRoot, nodeModules], {
      timeout: 20000, killSignal: 'SIGKILL', encoding: 'utf8',
    });

    expect(res.error).toBeUndefined();
    expect(res.signal).toBe('SIGTERM');
    const runnerCwd = res.stderr.match(/RUNNER_CWD=(.+)/)[1];
    expect(runnerCwd.startsWith(tmpRoot)).toBe(true);
    expect(existsSync(runnerCwd)).toBe(false);
    expect(readdirSync(tmpRoot).filter((n) => n.startsWith('so-snapshot-probe-'))).toEqual([]);
  });
});

describe('receipt path guard', () => {
  it('rejects a snapshot tree that is not an object id before it becomes a path', () => {
    // Bug: `../` in snapshotTree reads or writes a receipt outside the receipt directory.
    expect(() => receiptPath('/repo', '../../etc/x')).toThrow(TypeError);
    expect(readSnapshotProbeReceipt({ repoRoot: '/repo', snapshotTree: '../../etc/x' })).toEqual({ ok: false, receipt: null, reason: 'invalid-tree' });
  });
});

describe('computeSnapshotTree', () => {
  it('maps a commit that changes only an excluded file to the same snapshot tree', () => {
    // Bug: a receipt keyed by the source sha would force a re-run for private-only commits;
    // one keyed by a tree that ignores public changes would let a stale receipt pass.
    const { repo, git } = makeFixture();
    const before = computeSnapshotTree({ repoRoot: repo, git });
    write(repo, { '.vault.yaml': 'private: changed\n' });
    commitAll(repo, 'private only');
    const privateOnly = computeSnapshotTree({ repoRoot: repo, git });
    write(repo, { 'README.md': 'public changed\n' });
    commitAll(repo, 'public');
    const publicChange = computeSnapshotTree({ repoRoot: repo, git });

    expect(privateOnly.snapshotTree).toBe(before.snapshotTree);
    expect(privateOnly.sourceSha).not.toBe(before.sourceSha);
    expect(publicChange.snapshotTree).not.toBe(before.snapshotTree);
  });
});
