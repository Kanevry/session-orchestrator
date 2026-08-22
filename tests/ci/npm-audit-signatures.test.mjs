import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';

const YAML_PATH = resolve(process.cwd(), '.gitlab-ci.yml');
const doc = loadYaml(readFileSync(YAML_PATH, 'utf8'));

const JOB_NAME = 'npm-audit-signatures';
const job = doc[JOB_NAME];

// The bug this file exists to catch, stated once: `npm audit signatures`
// collapses "the tarballs did not verify" and "I could not reach the registry"
// onto the SAME exit 1 (measured 2026-08-22, npm 11.8.0 — a bare run against an
// unreachable registry and a run in a tree with no node_modules both exit 1).
// A bare `npm audit signatures` in the job script would therefore report a DNS
// blip as a supply-chain finding, sending the next reader hunting a compromise
// that never happened — the same confusion #933 removed from schema-drift-check,
// where "you forgot the token" and "the schema diverged" used to be one red.
//
// The job defends against that by classifying npm's JSON ENVELOPE, never its
// exit code. These are behavioral tests of that classifier: the real script
// block is lifted out of the committed YAML and executed. They are network-free
// on purpose — only the classifier tail runs, against crafted envelopes of the
// exact shapes npm was measured to emit. A rewrite back to a bare npm call, or
// any regression that merges the two classes, fails here.

/** The job's single folded script block — the exact string the runner executes. */
const scriptBlock = (job?.script ?? [])[0] ?? '';

/**
 * The classifier tail of the script block (everything from `node -e` on).
 * Sliced off so the test needs neither a registry nor an installed tree: the
 * npm invocation's only job is to produce `sig-audit.json`, which we forge.
 */
const classifier = scriptBlock.slice(scriptBlock.indexOf('node -e '));

/** Tmp dirs created by any test below; drained after each test. */
const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/**
 * Run the committed classifier against a forged `sig-audit.json`.
 * @param {string} envelope raw stdout npm would have written
 * @returns {{status: number, stdout: string}}
 */
function classify(envelope) {
  const dir = mkdtempSync(join(tmpdir(), 'so-sig-audit-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'sig-audit.json'), envelope);
  const res = spawnSync('sh', ['-c', classifier], { cwd: dir, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '' };
}

describe('npm-audit-signatures separates a failed query from a negative verdict', () => {
  it('exits 0 only when the query completed AND found nothing wrong', () => {
    const { status, stdout } = classify('{"invalid":[],"missing":[]}');
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
  });

  it('exits 1 — a verdict — when signatures are invalid or missing', () => {
    // Shape as npm emits it when a tarball fails to verify.
    const { status, stdout } = classify(
      '{"invalid":[{"name":"evil-pkg","version":"1.2.3"}],"missing":[{"name":"old-pkg","version":"0.1.0"}]}',
    );
    expect(status).toBe(1);
    expect(stdout).toContain('FAILED');
    // The offending packages must be printed, or the red is unactionable.
    expect(stdout).toContain('evil-pkg');
    expect(stdout).toContain('old-pkg');
  });

  it('exits 5 — NOT 1 — when the registry is unreachable', () => {
    // Verbatim envelope measured from:
    //   npm audit signatures --json --registry=https://registry.invalid.example/
    const { status, stdout } = classify(
      '{"error":{"code":"ENOTFOUND","summary":"request to https://registry.invalid.example/-/npm/v1/keys failed"}}',
    );
    expect(status).toBe(5);
    expect(stdout).toContain('UNAVAILABLE');
    // The whole point: a network fact must not read as a signature fact.
    expect(stdout).toContain('NOT a signature verdict');
    expect(stdout).not.toContain('FAILED');
  });

  it('exits 5 when nothing was installed, rather than passing vacuously', () => {
    // Verbatim envelope measured by running the audit in a tree holding only
    // package.json + package-lock.json. A job that compared nothing must never
    // report the same green as a job that compared everything (#929 pipeline 6808).
    const { status, stdout } = classify(
      '{"error":{"summary":"found no dependencies to audit that were installed from a supported registry","detail":""}}',
    );
    expect(status).toBe(5);
    expect(stdout).toContain('UNAVAILABLE');
  });

  it('exits 5 when npm wrote no parseable envelope at all', () => {
    // A crash mid-write leaves truncated stdout. Unparseable is "no answer",
    // never "no findings" — the difference between exit 5 and a false green.
    const { status, stdout } = classify('{"invalid":[');
    expect(status).toBe(5);
    expect(stdout).toContain('UNAVAILABLE');
  });

  it('installs node_modules, without which it could verify nothing', () => {
    // `npm audit signatures` reads the INSTALLED tree, not the lockfile — so
    // dropping the shared setup anchor would silently reduce this gate to the
    // exit-5 path on every run. Asserted on the merged job, post-anchor.
    expect(JSON.stringify(job.before_script ?? [])).toContain('npm ci');
  });
});

describe('npm-audit-signatures is a binding gate, not an advisory one', () => {
  it('carries no allow_failure — every exit code is hard', () => {
    // The gate was measured green at wiring time (332/332 verified, exit 0), so
    // it is binding from day one. `allow_failure: true` added later "to unblock
    // a pipeline" would turn the repo's only cryptographic provenance check into
    // decoration while still printing a reassuring job name.
    expect(job.allow_failure).toBeUndefined();
  });

  it('is fanned into pipeline-gate, so its absence cannot go unnoticed', () => {
    // #933 Loch 3: a gate that exists but is not required by the fan-in yields a
    // GREEN pipeline that verified nothing (measured: pipeline 6808 went green
    // with exactly one job). Membership in `needs` is what makes it load-bearing.
    expect(doc['pipeline-gate'].needs).toContain(JOB_NAME);
  });

  it('runs in the security stage alongside the other supply-chain gates', () => {
    expect(job.stage).toBe('security');
  });
});
